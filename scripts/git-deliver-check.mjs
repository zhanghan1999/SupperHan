// scripts/git-deliver-check.mjs
//
// 交付对账门禁：用户下达「提交 / 推送」指令时，先把**开发 agent 声明的覆盖文件**
// 与 **git 实际改动的文件** 对账，把三类偏差摊成退出码，再决定能不能提交。
//
// 为什么必须存在（不是洁癖，是两次真实事故的形状）：
//   1) 一次 rebase 后 `git add` 只暂存了「被修改的」文件，4 个新建文件从头到尾没进
//      过任何提交 —— 因为「新建」这件事只存在于 agent 的记忆里，而记忆会被压缩掉。
//   2) 更一般的形态：agent 自报的清单永远可能漏报或虚报，而 git 不会。所以判据
//      取**两侧对账**，不取任何一侧的自觉。
//
// 本脚本**只读**：只跑 status / diff / rev-parse / ls-files / for-each-ref，
// 一个字段也不写 —— 绝不代为 `git add`、绝不代为 commit（那是用户的决定之后的事）。
//
// Usage:
//   node scripts/git-deliver-check.mjs --cwd <repoRoot>
//        [--task-id <id>] [--declared <files.json | -] [--json]
//
//   --cwd        仓库根（必填，与其它脚本同形）
//   --task-id    本次任务的快照 ref 后缀，基线取 refs/supperh/snap/<task-id>；
//                不给或取不到 → 回落到 HEAD，并在 baseline 里如实标注
//   --declared   开发 agent 回报里的 artifacts 清单（JSON 数组，或 {artifacts:[...]}）；
//                传 `-` 表示「本次确实没有写类 agent 参与」，跳过双向对账
//   --json       额外把结果 JSON 打到 stdout（默认就打，此旗标保留给人类读的场景）
//
// 退出码（与 fastpath 的 30–37、flow 的 41 语义空间互不重叠）：
//   0   可提交：两侧对齐，且没有待裁决的未跟踪文件
//   10  有未跟踪文件尚未进暂存区 → 必须逐个问用户「要不要纳入 VCS」，不得静默跳过
//   11  git 改了但 agent 清单里没有 → 漏报覆盖范围，必须补清单或说明为何不提交
//   12  agent 清单里有但 git 没动 → 虚报（或该文件根本没落盘），必须核实
//   2   参数 / 环境错误（不是 git 仓、清单不可解析）。「没校过」永远不等于「校过了且通过」

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 快照 ref 前缀**不在此处重新定义**：它在 `git-preflight.mjs` 已有一份（`resolve-project.mjs`
// 另有一份同名常量），再写字面量就是第三个真相源 —— 三份常量会漂，漂了以谁为准没人知道。
import { SNAPSHOT_REF_PREFIX } from './git-preflight.mjs';

export const EXIT = { OK: 0, UNTRACKED_UNDECIDED: 10, UNDECLARED: 11, PHANTOM: 12, BAD_ARGS: 2 };
export { SNAPSHOT_REF_PREFIX };

const GIT_TIMEOUT_MS = 15000;

function git(root, args) {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args],
    { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return (r.stdout || '').replace(/\r\n/g, '\n');
}

/** 绝对路径或相对路径 → repo-relative POSIX。比对键统一小写（Windows/macOS 大小写不敏感） */
export function toRepoRel(root, p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  if (!s) return null;
  const rootPosix = path.resolve(root).replace(/\\/g, '/').replace(/\/+$/, '');
  if (s.startsWith('/')) s = s.replace(/^\/+/, '');                 // /c/x/y 之类的 POSIX 形态
  const abs = path.resolve(rootPosix, s).replace(/\\/g, '/');
  if (abs === rootPosix) return null;
  if (abs.startsWith(rootPosix + '/')) return abs.slice(rootPosix.length + 1);
  return s.replace(/\/+$/, '');                                      // 落在仓外：原样返回，交给上层判
}
const key = (p) => String(p).toLowerCase();

/**
 * `git status --porcelain` 的解析。必须带 `-uall`：默认的 normal 会把未跟踪**目录**
 * 折叠成一行目录名，新建文件因此从清单上消失 —— 那正是漏提交的机制级根因。
 * @returns {{trackedModified:string[], staged:string[], untracked:string[]}}
 */
export function parseStatus(porcelain) {
  const trackedModified = [], staged = [], untracked = [];
  for (const line of (porcelain || '').split('\n')) {
    if (!line.trim()) continue;
    const x = line[0], y = line[1];
    const p = line.slice(3).trim().replace(/^.*-> /, '');
    if (x === '?' && y === '?') { untracked.push(p); continue; }
    if (x !== ' ' && x !== '?') staged.push(p);          // 已进 index 的改动
    if (y !== ' ' && y !== '?') trackedModified.push(p); // 工作区未暂存的改动
  }
  return { trackedModified, staged, untracked };
}

/** 相对某个基线 commit 的改动文件（不含未跟踪 —— 未跟踪由 status 负责） */
function diffAgainst(root, baseline) {
  const out = git(root, ['diff', '--name-only', baseline, '--']);
  return out === null ? null : out.split('\n').filter(Boolean);
}

function readDeclared(spec) {
  if (spec === '-') return { skip: true, files: [] };
  let raw;
  try { raw = fs.readFileSync(spec, 'utf8'); }
  catch { return { error: `--declared 指向的文件读不到：${spec}` }; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { return { error: `--declared 不是合法 JSON：${e.message}` }; }
  const arr = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed?.artifacts) ? parsed.artifacts
      : Array.isArray(parsed?.files) ? parsed.files
        : null;
  if (!arr) return { error: '--declared 既不是数组，也不含 artifacts[] / files[] 字段' };
  return { skip: false, files: arr.map(String) };
}

