// tests/resolve-project-cli.test.mjs
// CLI 级集成测试：参数解析、退出码、向后兼容形状、jsonl 记账。
// 不依赖测试环境有 git 历史：本仓库当前尚无 commit，readHeadCommit 返回 null，
// 因此带锚点的调用在此环境下必然落 35（HEAD 取不到 → 保守出局），这正是要断言的行为。
import { test, before } from 'node:test';
import assert  from 'node:assert/strict';
import fs      from 'node:fs';
import os      from 'node:os';
import path    from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT     = path.join(__dirname, '..', 'scripts', 'resolve-project.mjs');
const GEN        = 'gen-20260101120000';
const INDEX_TEXT = [
  '---',
  'schema: supperh-index/2',
  'module: order',
  'kind: code',
  'learnedAt: 2026-09-10T08:30:00+08:00',
  'learnedAtCommit: 0000000000000000000000000000000000000000',
  'controllers: 1',
  'coveredControllers: 1',
  '---',
  '',
  '| route | controller | method | batch | lines | level | sources |',
  '|---|---|---|---|---|---|---|',
  '| POST /api/v1/order/create | OrderController | create | batch-01.md | 40-88 | L3 | src/main/java/com/demo/OrderController.java |',
  ''
].join('\n');

let root, privateRoot, workspace;
// 金样：plain 调用的字段顺序。故意改动本行时请连同步文档/消费方一起改。
// `dbDriver` 排在 `drivers` 之后：它是从 drivers 派生的别名（按 role 解），不是注册表里的 YAML 路径。
const GOLD_KEYS = [
  'ok', 'code', 'displayName', 'configFile', 'registryLegacy', 'toolRoot', 'privateRoot',
  'driversRoot', 'contextRoot', 'tasksRoot', 'menuConfigFile', 'menu', 'codeRoot',
  'effectiveRoot', 'packageRoot', 'db', 'drivers', 'dbDriver', 'project'
].join('|');

function runCli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SUPPERH_PRIVATE_ROOT: privateRoot }
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 让断言去报原文 */ }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-cli-'));
  privateRoot = path.join(root, 'private');
  workspace = path.join(root, 'ws');
  fs.mkdirSync(path.join(privateRoot, 'projects'), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(privateRoot, 'projects', 'demo.yaml'),
    `schemaVersion: 1\nidentity:\n  code: demo\n  displayName: Demo\n  workspaces:\n    - "${workspace.replace(/\\/g, '/')}"\ncodeRoot: "${workspace.replace(/\\/g, '/')}"\npackageRoot: com.demo\nmodules:\n  - name: order\n    entryPattern: '**/*.java'\nbuild:\n  tool: maven\n  jdk: '1.8'\n  compileCmd: mvn compile\n  testCmd: mvn test\ndb:\n  host: localhost\n  port: 5432\n  schemas: { prod: p, uat: u, test: t }\n  readonlyUser: ro\nbranches: { prod: prod, uat: uat, dev: dev }\ndrivers:\n  database: { impl: noop.py, healthCheck: noop.py }\nnaming:\n  commandPrefix: /supperH\n`, 'utf8');
  const modDir = path.join(privateRoot, 'context', 'demo', 'order');
  fs.mkdirSync(path.join(modDir, GEN), { recursive: true });
  fs.writeFileSync(path.join(modDir, 'CURRENT'), GEN + '\n', 'utf8');
  fs.writeFileSync(path.join(modDir, GEN, 'index.md'), INDEX_TEXT, 'utf8');
});

test('向后兼容：不带 --module/--anchor 时输出形状与改动前一致（无门禁字段）', () => {
  const r = runCli(['--cwd', workspace]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.code, 'demo');
  assert.ok(!('fastPath' in r.json), '不带锚点不得注入 fastPath 字段');
  assert.ok(!('freshness' in r.json), '不带 --module 不得注入 freshness 字段');
  // 金样：把"字节级不变"从口号变成可证伪命题（锁住缩进、行尾换行、字段顺序）
  assert.equal(r.stdout, JSON.stringify(r.json, null, 2) + '\n', '必须是 2 空格缩进 + 单一尾换行');
  assert.equal(Object.keys(r.json).join('|'), GOLD_KEYS, '字段顺序漂移会同步改变所有下游消费方的读取结果');
});

test('--module 返回 freshness；本环境无 git HEAD → stale=true 而非猜测', () => {
  const r = runCli(['--cwd', workspace, '--module', 'order']);
  assert.equal(r.status, 0, r.stderr);
  // freshness-only 是文档化的合法模式（不请求门禁结论）：不得注入 fastPath
  assert.ok(!('fastPath' in r.json), '不带 --anchor 就是没请求门禁，不得伪造 fastPath 字段');
  assert.equal(r.json.freshness.available, true);
  assert.equal(r.json.freshness.learnedAtCommit, '0000000000000000000000000000000000000000');
  assert.equal(r.json.freshness.gen, GEN);
  // 无 HEAD 可用时必须保守判过期，而不是"当没变化"放过
  assert.equal(r.json.freshness.stale, true);
});

test('带锚点：HEAD 取不到 → 退出 35 落慢路径，且 binding 仍完整返回', () => {
  const r = runCli(['--cwd', workspace, '--module', 'order',
    '--anchor', 'POST /api/v1/order/create', '--text', '创建人字段为空']);
  assert.equal(r.status, 35);
  assert.equal(r.json.ok, true, '分流不是失败：binding 字段仍应给出');
  assert.equal(r.json.fastPath.eligible, false);
  assert.equal(r.json.fastPath.gates.G4_fresh, 'fail');
  assert.equal(r.json.fastPath.gates.G2_dataReady, 'pass');
  assert.match(r.stderr, /fast-path gate/);
});

test('锚点不可解析（trace_id）→ 30 分流，不报错停止', () => {
  const r = runCli(['--cwd', workspace, '--module', 'order', '--anchor', 'trace_id=abc123']);
  assert.equal(r.status, 30);
  assert.equal(r.json.fastPath.gates.G0_anchorKind, 'fail');
});

test('门禁不改变项目硬停优先级：cwd 未注册时仍退出 10', () => {
  const elsewhere = path.join(root, 'nowhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  const r = runCli(['--cwd', elsewhere, '--module', 'order', '--anchor', 'POST /api/v1/order/create']);
  assert.equal(r.status, 10, 'R3.5：步骤 0 未过时禁止求值快路径');
  assert.ok(!('fastPath' in r.json));
});

test('私有根缺失 → 12 硬停（早于一切门禁）', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--cwd', workspace, '--module', 'order', '--anchor', 'x'], {
    encoding: 'utf8', env: { ...process.env, SUPPERH_PRIVATE_ROOT: path.join(root, 'nope') }
  });
  assert.equal(r.status, 12);
});

