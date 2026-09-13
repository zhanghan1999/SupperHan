// tests/validate-registry.test.mjs
// `node scripts/validate-project.mjs` 的注册表感知：多项目全量校验、按 code 单选、用法错误与校验失败
// 必须是不同退出码（否则"参数写错"会被 docs 里的"validate 失败→修 project.yaml"引向歧途）。
// 另锁死一条已踩过的坑：identity.workspaces 由 /supperH-init 与 migrate-registry.mjs 写入、
// 由 resolve-project 用来绑定 cwd，schema 若不声明它（additionalProperties:false），
// 每一个真实注册过的项目都会被判成违规。
// 以及跨字段通道规则（schema 表达不了：本仓库最小校验器没有 if/then/allOf）：
// kind=mcp 必须带 mcp 绑定、script 槽位不得挂 mcp 段、废弃槽位只警告不阻断，
// 以及退役键清点（F-12）：db.writableUser / db.forbidWriteSchemas / writes[].action=sql_write
// 出现即退 2 并点名怎么删。旧形态查的是"禁写清单盖没盖住 prod/uat"，那份清单已整个退役。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import os     from 'node:os';
import path   from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT    = path.join(__dirname, '..', 'scripts', 'validate-project.mjs');

function projYaml(code) {
  return [
    'schemaVersion: 1',
    'identity:',
    `  code: ${code}`,
    `  displayName: "${code} 显示名"`,
    '  workspaces:',
    `    - "C:/tmp/${code}"`,
    `codeRoot: "C:/tmp/${code}"`,
    'packageRoot: com.example.demo',
    'modules:',
    '  - name: order',
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
    ''
  ].join('\n');
}

let root;
function mkPrivate(name, files) {
  const pr = path.join(root, name);
  fs.mkdirSync(path.join(pr, 'projects'), { recursive: true });
  for (const [name2, text] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(pr, 'projects', name2), text, 'utf8');
  }
  return pr;
}
function run(args, privateRoot) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SUPPERH_PRIVATE_ROOT: privateRoot }
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-validate-')); });

test('无参：校验 projects/ 下全部文件（不再只读迁移前的单个 project.yaml）', () => {
  const pr = mkPrivate('multi', { 'aa.yaml': projYaml('aa'), 'bb.yaml': projYaml('bb') });
  const r = run([], pr);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /OK: aa/);
  assert.match(r.out, /OK: bb/);
  assert.match(r.out, /2 passed \/ 2 checked/);
  // workspaces 是 init/migrate 写入的字段：被 schema 拒绝就等于每个真实项目都校验失败
  assert.doesNotMatch(r.err, /workspaces/);
});

test('branches 可选，但写了就得完整（F-8：缺席是合法答案，假值是错误答案）', () => {
  const base = projYaml('aa');
  // 1）整段缺席 = “未登记分支映射”，必须能过：/supperH-init 对未检出的键就是不写
  const none = mkPrivate('br-none', { 'aa.yaml': base.replace(/^branches:.*$/m, '# branches 未登记') });
  assert.equal(run(['--project', 'aa'], none).status, 0, 'branches 不在顶层 required 里');

  // 2）写了却不写 prod = 没有部署目标，半截比不写更糟
  const noProd = mkPrivate('br-noprod', { 'aa.yaml': base.replace(/^branches: .*$/m, 'branches: { uat: uat, dev: dev }') });
  const r2 = run(['--project', 'aa'], noProd);
  assert.equal(r2.status, 2);
  assert.match(r2.err + r2.out, /branches\.prod: required field missing/);

  // 3）空串不是合法分支名：它会在 --env 那里长成“环境名合法、branch 取不到”的歧义现场
  const blank = mkPrivate('br-blank', { 'aa.yaml': base.replace(/^branches: .*$/m, 'branches: { prod: "", uat: uat, dev: dev }') });
  const r3 = run(['--project', 'aa'], blank);
  assert.equal(r3.status, 2);
  assert.match(r3.err + r3.out, /branches\.prod: minLength/);

  // 4）环境名只认 prod/uat/dev：多一个键得被拦下，而不是“写了但没人读”
  const extra = mkPrivate('br-extra', { 'aa.yaml': base.replace(/^branches: .*$/m, 'branches: { prod: prod, uat: uat, dev: dev, sit: sit }') });
  const r4 = run(['--project', 'aa'], extra);
  assert.equal(r4.status, 2);
  assert.match(r4.err + r4.out, /branches\.sit: additional property not allowed/);
});

