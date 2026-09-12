// tests/init-scan-modules.test.mjs
// 锁死 /supperH-init 扫描侧的三件事（都是实测踩出来的）：
//   ① 工具目录不得变成"模块"：.worktrees / out / node_modules / target 里也有 src/main/java，
//      旧实现把目录名交给 slug()（前导点被吃掉），于是 .worktrees 成了"模块 worktrees"，
//      而它是同一份代码的第二副本 —— 混进学习记录的 sources 后 G4b 的 diff 交集就没有意义了。
//   ② 多模块仓的 entryPattern 必须带模块目录前缀：pattern 在 effectiveRoot(=codeRoot) 下求值，
//      写成 codeRoot 相对的 `src/main/java/**` 对 demo-base/demo-biz 这种布局永远匹配不到 Controller
//      → 学习数据永远空 → G0 永远出局，快路径一行都测不到。
//   ③ “用户改则以用户为准”必须真能落地，且写 branches 不得串台到 db.schemas（两处都有 prod/uat/test）。
//   ④ 接了库就必须把禁写清单跟着 db.schemas 的实际值重建（F-7）：模板已不再携带 example_* 假值，
//      接 = 渲染器按用户给的真值生成整段；不接 = 整段不写。留着 example_* 就是“门禁存在但一条不命中”，
//      driver 的 ReadOnlyGuard 与 bug-dev 的 DB 门禁形同虚设。
//   ⑤ “不接外部源”是合法答案而不是错误：漏答字段不得回落成任何假值，也不得静默写出半截 db 段。
//   ⑥ 同样适用于 branches（F-8）：未检出的分支名不写（盘上缺席 = “未登记”），
//      而不是沿用模板里的 release-main / staging / develop —— 那会被 --env 诊断基线当现场读出去。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import {
  scanProject, applyStructuralOverrides, entryPatternOf, renderConfig, planConnections,
  applyBranchSection, branchMappingOf,
} from '../scripts/init-project.mjs';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE   = path.join(TOOL_ROOT, 'schemas', 'project.example.yaml');

// 只有“值文本”才是会被当真东西读的部分：模板注释里故意写着 example_*（说明旧形态为何错），
// 拿原始全文断言“没有假值”会把这段说明书本身判成违规。
const valueText = (t) => t.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
const render = (repo, values) => {
  const plan = applyStructuralOverrides(scanProject(repo), values);
  const text = renderConfig(fs.readFileSync(EXAMPLE, 'utf8'), plan, values);
  return { doc: YAML.parse(text), text };
};

function tmpRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function w(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}
function java(...relUnderJavaRoot) {
  return relUnderJavaRoot.join(path.sep) + '.java';
}

// ---- 多模块 maven 仓 + 四种"看着像源码目录"的噪音 ----
function buildMultiModule(t) {
  const repo = tmpRepo(t);
  w(path.join(repo, 'pom.xml'), [
    '<project>', '  <artifactId>demo</artifactId>', '  <packaging>pom</packaging>', '  <modules>',
    '    <module>demo-base</module>', '    <module>demo-biz</module>', '    <module>demo-dep</module>',
    '  </modules>', '</project>', '',
  ].join('\n'));
  w(path.join(repo, 'demo-base', 'pom.xml'), '<project><artifactId>demo-base</artifactId></project>\n');
  w(path.join(repo, 'demo-biz', 'pom.xml'), '<project><artifactId>demo-biz</artifactId></project>\n');
  w(path.join(repo, 'demo-dep', 'pom.xml'), '<project><artifactId>demo-dep</artifactId></project>\n');
  w(path.join(repo, java('demo-base', 'src', 'main', 'java', 'com', 'a', 'order', 'controller', 'OrderController')),
    'package com.a.order.controller;\n');
  w(path.join(repo, java('demo-biz', 'src', 'main', 'java', 'com', 'a', 'pay', 'controller', 'PayController')),
    'package com.a.pay.controller;\n');
  // 噪音：每个都含 src/main/java/**/controller，旧实现会把它们全部登记成模块
  for (const junk of ['.worktrees', 'out', 'node_modules', 'target']) {
    w(path.join(repo, java(junk, 'copy', 'src', 'main', 'java', 'com', 'a', 'order', 'controller', 'Junk')),
      'package com.a.order.controller;\n');
  }
  return repo;
}

