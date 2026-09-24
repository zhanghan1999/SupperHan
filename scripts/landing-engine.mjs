#!/usr/bin/env node
// scripts/landing-engine.mjs
//
// 确定性落地引擎（code 模式）。把 analyzer 切片装填成 <CONTEXT_ROOT>/<module>/gen-<ts>/ 的
// batch-*.md + index.md，原子切 module 级 CURRENT，并按 expected_slice_ids 清理 staging。
//
// 为什么要有它（与 flow 模式同一条理由）：装填 / 逻辑序重排 / 索引生成 / 自检都是**纯机械计算**。
// 让模型逐格誊 markdown 换来的是"每次都不同"（同一输入两种到达顺序必须跑出字节一致的产物），
// 而且把每轮落地的大头 token 成本花在格式化上。脚本化后 writer 只做"组装入参 + 调用 + 原样回报"。
//
// 用法：
//   node scripts/landing-engine.mjs --context-root <dir> --module <m> --staging-dir <dir> \
//     --expected-slice-ids 01,02,03 [--mode init|update] [--commit <hash>] [--plan <plan.json>] \
//     [--project <code>] [--now <yyyymmddHHMMSS>] [--write]
//
// 不带 --write = **干跑**：完成全部读取、装填计算与自检，打印计划与结果 JSON，**不写任何文件**。
//
// 退出码：0 = WRITTEN（或干跑通过）；2 = 入参错；41 = GEN_INTEGRITY_FAIL（不切 CURRENT）；42 = METHOD_DRIFT。
import fs from 'node:fs';
import path from 'node:path';
import { parseIndexMarkdown, parseSourcesCell } from './fastpath-gate.mjs';

export const LANDING_EXIT = { OK: 0, USAGE: 2, BOUNDARY: 21, INTEGRITY: 41, DRIFT: 42 };
const CANONICAL_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'ALL'];
const BATCH_BUDGET = 30 * 1024;           // SKILL §1：单批目标 ≤30KB
const SINGLE_CTRL_TOLERANCE = 50 * 1024;  // 单 Controller 独占批容忍到 50KB
const lvRank = { L1: 1, L2: 2, L3: 3 };

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
export const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
const pad3 = (n) => String(n).padStart(3, '0');
const fail = (code, message, extra = {}) => ({ exitCode: code === 'METHOD_DRIFT' ? LANDING_EXIT.DRIFT : LANDING_EXIT.INTEGRITY, result: { status: 'fail', code, message, ...extra } });

/** route 归一（单点）：method 非规范拼写 → ALL；path 必须补成以 / 开头。与 writer 契约同源。 */
export function normRouteKey(method, p) {
  const mm = String(method ?? '').trim().toUpperCase();
  const canon = CANONICAL_METHODS.includes(mm) ? mm : 'ALL';
  let pth = String(p ?? '').trim();
  if (pth && !pth.startsWith('/')) pth = '/' + pth;
  return { method: canon, path: pth, key: canon + ' ' + pth };
}

/** 完整度：L3 含 SQL 摘要；L2 追到下游/有异常/有事务；L1 仅骨架。 */
export function levelOf(m) {
  if ((m.sql_refs ?? []).length) return 'L3';
  if ((m.call_chain ?? []).length || (m.throws ?? []).length || String(m.transaction ?? '').trim()) return 'L2';
  return 'L1';
}

/** 单个 route 段的规范正文（确定性模板；字段全部来自切片数据，不含模型自由发挥）。 */
export function segmentText(m) {
  const nr = normRouteKey(m.route?.method, m.route?.path);
  const raw = String(m.route_raw_path ?? '').trim();
  const L = [];
  L.push(`--- route: ${nr.key} ---`);
  L.push(`### ${m.name}`);
  L.push('');
  L.push(`- **签名**：\`${String(m.signature ?? '').trim()}\``);
  let routeLine = `- **路由**：\`${nr.key}\``;
  if (raw && raw !== nr.path) routeLine += `（注解原文：\`${raw}\`）`;
  if (m.route_unresolved === true) routeLine += '（**含未解析占位符**，不得据此锚定）';
  L.push(routeLine);
  L.push(`- **完整度**：${levelOf(m)}`);
  const chain = (m.call_chain ?? []).map(String);
  L.push(`- **调用链**：${chain.length ? chain.join(' → ') : '无'}`);
  const sql = (m.sql_refs ?? []).map(s => `${s.op} ${s.entity}`);
  L.push(`- **SQL 引用**：${sql.length ? sql.join('；') : '无'}`);
  const th = (m.throws ?? []).map(t => `${t.exc}${t.msg ? '：' + t.msg : ''}`);
  L.push(`- **显式异常**：${th.length ? th.join('；') : '无'}`);
  if (String(m.transaction ?? '').trim()) L.push(`- **事务边界**：${String(m.transaction).trim()}`);
  for (const ec of (m.external_calls ?? [])) {
    L.push(`- **外部调用**：${[ec.type, ec.endpoint, ec.evidence, ec.config].filter(Boolean).join(' | ')}`);
  }
  L.push(`- **备注**：${String(m.notes ?? '').trim() || '无'}`);
  L.push('');
  return L.join('\n');
}

