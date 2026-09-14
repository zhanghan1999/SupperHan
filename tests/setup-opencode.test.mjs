// tests/setup-opencode.test.mjs
// OpenCode 安装通道端到端：跑真实 `node scripts/setup.mjs --target opencode --dest <tmp>`。
//
// 为什么必须走 CLI 而不是只测函数：
//   上一轮 `init-project.mjs` 的 const 崩溃就是因为单测只调渲染层、没人跑命令行。这里同类
//   风险一模一样 —— 装完东西在不在、配置合并对不对、私有根有没有被污染，只有真跑一遍才知道。
//
// 锁死的五件事：
//   1) 资产按单数目录名落位（agent/command/skill），mcp + instructions 合并进 opencode.json。
//   2) 红线不做拷贝件：instructions 指向工具仓 .qoder/rules/*.md，且反复安装不累积重复项。
//   3) 陈旧产物按**安装清单**清理：改名/删掉的命令不会以副本继续被加载；用户自放文件一律不动。
//   4) 用户文件优先：带注释的 .jsonc（以及带注释的 .json）一个字节都不改写，只打印待粘贴片段。
//   5) 私有根只建骨架：绝不 copyFileSync(example → project.yaml)，F-7 不在此处倒退。
import { test, before, after } from 'node:test';
import assert    from 'node:assert/strict';
import fs        from 'node:fs';
import os        from 'node:os';
import path      from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { detectIde, OPENCODE_CONFIG_FILES } from '../scripts/detect-ide.mjs';

const ROOT      = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP     = path.join(ROOT, 'scripts', 'setup.mjs');
const MANIFEST  = 'supperh-installed.json';
const MCP_ID    = 'supperh-drivers';
const RULES_GLOB = (ROOT.replace(/\\/g, '/') + '/.qoder/rules/*.md');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// 自己一份 dist 副本，不读仓库真 dist：mcp-manifest.test.mjs 会真跑 sync-assets（rmSync + 重建），
// 而 node --test 文件级并发——抢同一份目录就是偶发 ENOENT。内容只要求形状对（四个源目录）。
const FIXTURE_DIST_FILES = [
  'agents/supperH-bug-dev.md',
  'agents/supperH-prelearn-analyzer.md',
  'commands/supperH-setup.md',
  'commands/supperH-bootstrap.md',
  'commands/supperH-init.md',
  'commands/supperH-bug.md',
  'commands/supperH-learn.md',
  'skills/supperH-prelearn/SKILL.md',
  'skills/supperH-data-fetch/SKILL.md',
  'mcp-skeleton/shell.py',
  'mcp-skeleton/requirements.txt',
];
let FIXTURE_DIST = null;

before(() => {
  FIXTURE_DIST = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-fxdist-'));
  for (const rel of FIXTURE_DIST_FILES) {
    const abs = path.join(FIXTURE_DIST, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '# ' + rel + '\n', 'utf8');
  }
});
after(() => { if (FIXTURE_DIST) fs.rmSync(FIXTURE_DIST, { recursive: true, force: true }); });

/** 一次安装 = 全新私有根 + 全新 dest；返回 {priv, dest, r}。 */
function install(priv, dest, extraArgs = []) {
  const r = spawnSync(process.execPath, [
    SETUP, '--target', 'opencode', '--dest', dest,
    '--yes', '--skip-npm', '--skip-sync', ...extraArgs,
  ], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, SUPPERH_PRIVATE_ROOT: priv, SUPPERH_DIST_DIR: FIXTURE_DIST },
  });
  r.allOutput = (r.stdout || '') + (r.stderr || '');
  return r;
}

function mkSandbox(t, prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const priv = path.join(base, 'priv');
  const dest = path.join(base, 'oc');
  fs.mkdirSync(path.join(priv, 'projects'), { recursive: true });
  return { base, priv, dest };
}