test('F1：门禁入参不成对绝不返回 0（0 意味着 eligible+anchorResolved 一定存在）', () => {
  // 调用形态本身就不成立：连门禁都没跑起来
  const shapeBad = [
    ['有 --anchor 无 --module', ['--cwd', workspace, '--anchor', 'POST /api/v1/order/create']],
    ['--anchor 放在末尾且无值', ['--cwd', workspace, '--module', 'order', '--anchor']],
    ['有 --text 无 --anchor', ['--cwd', workspace, '--module', 'order', '--text', '字段为空']],
    ['--module 放在末尾且无值', ['--cwd', workspace, '--anchor', 'POST /api/v1/order/create', '--module']]
  ];
  for (const [desc, args] of shapeBad) {
    const r = runCli(args);
    assert.equal(r.status, 36, `${desc}：应为 36 门禁未完整求值，实际 ${r.status} ${r.stderr}`);
    assert.ok(r.json && 'fastPath' in r.json, `${desc}：stdout 仍必须是完整 JSON`);
    assert.equal(r.json.fastPath.eligible, false, `${desc}：绝不允许 eligible=true`);
    assert.equal(r.json.fastPath.anchorResolved, null, `${desc}：36 不得携带锚点解析结果`);
    assert.ok(r.stdout.length > 0, `${desc}：stdout 永不落空`);
  }
  // 缺 --text：在这个无 commit 的环境里 G4 会先短路成 35；关键不变式是**永远不为 0**
  const noText = runCli(['--cwd', workspace, '--module', 'order', '--anchor', 'POST /api/v1/order/create']);
  assert.notEqual(noText.status, 0, '缺 --text 时绝不得判为准入');
  assert.equal(noText.json.fastPath.eligible, false);
  // 空锚点是"合法值"：交给 classifyAnchor 判 30（分流），而不是被当成没传而逸出 0
  const empty = runCli(['--cwd', workspace, '--module', 'order', '--anchor', '', '--text', '字段为空']);
  assert.equal(empty.status, 30, '--anchor "" 应走 G0 分流为 30');
  assert.equal(empty.json.ok, true, '分流不是失败：binding 字段仍应给出');
});

test('F3：index.md 不可读 → 不得裸抛成 exit 1，且 stdout 必须非空', () => {
  // 用一个目录冒充 index.md：existsSync 为真、readFileSync 报 EISDIR
  const brk = path.join(privateRoot, 'context', 'demo', 'brk');
  fs.mkdirSync(path.join(brk, 'gen-1', 'index.md'), { recursive: true });
  fs.writeFileSync(path.join(brk, 'CURRENT'), 'gen-1\n', 'utf8');
  const r = runCli(['--cwd', workspace, '--module', 'brk', '--anchor', 'POST /api/v1/order/create', '--text', '字段为空']);
  assert.notEqual(r.status, 1, '不得把 node 内部异常码当退出码');
  assert.ok(r.stdout.length > 0, 'stdout 为空会让主 agent 无法分支');
  assert.equal(r.json.fastPath.gates.G2_dataReady, 'fail');
  assert.equal(r.status, 32, '不可读归入"学习数据未就绪"分流');
});

