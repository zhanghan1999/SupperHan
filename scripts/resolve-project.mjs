// scripts/resolve-project.mjs
// Deterministic cwd -> project resolver (the runtime "path gate").
//
// Reads the private-root project registry (projects/<code>.yaml, one file per
// project; falls back to legacy single project.yaml during migration), matches
// the CURRENT workspace folder against each project's bound roots
// (identity.workspaces[] + codeRoot), and emits ONE project's binding as JSON.
//
// This is a pure lookup — no LLM judgment. Its exit code IS the gate:
//   0  = exactly one project matched (stdout = binding JSON)
//   10 = no registered project matches cwd  (caller must run /supperH-init here)
//   11 = multiple projects match ambiguously (caller must disambiguate)
//   12 = private root not found              (caller must run /supperH-bootstrap)
//
// Usage:
//   node scripts/resolve-project.mjs --cwd <absolute workspace path>
//   SUPPERH_PRIVATE_ROOT=<path> node scripts/resolve-project.mjs --cwd ...
//
// Optional fast-path gate mode (adds fields to the payload; the exit code becomes
// the gate verdict). Without --module/--anchor the output stays shape-identical:
//   --module <name>                 also emit `freshness`, which fixes the R2/R3.5
//                                   conflict where the main agent had to read
//                                   CONTEXT_ROOT/index.md and run git rev-parse HEAD
//                                   itself - it can legitimately do neither
//   --module <name> --anchor <a>    evaluate G0-G4 + the veto word list
//   --text <raw user description>   REQUIRED together with --anchor; it feeds the veto
//                                   word scan. Missing -> the gate cannot be fully
//                                   evaluated -> exit 36, never 0.
//   --intent-json <inline>          I0 intent echo (step 1.6): the restatement + the
//   --intent-report <path>            verbatim fragments the orchestrator claims the user
//                                   said. Only the *script* can check a quote against
//                                   --text with includes(), so this is where it happens.
//                                   {expected, actual, repro, quotes:{expected[],actual[]}}.
//                                   Absent / unparsable -> 36 (fix the caller); present
//                                   but under-defined -> 40 (ask the user once).
//   --anchor-source <direct|lookup> Where the anchor came from. `lookup` = resolved via
//                                   F1.4 driver reverse-lookup, so it legitimately is not
//                                   in the user's text -> quote provenance check waived
//                                   (that path has its own "exactly one hit" guardrail).
//                                   Anything else = direct (default, stricter).
//   --impact-json <inline>          G5 check (P1-2): feed back the supperH-bug-analyzer(lite)
//   --impact-report <path>            report so the *script* - not the orchestrator -
//                                     decides whether the impact radius is narrow.
//                                     Usable on its own (no --module/--anchor needed).
//                                     When combined with the anchor gate, the gate
//                                     verdict wins unless it passed (0).
//   --scope <absolute path>           Repeatable. The analysis budget the orchestrator
//                                     handed supperH-bug-analyzer (codeRoot / CONTEXT_ROOT / a
//                                     single module dir). verifyImpactReport then checks
//                                     that EVERY file path named in the report sits under
//                                     one of them - a self-reported "I stayed inside"
//                                     cannot be checked, a path can. Relative paths count
//                                     as violations (nothing defines the join base).
//                                     Only meaningful with --impact-*; alone -> 36.
//   --env <name>                    DIAGNOSTIC baseline = the environment the evidence belongs to
//                                   (prod / uat / test / dev - whatever this project declares under
//                                   `branches.*` UNION `db.schemas.*`). It is NOT the freshness
//                                   baseline: freshness compares learning data against `HEAD` of
//                                   `effectiveRoot` (this checkout), while a diagnosis is only valid
//                                   for the environment it was sampled from. Both being "the same
//                                   project" is exactly what lets "queried the uat schema, read the
//                                   dev branch" get reported as "code and data disagree". Emits
//                                   payload.diagnoseBaseline = { declared, env, branch, schema,
//                                   codeSide }. Unknown or blank name -> 36 (caller bug: the
//                                   environment must be stated, not guessed). Absent -> the field is
//                                   not emitted at all, so plain output stays identical to pre-flag
//                                   builds (same discipline as --module/--anchor).
//   --preflight                     LOCAL FACTS ONLY, before anything gets modified (docs §10.10).
//                                   Emits payload.preflight = { blocking:false, delivery, available,
//                                   branch, detached, headCommit, hasCommits, dirtyFiles[],
//                                   dirtyCount, dirtyKnown, snapshotPossible, snapshotBlocker,
//                                   snapshotSweep }. `delivery` is the runtime-resolved
//                                   `git.deliveryMode` (+ snapshot TTL / ref namespace), which is why
//                                   no {{PROJECT.git.*}} placeholder exists. `driverSlots` names which
//                                   data sources this project actually registered (+ their kind and
//                                   whether a healthCheck exists) - a fact, so a downstream hard
//                                   requirement like "hand the SQL text to the user" is known to be
//                                   satisfiable before dispatch, not discovered at fetch time. A dirty working tree is
//                                   RECORDED, never blocking: phase 1 ships no isolation, and the
//                                   agent has no standing to veto the user's own workspace. It also
//                                   sweeps expired refs/supperh/snap/* refs (best effort, silent).
//                                   NO network probing happens here - §10.8 rules out pre-flight
//                                   connectivity checks, and this invariant is what lets the flag
//                                   exist at all. **It never changes the exit code.** Absent -> the
//                                   field is not emitted (same shape discipline as --env).
//
// L2 overrides are wired here: project.fastPath = { enabled, maxDiffLines, maxFiles,
// allowAnchorKinds }. Budgets are clamped to HARD_CAPS, so a typo cannot widen them.
//
// Gate exit codes (normal routing, not failures):
//   30 anchor unusable (unsupported kind, or zero route hit) / 31 ambiguous /
//   32 no usable index (missing / unreadable / unparsable / schema or column drift) /
//   33 veto hit / 34 level below L3 / 35 stale learning data /
//   36 gate not evaluated at all (incomplete args or internal error) /
//   37 G5 impact radius wider than 1 hop (or lite guardrail broken: reads non-empty,
//      evidence claims a source read while reads is [], or a path outside --scope)
//
//   40 I0 intent under-defined. **Deliberately outside the 30-37 band**: that band all
//   means "fall back to the full path", while 40 means "ask the user once, then route".
//   Folding it into the band would crack the invariant the caller relies on when it
//   branches on the exit code. Note the intent verdict is returned in the JSON
//   (`fastPath.intent`) on *every* code, because step 1.6 runs on both paths - 40 only
//   decides whether routing is blocked, not whether the echo is owed.
//
// Invariant (anchor-gate mode): exit 0 implies fastPath.eligible === true AND
// fastPath.anchorResolved is present. "We never got that far" is always 36 - returning
// 0 there would let the orchestrator enter the fast path with no anchor (R2 bypass
// through a flag parser).
// Invariant (impact mode): exit 0 implies impact.narrow === true, and this mode never
// emits fastPath fields - so a caller cannot read "0" as "the anchor gate passed".
import fs   from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { pathToFileURL } from 'node:url';
import { resolvePrivateRoot } from './resolve-private-root.mjs';
import { evaluateFastPath, verifyImpactReport, readFreshness, EXIT } from './fastpath-gate.mjs';
import { collectGitFacts, SNAPSHOT_REF_PREFIX } from './git-preflight.mjs';
import { dbRoleSlot } from './validate-project.mjs';