// 只统计 supperH 放的资产目录，配置文件单独断言
function listFiles(dir, rel = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const r = rel ? rel + '/' + name : name;
    if (fs.statSync(abs).isDirectory()) out.push(...listFiles(abs, r));
    else out.push(r);
  }
  return out.sort();
}

const ASSET_ROOTS = ['agent', 'command', 'skill', 'mcp-skeleton'];

test('首次安装：资产落位 + mcp/instructions 合并 + 私有根不造 legacy project.yaml', (t) => {
  const { priv, dest } = mkSandbox(t, 'supperh-oc1-');
  const r = install(priv, dest);
  assert.equal(r.status, 0, r.allOutput);

  // 单数目录名（实测 1.18.21 单复数都吃，但工具仓侧映射表写死单数，这里钉住不漂移）
  for (const f of ['command/supperH-bug.md', 'command/supperH-init.md', 'agent/supperH-bug-dev.md',
    'skill/supperH-prelearn/SKILL.md', 'mcp-skeleton/shell.py']) {
    assert.ok(fs.existsSync(path.join(dest, f)), 'missing installed file: ' + f);
  }
  assert.ok(!fs.existsSync(path.join(dest, 'commands')), '不该出现复数目录 commands/');

  const conf = path.join(dest, OPENCODE_CONFIG_FILES[0]);
  const doc = readJson(conf);
  assert.equal(doc.mcp[MCP_ID].type, 'local');
  assert.ok(String(doc.mcp[MCP_ID].command[1]).endsWith(path.join('mcp-skeleton', 'shell.py')));
  assert.equal(doc.mcp[MCP_ID].environment.SUPPERH_PRIVATE_ROOT, priv, '私有根必须随安装传递');
  assert.deepEqual(doc.instructions, [RULES_GLOB], '红线走 instructions 指向工具仓，不生成拷贝件');

  // 私有根：只建骨架，绝不把 example 拷成 project.yaml（那会把 F-7 干掉假值重新造出来）
  for (const d of ['projects', 'screens', 'drivers', 'context', 'tasks']) {
    assert.ok(fs.statSync(path.join(priv, d)).isDirectory(), 'missing private root dir: ' + d);
  }
  assert.ok(!fs.existsSync(path.join(priv, 'project.yaml')), 'setup 不得在私有根造 legacy project.yaml');
  assert.match(r.allOutput, /\/supperH-init/);

  // 清单只记自己放的，且全部落在映射后的四个目标根之内
  const mf = readJson(path.join(dest, MANIFEST));
  assert.ok(mf.files.length > 0);
  for (const rel of mf.files) {
    assert.ok(ASSET_ROOTS.includes(rel.split('/')[0]), 'manifest 条目越界: ' + rel);
  }
  assert.deepEqual(mf.files, listFiles(path.join(dest, 'agent'), 'agent')
    .concat(listFiles(path.join(dest, 'command'), 'command'))
    .concat(listFiles(path.join(dest, 'skill'), 'skill'))
    .concat(listFiles(path.join(dest, 'mcp-skeleton'), 'mcp-skeleton')).sort());

  // 装完的探测：探的就是安装目录，不能拿默认 config dir 的状态冒充
  const st = detectIde({ opencodeHome: dest }).mcp.opencode;
  assert.equal(st.registered, true, st.reason);
  assert.equal(st.path, conf);
});

test('二次安装幂等：instructions 不累积，文件集合不变', (t) => {
  const { priv, dest } = mkSandbox(t, 'supperh-oc2-');
  assert.equal(install(priv, dest).status, 0);
  const beforeFiles = ASSET_ROOTS.map(d => listFiles(path.join(dest, d), d)).flat().sort();

  const r2 = install(priv, dest);
  assert.equal(r2.status, 0, r2.allOutput);
  const afterFiles = ASSET_ROOTS.map(d => listFiles(path.join(dest, d), d)).flat().sort();
  assert.deepEqual(afterFiles, beforeFiles, '第二次安装不得增减资产文件');

  const doc = readJson(path.join(dest, OPENCODE_CONFIG_FILES[0]));
  assert.deepEqual(doc.instructions, [RULES_GLOB], '重复安装必须去重');
  assert.equal(Object.keys(doc.mcp).length, 1);
});