test('--project 单选命中 / 未命中：未命中是用法错误（3），不是校验失败（2）', () => {
  const pr = mkPrivate('pick', { 'aa.yaml': projYaml('aa'), 'bb.yaml': projYaml('bb') });
  const one = run(['--project', 'aa'], pr);
  assert.equal(one.status, 0, one.err);
  assert.match(one.out, /1 passed \/ 1 checked/);
  assert.doesNotMatch(one.out, /OK: bb/);

  const miss = run(['--project', 'zz'], pr);
  assert.equal(miss.status, 3, 'code 不存在应报"未注册"而不是"结构违规"');
  assert.match(miss.err, /not registered/);
});

test('违规文件逐个点名：缺 identity.code 会让解析器静默跳过（表现为已注册却报未注册）', () => {
  const noCode = projYaml('aa').replace(/^  code: aa$/m, '  # code 被误删');
  const pr = mkPrivate('bad', { 'aa.yaml': projYaml('aa'), 'cc.yaml': noCode });
  const r = run([], pr);
  assert.equal(r.status, 2);
  assert.match(r.out, /OK: aa/, '好的那个仍应报 OK：不能只报第一个失败');
  assert.match(r.err, /FAIL: cc/);
  assert.match(r.err, /identity\.code/);
  assert.match(r.out, /1 passed \/ 2 checked/, '汇总行走 stdout：机读结果与失败明细分流');
});

test('同一 identity.code 出现在两个文件 → 违规（项目身份失去唯一性）', () => {
  const pr = mkPrivate('dup', { 'aa.yaml': projYaml('aa'), 'alias.yaml': projYaml('aa') });
  const r = run([], pr);
  assert.equal(r.status, 2);
  assert.match(r.err, /重复/);
  assert.match(r.err, /aa\.yaml/);
  assert.match(r.err, /alias\.yaml/);
});

test('文件名 ≠ identity.code：只警告不阻断（解析器按 identity.code 取身份）', () => {
  const pr = mkPrivate('mismatch', { 'cc.yaml': projYaml('dd') });
  const r = run([], pr);
  assert.equal(r.status, 0, r.err);
  assert.match(r.err, /文件名/);
  assert.match(r.out, /OK: dd/);
});

test('用法错误一律 exit 3：未知参数、末尾缺值（与门禁脚本同一套姿态）', () => {
  const pr = mkPrivate('usage', { 'aa.yaml': projYaml('aa') });
  assert.equal(run(['--bogus'], pr).status, 3);
  assert.equal(run(['--project'], pr).status, 3, '--project 放在末尾且无值不得静默当成没传');
  assert.equal(run(['--file'], pr).status, 3);
  const noFile = run(['--file', path.join(pr, 'nope.yaml')], pr);
  assert.equal(noFile.status, 3);
  assert.match(noFile.err, /no such file/);
});

test('--file 可校验未注册的草稿；--json 给机器消费', () => {
  const pr = mkPrivate('draft', {});
  const draft = path.join(root, 'draft', 'x.yaml');
  fs.mkdirSync(path.dirname(draft), { recursive: true });
  fs.writeFileSync(draft, projYaml('ee'), 'utf8');
  const j = run(['--file', draft, '--json'], pr);
  assert.equal(j.status, 0, j.err);
  const parsed = JSON.parse(j.out);
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.checked, 1);
  assert.equal(parsed.results[0].code, 'ee');
  assert.deepEqual(parsed.results[0].errors, []);
});

