// tests/landing-engine.test.mjs
// 确定性落地引擎的机械回归：
//   1) init 落地：新代 + module 级 CURRENT + 七列 index + 按片清理；
//   2) update 尾组：copy-on-write 沿用旧行 + 同 Controller 跨组合并（不新开 batch）+ 总行数不丢；
//   3) 确定性：同一份输入两次落地，index 表体逐字节相同；
//   4) fail-closed：切片含未解析占位符 → GEN_INTEGRITY_FAIL 且不切 CURRENT；
//   5) 逻辑序 L：有计划用 (file,line)，无计划回退；
//   6) 越界形态：切片嵌套 data / slice_id 不符 → 拒收。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runLanding, parseBatchSegments, normRouteKey, levelOf } from '../scripts/landing-engine.mjs';
import { parseIndexMarkdown } from '../scripts/fastpath-gate.mjs';

const MODULE = 'demo-biz';
const COMMIT = 'a'.repeat(40);
const CTRL = 'com.example.demo.web.RollingTestController';

/** 造一个切片文件（顶层形状契约：{module,slice_id,commit,controllers}）。 */
function mkSlice(stagingDir, id, methods, { ctrl = CTRL, commit = COMMIT, nestData = false, sliceIdOverride = null } = {}) {
  const body = {
    commit,
    controllers: [{
      fqn: ctrl,
      file: 'C:/fake/src/main/java/com/example/demo/web/RollingTestController.java',
      methods
    }]
  };
  const top = nestData
    ? { module: MODULE, slice_id: sliceIdOverride ?? id, commit, data: body }
    : { module: MODULE, slice_id: sliceIdOverride ?? id, commit, ...body };
  fs.writeFileSync(path.join(stagingDir, `slice-${id}.json`), JSON.stringify(top, null, 2), 'utf8');
}

/** 造一个方法记录（analyzer 输出形状）。 */
function mkMethod(name, routePath, { method = null, touched = null, sql = [], chain = [], throws = [], rawPath = null, unresolved = false, incomplete = false } = {}) {
  const file = 'src/main/java/com/example/demo/web/RollingTestController.java';
  return {
    name,
    signature: `public String ${name}()`,
    route: { method, path: routePath },
    ...(rawPath ? { route_raw_path: rawPath } : {}),
    route_unresolved: unresolved,
    anchor: `--- route: ${name} ---`,
    call_chain: chain,
    touched_files: touched ?? [file],
    sources_incomplete: incomplete,
    sql_refs: sql,
    throws,
    transaction: '',
    external_calls: [],
    notes: ''
  };
}

function mkEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-land-'));
  const contextRoot = path.join(root, 'context', 'demobiz');
  const stagingDir = path.join(root, 'staging', MODULE, 'gen-20260924000000');
  fs.mkdirSync(path.join(contextRoot, MODULE), { recursive: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  return { root, contextRoot, stagingDir };
}
const planFile = (root, routes) => {
  const p = path.join(root, 'plan.json');
  fs.writeFileSync(p, JSON.stringify({ controllers_count: 1, routes }), 'utf8');
  return p;
};
const idxOf = (contextRoot) => {
  const cur = fs.readFileSync(path.join(contextRoot, MODULE, 'CURRENT'), 'utf8').replace(/^\uFEFF/, '').trim();
  return { gen: cur, parsed: parseIndexMarkdown(fs.readFileSync(path.join(contextRoot, MODULE, cur, 'index.md'), 'utf8')) };
};

test('init 落地：新代 + module 级 CURRENT + 七列 index + 按片清理', () => {
  const { contextRoot, stagingDir } = mkEnv();
  mkSlice(stagingDir, '01', [mkMethod('m01', '/rolltest/m01'), mkMethod('m02', '/rolltest/m02')]);
  mkSlice(stagingDir, '02', [mkMethod('m03', '/rolltest/m03')]);
  const { exitCode, result } = runLanding({ contextRoot, module: MODULE, stagingDir, expected: ['01', '02'], commit: COMMIT, mode: 'init', now: '20260924010101', write: true });
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.code, 'WRITTEN');
  const { gen, parsed } = idxOf(contextRoot);
  assert.equal(gen, 'gen-20260924010101');
  assert.equal(parsed.rows.length, 3, '3 条 route 全部进反查表');
  assert.deepEqual(parsed.missingCols, []);
  assert.equal(parsed.drift, null);
  assert.equal(parsed.frontmatter.schema, 'supperh-index/2');
  // CURRENT 必须在 module 级、不在 gen 内
  assert.ok(!fs.existsSync(path.join(contextRoot, MODULE, gen, 'CURRENT')), 'CURRENT 不得写进 gen 目录');
  // method 归一
  assert.deepEqual(parsed.rows.map(r => r.route), ['ALL /rolltest/m01', 'ALL /rolltest/m02', 'ALL /rolltest/m03']);
  // 按片清理：本组切片已删
  assert.ok(!fs.existsSync(path.join(stagingDir, 'slice-01.json')));
  assert.ok(!fs.existsSync(path.join(stagingDir, 'slice-02.json')));
});

