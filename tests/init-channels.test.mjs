// tests/init-channels.test.mjs
// 注册期通道探测（probeDrivers 的 MCP 探测项）+ 通道结论回写（decideChannels）。
//
// 为什么锁这些：
//   1) MCP server 起不来时工具从列表静默消失，没有错误码也没有 stderr。所以"能不能走
//      MCP"必须在注册期由本地脚本退出码答一次，并写回 `kind`；会话内只读已定的 kind。
//      回写一旦被改成"运行时判断"，这套设计的唯一保证就没了。
//   2) MCP 探测只查管路（私有根/注册文件/白名单/adapter 可装载），不碰后端。它必须
//      被挡在连通性门禁之外（gate:false）：否则"脚本全挂 + 管路完好"会骗过 exit 20，
//      把没连上的项目登记成已就绪。
//   3) `fallback: none` 是运维的显式决定，探测无权悄悄翻成 script。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import os     from 'node:os';
import path   from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { probeDrivers, gateOf, decideChannels } from '../scripts/init-project.mjs';

const ROOT    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'priv-mcp');
const SHELL   = path.join(ROOT, 'mcp-skeleton', 'shell.py');
const PY      = process.platform === 'win32' ? 'python' : 'python3';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const fwd = (p) => p.split(path.sep).join('/');

let hasPy = false;
let hasYaml = false;
let tmp;
before(() => {
  hasPy = spawnSync(PY, ['--version'], { encoding: 'utf8' }).status === 0;
  hasYaml = hasPy && spawnSync(PY, ['-c', 'import yaml'], { encoding: 'utf8' }).status === 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-chan-'));
  // 两个桩 driver：一个健康、一个"连不上"，用来造 present/reachable 三个分支
  fs.writeFileSync(path.join(tmp, 'ok.py'), 'import sys\nprint("driver-up")\nsys.exit(0)\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'down.py'),
    'import sys\nsys.stderr.write("driver-down\\n")\nsys.exit(3)\n', 'utf8');
});

/** Minimal L2 text: probeDrivers only reads drivers.<slot>.{impl,kind,fallback}. */
function cfg(slots) {
  return [
    'schemaVersion: 1',
    'identity:',
    '  code: fx-mcp',
    'drivers:',
    ...Object.entries(slots).flatMap(([slot, sc]) => [
      `  ${slot}:`,
      ...sc.map((l) => '    ' + l),
    ]),
    '',
  ].join('\n');
}
const scriptSlot = (file) => [`impl: "${fwd(path.join(tmp, file))}"`, 'healthCheck: noop'];

test('probeDrivers：present / reachable 三分支各自独立可辨', (t) => {
  if (!hasPy) return t.skip(`${PY} 不可用：脚本探测无法执行`);
  const probes = probeDrivers(cfg({
    database: scriptSlot('ok.py'),
    logs:     scriptSlot('down.py'),
    tickets:  ['impl: "/nope/never-written.py"', 'healthCheck: noop'],
  }), 'fx-mcp', FIXTURE);
  const by = Object.fromEntries(probes.map((p) => [p.slot + ':' + p.channel, p]));

  assert.equal(by['database:script'].present, true);
  assert.equal(by['database:script'].reachable, true);
  assert.match(by['database:script'].detail, /driver-up/, 'detail 要带上脚本自己的话');

  assert.equal(by['logs:script'].present, true);
  assert.equal(by['logs:script'].reachable, false);
  assert.equal(by['logs:script'].exit, 3, '退出码原样带出，不折叠成布尔');
  assert.match(by['logs:script'].detail, /driver-down/);

  assert.equal(by['tickets:script'].present, false, '文件不存在 ≠ 连不上：两者在报告里必须区分');
  assert.equal(by['tickets:script'].reachable, false);
});