test('工具目录不再被当模块，模块清单等于 pom 声明', (t) => {
  const plan = scanProject(buildMultiModule(t));
  assert.deepEqual(plan.modules, ['demo-base', 'demo-biz', 'demo-dep']);
  assert.equal(plan.modulesDetected, true);
  for (const junk of ['worktrees', 'opencode', 'out', 'node_modules', 'target', 'copy'])
    assert.ok(!plan.modules.includes(junk), `${junk} 不得成为模块`);
});

test('entryPattern 带模块目录前缀，没看到 controller 包的模块给超集而不是空匹配', (t) => {
  const plan = scanProject(buildMultiModule(t));
  const byName = Object.fromEntries(plan.modulePlans.map(m => [m.name, m]));
  assert.equal(byName['demo-base'].dir, 'demo-base');
  assert.equal(byName['demo-base'].controllersSeen, true);
  assert.equal(byName['demo-base'].entryPattern, 'demo-base/src/main/java/**/controller/*.java');
  assert.equal(byName['demo-biz'].entryPattern, 'demo-biz/src/main/java/**/controller/*.java');
  // demo-dep 只有 pom（依赖聚合模块，无源码）：给 **/*.java 超集，绝不给"匹配不到任何东西"的形状
  assert.equal(byName['demo-dep'].controllersSeen, false);
  assert.equal(byName['demo-dep'].entryPattern, 'demo-dep/src/main/java/**/*.java');
  // 每个 pattern 都相对 effectiveRoot 求值，所以必须各自带前缀
  assert.ok(plan.modulePlans.every(m => m.entryPattern.startsWith('demo-')),
    '多模块仓不允许出现 codeRoot 相对的通用 pattern');
});

test('单模块仓（java 源码直接挂在 codeRoot 下）仍是 codeRoot 相对 pattern', (t) => {
  const repo = tmpRepo(t);
  w(path.join(repo, java('src', 'main', 'java', 'com', 'a', 'order', 'controller', 'OrderController')),
    'package com.a.order.controller;\n');
  const plan = scanProject(repo);
  assert.equal(plan.modulesDetected, true);
  assert.deepEqual(plan.modulePlans.map(m => m.name), ['app']);
  assert.equal(plan.modulePlans[0].dir, null);
  assert.equal(plan.modulePlans[0].entryPattern, 'src/main/java/**/controller/*.java');
});

test('packageRoot：探不到就只列候选，写的值仍是显然假的 com.example.app', (t) => {
  const plan = scanProject(buildMultiModule(t));
  assert.equal(plan.packageRootDetected, false);
  assert.equal(plan.packageRoot, 'com.example.app');
  // 两个模块各自探到包链 → 交集可用（com.a），partial=false
  assert.deepEqual(plan.packageRootCandidates.map(c => c.module), ['demo-base', 'demo-biz']);
  assert.equal(plan.packageRootCommon, 'com.a');
  assert.equal(plan.packageRootPartial, false);
});

test('多顶层包并存（com/org 同层）时交集不可信 → common=null，交回人回答', (t) => {
  const repo = buildMultiModule(t);
  w(path.join(repo, 'demo-biz', 'src', 'main', 'java', 'org', 'b', 'Bean.java'), '');
  const plan = scanProject(repo);
  assert.equal(plan.packageRootPartial, true, '有模块第一层就分叉 → 部分覆盖');
  assert.equal(plan.packageRootCommon, null, '部分覆盖的交集不得当 packageRoot 结论');
});

test('没有任何模块拥有 src/main/java 时不谎报 partial', (t) => {
  const repo = tmpRepo(t);
  w(path.join(repo, 'pom.xml'), '<project><artifactId>empty</artifactId></project>\n');
  const plan = scanProject(repo);
  assert.deepEqual(plan.modules, ['app']);
  assert.equal(plan.modulesDetected, false);
  assert.equal(plan.packageRootPartial, false);
  assert.equal(plan.packageRootCommon, null);
});

test('分支名没探测到时如实上报 needsUserInput，且不发明任何名字（F-8）', (t) => {
  const plan = scanProject(buildMultiModule(t));   // 临时目录不是 git 仓 → 探测必然为空
  assert.deepEqual(plan.branchesDetected, { prod: false, uat: false, dev: false });
  assert.deepEqual(plan.branchesNeedsUserInput, ['prod', 'uat', 'dev']);
  assert.deepEqual(plan.branches, { prod: null, uat: null, dev: null },
    '未检出时不得返回任何可被当事实用的字符串（旧形态在这里放 release-main / staging / develop）');
});