test('update 尾组：copy-on-write 沿用旧行 + 跨组合并不新开 batch + 行数不丢', () => {
  const { contextRoot, stagingDir } = mkEnv();
  mkSlice(stagingDir, '01', [mkMethod('m01', '/rolltest/m01'), mkMethod('m02', '/rolltest/m02')]);
  mkSlice(stagingDir, '02', [mkMethod('m03', '/rolltest/m03')]);
  runLanding({ contextRoot, module: MODULE, stagingDir, expected: ['01', '02'], commit: COMMIT, mode: 'init', now: '20260924010101', write: true });
  // 尾组：只 1 片（非 3 倍数），且与上一组同 Controller
  mkSlice(stagingDir, '03', [mkMethod('m04', '/rolltest/m04')]);
  const { exitCode, result } = runLanding({ contextRoot, module: MODULE, stagingDir, expected: ['03'], commit: COMMIT, mode: 'update', now: '20260924010202', write: true });
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.data.prev_gen, 'gen-20260924010101');
  assert.equal(result.data.methods_written, 1);
  assert.equal(result.data.carried_from_prev, 3, '旧 3 行必须被沿用');
  const { parsed } = idxOf(contextRoot);
  assert.equal(parsed.rows.length, 4, '旧 3 + 新 1 = 4，一行不丢');
  assert.equal(new Set(parsed.rows.map(r => r.batch)).size, 1, '同 Controller 跨组 → 并进同一个 batch，不新开文件');
  assert.ok(!fs.existsSync(path.join(stagingDir, 'slice-03.json')));
});

test('确定性：同一输入两次落地，index 表体逐字节相同（只有代名/learnedAt 不同）', () => {
  const body = (ctx, now) => {
    const { contextRoot, stagingDir } = mkEnv();
    mkSlice(stagingDir, '01', [mkMethod('a', '/x/a', { chain: ['S#a'], sql: [{ op: 'select', entity: '<T_A>' }] }), mkMethod('b', '/x/b')]);
    runLanding({ contextRoot, module: MODULE, stagingDir, expected: ['01'], commit: COMMIT, mode: 'init', now, write: true });
    const { gen } = idxOf(contextRoot);
    return fs.readFileSync(path.join(contextRoot, MODULE, gen, 'index.md'), 'utf8')
      .replace(/gen-\d{14}/g, 'GEN').replace(/learnedAt: .*/g, 'learnedAt: T');
  };
  assert.equal(body(null, '20260924010101'), body(null, '20260924020303'), '同输入必须字节一致（脚本化的意义所在）');
});

test('fail-closed：含未解析占位符 → 不落地、不切 CURRENT、不删切片', () => {
  const { contextRoot, stagingDir } = mkEnv();
  mkSlice(stagingDir, '01', [mkMethod('a', '${adminPath}/x/a', { rawPath: '${adminPath}/x/a', unresolved: true })]);
  const { exitCode, result } = runLanding({ contextRoot, module: MODULE, stagingDir, expected: ['01'], commit: COMMIT, mode: 'init', now: '20260924010101', write: true });
  assert.notEqual(exitCode, 0);
  assert.equal(result.code, 'GEN_INTEGRITY_FAIL');
  assert.ok(!fs.existsSync(path.join(contextRoot, MODULE, 'CURRENT')), '自检不过不得切 CURRENT');
  assert.ok(fs.existsSync(path.join(stagingDir, 'slice-01.json')), '失败保留切片供排查');
});

test('拒收形态漂移：嵌套 data / slice_id 不符', () => {
  const a = mkEnv();
  mkSlice(a.stagingDir, '01', [mkMethod('a', '/x/a')], { nestData: true });
  assert.equal(runLanding({ contextRoot: a.contextRoot, module: MODULE, stagingDir: a.stagingDir, expected: ['01'], commit: COMMIT, write: false }).result.code, 'GEN_INTEGRITY_FAIL');
  const b = mkEnv();
  mkSlice(b.stagingDir, '01', [mkMethod('a', '/x/a')], { sliceIdOverride: '99' });
  assert.equal(runLanding({ contextRoot: b.contextRoot, module: MODULE, stagingDir: b.stagingDir, expected: ['01'], commit: COMMIT, write: false }).result.code, 'GEN_INTEGRITY_FAIL');
});