test('probeDrivers：kind=mcp 槽位多出一条管路探测项', (t) => {
  if (!hasPy) return t.skip(`${PY} 不可用`);
  const probes = probeDrivers(cfg({
    logs:    ['kind: mcp', 'fallback: script', ...scriptSlot('ok.py')],
    tickets: ['kind: mcp', ...scriptSlot('ok.py')],
  }), 'fx-mcp', FIXTURE);
  const mcp = probes.filter((p) => p.channel === 'mcp');
  assert.equal(mcp.length, 2, '两个 kind=mcp 槽位 = 两条探测结论，一条都不能省');
  for (const p of mcp) {
    assert.equal(p.gate, false, 'MCP 管路探测不参与连通性门禁');
    assert.equal(p.impl, 'mcp-skeleton/shell.py');
  }
  const logs = mcp.find((p) => p.slot === 'logs');
  if (!hasYaml) {
    // 缺 PyYAML 时壳必须显式失败（而不是"看起来没配 mcp"）
    assert.equal(logs.reachable, false);
    assert.match(logs.detail, /PyYAML|requirements\.txt/);
    return t.skip('缺 PyYAML：只验证壳的显式失败');
  }
  assert.equal(logs.reachable, true, 'fixture 里 logs 槽 kind=mcp + adapter 齐备');
  assert.equal(logs.exit, 0);
  // fixture 的 tickets 槽 mcp.server 指向别的 server：管路不完整 = 不可达，且要说清原因
  const tickets = mcp.find((p) => p.slot === 'tickets');
  assert.equal(tickets.reachable, false);
  assert.match(tickets.detail, /不走本壳/);
});

test('脚本槽位不产生 MCP 探测项（探测面不随配置无关扩张）', (t) => {
  if (!hasPy) return t.skip(`${PY} 不可用`);
  const probes = probeDrivers(cfg({ database: scriptSlot('ok.py') }), 'fx-mcp', FIXTURE);
  assert.deepEqual(probes.map((p) => p.channel), ['script']);
});

// ---------- 门禁：MCP 探测永远不能顶替脚本退出码 ----------
test('gateOf：脚本全挂 + MCP 管路完好 → 门禁仍然失败（exit 20 的判据）', () => {
  const probes = [
    { slot: 'database', channel: 'script', present: true, reachable: false },
    { slot: 'database', channel: 'mcp', present: true, reachable: true, gate: false },
  ];
  const g = gateOf(probes);
  assert.equal(g.passed, false);
  assert.equal(g.configured.length, 1, '只有脚本项计入 configured');
  assert.equal(g.reachable.length, 0);
});

test('gateOf：一个都没配 → 放行；配了一个且可达 → 放行', () => {
  assert.equal(gateOf([]).passed, true);
  assert.equal(gateOf([{ channel: 'script', present: false, reachable: false }]).passed, true,
    'driver 尚未落地时不得把注册卡死（§11：真实 driver 由用户自开发）');
  assert.equal(gateOf([{ channel: 'script', present: true, reachable: true }]).passed, true);
});

// ---------- 回写：结论进 kind，且只动 kind ----------
const MCP_TEXT = [
  'schemaVersion: 1',
  'identity:',
  '  code: demo',
  'drivers:',
  '  logs:',
  '    # 取数走 MCP 时取消注释：',
  '    # kind: mcp',
  '    kind: mcp',
  '    fallback: script',
  '    mcp:',
  '      server: supperh-drivers',
  '      sources: [app_logs]',
  '    impl: "{{DRIVERS_ROOT}}/log-example.py"',
  '    healthCheck: "{{DRIVERS_ROOT}}/log-example.py --health"',
  '  tickets:',
  '    kind: mcp',
  '    fallback: none',
  '    impl: "{{DRIVERS_ROOT}}/ticket-example.py"',
  '    healthCheck: noop',
  '  efficiency:',
  '    kind: mcp',
  '    impl: "{{DRIVERS_ROOT}}/efficiency-example.py"',
  '    healthCheck: noop',
  'naming:',
  '  commandPrefix: /supperH',
  '',
].join('\n');

