// tests/setup-dsh.test.mjs
// DSH 安装通道端到端 + 生成器单测 + per-IDE 适配文档门禁。
// 为什么走 CLI：与 setup-opencode.test.mjs 同理 —— 装完东西在不在、AGENTS.md 合并对不对、
// 陈旧清理守不守边界，只有真跑一遍才知道。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  dshName, splitAsset, generateAll,
  renderAgentsBlock, mergeAgentsBlock, AGENTS_BEGIN, AGENTS_END,
} from '../scripts/dsh-assets.mjs';
import { ideDocsProblems } from '../scripts/sync-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = path.join(ROOT, 'scripts', 'setup.mjs');
const MANIFEST = 'supperh-installed.json';
const read = (p) => fs.readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));

// ---------- fixture dist（真实 frontmatter，覆盖 command / agent / protocol 三种） ----------
const FIXTURE = {
  'commands/supperH-bug.md': [
    '---',
    'description: 修复 bug 的主入口，含"引号"和冒号：测试。',
    'mode: primary',
    'permission:',
    '  edit: deny',
    '  task: allow',
    '---',
    '',
    '# /supperH-bug · Bug 主入口',
    '',
    '## 角色',
    '',
    '你是主 agent。',
    '',
  ].join('\n'),
  'commands/supperH-learn.md': '---\ndescription: 学习入口。\nmode: primary\npermission:\n  edit: deny\n---\n\n# /supperH-learn · 学习入口\n\n正文。\n',
  'agents/supperH-bug-dev.md': '---\ndescription: 开发子 agent。\nmode: subagent\npermission:\n  read: allow\n  edit: allow\n  bash: allow\n  external_directory: deny\n---\n\n# supperH-bug-dev · 开发子 agent\n\n正文。\n',
  'skills/supperH-prelearn/SKILL.md': '---\nname: supperH-prelearn\ndescription: 预学习统筹。\n---\n\n# skill: supperH-prelearn · 预学习统筹\n\n正文。\n',
};

let FIXTURE_DIST = null;
function mkFixtureDist(files = FIXTURE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-dshfx-'));
  for (const rel of Object.keys(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, files[rel], 'utf8');
  }
  return dir;
}

before(() => { FIXTURE_DIST = mkFixtureDist(); });
after(() => { if (FIXTURE_DIST) fs.rmSync(FIXTURE_DIST, { recursive: true, force: true }); });

function install(dest, extraEnv = {}) {
  // 沙箱里管道 spawn 被 EPERM（命名管道边界），设 DSH_TEST_SPAWN_STDIO=inherit 时改用继承
  // （status 断言不变，setup 的输出会直接进测试进程 stdout）。正常环境保持 pipe 捕获。
  const stdio = process.env.DSH_TEST_SPAWN_STDIO === 'inherit' ? 'inherit' : 'pipe';
  const r = spawnSync(process.execPath, [
    SETUP, '--target', 'dsh', '--dest', dest,
    '--yes', '--skip-npm', '--skip-sync',
  ], {
    cwd: ROOT, encoding: 'utf8', stdio,
    env: { ...process.env, SUPPERH_DIST_DIR: FIXTURE_DIST, ...extraEnv },
  });
  r.allOutput = stdio === 'inherit' ? '(inherited)' : (r.stdout || '') + (r.stderr || '');
  return r;
}

function mkSandbox(t, prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const priv = path.join(base, 'priv');
  const dest = path.join(base, 'dsh');
  fs.mkdirSync(path.join(priv, 'projects'), { recursive: true });
  return { base, priv, dest };
}

const listFiles = (dir, rel = '') => {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const r = rel ? rel + '/' + name : name;
    if (fs.statSync(abs).isDirectory()) out.push(...listFiles(abs, r));
    else out.push(r);
  }
  return out.sort();
};

// ---------- 生成器单测 ----------