test('逻辑序 L：有计划用 (file,line) 还原声明序；无计划回退且如实标注', () => {
  const { root, contextRoot, stagingDir } = mkEnv();
  // 故意让完成序与声明序相反：slice-02 的方法声明行更小
  mkSlice(stagingDir, '01', [mkMethod('late', '/rolltest/late')]);
  mkSlice(stagingDir, '02', [mkMethod('early', '/rolltest/early')]);
  const p = planFile(root, [
    { id: 'r2', key: 'ALL /rolltest/early', method: 'ALL', path: '/rolltest/early', controller: CTRL, file: 'A.java', line: 10 },
    { id: 'r1', key: 'ALL /rolltest/late', method: 'ALL', path: '/rolltest/late', controller: CTRL, file: 'A.java', line: 90 }
  ]);
  const withPlan = runLanding({ contextRoot, module: MODULE, stagingDir, expected: ['01', '02'], commit: COMMIT, mode: 'init', now: '20260924010101', plan: p, write: true });
  assert.equal(withPlan.result.data.l_order, 'plan');
  const order = idxOf(contextRoot).parsed.rows.map(r => r.route);
  assert.deepEqual(order, ['ALL /rolltest/early', 'ALL /rolltest/late'], '按源码声明序（line 10 在 line 90 前）');
  const noPlanEnv = mkEnv();     // 上一轮 write 已按片清理 staging，回退用例要用新的
  mkSlice(noPlanEnv.stagingDir, '01', [mkMethod('late', '/rolltest/late')]);
  mkSlice(noPlanEnv.stagingDir, '02', [mkMethod('early', '/rolltest/early')]);
  const noPlan = runLanding({ contextRoot: noPlanEnv.contextRoot, module: MODULE, stagingDir: noPlanEnv.stagingDir, expected: ['01', '02'], commit: COMMIT, mode: 'init', now: '20260924020202', write: false });
  assert.match(noPlan.result.data.l_order, /^fallback/, '无计划必须如实标注回退');
});

test('逻辑序 L：plan 键含 ${...} 占位符、切片键是展开真值 → endsWith 兜底仍按 (file,line) 定序（真实场景：${adminPath}）', () => {
  const { root, contextRoot, stagingDir } = mkEnv();
  // 切片侧 route.path 是占位符解析后的真值 /a/...；plan 侧 key 保留注解原文 ${adminPath}/...
  mkSlice(stagingDir, '01', [mkMethod('late', '/a/measure/measureScheme/list')]);
  mkSlice(stagingDir, '02', [mkMethod('early', '/a/measure/measureScheme/form')]);
  const p = planFile(root, [
    { id: 'r2', key: 'ALL ${adminPath}/measure/measureScheme/form', method: 'ALL', path: '${adminPath}/measure/measureScheme/form', controller: CTRL, file: 'A.java', line: 10 },
    { id: 'r1', key: 'ALL ${adminPath}/measure/measureScheme/list', method: 'ALL', path: '${adminPath}/measure/measureScheme/list', controller: CTRL, file: 'A.java', line: 38 }
  ]);
  const r = runLanding({ contextRoot, module: MODULE, stagingDir, expected: ['01', '02'], commit: COMMIT, mode: 'init', now: '20260924030303', plan: p, write: true });
  assert.equal(r.result.data.l_order, 'plan', '占位符计划必须命中（endsWith 兜底）');
  const order = idxOf(contextRoot).parsed.rows.map(x => x.route);
  assert.deepEqual(order, ['ALL /a/measure/measureScheme/form', 'ALL /a/measure/measureScheme/list'], '按源码声明序（form L10 在 list L38 前）');
});

test('route 段解析与完整度判定：锚点切分 + L1/L2/L3', () => {
  const txt = ['---', 'batch: 001', '---', '', '--- route: ALL /x/a ---', '### a', '', '- x', '', '--- route: ALL /x/b ---', '### b', ''].join('\n');
  const segs = parseBatchSegments(txt);
  assert.deepEqual(segs.map(s => s.route), ['ALL /x/a', 'ALL /x/b']);
  assert.equal(normRouteKey(null, 'x/a').key, 'ALL /x/a', '裸 @RequestMapping → ALL + 补前导斜杠');
  assert.equal(normRouteKey('ANY', '/x/a').key, 'ALL /x/a', 'ANY 是非规范拼写 → ALL');
  assert.equal(levelOf(mkMethod('a', '/x/a')), 'L1');
  assert.equal(levelOf(mkMethod('a', '/x/a', { chain: ['S#a'] })), 'L2');
  assert.equal(levelOf(mkMethod('a', '/x/a', { sql: [{ op: 'select', entity: '<T>' }] })), 'L3');
});
