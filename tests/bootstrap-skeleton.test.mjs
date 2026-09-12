// tests/bootstrap-skeleton.test.mjs
// /supperH-bootstrap 与 scripts/bootstrap.mjs 的职责边界（F-9）：
// bootstrap **只**建私有根骨架 + prefs.md，绝不生成任何项目条目。
// 旧形态从 schemas/project.example.yaml 复制一份写 <私有根>/project.yaml（legacy 单文件），
// 于是"注册项目"有两个入口：一个有扫描/门禁/菜单采集，一个什么都没有。
// 两个入口并存时用户不知道该跑哪个，跑完还多出一个待迁移文件 —— 这里锁死新边界。
// 落盘类 CLI 必须真跑命令行（只测函数等于没测），所以全部走 spawnSync。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PRIVATE_SUBS } from '../scripts/resolve-private-root.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'bootstrap.mjs');

function run(priv, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, SUPPERH_PRIVATE_ROOT: priv },
  });
  r.all = (r.stdout || '') + (r.stderr || '');
  return r;
}
function tmpPriv(t) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-boot-')), 'priv');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  return dir;
}

test('首次运行：建全套骨架 + prefs.md，不写任何 yaml', (t) => {
  const priv = tmpPriv(t);
  const first = run(priv, ['--check']);
  assert.equal(first.status, 2, '私有根不存在时 --check 必须报未就绪');

  const r = run(priv);
  assert.equal(r.status, 0, r.all);
  for (const sub of PRIVATE_SUBS) {
    assert.ok(fs.statSync(path.join(priv, sub)).isDirectory(), `缺子目录 ${sub}`);
  }
  assert.ok(fs.existsSync(path.join(priv, 'prefs.md')), 'prefs.md 是用户偏好文件，骨架就该带上');
  // 这一条是 F-9 的正身：legacy 单文件不得再被造出来
  assert.ok(!fs.existsSync(path.join(priv, 'project.yaml')), 'bootstrap 不得再写 legacy 单文件条目');
  assert.deepEqual(fs.readdirSync(path.join(priv, 'projects')), [], 'bootstrap 不得生成任何注册条目');
  assert.match(r.all, /supperH-init/);
});

test('幂等：第二次运行不报错、不覆盖已改过的 prefs.md', (t) => {
  const priv = tmpPriv(t);
  assert.equal(run(priv).status, 0);
  const prefs = path.join(priv, 'prefs.md');
  fs.writeFileSync(prefs, '# 用户自己写的偏好\n', 'utf8');

  const again = run(priv);
  assert.equal(again.status, 0, again.all);
  assert.equal(fs.readFileSync(prefs, 'utf8'), '# 用户自己写的偏好\n', 'prefs.md 是用户资产，存在就绝不覆盖');
  assert.match(again.all, /all present/, '已就绪时不该声称又建了一遍');
});

test('--dry-run：一个字节都不写', (t) => {
  const priv = tmpPriv(t);
  const r = run(priv, ['--dry-run']);
  assert.equal(r.status, 0, r.all);
  assert.ok(!fs.existsSync(priv), '--dry-run 不得创建私有根');
});

test('--force 已随 F-9 移除：报错并指回真正能覆盖条目的命令（不是静默忽略）', (t) => {
  const priv = tmpPriv(t);
  const r = run(priv, ['--force']);
  assert.equal(r.status, 2);
  assert.match(r.all, /--force 已随 F-9 移除/);
  assert.match(r.all, /init-project\.mjs --write/);
});

test('legacy project.yaml 存在：默认只报告并指路，加 --migrate 才动用户的文件', (t) => {
  const priv = tmpPriv(t);
  fs.mkdirSync(path.join(priv, 'projects'), { recursive: true });
  const legacy = [
    'schemaVersion: 1', 'identity:', '  code: legacyapp', '  displayName: "Legacy"',
    'codeRoot: "C:/tmp/legacyapp"', 'packageRoot: com.legacy',
    'modules:', "  - name: order", "    entryPattern: '**/*.java'",
    'build:', '  tool: maven', "  jdk: '1.8'", '  compileCmd: mvn compile', '  testCmd: mvn test',
    'branches: { prod: main }', 'naming:', '  commandPrefix: /supperH', '',
  ].join('\n');
  fs.writeFileSync(path.join(priv, 'project.yaml'), legacy, 'utf8');

  const report = run(priv);
  assert.equal(report.status, 0, report.all);
  assert.match(report.all, /legacy 单文件条目/);
  assert.ok(fs.existsSync(path.join(priv, 'project.yaml')), '未给 --migrate 就不得改名用户的文件');
  assert.deepEqual(fs.readdirSync(path.join(priv, 'projects')), [], '报告阶段不得顺手写注册表');

  const go = run(priv, ['--migrate']);
  assert.equal(go.status, 0, go.all);
  assert.ok(fs.existsSync(path.join(priv, 'projects', 'legacyapp.yaml')), '迁移后条目进注册表');
  assert.ok(!fs.existsSync(path.join(priv, 'project.yaml')), 'legacy 文件被让位');
  assert.ok(fs.existsSync(path.join(priv, 'project.yaml.migrated.bak')), '原文必须留备份，不能删');

  const check = run(priv, ['--check']);
  assert.equal(check.status, 0, '迁移完成后 --check 应就绪');
  assert.match(check.all, /registryCount: 1/);
});

test('骨架清单只有一处定义：bootstrap 与 setup 不会各写一份而漂移', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'setup.mjs'), 'utf8');
  assert.ok(!/const PRIVATE_SUBS\s*=/.test(src),
    'setup.mjs 不得再自带一份子目录清单（历史上漂移过一次：迁移出来的根缺 menus/）');
  assert.match(src, /ensurePrivateSkeleton/);
  assert.deepEqual(PRIVATE_SUBS, ['projects', 'menus', 'drivers', 'context', 'tasks']);
});