test('空注册表 → 2 并引导 /supperH-init；legacy 单文件仍可用但要提示迁移', () => {
  const empty = mkPrivate('empty', {});
  const r0 = run([], empty);
  assert.equal(r0.status, 2);
  assert.match(r0.err, /no project to validate/);

  const legacy = path.join(root, 'legacy');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'project.yaml'), projYaml('ff'), 'utf8');
  const r1 = run([], legacy);
  assert.equal(r1.status, 0, r1.err);
  assert.match(r1.err, /legacy single project\.yaml/);
  assert.match(r1.err, /migrate-registry\.mjs/);
});

test('私有根缺失 → 2 并引导 bootstrap（不裸抛 ENOENT）', () => {
  const r = run([], path.join(root, 'nowhere'));
  assert.equal(r.status, 2);
  assert.match(r.err, /private root not found/);
  assert.match(r.err, /supperH-bootstrap/);
});

// ---- 调用通道跨字段规则（阶段4）-------------------------------------------------
// projYaml() 的 drivers 块只有 database 一行；替换整块以构造通道变体。
function projWithDrivers(code, driversLines) {
  return projYaml(code).replace(
    /^drivers:\n[^\n]*\n/m,
    'drivers:\n' + driversLines.join('\n') + '\n'
  );
}
function checkDrivers(name, code, driversLines) {
  const pr = mkPrivate(name, { [`${code}.yaml`]: projWithDrivers(code, driversLines) });
  const r = run(['--json'], pr);
  const j = JSON.parse(r.out);
  return {
    status: r.status,
    errors: j.results?.[0]?.errors ?? [],
    warnings: j.results?.[0]?.warnings ?? []
  };
}
const MCP_BINDING = [
  '  database:',
  '    impl: noop.py',
  '    healthCheck: noop.py',
  '    kind: mcp',
  '    fallback: script',
  '    mcp:',
  '      server: supperh-drivers',
  "      sources: ['sys_menu', 'demo_order']",
  '      healthTool: db_health'
];

test('未声明 kind/fallback/mcp 的旧配置仍通过：新增字段不得让已注册项目突然全灭', () => {
  const r = checkDrivers('chan-baseline', 'ca', [
    '  database: { impl: noop.py, healthCheck: noop.py }'
  ]);
  assert.equal(r.status, 0, JSON.stringify(r.errors));
  assert.ok(r.warnings.every((w) => typeof w === 'string'), '新字段只能以告警出场，不得产出违法项');
  assert.match(JSON.stringify(r.warnings), /没有 desc/,
    '缺 desc 的存量条目要被点名（写入门禁才硬拦它）：' + JSON.stringify(r.warnings));
});

test('kind=mcp + 完整 mcp 绑定 → 合法（通道扩展不是新门禁）', () => {
  const r = checkDrivers('chan-mcp-ok', 'cb', MCP_BINDING);
  assert.equal(r.status, 0, JSON.stringify(r.errors));
});

test('废弃槽位 vpnPreCheck 仍可解析且只发警告：删键会让已注册项目一夜全灭（退场兼容）', () => {
  const r = checkDrivers('chan-deprecated-slot', 'cc', [
    '  database: { impl: noop.py, healthCheck: noop.py }',
    '  vpnPreCheck:',
    '    impl: vpn.py',
    '    healthCheck: vpn.py'
  ]);
  assert.equal(r.status, 0, '废弃不得改变退出码：' + JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => /vpnPreCheck 已废弃/.test(w)),
    '必须给出可执行的退场理由（为何废弃 + 该怎么处置），不能默默放过：' + JSON.stringify(r.warnings));
});

test('kind=mcp 但缺绑定 / sources 为空 → 2：运行期不能没有可走的通道', () => {
  const noBinding = checkDrivers('chan-no-binding', 'cd', [
    '  database: { impl: noop.py, healthCheck: noop.py }',
    '  logs:',
    '    impl: log.py',
    '    healthCheck: log.py',
    '    kind: mcp'
  ]);
  assert.equal(noBinding.status, 2);
  assert.ok(noBinding.errors.some((e) => /缺 mcp 绑定/.test(e)), JSON.stringify(noBinding.errors));

  const emptySources = checkDrivers('chan-empty-sources', 'ce', [
    '  database: { impl: noop.py, healthCheck: noop.py }',
    '  logs:',
    '    impl: log.py',
    '    healthCheck: log.py',
    '    kind: mcp',
    '    mcp: { server: supperh-drivers, sources: [] }'
  ]);
  assert.equal(emptySources.status, 2);
  assert.ok(emptySources.errors.some((e) => /非空白名单/.test(e)), JSON.stringify(emptySources.errors));
});