test('dshName：supperH-* → supperh-* 小写 kebab，其余大写拒绝', () => {
  assert.equal(dshName('supperH-bug-dev'), 'supperh-bug-dev');
  assert.equal(dshName('supperH-prelearn'), 'supperh-prelearn');
  assert.throws(() => dshName('supperH-Bad'));
  assert.throws(() => dshName('x'));
});

test('splitAsset：description 抽出、正文原样保留', () => {
  const { description, body } = splitAsset(FIXTURE['commands/supperH-bug.md']);
  assert.ok(description.startsWith('修复 bug 的主入口'));
  assert.ok(body.includes('# /supperH-bug')); // body 以 frontmatter 后的空行开头，与残留形态一致
  assert.ok(body.includes('你是主 agent'));
});

test('generateAll：形态正确（command/agent/protocol/rules）且正文一字不改', () => {
  const skills = generateAll({ distDir: FIXTURE_DIST, rulesDir: path.join(ROOT, '.qoder', 'rules'), toolRoot: ROOT });
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
  assert.equal(skills.length, 5); // 2 command + 1 agent + 1 protocol + 1 rules
  const bug = byName['supperh-bug'];
  assert.ok(bug.text.includes('disable-model-invocation: true'));
  assert.ok(bug.text.includes('/supperh-bug'));
  assert.ok(bug.text.includes('本机手势'));
  const dev = byName['supperh-bug-dev'];
  assert.ok(dev.text.includes('user-invocable: false'));
  assert.ok(dev.text.includes('角色「开发」'));
  assert.ok(!dev.text.includes('disable-model-invocation'));
  const pre = byName['supperh-prelearn'];
  assert.ok(pre.text.includes('user-invocable: false'));
  assert.ok(!pre.text.includes('disable-model-invocation')); // 协议不是手势命令
  const rules = byName['supperh-rules'];
  assert.ok(rules.text.includes('## 10-redlines.md'));
  assert.ok(rules.text.includes('user-invocable: false'));
  for (const s of skills) {
    assert.ok(/^supperh-[a-z0-9][a-z0-9-]*$/.test(s.name), 'kebab 名');
    assert.ok(!/\{\{[A-Za-z]/.test(s.text), '无残留占位符');
  }
  const devBody = dev.text.slice(dev.text.indexOf('# supperH-bug-dev'));
  assert.ok(devBody.includes('# supperH-bug-dev · 开发子 agent'));
  assert.ok(devBody.includes('正文。'));
});

test('renderAgentsBlock / mergeAgentsBlock：created / appended / replaced 三态', () => {
  const block = renderAgentsBlock({ toolRoot: ROOT, dshHome: '/tmp/fake-home' });
  assert.ok(block.includes(AGENTS_BEGIN) && block.includes(AGENTS_END));
  assert.ok(block.includes('/supperh-bug'));
  assert.equal(mergeAgentsBlock('', block).mode, 'created');
  assert.equal(mergeAgentsBlock('已有内容\n', block).mode, 'appended');
  assert.equal(mergeAgentsBlock(block, block).mode, 'replaced');
  const replaced = mergeAgentsBlock('头部\n' + block + '\n尾部', block).text;
  assert.equal(replaced.match(/BEGIN supperH rules/g).length, 1);
  assert.ok(replaced.includes('头部') && replaced.includes('尾部'));
});

// ---------- 安装端到端 ----------

test('首次安装：资产 + 红线全落位、AGENTS.md 建区块、清单可查', (t) => {
  const { priv, dest } = mkSandbox(t, 'supperh-dsh1-');
  const r = install(dest, { SUPPERH_PRIVATE_ROOT: priv });
  assert.equal(r.status, 0, r.allOutput);
  assert.ok(fs.existsSync(path.join(dest, 'skills', 'supperh-bug', 'SKILL.md')), '命令 skill');
  assert.ok(fs.existsSync(path.join(dest, 'skills', 'supperh-bug-dev', 'SKILL.md')), '角色 skill');
  assert.ok(fs.existsSync(path.join(dest, 'skills', 'supperh-rules', 'SKILL.md')), '红线 skill');
  const agents = read(path.join(dest, 'AGENTS.md'));
  assert.ok(agents.includes(AGENTS_BEGIN) && agents.includes(AGENTS_END));
  const manifest = readJson(path.join(dest, MANIFEST));
  assert.equal(manifest.files.length, 5);
});

test('幂等 + 陈旧清理 + 用户文件不动', (t) => {
  const { priv, dest } = mkSandbox(t, 'supperh-dsh2-');
  assert.equal(install(dest, { SUPPERH_PRIVATE_ROOT: priv }).status, 0);
  const before = read(path.join(dest, 'AGENTS.md'));
  assert.equal(before.match(/BEGIN supperH rules/g).length, 1);
  fs.writeFileSync(path.join(dest, 'skills', 'user-keep.md'), 'mine', 'utf8');
  assert.equal(install(dest, { SUPPERH_PRIVATE_ROOT: priv }).status, 0);
  const after = read(path.join(dest, 'AGENTS.md'));
  assert.equal(after.match(/BEGIN supperH rules/g).length, 1);
  assert.ok(fs.existsSync(path.join(dest, 'skills', 'user-keep.md')), '用户文件没被清');
  const fewer = mkFixtureDist(Object.fromEntries(
    Object.entries(FIXTURE).filter(([k]) => !k.includes('supperH-bug.md')),
  ));
  const r = install(dest, { SUPPERH_PRIVATE_ROOT: priv, SUPPERH_DIST_DIR: fewer });
  assert.equal(r.status, 0, r.allOutput);
  assert.ok(!fs.existsSync(path.join(dest, 'skills', 'supperh-bug')), '陈旧的 supperh-bug 被清掉');
  assert.ok(fs.existsSync(path.join(dest, 'skills', 'supperh-rules', 'SKILL.md')), '红线仍在');
});

// ---------- per-IDE 文档门禁 ----------

test('ide-docs 门禁：当前仓库干净', () => {
  assert.deepEqual(ideDocsProblems(ROOT), []);
});

test('ide-docs 门禁：白名单外 / 缺件 / 跑题 / 非适配内容都被拦', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-idedocs-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const f of ['qoder适配说明.md', 'opencode适配说明.md', 'dsh适配说明.md']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(base, f));
  }
  assert.deepEqual(ideDocsProblems(base), []);
  fs.writeFileSync(path.join(base, 'claude-code适配说明.md'), '# Claude Code 适配说明\n\n$DSH_HOME 之类。\n', 'utf8');
  assert.ok(ideDocsProblems(base).some((p) => p.kind === 'extra-ide-doc' && p.file === 'claude-code适配说明.md'));
  fs.rmSync(path.join(base, 'claude-code适配说明.md'));
  fs.rmSync(path.join(base, 'dsh适配说明.md'));
  assert.ok(ideDocsProblems(base).some((p) => p.kind === 'missing-ide-doc' && p.file === 'dsh适配说明.md'));
  fs.writeFileSync(path.join(base, 'dsh适配说明.md'), '# DSH 适配说明\n\n$DSH_HOME 配置。上一轮做过的账本见……\n', 'utf8');
  assert.ok(ideDocsProblems(base).some((p) => p.kind === 'non-config' && p.marker === '账本'));
  fs.writeFileSync(path.join(base, 'dsh适配说明.md'), '# 随便一个标题\n\n$DSH_HOME 配置。\n', 'utf8');
  assert.ok(ideDocsProblems(base).some((p) => p.kind === 'own-title'));
  fs.writeFileSync(path.join(base, 'dsh适配说明.md'), '# DSH 适配说明\n\n没有安装根字面量的纯分析。\n', 'utf8');
  assert.ok(ideDocsProblems(base).some((p) => p.kind === 'own-config'));
});