const probe = (slot, over = {}) => ({
  slot, channel: 'mcp', kind: 'mcp', gate: false, present: true,
  reachable: false, exit: 1, detail: 'PyYAML 未安装', ...over,
});

test('不可达的 kind=mcp 槽位回写成 kind: script，其余字节不动', () => {
  const { text, decisions } = decideChannels(MCP_TEXT, [probe('logs', { fallback: 'script' })]);
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0].action, 'downgraded');
  assert.equal(decisions[0].written, true);
  const logs = text.split(/\r?\n/).slice(5, 13);
  assert.ok(logs.some((l) => l === '    kind: script'), '实际片段：' + JSON.stringify(logs));
  assert.ok(logs.some((l) => l === '    # kind: mcp'), '注释里的示例不能被改写');
  assert.ok(logs.some((l) => l === '      sources: [app_logs]'), 'mcp 段留档，改的只是通道选择');
  assert.ok(text.includes('  tickets:\n    kind: mcp\n    fallback: none'), '未探测的槽位不能被动到');
});

test('可达的 mcp 槽位保持 mcp；fallback: none 只报告不翻写', () => {
  const { text, decisions } = decideChannels(MCP_TEXT, [
    probe('logs', { fallback: 'script', reachable: true }),
    probe('tickets', { fallback: 'none' }),
  ]);
  assert.equal(text, MCP_TEXT, '两种情况都必须一字不改');
  assert.deepEqual(decisions.map((d) => d.action), ['kept', 'blocked']);
  assert.match(decisions[1].note, /不得被探测悄悄改写/);
});

test('原文没有 kind 行时插到 impl 之前（同一缩进，不另起段落）', () => {
  const src = MCP_TEXT.replace('  efficiency:\n    kind: mcp\n', '  efficiency:\n');
  const { text, decisions } = decideChannels(src, [probe('efficiency', { fallback: 'script' })]);
  assert.equal(decisions[0].written, true);
  assert.match(text, /  efficiency:\r?\n    kind: script\r?\n    impl:/);
});

test('回写只改 kind 的值：不插行、不顺手展开 token', () => {
  const { text } = decideChannels(MCP_TEXT, [probe('logs', { fallback: 'script' })]);
  const kinds = (s) => s.split(/\r?\n/).filter((l) => /^\s+kind:/.test(l)).length;
  assert.equal(kinds(text), kinds(MCP_TEXT), 'kind 行数不能变：一个槽位两行 kind = 最后一行赢，没人看得见');
  // 模板里的 {{DRIVERS_ROOT}} 是 L2 原生的（runtime 由 resolver 展开），回写只碰 kind
  assert.match(text, /impl: "\{\{DRIVERS_ROOT\}\}\/log-example\.py"/);
});

test('幂等：同一份结论跑两次，第二次不再改动', () => {
  const once = decideChannels(MCP_TEXT, [probe('logs', { fallback: 'script' })]);
  const twice = decideChannels(once.text, [probe('logs', { fallback: 'script' })]);
  assert.equal(twice.text, once.text);
  assert.equal(twice.decisions[0].written, false, '重复注册不该每次都重写文件');
});

test('壳文件缺失（未跑 sync）时探测项如实报 present=false', (t) => {
  if (!hasPy) return t.skip(`${PY} 不可用`);
  const existed = fs.existsSync(SHELL);
  assert.equal(existed, true, '本仓库应携带壳');
  const probes = probeDrivers(cfg({ logs: ['kind: mcp', ...scriptSlot('ok.py')] }), 'fx-mcp', FIXTURE);
  const mcp = probes.find((p) => p.channel === 'mcp');
  assert.equal(mcp.present, true);
  assert.equal(typeof mcp.fallback, 'string', 'fallback 要随探测项带出，回写才判得了能不能降');
});