test('kind=script 却挂了 mcp 段 → 2：配置自相矛盾会被静默忽略', () => {
  const r = checkDrivers('chan-orphan-mcp', 'cf', [
    '  database: { impl: noop.py, healthCheck: noop.py }',
    '  tickets:',
    '    impl: t.py',
    '    healthCheck: t.py',
    '    mcp: { server: supperh-drivers, sources: [x] }'
  ]);
  assert.equal(r.status, 2);
  assert.ok(r.errors.some((e) => /仅在 kind=mcp 时有意义/.test(e)), JSON.stringify(r.errors));
});

test('fallback=none：警告不阻断（server 起不来时该源会静默不可用）', () => {
  const r = checkDrivers('chan-fallback-none', 'cg', [
    '  database: { impl: noop.py, healthCheck: noop.py }',
    '  efficiency:',
    '    impl: e.py',
    '    healthCheck: e.py',
    '    kind: mcp',
    '    fallback: none',
    '    mcp: { server: supperh-drivers, sources: [kpi] }'
  ]);
  assert.equal(r.status, 0, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => /fallback=none/.test(w)), JSON.stringify(r.warnings));
});

test('kind 非 {script,mcp} → 2：三通道分类已被否定，不留第三值', () => {
  const r = checkDrivers('chan-bad-kind', 'ch', [
    '  database: { impl: noop.py, healthCheck: noop.py, kind: http }'
  ]);
  assert.equal(r.status, 2);
  assert.ok(r.errors.some((e) => /database\.kind/.test(e) && /enum/.test(e)), JSON.stringify(r.errors));
});

// ---- git 交付与快照段（d1）---------------------------------------------------
// 这段是可选的：缺省形态（不 commit + 快照存 7 天）由脚本在运行期给出，
// 所以“不写 git 段”必须仍过校验——否则每一个已注册项目会在加完这个键后全灭（同一个坑）。
function projWithGit(code, gitLines) {
  return projYaml(code) + (gitLines ? gitLines.join('\n') + '\n' : '');
}
function checkGit(name, code, gitLines) {
  const pr = mkPrivate(name, { [`${code}.yaml`]: projWithGit(code, gitLines) });
  const r = run(['--json'], pr);
  let j = { results: [] };
  try { j = JSON.parse(r.out); } catch { /* 非 0 时 stdout 可能是空 */ }
  return { status: r.status, errors: j.results?.[0]?.errors ?? [], err: r.err };
}

test('不写 git 段 → 通过：可选段不得因为新增 schema 而变成事实必填', () => {
  const r = checkGit('git-absent', 'ga', null);
  assert.equal(r.status, 0, JSON.stringify(r.errors));
});

test('git.deliveryMode 三个合法值 + snapshotTtlDays 边界值 → 通过', () => {
  for (const mode of ['none', 'local-commit', 'push-pr']) {
    const r = checkGit(`git-mode-${mode}`, `gb${mode.length}`, ['git:', `  deliveryMode: ${mode}`, '  snapshotTtlDays: 0']);
    assert.equal(r.status, 0, `${mode}: ${JSON.stringify(r.errors)}`);
  }
  const max = checkGit('git-ttl-max', 'gc', ['git:', '  snapshotTtlDays: 365']);
  assert.equal(max.status, 0, JSON.stringify(max.errors));
});

