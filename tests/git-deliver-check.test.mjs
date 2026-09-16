// tests/git-deliver-check.test.mjs
// 交付对账门禁（scripts/git-deliver-check.mjs）的行为锁。
//
// 为什么必须单独锁（不是给覆盖率添数，是钉四条会静默失效的判断）：
//   ① 未跟踪文件必须**逐个文件**出现在清单上 —— `git status` 默认把未跟踪目录折叠成
//      一行目录名，「新建 4 个文件」在清单上只剩 1 条，按文件粒度的比对全部漏判；
//   ② 裁决顺序必须是 虚报 → 漏报 → 待裁决 —— 顺序反了会把「agent 根本没落盘」
//      降级成「问你一句要不要提交」，那是把 bug 问成需求；
//   ③ 只读性 —— 门禁一旦能代为 `git add`，它就变成了替用户做「要不要纳入 VCS」的决定，
//      而那个决定的后果（漏提 / 误提内网文件）由人承担；
//   ④ 条文与实现必须同时被钉住 —— 本仓有过先例：文档宣称的扫描从未真正实现过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, parseStatus, toRepoRel, EXIT, SNAPSHOT_REF_PREFIX } from '../scripts/git-deliver-check.mjs';
import { listDirtyFiles } from '../scripts/git-preflight.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 真临时 git 仓（门禁的判据是 git 实况，拿 mock 测等于没测） */
function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-deliver-'));
  const g = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${(r.stderr || '').trim()}`);
    return (r.stdout || '').trim();
  };
  g(['init', '-q', '-b', 'main']);
  // email 不写带域名的形式：tests/ 在 L1 纯度扫描名单内
  g(['config', 'user.name', 'fx']);
  g(['config', 'user.email', 'fx']);
  g(['config', 'commit.gpgsign', 'false']);
  const put = (rel, text) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
  };
  return { dir, g, put };
}

/** 夹具文件一律写在被测仓**之外**：写进去它自己就成了一个未跟踪的交付文件，
 *  门禁会如实抓出来（下面「只读性」那条用例第一次跑就是这么挂的）。 */
const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-decl-'));
let seq = 0;
function declaredFile(arr) {
  const p = path.join(FIXTURES, `declared-${++seq}.json`);
  fs.writeFileSync(p, JSON.stringify(arr), 'utf8');
  return p;
}

// ── 纯函数层 ──────────────────────────────────────────────────────────────────

test('parseStatus 把 porcelain 拆成 已跟踪未暂存 / 已暂存 / 未跟踪 三类', () => {
  const st = parseStatus(' M a.java\nM  b.java\n?? c.java\nD  d.java\nR  old.java -> new.java\n');
  assert.deepEqual(st.trackedModified, ['a.java'], '第二列非空 = 工作区未暂存的改动');
  assert.deepEqual(st.staged.sort(), ['b.java', 'd.java', 'new.java'], '第一列非空 = 已进 index');
  assert.deepEqual(st.untracked, ['c.java']);
});

test('toRepoRel 把绝对 / 反斜杠 / 仓内相对路径统一成 repo-relative POSIX', () => {
  const root = path.resolve('scripts');           // 任意真实目录即可，只要与入参同源
  const abs = path.join(root, 'sub\\x.md');
  assert.equal(toRepoRel(root, abs), 'sub/x.md');
  assert.equal(toRepoRel(root, 'sub/x.md'), 'sub/x.md');
  assert.equal(toRepoRel(root, '  '), null, '空白 → null，不参与比对');
  assert.equal(toRepoRel(root, '.'), null, '仓根本身不是文件，不能进清单');
});

// ── 退出码裁决 ────────────────────────────────────────────────────────────────

test('0 可提交：两侧对齐且无待裁决未跟踪文件', () => {
  const { dir, g, put } = mkRepo();
  put('base.java', 'v1\n'); g(['add', '.']); g(['commit', '-q', '-m', 'base']);
  put('base.java', 'v2\n');
  const r = check(dir, { declared: declaredFile(['base.java']) });
  assert.equal(r.code, EXIT.OK, JSON.stringify(r.reasons));
  assert.ok(r.ok);
  assert.deepEqual(r.covered, ['base.java']);
});

test('10 未跟踪文件必须先问用户「要不要纳入 VCS」—— 4 个新建文件逐个列出，不折叠', () => {
  const { dir, g, put } = mkRepo();
  put('base.java', 'v1\n'); g(['add', '.']); g(['commit', '-q', '-m', 'base']);
  // 事故原形：一次派发既改了旧文件、又新建 4 个，且新文件全落在同一个新目录里
  put('base.java', 'v2\n');
  for (const n of ['Alpha', 'Beta', 'Gamma', 'Delta']) put(`src/web/${n}.jsp`, '<p></p>\n');
  const files = ['base.java', 'src/web/Alpha.jsp', 'src/web/Beta.jsp', 'src/web/Gamma.jsp', 'src/web/Delta.jsp'];
  const r = check(dir, { declared: declaredFile(files) });
  assert.equal(r.code, EXIT.UNTRACKED_UNDECIDED, JSON.stringify(r.reasons));
  assert.equal(r.untracked.length, 4, `未跟踪必须逐个文件列出，实际: ${JSON.stringify(r.untracked)}`);
  assert.ok(r.untracked.every((p) => p.endsWith('.jsp')), '列出的必须是 4 个文件本身，不是那个目录名');
});

test('11 漏报：git 侧改了但覆盖清单没报 —— 提交范围与交付范围已不一致', () => {
  const { dir, g, put } = mkRepo();
  put('base.java', 'v1\n'); g(['add', '.']); g(['commit', '-q', '-m', 'base']);
  put('base.java', 'v2\n'); put('src/web/Epsilon.jsp', '<p></p>\n');
  const r = check(dir, { declared: declaredFile(['base.java']) });   // 故意漏报新文件
  assert.equal(r.code, EXIT.UNDECLARED, JSON.stringify(r.reasons));
  assert.deepEqual(r.undeclared, ['src/web/Epsilon.jsp']);
});

test('12 虚报：清单里有、git 侧没动（根本没落盘）', () => {
  const { dir, g, put } = mkRepo();
  put('base.java', 'v1\n'); g(['add', '.']); g(['commit', '-q', '-m', 'base']);
  put('base.java', 'v2\n');
  const r = check(dir, { declared: declaredFile(['base.java', 'never-written.java']) });
  assert.equal(r.code, EXIT.PHANTOM, JSON.stringify(r.reasons));
  assert.deepEqual(r.phantom, ['never-written.java']);
});

test('裁决顺序：虚报优先于漏报、漏报优先于待裁决 —— 不把 bug 问成需求', () => {
  const { dir, g, put } = mkRepo();
  put('base.java', 'v1\n'); g(['add', '.']); g(['commit', '-q', '-m', 'base']);
  put('base.java', 'v2\n'); put('new.java', 'x\n');
  // 同时具备三个缺陷：虚报 + 漏报 + 未跟踪
  const r = check(dir, { declared: declaredFile(['base.java', 'ghost.java']) });
  assert.equal(r.code, EXIT.PHANTOM, '先核实"清单里的文件到底存不存在"');
  // 去掉虚报 → 落到漏报
  const r2 = check(dir, { declared: declaredFile(['base.java']) });
  assert.equal(r2.code, EXIT.UNDECLARED);
  // 补齐漏报 → 才落到"问用户一句"
  const r3 = check(dir, { declared: declaredFile(['base.java', 'new.java']) });
  assert.equal(r3.code, EXIT.UNTRACKED_UNDECIDED);
});

test('2 环境错误：不是 git 仓 / 清单不可解析 / 非 git 目录 —— 绝不等于「校过且通过」', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-nogit-'));
  const a = check(tmp, {});
  assert.equal(a.code, EXIT.BAD_ARGS);
  assert.notEqual(a.ok, true);

  const { dir, g, put } = mkRepo();
  put('base.java', 'v1\n'); g(['add', '.']); g(['commit', '-q', '-m', 'base']);
  const bad = path.join(FIXTURES, `bad-${++seq}.json`);
  fs.writeFileSync(bad, '{ this is not json', 'utf8');
  assert.equal(check(dir, { declared: bad }).code, EXIT.BAD_ARGS, 'JSON 语法错必须报，不能当"没声明"');
  const shape = path.join(FIXTURES, `shape-${++seq}.json`);
  fs.writeFileSync(shape, JSON.stringify({ note: '既不是数组也没有 artifacts[]' }), 'utf8');
  assert.equal(check(dir, { declared: shape }).code, EXIT.BAD_ARGS);
});

test('--declared - 表示「本次确无写类 agent 参与」，跳过双向对账但仍抓未跟踪', () => {
  const { dir, g, put } = mkRepo();
  put('base.java', 'v1\n'); g(['add', '.']); g(['commit', '-q', '-m', 'base']);
  put('surprise.java', 'x\n');                      // 没人声明过它
  const r = check(dir, { declared: '-' });
  assert.equal(r.code, EXIT.UNTRACKED_UNDECIDED, '跳过对账 ≠ 跳过未跟踪检查');
});

// ── 基线：快照 ref ────────────────────────────────────────────────────────────

test('基线优先取快照 ref；取不到回落 HEAD 并在 baseline.kind 里如实标注', () => {
  const { dir, g, put } = mkRepo();
  put('base.java', 'v1\n'); g(['add', '.']); g(['commit', '-q', '-m', 'base']);
  const snap = g(['rev-parse', 'HEAD']);
  g(['update-ref', SNAPSHOT_REF_PREFIX + 'fx1', snap]);
  put('taskA.java', 'x\n'); g(['add', '.']); g(['commit', '-q', '-m', '本任务的中途提交']);

  const withSnap = check(dir, { taskId: 'fx1', declared: declaredFile(['taskA.java']) });
  assert.equal(withSnap.baseline.kind, 'snapshot');
  assert.equal(withSnap.baseline.sha, snap, '基线必须是快照那一刻，不是 HEAD');
  assert.ok(withSnap.covered.includes('taskA.java'),
    '已提交进本任务的改动，只有相对快照才看得见（相对 HEAD 会完全消失）');

  const noSnap = check(dir, { taskId: '不存在的任务', declared: declaredFile(['taskA.java']) });
  assert.equal(noSnap.baseline.kind, 'HEAD', '回落要留痕，不能让读者以为对的是快照');
  assert.ok(!noSnap.covered.includes('taskA.java'), '回落时中途提交的文件确实看不见 —— 这正是优先取快照的理由');

  const none = check(dir, {});
  assert.equal(none.baseline.kind, 'HEAD');
});

// ── 只读性（门禁不得替人做决定）──────────────────────────────────────────────

test('只读：跑完门禁后 status / HEAD / refs 与跑前逐字节一致，且 index 未被改动', () => {
  const { dir, g, put } = mkRepo();
  put('base.java', 'v1\n'); g(['add', '.']); g(['commit', '-q', '-m', 'base']);
  put('base.java', 'v2\n'); put('new1.java', 'x\n'); put('new2.java', 'x\n');
  const before = {
    status: g(['status', '--porcelain', '--untracked-files=all']),
    head: g(['rev-parse', 'HEAD']),
    refs: g(['for-each-ref', '--format=%(refname)']),
    index: g(['ls-files', '--stage']),
  };
  check(dir, { declared: declaredFile(['base.java', 'new1.java', 'new2.java']) });
  const after = {
    status: g(['status', '--porcelain', '--untracked-files=all']),
    head: g(['rev-parse', 'HEAD']),
    refs: g(['for-each-ref', '--format=%(refname)']),
    index: g(['ls-files', '--stage']),
  };
  assert.deepEqual(after, before, '门禁一个字节都不许动：不 add、不 commit、不钉 ref');
});

// ── 机制级根因回归：未跟踪目录折叠 ────────────────────────────────────────────

test('回归锁：listDirtyFiles 必须逐个列出未跟踪目录里的文件，不折叠成目录名', () => {
  const { dir, g, put } = mkRepo();
  put('base.java', 'v1\n'); g(['add', '.']); g(['commit', '-q', '-m', 'base']);
  for (const n of ['One', 'Two', 'Three']) put(`brand/new/${n}.java`, 'x\n');
  const dirty = listDirtyFiles(dir);
  assert.equal(dirty.filter((p) => p.endsWith('.java')).length, 3,
    `折叠形态只会得到 1 条目录名，实际: ${JSON.stringify(dirty)}`);
  assert.ok(!dirty.some((p) => p === 'brand/new/' || p === 'brand/new'),
    '目录名本身不该出现在按文件粒度的清单里');
});

// ── 条文与实现同时被钉住 ──────────────────────────────────────────────────────

test('条文登记：红线、工作流节、写类 agent 契约三处都在，且引用的是真实存在的脚本', () => {
  const rd = (p) => fs.readFileSync(path.join(REPO, p), 'utf8').replace(/\r\n/g, '\n');
  const rl = rd('.qoder/rules/10-redlines.md');
  assert.ok(rl.includes('提交 / 推送前必须过交付对账门禁'), 'R3 流程纪律里必须有这条红线');
  assert.ok(rl.includes('不自动 push'), '红线必须重申"不自动 commit / 不自动 push"');

  const wf = rd('.qoder/rules/20-workflow.md');
  assert.ok(wf.includes('git-deliver-check.mjs'), '工作流必须有这道门禁的用法节');
  assert.ok(/"artifacts":.*写类 agent 必填/.test(wf), 'artifacts 必须从"若产生写操作"收成必填');

  const dev = rd('agents/supperH-bug-dev.md');
  assert.ok(dev.includes('新建的文件也必须列进来'), '主力写类 agent 的返回示例必须带这条要求');

  // 条文里出现的脚本必须真实存在 —— 防"文档宣称了一个不存在的门禁"
  for (const rel of ['scripts/git-deliver-check.mjs', 'scripts/git-preflight.mjs']) {
    assert.ok(fs.existsSync(path.join(REPO, rel)), rel);
  }
  assert.ok(fs.existsSync(path.join(REPO, 'scripts/git-deliver-check.mjs')));
});

test('常量同源：门禁用的快照 ref 前缀就是 git-preflight 那一份，没有第二份字面量', () => {
  assert.equal(SNAPSHOT_REF_PREFIX, 'refs/supperh/snap/');
  const src = fs.readFileSync(path.join(REPO, 'scripts/git-deliver-check.mjs'), 'utf8');
  assert.ok(!/['"]refs\/supperh\/snap\/['"]/.test(src),
    '门禁脚本内不得再出现该前缀的字面量 —— 三份常量会漂');
  assert.ok(/import\s*\{[^}]*SNAPSHOT_REF_PREFIX[^}]*\}\s*from\s*'\.\/git-preflight\.mjs'/.test(src),
    '必须 import 复用');
});