test('陈旧产物按清单清理，用户自放文件不动，用户 instructions 保留', (t) => {
  const { priv, dest } = mkSandbox(t, 'supperh-oc3-');
  assert.equal(install(priv, dest).status, 0);

  // 模拟“上个版本装了、这个版本已改名/删掉”的命令：存在 = 会被继续加载的陈旧副本
  fs.writeFileSync(path.join(dest, 'command', 'supperH-oldname.md'), '# 陈旧产物\n', 'utf8');
  fs.mkdirSync(path.join(dest, 'skill', 'obsolete-skill'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'skill', 'obsolete-skill', 'SKILL.md'), '# 陈旧\n', 'utf8');
  const mfPath = path.join(dest, MANIFEST);
  const mf = readJson(mfPath);
  mf.files.push('command/supperH-oldname.md', 'skill/obsolete-skill/SKILL.md');
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2), 'utf8');

  // 用户自己的东西：同名目录里手放的文件 + 手写的 instructions
  fs.writeFileSync(path.join(dest, 'command', 'my-own.md'), '# 用户命令\n', 'utf8');
  const conf = path.join(dest, OPENCODE_CONFIG_FILES[0]);
  const doc = readJson(conf);
  doc.instructions.push('~/my-rules.md');
  doc.theme = 'opencode';                       // 无关键必须原样保留
  fs.writeFileSync(conf, JSON.stringify(doc, null, 2), 'utf8');

  // 越界条目：污染/手改的清单不得删到映射目录之外
  mf.files.push('../../Windows/temp/should-not-touch');
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2), 'utf8');

  const r = install(priv, dest);
  assert.equal(r.status, 0, r.allOutput);
  assert.match(r.allOutput, /清理上次安装产物/);

  assert.ok(!fs.existsSync(path.join(dest, 'command', 'supperH-oldname.md')), '陈旧命令必须被清掉');
  assert.ok(!fs.existsSync(path.join(dest, 'skill', 'obsolete-skill')), '陈旧 skill 目录（空后）应被移除');
  assert.ok(fs.existsSync(path.join(dest, 'command', 'supperH-bug.md')), '当版资产仍在');
  assert.ok(fs.existsSync(path.join(dest, 'command', 'my-own.md')), '用户自放文件绝不能在清单之外被删');
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'should-not-touch')), '越界条目不得被删（也不能被碰）');
  assert.match(r.allOutput, /越界/);

  const after = readJson(conf);
  assert.equal(after.theme, 'opencode');
  assert.deepEqual(after.instructions, ['~/my-rules.md', RULES_GLOB], '用户 instructions 保留，自己的那条替换而非追加');
});

test('.jsonc 是用户文件：注释保留，supperH 只写 .json', (t) => {
  const { priv, dest } = mkSandbox(t, 'supperh-oc4-');
  fs.mkdirSync(dest, { recursive: true });
  const jsonc = path.join(dest, OPENCODE_CONFIG_FILES[1]);
  const jsoncText = '{\n  // 我的个人配置，别抹我注释\n  "$schema": "https://opencode.ai/config.json",\n  "theme": "system"\n}\n';
  fs.writeFileSync(jsonc, jsoncText, 'utf8');

  const r = install(priv, dest);
  assert.equal(r.status, 0, r.allOutput);
  assert.equal(fs.readFileSync(jsonc, 'utf8'), jsoncText, '.jsonc 必须逐字节不变');
  assert.match(r.allOutput, /opencode\.jsonc/, '要如实告知还有另一个配置文件');

  const doc = readJson(path.join(dest, OPENCODE_CONFIG_FILES[0]));
  assert.equal(doc.mcp[MCP_ID].enabled, true);
  assert.deepEqual(doc.instructions, [RULES_GLOB]);
});

