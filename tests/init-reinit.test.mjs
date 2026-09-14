// tests/init-reinit.test.mjs
// 锁死 `init-project.mjs --reinit`（清场重配）的四件事。全部走真实命令行 + 临时私有根：
// 「落盘类行为一律要有走命令行的用例，只测渲染层等于没测」（§11 一期记录的原话）。
//   ① 计划模式真的只读：整个私有根逐文件字节比对，跑完必须一字不差。
//   ② 撤销不删任何东西：条目/页面档案/context/tasks 全部 rename 进 _retired/<戳>/<code>/，
//      且 manifest.json 里每条 from→to 都能对上真实文件 —— 回滚要能机械执行，不是靠记忆。
//   ③ 学习数据非空时 --confirm <code> 是硬门禁（退 23），而且拦下时一个文件都没动。
//      --force 不适用（它是写模式的降级旗标），所以这里没有绕过路径。
//   ④ 根路径与解析器同源：条目自定义了 contextRoot，清场必须去那个自定义位置搬，
//      而不是按默认布局猜；指到私有根外的路径一律只报告不搬。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INIT   = path.join(TOOL_ROOT, 'scripts', 'init-project.mjs');
const RESOLVE = path.join(TOOL_ROOT, 'scripts', 'resolve-project.mjs');

// v2 页面档案：--values 里是嵌套的 screen.discovery 数组（不再是 menu.* 扁平键）。
// path 指的 menu.json 是被学习项目自己的文件（真存在的旧物），不属我们的模块命名，保留。
const SCREEN_CODE = { screen: { discovery: [{ via: 'code', path: 'menu.json', format: 'json' }] } };

function w(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}
function runScript(t, script, args, privateRoot) {
  const r = spawnSync(process.execPath, [script, ...args],
    { encoding: 'utf8', env: { ...process.env, SUPPERH_PRIVATE_ROOT: privateRoot } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 让断言去报 stderr/stdout */ }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}
const runInit = (t, priv, args) => runScript(t, INIT, args, priv);
const runResolve = (t, priv, cwd) => runScript(t, RESOLVE, ['--cwd', cwd], priv);

/** 造一个最小 maven 工作区（结构字段由 --values 显式给，所以 pom 只求能被扫到）。 */
function buildRepo(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-ri-repo-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  w(path.join(repo, 'pom.xml'), '<project><artifactId>demo</artifactId></project>\n');
  w(path.join(repo, 'src', 'main', 'java', 'com', 'acme', 'order', 'controller', 'OrderController.java'),
    'package com.acme.order.controller;\n');
  return repo;
}
function tmpPrivateRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-ri-priv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  return dir;
}
/** 整棵私有根的逐文件字节快照（计划模式的"只读"判据就靠它）。 */
function snapshot(root) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out[r + '/'] = 'dir'; walk(p, r); }
      else out[r] = fs.readFileSync(p).toString('hex');
    }
  };
  walk(root, '');
  return out;
}
const registered = (t, priv, repo, code) => {
  const vf = path.join(priv, `values-${code}.json`);
  fs.writeFileSync(vf, JSON.stringify({ code, packageRoot: 'com.acme', ...SCREEN_CODE }), 'utf8');
  const r = runInit(t, priv, ['--write', '--cwd', repo, '--values', vf]);
  assert.equal(r.status, 0, `前置：注册 ${code} 必须成功，实退 ${r.status}：${r.stderr.slice(0, 400)}${r.stdout.slice(0, 400)}`);
};
const entryFile = (priv, code) => path.join(priv, 'projects', `${code}.yaml`);
const has = (json, kind) => json.items.find((it) => it.kind === kind);

