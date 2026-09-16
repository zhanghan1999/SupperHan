// tests/flow-cli.test.mjs
// flow 一期需求的 §8 端到端用例：走真子进程、断真退出码与真 JSON envelope。
//
// 为什么这一支单独成文件、且必须起子进程：需求书 §8 用例 1 点名"走命令行的端到端
// 用例"，本仓踩过"落盘与门禁类 CLI 只测纯函数，漏掉整条写入/解析路径的崩溃"。这里
// 覆盖的是把 `--flow-readiness` / `--flow-plan` 两个只读旗标一路从 argv 打到退出码
// 的完整接线（含 resolve-project 对 flow-engine 的 import、私有根装载、freshness 读表、
// blockers 组装）——纯函数测试证伪不了"旗标名拼错""envelope 少字段""exitCode 被别的
// 门禁抢写"这一类只在 CLI 层才暴露的缺陷。
//
// 夹具一律用 fx-* 中性名 + demo/localhost 这类既有测试里已在用的通用值；绝不写真实现
// 网的槽位名 / 主机名 / 凭据（sync 的 L1 纯度扫描覆盖 tests/）。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs      from 'node:fs';
import os      from 'node:os';
import path    from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { evaluateFastPath, EXIT as FP_EXIT } from '../scripts/fastpath-gate.mjs';
import { buildPlan, normalizeRoute } from '../scripts/flow-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RP        = path.join(__dirname, '..', 'scripts', 'resolve-project.mjs');
const GEN       = 'gen-20260101120000';

let root, privateRoot;

