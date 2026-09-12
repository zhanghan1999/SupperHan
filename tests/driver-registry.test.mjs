// tests/driver-registry.test.mjs
// 锁住"数据源登记"这条路（/supperH-driver 的确定性后端）的四件事：
//  ① 槽位名归用户（F-11）：第五种、第六种源能登记；登记是文本手术，不得吃掉维护者写的注释，
//     也不得顺手改坏同文件里的其他条目（一次 add 只动一个槽位）。
//  ② desc 是**写入门禁**而不是 schema 必填：schema 层对缺 desc 只告警（新增字段不得让已注册
//     项目一夜全灭），所以"新条目必须带人话描述"只能由登记这一刻硬拦；退 2 且不落盘。
//  ③ 探活取本地退出码（R3.5）：驱动文件不存在 / healthCheck 非 0 → 退 20 且不写盘；
//     只有 --force 才带病登记，并把不可达记成警告（不是静默成功）。
//  ④ 删条目要 --yes：删掉的是用户给过的声明（writes/desc），必须由用户确认过一次；
//     删掉最后一个槽位时整段 drivers: 一并消失 = 纯代码模式（不是留一个 `drivers:` 空段）。
//  ⑤ 存量非法项不阻断本次修复：只拦"这次改动新引入"的错误，否则给缺 desc 的条目补 desc
//     会被同文件里别的存量问题一起拦死——门禁阻止修复是缺陷。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { normalizeValues, insertSlot, setSlotFields, deleteSlot } from '../scripts/driver-registry.mjs';
import { loadSchema, validateAgainstSchema } from '../scripts/validate-project.mjs';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT    = path.join(TOOL_ROOT, 'scripts', 'driver-registry.mjs');
const isWin     = process.platform === 'win32';
const PY        = isWin ? 'python' : 'python3';

// 夹具项目：只带一个 logs 槽位 + 两处注释（注释必须活着度过 add/update/remove）。
const PROJECT_TEXT = [
  'schemaVersion: 1',
  'identity:',
  "  code: 'fx'",
  "  displayName: '夹具项目'",
  "codeRoot: 'C:/fx'",
  "packageRoot: 'com.fx.demo'",
  'modules:',
  "  - name: 'demo'",
  "    entryPattern: '**/demo/controller/*.java'",
  'build:',
  "  tool: 'maven'",
  "  jdk: '17'",
  "  compileCmd: 'mvn -q compile'",
  "  testCmd: 'mvn -q test'",
  'naming:',
  "  commandPrefix: '/fx'",
  'drivers:',
  '  # 这段注释解释为什么 logs 走索引：add 之后它必须还在原地',
  '  logs:',
  "    desc: '错误日志平台，按 traceId 查现场'",
  `    impl: '{{DRIVERS_ROOT}}/ok_driver.py'`,
  `    healthCheck: '${PY} {{DRIVERS_ROOT}}/ok_driver.py --health'`,
  '',
].join(isWin ? '\r\n' : '\n');

function makePriv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-drv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'drivers'),  { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', 'fx.yaml'), PROJECT_TEXT, 'utf8');
  const drv = (name, code) => fs.writeFileSync(path.join(dir, 'drivers', name),
    `import sys\nsys.stderr.write("${name} probe\\n")\nsys.exit(${code})\n`, 'utf8');
  drv('ok_driver.py', 0);
  drv('bad_driver.py', 3);
  return dir;
}

function cli(priv, args, input) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', env: { ...process.env, SUPPERH_PRIVATE_ROOT: priv }, input: input ?? '', timeout: 60000,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 用法错误路径只写 stderr */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const readDoc  = (priv) => YAML.parse(fs.readFileSync(path.join(priv, 'projects', 'fx.yaml'), 'utf8'));
const readText = (priv) => fs.readFileSync(path.join(priv, 'projects', 'fx.yaml'), 'utf8');
const slotValues = (extra) => JSON.stringify({
  desc: '内部支持台，读问题记录与回复',
  impl: '{{DRIVERS_ROOT}}/ok_driver.py',
  healthCheck: `${PY} {{DRIVERS_ROOT}}/ok_driver.py --health`,
  ...extra,
});