// ---------- ① 计划模式只读 ----------
test('--reinit 不带 --purge：只出计划，整棵私有根一字不差', (t) => {
  const repo = buildRepo(t), priv = tmpPrivateRoot(t);
  registered(t, priv, repo, 'ri-plan');
  w(path.join(priv, 'context', 'ri-plan', 'gen-1', 'index.md'), '# 学习索引\n');

  const before = snapshot(priv);
  const r = runInit(t, priv, ['--reinit', '--cwd', repo]);
  assert.equal(r.status, 0, r.stderr.slice(0, 400));
  const j = r.json;
  assert.equal(j.mode, 'plan');
  assert.equal(j.code, 'ri-plan');
  assert.equal(j.ok, true);
  // 条目 + 页面档案 + context + tasks 四项都该被点名为"将搬走"
  for (const kind of ['entry', 'screens', 'context', 'tasks']) {
    const it = has(j, kind);
    assert.ok(it, `计划里必须列出 ${kind}：${JSON.stringify(j.items.map((x) => x.kind))}`);
    assert.equal(it.exists, true, `${kind} 应当存在于盘上`);
    assert.equal(it.willMove, true, `${kind} 应被标为将搬走（在私有根内）`);
  }
  assert.equal(has(j, 'context').files, 1, '报告必须说出这一搬带走几个学习文件');
  assert.equal(j.learningFiles, 1);
  assert.equal(j.movableCount, 4);
  assert.match(j.next, /--purge/, 'next 必须给出执行姿势');

  assert.deepEqual(snapshot(priv), before, '计划模式一个字节都不许动');
  assert.ok(!fs.existsSync(path.join(priv, '_retired')), '计划模式不得建隔离区');
});

// ---------- ② 撤销 = 搬走 + manifest 可回滚 ----------
test('--purge 撤空项目：搬走而非删除，manifest 逐条可回滚，解析器改口', (t) => {
  const repo = buildRepo(t), priv = tmpPrivateRoot(t);
  registered(t, priv, repo, 'ri-purge');
  // init 自留的 sidecar（<code>.yaml.bak）该一起走；手工命名形状（<code>.备注.bak）不走
  w(entryFile(priv, 'ri-purge') + '.bak', 'schemaVersion: 1\n');
  w(path.join(priv, 'projects', 'ri-purge.手工备注.bak'), '手工留的，内容不明\n');
  // 旧 menu 时代残留（F-15b 已整体改名、不留别名）：清场也必须一并搬走
  w(path.join(priv, 'menus', 'ri-purge.yaml'), 'schemaVersion: 1\nmenu: old\n');
  w(path.join(priv, 'menus', 'ri-purge.yaml.bak'), 'legacy sidecar\n');

  const r = runInit(t, priv, ['--reinit', '--cwd', repo, '--purge']);
  assert.equal(r.status, 0, `撤一场必须成功，实退 ${r.status}：${r.stderr.slice(0, 300)}${JSON.stringify(r.json)}`);
  const j = r.json;
  assert.equal(j.mode, 'purge');
  assert.equal(j.learningFiles, 0, '两个目录是空的，不该触发确认门');

  // 原地全没了
  for (const p of [entryFile(priv, 'ri-purge'), path.join(priv, 'screens', 'ri-purge.yaml'),
    path.join(priv, 'menus', 'ri-purge.yaml'), path.join(priv, 'menus', 'ri-purge.yaml.bak'),
    path.join(priv, 'context', 'ri-purge'), path.join(priv, 'tasks', 'ri-purge'),
    entryFile(priv, 'ri-purge') + '.bak']) {
    assert.ok(!fs.existsSync(p), `${p} 应已被搬走`);
  }
  // 但没有任何东西被删：隔离区里逐条对得上
  const moves = j.moves;
  assert.equal(moves.length, j.movableCount);
  for (const m of moves) {
    assert.ok(!fs.existsSync(m.from), `from 应已空：${m.from}`);
    assert.ok(fs.existsSync(m.to), `to 必须真实存在（不删任何东西）：${m.to}`);
    assert.ok(m.to.startsWith(path.join(priv, '_retired')), `隔离区必须在私有根内：${m.to}`);
  }
  const mf = path.join(j.quarantine, 'manifest.json');
  assert.ok(fs.existsSync(mf), '必须留 manifest');
  const man = JSON.parse(fs.readFileSync(mf, 'utf8'));
  assert.equal(man.code, 'ri-purge');
  assert.deepEqual(man.moves.map((m) => m.from).sort(), moves.map((m) => m.from).sort());
  assert.match(man.restore, /from/);

  // 手工备份原地未动，但被点名了 —— "清干净了"这句话不能盖住它
  const lookalike = path.join(priv, 'projects', 'ri-purge.手工备注.bak');
  assert.ok(fs.existsSync(lookalike), '非 init 生成的形状不许动');
  assert.ok(j.notTouched.some((n) => n.kind === 'entry-lookalike' && n.path === lookalike),
    `同前缀的手工备份必须报告出来：${JSON.stringify(j.notTouched)}`);

  // 解析器现在必须说"没注册"
  const rr = runResolve(t, priv, repo);
  assert.equal(rr.status, 10, `撤完后解析器应退 10，实退 ${rr.status}`);

  // 幂等：再撤一次是空操作，且不再产生第二个隔离区
  const again = runInit(t, priv, ['--reinit', '--cwd', repo, '--purge']);
  assert.equal(again.status, 0);
  assert.equal(again.json.noop, true, `二次清场必须是 noop：${JSON.stringify(again.json)}`);
});

