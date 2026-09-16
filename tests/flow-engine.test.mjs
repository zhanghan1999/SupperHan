// tests/flow-engine.test.mjs
// flow 引擎（scripts/flow-engine.mjs）的 §8 回归用例 2–16。
//
// 覆盖口径：绝大多数走**真私有根 + 真落盘**（appendWave/finalize 会写 gen 目录、切
// CURRENT、生成 flow-index/flow-check/flow-notes），只有纯计算（归一化、五类端点、分片）
// 用纯函数。理由见需求书：本仓踩过"落盘类只测渲染层，漏掉整条写入路径"——finalize 的
// 校验/切指针/合并半程只有真跑磁盘才证伪得了。另配少量 CLI 子进程冒烟，证明 writer 经
// bash 调用这一层的接线与退出码（0/42/43）也对得上。
//
// 夹具一律 fx/中性 route，绝不写真实现网槽位名/主机名/凭据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs      from 'node:fs';
import os      from 'node:os';
import path    from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as FE from '../scripts/flow-engine.mjs';
const {
  normalizeRoute, partFileName, analyzeGraph, findCycles, mergeGeneration,
  appendWave, finalize, query, parseIndex, renderIndex, renderCheck, renderNotes,
  readCurrentGen, readPrevGeneration, readParts, listGens, discardOpenGens,
  NODE_COLS, EDGE_COLS, EXTERNAL_COLS, EDGE_ALLOWED_EXTRA_COLS,
  UNRESOLVED_CODES, INVARIANT, EXIT, BoundaryError,
} = FE;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE    = path.join(__dirname, '..', 'scripts', 'flow-engine.mjs');