test('entryPatternOf：dir 与 controllersSeen 的四种组合', () => {
  assert.equal(entryPatternOf({ dir: 'm', controllersSeen: true }), 'm/src/main/java/**/controller/*.java');
  assert.equal(entryPatternOf({ dir: 'm', controllersSeen: false }), 'm/src/main/java/**/*.java');
  assert.equal(entryPatternOf({ dir: null, controllersSeen: true }), 'src/main/java/**/controller/*.java');
  assert.equal(entryPatternOf({ dir: 'a/b', controllersSeen: false }), 'a/b/src/main/java/**/*.java');
});

test('--values 能覆盖结构字段：删掉的假模块不会又回来', () => {
  const base = {
    code: 'demo', codeRoot: 'C:/ws/demo', packageRoot: 'com.example.app', packageRootDetected: false,
    modules: ['demo-base', 'demo-biz', 'worktrees'],
    modulePlans: [
      { name: 'demo-base', dir: 'demo-base', controllersSeen: true, entryPattern: 'demo-base/src/main/java/**/controller/*.java' },
      { name: 'demo-biz', dir: 'demo-biz', controllersSeen: true, entryPattern: 'demo-biz/src/main/java/**/controller/*.java' },
      { name: 'worktrees', dir: 'worktrees', controllersSeen: true, entryPattern: 'worktrees/src/main/java/**/controller/*.java' },
    ],
    branches: { prod: null, uat: null, dev: null },
    branchesDetected: { prod: false, uat: false, dev: false },
  };
  const p = applyStructuralOverrides(base, {
    code: 'Demo Real', modules: 'demo-base, demo-biz', packageRoot: 'com.example.legacy',
    'branches.dev': 'dev',
  });
  assert.equal(p.code, 'demo-real', 'code 会被 slug 成文件名安全形态（它同时是目录名）');
  assert.deepEqual(p.modules, ['demo-base', 'demo-biz']);
  assert.deepEqual(p.modulePlans.map(m => m.entryPattern), [
    'demo-base/src/main/java/**/controller/*.java',
    'demo-biz/src/main/java/**/controller/*.java',
  ], '保留各自扫描得到的 pattern，不按名字重猜');
  assert.equal(p.packageRoot, 'com.example.legacy');
  assert.equal(p.packageRootDetected, true, '用户给的就不是默认值了');
  assert.equal(p.branches.dev, 'dev');
  assert.equal(p.branchesDetected.dev, true, '用户提供的分支不算"猜的"');
  assert.equal(p.branchesDetected.prod, false, '未被覆盖的仍标未检出');
  // 原对象不得被改坏（调用方可能还要复用 plan）
  assert.equal(base.packageRoot, 'com.example.app');
  assert.equal(base.branches.dev, null, '用户答案不得回灌到原 plan 的未检出键上（浅拷贝不够，branches 要单独拷）');
});

test('落盘的 yaml：模块 pattern 各自带前缀，写 branches 不串台到 db.schemas', (t) => {
  const repo = buildMultiModule(t);
  const values = {
    packageRoot: 'com.a', modules: ['demo-base', 'demo-biz'],
    'branches.prod': 'release/2.0', 'branches.uat': 'staging-2',
    'db.host': 'db.internal', 'db.port': '5432',
    'db.schemas.prod': 'demo_prod', 'db.schemas.uat': 'demo_uat', 'db.schemas.test': 'demo_test',
    'db.readonlyUser': 'ro_user', 'db.writableUser': 'rw_user',
  };
  const plan = applyStructuralOverrides(scanProject(repo), values);
  const text = renderConfig(fs.readFileSync(EXAMPLE, 'utf8'), plan, values);
  const doc = YAML.parse(text);
  assert.deepEqual(doc.modules.map(m => m.name), ['demo-base', 'demo-biz']);
  assert.deepEqual(doc.modules.map(m => m.entryPattern), [
    'demo-base/src/main/java/**/controller/*.java',
    'demo-biz/src/main/java/**/controller/*.java',
  ]);
  assert.ok(!/name: (inventory|pay|worktrees|out)\b/.test(text), '模板里的示例模块必须被整段替换掉');
  assert.equal(doc.packageRoot, 'com.a');
  assert.equal(doc.identity.code, 'demo');
  assert.deepEqual(doc.branches, { prod: 'release/2.0', uat: 'staging-2' },
    '未检出又未答的 dev 不得留在盘上（旧形态会沿用模板里的 develop，长得象事实）');
  assert.ok(!/^  dev:/m.test(valueText(text)), 'branches 块里不得残留模板的 dev 行');
  assert.equal(doc.db.schemas.prod, 'demo_prod', 'db.schemas.prod 不得被分支写入覆盖（同名键）');
  assert.equal(doc.db.schemas.uat, 'demo_uat');
  // 写保护清单必须跟着实际库名走：假值会造出“门禁存在但一条不命中”的假绿灯
  assert.deepEqual(doc.db.forbidWriteSchemas, ['demo_prod', 'demo_uat']);
  assert.ok(!/example_(prod|uat|readonly)/.test(valueText(text)), '模板假库名不得出现在落盘的值里');
  assert.equal(doc.codeRoot.replace(/\\/g, '/').toLowerCase(), repo.replace(/\\/g, '/').toLowerCase());
  assert.equal(doc.identity.workspaces.length, 1);
  assert.equal(doc.identity.workspaces[0].replace(/\\/g, '/').toLowerCase(),
    repo.replace(/\\/g, '/').toLowerCase(), 'workspaces 必须绑定 codeRoot，否则解析器永远命中不了');
});