// ---------- ③ 学习数据门禁 ----------
test('context/ 有学习成果：--purge 退 23 且一个文件都不动，--confirm <code> 才放行', (t) => {
  const repo = buildRepo(t), priv = tmpPrivateRoot(t);
  registered(t, priv, repo, 'ri-learn');
  const learningFile = path.join(priv, 'context', 'ri-learn', 'gen-1', 'order.md');
  w(learningFile, '# 调用链摘要\n');
  const before = snapshot(priv);

  const blocked = runInit(t, priv, ['--reinit', '--cwd', repo, '--purge']);
  assert.equal(blocked.status, 23, `学习数据非空必须退 23，实退 ${blocked.status}`);
  assert.equal(blocked.json.error, 'learning-data-present');
  assert.equal(blocked.json.needsConfirm, 'ri-learn');
  assert.equal(blocked.json.learningFiles, 1);
  assert.deepEqual(snapshot(priv), before, '退 23 时必须什么都没搬（拦下 ≠ 搬一半再后悔）');

  // --force 不适用（本模式没有这个旗标）：造出来就退 2，不降级
  const force = runInit(t, priv, ['--reinit', '--cwd', repo, '--purge', '--force']);
  assert.equal(force.status, 2, '--reinit 不接受 --force：那是写模式的降级旗标');

  // --confirm 必须是那个 code
  const wrong = runInit(t, priv, ['--reinit', '--cwd', repo, '--purge', '--confirm', 'other-code']);
  assert.equal(wrong.status, 2);
  assert.equal(wrong.json.error, 'confirm-mismatch');
  assert.ok(fs.existsSync(learningFile), '确认错了对象时不得动手');

  const ok = runInit(t, priv, ['--reinit', '--cwd', repo, '--purge', '--confirm', 'ri-learn']);
  assert.equal(ok.status, 0, `带正确 --confirm 必须放行，实退 ${ok.status}：${JSON.stringify(ok.json)}`);
  assert.equal(ok.json.learningFiles, 1);
  assert.ok(!fs.existsSync(learningFile), '确认后学习文件应已进隔离区');
  const moved = ok.json.moves.find((m) => m.kind === 'context');
  assert.ok(fs.existsSync(path.join(moved.to, 'gen-1', 'order.md')), '目录内的层级要原样保留，否则回滚无从下手');
});

// ---------- ④ 根路径与解析器同源 ----------
test('条目自定义 contextRoot：搬的是自定义位置，默认空壳也一并撤；私有根外只报告不搬', (t) => {
  const repo = buildRepo(t), priv = tmpPrivateRoot(t);
  registered(t, priv, repo, 'ri-root');
  const customCtx = path.join(priv, 'ctx-custom', 'ri-root');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-ri-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsideTasks = path.join(outside, 'tasks', 'ri-root');
  w(path.join(outsideTasks, 'task-1.md'), '# 任务产物\n');
  w(path.join(customCtx, 'placeholder.md'), '# 自定义位置的占位文件\n');
  // 直接改条目：把两个根都指到非常规位置（context 在私有根内、tasks 在私有根外）。
  // 走 YAML round-trip 而不是拼字符串：模板里本来就有 paths 段，追一个同名键会造出重复键而整个条目标废。
  const doc = YAML.parse(fs.readFileSync(entryFile(priv, 'ri-root'), 'utf8'));
  doc.paths = {
    contextRoot: '{{PRIVATE_ROOT}}/ctx-custom/{{PROJECT.identity.code}}',
    tasksRoot: outsideTasks.split(path.sep).join('/'),
  };
  fs.writeFileSync(entryFile(priv, 'ri-root'), YAML.stringify(doc), 'utf8');

  const r = runInit(t, priv, ['--reinit', '--cwd', repo]);
  assert.equal(r.status, 0, r.stderr.slice(0, 400));
  const j = r.json;
  assert.equal(has(j, 'context').path, path.normalize(customCtx),
    '必须搬条目声明的自定义目录 —— 按默认布局猜就会既漏掉真数据又可能误搬别人的');
  assert.equal(has(j, 'context').source, 'entry', '报告要能说出这个路径的出处');
  assert.ok(has(j, 'context-default'), '被空壳占着的默认布局也该列出来');
  assert.equal(has(j, 'tasks').willMove, false, '私有根外的路径不搬');
  assert.ok(j.notTouched.some((n) => n.kind === 'tasks' && n.path === path.normalize(outsideTasks)),
    `越界的 tasksRoot 必须被点名：${JSON.stringify(j.notTouched)}`);
  assert.ok(fs.existsSync(path.join(outsideTasks, 'task-1.md')), '越界目录里的文件不得被动');
});