test('git 段写错会被拦下：非法 mode / TTL 越界 / 未知子键', () => {
  const badMode = checkGit('git-bad-mode', 'gd', ['git:', '  deliveryMode: force-push']);
  assert.equal(badMode.status, 2);
  assert.ok(badMode.errors.some((e) => /git\.deliveryMode/.test(e) && /enum/.test(e)), JSON.stringify(badMode.errors));

  const badTtl = checkGit('git-bad-ttl', 'ge', ['git:', '  snapshotTtlDays: 999']);
  assert.equal(badTtl.status, 2);
  assert.ok(badTtl.errors.some((e) => /git\.snapshotTtlDays/.test(e)), JSON.stringify(badTtl.errors));

  const extra = checkGit('git-extra-key', 'gf', ['git:', '  autoPush: true']);
  assert.equal(extra.status, 2);
  assert.ok(extra.errors.some((e) => /git\.autoPush/.test(e) && /additional property/.test(e)), JSON.stringify(extra.errors));
});

// ---- 退役键点名（F-6 的继承者 = F-12）--------------------------------------
// 旧 F-6 查的是“禁写清单盖没盖住 prod/uat”。数据库通道收口为无条件只读之后，判据不再看库名，
// 那份清单也就没有读者了 —— 于是本节的职责从「查覆盖度」变成「让这些字符串从盘上消失」：
// schema 的 additionalProperties:false 会拒这两个键，但它只会说 unknown field，说不出该删谁、
// 改成什么，所以还要一条带迁移指引的检查。两道判据都得在，删掉任一道都会留一个静默口子。
function checkRaw(name, code, text) {
  const pr = mkPrivate(name, { [`${code}.yaml`]: text });
  const r = run(['--json'], pr);
  let j = { results: [] };
  try { j = JSON.parse(r.out); } catch { /* 非 0 时 stdout 可能为空 */ }
  const one = j.results?.[0] ?? {};
  return { status: r.status, errors: one.errors ?? [], warnings: one.warnings ?? [], err: r.err };
}

// 拼装用的固定行（projYaml 用 '\n' 拼接，这里逐行删除比正则可靠）
const DB_LINES = ['db:', '  host: localhost', '  port: 5432',
  '  schemas: { prod: p, uat: u, test: t }', '  readonlyUser: ro'];
const DRV_LINES = ['drivers:', '  database: { impl: noop.py, healthCheck: noop.py }'];
const without = (text, lines) => text.split('\n').filter(l => !lines.includes(l)).join('\n');

test('退役键残留在盘上 → 2：schema 说不出的「该删谁、改成什么」由迁移说明补上', () => {
  const stale = projYaml('gw').replace('  readonlyUser: ro',
    '  readonlyUser: ro\n  writableUser: rw\n  forbidWriteSchemas: [p, u]');
  const r = checkRaw('retired-db', 'gw', stale);
  assert.equal(r.status, 2);
  for (const k of ['writableUser', 'forbidWriteSchemas']) {
    const hit = r.errors.filter((e) => e.includes(`db.${k}`));
    assert.ok(hit.length, `${k} 要被逐项点名：${JSON.stringify(r.errors)}`);
    assert.ok(hit.some((e) => /SQL 工件/.test(e)), `${k} 的报错要给出路：${JSON.stringify(hit)}`);
  }
  assert.ok(r.errors.some((e) => /additional property not allowed/.test(e)),
    'schema 侧同一份盘也得红（两道判据只留一道 = 另一半会静默）：' + JSON.stringify(r.errors));
});

test('动作词表里的 sql_write 已退役 → 2：改数据不再是驱动能执行的动作', () => {
  const r = checkDrivers('retired-sql-write', 'gx', [
    '  database: { impl: noop.py, healthCheck: noop.py, role: database }',
    '  crm:',
    '    desc: 客户主数据',
    '    impl: c.py',
    '    healthCheck: c.py',
    '    writes:',
    '      - action: sql_write',
    '        gate: confirm',
  ]);
  assert.equal(r.status, 2);
  assert.ok(r.errors.some((e) => /sql_write/.test(e) && /退役/.test(e)), JSON.stringify(r.errors));
});