// ---------- F-7：接不接外部源是用户的选择 ----------
// 旧行为：“不接”这个答案只能落成模板假值，而结构合法、validate 退 0、连通门禁因“0 个已配置驱动”自动放行。
// 新行为：不接 = 两段整体不写（纯代码模式）；接 = 按真值生成整段；接一半 = 写盘前退 2。

const FULL_DB = {
  'db.host': 'db.internal', 'db.port': '5432',
  'db.schemas.prod': 'demo_prod', 'db.schemas.uat': 'demo_uat', 'db.schemas.test': 'demo_test',
  'db.readonlyUser': "ro'u", 'db.writableUser': 'rw_user',
};

test('不接任何外部源：db / drivers 两段整体从落盘文本里消失（纯代码模式）', (t) => {
  const repo = buildMultiModule(t);
  const { doc, text } = render(repo, { packageRoot: 'com.a', modules: ['demo-base', 'demo-biz'] });
  assert.equal(doc.db, undefined, '不能写一个空 db: 段：空字符串与“没接”是两件事');
  assert.equal(doc.drivers, undefined);
  assert.ok(!/^db:/m.test(valueText(text)), '顶格 db: 键不得存在于值文本里（否则下游会以为接了库）');
  assert.ok(!/^drivers:/m.test(valueText(text)));
  assert.ok(!/example_|\{\{DRIVERS_ROOT\}\}/.test(valueText(text)), '整段删除后不得留下任何假值');
  // 不接不能伤到其它段：结构仍然完整可解析，模块照写
  assert.equal(doc.branches, undefined,
    'F-8：模板不再携带分支值，所以未检出又未答 = 整段不写（旧形态会留下三个假名字）');
  assert.ok(!/^branches:/m.test(valueText(text)), '值文本里不得有顶格 branches: 键');
  assert.deepEqual(doc.modules.map(m => m.name), ['demo-base', 'demo-biz']);
  const conn = planConnections({ packageRoot: 'com.a' });
  assert.deepEqual({ connect: conn.connect, dbConfigured: conn.dbConfigured, ok: conn.ok },
    { connect: [], dbConfigured: false, ok: true }, '一个都不选是合法答案，不得退 2');
});

test('接了库与日志驱动：整段按真值生成，反斜杠路径与带单引号的账号不被写坏', (t) => {
  const repo = buildMultiModule(t);
  const values = {
    packageRoot: 'com.a', modules: ['demo-base', 'demo-biz'], connect: ['database', 'logs'],
    ...FULL_DB,
    'drivers.database.impl': 'C:\\work\\supper-Han-private\\drivers\\demo\\db.py',
    'drivers.database.healthCheck': 'C:\\work\\supper-Han-private\\drivers\\demo\\db.py --health',
    'drivers.logs.impl': '{{DRIVERS_ROOT}}/demo/logs.py',
    'drivers.logs.healthCheck': '{{DRIVERS_ROOT}}/demo/logs.py --health',
    'drivers.logs.config': { indexPattern: 'demo-logs-*' },
  };
  const { doc } = render(repo, values);
  assert.equal(doc.db.host, 'db.internal');
  assert.equal(doc.db.port, 5432);
  assert.deepEqual(doc.db.schemas, { prod: 'demo_prod', uat: 'demo_uat', test: 'demo_test' });
  assert.equal(doc.db.readonlyUser, "ro'u", "单引号账号必须原样回读（写进去的是 '' 转义）");
  assert.deepEqual(doc.db.forbidWriteSchemas, ['demo_prod', 'demo_uat'], '禁写清单跟着真库名重建');
  assert.deepEqual(Object.keys(doc.drivers), ['database', 'logs'], '没选的槽位不得被凭空造出来');
  assert.equal(doc.drivers.database.impl,
    'C:\\work\\supper-Han-private\\drivers\\demo\\db.py', 'Windows 反斜杠路径不得被双引号转义吞掉');
  assert.equal(doc.drivers.logs.config.indexPattern, 'demo-logs-*');
});