// ---- ① 槽位名归用户 + 文本手术无损 ----------------------------------------
test('add：自定义槽位名能登记，且不碰别的条目与注释', (t) => {
  const priv = makePriv(t);
  const r = cli(priv, ['add', '--project', 'fx', '--slot', 'wo_de', '--values', '-'], slotValues());
  assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
  const doc = readDoc(priv);
  assert.equal(doc.drivers.wo_de.desc, '内部支持台，读问题记录与回复');
  assert.equal(doc.drivers.wo_de.impl, '{{DRIVERS_ROOT}}/ok_driver.py');
  assert.equal(doc.drivers.logs.impl, '{{DRIVERS_ROOT}}/ok_driver.py', '已有条目不得被顺手改写');
  const text = readText(priv);
  assert.match(text, /# 这段注释解释为什么 logs 走索引/, '注释是"这个字段为何不能留空"的载体，round-trip 会丢');
  assert.deepEqual(validateAgainstSchema(doc, loadSchema()), [], '登记结果必须自带 schema 合法性');
});

test('add：项目没有 drivers: 段时整段新建（纯代码模式接第一个源）', (t) => {
  const priv = makePriv(t);
  const lines = PROJECT_TEXT.split(/\r?\n/);
  const at = lines.findIndex((l) => l === 'drivers:');
  fs.writeFileSync(path.join(priv, 'projects', 'fx.yaml'), lines.slice(0, at).join('\r\n'), 'utf8');
  assert.equal(readDoc(priv).drivers, undefined, '前置条件：夹具已退化成纯代码模式');
  const r = cli(priv, ['add', '--project', 'fx', '--slot', 'im', '--values', '-'], slotValues({ desc: '内部 IM，发通知消息' }));
  assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
  assert.equal(readDoc(priv).drivers.im.desc, '内部 IM，发通知消息');
  assert.equal(r.json.createdDriversSection, true, '新建了整段这件事必须说出来');
});

// ---- ② desc 是写入门禁 ---------------------------------------------------
test('add：缺 desc 退 2 且不落盘（schema 只告警，所以必须由登记拦）', (t) => {
  const priv = makePriv(t);
  const before = readText(priv);
  const r = cli(priv, ['add', '--project', 'fx', '--slot', 'im', '--values', '-'],
    JSON.stringify({ impl: '{{DRIVERS_ROOT}}/ok_driver.py', healthCheck: `${PY} x.py` }));
  assert.equal(r.status, 2, r.stdout);
  assert.match(JSON.stringify(r.json.problems), /desc 不能为空/);
  assert.equal(readText(priv), before, '被拦下的登记必须在盘上不留痕迹');
});

test('add：desc 只是复读槽位名/impl 也被拦（那没有回答"这个源是什么"）', (t) => {
  const priv = makePriv(t);
  const r = cli(priv, ['add', '--project', 'fx', '--slot', 'im', '--values', '-'],
    slotValues({ desc: 'im' }));
  assert.equal(r.status, 2, r.stdout);
  assert.match(JSON.stringify(r.json.problems), /只是名字或 impl 的复读/);
});

test('add：槽位名不合法退 2（名字归用户但仍得能当 YAML 键）', (t) => {
  const priv = makePriv(t);
  for (const bad of ['1bad', 'a', '有中文', 'x'.repeat(41)]) {
    const r = cli(priv, ['add', '--project', 'fx', '--slot', bad, '--values', '-'], slotValues());
    assert.equal(r.status, 2, `${bad} 应被拦：${r.stdout}`);
    assert.match(JSON.stringify(r.json.problems), /不合法/);
  }
  assert.equal(readDoc(priv).drivers.im, undefined);
});

test('update：给存量条目补 desc 能成功（写入门禁只管新条目）', (t) => {
  const priv = makePriv(t);
  const doc = readDoc(priv);
  delete doc.drivers.logs.desc;
  fs.writeFileSync(path.join(priv, 'projects', 'fx.yaml'), YAML.stringify(doc), 'utf8');
  const r = cli(priv, ['update', '--project', 'fx', '--slot', 'logs', '--values', '-'],
    JSON.stringify({ desc: '错误日志平台，按 traceId 查现场' }));
  assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
  assert.equal(readDoc(priv).drivers.logs.desc, '错误日志平台，按 traceId 查现场');
});

// ---- ③ 探活：门禁只认本地退出码 -------------------------------------------
test('add：驱动文件不存在 → 退 20 且不落盘', (t) => {
  const priv = makePriv(t);
  const r = cli(priv, ['add', '--project', 'fx', '--slot', 'im', '--values', '-'],
    slotValues({ impl: '{{DRIVERS_ROOT}}/nope.py' }));
  assert.equal(r.status, 20, r.stdout);
  assert.match(JSON.stringify(r.json.problems), /文件不存在/);
  assert.equal(readDoc(priv).drivers.im, undefined, '探活失败不得留下"登记了但取不到数"的条目');
});

test('add：healthCheck 非 0 → 退 20；--force 才带病登记并记警告', (t) => {
  const priv = makePriv(t);
  const vals = slotValues({ impl: '{{DRIVERS_ROOT}}/bad_driver.py', healthCheck: `${PY} {{DRIVERS_ROOT}}/bad_driver.py --health` });
  const r = cli(priv, ['add', '--project', 'fx', '--slot', 'im', '--values', '-'], vals);
  assert.equal(r.status, 20, r.stdout);
  assert.match(JSON.stringify(r.json.problems), /探活未通过/);
  const f = cli(priv, ['add', '--project', 'fx', '--slot', 'im', '--values', '-', '--force'], vals);
  assert.equal(f.status, 0, f.stderr + '\n' + f.stdout);
  assert.ok(f.json.gateNote, '--force 必须把降级说出来，不能静默成功');
  assert.match(JSON.stringify(f.json.warnings), /退化为不可用/);
  assert.equal(readDoc(priv).drivers.im.impl, '{{DRIVERS_ROOT}}/bad_driver.py');
});

test('update：只改 desc 不陪跑探活（每个 healthCheck 最长 30s）', (t) => {
  const priv = makePriv(t);
  const r = cli(priv, ['update', '--project', 'fx', '--slot', 'logs', '--values', '-'],
    JSON.stringify({ desc: '错误日志平台（改了描述）' }));
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.json.probes, [], '不影响可达性的改动不该产生探测');
});