test('数据库通道（role: database）上出现 writes 段 → 2：该段在这条通道上没有合法内容', () => {
  const r = checkDrivers('db-channel-writes', 'gy', [
    '  database:',
    '    desc: 业务主库',
    '    impl: noop.py',
    '    healthCheck: noop.py',
    '    role: database',
    '    writes:',
    '      - action: status_change',
    '        gate: deny',
  ]);
  assert.equal(r.status, 2, '一份 gate: deny 的声明看着像有门禁，其实拦它的是守卫本身');
  assert.ok(r.errors.some((e) => /无条件只读/.test(e)), JSON.stringify(r.errors));
});

test('非库槽位的 writes 声明照旧合法：收口只拿走数据库通道的写能力', () => {
  const r = checkDrivers('non-db-writes', 'gz', [
    '  database: { impl: noop.py, healthCheck: noop.py, role: database }',
    '  im:',
    '    desc: 内部 IM，发通知消息',
    '    impl: i.py',
    '    healthCheck: i.py',
    '    writes:',
    '      - action: message_send',
    '        gate: confirm',
  ]);
  assert.equal(r.status, 0, JSON.stringify(r.errors));
});

// ---- 纯代码模式与模板假值残留（F-7）-------------------------------------------
// 接不接外部数据源是用户的选择。一旦 schema 把 db/drivers 写成 required，
// “不接”就只能落成 example_* 假值：结构合法、写保护一条不命中、三份机制全都看不出它没被配好。

test('不写 db / drivers 两段的项目通过校验：外部源是用户选择，不是注册硬前置', () => {
  const r = checkRaw('code-only', 'pa', without(projYaml('pa'), [...DB_LINES, ...DRV_LINES]));
  assert.equal(r.status, 0, JSON.stringify(r.errors));
  assert.ok(!r.errors.some((e) => /db|drivers/.test(e)), '纯代码模式不得被报任何错：' + JSON.stringify(r.errors));
});

test('“不接”但假值还在盘上 → 2：残留的 example_* 会骗过写保护与连通门禁', () => {
  const stale = projYaml('pb')
    .replace('  host: localhost', '  host: db.example.internal')
    .replace('  schemas: { prod: p, uat: u, test: t }', '  schemas: { prod: example_prod, uat: example_uat, test: example_test }')
    .replace('  database: { impl: noop.py, healthCheck: noop.py }',
      '  database: { impl: "C:/priv/drivers/db-example.py", healthCheck: "C:/priv/drivers/db-example.py --health" }');
  const r = checkRaw('residue', 'pb', stale);
  assert.equal(r.status, 2, '整段仍是模板值：残留规则必须独立拦住（旧形态在这里靠清单覆盖度判）');
  assert.ok(r.errors.some((e) => /db\.host/.test(e) && /模板假值/.test(e)), JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => /db\.schemas\.prod/.test(e)), '逐个字段点名，不能只报一句“有残留”');
  assert.ok(r.errors.some((e) => /drivers\.database\.impl/.test(e)), JSON.stringify(r.errors));

  // codeRoot/packageRoot 里的 example 路径不在扫描面：它们只会“匹配不上”，不会伪装成真凭据
  const clean = checkRaw('residue-ok', 'pc', projYaml('pc'));
  assert.equal(clean.status, 0, JSON.stringify(clean.errors));
});

test('驱动与 db 段必须彼此成立：有驱动没库 = 错，有库没驱动 = 警告', () => {
  const driverOnly = checkRaw('driver-no-db', 'pd', without(projYaml('pd'), DB_LINES));
  assert.equal(driverOnly.status, 2);
  assert.ok(driverOnly.errors.some((e) => /没有 db 段/.test(e) && /role: database/.test(e)),
    '库通道没有 host/port/账号可连 = 这条 SQL 通道是空的：' + JSON.stringify(driverOnly.errors));

  const dbOnly = checkRaw('db-no-driver', 'pe', without(projYaml('pe'), DRV_LINES));
  assert.equal(dbOnly.status, 0, JSON.stringify(dbOnly.errors));
  assert.ok(dbOnly.warnings.some((w) => /drivers\.database|没有通道|没有任何通道/.test(w)),
    '库信息是事实、只是暂时无通道：要警告但不能阻断注册：' + JSON.stringify(dbOnly.warnings));
});