test('接一半 = 意图不明，写盘前就退 2：不补默认值也不留假值', () => {
  const partial = planConnections({ 'db.host': 'db.internal' });
  assert.equal(partial.ok, false);
  assert.equal(partial.dbConfigured, true, '给了任意 db.* 值 = 隐式声明要接库');
  assert.deepEqual(partial.dbMissing,
    ['db.port', 'db.schemas.prod', 'db.schemas.uat', 'db.schemas.test', 'db.readonlyUser', 'db.writableUser'],
    '缺项得逐项点名递给调用方，不能只说“不完整”');

  const bogus = planConnections({ connect: ['database', 'crm'] });
  assert.equal(bogus.ok, false);
  assert.deepEqual(bogus.unknown, ['crm'], '只有四个槽位可选，写错名字不得被沉默忽略');

  const noProbe = planConnections({
    ...FULL_DB, connect: ['database', 'logs'], 'drivers.logs.impl': '{{DRIVERS_ROOT}}/demo/logs.py',
  });
  assert.equal(noProbe.ok, false);
  assert.deepEqual(noProbe.driverMissing, { logs: ['healthCheck'] },
    '没驱动 = 这个源不存在；healthCheck 是它唯一的连通性证据');
});

// ---------- 真实 CLI 端到端（走 initWrite 整条路，不只是渲染层） ----------
// 上面几条只测 renderConfig / planConnections：上一轮这里把 cfgText 误写成 const，
// decideChannels 回写 kind 时抛 TypeError，`--write` 每次退 1，而单测全绿。
// 凡是“落盘”的东西必须有人真跑一次命令行，否则等于没测。
function tmpPrivateRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-priv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  return dir;
}
function runInit(privateRoot, repo, values) {
  const vf = path.join(privateRoot, `values-${values.code}.json`);
  fs.writeFileSync(vf, JSON.stringify(values), 'utf8');
  const r = spawnSync(process.execPath,
    [path.join(TOOL_ROOT, 'scripts', 'init-project.mjs'), '--write', '--cwd', repo, '--values', vf],
    { encoding: 'utf8', env: { ...process.env, SUPPERH_PRIVATE_ROOT: privateRoot } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 让断言去报 stderr */ }
  return { status: r.status, json, stderr: r.stderr };
}
const MENU_CODE = {
  'menu.source': 'code', 'menu.code.path': 'menu.json', 'menu.code.format': 'json',
};

test('CLI 不接外部源：退 0 且落盘文件里没有 db / drivers 两段', (t) => {
  const repo = buildMultiModule(t);
  const priv = tmpPrivateRoot(t);
  const r = runInit(priv, repo, { code: 'cli-a', packageRoot: 'com.a', ...MENU_CODE });
  assert.equal(r.status, 0, `init --write 必须成功，实退 ${r.status}：${r.stderr.slice(0, 400)}`);
  assert.equal(r.json.connections.mode, 'code-only', '接入决定要能原样回报给用户，不是沉默退 0');
  // F-8：一个分支都没检出也没人答 → 整段不写，但这件事必须被说出来（不是静默缺席）
  assert.deepEqual(r.json.branches.undeclared, ['prod', 'uat', 'dev']);
  assert.equal(r.json.branches.declared.length, 0);
  assert.match(r.json.branches.note, /未登记任何分支映射/);
  const text = fs.readFileSync(path.join(priv, 'projects', 'cli-a.yaml'), 'utf8');
  assert.ok(!/^db:/m.test(valueText(text)), '值文本里不得有顶格 db: 键');
  assert.ok(!/^drivers:/m.test(valueText(text)));
  assert.ok(!/example_|\{\{DRIVERS_ROOT\}\}/.test(valueText(text)));
  const v = spawnSync(process.execPath,
    [path.join(TOOL_ROOT, 'scripts', 'validate-project.mjs'), '--project', 'cli-a'],
    { encoding: 'utf8', env: { ...process.env, SUPPERH_PRIVATE_ROOT: priv } });
  assert.equal(v.status, 0, `纯代码模式（无 db / 无 branches 段）必须能通过 validate：${v.stdout}${v.stderr}`);
});

test('CLI 接一半：写盘前退 2，缺项逐项点名，且 projects/<code>.yaml 不存在', (t) => {
  const repo = buildMultiModule(t);
  const priv = tmpPrivateRoot(t);
  const r = runInit(priv, repo, { code: 'cli-b', packageRoot: 'com.a', 'db.host': 'db.internal', ...MENU_CODE });
  assert.equal(r.status, 2);
  assert.equal(r.json.error, 'connection-choices-incomplete');
  const problems = JSON.stringify(r.json.problems || []);
  for (const k of ['db.port', 'db.schemas.prod', 'db.schemas.test', 'db.readonlyUser'])
    assert.ok(problems.includes(k), `problems 得点名 ${k}，不能只说“不完整”`);
  assert.ok(!fs.existsSync(path.join(priv, 'projects', 'cli-b.yaml')), '拦截必须发生在写盘之前');
});

// ---------- F-8：branches 段整段重建，而不是逐行改写 ----------
// 旧 setBranch 只能改写已存在的键：没检出的键就沿用模板值，于是“没问到”在盘上
// 长得和“这个项目确实有这个分支”一模一样，而 --env 会把那个字符串当现场读出去。
const TPL_BRANCHES = [
  'schemaVersion: 1', 'build:', '  tool: maven', '',
  'branches:', '  prod: release-main', '  uat: staging', '  dev: develop', '',
  'naming:', '  commandPrefix: /supperH', '',
].join('\n');
const planB = (b, d) => ({ branches: b, branchesDetected: d });

test('applyBranchSection：只留检出/确认过的键，全未检出则整段删除', () => {
  const only = applyBranchSection(TPL_BRANCHES,
    planB({ prod: 'release/2.0', uat: null, dev: null }, { prod: true, uat: false, dev: false }));
  assert.deepEqual(YAML.parse(only).branches, { prod: 'release/2.0' }, '模板的 uat/dev 两行必须被重建掉');
  assert.ok(/^naming:/m.test(only), '重建不得吃掉下一段');

  const none = applyBranchSection(TPL_BRANCHES, planB({ prod: null, uat: null, dev: null }, { prod: false, uat: false, dev: false }));
  assert.equal(YAML.parse(none).branches, undefined);
  assert.ok(!/^branches:/m.test(none), '整段删除后不得留顶格 branches: 键');

  // 真检出过就写，不因名字看着像模板值而丢弃（很多仓的 dev 分支就叫 develop）
  const weird = applyBranchSection(TPL_BRANCHES,
    planB({ prod: 'develop', uat: null, dev: null }, { prod: true, uat: false, dev: false }));
  assert.deepEqual(YAML.parse(weird).branches, { prod: 'develop' });
});

test('applyBranchSection：值里带 # / 空格时不被 YAML 误读；检出了却没值也不写', () => {
  const t = applyBranchSection(TPL_BRANCHES,
    planB({ prod: 'release # 2 wip', uat: '  ', dev: null }, { prod: true, uat: true, dev: false }));
  assert.deepEqual(YAML.parse(t).branches, { prod: 'release # 2 wip' },
    '空白值等于没给出：不得写一个引号包着的空格串当分支名');
});

test('branchMappingOf：declared / undeclared / note 三态都递得出文本', () => {
  const full = branchMappingOf(planB({ prod: 'main', uat: null, dev: 'dev' }, { prod: true, uat: false, dev: true }));
  assert.deepEqual(full.declared, ['prod=main', 'dev=dev']);
  assert.deepEqual(full.undeclared, ['uat']);
  assert.equal(full.note, null, '登记到了就不该发告警');

  const empty = branchMappingOf(planB({ prod: null, uat: null, dev: null }, { prod: false, uat: false, dev: false }));
  assert.deepEqual(empty.declared, []);
  assert.deepEqual(empty.undeclared, ['prod', 'uat', 'dev']);
  assert.match(empty.note, /未登记任何分支映射/, '一个都没登记时必须有一句可复述的读法');
});
