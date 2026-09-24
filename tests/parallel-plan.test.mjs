// tests/parallel-plan.test.mjs
// --parallel-plan 脚本出口（scripts/parallel-plan.mjs）回归。
// 覆盖：注解扫描（裸 @RequestMapping → ALL 键 / 简写 / 类级前缀 / ADMIN 占位符原样保留 / scan_incomplete）、
// 确定性切片（同输入必同字节）、无重叠/并集不变式、巨型 Controller 方法窗口、纯目录 CLI 冒烟 + 退出码。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as PP from '../scripts/parallel-plan.mjs';
const { parseRouteInventory, buildParallelPlan, runPlan, EXIT, stripComments } = PP;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'parallel-plan.mjs');
const ADMIN = '$' + '{adminPath}';   // 字面 ADMIN 占位符（String.raw 内容里禁止 $ 紧跟 {）

// 夹具一律 fx/中性 route，绝不含真实项目槽位名/主机名/凭据。
function mkTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-pplan-'));
  const java = path.join(root, 'src', 'main', 'java', 'com', 'fx');
  fs.mkdirSync(java, { recursive: true });
  fs.writeFileSync(path.join(java, 'OrderController.java'), [
    'package com.fx;',
    '@RestController',
    '@RequestMapping("/api/v1/order")',
    'public class OrderController {',
    '  @GetMapping("/list")',
    '  public R list() { return null; }',
    '  @RequestMapping(value = "/create", method = RequestMethod.POST)',
    '  public R create(@RequestBody X x) { return null; }',
    '  @PostMapping("/save")',
    '  public R save(@RequestBody X x) { return null; }',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(java, 'BareController.java'), [
    'package com.fx;',
    '@RestController',
    '@RequestMapping("' + ADMIN + '/bare")',
    'public class BareController {',
    '  @RequestMapping("/x")',
    '  public R x() { return null; }',
    '  @RequestMapping(value = "/y", method = RequestMethod.DELETE)',
    '  public R y() { return null; }',
    '}',
  ].join('\n'));
  const g = [];
  for (let i = 1; i <= 60; i++) {
    const m = 'm' + String(i).padStart(2, '0');
    g.push('  @GetMapping("/g/' + i + '")');
    g.push('  public R ' + m + '() { return null; }');
  }
  fs.writeFileSync(path.join(java, 'GiantController.java'), [
    'package com.fx;',
    '@RestController',
    '@RequestMapping("/g")',
    'public class GiantController {',
    g.join('\n'),
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(java, 'WeirdController.java'), [
    'package com.fx;',
    '@RestController',
    '@RequestMapping',
    'public class WeirdController {',
    '  @GetMapping("/w")',
    '  public R w() { return null; }',
    '}',
  ].join('\n'));
  return root;
}

test('parseRouteInventory：裸 @RequestMapping → ALL 键，raw_method=null，简写/显式 method 保留', () => {
  const { routes, incomplete } = parseRouteInventory([
    '@RestController',
    '@RequestMapping("/api/order")',
    'public class O {',
    '  @RequestMapping("/bare")',
    '  public R bare() { return null; }',
    '  @GetMapping("/g")',
    '  public R g() { return null; }',
    '  @RequestMapping(value = "/del", method = RequestMethod.DELETE)',
    '  public R del() { return null; }',
    '}',
  ].join('\n'));
  assert.equal(incomplete, false);
  assert.equal(routes.length, 3);
  assert.equal(routes.find((r) => r.java_method === 'bare').key, 'ALL /api/order/bare');
  assert.equal(routes.find((r) => r.java_method === 'bare').raw_method, null);
  assert.equal(routes.find((r) => r.java_method === 'g').method, 'GET');
  assert.equal(routes.find((r) => r.java_method === 'del').method, 'DELETE');
});

test('parseRouteInventory：ADMIN 占位符原样保留（与锚点字面一致契约）', () => {
  const { routes } = parseRouteInventory([
    '@RestController',
    '@RequestMapping("' + ADMIN + '/bare")',
    'public class B {',
    '  @RequestMapping("/x")',
    '  public R x() { return null; }',
    '}',
  ].join('\n'));
  assert.equal(routes.length, 1);
  assert.equal(routes[0].key, 'ALL ' + ADMIN + '/bare/x');
});

test('parseRouteInventory：裸类级 @RequestMapping（无路径）→ 空前缀挂根，不再标不完整', () => {
  const { routes, incomplete } = parseRouteInventory([
    '@RestController',
    '@RequestMapping',
    'public class W {',
    '  @GetMapping("/w")',
    '  public R w() { return null; }',
    '}',
  ].join('\n'));
  assert.equal(incomplete, false, '裸类级 @RequestMapping = Spring 空前缀（挂根），不是未知');
  const w = routes.find((r) => r.java_method === 'w');
  assert.ok(w, '方法级 route 应被扫到');
  assert.equal(w.key, 'GET /w');
});

test('parseRouteInventory：类级多值前缀 → scan_incomplete=true（前缀覆盖可能不全）', () => {
  const { routes, incomplete } = parseRouteInventory([
    '@RestController',
    '@RequestMapping({"/a", "/b"})',
    'public class M {',
    '  @GetMapping("/list")',
    '  public R list() { return null; }',
    '}',
  ].join('\n'));
  assert.equal(incomplete, true);
  assert.equal(routes.find((r) => r.java_method === 'list').key, 'GET /a/list', '取第一个前缀，标记不完整');
});

test('parseRouteInventory：块注释里的注解不得成为幽灵路由（实案：*//* 紧跟块注释）', () => {
  const { routes, incomplete } = parseRouteInventory([
    '@RestController',
    '@RequestMapping("/api/order")',
    'public class O {',
    '  @GetMapping("/real")',
    '  public R real() { return null; }',
    '  /**',
    '   * 测试方法',
    '   *//*',
    '  @RequestMapping(value = "ghost")',
    '  @ResponseBody',
    '  public String ghost() { return null; }',
    '  }*/',
    '}',
  ].join('\n'));
  assert.equal(routes.length, 1, '块注释内的注解必须被剥离，否则计划里会多出幽灵 route');
  assert.equal(routes[0].java_method, 'real');
  assert.ok(!routes.some((r) => String(r.key).includes('ghost')), '不得出现幽灵路由');
  assert.equal(incomplete, false);
});

test('stripComments：行结构不变（route.line 不错位）+ 字符串字面量里的 /* 不算注释起点', () => {
  const src = ['a', '/* x', 'y */', 'b'].join('\n');
  const stripped = stripComments(src);
  assert.equal(stripped.split('\n').length, 4, '行数必须保持，否则 route.line 整体错位');
  assert.equal(stripped.split('\n')[3], 'b');
  const s2 = 'String s = "a/*b"; @GetMapping("/x")';
  assert.ok(stripComments(s2).includes('@GetMapping'), '字符串里的 /* 不得开启块注释');
});

test('CLI：scan_incomplete → 退出码 43（SCAN_INCOMPLETE），stdout 仍出清单', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-pplan-incomplete-'));
  const java = path.join(root, 'src', 'main', 'java', 'com', 'fx');
  fs.mkdirSync(java, { recursive: true });
  fs.writeFileSync(path.join(java, 'MultiPrefixController.java'), [
    'package com.fx;',
    '@RestController',
    '@RequestMapping({"/a", "/b"})',
    'public class MultiPrefixController {',
    '  @GetMapping("/list")',
    '  public R list() { return null; }',
    '}',
  ].join('\n'));
  const r = spawnSync(process.execPath,
    [SCRIPT, '--root', root, '--entry', 'src/main/java/**/*Controller.java', '--module', 'fx'],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, EXIT.SCAN_INCOMPLETE, r.stderr || r.stdout);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.scan_incomplete, true);
  assert.deepEqual(plan.incomplete_files, ['src/main/java/com/fx/MultiPrefixController.java']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('buildParallelPlan：同输入必同字节输出 + 无重叠/并集不变式 + 每片 ≤3', () => {
  const root = mkTree();
  const a = runPlan({ effectiveRoot: root, entryPattern: 'src/main/java/**/*Controller.java', module: 'fx' });
  const b = runPlan({ effectiveRoot: root, entryPattern: 'src/main/java/**/*Controller.java', module: 'fx' });
  assert.equal(JSON.stringify(a), JSON.stringify(b), '同输入两跑必须字节一致');
  assert.deepEqual(a, b);
  const all = new Set(a.routes.map((r) => r.id));
  const seen = new Set();
  for (const s of a.slices) for (const id of s.route_ids) {
    assert.ok(!seen.has(id), 'route ' + id + ' 重复出现');
    seen.add(id);
  }
  assert.equal(seen.size, all.size, '切片并集必须 = 全集（无缺口）');
  assert.ok(a.slices.every((s) => s.route_ids.length <= 3), '并行契约每片 ≤3 route');
  assert.ok(a.slices.every((s) => typeof s.est_bytes === 'number' && s.est_bytes === s.route_ids.length * 2048),
    '每片必须带机械预估 est_bytes（route 数 × 固定成本模型）');
  assert.equal(a.total_routes, 66, '3+2+60+1 条路由');
  assert.equal(a.controllers_count, 4);
  assert.equal(a.scan_incomplete, false, '裸类级 @RequestMapping 已是空前缀挂根，WeirdController 不再标不完整');
  fs.rmSync(root, { recursive: true, force: true });
});

test('巨型 Controller 跨片窗口：方法连续且不重叠（并集覆盖计划）', () => {
  const root = mkTree();
  const a = runPlan({
    effectiveRoot: root, entryPattern: 'src/main/java/**/*Controller.java', module: 'fx',
    controller: 'com.fx.GiantController',
  });
  assert.equal(a.total_routes, 60);
  assert.equal(a.total_slices, 20);
  const wins = a.slices.map((s) => s.window).filter(Boolean);
  assert.equal(wins.length, 20, '单片 controller 的切片都必须有窗口');
  for (let i = 1; i < wins.length; i++) {
    const pe = Number(wins[i - 1].end_method.replace('m', ''));
    const cs = Number(wins[i].start_method.replace('m', ''));
    assert.equal(cs, pe + 1, '窗口必须方法连续（无重叠、无缺口）');
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('CLI 纯目录模式：退出码 0 + JSON 可解析；空树 NOT_READY(42)', () => {
  const root = mkTree();
  const r = spawnSync(process.execPath,
    [SCRIPT, '--root', root, '--entry', 'src/main/java/**/*Controller.java', '--module', 'fx'],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.total_routes, 66);
  assert.ok(Array.isArray(plan.slices) && plan.slices.length > 0);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-pplan-empty-'));
  const r2 = spawnSync(process.execPath, [SCRIPT, '--root', empty, '--module', 'x'],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(r2.status, EXIT.NOT_READY);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});