function runCli(args, priv) {
  const r = spawnSync(process.execPath, [RP, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SUPPERH_PRIVATE_ROOT: priv ?? privateRoot }
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 让断言去报原文 */ }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

/** 注册一个项目：withDb=false 时整段 db/drivers 都不写（flow 与库无关的正证）。 */
function registerProject(code, { withDb = true, modules = ['order'] } = {}) {
  const ws = path.join(root, 'ws-' + code);
  fs.mkdirSync(ws, { recursive: true });
  const w = ws.replace(/\\/g, '/');
  const moduleLines = modules.map((m) => `  - name: ${m}\n    entryPattern: '**/*.java'`).join('\n');
  const dbBlock = withDb
    ? 'db:\n  host: localhost\n  port: 5432\n  schemas: { prod: p, uat: u, test: t }\n  readonlyUser: ro\n' +
      'branches: { prod: prod, uat: uat, dev: dev }\ndrivers:\n  database: { impl: noop.py, healthCheck: noop.py }\n'
    : 'branches: { prod: prod, uat: uat, dev: dev }\n';
  fs.writeFileSync(path.join(privateRoot, 'projects', `${code}.yaml`),
    `schemaVersion: 1\nidentity:\n  code: ${code}\n  displayName: ${code}\n  workspaces:\n    - "${w}"\n` +
    `codeRoot: "${w}"\npackageRoot: com.fx\nmodules:\n${moduleLines}\n` +
    `build:\n  tool: maven\n  jdk: '1.8'\n  compileCmd: mvn compile\n  testCmd: mvn test\n${dbBlock}` +
    `naming:\n  commandPrefix: /supperH\n`, 'utf8');
  return ws;
}

/** 把某个分区（模块或 screens）标成"已学"：写 CURRENT + <gen>/index.md（七列反查表）。 */
function learnPartition(code, part, rows) {
  const dir = path.join(privateRoot, 'context', code, part);
  fs.mkdirSync(path.join(dir, GEN), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CURRENT'), GEN + '\n', 'utf8');
  const body = [
    '---', 'schema: supperh-index/2', `module: ${part}`,
    part === 'screens' ? 'kind: screens' : 'kind: code',
    'learnedAt: 2026-09-10T08:30:00+08:00',
    'learnedAtCommit: 0000000000000000000000000000000000000000',
    '---', '',
    '| route | controller | method | batch | lines | level | sources |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.route} | ${r.controller} | ${r.method || 'm'} | batch-01.md | 1-9 | L3 | src/main/java/com/fx/${r.controller}.java |`),
    ''
  ].join('\n');
  fs.writeFileSync(path.join(dir, GEN, 'index.md'), body, 'utf8');
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-flowcli-'));
  privateRoot = path.join(root, 'private');
  fs.mkdirSync(path.join(privateRoot, 'projects'), { recursive: true });
});

// ───────────────────────────────────────────────────────────────────────────
// 用例 1：--flow-readiness 端到端（未学 code / 未学 screens / 全就绪 三种）
//   + 断言"接没接数据库都不进 blockers"
// ───────────────────────────────────────────────────────────────────────────

test('用例1-A 未学 code：screens 已学但模块无代码代次 → 41 + blockers 含 CODE_NOT_LEARNED', () => {
  const ws = registerProject('fx-nocode', { withDb: true, modules: ['order'] });
  learnPartition('fx-nocode', 'screens', [{ route: '/fx/order/list', controller: 'FxOrderController' }]);
  // 故意不建 context/fx-nocode/order —— 代码没学
  const r = runCli(['--cwd', ws, '--flow-readiness']);
  assert.equal(r.status, 41, 'blockers 非空必须落 41（不是 36/0）：' + r.stderr);
  assert.equal(r.json.flowReadiness.evaluated, true);
  assert.equal(r.json.flowReadiness.ready, false);
  const codes = r.json.flowReadiness.blockers.map((b) => b.code);
  assert.ok(codes.includes('CODE_NOT_LEARNED'), JSON.stringify(codes));
  // 每条 blocker 都得自带人话与可执行动作，不能只回一个码
  for (const b of r.json.flowReadiness.blockers) {
    assert.ok(b.meaning_zh && b.action_zh, JSON.stringify(b));
  }
  assert.ok(r.stdout.length > 0, 'stdout 永不落空');
});

test('用例1-B 未学 screens：页面档案缺失 → 41 + blockers 含 SCREENS_NOT_LEARNED', () => {
  const ws = registerProject('fx-noscreens', { withDb: true, modules: ['order'] });
  learnPartition('fx-noscreens', 'order', [{ route: '/fx/order/list', controller: 'FxOrderController' }]);
  // 不建 screens
  const r = runCli(['--cwd', ws, '--flow-readiness']);
  assert.equal(r.status, 41, r.stderr);
  const codes = r.json.flowReadiness.blockers.map((b) => b.code);
  assert.ok(codes.includes('SCREENS_NOT_LEARNED'), JSON.stringify(codes));
  assert.equal(r.json.flowReadiness.screens.available, false);
});

test('用例1-C 全就绪：screens + 模块都学到 → 0 + blockers 空', () => {
  const ws = registerProject('fx-ready', { withDb: true, modules: ['order'] });
  learnPartition('fx-ready', 'screens', [{ route: '/fx/order/list', controller: 'FxOrderController' }]);
  learnPartition('fx-ready', 'order', [{ route: '/fx/order/list', controller: 'FxOrderController' }]);
  const r = runCli(['--cwd', ws, '--flow-readiness']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.flowReadiness.ready, true);
  assert.deepEqual(r.json.flowReadiness.blockers, []);
  assert.equal(r.json.flowReadiness.code.modules_ready.includes('order'), true);
});

test('用例1-D 数据库与 flow 就绪无关：不接库的项目全就绪同样退 0，任何场景 blockers 里都无库码', () => {
  const ws = registerProject('fx-nodb', { withDb: false, modules: ['order'] });
  learnPartition('fx-nodb', 'screens', [{ route: '/fx/order/list', controller: 'FxOrderController' }]);
  learnPartition('fx-nodb', 'order', [{ route: '/fx/order/list', controller: 'FxOrderController' }]);
  const r = runCli(['--cwd', ws, '--flow-readiness']);
  assert.equal(r.status, 0, '不接库不是缺学习数据：' + r.stderr);
  assert.equal(r.json.flowReadiness.ready, true, JSON.stringify(r.json.flowReadiness.blockers));
  assert.ok(!('db' in r.json) || r.json.db == null || Object.keys(r.json.db).length === 0,
    '夹具本身确实没接库（否则这条正证不成立）');

  // 反面：三种情形（含未就绪）的 blockers 里都不许出现任何"库/数据源"类码
  const probe = [
    registerProject('fx-nodb2', { withDb: false, modules: ['order'] }),          // 未学 code
    (() => { const w = registerProject('fx-nodb3', { withDb: false, modules: ['order'] });
             learnPartition('fx-nodb3', 'screens', [{ route: '/fx/x', controller: 'FxX' }]); return w; })(), // 未学 code(screens有)
  ];
  const DBISH = /db|database|source|库|数据源|conn/i;
  for (const w of probe) {
    const rr = runCli(['--cwd', w, '--flow-readiness']);
    for (const b of rr.json.flowReadiness.blockers) {
      assert.ok(!DBISH.test(b.code), `blockers 里不得混进库依赖码（防日后有人加回来）：${b.code}`);
    }
  }
});

test('用例1-E flow 只读旗标的参数缺口一律 36，绝不被误诊成 41（"去补学习"）', () => {
  const ws = registerProject('fx-ready2', { withDb: true, modules: ['order'] });
  learnPartition('fx-ready2', 'screens', [{ route: '/fx/order/list', controller: 'FxOrderController' }]);
  learnPartition('fx-ready2', 'order', [{ route: '/fx/order/list', controller: 'FxOrderController' }]);
  assert.equal(runCli(['--cwd', ws, '--page', '/fx/order/list']).status, 36, '只给 --page 不给 flow 旗标 = 没人校 → 36');
  assert.equal(runCli(['--cwd', ws, '--flow-readiness', '--flow-plan']).status, 36, '两个只读旗标互斥 → 36');
  assert.equal(runCli(['--cwd', ws, '--flow-plan', '--strict']).status, 36, '--strict 只对 readiness 有意义 → 36');
  const r = runCli(['--cwd', ws, '--flow-readiness', '--page']);
  assert.equal(r.status, 36, '末尾 --page 无值 → 36，不得落到 41');
  assert.equal(r.json.flowReadiness.evaluated, false, '未求值得占住字段位、标 evaluated:false');
});

// ───────────────────────────────────────────────────────────────────────────
// 用例 7：flows 保留分区在 fastpath-gate 被排除
// ───────────────────────────────────────────────────────────────────────────

test('用例7 保留分区 flows / screens 一律被排除在 bug 快路径之外（G2 fail → 32）', () => {
  const cr = path.join(privateRoot, 'context', 'fx-ready');
  for (const mod of ['flows', 'screens']) {
    const r = evaluateFastPath({ contextRoot: cr, module: mod, anchor: 'GET /fx/order/list', text: '创建人字段为空' });
    assert.equal(r.eligible, false, `${mod} 绝不允许 eligible=true`);
    assert.equal(r.status, FP_EXIT.NO_INDEX, `${mod} 应短路成 32（数据未就绪那档），实际 ${r.status}`);
    assert.equal(r.gates.G2_dataReady, 'fail');
    assert.match(r.message, new RegExp(mod), `得说清是保留分区而非"没数据"：${r.message}`);
  }
});

test('用例7 反证：一个 index.md 里 frontmatter kind=flows 的普通模块同样被 kind 判据排除', () => {
  const code = 'fx-kindflow';
  const ws = registerProject(code, { withDb: true, modules: ['order'] });
  const dir = path.join(privateRoot, 'context', code, 'order', GEN);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(privateRoot, 'context', code, 'order', 'CURRENT'), GEN + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'index.md'),
    ['---', 'schema: supperh-index/2', 'module: order', 'kind: flows',
     'learnedAtCommit: 0000000000000000000000000000000000000000', '---', '',
     '| route | controller | method | batch | lines | level | sources |',
     '|---|---|---|---|---|---|---|',
     '| /fx/a | C | m | b.md | 1-2 | L3 | src/main/java/C.java |', ''].join('\n'), 'utf8');
  const r = evaluateFastPath({ contextRoot: path.join(privateRoot, 'context', code), module: 'order',
    anchor: 'GET /fx/a', text: '空' });
  assert.equal(r.gates.G2_dataReady, 'fail');
  assert.equal(r.status, FP_EXIT.NO_INDEX, 'frontmatter kind=flows 命中即出局');
  assert.ok(ws);
});