test('add：写能力声明按封闭词表落盘，other 缺 userPhrase 被拦', (t) => {
  const priv = makePriv(t);
  const ok = cli(priv, ['add', '--project', 'fx', '--slot', 'im', '--values', '-'],
    slotValues({ desc: '内部 IM，发通知消息', writes: [{ action: 'message_send', gate: 'confirm', note: '给值班群发一条缺陷提醒' }] }));
  assert.equal(ok.status, 0, ok.stderr + '\n' + ok.stdout);
  assert.deepEqual(readDoc(priv).drivers.im.writes,
    [{ action: 'message_send', gate: 'confirm', note: '给值班群发一条缺陷提醒' }]);
  assert.ok(readText(priv).includes('      - action: '), 'writes 必须是块状列表，不能塌成一行');

  const bad = cli(priv, ['add', '--project', 'fx', '--slot', 'sms', '--values', '-'],
    slotValues({ desc: '短信网关，发验证码', writes: [{ action: 'other', gate: 'confirm' }] }));
  assert.equal(bad.status, 2, bad.stdout);
  assert.match(JSON.stringify(bad.json.problems), /action=other 必须带 userPhrase/);
  assert.equal(readDoc(priv).drivers.sms, undefined);
});

test('add：数据库通道要 role 与 db 段彼此成立（缺 db 段 = 写保护默认失效）', (t) => {
  const priv = makePriv(t);
  const r = cli(priv, ['add', '--project', 'fx', '--slot', 'main_db', '--values', '-'],
    slotValues({ desc: '业务主库，读订单表', role: 'database' }));
  assert.equal(r.status, 2, r.stdout);
  assert.match(JSON.stringify(r.json.problems), /没有 db 段/);
  assert.equal(readDoc(priv).drivers.main_db, undefined);
});