const IS_WIN = process.platform === 'win32';
// 唯一有机器语义的 role 值（不是槽位名）：它决定写保护绑哪个通道。槽位名清单归用户，本仓库不持有。
const DB_ROLE_NAME = 'database';

// --preflight 脏文件清单的递出上限。只影响 JSON 载荷大小，不影响 dirtyCount；
// 超限时必须同时置 dirtyTruncated 并写明归属判定不可靠（见下方 dirtyNote）。
const PREFLIGHT_DIRTY_CAP = 200;

// Normalise a path for comparison + ancestry tests. Returns POSIX-style string
// with no trailing separator; on Windows, lower-cased (drive-letter insensitive).
function normKey(p) {
  if (!p) return null;
  let s = String(p).trim();
  if (!s) return null;
  s = path.resolve(s);                 // absolute-ise
  s = s.replace(/\\/g, '/');           // posix separators
  s = s.replace(/\/+$/, '');           // strip trailing slash(es)
  if (IS_WIN) s = s.toLowerCase();
  return s || null;
}

// Is `child` the same as, or nested under, `root`?
function isUnder(root, child) {
  if (!root || !child) return false;
  return child === root || child.startsWith(root + '/');
}

// Resolve a private root override (env) else the tool-root sibling default.
function privateRootLocation() {
  const env = process.env.SUPPERH_PRIVATE_ROOT;
  if (env) {
    const p = path.resolve(env);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      return { privateRoot: p, toolRoot: resolvePrivateRoot().toolRoot, found: true };
    }
    return { privateRoot: p, toolRoot: resolvePrivateRoot().toolRoot, found: false };
  }
  const info = resolvePrivateRoot();
  return { privateRoot: info.privateRoot, toolRoot: info.toolRoot, found: info.privateRootExists };
}

// Read one project config file, tolerating missing/broken files (returns null).
function readProjectFile(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const data = YAML.parse(text);
    if (!data || typeof data !== 'object') return null;
    const code = data?.identity?.code;
    if (!code) return null;
    return { file, data, code };
  } catch {
    return null;
  }
}