test('带注释的 .json：拒绝覆盖 + 打印待粘贴片段（不静默失效）', (t) => {
  const { priv, dest } = mkSandbox(t, 'supperh-oc5-');
  fs.mkdirSync(dest, { recursive: true });
  const conf = path.join(dest, OPENCODE_CONFIG_FILES[0]);
  const text = '{\n  // 我就想用 JSON 文件名写注释\n  "theme": "opencode"\n}\n';
  fs.writeFileSync(conf, text, 'utf8');

  const r = install(priv, dest);
  assert.equal(r.status, 0, '配置文件写不进去不该让整个安装失败');
  assert.equal(fs.readFileSync(conf, 'utf8'), text, '含注释 → 一个字节都不动');
  assert.match(r.allOutput, /不覆盖用户文件/);
  assert.match(r.allOutput, /\.qoder\/rules\/\*\.md/, '必须打印可手工粘贴的 instructions 片段');

  // 坏了的 .json（不是注释问题）同样拒绝覆盖
  fs.writeFileSync(conf, '{ this is not json at all', 'utf8');
  const r2 = install(priv, dest);
  assert.equal(r2.status, 0, r2.allOutput);
  assert.equal(fs.readFileSync(conf, 'utf8'), '{ this is not json at all');
  assert.match(r2.allOutput, /解析失败/);
});

test('探测：只有 .jsonc 里注册了 server 也算已注册（修前的假阴性）', () => {
  const t = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-oc6-')), 'cfg');
  fs.mkdirSync(t, { recursive: true });
  const jsonc = path.join(t, OPENCODE_CONFIG_FILES[1]);
  fs.writeFileSync(jsonc, '{\n  // 手写的\n  "mcp": { "' + MCP_ID + '": { "type": "local", "command": ["python", "shell.py"], "enabled": true } }\n}\n', 'utf8');
  const st = detectIde({ opencodeHome: t }).mcp.opencode;
  assert.equal(st.registered, true, st.reason);
  assert.equal(st.path, jsonc);
  fs.rmSync(path.dirname(t), { recursive: true, force: true });
});

// 安装器不依赖真 dist，但“到底有几个命令”这件事得有人钉住：setup.mjs 的 next steps 文案
// 与两份适配说明都写着同一个数，漏一个就是文案在说谎。读源目录（sync 只读不写 commands/，无竞争）。
test('命令清单与文案一致：写进 next steps 的 /supperH-* 真的都存在', () => {
  const names = fs.readdirSync(path.join(ROOT, 'commands')).filter(n => n.endsWith('.md')).sort();
  assert.deepEqual(names, [
    'supperH-bootstrap.md', 'supperH-bug.md', 'supperH-driver.md', 'supperH-init.md',
    'supperH-learn.md', 'supperH-setup.md',
  ]);
});

test('私有根已有条目时：只补齐缺失骨架目录，绝不碰条目内容', (t) => {
  const { priv, dest } = mkSandbox(t, 'supperh-oc7-');
  // mkSandbox 只建了 projects/；放一个已注册条目让 ok=true（本机真实情形：迁移脚本造的私有根缺 screens/）
  const entry = path.join(priv, 'projects', 'fx-code.yaml');
  const entryText = 'schemaVersion: 1\nidentity:\n  code: fx-code\n';
  fs.writeFileSync(entry, entryText, 'utf8');

  const r = install(priv, dest);
  assert.equal(r.status, 0, r.allOutput);
  assert.match(r.allOutput, /private root ok: .*\(1 project\(s\) registered\)/);
  for (const d of ['screens', 'drivers', 'context', 'tasks']) {
    assert.ok(fs.statSync(path.join(priv, d)).isDirectory(), '应补齐: ' + d);
  }
  assert.equal(fs.readFileSync(entry, 'utf8'), entryText, '已注册条目一个字节都不能动');
  assert.ok(!fs.existsSync(path.join(priv, 'project.yaml')), 'ok 分支也不得造 legacy 文件');
});
