// scripts/git-preflight.mjs
// `--preflight` 的本地事实采集层（docs/architecture.md §10.10）。
//
// 这里刻意**不做任何网络/连通性探测**。§10.8 已经论证过"执行前预检"能测到的都不是
// 证据（零信任网关对 VPN 网段任意端口都本地代答 accept），那条结论对 git 侧同样成立：
// 预检只回答"这个检出此刻是什么样"——分支、HEAD、哪些文件已经脏、交付方式解析结果、
// 上一批快照 ref 该不该清。连通性结论仍然只由各槽位 healthCheck 的退出码事后给出。
//
// 三条贯穿全模块的纪律：
// 1. **只记录，不阻断**：本模块没有任何"决定走哪条路"的权力，返回值一律是事实；
//    调用方（resolve-project.mjs）不得因为这里报了脏文件而改变退出码。
//    理由：一期不做 worktree 隔离，AI 也没资格阻断用户自己的工作区。
// 2. **失败静默**：git 不可用 / 不是仓库 / 超时 → 回 `null` + 一句 reason，
//    绝不抛异常、绝不改变退出码。卫生动作不许产生决策权（同 §10.6 记账纪律）。
// 3. **null 与空数组必须分得开**：`null` = 不知道，`[]` = 确认干净。把"不知道"
//    折叠成"干净"，等于给脏工作区发绿灯——这是本项目最不允许的一类错。
//
// git 调用形状与 fastpath-gate.mjs 的 readHeadCommit/diffNameOnly 一致：
// `-C <root>` 前置、屏蔽 stderr、catch 后回 null。唯一有意不同的是 status 的超时预算，
// 见 STATUS_TIMEOUT_MS 处的说明。
import { execFileSync } from 'node:child_process';
import { readHeadCommit } from './fastpath-gate.mjs';

/** 快照 ref 命名空间；清扫只遍历这一前缀，绝不碰其它 ref */
export const SNAPSHOT_REF_PREFIX = 'refs/supperh/snap/';

const GIT_TIMEOUT_MS = 5000;
// `git status` 要扫整棵工作树的 mtime，大仓上 5s 会不够（Windows 尤其明显）。
// 这是与上面两个函数**有意**不同的一处：它是"慢一点的本地事实"，不是"取数失败"。
// 超时的后果是 dirtyKnown:false（不知道），绝不是"干净"。
const STATUS_TIMEOUT_MS = 15000;

function git(root, args, timeout = GIT_TIMEOUT_MS) {
  if (!root) return null;
  try {
    const out = execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout, maxBuffer: 16 * 1024 * 1024
    });
    return String(out).replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

/**
 * 工作区脏文件清单（含未追踪），repo-relative POSIX 路径、升序去重。
 *
 * `-c core.quotePath=false` 不是可选项：中文文件名被转义成 `"\346\226\207..."` 后，
 * 下游拿它与 plan 的 `touched_files` 比对永远对不上，"脏文件命中计划内文件"这条
 * 停问判据就静默失效（同一个坑见 §10.7 表）。
 * 失败回 `null` = 不知道；空数组 = 确认干净。
 * @returns {string[]|null}
 */
export function listDirtyFiles(root) {
  const out = git(root, ['-c', 'core.quotePath=false', 'status', '--porcelain'], STATUS_TIMEOUT_MS);
  if (out === null) return null;
  const files = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // porcelain v1 固定是 `XY<空格><路径>`；重命名形态是 `R  old -> new`，取 new（要被改的是它）
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    p = p.replace(/^"|"$/g, '').trim();
    if (p) files.push(p.replace(/\\/g, '/'));
  }
  return [...new Set(files)].sort();
}

/**
 * 列出快照 ref 及其提交时间。
 * `%` 格式串整体走一个参数（不拼接进 shell，无注入面）；tab 分隔避免与 ref 名里的字符混淆。
 * @returns {Array<{ref:string, sha:string, committerTs:number|null}>|null} null = 取不到
 */
export function listSnapshotRefs(root, prefix = SNAPSHOT_REF_PREFIX) {
  const out = git(root, ['for-each-ref',
    `--format=%(refname)\t%(objectname)\t%(committerdate:unix)`,
    prefix.replace(/\/+$/, '')]);
  if (out === null) return null;
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ref, sha, ts] = line.split('\t');
    if (!ref || !sha) continue;
    const n = Number(ts);
    rows.push({ ref: ref.trim(), sha: sha.trim(), committerTs: Number.isFinite(n) && n > 0 ? n : null });
  }
  return rows;
}