/** 解析 batch 文件的 route 段（按锚点切分；正文原样保留，不重新生成）。 */
export function parseBatchSegments(text) {
  const lines = String(text).split('\n');
  let i = 0;
  if (lines[0] === '---') { i = 1; while (i < lines.length && lines[i] !== '---') i++; i++; }
  const out = [];
  let cur = null;
  for (; i < lines.length; i++) {
    const m = /^--- route: (.+?) ---\s*$/.exec(lines[i]);
    if (m) { if (cur) out.push(cur); cur = { route: m[1], buf: [lines[i]] }; }
    else if (cur) cur.buf.push(lines[i]);
  }
  if (cur) out.push(cur);
  return out.map(s => ({ route: s.route, text: s.buf.join('\n').replace(/\s+$/, '') + '\n' }));
}

/** 读 module 级 CURRENT。 */
export function readCurrent(contextRoot, module) {
  const modDir = path.join(contextRoot, module);
  const curFile = path.join(modDir, 'CURRENT');
  if (!fs.existsSync(curFile)) return { modDir, gen: null, genDir: null };
  const gen = fs.readFileSync(curFile, 'utf8').replace(/^\uFEFF/, '').trim();
  const genDir = gen ? path.join(modDir, gen) : null;
  return { modDir, gen: gen || null, genDir: genDir && fs.existsSync(genDir) ? genDir : null };
}

/** 读旧代已有 route（index 行 + 段正文，供 copy-on-write 沿用）。 */
export function readOldGen(genDir) {
  const rows = new Map();
  if (!genDir) return rows;
  const idxFile = path.join(genDir, 'index.md');
  if (!fs.existsSync(idxFile)) return rows;
  const parsed = parseIndexMarkdown(fs.readFileSync(idxFile, 'utf8'));
  for (const r of parsed.rows) {
    rows.set(r.route, {
      route: r.route, controller: r.controller, javaMethod: r.method, level: r.level,
      sources: r.sources?.usable ? r.sources.files.join(';') : '-',
      sourcesIncomplete: r.sources?.usable !== true, segment: null
    });
  }
  for (const f of fs.readdirSync(genDir).filter(n => /^batch-\d+(-\d+){0,2}\.md$/.test(n))) {
    for (const seg of parseBatchSegments(fs.readFileSync(path.join(genDir, f), 'utf8'))) {
      const hit = rows.get(seg.route);
      if (hit) hit.segment = seg.text;
    }
  }
  return rows;
}

/** 计划：route 键 → 源码声明序 (file, line)，用于还原逻辑序 L（SKILL §1）。 */
export function readPlanOrder(planFile) {
  const map = new Map();
  if (!planFile || !fs.existsSync(planFile)) return map;
  let plan; try { plan = readJson(planFile); } catch { return map; }
  for (const r of (plan.routes ?? [])) {
    const key = normRouteKey(r.method ?? r.raw_method, r.path).key;
    const rec = { file: String(r.file ?? ''), line: Number(r.line ?? 0) };
    map.set(key, rec);
    // 计划键保留注解原文（含 ${...}），旧代 index 里是展开后的真值 → 再用"末段占位符之后的后缀"兜一层匹配
    const tail = key.replace(/^[A-Z]+\s+/, '').split(/\$\{[^}]*\}/).pop() || '';
    if (tail) map.set('tail:' + tail, rec);
  }
  return map;
}
export function planOrderOf(map, key) {
  if (map.has(key)) return map.get(key);
  const tail = String(key).replace(/^[A-Z]+\s+/, '').split(/\$\{[^}]*\}/).pop() || '';
  if (tail && map.has('tail:' + tail)) return map.get('tail:' + tail);
  // plan 侧 key 保留注解原文（含 ${...} 占位符），切片侧是展开后的真值路径：
  // plan 的 tail（最后一个 ${...} 之后的部分）是切片完整路径（去 method 前缀）的**后缀** → endsWith 兜底。
  const pathPart = String(key).replace(/^[A-Z]+\s+/, '');
  for (const [k, v] of map) {
    if (k.startsWith('tail:') && pathPart.endsWith(k.slice(5))) return v;
  }
  return null;
}