// ── 夹具小工具 ──────────────────────────────────────────────────────────────
function mkctx(prefix = 'fx-flow-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const ctx = path.join(root, 'ctx');
  fs.mkdirSync(ctx, { recursive: true });
  return ctx;
}
/** 一个 analyzer 片的返回（压缩结构）：nodes/edges/externals */
function item(nodes, edges = [], externals = []) { return { nodes, edges, externals }; }
function node(pageKey, prevStatus = 'root', extra = {}) {
  return { page_key: pageKey, route: pageKey, module: 'order', prev_status: prevStatus, ...extra };
}
function edge(page, prevPage, { kind = 'data_predecessor', basis = 'inventory', evidence = 'src/main/resources/mapper/FxMapper.xml:1 insert t_fx', status = 'confirmed' } = {}) {
  return { page, prev_page: prevPage, kind, basis, evidence, status };
}
function runEngine(args) {
  const r = spawnSync(process.execPath, [ENGINE, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 让断言报原文 */ }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}
function readIndexText(ctx, gen) {
  return fs.readFileSync(path.join(ctx, 'flows', gen, 'flow-index.md'), 'utf8');
}
function liveEdgesOf(indexParsed) { return indexParsed.edges.filter((e) => e.status !== 'superseded'); }

// ───────────────────────────────────────────────────────────────────────────
// 用例 2：route 归一化双向一致性
// ───────────────────────────────────────────────────────────────────────────

test('用例2 归一化折叠大小写/末尾斜杠/三种路径变量写法', () => {
  assert.equal(normalizeRoute('GET /Order/Detail'), '/order/detail');
  assert.equal(normalizeRoute('/order/detail'), '/order/detail');
  assert.equal(normalizeRoute('/order/detail/'), '/order/detail');
  assert.equal(normalizeRoute('/order/{id}'), '/order/{}');
  assert.equal(normalizeRoute('/order/:id'), '/order/{}');
  assert.equal(normalizeRoute('/order/123'), '/order/{}');
  assert.equal(normalizeRoute('  POST   /Fx//List/  ').replace(/^\/fx\//, '/fx/').startsWith('/fx'), true);
  assert.equal(normalizeRoute(''), '', '空输入返回空串');
});

test('用例2 混合写法的一条边，两个方向都能命中（单向可中=缺陷）', () => {
  const ctx = mkctx();
  const gen = 'gen-20260101000000';
  appendWave({ contextRoot: ctx, gen, wave: 1, items: [
    item([node('/order/list'), node('/order/detail', 'no_data')],
      // 故意用大写 + 末尾斜杠 + :id 变量三种写法混进同一批
      [edge('/ORDER/DETAIL/', '/Order/List/')]),
  ]});
  const f = finalize({ contextRoot: ctx, gen, commit: 'c2', nowStamp: 'T' });
  assert.equal(f.ok, true, f.diagnostics?.map((d) => d.message).join('; '));
  // 上一步方向：以规整写法查 detail，应命中 list
  const qPrev = query({ contextRoot: ctx, page: '/order/detail' });
  assert.deepEqual(qPrev.prev_pages, ['/order/list']);
  // 下一步方向：以另一种写法查 list，反查应命中 detail（同一条边，两个方向都得到）
  const qNext = query({ contextRoot: ctx, page: 'GET /ORDER/LIST/' });
  assert.deepEqual(qNext.next_pages, ['/order/detail']);
});

test('用例2 part 文件名与到达顺序无关（同页不同写法 → 同一稳定键）', () => {
  const a = partFileName('/Order/Detail/');
  const b = partFileName('GET /order/detail');
  assert.equal(a, b, '同一页面的文件名必须一致，否则去重靠文件名失效');
});

// ───────────────────────────────────────────────────────────────────────────
// 用例 3：端点自检五类结果
// ───────────────────────────────────────────────────────────────────────────

function mkNodeMap(entries) {
  const m = new Map();
  for (const [k, prev] of entries) m.set(k, { page_key: k, route: k, module: 'order', prev_status: prev || 'root', evidence_ref: '' });
  return m;
}

test('用例3 analyzeGraph 同时命中孤立页 / 悬挂边 / 跨页环，且三者语义互不串', () => {
  const nodes = mkNodeMap([['/a'], ['/b'], ['/c'], ['/orphan'], ['/x'], ['/y'], ['/gone']]);
  const edges = [
    { page: '/b', prev_page: '/a', status: 'confirmed' },
    { page: '/c', prev_page: '/b', status: 'confirmed' },
    { page: '/x', prev_page: '/y', status: 'confirmed' },  // 跨页环 x↔y
    { page: '/y', prev_page: '/x', status: 'confirmed' },
    { page: '/gone', prev_page: '/a', status: 'confirmed' },
  ];
  const pageSet = new Set(['/a', '/b', '/c', '/orphan', '/x', '/y']);  // /gone 已不在页面档案 → 悬挂
  const a = analyzeGraph({ nodes, edges }, pageSet);
  assert.deepEqual(a.orphan_pages, ['/orphan'], '孤立页 = 既是入口又是末叶');
  assert.equal(a.dangling_edges.length, 1, JSON.stringify(a.dangling_edges));
  assert.equal(a.dangling_edges[0].missing, '/gone');
  assert.equal(a.cycles.length, 1, JSON.stringify(a.cycles));
  assert.match(a.cycles[0], /\/x → \/y|\/y → \/x/, '环页链要能读出来');
  assert.ok(a.entry_pages.includes('/a') && a.entry_pages.includes('/orphan'));
  assert.deepEqual(a.endpoint_missing, [], '/gone 仍是节点，属悬挂而非端点缺失');
});

test('用例3 单页代次里孤立页判据不误报（页面集 ≤1 时不成信号）', () => {
  const nodes = mkNodeMap([['/solo']]);
  const a = analyzeGraph({ nodes, edges: [] }, new Set(['/solo']));
  assert.deepEqual(a.orphan_pages, [], '只有一个节点时它既入口又末叶，但本轮页面集不 >1，不算孤立页');
});

test('用例3 只有悬挂边阻断 CURRENT；环永不阻断、也不被静默断开', () => {
  // (A) 只有环，无悬挂 → 必须切 CURRENT，环在 flow-index 里两条边都在
  const ctxA = mkctx();
  const genA = 'gen-20260101000000';
  appendWave({ contextRoot: ctxA, gen: genA, wave: 1, items: [
    item([node('/x'), node('/y')], [edge('/x', '/y'), edge('/y', '/x')]),
  ]});
  const fA = finalize({ contextRoot: ctxA, gen: genA, commit: 'cyc', nowStamp: 'T', pageSet: ['/x', '/y'] });
  assert.equal(fA.ok, true, '环不得阻断：' + JSON.stringify(fA.diagnostics));
  assert.equal(readCurrentGen(ctxA), genA, 'CURRENT 必须切过去');
  assert.equal(fA.data.check.cycles, 1);
  const idxA = parseIndex(readIndexText(ctxA, genA));
  assert.equal(liveEdgesOf(idxA).length, 2, '环上两条边都得留着，不得静默断一条');

  // (B) 有悬挂边（端点不在页面档案）→ 不切 CURRENT，报 FLOW_INTEGRITY_FAIL
  const ctxB = mkctx();
  const genB = 'gen-20260101000000';
  appendWave({ contextRoot: ctxB, gen: genB, wave: 1, items: [
    item([node('/b'), node('/a')], [edge('/b', '/a')]),
  ]});
  const fB = finalize({ contextRoot: ctxB, gen: genB, commit: 'dang', nowStamp: 'T', pageSet: ['/b'] }); // /a 不在档案
  assert.equal(fB.ok, false, '悬挂边必须阻断');
  assert.equal(fB.code, 'FLOW_INTEGRITY_FAIL');
  assert.equal(fB.status, EXIT.INTEGRITY_FAIL);
  assert.equal(readCurrentGen(ctxB), null, '阻断时 CURRENT 不切');
  assert.ok(fB.diagnostics.some((d) => d.invariant === INVARIANT.DANGLING_EDGE),
    JSON.stringify(fB.diagnostics));
});

// ───────────────────────────────────────────────────────────────────────────
// 用例 4：prev 侧三态不同形
// ───────────────────────────────────────────────────────────────────────────

test('用例4 四种 prev 状态产出四个可分辨的桶，原因码里不得有库/语言类', () => {
  assert.deepEqual([...UNRESOLVED_CODES].sort(), ['no_table_inventory', 'sources_incomplete'],
    '一期原因码只有这两个');
  for (const code of UNRESOLVED_CODES) {
    assert.ok(!/db|database|sql|conn|库|数据源|lang|profile|剖面/.test(code), `原因码不得是库/语言类：${code}`);
  }
  // 非法原因码（库类）必须被 parsePart 判成 PART_SHAPE
  const bad = FE.parsePart(renderPartSafe(item([node('/z', 'unresolved:db_unreachable')])));
  assert.ok(bad.problems.some((p) => p.invariant === INVARIANT.PART_SHAPE && /prev_status/.test(p.message)),
    JSON.stringify(bad.problems));

  const ctx = mkctx();
  const gen = 'gen-20260101000000';
  appendWave({ contextRoot: ctx, gen, wave: 1, items: [
    item([node('/src')]),                                              // 入口：root（真第一步）
    item([node('/b'), node('/readme', 'no_data')], [edge('/b', '/src')]), // /b 有上一步 /src；readme 只读页 no_data
    item([node('/c'), node('/un1', 'unresolved:no_table_inventory')]), // unresolved 码1
    item([node('/d'), node('/un2', 'unresolved:sources_incomplete')]), // unresolved 码2
    // 其余三态页无 prev 边（作为入口呈现各自状态）
  ]});
  const f = finalize({ contextRoot: ctx, gen, commit: 'c4', nowStamp: 'T' });
  assert.equal(f.ok, true, JSON.stringify(f.diagnostics));
  const c = f.data.prev_status_counts;
  assert.ok(c.root >= 1 && c.no_data === 1 && c.unresolved_no_table_inventory === 1 && c.unresolved_sources_incomplete === 1,
    JSON.stringify(c));
  assert.equal(c.other, 0, '不该有第四种未登记形态');
  // 回答期视图：有 prev 的页 → has_prev；三种入口各按三态如实报，不同形
  assert.equal(query({ contextRoot: ctx, page: '/b' }).prev_status_view, 'has_prev');
  assert.equal(query({ contextRoot: ctx, page: '/readme' }).prev_status_view, 'no_data');
  assert.equal(query({ contextRoot: ctx, page: '/un1' }).prev_status_view, 'unresolved:no_table_inventory');
  assert.equal(query({ contextRoot: ctx, page: '/un2' }).prev_status_view, 'unresolved:sources_incomplete');
  assert.equal(query({ contextRoot: ctx, page: '/src' }).prev_status_view, 'root');
});
function renderPartSafe(it) { return FE.renderPart(it); }

// ───────────────────────────────────────────────────────────────────────────
// 用例 5：整代合并 + superseded_by + 旧代不被原地改 + CURRENT 原子切换 + 保留 2 代
//   （这条同时复现"mergeGeneration 把上一代 nodes(Map) 当数组展开"导致节点丢失的 bug）
// ───────────────────────────────────────────────────────────────────────────

test('用例5 第二代推翻同一条边：旧边记 superseded_by、上一代节点不丢、旧代目录不被改、切一次、留 2 代', () => {
  const ctx = mkctx();
  const gen1 = 'gen-20260101000000';
  appendWave({ contextRoot: ctx, gen: gen1, wave: 1, items: [
    item([node('/b'), node('/a')], [edge('/b', '/a', { basis: 'inventory', evidence: 'a/m.xml:1 insert t_a' })]),
  ]});
  const f1 = finalize({ contextRoot: ctx, gen: gen1, commit: 'r1', nowStamp: 'T' });
  assert.equal(f1.ok, true, JSON.stringify(f1.diagnostics));
  const gen1IndexBefore = readIndexText(ctx, gen1);

  // 第二代：只重推 /b 这条边（/a 只由上一代节点表提供，本波不再重复列 /a）
  const gen2 = 'gen-20260102000000';
  appendWave({ contextRoot: ctx, gen: gen2, wave: 1, items: [
    item([node('/b')], [edge('/b', '/a', { basis: 'read_code', status: 'inferred', evidence: 'a/m.xml:1 insert t_a; a/m.xml:9 select t_a' })]),
  ]});
  const f2 = finalize({ contextRoot: ctx, gen: gen2, commit: 'r2', nowStamp: 'T' });
  assert.equal(f2.ok, true, '整代合并后仍应可切：' + JSON.stringify(f2.diagnostics));

  const idx2 = parseIndex(readIndexText(ctx, gen2));
  assert.ok(idx2.nodes.has('/a'), '上一代的 /a 节点必须在第二代仍在（丢了=合并坏）');
  assert.ok(idx2.nodes.has('/b'));
  assert.ok(!idx2.nodes.has(''), '绝不允许出现空键幽灵节点');
  const live = liveEdgesOf(idx2);
  assert.equal(live.length, 1, '同一条 (page,prev_page) 活边只剩一条');
  assert.equal(live[0].basis, 'read_code', '本轮为准');
  const sup = idx2.edges.find((e) => e.status === 'superseded');
  assert.ok(sup, '旧边不静默删，记 superseded');
  assert.ok(sup.superseded_by && sup.superseded_by === live[0].edge_id,
    `superseded_by 必须指向新边 id：${sup.superseded_by} vs ${live[0].edge_id}`);

  assert.equal(readIndexText(ctx, gen1), gen1IndexBefore, '旧代目录绝不被 in-place 修改');
  assert.equal(readCurrentGen(ctx), gen2, 'CURRENT 原子切到第二代');
  const gens = listGens(ctx);
  assert.equal(gens.length, 2, '保留最近 2 代：' + JSON.stringify(gens));
});

// ───────────────────────────────────────────────────────────────────────────
// 用例 6：外部接口隔离
// ───────────────────────────────────────────────────────────────────────────

function external(viaPage, endpoint, pointsTo) {
  return { direction: 'out', endpoint, points_to: pointsTo, via_page: viaPage, via_route: 'GET ' + viaPage, counterpart: 'fx-网关', evidence: 'src/main/java/FxClient.java:42', scope: 'outOfScope' };
}

test('用例6 外部接口只登记不成边：无 prev 的页仍判入口，外部对端不进任何 next 反查，也不计悬挂', () => {
  const ctx = mkctx();
  const gen = 'gen-20260101000000';
  appendWave({ contextRoot: ctx, gen, wave: 1, items: [
    // /ext-only 只登记了一条外部接口，没有任何 prev 边
    item([node('/ext-only'), node('/pay')], [], [external('/ext-only', 'POST /openapi/push', 'page:/pay')]),
    // 另放一条真悬挂边：/d←/gone，/gone 是节点但不在页面档案里
    item([node('/d'), node('/gone')], [edge('/d', '/gone')]),
  ]});
  const pageSet = ['/ext-only', '/pay', '/d']; // 注意：/gone 不在档案 → 真悬挂
  const f = finalize({ contextRoot: ctx, gen, commit: 'c6', nowStamp: 'T', pageSet, targetKeys: [] });
  assert.equal(f.code, 'FLOW_INTEGRITY_FAIL', '真悬挂边应阻断');
  const dangling = f.data.check;
  assert.ok(dangling, JSON.stringify(f.data));
  // 外部登记不计入端点判据
  assert.ok(f.diagnostics.every((d) => !/openapi|ext-only|\/pay/.test((d.message || '') + (d.rerun_routes || []).join(','))),
    '外部端点绝不得混进悬挂诊断：' + JSON.stringify(f.diagnostics));
});

test('用例6 外部登记 + 端点自检：入口判定与 next 反查都不被外部污染（正常代次）', () => {
  const ctx = mkctx();
  const gen = 'gen-20260101000000';
  appendWave({ contextRoot: ctx, gen, wave: 1, items: [
    item([node('/ext-only'), node('/pay')], [], [external('/ext-only', 'POST /openapi/push', 'page:/pay')]),
  ]});
  const f = finalize({ contextRoot: ctx, gen, commit: 'c6b', nowStamp: 'T', pageSet: ['/ext-only', '/pay'] });
  assert.equal(f.ok, true, JSON.stringify(f.diagnostics));
  assert.equal(f.data.check.dangling_edges, 0, '外部登记不制造假悬挂');
  assert.equal(f.data.check.external_registered, 1);
  // /ext-only 无 prev → 是入口
  const q = query({ contextRoot: ctx, page: '/ext-only' });
  assert.deepEqual(q.prev_pages, [], '外部登记不给本页造成 prev');
  assert.ok(!q.next_pages.includes('/pay'), 'points_to:page:/pay 不得变成一条 next 边');
  assert.deepEqual(q.next_pages, []);
});

test('用例6 边表里混进指向外部端点的边 → EDGE_ENDPOINT_NOT_FOUND 拒绝切 CURRENT', () => {
  const ctx = mkctx();
  const gen = 'gen-20260101000000';
  appendWave({ contextRoot: ctx, gen, wave: 1, items: [
    item([node('/x')], [edge('/x', '/openapi/order/push')]), // 外部端点被误写进边表，且不是节点
  ]});
  const f = finalize({ contextRoot: ctx, gen, commit: 'c6c', nowStamp: 'T', pageSet: ['/x'] });
  assert.equal(f.ok, false);
  assert.equal(f.code, 'FLOW_INTEGRITY_FAIL');
  assert.equal(readCurrentGen(ctx), null);
  assert.ok(f.diagnostics.some((d) => d.invariant === INVARIANT.DANGLING_EDGE && /EDGE_ENDPOINT_NOT_FOUND/.test(d.message)),
    JSON.stringify(f.diagnostics));
});

// ───────────────────────────────────────────────────────────────────────────
// 用例 8：next 侧零存储的结构不变式
// ───────────────────────────────────────────────────────────────────────────

test('用例8 列契约：节点表无 next 方向列，边表恰 7 列（superseded_by 唯一可追加）', () => {
  assert.deepEqual([...NODE_COLS], ['page_key', 'route', 'title', 'module', 'prev_status', 'evidence_ref']);
  assert.deepEqual([...EDGE_COLS], ['edge_id', 'page', 'prev_page', 'kind', 'basis', 'evidence', 'status']);
  assert.deepEqual([...EDGE_ALLOWED_EXTRA_COLS], ['superseded_by']);
  for (const col of NODE_COLS) {
    assert.ok(!/next|leaf|pending|coverage|downstream/i.test(col),
      `节点表不得出现 next 方向状态/计数列：${col}`);
  }
});

test('用例8 解析真实产出的 flow-index.md：表头列集合与契约逐字一致', () => {
  const ctx = mkctx();
  const gen = 'gen-20260101000000';
  appendWave({ contextRoot: ctx, gen, wave: 1, items: [
    item([node('/b'), node('/a')], [edge('/b', '/a')]),
  ]});
  finalize({ contextRoot: ctx, gen, commit: 'c8', nowStamp: 'T' });
  const text = readIndexText(ctx, gen);
  const nodeHeader = text.split('\n').find((l) => /^\|\s*page_key\s*\|/.test(l));
  assert.ok(nodeHeader);
  assert.deepEqual(nodeHeader.replace(/\s/g, '').replace(/^\||\|$/g, '').split('|'), NODE_COLS);
  const edgeHeader = text.split('\n').find((l) => /^\|\s*edge_id\s*\|/.test(l));
  assert.deepEqual(edgeHeader.replace(/\s/g, '').replace(/^\||\|$/g, '').split('|'), EDGE_COLS);
});

test('用例8 flow-check.md 不是数据源：删掉它 query 结果字节一致；只在报告出现的假下游不出现在 next 反查', () => {
  const ctx = mkctx();
  const gen = 'gen-20260101000000';
  appendWave({ contextRoot: ctx, gen, wave: 1, items: [
    item([node('/a'), node('/b')], [edge('/b', '/a')]),
  ]});
  finalize({ contextRoot: ctx, gen, commit: 'c8b', nowStamp: 'T' });
  const before = JSON.stringify(query({ contextRoot: ctx, page: '/a' }));
  // /b 是末叶，会出现在 flow-check 的 leaf_pages 里，但它没有任何下游
  const qB = query({ contextRoot: ctx, page: '/b' });
  assert.deepEqual(qB.next_pages, [], '末叶没有下游；即便报告把它列成 leaf 也不代表存了 next');
  const checkPath = path.join(ctx, 'flows', gen, 'flow-check.md');
  assert.ok(fs.existsSync(checkPath));
  assert.ok(fs.readFileSync(checkPath, 'utf8').includes('/b'));
  fs.rmSync(checkPath);
  const after = JSON.stringify(query({ contextRoot: ctx, page: '/a' }));
  assert.equal(after, before, '删掉体检报告后 query 必须一字不变（证明没人读它）');
});

// ───────────────────────────────────────────────────────────────────────────
// 用例 9：回答期范围判定
// ───────────────────────────────────────────────────────────────────────────

test('用例9 目标页不在清单内 → 直接"不在回答范围之内"，不打回学习、不猜最像的', () => {
  const ctx = mkctx();
  const gen = 'gen-20260101000000';
  appendWave({ contextRoot: ctx, gen, wave: 1, items: [
    item([node('/order/list'), node('/order/detail')], [edge('/order/detail', '/order/list')]),
  ]});
  finalize({ contextRoot: ctx, gen, commit: 'c9', nowStamp: 'T' });
  const r = query({ contextRoot: ctx, page: '/some/unregistered/page', pageSet: ['/order/list', '/order/detail'] });
  assert.equal(r.in_scope, false);
  assert.equal(r.answer_zh, '不在回答范围之内');
  const blob = JSON.stringify(r);
  assert.ok(!/请先学习|建议先学|建议学习|去学/.test(blob), '范围外不得打回学习：' + blob);
  assert.ok(!blob.includes('/order/list') && !blob.includes('/order/detail'),
    '不得退化成按名字模糊匹配出一个相近页面：' + blob);
});

// ───────────────────────────────────────────────────────────────────────────
// 用例 10：折叠去重 + 越权边界
// ───────────────────────────────────────────────────────────────────────────

test('用例10 两片各推同一条边 → 整理后只剩一条，evidence 取更全的那条', () => {
  const ctx = mkctx();
  const gen = 'gen-20260101000000';
  appendWave({ contextRoot: ctx, gen, wave: 1, items: [
    item([node('/b'), node('/a')], [edge('/b', '/a', { evidence: 'short' })]),
    item([node('/b'), node('/a')], [edge('/b', '/a', { evidence: 'src/main/resources/mapper/FxMapper.xml:1 insert t_a; :9 select t_a' })]),
  ]});
  const f = finalize({ contextRoot: ctx, gen, commit: 'c10', nowStamp: 'T' });
  assert.equal(f.ok, true, JSON.stringify(f.diagnostics));
  const idx = parseIndex(readIndexText(ctx, gen));
  const live = liveEdgesOf(idx).filter((e) => e.page === '/b' && e.prev_page === '/a');
  assert.equal(live.length, 1, '同键折叠成一条');
  assert.equal(live[0].evidence, 'src/main/resources/mapper/FxMapper.xml:1 insert t_a; :9 select t_a',
    '保留 evidence 更全的那条');
});

test('用例10 越权动作 → 整代不切 CURRENT，报 WRITE_BOUNDARY_VIOLATION（不重试）', () => {
  // 相对路径的 contextRoot 撞机械边界
  assert.throws(() => appendWave({ contextRoot: 'relative/ctx', items: [item([node('/a')])] }), BoundaryError);
  // 向 CURRENT 已指向的代次追加 = 越权写已启用代
  const ctx = mkctx();
  const gen = 'gen-20260101000000';
  appendWave({ contextRoot: ctx, gen, items: [item([node('/a')])] });
  finalize({ contextRoot: ctx, gen, commit: 'c10b', nowStamp: 'T' });
  assert.equal(readCurrentGen(ctx), gen);
  assert.throws(() => appendWave({ contextRoot: ctx, gen, items: [item([node('/b')])] }),
    (e) => e instanceof BoundaryError && e.code === 'WRITE_BOUNDARY_VIOLATION');
  assert.equal(readCurrentGen(ctx), gen, '越权后 CURRENT 不被改动');
});

// ───────────────────────────────────────────────────────────────────────────
// 用例 11：全量不裁页
// ───────────────────────────────────────────────────────────────────────────

test('用例11 30 个页面全量 → 节点表恰 30 行，产物里无任何"超限/截断/建议分批"措辞', () => {
  const ctx = mkctx();
  const gen = 'gen-20260101000000';
  const items = [];
  const keys = [];
  for (let i = 0; i < 30; i++) { const k = `/fx/page/p${i}`; keys.push(k); items.push(item([node(k)])); }
  appendWave({ contextRoot: ctx, gen, wave: 1, items });
  const f = finalize({ contextRoot: ctx, gen, commit: 'c11', nowStamp: 'T', pageSet: keys });
  assert.equal(f.ok, true, JSON.stringify(f.diagnostics));
  assert.equal(f.data.nodes, 30);
  const idx = parseIndex(readIndexText(ctx, gen));
  assert.equal(idx.nodes.size, 30, '节点表恰 30 行');
  const all = readIndexText(ctx, gen)
    + fs.readFileSync(path.join(ctx, 'flows', gen, 'flow-check.md'), 'utf8')
    + fs.readdirSync(path.join(ctx, 'flows', gen)).filter((f2) => /^flow-notes-/.test(f2)).map((f2) => fs.readFileSync(path.join(ctx, 'flows', gen, f2), 'utf8')).join('');
  assert.ok(!/截断|因超限|超限|跳过|建议分批|规模过大|truncat/i.test(all), '产物不得出现偷偷少做的措辞');
  // 分片侧同样不裁：30 route 全进 plan
  const plan = FE.buildPlan(keys.map((k) => ({ route: k, controller: 'FxController' })), new Set(keys));
  assert.equal(plan.total_routes, 30);
});

// ───────────────────────────────────────────────────────────────────────────
// 用例 12：顺序无关性（字节一致）
// ───────────────────────────────────────────────────────────────────────────

function standaloneItems() {
  return {
    p1: item([node('/fx/a')]),
    p2: item([node('/fx/b')], [edge('/fx/b', '/fx/a')]),
    p3: item([node('/fx/c')], [edge('/fx/c', '/fx/a')]),
  };
}

test('用例12 同批页面两种到达顺序 → flow-parts 文件名集合一致 + flow-index.md 字节一致', () => {
  const { p1, p2, p3 } = standaloneItems();
  const gen = 'gen-20260101000000';

  const ctxA = mkctx('fx-order-a-');
  appendWave({ contextRoot: ctxA, gen, wave: 1, items: [p1, p2, p3] });
  finalize({ contextRoot: ctxA, gen, commit: 'c12', nowStamp: 'T' });

  const ctxB = mkctx('fx-order-b-');
  // 打乱到达顺序 + 拆成两波（模拟并发抖动）
  appendWave({ contextRoot: ctxB, gen, wave: 1, items: [p3] });
  appendWave({ contextRoot: ctxB, gen, wave: 2, items: [p2, p1] });
  finalize({ contextRoot: ctxB, gen, commit: 'c12', nowStamp: 'T' });

  const partsA = fs.readdirSync(path.join(ctxA, 'flows', gen, 'flow-parts')).sort();
  const partsB = fs.readdirSync(path.join(ctxB, 'flows', gen, 'flow-parts')).sort();
  assert.deepEqual(partsA, partsB, 'part 文件名取自 route 稳定键，不取到达序号');
  assert.equal(Buffer.compare(Buffer.from(readIndexText(ctxA, gen), 'utf8'), Buffer.from(readIndexText(ctxB, gen), 'utf8')), 0,
    'flow-index.md 必须字节一致');
});

// ───────────────────────────────────────────────────────────────────────────
// 用例 13：失败按波分流 + 可重跑
// ───────────────────────────────────────────────────────────────────────────

test('用例13 某波里一页坏 → 该页进重跑清单、其它波 parts 不被改写、修好后边集与一次全成功一致', () => {
  const good = () => {
    const ctx = mkctx('fx-wave-good-');
    const gen = 'gen-20260101000000';
    appendWave({ contextRoot: ctx, gen, wave: 1, items: [item([node('/fx/w1')])] });        // 好波
    appendWave({ contextRoot: ctx, gen, wave: 2, items: [item([node('/fx/w2')])] });        // 好波
    // 坏波：直接写一个坏 part（表头列数不符），模拟某页 analyzer 返回被落歪
    const partsDir = path.join(ctx, 'flows', gen, 'flow-parts');
    fs.writeFileSync(path.join(partsDir, partFileName('/fx/w3')),
      '---\nkind: flows-part\nschema: flows-v1\n---\n\n## 节点表\n\n| page_key | route | title | module | prev_status |\n|---|---|---|---|---|\n| /fx/w3 | /fx/w3 |  | order | root |\n', 'utf8');
    const f = finalize({ contextRoot: ctx, gen, commit: 'c13', nowStamp: 'T', targetKeys: ['/fx/w1', '/fx/w2', '/fx/w3'] });
    return { ctx, gen, partsDir, f };
  };
  // 基线：三页全成功
  const base = mkctx('fx-wave-base-');
  appendWave({ contextRoot: base, gen: 'gen-20260101000000', wave: 1, items: [
    item([node('/fx/w1')]), item([node('/fx/w2')]), item([node('/fx/w3')]),
  ]});
  finalize({ contextRoot: base, gen: 'gen-20260101000000', commit: 'c13', nowStamp: 'T' });
  const baseIdx = parseIndex(readIndexText(base, 'gen-20260101000000'));

  const { ctx, gen, partsDir, f } = good();
  assert.equal(f.ok, false, '坏波存在 → 不切');
  assert.equal(readCurrentGen(ctx), null);
  // ① 坏页进重跑清单（经 COVERAGE：坏 part 的页没进节点表 → 覆盖率不足 → rerun_routes 含它）
  assert.ok((f.data.rerun_routes || []).includes('/fx/w3'), JSON.stringify(f.data.rerun_routes));
  // ② 已落盘的其它波 parts 未被改写（好波文件仍在盘）
  assert.ok(fs.existsSync(path.join(partsDir, partFileName('/fx/w1'))));
  assert.ok(fs.existsSync(path.join(partsDir, partFileName('/fx/w2'))));

  // ③ 重跑坏页（覆盖写正确 part）→ 最终边集与一次全成功一致
  fs.writeFileSync(path.join(partsDir, partFileName('/fx/w3')),
    FE.renderPart(item([node('/fx/w3')])), 'utf8');
  const f2 = finalize({ contextRoot: ctx, gen, commit: 'c13', nowStamp: 'T', targetKeys: ['/fx/w1', '/fx/w2', '/fx/w3'] });
  assert.equal(f2.ok, true, JSON.stringify(f2.diagnostics));
  const fixedIdx = parseIndex(readIndexText(ctx, gen));
  assert.deepEqual([...fixedIdx.nodes.keys()].sort(), [...baseIdx.nodes.keys()].sort());
  assert.deepEqual(liveEdgesOf(fixedIdx).map((e) => `${e.page}<-${e.prev_page}`).sort(),
    liveEdgesOf(baseIdx).map((e) => `${e.page}<-${e.prev_page}`).sort());
});

// ───────────────────────────────────────────────────────────────────────────
// 用例 14：半成品不可见 + 无 CURRENT 指向的 gen 整代重做
// ───────────────────────────────────────────────────────────────────────────

test('用例14 整理校验不过 → CURRENT 仍指旧代、读到上一代完整数据；无 CURRENT 指向的半成品被整代丢弃不复用', () => {
  const ctx = mkctx();
  // 先建一个可用旧代
  const gen0 = 'gen-20260101000000';
  appendWave({ contextRoot: ctx, gen: gen0, items: [item([node('/fx/old')])] });
  finalize({ contextRoot: ctx, gen: gen0, commit: 'old', nowStamp: 'T' });
  assert.equal(readCurrentGen(ctx), gen0);

  // 新代造一条悬挂边（端点不在页面档案）→ 校验不过
  const gen1 = 'gen-20260102000000';
  appendWave({ contextRoot: ctx, gen: gen1, items: [item([node('/fx/new'), node('/fx/ghost')], [edge('/fx/new', '/fx/ghost')])] });
  const f = finalize({ contextRoot: ctx, gen: gen1, commit: 'new', nowStamp: 'T', pageSet: ['/fx/new'] }); // /fx/ghost 不在档案
  assert.equal(f.ok, false);
  assert.equal(readCurrentGen(ctx), gen0, 'CURRENT 必须仍指旧代');
  // 问答读到的是旧代完整数据（旧代有 /fx/old，新代的 /fx/new 读不到）
  const q = query({ contextRoot: ctx, page: '/fx/old' });
  assert.equal(q.ok, true);
  assert.equal(q.gen, gen0);
  // 半成品不进入可读集：查 /fx/new（仅存在于校验失败的 gen1）时，
  // CURRENT 仍指 gen0，故读到的 gen 是 gen0 且该页无节点行（node===null）。
  const qNew = query({ contextRoot: ctx, page: '/fx/new' });
  assert.equal(qNew.gen, gen0, '只能读到旧代 gen0，绝不暴露未切指针的 gen1');
  assert.equal(qNew.node, null, '半成品里的 /fx/new 不得出现在可读集');

  // 半成品带着 .open 标记留在盘上；下次 appendWave（不给 gen）必须整代丢弃重做，绝不复用
  assert.ok(fs.existsSync(path.join(ctx, 'flows', gen1, '.open')), '失败的代次带 .open 哨兵');
  const a = appendWave({ contextRoot: ctx, items: [item([node('/fx/next')])], now: Date.parse('2026-03-01T00:00:00Z') });
  assert.ok(a.data.discarded_incomplete_gens.includes(gen1), JSON.stringify(a.data.discarded_incomplete_gens));
  assert.ok(!listGens(ctx).includes(gen1), '半成品代次目录已被清除，不复用');
});

// ───────────────────────────────────────────────────────────────────────────
// 用例 15：互斥合规（等价可断言形式）
// ───────────────────────────────────────────────────────────────────────────
// 原命题"writer 落盘期间没有 analyzer 在途"是编排行为，单测层无法机械断言。
// 这里以调用序的等价形式覆盖：append 永不切 CURRENT、同波重复 append 幂等不产生重复边、
// finalize 恰好切一次 CURRENT。真正的写读互斥需在集成/人工层验证（见报告）。

test('用例15(等价) 各波 append 从不切 CURRENT；同波重复 append 幂等不重复；finalize 恰好切一次', () => {
  const ctx = mkctx();
  const gen = 'gen-20260101000000';
  const a1 = appendWave({ contextRoot: ctx, gen, wave: 1, items: [item([node('/fx/p')])] });
  assert.equal(a1.data.switched, false);
  assert.equal(readCurrentGen(ctx), null, 'append 阶段 CURRENT 绝不能被切');
  // 同一批内容重复 append（模拟同一波被投递两次）→ 文件名按 route 稳定键覆盖，不产生第二份
  appendWave({ contextRoot: ctx, gen, wave: 1, items: [item([node('/fx/p')])] });
  const parts = readParts(path.join(ctx, 'flows', gen, 'flow-parts'));
  assert.equal(parts.length, 1, '同页重复落盘按稳定键覆盖，不叠加');
  const f = finalize({ contextRoot: ctx, gen, commit: 'c15', nowStamp: 'T' });
  assert.equal(f.ok, true, JSON.stringify(f.diagnostics));
  assert.equal(f.data.switched, true);
  assert.equal(readCurrentGen(ctx), gen);
  assert.equal(readParts(path.join(ctx, 'flows', gen, 'flow-parts')).length, 1);
  // finalize 切一次后，再对该代 append 被拒（写读交叠的机械护栏之一）
  assert.throws(() => appendWave({ contextRoot: ctx, gen, items: [item([node('/fx/q')])] }), BoundaryError);
});

// ───────────────────────────────────────────────────────────────────────────
// 用例 16：诊断可用性
// ───────────────────────────────────────────────────────────────────────────

test('用例16 坏 part → FLOW_INTEGRITY_FAIL 的 diagnostics 指到具体 part 文件名与行 + rerun_routes；BOUNDARY 走不重试分支', () => {
  const ctx = mkctx();
  const gen = 'gen-20260101000000';
  appendWave({ contextRoot: ctx, gen, wave: 1, items: [
    item([node('/fx/good')]),
    item([node('/fx/bad')]),
  ]});
  const partsDir = path.join(ctx, 'flows', gen, 'flow-parts');
  const badName = partFileName('/fx/bad');
  // 覆盖写：边表数据行列数比表头少一列（真实"列数不符"形态）
  fs.writeFileSync(path.join(partsDir, badName),
    ['---', 'kind: flows-part', 'schema: flows-v1', '---', '',
     '## 节点表', '', '| page_key | route | title | module | prev_status | evidence_ref |',
     '|---|---|---|---|---|---|', '| /fx/bad | /fx/bad |  | order | root |  |', '',
     '## 边表', '', '| edge_id | page | prev_page | kind | basis | evidence | status |',
     '|---|---|---|---|---|---|---|', '| - | /fx/bad | /fx/good | data_predecessor | inventory | confirmed |', ''].join('\n'),
    'utf8');
  const f = finalize({ contextRoot: ctx, gen, commit: 'c16', nowStamp: 'T', targetKeys: ['/fx/good', '/fx/bad'] });
  assert.equal(f.code, 'FLOW_INTEGRITY_FAIL');
  assert.equal(readCurrentGen(ctx), null);
  const shape = f.diagnostics.find((d) => d.invariant === INVARIANT.PART_SHAPE);
  assert.ok(shape, JSON.stringify(f.diagnostics));
  assert.equal(shape.part, badName, '必须指到具体 part 文件名');
  assert.ok(Number(shape.line) > 0, '必须给出行号：' + shape.line);
  // 重跑单位：坏 part 的页没进节点表 → COVERAGE 诊断把它列进 rerun_routes
  const rerun = [...new Set(f.diagnostics.flatMap((d) => d.rerun_routes || []))];
  assert.ok(rerun.includes('/fx/bad'), JSON.stringify(f.diagnostics));
  // diagnostics 全是机械元数据，不含任何 analyzer 推理正文
  for (const d of f.diagnostics) {
    assert.ok(typeof d.part === 'string' && typeof d.invariant === 'string');
    assert.ok(!/因为|所以|我认为|推测/.test(d.message || ''), '诊断是机器可读定位，不是过程叙述');
  }

  // BOUNDARY 类：CLI 追加到已启用代 → 43，invariant BOUNDARY，rerun_routes 空（不重试）
  const ctx2 = mkctx();
  const g2 = 'gen-20260101000000';
  const wf = path.join(ctx2, 'wf.json');
  fs.writeFileSync(wf, JSON.stringify({ items: [item([node('/a')])] }), 'utf8');
  const ap = runEngine(['append', '--context-root', ctx2, '--wave-file', wf, '--gen', g2]);
  assert.equal(ap.status, 0);
  const fin = runEngine(['finalize', '--context-root', ctx2, '--gen', g2, '--commit', 'x']);
  assert.equal(fin.status, 0);
  // 再对已启用代 append → 越权 → 43 + BOUNDARY + 不重试
  const bad = runEngine(['append', '--context-root', ctx2, '--wave-file', wf, '--gen', g2]);
  assert.equal(bad.status, 43, 'BOUNDARY 是 43，不是 42');
  assert.equal(bad.json.code, 'WRITE_BOUNDARY_VIOLATION');
  assert.equal(bad.json.diagnostics[0].invariant, INVARIANT.BOUNDARY);
  assert.deepEqual(bad.json.diagnostics[0].rerun_routes, [], 'BOUNDARY 不产生重跑单位（立即停、不重试）');
});

// ───────────────────────────────────────────────────────────────────────────
// 少量 CLI 冒烟：证明 writer 经 bash 调用的接线/退出码/JSON envelope 正确
// ───────────────────────────────────────────────────────────────────────────

test('CLI 冒烟 append→finalize→query 一路经子进程跑通，退出码与 envelope 一致', () => {
  const ctx = mkctx();
  const gen = 'gen-20260101000000';
  const wf = path.join(ctx, '..', 'wave.json');
  fs.writeFileSync(wf, JSON.stringify({ items: [
    item([node('/fx/a')], []),
    item([node('/fx/b')], [edge('/fx/b', '/fx/a')]),
  ] }), 'utf8');
  const ap = runEngine(['append', '--context-root', ctx, '--wave-file', wf, '--gen', gen, '--wave', '1']);
  assert.equal(ap.status, 0, ap.stderr);
  assert.equal(ap.json.code, 'PARTS_APPENDED');
  assert.equal(ap.json.data.switched, false);
  const fin = runEngine(['finalize', '--context-root', ctx, '--gen', gen, '--commit', 'deadbeef']);
  assert.equal(fin.status, 0, fin.stderr);
  assert.equal(fin.json.code, 'WRITTEN');
  const pages = path.join(ctx, '..', 'pages.json');
  fs.writeFileSync(pages, JSON.stringify(['/fx/a', '/fx/b']), 'utf8');
  const q = runEngine(['query', '--context-root', ctx, '--page', '/fx/b', '--pages-file', pages]);
  assert.equal(q.status, 0, q.stderr);
  assert.deepEqual(q.json.prev_pages, ['/fx/a']);
  // 查询未学分区：另起一个空 ctx → FLOWS_NOT_LEARNED
  const empty = mkctx();
  const qe = runEngine(['query', '--context-root', empty, '--page', '/fx/a']);
  assert.equal(qe.status, EXIT.NOT_READY);
  assert.equal(qe.json.code, 'FLOWS_NOT_LEARNED');
});