// ---- ④ remove：删声明必须过用户 ------------------------------------------
test('remove：不带 --yes 退 2；带 --yes 才删，且删空时整段 drivers: 一起消失', (t) => {
  const priv = makePriv(t);
  const no = cli(priv, ['remove', '--project', 'fx', '--slot', 'logs']);
  assert.equal(no.status, 2, no.stdout);
  assert.match(no.json.error, /需要 --yes/);
  assert.ok(readDoc(priv).drivers.logs, '未确认的删除不能碰盘');

  const yes = cli(priv, ['remove', '--project', 'fx', '--slot', 'logs', '--yes']);
  assert.equal(yes.status, 0, yes.stderr + '\n' + yes.stdout);
  const doc = readDoc(priv);
  assert.equal(doc.drivers, undefined, '最后一个槽位删完就退回纯代码模式：留一个空 drivers: 会被解成 null，schema 过不去');
  assert.deepEqual(validateAgainstSchema(doc, loadSchema()), [], '删完仍须是合法文档');
  assert.ok(fs.existsSync(path.join(priv, 'projects', 'fx.yaml.bak')), '写盘前必须留 .bak');
});

test('remove/update 不存在的槽位 → 退 3 并列出当前已登记的名字', (t) => {
  const priv = makePriv(t);
  const r = cli(priv, ['remove', '--project', 'fx', '--slot', 'nope', '--yes']);
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.json.hint, /logs/);
});

// ---- ⑤ 存量非法项不阻断修复 ----------------------------------------------
test('存量条目自带非法项时，只拦"这次改动新引入"的错误', (t) => {
  const priv = makePriv(t);
  const doc = readDoc(priv);
  doc.drivers.logs.impl = 'example_driver.py';          // 存量：模板假值残留，validate 会退 2
  fs.writeFileSync(path.join(priv, 'projects', 'fx.yaml'), YAML.stringify(doc), 'utf8');
  const r = cli(priv, ['update', '--project', 'fx', '--slot', 'logs', '--values', '-'],
    JSON.stringify({ desc: '错误日志平台（补描述）' }));
  assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
  assert.ok(r.json.preexistingErrors?.length, '存量问题必须报出来（否则用户不知道为什么 validate 还红）');
  assert.match(JSON.stringify(r.json.preexistingErrors), /example_driver/);
});

test('--dry-run 只回文本不写盘', (t) => {
  const priv = makePriv(t);
  const before = readText(priv);
  const r = cli(priv, ['add', '--project', 'fx', '--slot', 'im', '--values', '-', '--dry-run'],
    slotValues({ desc: '内部 IM，发通知消息' }));
  assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
  assert.equal(readText(priv), before);
  assert.match(r.json.text, /  im:/);
});

// ---- list / health：只读，不改形状 ----------------------------------------
test('list：writes 整段缺席报成 null（只读），不是空数组', (t) => {
  const priv = makePriv(t);
  const r = cli(priv, ['list', '--project', 'fx']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.count, 1);
  assert.equal(r.json.dbSlot, null);
  assert.deepEqual(r.json.drivers[0].writes, null, '空清单会被读成"没有声明"，而"只读"必须是显式事实');
  assert.equal(r.json.drivers[0].slot, 'logs');
});

test('health：逐槽位探活，退 0 且不写盘', (t) => {
  const priv = makePriv(t);
  const before = readText(priv);
  const r = cli(priv, ['health', '--project', 'fx']);
  assert.equal(r.status, 0, r.stderr + '\n' + r.stdout);
  assert.equal(r.json.configured, 1);
  assert.equal(r.json.reachable, 1);
  assert.equal(readText(priv), before);
});