/**
 * 清扫过期快照 ref。**破坏性动作，因此处处保守**：
 * - `ttlDays === 0` = 用户明确选择"不自动清扫"，一次都不删
 * - 取不到提交时间 → 保留（不知道 age 就不删，删错的代价是不可恢复）
 * - 只遍历 `refs/supperh/snap/` 前缀；单条 `update-ref -d`，不跑 `git gc`
 * - 任何一步失败只记进 `failed`，不抛异常、不影响退出码
 * @returns {{ran:boolean, scanned:number, removed:string[], kept:number, failed:string[], reason:string|null}}
 */
export function sweepSnapshotRefs(root, { ttlDays = 7, prefix = SNAPSHOT_REF_PREFIX, now = Date.now() } = {}) {
  const base = { ran: false, scanned: 0, removed: [], kept: 0, failed: [], reason: null };
  if (!root) return { ...base, reason: '未取得 effectiveRoot，快照 ref 未清扫' };
  if (ttlDays === 0) return { ...base, reason: 'snapshotTtlDays=0：本项目选择不自动清扫，ref 由人工处置' };
  const rows = listSnapshotRefs(root, prefix);
  if (rows === null) return { ...base, reason: 'git for-each-ref 未取得（不是 git 仓库 / git 不可用 / 超时），快照 ref 未清扫' };
  const cutoffSec = Math.floor(now / 1000) - ttlDays * 86400;
  let kept = 0;
  for (const r of rows) {
    if (r.committerTs === null || r.committerTs > cutoffSec) { kept++; continue; }
    // 只删自己命名空间下的东西——这条判断是防"前缀被调用方写歪"时的最后一道
    if (!r.ref.startsWith(prefix)) { kept++; continue; }
    const ok = git(root, ['update-ref', '-d', r.ref]) !== null;
    if (ok) base.removed.push(r.ref); else base.failed.push(r.ref);
  }
  return { ran: true, scanned: rows.length, removed: base.removed, kept, failed: base.failed, reason: null };
}

/**
 * 一次预检的全部本地事实。纯只读 + 一次 ref 清扫，无网络、无决策。
 *
 * `hasCommits` 与 `available` 必须分开：一个刚 `git init` 完、还没有 commit 的仓库
 * （本仓库自身的 master 分支就长期是这个状态）`rev-parse HEAD` 回空，此时
 * `git stash create` 无处可存（它需要一个基线 commit）——快照能力为 false，
 * 但这不是错误，也不阻断任务，只是要把原因如实写出来让人看见。
 *
 * @param {string} root effectiveRoot
 * @param {{ttlDays?:number, refPrefix?:string, now?:number}} opts
 */
export function collectGitFacts(root, { ttlDays = 7, refPrefix = SNAPSHOT_REF_PREFIX, now = Date.now() } = {}) {
  const probed = git(root, ['rev-parse', '--is-inside-work-tree']);
  const available = String(probed ?? '').trim() === 'true';
  if (!available) {
    return {
      available: false,
      reason: 'effectiveRoot 不是 git 工作区（无 .git / git 不在 PATH / 超时）：本次不建回滚快照，改动只能靠人核对',
      branch: null, detached: false, headCommit: null, hasCommits: false,
      dirtyFiles: [], dirtyCount: null, dirtyKnown: false,
      snapshotPossible: false, snapshotBlocker: '非 git 工作区',
      snapshotSweep: { ran: false, scanned: 0, removed: [], kept: 0, failed: [], reason: '未求值（非 git 工作区）' }
    };
  }
  const head = readHeadCommit(root);
  const branchRaw = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRaw === null ? null : branchRaw.trim();
  const dirty = listDirtyFiles(root);
  return {
    available: true,
    reason: null,
    branch: branch && branch !== 'HEAD' ? branch : null,
    detached: branch === 'HEAD',
    headCommit: head,
    hasCommits: !!head,
    dirtyFiles: dirty ?? [],
    dirtyCount: Array.isArray(dirty) ? dirty.length : null,
    dirtyKnown: Array.isArray(dirty),
    snapshotPossible: !!head,
    snapshotBlocker: head ? null : '仓库尚无任何 commit：`git stash create` 没有可存的基线，回滚锚点建不出来',
    snapshotSweep: sweepSnapshotRefs(root, { ttlDays, refPrefix, now })
  };
}