/**
 * 落地主流程。**不打印、不 process.exit**（便于 in-process 测试）。
 * @returns {{exitCode:number, result:object}}
 */
export function runLanding(o) {
  const module = o.module, contextRoot = o.contextRoot;
  const expected = (o.expected ?? []).map(String);
  if (!contextRoot || !module || !o.stagingDir || !expected.length) {
    return { exitCode: LANDING_EXIT.USAGE, result: { status: 'fail', code: 'BAD_ARGS', message: '需要 contextRoot/module/stagingDir/expected' } };
  }

  // ── 1) 读本组切片并校验形状 ──
  const slices = [];
  for (const id of expected) {
    const f = path.join(o.stagingDir, `slice-${id}.json`);
    if (!fs.existsSync(f)) return fail('GEN_INTEGRITY_FAIL', `切片缺失：slice-${id}.json`, { missing: id });
    let j; try { j = readJson(f); } catch (e) { return fail('GEN_INTEGRITY_FAIL', `切片非法 JSON：slice-${id}.json（${e.message}）`); }
    if (j.data !== undefined || j.status !== undefined || j.code !== undefined || !Array.isArray(j.controllers)) {
      return fail('GEN_INTEGRITY_FAIL', `切片顶层形状漂移（应 {module,slice_id,commit,controllers}，不得嵌套 data / 带 status 外壳）：slice-${id}.json`);
    }
    if (String(j.slice_id) !== id) return fail('GEN_INTEGRITY_FAIL', `slice_id 与文件名不一致：期望 ${id}，实得 ${j.slice_id}`);
    if (j.module && String(j.module) !== module) return fail('GEN_INTEGRITY_FAIL', `切片 module 不符：${j.module} ≠ ${module}`);
    slices.push({ id, commit: String(j.commit ?? ''), controllers: j.controllers });
  }
  const commits = [...new Set(slices.map(s => s.commit).filter(Boolean))];
  if (o.commit && commits.length && !commits.includes(o.commit)) {
    return fail('GEN_INTEGRITY_FAIL', `切片 commit 与入参不一致：${commits.join(',')} ≠ ${o.commit}`);
  }
  const commit = o.commit || commits[0] || '';

  // ── 2) 本组 route 集合（同 key 去重；method 归一 + 占位符残留检查）──
  const planOrder = readPlanOrder(o.plan);
  const items = [], seen = new Map();
  let methodNormalized = 0, routeUnresolved = 0, badSources = 0;
  for (const s of slices) {
    for (const c of s.controllers) {
      const simple = String(c.fqn ?? '').split('.').pop();
      for (const m of (c.methods ?? [])) {
        const nr = normRouteKey(m.route?.method, m.route?.path);
        const rawMethod = String(m.route?.method ?? '').trim().toUpperCase();
        if (!rawMethod || !CANONICAL_METHODS.includes(rawMethod)) methodNormalized++;
        if (m.route_unresolved === true) routeUnresolved++;
        const touched = (m.touched_files ?? []).map(String);
        const badPath = touched.some(p => p.startsWith('/') || p.includes('\\') || p.startsWith('./') || /^[A-Za-z]:/.test(p));
        if (m.sources_incomplete === true || badPath) badSources++;
        const it = {
          key: nr.key, controller: simple, ctrlFqn: String(c.fqn ?? ''),
          javaMethod: String(m.name ?? ''), level: levelOf(m), segment: segmentText(m),
          sources: (m.sources_incomplete === true || badPath) ? '-' : new Set(touched),
          srcIncomplete: m.sources_incomplete === true || badPath, carried: false
        };
        if (seen.has(it.key)) items[seen.get(it.key)] = it; else { seen.set(it.key, items.length); items.push(it); }
      }
    }
  }
  if (routeUnresolved) {
    return fail('GEN_INTEGRITY_FAIL', `本组有 ${routeUnresolved} 条 route 仍含未解析 \${...} 占位符，拒绝落地（不得把原文写进锚点/反查表）`);
  }

  // ── 3) copy-on-write：并入旧代未被本次覆盖的 route（段正文与 sources 原样沿用）──
  const cur = readCurrent(contextRoot, module);
  const oldRows = readOldGen(cur.genDir);
  let carried = 0, dropped = 0;
  for (const [key, r] of oldRows) {
    if (seen.has(key)) continue;
    if (!r.segment) { dropped++; continue; }     // 旧行找不到段正文 → 不静默变浅：丢弃并记账
    items.push({
      key, controller: r.controller, ctrlFqn: '', javaMethod: r.javaMethod, level: r.level,
      segment: r.segment, sources: null, oldSourcesRaw: r.sources, srcIncomplete: r.sourcesIncomplete, carried: true
    });
    carried++;
  }

  // ── 4) 逻辑序 L（计划 (file,line) 优先；缺失回退 Controller 名 + 落地序）──
  const orderIdx = new Map(items.map((it, i) => [it, i]));
  let planHits = 0;
  for (const it of items) if (planOrderOf(planOrder, it.key)) planHits++;
  const lOrder = !planOrder.size ? 'fallback(no-plan)' : planHits === items.length ? 'plan' : planHits ? 'plan+fallback' : 'fallback(plan-miss)';
  const ordered = items.slice().sort((a, b) => {
    const oa = planOrderOf(planOrder, a.key), ob = planOrderOf(planOrder, b.key);
    if (oa && ob) {
      if (oa.file !== ob.file) return oa.file < ob.file ? -1 : 1;
      if (oa.line !== ob.line) return oa.line - ob.line;
    }
    if (a.controller !== b.controller) return a.controller < b.controller ? -1 : 1;
    return orderIdx.get(a) - orderIdx.get(b);
  });

  // ── 5) 线性装填（≤30KB；单 Controller 独占容忍 50KB；段 >30KB oversized 独占）──
  const batches = [];
  let cur2 = null;
  const flush = () => { if (cur2 && cur2.items.length) batches.push(cur2); cur2 = null; };
  for (const it of ordered) {
    const segB = bytesOf(it.segment);
    if (cur2) {
      const sameCtrl = cur2.ctrl === it.controller;
      const over = cur2.bytes + segB > BATCH_BUDGET;
      const tolerated = sameCtrl && cur2.onlyCtrl && cur2.bytes + segB <= SINGLE_CTRL_TOLERANCE;
      if (over && !tolerated) flush();
    }
    if (!cur2) cur2 = { ctrl: it.controller, onlyCtrl: true, items: [], bytes: 0 };
    if (cur2.ctrl !== it.controller) cur2.onlyCtrl = false;
    cur2.items.push(it); cur2.bytes += segB; it.oversized = segB > BATCH_BUDGET;
  }
  flush();
  const finalBatches = [];
  for (const b of batches) {
    if (b.items.length > 1 && b.items.some(it => it.oversized)) {
      const ov = b.items.filter(it => it.oversized), rest = b.items.filter(it => !it.oversized);
      for (const o1 of ov) finalBatches.push({ ctrl: o1.controller, onlyCtrl: true, items: [o1], bytes: bytesOf(o1.segment) });
      if (rest.length) finalBatches.push({ ctrl: rest[0].controller, onlyCtrl: rest.every(r => r.controller === rest[0].controller), items: rest, bytes: rest.reduce((s, r) => s + bytesOf(r.segment), 0) });
    } else finalBatches.push(b);
  }

  // ── 6) 生成 batch 文本 + index 行 ──
  const batchNames = [], oversized = [], rows = [];
  finalBatches.forEach((b, bi) => {
    const name = `batch-${pad3(bi + 1)}.md`;
    batchNames.push(name);
    let un = new Set(), dash = false;
    for (const it of b.items) {
      if (it.srcIncomplete || it.sources === '-') { dash = true; continue; }
      if (it.sources instanceof Set) for (const f of it.sources) un.add(f);
      if (it.oldSourcesRaw && it.oldSourcesRaw !== '-') {
        const p = parseSourcesCell(it.oldSourcesRaw);
        if (p?.usable) for (const f of p.files) un.add(f); else dash = true;
      }
    }
    const srcCell = (dash || un.size === 0) ? '-' : [...un].sort().join(';');
    if (b.items.some(it => it.oversized)) oversized.push(name);
    const batchLevel = b.items.map(i => i.level).sort((x, y) => lvRank[y] - lvRank[x])[0];
    const fm = ['---', `batch: ${pad3(bi + 1)}`, `module: ${module}`, 'kind: code',
      `controller: ${b.ctrl}`, `route_count: ${b.items.length}`, `level: ${batchLevel}`,
      `oversized: ${b.items.some(i => i.oversized)}`, '---', '',
      `# ${module} · ${b.ctrl} · batch-${pad3(bi + 1)}`, ''].join('\n');
    let body = fm;
    let written = fm.split('\n').length - 1;       // fm 末尾带换行 → split 多一个空元素；实际已写行数 = length-1
    for (const it of b.items) {
      const segLines = it.segment.replace(/\n$/, '').split('\n');
      const start = written + 1, end = written + segLines.length;
      body += it.segment + '\n';                   // 段（自带尾换行）+ 一个段间空行
      rows.push({ route: it.key, controller: it.controller, method: it.javaMethod, batch: name, lines: `${start}-${end}`, level: it.level, sources: srcCell });
      written = end + 1;                           // 空行也占一行
    }
    b.name = name; b.text = body;
  });

  // ── 7) index.md ──
  const problems = [];
  if (new Set(rows.map(r => r.route)).size !== rows.length) problems.push('index 存在重复 route 行');
  const badMethodRows = rows.filter(r => !CANONICAL_METHODS.includes(String(r.route).split(' ')[0]));
  const badSourceRows = rows.filter(r => r.sources !== '-' && !parseSourcesCell(r.sources)?.usable);
  if (badSourceRows.length) problems.push(`sources 形态非法：${badSourceRows.length} 行`);
  if (dropped) problems.push(`旧代有 ${dropped} 行找不到段正文，已丢弃（不让产物静默变浅）`);
  const ctrlCount = new Set(rows.map(r => r.controller)).size;
  const planCtrlCount = (() => { try { return readJson(o.plan)?.controllers_count ?? null; } catch { return null; } })();
  const now = String(o.now || new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14));
  const gen = `gen-${now}`;
  const learnedAt = `${now.slice(0,4)}-${now.slice(4,6)}-${now.slice(6,8)}T${now.slice(8,10)}:${now.slice(10,12)}:${now.slice(12,14)}+08:00`;
  const idx = ['---', 'schema: supperh-index/2', `module: ${module}`, 'kind: code',
    `learnedAt: ${learnedAt}`, `learnedAtCommit: "${commit}"`,
    `controllers: ${planCtrlCount ?? ctrlCount}`, `coveredControllers: ${ctrlCount}`, '---', '',
    `# ${module} 学习索引（${o.mode}${o.mode === 'update' ? ` ← ${cur.gen ?? '无'}` : ' 首次建立'}）`, '',
    '## route 反查表', '',
    '| route | controller | method | batch | lines | level | sources |',
    '|---|---|---|---|---|---|---|'];
  for (const r of rows) idx.push(`| ${r.route} | ${r.controller} | ${r.method} | ${r.batch} | ${r.lines} | ${r.level} | ${r.sources} |`);
  idx.push('', '## 概览', '',
    `- 本代：${gen}（${o.mode}；上一代 ${cur.gen ?? '无'}）`,
    `- route 总数：${rows.length}（沿用旧代 ${carried} + 本次新落 ${rows.length - carried}）`,
    `- 落地组：expected_slice_ids = [${expected.join(', ')}]`,
    `- 物理批次：${batchNames.join(', ') || '无'}${oversized.length ? `（oversized: ${oversized.join(', ')}）` : '（无 oversized）'}`,
    `- 逻辑序：${lOrder}`,
    `- method 归一：${methodNormalized} 条非规范/null 拼写 → ALL`,
    `- sources：${rows.filter(r => r.sources === '-').length} 行写 '-'（fail-closed），其余为合法 repo-relative POSIX`,
    '');
  const idxText = idx.join('\n') + '\n';

  // ── 8) 自检（真实解析器；不过则不切 CURRENT）──
  const parsed = parseIndexMarkdown(idxText);
  if (parsed.drift) problems.push(`index 格式代际漂移：${parsed.drift}`);
  if ((parsed.missingCols ?? []).length) problems.push(`index 缺列：${parsed.missingCols.join(',')}`);
  if (parsed.rows.length !== rows.length) problems.push(`index 解析行数 ${parsed.rows.length} ≠ 生成行数 ${rows.length}`);
  for (const b of finalBatches) if (!/^--- route: /m.test(b.text)) problems.push(`${b.name} 无 route 锚点`);

  const result = {
    status: problems.length ? 'fail' : 'ok',
    code: problems.length ? 'GEN_INTEGRITY_FAIL' : (o.write ? 'WRITTEN' : 'DRY_RUN_OK'),
    data: {
      gen_dir: path.join(contextRoot, module, gen), prev_gen: cur.gen,
      batches: batchNames, oversized_batches: oversized, needs_repack_group: [],
      index_updated: !problems.length,
      methods_written: rows.length - carried, methods_in_index: rows.length,
      carried_from_prev: carried, method_normalized: methodNormalized,
      route_unresolved_batches: 0,
      sources_batches: new Set(rows.filter(r => r.sources !== '-').map(r => r.batch)).size,
      sources_incomplete_batches: new Set(rows.filter(r => r.sources === '-').map(r => r.batch)).size,
      sources_unusable_batches: 0,
      completeness: { expected: expected.length, landed: slices.length, pct: 100 },
      l_order: lOrder, problems
    }
  };
  if (problems.length) return { exitCode: LANDING_EXIT.INTEGRITY, result };
  if (badMethodRows.length) return { exitCode: LANDING_EXIT.DRIFT, result: { status: 'fail', code: 'METHOD_DRIFT', message: `index 存在非规范 method：${badMethodRows.map(b => b.route).join(', ')}` } };
  if (!o.write) return { exitCode: LANDING_EXIT.OK, result };

  // ── 9) 落盘 → 原子切 CURRENT → 按片清理 → 惰性 GC ──
  const modDir = path.join(contextRoot, module);
  const genDir = path.join(modDir, gen);
  const guard = (p) => { const rel = path.relative(modDir, p); if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('BOUNDARY:' + p); };
  fs.mkdirSync(genDir, { recursive: true });
  for (const b of finalBatches) { const p = path.join(genDir, b.name); guard(p); fs.writeFileSync(p, b.text, 'utf8'); }
  const idxPath = path.join(genDir, 'index.md'); guard(idxPath); fs.writeFileSync(idxPath, idxText, 'utf8');
  const tmp = path.join(modDir, 'CURRENT.tmp'); guard(tmp);
  fs.writeFileSync(tmp, gen, { encoding: 'utf8' });                 // 无 BOM、无尾换行
  fs.renameSync(tmp, path.join(modDir, 'CURRENT'));                 // module 级，不在 gen 内
  for (const id of expected) {                                      // 按片清理：只删本组
    for (const suffix of ['.json', '.json.tmp']) {
      const p = path.join(o.stagingDir, `slice-${id}${suffix}`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
  const keep = Number(o.keep ?? 2);
  const gens = fs.readdirSync(modDir).filter(d => /^gen-\d{14}$/.test(d)).sort();
  const survivors = new Set([gen, cur.gen].filter(Boolean));
  for (const d of gens) {                                           // 惰性 GC：非最近 keep 代，且 >24h 才物理删
    if (survivors.has(d)) continue;
    const idx2 = gens.indexOf(d);
    if (gens.length - idx2 <= keep && !survivors.has(d)) continue;
    const st = fs.statSync(path.join(modDir, d));
    if (Date.now() - st.mtimeMs > 24 * 3600 * 1000) fs.rmSync(path.join(modDir, d), { recursive: true, force: true });
  }
  return { exitCode: LANDING_EXIT.OK, result };
}

// ── CLI ──
export function parseArgs(argv) {
  const o = { mode: 'init', write: false, keep: 2 };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--context-root') o.contextRoot = argv[++i];
    else if (f === '--module') o.module = argv[++i];
    else if (f === '--staging-dir') o.stagingDir = argv[++i];
    else if (f === '--expected-slice-ids') o.expected = String(argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    else if (f === '--mode') o.mode = argv[++i];
    else if (f === '--commit') o.commit = argv[++i];
    else if (f === '--plan') o.plan = argv[++i];
    else if (f === '--project') o.project = argv[++i];
    else if (f === '--now') o.now = argv[++i];
    else if (f === '--keep') o.keep = Number(argv[++i]);
    else if (f === '--write') o.write = true;
  }
  return o;
}

export function main(argv = process.argv.slice(2)) {
  const { exitCode, result } = runLanding(parseArgs(argv));
  console.log(JSON.stringify(result, null, 2));
  return exitCode;
}

if (process.argv[1] && process.argv[1].endsWith('landing-engine.mjs')) process.exit(main());