// ---------- ⑤ 参数护栏与"本来就没注册" ----------
test('护栏：无目标 / code 与 cwd 不一致 / 孤立条目 / --confirm 单用 都退 2 或明确 noop', (t) => {
  const repo = buildRepo(t), priv = tmpPrivateRoot(t);
  registered(t, priv, repo, 'ri-guard');

  assert.equal(runInit(t, priv, ['--reinit']).status, 2, '既没 --cwd 也没 --code：不知道该撤谁就得停下');
  const mismatch = runInit(t, priv, ['--reinit', '--cwd', repo, '--code', 'not-it']);
  assert.equal(mismatch.status, 2);
  assert.equal(mismatch.json.error, 'code-mismatch', '两个入口给出不一致的答案时不得挑一个动手');
  assert.equal(runInit(t, priv, ['--reinit', '--write', '--cwd', repo]).status, 2, '清场不接受写模式的旗标');
  assert.equal(runInit(t, priv, ['--reinit', '--cwd', repo, '--confirm', 'ri-guard']).status, 2,
    '--confirm 不配 --purge 时它是空话，不能被静默吞掉');

  // 未注册的工作区：noop 而不是错误，并把"读不了的条目"分开报出来
  w(path.join(priv, 'projects', 'broken.yaml'), '{oops: \n');
  const repo2 = buildRepo(t);
  const none = runInit(t, priv, ['--reinit', '--cwd', repo2]);
  assert.equal(none.status, 0);
  assert.equal(none.json.noop, true);
  assert.ok(none.json.unparseableEntries.some((b) => b.file.endsWith('broken.yaml')),
    `解析不了的条目必须与"本来没注册"区分：${JSON.stringify(none.json.unparseableEntries)}`);

  // 按 code 撤一个不存在的短码：noop
  const ghost = runInit(t, priv, ['--reinit', '--code', 'ghost-code']);
  assert.equal(ghost.status, 0);
  assert.equal(ghost.json.noop, true);
});

// ---------- ⑥ 撤完还能重跑首次注册 ----------
test('清场后 /supperH-init 能当首次注册重跑（这是本功能存在的唯一理由）', (t) => {
  const repo = buildRepo(t), priv = tmpPrivateRoot(t);
  registered(t, priv, repo, 'ri-cycle');
  const purged = runInit(t, priv, ['--reinit', '--cwd', repo, '--purge']);
  assert.equal(purged.status, 0, JSON.stringify(purged.json));

  // 二次注册前留下的 .bak 来自上一次 --write：清场把它一起撤走，所以这次不该再有 .bak 混淆首次判定
  const again = runInit(t, priv, ['--write', '--cwd', repo, '--values', (() => {
    const vf = path.join(priv, 'values-again.json');
    fs.writeFileSync(vf, JSON.stringify({ code: 'ri-cycle', packageRoot: 'com.acme', ...SCREEN_CODE }), 'utf8');
    return vf;
  })()]);
  assert.equal(again.status, 0, `清场后必须能当首次注册重跑，实退 ${again.status}：${again.stderr.slice(0, 300)}`);
  assert.equal(again.json.existed, false, '页面档案/条目都不在盘上 → --write 报的是"首次注册"');
  assert.equal(again.json.screenWritten, true);
  const rr = runResolve(t, priv, repo);
  assert.equal(rr.status, 0, '解析器必须重新命中');
  assert.equal(rr.json.code, 'ri-cycle', '解析器命中的必须还是同一个短码（learning 目录重建后才能接着用）');
});