// ───────────────────────────────────────────────────────────────────────────
// 用例 17（CLI 侧）：--flow-plan 字节一致 + 结构约束；纯函数侧再补乱序一致
// ───────────────────────────────────────────────────────────────────────────

test('用例17-CLI --flow-plan 同一输入连跑两次字节一致，且一片 ≤3 route / 一波 ≤2 片 / 一片内同 Controller', () => {
  const code = 'fx-plan';
  const ws = registerProject(code, { withDb: true, modules: ['order'] });
  // 造 5 条 FxA 路由（拆成 2 片：3+2）+ 2 条 FxB（1 片），全在 screens 清单内
  // 路由叶子段必须非数字：VAR_SEGMENT_RE 会把纯数字段归一成 {}，数字路由会互相塌缩
  const rows = [
    { route: '/fx/a/list', controller: 'FxAController' }, { route: '/fx/a/get', controller: 'FxAController' },
    { route: '/fx/a/post', controller: 'FxAController' }, { route: '/fx/a/del', controller: 'FxAController' },
    { route: '/fx/a/edit', controller: 'FxAController' }, { route: '/fx/b/list', controller: 'FxBController' },
    { route: '/fx/b/get', controller: 'FxBController' },
  ];
  learnPartition(code, 'screens', rows);
  learnPartition(code, 'order', rows);

  const r1 = runCli(['--cwd', ws, '--flow-plan']);
  const r2 = runCli(['--cwd', ws, '--flow-plan']);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(Buffer.compare(Buffer.from(r1.stdout, 'utf8'), Buffer.from(r2.stdout, 'utf8')), 0,
    '同输入两次 --flow-plan 必须字节一致（分片决定可重生成性）');
  const plan = r1.json.flowPlan;
  assert.equal(plan.evaluated, true);
  assert.equal(plan.total_routes, 7, JSON.stringify(plan.waves));
  for (const wv of plan.waves) {
    assert.ok(wv.parts.length <= 2, `一波 ≤ 2 片，实际 ${wv.parts.length}`);
    for (const p of wv.parts) {
      assert.ok(p.page_keys.length >= 1 && p.page_keys.length <= 3, `一片 ≤ 3 route，实际 ${p.page_keys.length}`);
    }
  }
  // 每个 part 内所有 route 必属同一 Controller：拿 index.md 里的映射反查校验
  const ctrlOf = new Map(rows.map((x) => [normalizeRoute(x.route), x.controller]));
  for (const wv of plan.waves) for (const p of wv.parts) {
    const ctrls = new Set(p.page_keys.map((k) => ctrlOf.get(k)));
    assert.equal(ctrls.size, 1, `一片内 route 必须同属一个 Controller：${JSON.stringify([...ctrls])}`);
    assert.ok(ctrls.has(p.controller) || p.controller === '(unknown)', '片标注的 controller 与 route 归属一致');
  }
});

test('用例17-pure buildPlan 不受目录/行序影响：打乱输入序 → 输出 JSON 字节一致', () => {
  // 叶子段非数字，避免被归一成 {} 而互相塌缩（那会让 total 与预期不符）
  const rows = [
    { route: '/fx/a/one', controller: 'FxAController', module: 'order' },
    { route: '/fx/a/two', controller: 'FxAController', module: 'order' },
    { route: '/fx/b/one', controller: 'FxBController', module: 'order' },
    { route: '/fx/a/two', controller: 'FxAController', module: 'order' }, // 重复：应被去重（Set）
    { route: '/fx/c/nine', controller: 'FxCController', module: 'order' },
  ];
  const shuffled = [rows[4], rows[1], rows[2], rows[0], rows[3]];
  const p1 = buildPlan(rows);
  const p2 = buildPlan(shuffled);
  assert.equal(JSON.stringify(p1), JSON.stringify(p2), '归属不得由遍历顺序决定');
  assert.equal(p1.total_routes, 4, '四条去重后的 route（重复的 /fx/a/1 折叠成一条）');
});