// Read one menu-source config file (<PRIVATE_ROOT>/menus/<code>.yaml),
// tolerating missing/broken files (returns null). Menu config is an independent
// sidecar of the project; its absence is a legitimate state (the runtime gate
// decides whether that blocks /supperH-learn's menu mode).
function readMenuFile(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const data = YAML.parse(text);
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

// Load every project in the registry. Falls back to legacy single project.yaml
// when projects/ does not exist yet (pre-migration window).
function loadRegistry(privateRoot) {
  const projectsDir = path.join(privateRoot, 'projects');
  const entries = [];
  if (fs.existsSync(projectsDir) && fs.statSync(projectsDir).isDirectory()) {
    for (const name of fs.readdirSync(projectsDir)) {
      if (!/\.ya?ml$/i.test(name)) continue;
      const e = readProjectFile(path.join(projectsDir, name));
      if (e) entries.push(e);
    }
    return { projectsDir, entries, legacy: false };
  }
  const legacyFile = path.join(privateRoot, 'project.yaml');
  if (fs.existsSync(legacyFile)) {
    const e = readProjectFile(legacyFile);
    if (e) entries.push(e);
  }
  return { projectsDir, entries, legacy: true };
}

// Append one JSONL record per gate evaluation so thresholds can be tuned on real
// data later. Written from inside this node process: costs no agent permission and
// never lands in git (the private root is untracked by design).
function logFastPathAttempt(privateRoot, rec) {
  try {
    const dir = path.join(privateRoot, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date();
    const month = String(stamp.getMonth() + 1).padStart(2, '0');
    const file = path.join(dir, `fastpath-${stamp.getFullYear()}${month}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ at: stamp.toISOString(), ...rec }) + '\n', 'utf8');
  } catch {
    // Logging must never change the gate verdict or the exit code.
  }
}

// Absolute root set a project "owns" for cwd matching.
function boundRootsOf(data) {
  const roots = [];
  const ws = Array.isArray(data?.identity?.workspaces) ? data.identity.workspaces : [];
  for (const w of ws) { const k = normKey(w); if (k) roots.push(k); }
  const cr = normKey(data?.codeRoot);
  if (cr) roots.push(cr);
  return [...new Set(roots)];
}

// Expand the token set used inside `paths.*` overrides and `drivers.*` values.
// DRIVERS_ROOT is mandatory here: L2 registers drivers as
// `impl: "{{DRIVERS_ROOT}}/x.py"`, and this is the ONLY place that token is
// resolved for L2 values. Without it the raw text reaches the artifact layer,
// where templates compose `DRIVERS_ROOT/<impl>` into a double-prefixed path.
function expandTokens(s, ctx) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/\{\{DRIVERS_ROOT\}\}/g, ctx.driversRoot)
    .replace(/\{\{PRIVATE_ROOT\}\}/g, ctx.privateRoot)
    .replace(/\{\{TOOL_ROOT\}\}/g, ctx.toolRoot)
    .replace(/\{\{PROJECT\.identity\.code\}\}/g, ctx.code);
}

// Deep-expand every string in a plain value (drivers block is free-form nested).
function expandDeep(v, ctx) {
  if (typeof v === 'string') return expandTokens(v, ctx);
  if (Array.isArray(v)) return v.map(x => expandDeep(x, ctx));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = expandDeep(val, ctx);
    return out;
  }
  return v;
}

function tokenCtx(privateRoot, toolRoot, code) {
  const driversRoot = path.join(privateRoot, 'drivers');
  return { privateRoot, toolRoot, code, driversRoot };
}

/**
 * Expand + normalise a drivers block.
 * `impl` is by contract a bare path, so it gets native separators — otherwise it
 * comes out mixed (`<root>\drivers/x.py`, because the L2 template joins with `/`)
 * and can no longer be string-compared against the `driversRoot` field.
 * `healthCheck` is a command line (may carry args) and `config` is free-form:
 * both are returned verbatim so we never rewrite something that is not a path.
 */
function expandDriverSlots(drivers, ctx) {
  const out = expandDeep(drivers, ctx);
  if (out && typeof out === 'object') {
    for (const slot of Object.values(out)) {
      if (slot && typeof slot === 'object' && typeof slot.impl === 'string') {
        slot.impl = path.normalize(slot.impl);
      }
    }
  }
  return out;
}

/**
 * Expand `{{DRIVERS_ROOT}}` / `{{PRIVATE_ROOT}}` / `{{TOOL_ROOT}}` /
 * `{{PROJECT.identity.code}}` inside a project's `drivers` block. Exported so
 * scripts/init-project.mjs reuses this single implementation instead of
 * re-deriving driver paths with its own regex.
 * Accepts either a full project document or a bare drivers block.
 */
export function expandDrivers(doc, { privateRoot, toolRoot, code } = {}) {
  const root = privateRoot ?? resolvePrivateRoot().privateRoot;
  const drivers = (doc && typeof doc === 'object' && 'drivers' in doc) ? doc.drivers : doc;
  return expandDriverSlots(drivers, tokenCtx(root, toolRoot, code));
}

/**
 * 把“哪个槽位是数据库通道”解成一个固定名字（F-11）。
 *
 * 判定规则单点复用 validate-project.mjs 的 `dbRoleSlot`（显式 `role: database` 为准，
 * 存量同名槽位当同义）——不在这里再写一份“叫什么算库”，否则两处会对同一个配置给出不同结论，
 * 而这两份结论一个决定写保护绑不绑、一个决定门禁放不放行。
 * 只递出 L1 模板真正引用的四个字段（不复制整块）：多一份 config/writes 就多一份与
 * `drivers.<slot>` 不一致的可能，而主 agent 要把这份 JSON 全读进上下文。
 */
function pickDbDriver(data, driversExpanded) {
  const hit = dbRoleSlot(data);
  if (!hit) return null;
  const cfg = driversExpanded && driversExpanded[hit.slot];
  if (!cfg || typeof cfg !== 'object') return null;
  return {
    slot: hit.slot,
    kind: String(cfg.kind ?? 'script'),
    impl: typeof cfg.impl === 'string' ? cfg.impl : null,
    healthCheck: typeof cfg.healthCheck === 'string' ? cfg.healthCheck : null,
  };
}

function buildBinding(entry, ctx) {
  const { code, data, file } = entry;
  const localCtx = tokenCtx(ctx.privateRoot, ctx.toolRoot, code);
  // Native-path normalisation so downstream consumers get clean OS separators.
  const driversExpanded = expandDriverSlots(data?.drivers, localCtx);
  const toNative = (p) => (p ? path.normalize(p) : p);
  const defaultCtx = path.join(localCtx.privateRoot, 'context', code);
  const defaultTask = path.join(localCtx.privateRoot, 'tasks', code);
  const contextRoot = toNative(expandTokens(data?.paths?.contextRoot ?? defaultCtx, localCtx));
  const tasksRoot   = toNative(expandTokens(data?.paths?.tasksRoot   ?? defaultTask, localCtx));
  // Menu-source sidecar: path is always returned (may not exist); `menu` is the
  // parsed object or null. Menu mode of /supperH-learn gates on `menu == null`.
  const menuConfigFile = toNative(path.join(ctx.privateRoot, 'menus', code + '.yaml'));
  return {
    ok: true,
    code,
    displayName: data?.identity?.displayName ?? code,
    configFile: file,
    registryLegacy: ctx.legacy,
    toolRoot: localCtx.toolRoot,
    privateRoot: localCtx.privateRoot,
    driversRoot: localCtx.driversRoot,
    contextRoot,
    tasksRoot,
    menuConfigFile,
    menu: readMenuFile(menuConfigFile),
    codeRoot: data?.codeRoot,
    effectiveRoot: data?.effectiveRoot ?? data?.codeRoot,
    packageRoot: data?.packageRoot,
    db: data?.db,
    // Driver values leave the resolver fully expanded (impl/healthCheck are
    // absolute paths by then), so artifact templates must NOT prepend a second
    // DRIVERS_ROOT prefix. `config` is free-form and expanded too.
    drivers: driversExpanded,
    // `dbDriver`：按 role 解出的数据库通道别名（F-11）。
    // 为什么需要它：L1 产物以前写 `drivers.database.impl`，等于把“那个库源一定叫 database”
    // 钉成契约；而槽位名归用户、个数不限，不叫这个名字的项目会拿到一个填不上的 token（不报错、只是没值）。
    // 它是派生字段而非 YAML 路径：模板里写 {{PROJECT.dbDriver.impl}}，运行期从本返回体取值。
    // 未接入数据库时为 null（不是缺键）：这样“没库”是一个能机械区分的事实，而不是一个解不开的 token。
    dbDriver: pickDbDriver(data, driversExpanded),
    project: data
  };
}

/**
 * 诊断基线（环境侧）解析。与新鲜度基线（代码侧 = `effectiveRoot` 的 HEAD）是**两件事**：
 *
 *   新鲜度基线回答“学习记录相对于我这份检出过期了没”，它只能拿来做 G4 分流；
 *   诊断基线回答“我取回来的这些行、这些日志、这个响应，是哪个环境的”。
 *
 * 两者一直只被叫作“同一个项目”，于是会出现一类很难发现的错：查的是 uat 的 schema、
 * 看的是 dev 分支的 HEAD，然后结论写“代码与数据不一致”。环境未声明时不得默认成
 * 任一个环境（猜错环境 = 拿别人的现场证自己的结论），所以这里宁可 36。
 *
 * 合法环境名 = `branches.*` 与 `db.schemas.*` 的键并集（两边常常不对齐：`test` 库可能
 * 没有对应分支、`dev` 分支可能没有对应 schema），取不到的那一侧回 null 而不是报错。
 * 环境名区分大小写：错写会被当成“未声明的环境”而不是“猜你想写哪个”。
 *
 * 但“只登记了分支、整个项目没接数据库”不一样：那是 **无源可采**，不是“某一侧取不到”。
 * 环境标签只对数据成立（代码侧永远相对 `effectiveRoot` 的 HEAD，与 `--env` 写什么无关），
 * 放过去就会让人以为“这份证据属于 prod”，而它来自一个根本没连的库 —— 所以下面直接 36。
 *
 * @param {any} project 解析器返回的 `project` 段（完整 L2 文档）
 * @param {string} envRaw --env 的原始值
 * @returns {{ok:true, value:{env:string, branch:string|null, schema:string|null}}|{ok:false, message:string}}
 */
export function resolveDiagnoseBaseline(project, envRaw) {
  const p = project && typeof project === 'object' && !Array.isArray(project) ? project : {};
  const branches = p.branches && typeof p.branches === 'object' && !Array.isArray(p.branches) ? p.branches : {};
  const db = p.db && typeof p.db === 'object' && !Array.isArray(p.db) ? p.db : null;
  const schemas = db && db.schemas && typeof db.schemas === 'object' && !Array.isArray(db.schemas) ? db.schemas : {};
  const names = [...new Set([...Object.keys(branches), ...Object.keys(schemas)])]
    .filter((n) => String(branches[n] ?? schemas[n] ?? '').trim() !== '');
  const env = String(envRaw ?? '').trim();
  if (!env) {
    return { ok: false, message: `--env 参数值为空白：诊断基线未声明。合法环境名：${names.join(' / ') || '（本项目 branches/db.schemas 未声明任何环境）'}` };
  }
  if (!db) {
    return { ok: false, message: `本项目未接入数据库（L2 缺 db 段 = 纯代码模式）：--env '${env}' 无源可采。` +
      `环境标签只对取回的数据成立，代码侧永远相对 effectiveRoot 的 HEAD。` +
      `要环境证据就先把数据库通道接上（库信息走 /supperH-init，带 role: database 的槽位走 /supperH-driver）；只要代码结论就别给 --env（不给 = 不注入 diagnoseBaseline 字段，不是失败）` };
  }
  if (!names.includes(env)) {
    return { ok: false, message: `--env '${env}' 不在本项目声明的环境里（合法：${names.join(' / ') || '无'}）。环境得写对且区分大小写：拿不准就去问用户，不要换个看着像的名字重试` };
  }
  const pick = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  return { ok: true, value: { env, branch: pick(branches[env]), schema: pick(schemas[env]) } };
}

/** 回滚快照 ref 的命名空间前缀。归本项目独占，清扫只遍历这一前缀。 */
// 单一真相在 git-preflight.mjs（真正执行清扫的地方）；这里只做别名导出，
// 避免两处字面量漂移把"写入的 ref"与"清扫的前缀"分成两个名字。
export const GIT_SNAPSHOT_REF_PREFIX = SNAPSHOT_REF_PREFIX;
const DELIVERY_MODES = ['none', 'local-commit', 'push-pr'];
const DEFAULT_DELIVERY_MODE = 'none';
const DEFAULT_SNAPSHOT_TTL_DAYS = 7;
const MAX_SNAPSHOT_TTL_DAYS = 365;

/**
 * 交付方式（git.deliveryMode）与快照 TTL 解析。两个值都是**运行期输入**：
 * 不进 docs/placeholders.md 登记表、不写 {{PROJECT.git.deliveryMode}} 占位符，
 * 由 --preflight 读出后随载荷递出（与 drivers.<slot>.kind 同纪律）。
 * 两条理由：改 L2 值不必重跑 sync / 重启 IDE；更重要的是消除歧义——
 * “L2 里没写这一段”必须由脚本给出确定答案，不能留给模型自己看着办。
 *
 * fail-safe 方向：非法 / 未知值归 `none`（三者中最安全的一个）而不是报错也不是放行，
 * 并把原值留在 `declared` 里供上层如实告知用户（静默改用户意图与静默放行同样糟）。
 * `push-pr` 是合法声明但一期不支持执行：这里只如实递出 `supported: false`，
 * 拒绝动作在 supperH-bug-dev（报 DELIVERY_UNSUPPORTED），不在此处改写用户的声明。
 *
 * @param {any} project 解析器返回的 `project` 段（完整 L2 文档）；无 `git` 段 = 全缺省
 */
export function resolveGitDelivery(project) {
  const p = project && typeof project === 'object' && !Array.isArray(project) ? project : {};
  const g = p.git && typeof p.git === 'object' && !Array.isArray(p.git) ? p.git : {};
  const declared = typeof g.deliveryMode === 'string' && g.deliveryMode.trim() !== '' ? g.deliveryMode.trim() : null;
  const mode = declared && DELIVERY_MODES.includes(declared) ? declared : DEFAULT_DELIVERY_MODE;
  let ttl = g.snapshotTtlDays;
  // 只认真正的整数字面量：`true` / `'7'` 在 Number() 下会静默变成 1 / 7，
  // 把“写错了”伪装成“写对了”——这类错必须回缺省，不能透传。
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 0 || ttl > MAX_SNAPSHOT_TTL_DAYS) {
    ttl = DEFAULT_SNAPSHOT_TTL_DAYS;
  }
  return {
    mode,
    declared,
    clamped: declared !== null && declared !== mode,  // true = L2 写了但不被认，已按缺省执行
    supported: mode !== 'push-pr',
    snapshotTtlDays: ttl,
    refPrefix: GIT_SNAPSHOT_REF_PREFIX
  };
}

/**
 * Resolve the project binding for a workspace folder.
 * @param {{cwd?:string, privateRootOverride?:string}} opts
 * @returns {{ok:boolean, status:number, message:string, binding?:object, candidates?:object[]}}
 */
export function resolveProject(opts = {}) {
  const cwd = normKey(opts.cwd || process.cwd());
  const loc = privateRootLocation();
  if (!loc.found) {
    return {
      ok: false, status: 12, cwd,
      message: `private root not found: ${loc.privateRoot}. Run /supperH-bootstrap or set SUPPERH_PRIVATE_ROOT.`
    };
  }
  const { entries, legacy } = loadRegistry(loc.privateRoot);
  if (entries.length === 0) {
    return {
      ok: false, status: 10, cwd,
      message: `no registered projects under ${path.join(loc.privateRoot, 'projects')}. Run /supperH-init in this workspace.`
    };
  }

  // Match cwd against each project's bound roots; keep the most specific per project.
  const ctx = { privateRoot: loc.privateRoot, toolRoot: loc.toolRoot, legacy };
  const matches = [];
  for (const entry of entries) {
    const roots = boundRootsOf(entry.data);
    let bestLen = -1;
    for (const r of roots) if (isUnder(r, cwd) && r.length > bestLen) bestLen = r.length;
    if (bestLen >= 0) matches.push({ entry, specificity: bestLen });
  }

  if (matches.length === 0) {
    const tried = entries.map(e => ({ code: e.code, roots: boundRootsOf(e.data) }));
    return {
      ok: false, status: 10, cwd,
      message: `no registered project matches cwd "${opts.cwd || process.cwd()}". Run /supperH-init in this workspace. (registered: ${tried.map(t => t.code).join(', ')})`,
      candidates: tried
    };
  }

  matches.sort((a, b) => b.specificity - a.specificity);
  const top = matches[0];
  const tied = matches.filter(m => m.specificity === top.specificity && m.entry.code !== top.entry.code);
  if (tied.length > 0) {
    return {
      ok: false, status: 11, cwd,
      message: `ambiguous: cwd "${opts.cwd || process.cwd()}" matches multiple projects at equal depth: ${[top, ...tied].map(m => m.entry.code).join(', ')}. Narrow identity.workspaces/codeRoot or pass an explicit project.`,
      candidates: [top, ...tied].map(m => ({ code: m.entry.code, configFile: m.entry.file, specificity: m.specificity }))
    };
  }

  return {
    ok: true, status: 0, cwd,
    message: `matched project '${top.entry.code}'`,
    binding: buildBinding(top.entry, ctx)
  };
}

// CLI entry
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  let cwd = process.cwd();
  // `undefined` = the flag never appeared. A separate *Seen flag records the intent,
  // because a trailing `--anchor` (argv has no next element) yields undefined too.
  let moduleName;
  let anchor;
  let text;
  let moduleSeen = false;
  let anchorSeen = false;
  let textSeen = false;
  let impactSeen = false;
  let impactInline;               // --impact-json <literal>
  let impactFile;                 // --impact-report <path>
  const impactSource = () => (impactInline !== undefined ? '--impact-json' : '--impact-report');
  let intentSeen = false;
  let intentInline;               // --intent-json <literal>
  let intentFile;                 // --intent-report <path>
  let anchorSourceRaw;            // --anchor-source <direct|lookup>
  let scopeSeen = false;
  const scopeRoots = [];          // --scope <绝对路径>（可重复）：派单时给 analyzer 圈定的分析面
  let envSeen = false;
  let envName;                    // --env <name>：诊断基线（证据来自哪个环境），与代码侧的 HEAD 分家
  let preflightSeen = false;      // --preflight：只集本地事实 + 清扫快照 ref，永不改变退出码
  const intentSource = () => (intentInline !== undefined ? '--intent-json' : '--intent-report');
  // 只认 lookup（大小写/空白不敏感），其余一律归 direct。写错了只会多验一道（多拦），
  // 不会把"锚点出处验真"这道护栏静默关掉——方向必须与漏杀/误杀纪律一致。
  const anchorSource = () => (String(anchorSourceRaw ?? '').trim().toLowerCase() === 'lookup' ? 'lookup' : 'direct');
  // Flag presence is decided by `i + 1 < argv.length`, NOT by the truthiness of
  // argv[i+1]. Truthiness folds `--anchor ""` and a trailing `--anchor` into "absent",
  // which skipped the whole gate and left exitCode at 0 - while commands/supperH-bug.md
  // defines 0 as "all gates passed, go F2 and read fastPath.anchorResolved". An empty
  // anchor is a legal value: hand it to classifyAnchor, which routes it to 30.
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const hasValue = i + 1 < argv.length;
    if (flag === '--cwd' && hasValue) cwd = argv[++i];
    else if (flag === '--module') { moduleSeen = true; if (hasValue) moduleName = argv[++i]; }
    else if (flag === '--anchor') { anchorSeen = true; if (hasValue) anchor = argv[++i]; }
    else if (flag === '--text')   { textSeen = true;   if (hasValue) text = argv[++i]; }
    else if (flag === '--impact-json')   { impactSeen = true; if (hasValue) impactInline = argv[++i]; }
    else if (flag === '--impact-report') { impactSeen = true; if (hasValue) impactFile = argv[++i]; }
    else if (flag === '--intent-json')   { intentSeen = true; if (hasValue) intentInline = argv[++i]; }
    else if (flag === '--intent-report') { intentSeen = true; if (hasValue) intentFile = argv[++i]; }
    else if (flag === '--anchor-source') { if (hasValue) anchorSourceRaw = argv[++i]; }
    else if (flag === '--scope') { scopeSeen = true; if (hasValue) scopeRoots.push(argv[++i]); }
    else if (flag === '--env') { envSeen = true; if (hasValue) envName = argv[++i]; }
    else if (flag === '--preflight') { preflightSeen = true; }
  }
  // `--module` on its own is the documented freshness-only mode (exit 0, no gate fields).
  // A verdict is only requested once --anchor/--text/--intent shows up.
  // intent 计入 gateAsked 是故意的：它没有独立语义（不像 impact 可以单独验收形状），
  // 只给了 --intent-* 而忘了 --anchor 必须是 36，不能被读成"没申请门禁 → 0"。
  const gateAsked = anchorSeen || textSeen || intentSeen;
  const gap = !gateAsked ? null
    : anchorSeen && anchor === undefined ? '--anchor 缺参数值，门禁未求值'
    : !anchorSeen ? '缺 --anchor，门禁未求值'
    : moduleName === undefined ? (moduleSeen ? '--module 缺参数值，门禁未求值' : '缺 --module，门禁未求值')
    : null;
  // I0 的"参数问题"与"内容问题"必须分家：这里只管前者（互斥/缺值），
  // 内容欠定义是门禁自己判 40。两者混成一个码，用户就会被问一个修不了的问题。
  const intentGap = !intentSeen ? null
    : intentInline === undefined && intentFile === undefined
      ? `${intentSource()} 缺参数值，I0 未求值`
      : intentInline !== undefined && intentFile !== undefined
        ? '--intent-json 与 --intent-report 只能给一个，I0 未求值'
        : null;
  // G5 单独申请时不需要锚点入参（它只看回报形状），但同样"没给值就不能判"。
  const impactAsked = impactSeen;
  const impactGap = !impactAsked ? null
    : impactInline === undefined && impactFile === undefined
      ? `${impactSource()} 缺参数值，G5 未求值`
      : impactInline !== undefined && impactFile !== undefined
        ? '--impact-json 与 --impact-report 只能给一个，G5 未求值'
        : null;
  // --scope 不单独构成一项判定：它只是 G5 的额外校验输入。圈了范围却没人校，比
  // 不圈更危（编排者会以为越界已被拦住），所以它宁可 36 也绝不默默忽略。
  const scopeGap = !scopeSeen ? null
    : scopeRoots.length === 0 ? '--scope 缺参数值，分析面未圈定'
    : scopeRoots.some((s) => String(s).trim() === '')
      ? '--scope 参数值里有空白：空白路径要么把全部文件判成越界、要么全放行（取决于拼接基准），两种都不是结论'
      : !impactAsked
        ? '--scope 只在 --impact-* 回灌时生效：单独给 = 圈了范围但没人校'
      : null;

  const startedAt = Date.now();
  let res = null;
  let payload = null;
  let exitCode = EXIT.INCOMPLETE;

  // stdout must never come out empty: the orchestrator branches on the JSON *and*
  // the exit code, and an empty stdout is unrecoverable for it.
  const emit = () => {
    try {
      console.log(JSON.stringify(payload, null, 2));
    } catch {
      console.log(JSON.stringify({ ok: false, status: EXIT.INCOMPLETE, message: 'payload not serialisable' }));
    }
    if (res && !res.ok) console.error('[resolve-project] ' + res.message);
    else if (exitCode !== 0) {
      const why = payload?.fastPath?.message
        || (payload?.impact?.problems || []).join('; ')
        || '';
      console.error('[resolve-project][fast-path gate] ' + String(why));
    }
    process.exit(exitCode);
  };

  const incomplete = (msg) => ({
    status: EXIT.INCOMPLETE, eligible: false, gates: {}, anchorKind: null,
    anchorResolved: null, veto: [], vetoSkipped: true, intent: null, message: msg
  });

  // 「门禁未求值」本身是一种结论：必须同时给出 36 + 一条 jsonl 记账，
  // 否则账本的分母被削掉，以后拿它调阈值会偏乐观。
  const bail = (msg) => {
    payload.fastPath = incomplete(msg);
    exitCode = EXIT.INCOMPLETE;
    const b = res && res.ok ? res.binding : null;
    logFastPathAttempt(b?.privateRoot, {
      stage: 'anchor_gate',
      project: b?.code ?? null,
      module: moduleName ?? null,
      anchorKind: null,
      anchor: String(anchor ?? '').slice(0, 120),
      textGiven: typeof text === 'string' && text.trim() !== '',
      intentGiven: intentSeen,
      intent: { ran: false },
      anchorSource: anchorSource(),
      status: EXIT.INCOMPLETE, eligible: false, gates: {}, veto: [], route: null, level: null,
      wall_time_ms: Date.now() - startedAt
    });
  };

  // G5 的「未求值」同样要记账：否则账本分母缺一块，以后拿它调阈值会偏乐观。
  const logImpact = (imp) => {
    const b = res && res.ok ? res.binding : null;
    logFastPathAttempt(b?.privateRoot, {
      stage: 'impact_gate',
      project: b?.code ?? null,
      module: moduleName ?? null,
      anchorKind: null,
      anchor: null,
      textGiven: typeof text === 'string' && text.trim() !== '',
      status: imp.status,
      eligible: false,
      gates: { G5_impact: imp.narrow ? 'pass' : 'fail' },
      veto: [], route: null, level: null,
      impactCode: imp.code ?? null,
      // 圈没圈范围要可统计：没圈 scope 的 G5 通过，以后调阈值时不能与“校过越界”的混为一谈
      scopeGiven: scopeRoots.length > 0,
      scopeRoots: scopeRoots.length,
      diagnoseEnv: envSeen ? (String(envName ?? '').trim() || null) : null,
      problems: imp.problems ?? [],
      wall_time_ms: Date.now() - startedAt
    });
  };
  const bailImpact = (msg) => {
    payload.impact = { status: EXIT.INCOMPLETE, applied: true, narrow: false, code: null, problems: [msg], checks: {} };
    exitCode = EXIT.INCOMPLETE;
    logImpact(payload.impact);
  };

  // 诊断基线不成立 = 整单作废：环境没定下来，取回来的每一行都可以被质疑“你说的哪个库”。
  // 它不能只写成 payload 里的一个 reason：那与“门禁过了但环境没填”长得很像，
  // 而退出码是调用方唯一不会读错的东西。
  const bailEnv = (msg) => {
    payload.diagnoseBaseline = {
      declared: false, env: String(envName ?? '').trim() || null, reason: msg,
      codeSide: 'freshness.headCommit'
    };
    exitCode = EXIT.INCOMPLETE;
    const b = res && res.ok ? res.binding : null;
    logFastPathAttempt(b?.privateRoot, {
      stage: 'baseline_gate',
      project: b?.code ?? null,
      envGiven: envSeen,
      env: String(envName ?? '').trim() || null,
      status: EXIT.INCOMPLETE,
      problems: [msg],
      wall_time_ms: Date.now() - startedAt
    });
  };

  try {
    res = resolveProject({ cwd });
    payload = res.ok
      ? { ...res.binding }
      : { ok: false, status: res.status, cwd: res.cwd, message: res.message, candidates: res.candidates };
    exitCode = res.status;

    // Step-0 project gate wins over everything: never evaluate a fast path for a
    // workspace that has no unambiguously resolved project (R3.5). Hard stops
    // (10/11/12) do not log - they are not gate outcomes.
    //
    // 诊断基线排在所有门禁之前求值：环境未声明就取数，后面的结论全部无归属。
    // 它无效时也要把后面的门禁挡住（envVoid）：否则 exitCode 会被先写入的 0 抢走，
    // 一个“只是没说清环境”的调用看上去与一个健在的调用完全同形。
    let envVoid = false;
    if (res.ok && envSeen) {
      const bs = resolveDiagnoseBaseline(res.binding.project, envName);
      if (!bs.ok) { bailEnv(bs.message); envVoid = true; }
      else payload.diagnoseBaseline = { declared: true, ...bs.value, codeSide: 'freshness.headCommit' };
    }

    // ---- --preflight：只集本地事实，不参与任何分流 ----
    // 位置在环境之后、门禁之前：它不是门禁也不读学习数据，放这里只为了
    // "envVoid 时不输出半截预检"（与 freshness 同一处理）。
    // 铁律：这一段绝不写 exitCode（`blocking: false` 就是它的自我声明）。
    if (res.ok && preflightSeen && !envVoid) {
      const b = res.binding;
      const delivery = resolveGitDelivery(b.project);
      const facts = collectGitFacts(b.effectiveRoot, {
        ttlDays: delivery.snapshotTtlDays, refPrefix: delivery.refPrefix
      });
      // 脏清单必须夹截：主 agent 把这份 JSON 全读进上下文，一个 5000 文件未提交的仓
      // 库能一次吃掉几万 token。但夹截会让"脏文件是否命中 plan"算错，所以不能只夹不说：
      // 靠 dirtyTruncated + dirtyNote 把"此次归属判定不可靠、需逐个复核"明写在载荷里。
      const dirtyAll = Array.isArray(facts.dirtyFiles) ? facts.dirtyFiles : [];
      const dirtyTruncated = dirtyAll.length > PREFLIGHT_DIRTY_CAP;
      // 哪些取数源真的注册了：也是事实，不是判定。报它的理由很直接——下游的
      // “必须把 SQL 原文递给用户校验”这类硬要求，只有在数据库通道存在时才做得动；
      // 与其到取数那一步才发现做不到，不如开工前就看到“这个源没声明”。
      // 槽位名归用户（F-11）：这里遍历注册表的**实际键**，不再拿一份固定名单去问
      // “database 在不在”——那份名单本身就是“只有这四个源”的假设，用户加第五个源时
      // 它不会报错，只会看不见。“未声明”现在由缺键表示，不再逐个名字写 false。
      const drv = b.drivers && typeof b.drivers === 'object' ? b.drivers : {};
      const driverSlots = {};
      for (const [slot, cfg] of Object.entries(drv)) {
        if (!cfg || typeof cfg !== 'object') continue;
        driverSlots[slot] = {
          kind: String(cfg.kind ?? 'script'),
          role: (typeof cfg.role === 'string' && cfg.role.trim()) ? cfg.role.trim() : null,
          hasHealthCheck: typeof cfg.healthCheck === 'string' && cfg.healthCheck.trim() !== '',
          hasDesc: typeof cfg.desc === 'string' && cfg.desc.trim() !== '',
        };
      }
      // 把存量写法（没写 role 但槽位正叫 database）也标成 role，使这一行与 `dbDriver`
      // 的结论一致：两处对“谁是库通道”给不同答案时，写保护绑的与门禁认的就不是同一个槽位。
      const dbSlotName = b.dbDriver ? b.dbDriver.slot : null;
      if (dbSlotName && driverSlots[dbSlotName]) driverSlots[dbSlotName].role = DB_ROLE_NAME;
      const driverSlotCount = Object.keys(driverSlots).length;
      payload.preflight = {
        blocking: false,
        delivery,
        ...facts,
        driverSlots,
        driverSlotCount,
        // 纯代码模式（一个源都没接）要能报成“0 个”，而不是“探测过了但没结果”。
        dbDriverSlot: dbSlotName,
        dirtyFiles: dirtyTruncated ? dirtyAll.slice(0, PREFLIGHT_DIRTY_CAP) : dirtyAll,
        dirtyTruncated,
        dirtyNote: dirtyTruncated
          ? `脏文件清单已截断（只列前 ${PREFLIGHT_DIRTY_CAP} / 共 ${dirtyAll.length}）：` +
            '“脏文件是否命中本次计划内文件”因此不可靠，supperH-bug-dev 应用前必须对自己要改的每个路径跑 ' +
            '`git status --porcelain -- <path>` 逐个复核（在白名单内）'
          : null
      };
      // status 此刻必为 0（res.ok）：预检不参与分流，这一行不反映后续门禁结论。
      logFastPathAttempt(b.privateRoot, {
        stage: 'preflight',
        project: b.code,
        status: exitCode,
        deliveryMode: delivery.mode,
        deliveryDeclared: delivery.declared,
        deliveryClamped: delivery.clamped,
        deliverySupported: delivery.supported,
        snapshotTtlDays: delivery.snapshotTtlDays,
        gitAvailable: facts.available,
        branch: facts.branch,
        detached: facts.detached === true,
        hasCommits: facts.hasCommits === true,
        dirtyKnown: facts.dirtyKnown === true,
        dirtyCount: facts.dirtyCount,
        snapshotPossible: facts.snapshotPossible === true,
        dbDriverDeclared: !!b.dbDriver,
        driverSlotsDeclared: driverSlotCount,
        dirtyListed: payload.preflight.dirtyFiles.length,
        sweepRan: facts.snapshotSweep?.ran === true,
        sweepRemoved: (facts.snapshotSweep?.removed || []).length,
        sweepKept: facts.snapshotSweep?.kept ?? 0,
        sweepFailed: (facts.snapshotSweep?.failed || []).length,
        wall_time_ms: Date.now() - startedAt
      });
    }

    if (res.ok && moduleName && !envVoid) {
      const b = res.binding;
      const fresh = readFreshness({
        contextRoot: b.contextRoot, module: moduleName, effectiveRoot: b.effectiveRoot
      });
      payload.freshness = fresh;
      // Reuse the HEAD that freshness already fetched; `undefined` means "freshness
      // never got far enough to know" and lets the gate resolve it itself.
      const knownHead = fresh && fresh.available ? (fresh.headCommit ?? null) : undefined;

      if (gap) {
        // Incomplete pair (trailing `--anchor`, or `--text` without `--anchor`, …):
        // never fall through to 0 - the caller reads that as "go F2 with this anchor".
        bail(gap);
      } else if (intentGap) {
        // 参数层面的 I0 缺口：同属 36（该修的是调用方），绝不能走成 40 去问用户。
        bail(intentGap);
      } else if (anchorSeen) {
        // L2 覆盖已接线：projects/<code>.yaml 的 fastPath 段（schema 已声明）。
        // enabled 在所有 I/O 之前短路；预算只允许收紧（gate 内部夹到 HARD_CAPS）。
        const fp = (b.project && b.project.fastPath) || {};
        // I0 入参取数。解不开时记为"结构不可用"而不是"没给"：静默降级等于把整道
        // 意图门禁作废，而 PowerShell 吃引号/换行时它偏偏最常以这种形态发生。
        let intentValue;
        let intentParseErr = null;
        if (intentInline !== undefined || intentFile !== undefined) {
          try {
            const raw = intentInline !== undefined ? intentInline : fs.readFileSync(path.resolve(intentFile), 'utf8');
            intentValue = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
          } catch (e) { intentParseErr = e && e.message ? e.message : String(e); intentValue = undefined; }
        }
        const gate = evaluateFastPath({
          contextRoot: b.contextRoot,
          module: moduleName,
          anchor,
          text,
          effectiveRoot: b.effectiveRoot,
          headCommit: knownHead,
          enabled: fp.enabled !== false,
          limits: { maxDiffLines: fp.maxDiffLines, maxFiles: fp.maxFiles },
          allowAnchorKinds: Array.isArray(fp.allowAnchorKinds) ? fp.allowAnchorKinds : null,
          intent: intentValue,
          anchorSource: anchorSource()
        });
        if (intentParseErr !== null) {
          gate.intentParseError = intentParseErr;
          if (gate.status === EXIT.INCOMPLETE) {
            // 把真实原因顶到 message 前部：门禁的笼统文案会把人引向"去问用户"，
            // 而这里该修的是传参方式——改走 --intent-report 就绕开了 shell 转义。
            gate.message = `--intent-* 内容解析失败（${intentParseErr}），I0 无法求值；` +
              `改用 --intent-report <文件> 可避开 shell 吃引号/换行。原信息：${gate.message}`;
          }
        }
        payload.fastPath = gate;
        exitCode = gate.status;
        logFastPathAttempt(b.privateRoot, {
          stage: 'anchor_gate',
          project: b.code,
          module: moduleName,
          anchorKind: gate.anchorKind,
          anchor: String(anchor).slice(0, 120),
          textGiven: typeof text === 'string' && text.trim() !== '',
          status: gate.status,
          eligible: gate.eligible,
          gates: gate.gates,
          veto: (gate.veto || []).map((v) => v.id),
          route: gate.anchorResolved?.route ?? null,
          level: gate.anchorResolved?.level ?? null,
          // G4b 收益唯一的数据来源：没这两项就只能凭感觉判断"快路径还活着吗"。
          // additive 字段，不影响任何现有消费方。
          batch: gate.anchorResolved?.batch ?? null,
          g4b: gate.g4b ?? null,
          budget: gate.budget ?? null,
          needsLookup: gate.needsLookup === true,
          // I0 收益唯一数据来源：没这块就答不了"意图复述到底拦下了多少"，
          // 以及高频出现的"40 是不是在误拦"无从核对。短路时也要记（ran 随求值与否），
          // 否则分母缺一块，以后据此调参会偏乐观。
          intentGiven: intentSeen,
          intent: gate.intent
            ? {
              ran: true,
              ok: gate.intent.ok,
              slots_missing: gate.intent.slots_missing,
              quotes_total: gate.intent.quotes_total,
              quotes_verified: gate.intent.quotes_verified,
              problems: gate.intent.problems.length
            }
            : { ran: false, parse_error: intentParseErr !== null },
          anchorSource: anchorSource(),
          // 两个基线都要可统计：只记代码侧的话，“这条结论取于哪个环境”只能事后靠人回忆
          diagnoseEnv: envSeen ? (String(envName ?? '').trim() || null) : null,
          wall_time_ms: Date.now() - startedAt
        });
      }
    } else if (res.ok && gateAsked && !envVoid) {
      // Gate requested without a usable --module: nothing was evaluated, so 0 is not on the table.
      bail(gap ?? intentGap ?? '门禁入参不完整，未求值');
    }

    // ---- G5：影响半径由脚本判定，不再交给编排者读一句文字约定自行判断 ----
    // scopeSeen 也要进这个块：只圈范围不回灌 = 越界没人校，这是调用方的 bug，
    // 落在块外会被读成“没申请 G5 → 退出码不变”，那正是要防的静默放行。
    if (res.ok && (impactAsked || scopeSeen) && !envVoid) {
      const gatePassed = !gateAsked || exitCode === EXIT.PASS;
      if (!gatePassed) {
        // 锚点门禁已出局：G5 无需求值，但仍记下原因，账本能区分“没判”与“判了不过”。
        payload.impact = {
          status: exitCode, applied: false, narrow: false, code: null,
          checks: {}, problems: ['锚点门禁未通过，G5/scope 不求值（整单落完整路径）']
        };
      } else if (impactGap) {
        bailImpact(impactGap);
      } else if (scopeGap) {
        bailImpact(scopeGap);
      } else {
        let report = null;
        let parseErr = null;
        try {
          const raw = impactInline !== undefined
            ? impactInline
            : fs.readFileSync(path.resolve(impactFile), 'utf8');
          report = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
        } catch (e) { parseErr = e && e.message ? e.message : String(e); }
        const expectedRoute = payload.fastPath?.anchorResolved?.route ?? null;
        const imp = parseErr
          ? { status: EXIT.INCOMPLETE, narrow: false, code: null, checks: { shape: 'fail' },
              problems: [`impact 回报 JSON 解析失败：${parseErr}（shell 引号/$ 吃掉参数时就是这个形态）`] }
          : verifyImpactReport(report, { expectedRoute, scopeRoots });
        payload.impact = { ...imp, applied: true };
        exitCode = imp.status;
        logImpact(payload.impact);
      }
    }

    emit();
  } catch (e) {
    // Any escape hatch from here must still speak the invariant: never 0.
    payload = payload && typeof payload === 'object' ? payload
      : { ok: false, status: EXIT.INCOMPLETE, cwd, message: 'resolve-project 内部异常' };
    bail('门禁内部异常：' + (e && e.message ? e.message : String(e)));
    emit();
  }
}