export function check(root, { taskId = null, declared = null, baselineRef = null } = {}) {
  const r = path.resolve(root);
  const probe = git(r, ['rev-parse', '--is-inside-work-tree']);
  if (String(probe || '').trim() !== 'true') {
    return { ok: false, code: EXIT.BAD_ARGS, error: `${r} 不是 git 工作树，无法对账` };
  }

  // ── 基线：优先本次任务的快照 ref，取不到回落 HEAD，并如实标注 ──────────────
  let baseline = null, baselineKind = null;
  const ref = baselineRef || (taskId ? SNAPSHOT_REF_PREFIX + taskId : null);
  if (ref) {
    const sha = git(r, ['rev-parse', '--verify', ref]);
    if (sha) baseline = sha.trim(), baselineKind = 'snapshot';
  }
  if (!baseline) {
    const head = git(r, ['rev-parse', 'HEAD']);
    if (head) baseline = head.trim(), baselineKind = 'HEAD';
  }
  if (!baseline) {
    return { ok: false, code: EXIT.BAD_ARGS, error: '仓内没有任何 commit（HEAD 不可解），无基线可对账' };
  }

  // ── git 实况：基线以来的改动 ∪ 工作区状态。这是不会说谎的一侧 ───────────────
  const st = parseStatus(git(r, ['status', '--porcelain', '--untracked-files=all']));
  const fromDiff = baselineKind === 'snapshot'
    ? (diffAgainst(r, baseline) || [])
    : [];                       // 基线是 HEAD 时，工作区状态已完整覆盖「相对 HEAD 的改动」
  const gitSet = new Map();     // key -> repo-relative path
  for (const p of [...fromDiff, ...st.trackedModified, ...st.staged, ...st.untracked]) {
    const rel = toRepoRel(r, p);
    if (rel) gitSet.set(key(rel), rel);
  }
  const covered = [...gitSet.values()].sort();

  const untrackedUnstaged = st.untracked
    .map((p) => toRepoRel(r, p)).filter(Boolean).sort();

  // ── agent 声明侧 ────────────────────────────────────────────────────────────
  let declaredFiles = [], declaredMissing = [], declaredPhantom = [];
  if (declared !== null) {
    const d = readDeclared(declared);
    if (d.error) return { ok: false, code: EXIT.BAD_ARGS, error: d.error };
    if (!d.skip) {
      const dSet = new Map();
      for (const p of d.files) {
        const rel = toRepoRel(r, p);
        if (rel) dSet.set(key(rel), rel);
      }
      declaredFiles = [...dSet.values()].sort();
      // git 改了但清单没报 → 漏报（新文件最容易漏的那一类）
      declaredMissing = covered.filter((p) => !dSet.has(key(p)));
      // 清单报了但 git 没动 → 虚报，或该文件根本没落盘
      declaredPhantom = declaredFiles.filter((p) => !gitSet.has(key(p)));
    }
  }

  // ── 裁决：先判「有没有该问用户的」，再判「清单对不对得上」 ──────────────────
  let code = EXIT.OK;
  const reasons = [];
  if (declaredPhantom.length) {
    code = EXIT.PHANTOM;
    reasons.push(`清单里有 ${declaredPhantom.length} 个文件在 git 侧看不到任何改动 —— 要么没落盘，要么虚报，必须逐个核实`);
  } else if (declaredMissing.length) {
    code = EXIT.UNDECLARED;
    reasons.push(`git 侧有 ${declaredMissing.length} 个文件被改动却没出现在开发 agent 的覆盖清单里 —— 提交范围与交付范围已经不一致，不得凭记忆取舍`);
  } else if (untrackedUnstaged.length) {
    code = EXIT.UNTRACKED_UNDECIDED;
    reasons.push(`有 ${untrackedUnstaged.length} 个未跟踪文件尚未进暂存区 —— 逐个问用户「要不要纳入 VCS」；静默只提交已跟踪文件就是事故本身`);
  }

  return {
    ok: code === EXIT.OK, code,
    baseline: { kind: baselineKind, sha: baseline, ref: ref || null },
    covered,                                    // 本次交付真实触及的全部文件
    untracked: untrackedUnstaged,
    tracked_unstaged: st.trackedModified.slice().sort(),
    staged: st.staged.slice().sort(),
    declared: declaredFiles,
    undeclared: declaredMissing,                // exit 11 的明细
    phantom: declaredPhantom,                   // exit 12 的明细
    reasons,
    note: '本脚本只读：不会代为 git add / commit。裁决权在人。',
  };
}

function parseArgs(argv) {
  const a = { cwd: null, taskId: null, declared: null, baselineRef: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--cwd') a.cwd = argv[++i];
    else if (t === '--task-id') a.taskId = argv[++i];
    else if (t === '--declared') a.declared = argv[++i];
    else if (t === '--snap-ref') a.baselineRef = argv[++i];
    else if (t === '--json') a.json = true;
    else return { error: `未知参数：${t}` };
  }
  if (!a.cwd) return { error: '必须给 --cwd <repoRoot>' };
  return a;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.log(JSON.stringify({ ok: false, code: EXIT.BAD_ARGS, error: args.error }));
    process.exit(EXIT.BAD_ARGS);
  }
  const res = check(args.cwd, { taskId: args.taskId, declared: args.declared, baselineRef: args.baselineRef });
  console.log(JSON.stringify(res, null, args.json ? 2 : 0));
  process.exit(res.code);
}