test('项目没登记就退 3，并把 /supperH-init 指回去', (t) => {
  const priv = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-drv-empty-'));
  fs.mkdirSync(path.join(priv, 'projects'), { recursive: true });
  t.after(() => fs.rmSync(priv, { recursive: true, force: true }));
  const r = cli(priv, ['list', '--project', 'ghost']);
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.json.hint, /supperH-init/);
});

// ---- 纯函数：文本手术的三条边界 -------------------------------------------
test('normalizeValues：三种写法归一成同一份字段对象', (t) => {
  const nested = { desc: 'd', mcp: { server: 's', sources: ['a', 'b'] } };
  const wrapped = { drivers: { im: nested } };
  const flat = { 'drivers.im.desc': 'd', 'drivers.im.mcp.server': 's', 'drivers.im.mcp.sources': 'a,b' };
  for (const [i, raw] of [nested, wrapped, flat].entries()) {
    const { fields, unknown } = normalizeValues(raw, 'im');
    assert.deepEqual(unknown, [], '第 ' + i + ' 种写法不该有未知字段');
    assert.equal(fields.desc, 'd');
    assert.equal(fields.mcp.server, 's');
    assert.deepEqual(String(fields.mcp.sources).split(/[,，]/).map((s) => s.trim()), ['a', 'b']);
  }
  assert.deepEqual(normalizeValues({ nope: 1 }, 'im').unknown, ['nope']);
});

test('setSlotFields：按固定顺序插入缺失字段，null 删字段，注释一律不动', (t) => {
  const src = ['schemaVersion: 1', 'drivers:', '  logs:', '    # 别吃掉我', '    desc: d', '    impl: i', '', 'naming:', '  x: 1'].join('\r\n');
  const r = setSlotFields(src, 'logs', { role: 'database', desc: 'new', impl: null });
  const lines = r.text.split(/\r?\n/);
  const iDesc    = lines.indexOf("    desc: 'new'");
  const iRole    = lines.indexOf('    role: database');
  const iComment = lines.indexOf('    # 别吃掉我');
  assert.ok(iDesc >= 0 && iRole >= 0 && iComment >= 0, JSON.stringify(lines));
  assert.ok(iComment < iDesc, '注释位置不得因插队而漂移');
  assert.ok(iDesc < iRole, 'role 排在 desc 之后（与 init 的渲染顺序一致）');
  assert.ok(!lines.some((l) => /^\s+impl:/.test(l)), 'null = 删除该字段');
  assert.match(r.text, /naming:/);
});

test('deleteSlot：只删目标块，兄弟槽位与后续段落完好', (t) => {
  const src = ['schemaVersion: 1', 'drivers:', '  logs:', '    desc: a', '    impl: i',
    '  im:', '    desc: b', '    impl: j', 'naming:', "  commandPrefix: 'x'"].join('\r\n');
  const r = deleteSlot(src, 'logs');
  const doc = YAML.parse(r.text);
  assert.deepEqual(Object.keys(doc.drivers), ['im']);
  assert.ok(doc.naming.commandPrefix);
  assert.equal(deleteSlot(src, 'ghost').changed, false);
});

test('insertSlot：新块落在 drivers 段末尾，不写进别的槽位里', (t) => {
  const src = ['schemaVersion: 1', 'drivers:', '  logs:', '    desc: a', '', 'naming:', '  commandPrefix: x'].join('\r\n');
  const r = insertSlot(src, 'im', ['  im:', "    desc: 'b'"]);
  const doc = YAML.parse(r.text);
  assert.deepEqual(Object.keys(doc.drivers).sort(), ['im', 'logs']);
  assert.equal(doc.drivers.im.desc, 'b');
  assert.equal(insertSlot(src, 'logs', []).changed, false, '重名要退回去，不能塞出两个同名键');
});