test('每次带锚点调用落一条 jsonl 记账；硬停分支不记账，供后续按真实数据调阈值', () => {
  const logDir = path.join(privateRoot, 'logs');
  assert.ok(fs.existsSync(logDir), '应自动建 logs 目录');
  const files = fs.readdirSync(logDir).filter((f) => /^fastpath-\d{6}\.jsonl$/.test(f));
  assert.equal(files.length, 1, files.join(','));
  const read = () => fs.readFileSync(path.join(logDir, files[0]), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const n0 = read().length;
  // 门禁未完整求值（35/36）也要记账：否则 jsonl 的"未求值"分母被削掉，以后调阈值会偏
  runCli(['--cwd', workspace, '--module', 'order', '--anchor', 'POST /api/v1/order/create']);
  assert.equal(read().length, n0 + 1, '未完整求值也应落盘');
  const last = read()[read().length - 1];
  assert.notEqual(last.status, 0);
  assert.equal(last.eligible, false);
  assert.equal(last.textGiven, false, '否决词没扫过这件事必须可审计');

  // 硬停分支（10/12）不记账：它们不是门禁结果
  const elsewhere = path.join(root, 'nowhere2');
  fs.mkdirSync(elsewhere, { recursive: true });
  runCli(['--cwd', elsewhere, '--module', 'order', '--anchor', 'POST /api/v1/order/create', '--text', 'x']);
  assert.ok(!read().some((l) => [10, 11, 12].includes(l.status)), '硬停不得写入门禁账本');
});

// ---------- P1：--impact-json（G5 回灌）与 fastPath.enabled 的端到端接线 ----------

// evidence 不是点缀：code=ANALYZED 而零证据与“没看过”不可区分，门禁直接 36。
// 夹具不挂一条证据，下面的用例会测成“缺证据也能进快路径”。
const NARROW = { code: 'ANALYZED', target: { route: 'POST /api/v1/order/create' },
  data: { impact: { external_refs: [] } },
  evidence: [{ id: 'E1', kind: 'batch', ref: 'order/batch-01.md', lines: [40, 88], quote: 'create(): 入参非空校验' }],
  reads: [] };

test('P1-② --impact-json 独立模式：窄→0 / 宽→37 / 不可用→36，且不注入 fastPath', () => {
  const ok = runCli(['--cwd', workspace, '--module', 'order', '--impact-json', JSON.stringify(NARROW)]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.json.impact.narrow, true);
  assert.equal(ok.json.impact.applied, true);
  assert.ok(!('fastPath' in ok.json), '独立 impact 模式不得伪造 fastPath 字段');

  const wide = { ...NARROW, data: { impact: { external_refs: ['Other#m'] } } };
  assert.equal(runCli(['--cwd', workspace, '--module', 'order', '--impact-json', JSON.stringify(wide)]).status, 37);

  const bad = runCli(['--cwd', workspace, '--module', 'order', '--impact-json', '{ 不是 json']);
  assert.equal(bad.status, 36, '回报解析不了→36');
  assert.equal(bad.json.impact.applied, true);

  const bare = { ...NARROW };
  delete bare.evidence;
  const noEv = runCli(['--cwd', workspace, '--module', 'order', '--impact-json', JSON.stringify(bare)]);
  assert.equal(noEv.status, 36, 'ANALYZED 零证据 → 36（不得当“影响窄”）');
  assert.ok(noEv.json.impact.problems.join('|').includes('零证据'), '得说清为何出局：' + noEv.json.impact.problems.join('|'));
});

test('P1-② --impact-* 不成对/互斥 → 36；账本有 impact_gate 记录', () => {
  assert.equal(runCli(['--cwd', workspace, '--module', 'order', '--impact-json']).status, 36, '末尾无值');
  assert.equal(runCli(['--cwd', workspace, '--module', 'order', '--impact-json', JSON.stringify(NARROW), '--impact-report', 'x.json']).status, 36, '两个都给');
  const logDir = path.join(privateRoot, 'logs');
  const f = fs.readdirSync(logDir).filter((x) => /^fastpath-\d{6}\.jsonl$/.test(x))[0];
  const lines = fs.readFileSync(path.join(logDir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(lines.some((l) => l.stage === 'impact_gate'), 'G5 回灌须落 impact_gate 账');
});

test('P1-③ fastPath.enabled=false 端到端：binding.project.fastPath 传给门禁 → 30 disabled', () => {
  const ws2 = path.join(root, 'ws-off'); fs.mkdirSync(ws2, { recursive: true });
  const w = ws2.replace(/\\/g, '/');
  fs.writeFileSync(path.join(privateRoot, 'projects', 'off.yaml'),
    `schemaVersion: 1\nidentity:\n  code: off\n  displayName: Off\n  workspaces:\n    - "${w}"\ncodeRoot: "${w}"\npackageRoot: com.off\nmodules:\n  - name: order\n    entryPattern: '**/*.java'\nbuild:\n  tool: maven\n  jdk: '1.8'\n  compileCmd: mvn compile\n  testCmd: mvn test\ndb:\n  host: localhost\n  port: 5432\n  schemas: { prod: p, uat: u, test: t }\n  readonlyUser: ro\nbranches: { prod: prod, uat: uat, dev: dev }\ndrivers:\n  database: { impl: noop.py, healthCheck: noop.py }\nnaming:\n  commandPrefix: /supperH\nfastPath:\n  enabled: false\n`, 'utf8');
  const r = runCli(['--cwd', ws2, '--module', 'order', '--anchor', 'POST /api/v1/order/create', '--text', '字段为空']);
  assert.equal(r.status, 30, 'enabled=false 应短路为 30（无需求 HEAD/index）');
  assert.equal(r.json.fastPath.disabled, true);
  assert.equal(r.json.fastPath.gates.G0_anchorKind, 'skipped');
});

// ---------- 阶段 0：drivers 里的 {{DRIVERS_ROOT}} 必须在解析器内展开完成 ----------
// 回归的是真实缺陷：expandTokens 不认 DRIVERS_ROOT 且 drivers 原样透传，导致产物侧
// `DRIVERS_ROOT/{{PROJECT.drivers.database.impl}}` 拼出双前缀 + 未替换 token 的路径。
// 当时不炸只因私有根 drivers/ 是空目录。

test('阶段0：binding.drivers.* 输出已展开的绝对路径，不含 {{ 也不双前缀', () => {
  const ws3 = path.join(root, 'ws-drv'); fs.mkdirSync(ws3, { recursive: true });
  const w = ws3.replace(/\\/g, '/');
  fs.writeFileSync(path.join(privateRoot, 'projects', 'drv.yaml'),
    `schemaVersion: 1\nidentity:\n  code: drv\n  displayName: Drv\n  workspaces:\n    - "${w}"\ncodeRoot: "${w}"\npackageRoot: com.drv\nmodules:\n  - name: order\n    entryPattern: '**/*.java'\nbuild:\n  tool: maven\n  jdk: '1.8'\n  compileCmd: mvn compile\n  testCmd: mvn test\ndb:\n  host: localhost\n  port: 5432\n  schemas: { prod: p, uat: u, test: t }\n  readonlyUser: ro\nbranches: { prod: prod, uat: uat, dev: dev }\ndrivers:\n  database:\n    impl: "{{DRIVERS_ROOT}}/db-example.py"\n    healthCheck: "{{DRIVERS_ROOT}}/db-example.py --project {{PROJECT.identity.code}} --health"\n  logs:\n    impl: "{{DRIVERS_ROOT}}/log-example.py"\n    healthCheck: "{{DRIVERS_ROOT}}/log-example.py --health"\n    config:\n      indexPattern: "app-logs-*"\nnaming:\n  commandPrefix: /supperH\n`, 'utf8');

  const r = runCli(['--cwd', ws3]);
  assert.equal(r.status, 0, r.stderr);
  const drv = JSON.stringify(r.json.drivers);
  const expect = path.join(privateRoot, 'drivers', 'db-example.py');

  assert.equal(r.json.drivers.database.impl, expect, 'impl 必须是展开完成的绝对路径');
  assert.ok(!/\{\{/.test(drv), `驱动值不得把未替换 token 泄给下游：${drv}`);
  assert.ok(!/drivers[\\/]drivers|drivers[\\/][A-Za-z]:/.test(drv), '绝不得出现双前缀（drivers/drivers 或 drivers/C:）');
  assert.ok(r.json.drivers.database.healthCheck.includes('drv'), 'healthCheck 里的 identity.code 也要展开');
  assert.equal(r.json.drivers.logs.config.indexPattern, 'app-logs-*', 'config 自由格式字段不得被破坏');
  assert.equal(r.json.driversRoot, path.join(privateRoot, 'drivers'), 'driversRoot 与展开值同源');
});

// ---------- dbDriver：按 role 解出的库通道别名（F-11）----------
// 锁住的事：L1 产物不得再写死“库源叫 database”。槽位名归用户且个数不限，那个假设在
// 用户把库源命名为其它名字时不报错、只是拿不到值（token 填不上），是静默失效的一类缺陷。
function roleYaml(code, ws, driversBlock) {
  const w = ws.replace(/\\/g, '/');
  return [
    'schemaVersion: 1',
    'identity:', `  code: ${code}`, `  displayName: ${code} role`, `  workspaces:\n    - "${w}"`,
    `codeRoot: "${w}"`, 'packageRoot: com.role', 'modules:\n  - name: order\n    entryPattern: \'**/*.java\'',
    'build:\n  tool: maven\n  jdk: \'1.8\'\n  compileCmd: mvn compile\n  testCmd: mvn test',
    'db: { host: localhost, port: 5432, schemas: { prod: p, uat: u, test: t }, readonlyUser: ro }',
    'branches: { prod: prod, uat: uat, dev: dev }',
    ...(driversBlock ? ['drivers:', ...driversBlock] : []),
    'naming:\n  commandPrefix: /supperH', ''
  ].join('\n');
}
function roleProject(code, driversBlock) {
  const ws = path.join(root, 'ws-' + code);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(privateRoot, 'projects', `${code}.yaml`), roleYaml(code, ws, driversBlock), 'utf8');
  const r = runCli(['--cwd', ws]);
  return { status: r.status, json: r.json, ws };
}

test('dbDriver：用户自选槽位名 + role: database 照样解得出库通道，impl 已展开', () => {
  const r = roleProject('rolecustom', [
    '  maindb:',
    '    desc: 业务主库',
    '    role: database',
    '    impl: "{{DRIVERS_ROOT}}/maindb.py"',
    '    healthCheck: "{{DRIVERS_ROOT}}/maindb.py --health"',
    '  gitlab:',
    '    desc: 代码仓与流水线',
    '    impl: "{{DRIVERS_ROOT}}/gitlab.py"',
  ]);
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.equal(r.json.dbDriver.slot, 'maindb', '别名必须跟着 role 走，不是跟着名字走');
  assert.equal(r.json.dbDriver.impl, path.join(privateRoot, 'drivers', 'maindb.py'),
    '别名里的 impl 与 drivers.<slot>.impl 同源且同样展开完成');
  assert.equal(r.json.dbDriver.kind, 'script');
  assert.equal(r.json.drivers.maindb.impl, r.json.dbDriver.impl, '两份值不一致 = 下游会拿到两个不同的库通道地址');
  assert.ok(!('database' in r.json.drivers), '不得为用户不存在的槽位名造一个空条目');
});

test('dbDriver：存量写法（槽位正叫 database、没写 role）按同义处理', () => {
  const r = roleProject('rolelegacy', [
    '  database:',
    '    desc: 存量写法',
    '    impl: "{{DRIVERS_ROOT}}/legacy.py"',
  ]);
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.equal(r.json.dbDriver.slot, 'database', 'F-10 前的注册文件不得因为没写 role 就变成“无库通道”');
  assert.equal(r.json.dbDriver.healthCheck, null, '没声明探活命令就是 null，不得伪造一个');
});

test('dbDriver：纯代码模式报成 null（缺键会让“没库”与“token 解不开”分不开）', () => {
  const r = roleProject('rolepure', null);
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.ok('dbDriver' in r.json, '必须带这个键：只有值能表达“没有”');
  assert.equal(r.json.dbDriver, null);
});

test('dbDriver：多个槽位同时声明 role 时取排序后的第一个，与 validate 的报错同源', () => {
  // 这种配置 validate 会退 2（写保护只能绑一个通道），但解析器不拒加载存量文件：
  // 它必须与 dbRoleSlot 拿同一个结论，否则门禁验的库与取数走的库会是两个。
  const r = roleProject('roledup', [
    '  zdb:', '    desc: z', '    role: database', '    impl: "{{DRIVERS_ROOT}}/z.py"',
    '  adb:', '    desc: a', '    role: database', '    impl: "{{DRIVERS_ROOT}}/a.py"',
  ]);
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.equal(r.json.dbDriver.slot, 'adb', '结论必须确定（排序取首），不能依赖 YAML 键的出现顺序');
});

// ---------- I0 意图复述：CLI 级 e2e（真文本 → 真退出码 → jsonl 埋字段）----------
//
// 为何要现造一个 git 仓：上面那套 demo 工作区无 commit → HEAD 取不到 → 门禁在 G4
// 就短路成 35，永远到不了 I0。把仓的 HEAD 写进 index.md 的 learnedAtCommit 让 G4a
// 全等通过，测的才是"真文本一路走到 I0"这条完整链路——包括 --intent-* 两个旗标名
// 本身：它们与 verifyIntent() 错误文案里提的名字必须逐字对得上。

const I0_TEXT = 'POST /api/v1/order/create 创建人字段为空，期望返回创建人姓名';
// 字面 "absent" 是线上协议值，故意硬编码而不引常量：改了常量这里要先响。
const I0_GOOD = {
  expected: '期望：接口返回创建人姓名',
  actual: '实际：创建人字段为空',
  repro: 'absent',
  quotes: { expected: ['期望返回创建人姓名'], actual: ['POST /api/v1/order/create 创建人字段为空'] }
};

function gitSpawn(...args) { return spawnSync('git', args, { encoding: 'utf8' }); }

/** 造一个真 git 仓工作区 + 对应项目注册；返回 HEAD 或 null（无 git 时整组 skip） */
function freshRepoProject(code, wsName, headOut) {
  if (gitSpawn('--version').status !== 0) return null;
  const ws = path.join(root, wsName);
  fs.mkdirSync(ws, { recursive: true });
  if (gitSpawn('init', '-q', ws).status !== 0) return null;
  fs.writeFileSync(path.join(ws, 'README.md'), 'x\n', 'utf8');
  gitSpawn('-C', ws, 'add', '-A');
  gitSpawn('-C', ws, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'c1');
  const r = gitSpawn('-C', ws, 'rev-parse', 'HEAD');
  if (r.status !== 0) return null;
  const head = String(r.stdout).trim();
  headOut.head = head;
  headOut.ws = ws;

  const w = ws.replace(/\\/g, '/');
  fs.writeFileSync(path.join(privateRoot, 'projects', `${code}.yaml`),
    `schemaVersion: 1\nidentity:\n  code: ${code}\n  displayName: I0\n  workspaces:\n    - "${w}"\ncodeRoot: "${w}"\npackageRoot: com.i0\nmodules:\n  - name: order\n    entryPattern: '**/*.java'\nbuild:\n  tool: maven\n  jdk: '1.8'\n  compileCmd: mvn compile\n  testCmd: mvn test\ndb:\n  host: localhost\n  port: 5432\n  schemas: { prod: p, uat: u, test: t }\n  readonlyUser: ro\nbranches: { prod: prod, uat: uat, dev: dev }\ndrivers:\n  database: { impl: noop.py, healthCheck: noop.py }\nnaming:\n  commandPrefix: /supperH\n`, 'utf8');
  const modDir = path.join(privateRoot, 'context', code, 'order');
  fs.mkdirSync(path.join(modDir, GEN), { recursive: true });
  fs.writeFileSync(path.join(modDir, 'CURRENT'), GEN + '\n', 'utf8');
  // 唯一差别：learnedAtCommit = 这个仓的真实 HEAD → G4a 全等通过，门禁能走到 I0
  fs.writeFileSync(path.join(modDir, GEN, 'index.md'),
    INDEX_TEXT.replace(/0{40}/, head), 'utf8');
  return code;
}

test('I0 e2e：CLI 旗标一路走到意图门禁（合规→0 / 欠定义→40 / 没给结构→36）', (t) => {
  const info = {};
  if (!freshRepoProject('i0gate', 'ws-i0', info)) return t.skip('无 git');
  const base = ['--cwd', info.ws, '--module', 'order', '--anchor', 'POST /api/v1/order/create', '--text', I0_TEXT];

  const pass = runCli([...base, '--intent-json', JSON.stringify(I0_GOOD)]);
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(pass.json.fastPath.eligible, true);
  assert.equal(pass.json.fastPath.gates.I0_intent, 'pass');
  assert.equal(pass.json.fastPath.intent.quotes_verified, 2, '两条引用都应在用户原话里验到出处');

  // 不传 intent = 结构不可用 → 36（该修的是编排者），而不是 40（去问用户）
  const missing = runCli(base);
  assert.equal(missing.status, 36, '没给 intent 结构 → 36，不得与 40 混码');
  assert.equal(missing.json.fastPath.intentSkipped, true);
  assert.equal(missing.json.fastPath.intent, null);

  const under = runCli([...base, '--intent-json', JSON.stringify({ ...I0_GOOD, expected: '' })]);
  assert.equal(under.status, 40, '给了结构但槽位空 → 40（该问用户一次）');
  assert.equal(under.json.fastPath.eligible, false, '意图欠定义时 0 绝对不在候选里');
  assert.match(under.stderr, /一次性/);

  // 整段抄（两格共用同一片段）与编造引用：真实失败率最高的两种蒙混
  const copied = runCli([...base, '--intent-json', JSON.stringify({
    ...I0_GOOD, quotes: { expected: [I0_TEXT], actual: [I0_TEXT] } })]);
  assert.equal(copied.status, 40, '整段抄一遍两格共用 → 40');
  assert.match(copied.json.fastPath.message, /整段抄/);

  const madeUp = runCli([...base, '--intent-json', JSON.stringify({
    ...I0_GOOD, quotes: { expected: ['期望返回创建人姓名'], actual: ['接口返回的金额为负数'] } })]);
  assert.equal(madeUp.status, 40, '引用不在原话里 → 40（意译/编造会被机械发现）');
  assert.match(madeUp.json.fastPath.message, /找不到出处/);

  // 锚点不在原话：这条护栏以前提到都没提过
  const badAnchor = runCli(['--cwd', info.ws, '--module', 'order', '--anchor', 'GET /api/v1/order/x',
    '--text', '订单创建接口返回的创建人字段为空，期望返回创建人姓名',
    '--intent-json', JSON.stringify({ ...I0_GOOD, quotes: { expected: ['期望返回创建人姓名'], actual: ['返回的创建人字段为空'] } })]);
  assert.ok([30, 40].includes(badAnchor.status), `表里零命中会先 30，但不得是 0：${badAnchor.status}`);
});

test('I0 e2e：--anchor-source lookup 豁免，其余值一律按最严的 direct 处理', (t) => {
  const info = {};
  if (!freshRepoProject('i0src', 'ws-i0-src', info)) return t.skip('无 git');
  // 用户只说了工单号，route 是 F1.4 反查出来的——它本来就不应在原话里
  const text = '工单号 task-1024 里说创建人字段为空，期望返回创建人姓名';
  const it = { ...I0_GOOD, quotes: { expected: ['期望返回创建人姓名'], actual: ['task-1024 里说创建人字段为空'] } };
  const args = ['--cwd', info.ws, '--module', 'order', '--anchor', 'POST /api/v1/order/create', '--text', text];

  assert.equal(runCli([...args, '--intent-json', JSON.stringify(it)]).status, 40,
    '不声明出处 → 锚点验真照拦（漏杀不可接受）');
  const exempt = runCli([...args, '--intent-json', JSON.stringify(it), '--anchor-source', 'lookup']);
  assert.equal(exempt.status, 0, exempt.stderr);
  assert.equal(exempt.json.fastPath.intent.ok, true);
  // 写错了（大写/多空格之外的值）只能更严，不得静默把护栏关掉
  assert.equal(runCli([...args, '--intent-json', JSON.stringify(it), '--anchor-source', 'LOOKP']).status, 40,
    '畸形的 anchor-source 值不得当成 lookup');
});

test('I0 e2e：--intent-* 参数形状错误一律 36，解析失败时文案指向 --intent-report', (t) => {
  const info = {};
  if (!freshRepoProject('i0arg', 'ws-i0-arg', info)) return t.skip('无 git');
  const base = ['--cwd', info.ws, '--module', 'order', '--anchor', 'POST /api/v1/order/create', '--text', I0_TEXT];

  assert.equal(runCli([...base, '--intent-json']).status, 36, '末尾缺值');
  assert.equal(runCli([...base, '--intent-json', JSON.stringify(I0_GOOD), '--intent-report', 'x.json']).status, 36, '两个都给');
  const broken = runCli([...base, '--intent-json', '{ 不是 json']);
  assert.equal(broken.status, 36, '解不开 = 结构不可用 = 36，不是 40');
  assert.match(broken.json.fastPath.message, /--intent-report/, '文案要把人引向文件通道而不是“去问用户”');
  assert.equal(broken.json.fastPath.intentParseError ? true : false, true, '递出结构化标记供 jsonl 取用');

  // 文件通道：长文本走 --intent-report 才是 PowerShell 环境下的正路
  const file = path.join(root, 'i0-report.json');
  fs.writeFileSync(file, JSON.stringify(I0_GOOD), 'utf8');
  const ok = runCli([...base, '--intent-report', file]);
  assert.equal(ok.status, 0, ok.stderr);

  const onlyIntent = runCli(['--cwd', info.ws, '--module', 'order', '--intent-json', JSON.stringify(I0_GOOD)]);
  assert.equal(onlyIntent.status, 36, '只给 --intent-* 不给 --anchor：不得被读成“没申请门禁 → 0”');
});

test('I0 e2e：jsonl 埋下 intent{ran,quotes_*} 与 anchorSource（没这两项就答不了“拦了多少”）', (t) => {
  const info = {};
  if (!freshRepoProject('i0log', 'ws-i0-log', info)) return t.skip('无 git');
  const base = ['--cwd', info.ws, '--module', 'order', '--anchor', 'POST /api/v1/order/create', '--text', I0_TEXT];
  const logDir = path.join(privateRoot, 'logs');
  const f = fs.readdirSync(logDir).filter((x) => /^fastpath-\d{6}\.jsonl$/.test(x))[0];
  const read = () => fs.readFileSync(path.join(logDir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

  runCli([...base, '--intent-json', JSON.stringify(I0_GOOD)]);
  const good = read().at(-1);
  assert.equal(good.status, 0);
  assert.deepEqual({ ran: good.intent.ran, ok: good.intent.ok, v: good.intent.quotes_verified, t: good.intent.quotes_total },
    { ran: true, ok: true, v: 2, t: 2 });
  assert.equal(good.anchorSource, 'direct');
  assert.equal(good.intentGiven, true);

  // 被更早门禁短路时 ran 也要如实为 false/null，不得默认成“通过”
  runCli(['--cwd', info.ws, '--module', 'order', '--anchor', 'POST /api/v1/order/create']);
  const noText = read().at(-1);
  assert.equal(noText.intent.ran, false, '缺 --text 时 I0 没求值，得与“求值了但不合格”分开');

  runCli(base);
  const noIntent = read().at(-1);
  assert.equal(noIntent.intentGiven, false, '“根本没给结构”得能从账本里单独区分出来');
  assert.equal(noIntent.intent.ran, false);
});

// F3 回灌模式在同一进程里**重跑**一遍锚点门禁（带 --anchor/--text 是为了验
// “analyzer 分析的 target = 门禁解出的那条 route”）。于是 intent 也成了这次调用
// 的必填入参：漏带就是 36 → 升格完整路径——那是自伤，不是 G5 判出的“宽”。
//  commands/supperH-bug.md 的 F3 命令模板就靠本用例钉住。
test('I0 e2e：F3 回灌（--anchor + --impact-json）必须重带 --intent-*，漏带被自己判 36', (t) => {
  const info = {};
  if (!freshRepoProject('i0f3', 'ws-i0-f3', info)) return t.skip('无 git');
  const base = ['--cwd', info.ws, '--module', 'order', '--anchor', 'POST /api/v1/order/create', '--text', I0_TEXT];

  const both = runCli([...base, '--intent-json', JSON.stringify(I0_GOOD), '--impact-json', JSON.stringify(NARROW)]);
  assert.equal(both.status, 0, both.stderr);
  assert.equal(both.json.impact.applied, true, '门禁过了才轮到 G5 求值');
  assert.equal(both.json.impact.narrow, true);
  assert.equal(both.json.fastPath.gates.I0_intent, 'pass');

  const forget = runCli([...base, '--impact-json', JSON.stringify(NARROW)]);
  assert.equal(forget.status, 36, '漏带 intent → 门禁重跑时 I0 未求值 → 36（不得默默把 G5 当成唯一判定）');
  assert.equal(forget.json.impact.applied, false, '门禁未过时 G5 根本不该求值');

  const badIntent = runCli([...base, '--intent-json', JSON.stringify({ ...I0_GOOD, expected: '' }),
    '--impact-json', JSON.stringify(NARROW)]);
  assert.equal(badIntent.status, 40, '内容欠定义 → 40，且优先级高于 G5');
  assert.equal(badIntent.json.impact.applied, false);
});

// ---------- b2 --scope：派单时圈定的分析面，端到端锁住“越界一定出局” ----------
// 自报“我留在了范围内”永远无法核对，文件路径能核对。这组用例校的是接线本身：
// CLI 旗标 → scopeRoots → verifyImpactReport → 退出码 → jsonl。

const inScopeFile = () => path.join(workspace, 'src', 'main', 'java', 'com', 'demo', 'OrderController.java');
const outOfScopeFile = () => path.join(root, 'elsewhere', 'Other.java');
const flowReport = (file) => ({
  ...NARROW,
  data: { ...NARROW.data, flow: [{ class: 'com.demo.OrderController', method: 'create', file, evidence: ['E1'] }] }
});
const impactOf = (report, extra = []) => runCli(['--cwd', workspace, '--module', 'order', ...extra,
  '--impact-json', JSON.stringify(report)]);

test('b2 --scope：范围内→0 / 范围外→37 / 相对路径→37 / 自报越界→37', () => {
  const ok = impactOf(flowReport(inScopeFile()), ['--scope', workspace]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.json.impact.checks.scope, 'pass');

  const out = impactOf(flowReport(outOfScopeFile()), ['--scope', workspace]);
  assert.equal(out.status, 37, '读了范围外的文件 = 事实层面的面比允许的大，不是格式问题');
  assert.ok(out.json.impact.problems.join('|').includes('超出 --scope'), out.json.impact.problems.join('|'));

  const rel = impactOf(flowReport('src/main/java/com/demo/OrderController.java'), ['--scope', workspace]);
  assert.equal(rel.status, 37, '相对路径没有定义拼接基准，“看起来在范围内”不算证据');

  const self = impactOf({ ...NARROW, scope: { outside: [outOfScopeFile()] } }, ['--scope', workspace]);
  assert.equal(self.status, 37, 'analyzer 自报越界同样出局（它说了不算，但说出来就得算数）');

  const noScope = impactOf(flowReport(outOfScopeFile()));
  assert.equal(noScope.status, 0, '不给 --scope = 不校这一项（选配纪律，同 expectedRoute）');
  assert.equal(noScope.json.impact.checks.scope, 'absent', '未校过不得记成 pass');
});

test('b2 --scope 参数缺口→ 36：圈了范围却没人校，比不圈更危险', () => {
  assert.equal(runCli(['--cwd', workspace, '--module', 'order', '--scope']).status, 36, '末尾无值');
  assert.equal(impactOf(NARROW, ['--scope', '']).status, 36, '空白路径：要么全判越界要么全放行，两种都不是结论');
  assert.equal(runCli(['--cwd', workspace, '--module', 'order', '--scope', workspace]).status, 36, '只圈范围不回灌 → 没人校');
});

test('b2 --scope jsonl 落账：scopeGiven/scopeRoots（没圈范围的通过不能与校过越界的混为一谈）', () => {
  impactOf(flowReport(inScopeFile()), ['--scope', workspace]);
  impactOf(NARROW);
  const logDir = path.join(privateRoot, 'logs');
  const f = fs.readdirSync(logDir).filter((x) => /^fastpath-\d{6}\.jsonl$/.test(x))[0];
  const lines = fs.readFileSync(path.join(logDir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const gates = lines.filter((l) => l.stage === 'impact_gate');
  const withScope = gates.at(-2);
  const withoutScope = gates.at(-1);
  assert.deepEqual({ given: withScope.scopeGiven, roots: withScope.scopeRoots }, { given: true, roots: 1 });
  assert.deepEqual({ given: withoutScope.scopeGiven, roots: withoutScope.scopeRoots }, { given: false, roots: 0 });
});

// ---------- c2 两个基线：新鲜度（代码侧 HEAD）与诊断（环境侧 branches/db.schemas） ----------
// 两者一直只被叫作“同一个项目”，就会出现：查的是 uat 库 + 看的是 dev 分支 HEAD → 结论写“代码与数据不一致”。
// 夹具 demo.yaml：branches {prod,uat,dev} + db.schemas {prod,uat,test} → 合法环境名四个，两边不对齐。

test('c2 --env 合法：回挂 branch+schema，不碰 freshness/fastPath 字段', () => {
  const r = runCli(['--cwd', workspace, '--module', 'order', '--env', 'prod']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.diagnoseBaseline, {
    declared: true, env: 'prod', branch: 'prod', schema: 'p', codeSide: 'freshness.headCommit'
  });
  // 两个基线各占一个字段：诊断环境不得覆写代码侧结论的任何一个键
  assert.ok('freshness' in r.json, '代码侧基线仍由 freshness 字段承载');
  assert.ok(!('fastPath' in r.json), '--env 不申请门禁结论，不得伪造 fastPath 字段');

  const noEnv = runCli(['--cwd', workspace, '--module', 'order']);
  assert.equal(noEnv.status, 0, noEnv.stderr);
  assert.ok(!('diagnoseBaseline' in noEnv.json), '不给 --env = 不注入新字段（plain 输出形状不变）');
});

test('c2 branches 与 db.schemas 不对齐时该侧回 null：不报错，也不编一个值', () => {
  const only = runCli(['--cwd', workspace, '--module', 'order', '--env', 'test']);
  assert.equal(only.status, 0, only.stderr);
  assert.deepEqual({ env: only.json.diagnoseBaseline.env, branch: only.json.diagnoseBaseline.branch, schema: only.json.diagnoseBaseline.schema },
    { env: 'test', branch: null, schema: 't' }, 'test 库没有对应分支：该侧回 null，不能编一个');

  const dev = runCli(['--cwd', workspace, '--module', 'order', '--env', 'dev']);
  assert.equal(dev.json.diagnoseBaseline.schema, null, 'dev 分支没有对应 schema：同样回 null');
});

test('c2 --env 不许猜：未知/大小写不对/缺值 一律 36，且不被门禁的 0 抢走', () => {
  const unknown = runCli(['--cwd', workspace, '--module', 'order', '--env', 'SIT']);
  assert.equal(unknown.status, 36, '未声明的环境名不得默认成任何一个');
  assert.equal(unknown.json.diagnoseBaseline.declared, false);
  const reason = unknown.json.diagnoseBaseline.reason;
  assert.ok(/prod/.test(reason) && /uat/.test(reason), '得把合法名清单递给调用方：' + reason);

  // 环境无效必须压在门禁之前：否则“--module 单独给 = 退 0”这条路会把无效环境静默放过去
  assert.equal(runCli(['--cwd', workspace, '--module', 'order', '--env', 'PROD']).status, 36, '环境名区分大小写');
  assert.equal(runCli(['--cwd', workspace, '--module', 'order', '--env']).status, 36, '末尾无值');
  assert.equal(runCli(['--cwd', workspace, '--module', 'order', '--env', '  ']).status, 36, '空白值');
});

test('c2 纯代码模式（L2 无 db 段）：--env 无源可采 → 36，不给 --env 仍退 0', () => {
  // 接不接库是用户的选择（F-7），但选了“不接”就不能再要环境结论：
  // 环境标签只对“从某个库取回的数据”成立，代码侧永远相对 HEAD。
  const ws = path.join(root, 'ws-pure');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(privateRoot, 'projects', 'pure.yaml'),
    `schemaVersion: 1\nidentity:\n  code: pure\n  displayName: Pure\n  workspaces:\n    - "${ws.replace(/\\/g, '/')}"\ncodeRoot: "${ws.replace(/\\/g, '/')}"\npackageRoot: com.pure\nmodules:\n  - name: order\n    entryPattern: '**/*.java'\nbuild:\n  tool: maven\n  jdk: '1.8'\n  compileCmd: mvn compile\n  testCmd: mvn test\nbranches: { prod: prod, uat: uat, dev: dev }\nnaming:\n  commandPrefix: /supperH\n`, 'utf8');

  const plain = runCli(['--cwd', ws]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.json.ok, true, '不接库是合法运行态，不是处处报错');
  assert.ok(!plain.json.db, '无 db 段不得被伪造成空对象');

  const env = runCli(['--cwd', ws, '--env', 'prod']);
  assert.equal(env.status, 36, '无源可采的环境请求必须整单作废，而不是静默降级成代码结论');
  assert.equal(env.json.diagnoseBaseline.declared, false);
  assert.match(env.json.diagnoseBaseline.reason, /未接入数据库|纯代码模式/);
  // 得把出路递到调用方手上：两条（接库 / 去掉 --env），而不是只说“不行”
  assert.match(env.json.diagnoseBaseline.reason, /\/supperH-init/);
  assert.match(env.json.diagnoseBaseline.reason, /别给 --env/);
});

test('c2 jsonl：baseline_gate 落账，anchor_gate/impact_gate 带 diagnoseEnv', () => {
  runCli(['--cwd', workspace, '--module', 'order', '--env', 'SIT']);
  runCli(['--cwd', workspace, '--module', 'order', '--env', 'uat', '--impact-json', JSON.stringify(NARROW)]);
  const logDir = path.join(privateRoot, 'logs');
  const f = fs.readdirSync(logDir).filter((x) => /^fastpath-\d{6}\.jsonl$/.test(x))[0];
  const lines = fs.readFileSync(path.join(logDir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const bad = lines.filter((l) => l.stage === 'baseline_gate').at(-1);
  assert.equal(bad.status, 36, '基线无效也要记账：否则分母缺一块');
  assert.equal(bad.env, 'SIT');
  const imp = lines.filter((l) => l.stage === 'impact_gate').at(-1);
  assert.equal(imp.diagnoseEnv, 'uat', '不记环境就没法事后回答“这条结论在哪个环境上复核过”');
});

// ---------- d2 --preflight：只集本地事实，只记录不阻断（docs/architecture.md §10.10） ----------
// 这组用例必须跑**真 git 仓**：假数据永远抽不到“git 参数写错”那一类 bug。
// 典型例子：漏了 `-c core.quotePath=false`，中文脏文件名会变成 `"\346\226\207..."`，
// 下游拿它与 plan 的 touched_files 比对永远不相等 → “脏文件命中计划内文件”这条停问
// 判据静默失效。另一些关键不变式：非 git 目录**不得**变成失败（预检无权阻断），
// 以及“不知道”与“干净”必须分得开（dirtyKnown vs dirtyCount）。
let GIT_PROBE;
function pfYaml(code, ws, gitLines) {
  const w = ws.replace(/\\/g, '/');
  return [
    'schemaVersion: 1',
    'identity:',
    `  code: ${code}`,
    `  displayName: "${code} preflight"`,
    '  workspaces:',
    `    - "${w}"`,
    `codeRoot: "${w}"`,
    'packageRoot: com.demo',
    'modules:',
    "  - name: order",
    "    entryPattern: '**/*.java'",
    'build:',
    '  tool: maven',
    "  jdk: '1.8'",
    '  compileCmd: mvn compile',
    '  testCmd: mvn test',
    'db:',
    '  host: localhost',
    '  port: 5432',
    '  schemas: { prod: p, uat: u, test: t }',
    '  readonlyUser: ro',
    'branches: { prod: prod, uat: uat, dev: dev }',
    'drivers:',
    '  database: { impl: noop.py, healthCheck: noop.py }',
    'naming:',
    '  commandPrefix: /supperH',
    ...(gitLines || []),
    ''
  ].join('\n');
}
/** 造一个真 git 仓 + 注册它对应的项目；无 git 环境返回 null（整组 skip） */
function pfRepo(name, code, { files = { 'a.txt': '1\n' }, gitLines = null } = {}) {
  if (GIT_PROBE === 'no') return null;
  try {
    const ws = path.join(root, name);
    fs.mkdirSync(ws, { recursive: true });
    const git = (...args) => execFileSync('git', ['-C', ws, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
    const gitEnv = (env, ...args) => execFileSync('git', ['-C', ws, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, env: { ...process.env, ...env } });
    const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
    git('init', '-q');
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(ws, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body, 'utf8');
    }
    git('add', '-A');
    git(...ID, 'commit', '-q', '-m', 'c1');
    if (GIT_PROBE === undefined) GIT_PROBE = 'yes';
    fs.writeFileSync(path.join(privateRoot, 'projects', `${code}.yaml`), pfYaml(code, ws, gitLines), 'utf8');
    return {
      ws, git, gitEnv,
      id: ID,
      write: (rel, body) => { const abs = path.join(ws, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body, 'utf8'); },
      refs: () => git('for-each-ref', '--format=%(refname)', 'refs/supperh', 'refs/heads', 'refs/tags')
        .split('\n').map((s) => s.trim()).filter(Boolean)
    };
  } catch {
    GIT_PROBE = 'no';
    return null;
  }
}
const pfRun = (ws, extra = []) => runCli(['--cwd', ws, '--preflight', ...extra]);

test('d2 不给 --preflight 时不注入新字段（与 --env 同一形状纪律）', () => {
  const r = runCli(['--cwd', workspace, '--module', 'order']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!('preflight' in r.json), '没申请就不伪造：plain 输出形状必须与改动前一致');
});

test('d2 非 git 工作区：只记录不可用，绝不把退出码改成失败', () => {
  // 夹具里的 workspace 就是一个普通临时目录（没有 .git）——这正好是真实项
  // 目最常见的形态之一，它不得被读成“预检失败所以不能开工”
  const r = pfRun(workspace);
  assert.equal(r.status, 0, '脏 / 无 git 都不是门禁：预检无权阻断任务');
  assert.equal(r.json.preflight.blocking, false);
  assert.equal(r.json.preflight.available, false);
  assert.equal(r.json.preflight.dirtyKnown, false, '取不到 ≠ 干净：两者必须分得开');
  assert.equal(r.json.preflight.dirtyCount, null, '“不知道”得是 null，不是 0（0 会被读成绿灯）');
  assert.equal(r.json.preflight.snapshotPossible, false);
  assert.match(r.json.preflight.reason, /git/);
  assert.equal(r.json.preflight.snapshotSweep.ran, false);
});

test('d2 真 git 仓（干净）：分支 / HEAD / 零脏全部如实报出', (t) => {
  const repo = pfRepo('pf-clean', 'pf1');
  if (!repo) return t.skip('无 git');
  const r = pfRun(repo.ws);
  assert.equal(r.status, 0, r.stderr);
  const p = r.json.preflight;
  assert.equal(p.available, true);
  assert.equal(p.hasCommits, true);
  assert.ok(typeof p.branch === 'string' && p.branch.length > 0, '分支名要能报出来：' + JSON.stringify(p.branch));
  assert.equal(p.detached, false);
  assert.equal(p.headCommit, repo.git('rev-parse', 'HEAD').trim());
  assert.deepEqual({ known: p.dirtyKnown, count: p.dirtyCount, files: p.dirtyFiles },
    { known: true, count: 0, files: [] }, '确认干净：空数组而非 null');
  assert.equal(p.snapshotPossible, true, '有 commit 就有基线可存 → stash create 可用');
  assert.equal(p.snapshotBlocker, null);
  assert.equal(p.snapshotSweep.ran, true, 'git 仓内应真的跑过一次清扫');
  assert.equal(p.snapshotSweep.scanned, 0);
  // 取数源声明情况也是预检的一部分：“把 SQL 原文递给人校验”能否做到，开工前就该看见。
  // 键 = 注册表里的**实际槽位名**（F-11 后 L1 不持有名单）：未声明的名字表现为缺键，
  // 不再逐个写 false —— 那份固定名单本身就是“只有这四个源”的假设，加第五个源时它不报错、只是看不见。
  assert.deepEqual(p.driverSlots,
    { database: { kind: 'script', role: 'database', hasHealthCheck: true, hasDesc: false } });
  assert.equal(p.driverSlotCount, 1, '纯代码模式必须能报成 0 个，而不是“探过了但没结果”');
  assert.equal(p.dbDriverSlot, 'database', '库通道槽位名如实报出（存量同名写法也算）');
});

test('d2 脏文件：已追踪改动 + 未追踪 + 中文路径全部列全且不被转义', (t) => {
  const repo = pfRepo('pf-dirty', 'pf2');
  if (!repo) return t.skip('无 git');
  repo.write('a.txt', '2\n');                              // 已追踪修改
  repo.write('新接口控制器.java', 'x\n');        // 未追踪 + 非 ASCII
  const p = pfRun(repo.ws).json.preflight;
  assert.equal(p.dirtyKnown, true);
  assert.equal(p.dirtyCount, 2, JSON.stringify(p.dirtyFiles));
  assert.deepEqual(p.dirtyFiles, ['a.txt', '新接口控制器.java'],
    '少了 -c core.quotePath=false 时第二项会变成八进制串，命中判定从此静默失效');
  assert.equal(p.dirtyTruncated, false);
  assert.equal(p.dirtyNote, null, '未超限不得凭空造出一句“不可靠”提示');
});

test('d2 deliveryMode 运行期解析：不写=none / push-pr 标不支持 / 非法值折叠到 none 但保留原值', (t) => {
  const none = pfRepo('pf-none', 'pf3');
  const push = pfRepo('pf-push', 'pf4', { gitLines: ['git:', '  deliveryMode: push-pr'] });
  const bad = pfRepo('pf-bad', 'pf5', { gitLines: ['git:', '  deliveryMode: force-push'] });
  if (!none || !push || !bad) return t.skip('无 git');
  const a = pfRun(none.ws).json.preflight.delivery;
  assert.deepEqual({ mode: a.mode, declared: a.declared, clamped: a.clamped, supported: a.supported, ttl: a.snapshotTtlDays },
    { mode: 'none', declared: null, clamped: false, supported: true, ttl: 7 }, 'L2 没写 = 最安全缺省，不能交给模型推断');
  const b = pfRun(push.ws).json.preflight.delivery;
  assert.deepEqual({ mode: b.mode, supported: b.supported }, { mode: 'push-pr', supported: false },
    '声明要原样递出：“一期不执行”是执行者的判断，不是解析器暗中改写');
  const c = pfRun(bad.ws).json.preflight.delivery;
  assert.deepEqual({ mode: c.mode, declared: c.declared, clamped: c.clamped },
    { mode: 'none', declared: 'force-push', clamped: true },
    '手写未过 validate 的 L2：折叠到更安全的一档 + 原值可见，既不中断也不悄悄当成用户本意');
});

test('d2 预检永不改变退出码：同一调用带/不带 --preflight 结果必相同', (t) => {
  const repo = pfRepo('pf-code', 'pf6');
  if (!repo) return t.skip('无 git');
  const base = ['--module', 'order', '--anchor', 'POST /api/v1/order/create', '--text', '创建人字段为空，期望回填'];
  const plain = runCli(['--cwd', repo.ws, ...base]);
  const withPf = runCli(['--cwd', repo.ws, '--preflight', ...base]);
  assert.equal(withPf.status, plain.status, `预检不得抢走门禁的退出码（${plain.status} → ${withPf.status}）`);
  assert.ok(withPf.json.preflight, '预检字段仍要递出');
  assert.ok(!plain.json.preflight, '不带旗标的那次调用不得被附带新字段');
  assert.deepEqual(withPf.json.fastPath, plain.json.fastPath, '门禁结论逐字段不变');
});

test('d2 envVoid 时不输出半截预检（环境没定下来，先报 36）', () => {
  const r = runCli(['--cwd', workspace, '--module', 'order', '--env', 'SIT', '--preflight']);
  assert.equal(r.status, 36);
  assert.ok(!('preflight' in r.json), '与 freshness 同一处理：调用本身不成立时不递局部事实');
});

test('d2 快照 ref 清扫：过期的删、未到期的留、别人的命名空间不碰', (t) => {
  const repo = pfRepo('pf-sweep', 'pf7', { gitLines: ['git:', '  deliveryMode: none', '  snapshotTtlDays: 7'] });
  if (!repo) return t.skip('无 git');
  repo.write('a.txt', '2\n');
  // 两个“古老”快照 ref（一个在本项目前缀下、一个故意放在邻近前缀）+ 一个新鲜 ref
  const OLD = repo.gitEnv({ GIT_COMMITTER_DATE: '2000-01-01T00:00:00 +0800', GIT_AUTHOR_DATE: '2000-01-01T00:00:00 +0800' },
    ...repo.id, 'stash', 'create').trim();
  assert.ok(OLD, '工作区脏时 stash create 必须产出 sha');
  repo.git(...repo.id, 'update-ref', 'refs/supperh/snap/old', OLD);
  repo.git(...repo.id, 'update-ref', 'refs/supperh/keep/old', OLD);
  repo.git(...repo.id, 'update-ref', 'refs/heads/some-branch', OLD);
  const NEW = repo.git(...repo.id, 'stash', 'create').trim();
  repo.git(...repo.id, 'update-ref', 'refs/supperh/snap/fresh', NEW);

  const sw = pfRun(repo.ws).json.preflight.snapshotSweep;
  assert.equal(sw.ran, true);
  assert.equal(sw.scanned, 2, '只应遍历 refs/supperh/snap/ 前缀：两个老 ref 不在范围内');
  assert.deepEqual(sw.removed, ['refs/supperh/snap/old'], JSON.stringify(sw));
  assert.equal(sw.kept, 1, '新鲜的那条必须保留');
  const refs = repo.refs();
  assert.ok(!refs.includes('refs/supperh/snap/old'), '过期快照 ref 应当已被清掉');
  assert.ok(refs.includes('refs/supperh/snap/fresh'), '未到期的绝不能删');
  assert.ok(refs.includes('refs/supperh/keep/old'), '同命名空间下的其它前缀不属于 snap 清扫范围');
  assert.ok(refs.includes('refs/heads/some-branch'), '分支 ref 是用户的东西，旧不旧都不许碰');
});

test('d2 snapshotTtlDays=0 = 不自动清扫：一条也不删', (t) => {
  const repo = pfRepo('pf-nottl', 'pf8', { gitLines: ['git:', '  snapshotTtlDays: 0'] });
  if (!repo) return t.skip('无 git');
  repo.write('a.txt', '2\n');
  const OLD = repo.gitEnv({ GIT_COMMITTER_DATE: '2000-01-01T00:00:00 +0800', GIT_AUTHOR_DATE: '2000-01-01T00:00:00 +0800' },
    ...repo.id, 'stash', 'create').trim();
  repo.git(...repo.id, 'update-ref', 'refs/supperh/snap/old', OLD);
  const p = pfRun(repo.ws).json.preflight;
  assert.equal(p.delivery.snapshotTtlDays, 0);
  assert.deepEqual({ ran: p.snapshotSweep.ran, removed: p.snapshotSweep.removed }, { ran: false, removed: [] });
  assert.match(p.snapshotSweep.reason, /不自动清扫/);
  assert.ok(repo.refs().includes('refs/supperh/snap/old'), '用户明说不要清扫，就一条也不能少删');
});

test('d2 jsonl：预检落 stage=preflight 一行，带交付解析与清扫计数（不写脏清单本体）', (t) => {
  const repo = pfRepo('pf-log', 'pf9');
  if (!repo) return t.skip('无 git');
  repo.write('a.txt', '2\n');
  pfRun(repo.ws);
  const logDir = path.join(privateRoot, 'logs');
  const f = fs.readdirSync(logDir).filter((x) => /^fastpath-\d{6}\.jsonl$/.test(x))[0];
  const lines = fs.readFileSync(path.join(logDir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const rec = lines.filter((l) => l.stage === 'preflight').at(-1);
  assert.ok(rec, '预检也要记账：否则“多少仓是脏开工”这类问题只能靠回忆');
  assert.equal(rec.project, 'pf9');
  assert.equal(rec.deliveryMode, 'none');
  assert.equal(rec.dirtyCount, 1);
  assert.equal(rec.dirtyKnown, true);
  assert.equal(rec.sweepRan, true);
  assert.equal(rec.dbDriverDeclared, true, '账本要能回答“这个仓能不能取 SQL”：不记就只能重跑一次才知道');
  assert.equal(rec.dirtyListed, 1);
  assert.ok(!('dirtyFiles' in rec), '脏清单本体不进账本：它可以有几千条，只记数量');
});
