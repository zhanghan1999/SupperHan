// scripts/init-project.mjs
// /supperH-init deterministic backend: scan a workspace, (optionally) write a
// per-project registry entry, and enforce a ">=1 connection reachable" gate.
//
// Two modes:
//   --scan  --cwd <abs>                READ-ONLY. Emits a JSON scan plan to
//                                      stdout so the command layer can prefill
//                                      the derivable fields and only ASK the
//                                      user for the non-derivable private ones
//                                      (db host/port/users, log endpoints ...).
//   --write --cwd <abs> [--values <f>] [--force]
//                                      Builds projects/<code>.yaml from the
//                                      example template + scan + collected
//                                      values, runs the connectivity gate, and
//                                      — only on pass (or --force) — writes the
//                                      file and mkdirs context/<code> tasks/<code>,
//                                      then verifies the resolver now matches.
//
// The same run decides call channels mechanically: a `kind: mcp` slot whose shell
// plumbing probe fails is written back as `kind: script` (unless it declares
// `fallback: none`), so no later session has to guess whether MCP is available - and
// no session re-probes. Gates still come only from local script exit codes (R3.5).
//
// Exit codes (write mode is the hard gate):
//   0  wrote + resolver matches
//   2  bad args / template missing / write error / 接入声明不完整（选了某个外部源却没给全它的必填值）
//   20 connectivity gate FAILED (>=1 configured driver unreachable) — rerun with
//      --force to downgrade to a warning
//   21 wrote but resolver still does not match cwd (binding bug)
//   22 menu source missing on FIRST registration (values['menu.source'] empty
//      and menus/<code>.yaml absent) — NOT bypassable by --force
//
// Not connecting anything is a legitimate answer, not an error: `connect` and the db.*
// values are all optional. Choosing nothing writes a config with those sections removed
// (pure-code mode) — see applyConnectionChoices, and F-7 for why a skipped value must
// never fall back to the template's example_* literals.
import fs   from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { resolvePrivateRoot } from './resolve-private-root.mjs';
import { resolveProject, expandDrivers } from './resolve-project.mjs';
import { validateAgainstSchema } from './validate-project.mjs';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function log(...a) { console.error('[init]', ...a); }
function die(msg, code = 2) { log(msg); console.log(JSON.stringify({ ok: false, error: msg })); process.exit(code); }

// ---- sanitise a candidate code to the registry's filename-safe form ----
function slug(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
}

// ---- git branch list (best-effort; empty on any failure) ----
function gitBranches(cwd) {
  try {
    const r = spawnSync('git', ['-C', cwd, 'branch', '-a', '--format=%(refname:short)'],
      { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) return [];
    return [...new Set(String(r.stdout || '').split(/\r\n?|\n/).map(s => s.replace(/^origin\//, '').trim()).filter(Boolean))];
  } catch { return []; }
}

// ---- find packageRoot by walking src/main/java for the java package path ----
function detectPackageRoot(cwd) {
  const base = path.join(cwd, 'src', 'main', 'java');
  if (!fs.existsSync(base)) return null;
  const SEG_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  const parts = [];
  let cur = base;
  // descend while a directory has exactly one java-ish sub-package and no .java files here
  for (let depth = 0; depth < 12; depth++) {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { break; }
    const dirs = entries.filter(e => e.isDirectory() && SEG_RE.test(e.name));
    const hasJava = entries.some(e => e.isFile() && e.name.endsWith('.java'));
    if (hasJava || dirs.length !== 1) break;
    parts.push(dirs[0].name);
    cur = path.join(cur, dirs[0].name);
  }
  return parts.length ? parts.join('.') : null;
}

// ---- 工具/构建产物目录：永远不是源码模块，也不是学习输入 ----
const SKIP_DIRS = new Set([
  'node_modules', 'target', 'build', 'dist', 'out', 'bin', 'generated-sources',
  'generated-src', 'coverage', 'logs', '__pycache__',
]);
function isToolDir(name) {
  // 点开头一律排除：.git / .idea / .worktrees / .opencode 都不是模块目录。
  // 旧实现把目录名直接交给 slug()，前导点被吃掉，于是 .worktrees 就变成了“模块 worktrees”。
  if (!name || name.startsWith('.')) return true;
  return SKIP_DIRS.has(name.toLowerCase());
}

// ---- controller 目录的归属模块：往上找第一个直接拥有 src/main/java 的祖先 ----
// 返回值：'' = codeRoot 自己就是模块根（单模块仓）；null = 没找到归属（不当模块）。
function ownerDirOf(ctrlDir, base) {
  const root = path.resolve(base);
  let cur = path.dirname(ctrlDir);
  while (cur && cur !== root && cur.startsWith(root)) {
    if (fs.existsSync(path.join(cur, 'src', 'main', 'java')))
      return path.relative(root, cur).split(path.sep).join('/');
    cur = path.dirname(cur);
  }
  return fs.existsSync(path.join(root, 'src', 'main', 'java')) ? '' : null;
}

// ---- 模块清单：maven <modules>（权威目录名）+ 真实 controller 位置 ----
// 返回 [{name, dir, controllersSeen}]：dir 是**相对 codeRoot 的真实目录路径**（可多级），
// name 是它的文件名安全短码。entryPattern 必须用 dir 而不是 name —— 多模块仓的 Java 源码
// 在 <codeRoot>/<module>/src/main/java 下，写成 codeRoot 相对的 pattern 会永远匹配不到。
function detectModules(cwd) {
  const mods = new Map();
  const add = (dir, controllers) => {
    const d = String(dir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (d && d.split('/').some(isToolDir)) return;            // 工具目录不配当模块（d 为空 = codeRoot 自己，合法）
    const name = slug(d) || (d ? 'module-' + (mods.size + 1) : 'app');  // 非 ASCII 目录名：slug 会清空，给占位短码但保留真 dir
    const cur = mods.get(name) || { name, dir: d || null, controllersSeen: false };
    if (controllers) cur.controllersSeen = true;
    mods.set(name, cur);
  };
  // 1) maven 多模块清单（<module> 可写多级相对路径）
  const pom = path.join(cwd, 'pom.xml');
  if (fs.existsSync(pom)) {
    const txt = fs.readFileSync(pom, 'utf8');
    const m = txt.match(/<modules>([\s\S]*?)<\/modules>/);
    if (m) for (const d of m[1].matchAll(/<module>([^<]+)<\/module>/g)) {
      const rel = path.relative(cwd, path.resolve(cwd, String(d[1]).trim().replace(/[\\/]+$/, '')))
        .split(path.sep).join('/');
      if (!rel || rel.startsWith('..')) continue;              // 越界模块（../shared）不进清单
      add(rel, false);
    }
  }
  // 2) 真走到 controller 包：给 1) 补 controllersSeen，并兜住没有 pom 的仓
  (function walk(dir, depth) {
    if (depth > 8) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || isToolDir(e.name)) continue;
      const full = path.join(dir, e.name);
      if (/^(controller|controllers|web)$/i.test(e.name)
          && /[\\/]src[\\/]main[\\/]java[\\/]/.test(path.sep + path.relative(cwd, full))) {
        const owner = ownerDirOf(full, cwd);
        if (owner !== null) add(owner, true);
      }
      walk(full, depth + 1);
    }
  })(cwd, 0);
  return [...mods.values()].slice(0, 40);
}

// ---- 模块自己的入口 glob（相对 effectiveRoot = codeRoot）----
export function entryPatternOf(m) {
  const head = m.dir ? m.dir + '/' : '';
  return m.controllersSeen
    ? head + 'src/main/java/**/controller/*.java'   // 真看到 controller 包：精确
    : head + 'src/main/java/**/*.java';             // 只有 pom：给超集，不给空匹配
}

// ---- 多模块仓的 packageRoot 候选（只看 codeRoot 一层永远探不到）----
// 只输出候选 + 交集，不拿它们当结论写盘：一个模块探到的“最深单链”可能比真正的基础包多跑一层，
// 写错比写一个一眼假的 com.example.app 更危险（后者会逼人回答，前者不会）。
function detectPackageRootCandidates(cwd, mods) {
  const bases = mods.length ? mods.map(m => path.join(cwd, m.dir || '')) : [cwd];
  const chains = [];
  let rooted = 0;   // 有几个模块真的拥有 src/main/java
  let hits = 0;     // 其中有几个能得出单一包链
  for (const b of bases) {
    if (!fs.existsSync(path.join(b, 'src', 'main', 'java'))) continue;
    rooted++;
    const p = detectPackageRoot(b);
    if (!p) continue;                                        // 第一层就分叉（com/org/cn 并存）：没有单一包链
    hits++;
    if (chains.some(c => c.packageRoot === p)) continue;
    const rel = path.relative(cwd, b).split(path.sep).join('/');
    chains.push({ packageRoot: p, module: rel || null });
    if (chains.length >= 5) break;
  }
  let common = chains.length ? chains[0].packageRoot.split('.') : [];
  for (const c of chains.slice(1)) {
    const parts = c.packageRoot.split('.');
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  // 只有一部分模块探到包链时，那个交集不是“项目的 packageRoot”，只是“探到的那几个的公共前缀”。
  // 拿它当结论会少掉分叉模块（实测：多顶层包仓库 com/org/cn 并存），所以直返 null 让人回答。
  const trustworthy = rooted > 0 && hits === rooted;
  return {
    candidates: chains,
    common: trustworthy && common.length ? common.join('.') : null,
    partial: chains.length > 0 && !trustworthy,
  };
}

// ---- best-effort menu-source candidates (prefill only; user still confirms) ----
function detectMenuCandidates(cwd) {
  const out = [];
  const seen = new Set();
  function add(format, full) {
    const rel = path.relative(cwd, full).replace(/\\/g, '/');
    if (seen.has(rel)) return;
    seen.add(rel);
    out.push({ kind: 'code', path: rel, format });
  }
  function walk(dir, depth) {
    if (depth > 6) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (isToolDir(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      const lower = e.name.toLowerCase();
      if (/^(menu|menus).*\.json$/.test(lower)) { add('json', full); continue; }
      if (lower.endsWith('.sql')) {
        try { if (/\bsys_menu\b/i.test(fs.readFileSync(full, 'utf8'))) add('sql', full); } catch { /* unreadable */ }
        continue;
      }
      if (/^(router|routes?)\.(js|ts|json)$/.test(lower)) add('router', full);
    }
  }
  walk(cwd, 0);
  return out.slice(0, 20);
}

// ---- scan a workspace into a prefill plan ----
export function scanProject(cwd) {
  const abs = path.resolve(cwd || process.cwd());
  const build = { tool: 'unknown', jdk: null };
  if (fs.existsSync(path.join(abs, 'pom.xml'))) build.tool = 'maven';
  else if (fs.existsSync(path.join(abs, 'build.gradle')) || fs.existsSync(path.join(abs, 'build.gradle.kts')) || fs.existsSync(path.join(abs, 'settings.gradle'))) build.tool = 'gradle';

  const packageRoot = detectPackageRoot(abs);

  // derive code: pom artifactId (project-level) > settings rootProject.name > dir name
  let code = null;
  const pom = path.join(abs, 'pom.xml');
  if (fs.existsSync(pom)) {
    const txt = fs.readFileSync(pom, 'utf8');
    // project-level artifactId = one not inside <parent>
    const noParent = txt.replace(/<parent>[\s\S]*?<\/parent>/g, '');
    const a = noParent.match(/<artifactId>([^<]+)<\/artifactId>/);
    if (a) code = slug(a[1]);
  }
  if (!code) {
    const sg = path.join(abs, 'settings.gradle');
    if (fs.existsSync(sg)) {
      const r = fs.readFileSync(sg, 'utf8').match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
      if (r) code = slug(r[1]);
    }
  }
  if (!code) code = slug(path.basename(abs));

  const mods = detectModules(abs);
  const branches = gitBranches(abs);
  // 探测到的与猜出来的必须分得开。旧形态：没命中时 pickBranch 回一个形似名字（release-main /
  // staging / develop），靠下游 branchesDetected 标记 + 模板同名字面值“侥幸”不落盘。
  // 现在直接不给名字：未检出 = null，所以任何下游（命令层复述、--values 回灌、测试）
  // 都拿不到一个可以当事实用的字符串 —— 不存在的值比标了“未检出”的假值更难被误用。
  const pickBranch = (re) => {
    const hit = branches.find(b => re.test(b));
    return hit ? { name: hit, detected: true } : { name: null, detected: false };
  };
  const bp = pickBranch(/^(main|master|release.*)$/i);
  const bu = pickBranch(/^(staging|uat|pre.*)$/i);
  const bd = pickBranch(/^(develop|dev|feature.*)$/i);
  const detected = { prod: bp.detected, uat: bu.detected, dev: bd.detected };

  // 没有 pom 也没有 controller 包时给一个兜底模块（dir=null → codeRoot 相对）
  const modulePlans = (mods.length ? mods : [{ name: 'app', dir: null, controllersSeen: false }])
    .map(m => ({ ...m, entryPattern: entryPatternOf(m) }));
  const pkgCands = packageRoot
    ? { candidates: [], common: null, partial: false }
    : detectPackageRootCandidates(abs, mods);

  return {
    ok: true,
    cwd: abs,
    code,
    codeRoot: abs,
    build,
    packageRoot: packageRoot || 'com.example.app',
    packageRootDetected: !!packageRoot,
    // 探不到时只**列候选**，不替用户定：detected 仍为 false，命令层必须问。
    packageRootCandidates: pkgCands.candidates,
    packageRootCommon: pkgCands.common,
    // true = 探到了包链但只覆盖部分模块（多顶层包并存），不能当 packageRoot 用
    packageRootPartial: pkgCands.partial,
    modules: modulePlans.map(m => m.name),
    modulePlans,
    modulesDetected: mods.length > 0,
    branches: {
      prod: bp.name,
      uat:  bu.name,
      dev:  bd.name,
    },
    branchesDetected: detected,
    // 没探测到的分支只能问用户（和 db.* 一样归入“必须问”清单）；答不出就不写该键。
    // 它不是“必须存在”：branches 在 schema 里可选，缺席 = 未登记分支映射（F-8）。
    branchesNeedsUserInput: BRANCH_KEYS.filter(k => !detected[k]),
    // ---- 外部数据源：可选，不是注册硬前置（F-7），且**槽位名单不由 L1 决定**（F-11）----
    // 命令层拿这几组字段问**一次多选**：一个都不选 = 纯代码模式（落盘时 db/drivers 整段不写）。
    // 旧形态只有 needsUserInput，且它在 commands/supperH-init.md 里被读成了"必答清单"——
    // 语义本来是"禁止脚本猜"，但字段名分不清"必须问"与"必须有"，于是"不接"这个合法答案
    // 只能落成 db.example.internal / example_prod 这种看着像配置的假值。
    // 这里曾经返回 connectSlots: [四个写死的名字]，命令层照着摆菜单 —— 那等于把"一个项目最多
    // 接四种外部源"当成了通用契约，第五种源在 schema 阶段就被拒。init 现在只回答两件事：
    // 名字怎么起算合法、库信息挂到哪个槽位。真要加源走 /supperH-driver（可多次添加）。
    connectNaming: { pattern: SLOT_KEY_RE.source, maxLength: 40, dbSlotDefault: DB_SLOT_NAME },
    connectDefault: [],                     // 无默认值，一个都不自动接
    dbFieldsIfConnected: DB_VALUE_KEYS,     // 接了库才需要问；没接则一律不问
    driverFieldsIfConnected: ['desc', 'impl', 'healthCheck'],   // 每个自定义槽位至少要这三项
    // 兼容旧字段名（命令层若还在读它，语义 = 接 database 时禁止脚本猜的字段）
    needsUserInput: DB_VALUE_KEYS.slice(),
    // menu-learning source: always ask on first registration (no default, not skippable)
    menuCandidates: detectMenuCandidates(abs),
    menuNeedsUserInput: ['menu.source'],
  };
}

// ---- 环境键清单：schema 的 branches.properties 只允许这三个（additionalProperties: false）----
// 三处使用者（扫描 / 覆盖 / 落盘与汇报）必须同一份，否则会出现“扫得到却永不落盘”的第四种键。
const BRANCH_KEYS = ['prod', 'uat', 'dev'];

// ---- 用户改则以用户为准 ----
// supperH-init.md 结尾早就写了“结构字段扫描值是候选，用户改则以用户为准”，但旧实现只认
// 扫描值：即使命令层问了用户，答案也落不了盘，只能事后再手改 yaml（= 静默丢掉用户输入）。
// 这里把承诺接上：code / codeRoot / packageRoot / modules / branches.* 都可被 --values 覆盖。
export function applyStructuralOverrides(plan, values) {
  const v = values || {};
  const p = { ...plan, branches: { ...plan.branches }, branchesDetected: { ...plan.branchesDetected } };
  if (v.code && slug(v.code)) p.code = slug(v.code);          // code 同时是目录名/文件名，必须在算 target 前改
  if (v.codeRoot && path.isAbsolute(String(v.codeRoot))) p.codeRoot = path.resolve(String(v.codeRoot));
  if (v.packageRoot) { p.packageRoot = String(v.packageRoot); p.packageRootDetected = true; }
  if (v.modules) {
    const list = (Array.isArray(v.modules) ? v.modules : String(v.modules).split(/[,\uff0c]/))
      .map(s => slug(String(s).trim())).filter(Boolean);
    if (list.length) {
      const known = new Map((p.modulePlans || []).map(mm => [mm.name, mm]));
      p.modulePlans = list.map(n => known.get(n) || {
        name: n, dir: null, controllersSeen: false,
        // 用户新给的名字：只有 codeRoot 下真存在同名目录才能拼出模块前缀
        entryPattern: fs.existsSync(path.join(p.codeRoot, n))
          ? n + '/src/main/java/**/*.java' : 'src/main/java/**/*.java',
      });
      p.modules = p.modulePlans.map(mm => mm.name);
    }
  }
  for (const k of BRANCH_KEYS) {
    if (v['branches.' + k]) {
      p.branches[k] = String(v['branches.' + k]);
      p.branchesDetected[k] = true;                            // 用户给的就不是“猜的”了
    }
  }
  return p;
}

// ---- branches 段：整段重建，而不是逐行改写（F-8）----
// 为什么不用 setBranch 那种行内替换：它只能改写已存在的键，没检出的键就会沿用模板值，
// “没问到”在盘上就长得和“这个项目确实有这个分支”一模一样。整段重建天然没这个歧义，
// 也不会串台到 db.schemas（两处都有 prod/uat/test）。全未检出 = dropSection。
export function applyBranchSection(text, plan) {
  const rows = BRANCH_KEYS
    .filter(k => plan?.branchesDetected?.[k] && isGiven(plan?.branches?.[k]))
    .map(k => `  ${k}: ${yqv(plan.branches[k])}`);
  if (!rows.length) return dropSection(text, 'branches');
  return replaceSection(text, 'branches', ['branches:', ...rows].join('\n'));
}

/** 本次落盘的分支映射概况（只供命令层原样复述，不参与任何分流，不改退出码）。 */
export function branchMappingOf(plan) {
  const has = (k) => !!plan?.branchesDetected?.[k] && isGiven(plan?.branches?.[k]);
  const declared = BRANCH_KEYS.filter(has);
  return {
    declared: declared.map(k => `${k}=${String(plan.branches[k]).trim()}`),
    undeclared: BRANCH_KEYS.filter(k => !has(k)),
    note: declared.length ? null
      : '本项目未登记任何分支映射（未检出且用户未答）：--env 的合法环境名只剩 db.schemas 那一侧，一个都没时一律 36',
  };
}

// ---- identity.workspaces：必须真写进去 ----
// 旧实现写的是 `out.replace(/^identity:[ \t]*\r?\n/, ...)` —— 没有 m 标志，`^` 只能匹配字符串开头，
// 而 identity: 在模板里是第 8 行，所以这个注入**从未生效**：init 写出的 yaml 根本不带 workspaces，
// 解析器只能靠 codeRoot 匹配 cwd（工作区开的不是仓根就 exit 10）。
function setWorkspaces(text, root) {
  const eol   = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => /^identity:[ \t]*$/.test(l));
  if (start < 0) return text;
  let end = start + 1;
  while (end < lines.length && /^[ \t]+\S/.test(lines[end])) end++;            // identity 块 = [start+1, end)
  let wsAt = -1;
  for (let i = start + 1; i < end; i++) if (/^[ \t]*workspaces:/.test(lines[i])) { wsAt = i; break; }
  // YAML 单引号：反斜杠按字面处理。双引号里 `C:\Users\...` 会被当转义序列（BAD_DQ_ESCAPE），
  // 整个 L2 文件直接解析失败 → 项目注册成功但永远读不出来。
  const item = '    - \'' + String(root).replace(/'/g, "''") + '\'';
  const block = ['  workspaces:', item];
  if (wsAt < 0) { lines.splice(start + 1, 0, ...block); return lines.join(eol); }
  let wsEnd = wsAt + 1;
  while (wsEnd < end && /^[ \t]+-[ \t]/.test(lines[wsEnd])) wsEnd++;         // 吃掉原有列表项（不堆重复键）
  lines.splice(wsAt, wsEnd - wsAt, ...block);
  return lines.join(eol);
}

// ---- db.forbidWriteSchemas 必须跟着 db.schemas 的实际值走 ----
// 模板里这一节写死 example_prod / example_uat，而旧实现只替换 db.schemas.*。结果：注册完成后
// 真实生产库名根本不在禁写清单里 —— driver 的 ReadOnlyGuard 与 bug-dev 的 DB 门禁对 prod/uat
// 形同虚设（写错库不会报错，只会静默放行）。清单看着齐备但一条都不命中，是最危险的失败形态。
// export 只为测试：这段文本级手术必须能单独断言，不必跑完整个 initWrite。
export function syncForbidWriteSchemas(text) {
  const eol   = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const clean = (s) => String(s == null ? '' : s).trim().replace(/^['"]|['"]$/g, '');
  const sIdx = lines.findIndex(l => /^[ \t]+schemas[ \t]*:/.test(l));
  if (sIdx < 0) return text;
  const got = {};
  const flow = lines[sIdx].match(/\{([^}]*)\}/);
  if (flow) {
    for (const kv of flow[1].split(',')) { const i = kv.indexOf(':'); if (i > 0) got[clean(kv.slice(0, i))] = clean(kv.slice(i + 1)); }
  } else {
    for (let i = sIdx + 1; i < lines.length && /^[ \t]+\S/.test(lines[i]); i++) {
      const m = lines[i].match(/^[ \t]+(\w+)[ \t]*:[ \t]*(.*)$/);
      if (m) got[m[1]] = clean(m[2]);
    }
  }
  const want = [...new Set([got.prod, got.uat].filter(Boolean))];
  const fIdx = lines.findIndex(l => /^[ \t]*forbidWriteSchemas[ \t]*:/.test(l));
  if (!want.length || fIdx < 0) return text;
  const ind = lines[fIdx].match(/^[ \t]*/)[0];
  let end = fIdx + 1;
  while (end < lines.length && /^[ \t]+-[ \t]/.test(lines[end])) end++;   // 吃掉原有条目（不堆重复键）
  const block = want.map(n => ind + '  - \'' + n.replace(/'/g, "''") + '\'');
  lines.splice(fIdx, end - fIdx, lines[fIdx].replace(/:.*$/, ':'), ...block);
  return lines.join(eol);
}

// ---- 接入清单（F-7）：接不接外部数据源由用户决定，脚本只负责"不接就别造假值" ----
// 两条规则：
//   不接 → 该段从落盘文本里**整段删掉**（缺席 = 纯代码模式，语义明确，运行期读到就能直接回答"没接"）；
//   接   → 该段所有必填值必须真给出来，缺一项在写盘之前就退 2（不补默认值、不保留模板值）。
// 旧实现是 `setLine` 见空值就 return，于是模板的 example_* 原样留在 projects/<code>.yaml 里：
// 结构合法、validate 退 0、连通门禁因"0 个已配置驱动"自动放行 —— 三份机制全都看不出它没被配好。
const DB_VALUE_KEYS = ['db.host', 'db.port', 'db.schemas.prod', 'db.schemas.uat', 'db.schemas.test',
                       'db.readonlyUser', 'db.writableUser'];
// ---- 槽位名归用户（F-11）----
// 这里曾写着 `const DRIVER_SLOTS = ['database','logs','tickets','efficiency']`：那份名单把
// "一个项目最多接四种外部源"变成了 L1 契约，自定义槽位在 schema 阶段就退 2（实测
// `$.drivers.<自定义名>: additional property not allowed`），而 `tickets`/`efficiency` 本身
// 还是某家公司的产品类别（红线 R3 的 L2 泄漏）。现在键名只是标识符，唯一的语义承载是
// `role: database`（全项目最多一个）——它才是"这条通道发的 SQL 要过禁写清单"的判据。
const SLOT_KEY_RE  = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;   // 与 schemas/project.schema.yaml 的 patternProperties 同一判据
const DB_SLOT_NAME = 'database';   // 仅是"库信息没处挂靠时的默认名"，不携带特权：特权在 role
const DB_ROLE      = 'database';
const isGiven = (x) => x !== undefined && x !== null && String(x).trim() !== '';
const splitList = (raw) => (Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，]/))
  .map(s => String(s).trim()).filter(Boolean);
// 以下导出只给登记类入口复用（driver-registry.mjs）：槽位名判据与“人话描述”字段必须
// 只有一处定义，否则 init 与 /supperH-driver 会跑出不一致的门禁（同一个仓库已经栽过两次）。
export const SLOT_NAME_RE  = SLOT_KEY_RE;
export const DATABASE_ROLE = DB_ROLE;
export const DB_INFO_KEYS  = DB_VALUE_KEYS;

/**
 * 从收集到的 --values 算出"这次到底接了哪些外部源"，以及这个决定是否完整。
 * 槽位名由用户给：这里只判"名字合法吗 / 必填齐吗 / 数据库通道是谁"，不判"在名单里吗"。
 * 给了任意 db.* 值 = 要接库（隐式登记，不必再在 connect 里重复一遍）。
 * @returns {{connect:string[], dbConfigured:boolean, dbSlot:string|null, badNames:string[],
 *            dbMissing:string[], driverMissing:Object<string,string[]>, roleProblems:string[], ok:boolean}}
 */
export function planConnections(values) {
  const v = values || {};
  const declared = [...new Set(splitList(v.connect))];
  const dbConfigured = DB_VALUE_KEYS.some(k => isGiven(v[k]));
  const roleSlots = declared.filter(s => String(v[`drivers.${s}.role`] ?? '').trim() === DB_ROLE);
  const roleProblems = [];
  if (roleSlots.length > 1) {
    roleProblems.push(`${roleSlots.length} 个槽位同时标了 role: database（${roleSlots.join(', ')}）：写保护只能绑一个通道，两个就会不确定谁发 SQL，请只留一个`);
  }
  // 数据库通道归属：显式 role 优先；其次沿用键名 database（默认名，落盘时会补上显式 role，
  // 让生成的配置不依赖"靠名字猜语义"）。既不猜也不静默造源：
  //   只给了 db.*、一个槽位都没声明 → 挂靠默认名（该槽位不落盘，纯登记库信息，沿用 F-7 语义）；
  //   给了 db.* 且声明了若干槽位但没人标 role → 问回来，不挑一个看起来像的。
  let dbSlot = roleSlots[0] ?? (declared.includes(DB_SLOT_NAME) ? DB_SLOT_NAME : null);
  if (!dbSlot && dbConfigured) {
    if (!declared.length) { dbSlot = DB_SLOT_NAME; declared.push(DB_SLOT_NAME); }
    else roleProblems.push(`给了 db.* 但声明的槽位（${declared.join(', ')}）里没有标 role: database 的：哪个通道发 SQL 不能靠猜，请给其中一个补 drivers.<槽位>.role: database`);
  }
  if (dbSlot && !dbConfigured) {
    roleProblems.push(`drivers.${dbSlot} 标了 role: database 却没有任何 db.* 值：禁写清单（db.forbidWriteSchemas）拿不到库名，而空清单 = 任何库都不拦（写保护默认失效）`);
  }
  const badNames = declared.filter(s => !SLOT_KEY_RE.test(s));
  const dbMissing = dbConfigured ? DB_VALUE_KEYS.filter(k => !isGiven(v[k])) : [];
  const driverMissing = {};
  for (const slot of declared) {
    if (badNames.includes(slot)) continue;              // 名字本身不合法，再问字段没有意义
    const pre = `drivers.${slot}.`;
    const impl = v[pre + 'impl'], hc = v[pre + 'healthCheck'];
    const regOnly = !isGiven(impl) && !isGiven(hc);
    // 数据库通道允许"只登记库信息、暂不接驱动"（驱动文件晚点再放）：此时该槽位整段不落盘，一个字都不欠。
    // 其余槽位本身就是驱动，没驱动就没内容。
    if (regOnly && slot === dbSlot) continue;
    const need = isGiven(v[pre + 'desc']) ? [] : ['desc'];   // 人话描述：F-11 后唯一的"这个源是干什么的"来源
    if (regOnly) need.push('impl', 'healthCheck');
    else {
      if (!isGiven(impl)) need.push('impl');
      if (!isGiven(hc)) need.push('healthCheck');
      if (isGiven(v[pre + 'kind']) && String(v[pre + 'kind']).trim() === 'mcp' && !isGiven(v[pre + 'mcp.sources'])) {
        need.push('mcp.sources');         // 白名单为空 = 什么都取不到，比不给 kind 更糟
      }
    }
    if (need.length) driverMissing[slot] = need;
  }
  return {
    connect: declared,
    dbConfigured, dbSlot, badNames,
    unknown: badNames,                    // 旧字段名：一次改版周期内留给外部读取方，值同 badNames
    dbMissing, driverMissing, roleProblems,
    ok: !badNames.length && !dbMissing.length && !roleProblems.length && !Object.keys(driverMissing).length,
  };
}

/**
 * 菜单来源的完整性关（与 planConnections 同纪律）：光问“选了哪一支”不够，
 * 选了 database 却不答表名/列名时，模板里那套 `sys_menu` / `menu_id` / `path` 会原样留在
 * 落盘文件里 —— 结构合法、过 schema、没人读得出它从未被回答过（F-7 的同形缺陷）。
 * 而菜单这一路没有兼容网：`validate-project.mjs` 不读 `menus/*.yaml`，模板残留扫描也只盖 projects 条目。
 * 可选键（slot / order / rootParentId / extraFilter）不进必填清单：没答 = 删行 = 走缺省，不会留假值。
 */
export function planMenuChoices(values) {
  const v = values || {};
  const src = isGiven(v['menu.source']) ? String(v['menu.source']).trim() : null;
  if (!src) return { needed: false, ok: true, missing: [] };
  if (src !== 'database' && src !== 'code') {
    return { needed: true, ok: false, badSource: src, missing: [] };
  }
  const need = src === 'database'
    ? ['menu.database.table', 'menu.database.columns.id', 'menu.database.columns.parentId',
       'menu.database.columns.name', 'menu.database.columns.path']
    : ['menu.code.path', 'menu.code.format'];
  const missing = need.filter((k) => !isGiven(v[k]));
  return { needed: true, ok: !missing.length, source: src, missing };
}

// 未提供的值写空串而不是 'undefined'：空串被 schema 的 minLength:1 拦下（进而是 validate 退 2），
// 而 `host: 'undefined'` 会伪装成一个能用的主机名——那正是这一段要消灭的东西。
const yq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const yqv = (x) => yq(isGiven(x) ? String(x).trim() : '');
export { yq as yamlQuote, yqv as yamlQuoteOrEmpty };

function buildDbBlock(v) {
  const lines = [
    'db:',
    `  host: ${yqv(v['db.host'])}`,
    `  port: ${Number(v['db.port']) || 0}`,                       // 0 被 minimum:1 拦下，不能省行也不能写假端口
    '  schemas:',
    `    prod: ${yqv(v['db.schemas.prod'])}`,
    `    uat:  ${yqv(v['db.schemas.uat'])}`,
    `    test: ${yqv(v['db.schemas.test'])}`,
    `  readonlyUser: ${yqv(v['db.readonlyUser'])}`,
    `  writableUser: ${yqv(v['db.writableUser'])}`,
    '  forbidWriteSchemas: []',
  ];
  // 禁写清单只有一处实现：让 syncForbidWriteSchemas 按刚落盘的库名重建，不在这里再拼一遍
  return syncForbidWriteSchemas(lines.join('\n'));
}

/** 把一个槽位的字段列表渲染成 `  <slot>:` 开头的文本行（init 与 /supperH-driver 共用同一渲染顺序）。 */
export function buildDriversBlock(v, slots, dbSlot) {
  const out = ['drivers:'];
  for (const slot of slots || []) {
    const pre = `drivers.${slot}.`;
    const impl = v[pre + 'impl'], hc = v[pre + 'healthCheck'];
    if (!isGiven(impl) && !isGiven(hc)) continue;          // 只登记了 db 信息、没接驱动
    out.push(`  ${slot}:`);
    if (isGiven(v[pre + 'desc'])) out.push(`    desc: ${yqv(v[pre + 'desc'])}`);
    // role 由"谁是数据库通道"这个结论决定，而不是由键名长得像不像决定：落盘必带显式 role，
    // 否则下一个读配置的人只能靠 `database` 这个名字猜语义（F-11 收掉的正是这个隐性约定）。
    if (slot === dbSlot) out.push(`    role: ${DB_ROLE}`);
    if (isGiven(impl)) out.push(`    impl: ${yqv(impl)}`);
    if (isGiven(hc))   out.push(`    healthCheck: ${yqv(hc)}`);
    if (isGiven(v[pre + 'kind']))     out.push(`    kind: ${String(v[pre + 'kind']).trim()}`);
    if (isGiven(v[pre + 'fallback'])) out.push(`    fallback: ${String(v[pre + 'fallback']).trim()}`);
    const server = v[pre + 'mcp.server'], sources = v[pre + 'mcp.sources'];
    if (isGiven(server) || isGiven(sources)) {
      out.push('    mcp:');
      if (isGiven(server))  out.push(`      server: ${yqv(server)}`);
      if (isGiven(sources)) out.push('      sources: [' + splitList(sources).map(yqv).join(', ') + ']');
    }
    // 写能力声明：整段缺席 = 只读源（缺席即语义）。写了就把 action/gate 两行都显式落下去，
    // 缺哪项就写空串 —— 由 schema 的 enum 在 validate 阶段点名，不在这里二次判断以免规则漂移。
    const writes = Array.isArray(v[pre + 'writes']) ? v[pre + 'writes'] : [];
    if (writes.length) {
      out.push('    writes:');
      for (const w of writes) {
        const it = (w && typeof w === 'object') ? w : {};
        out.push(`      - action: ${yqv(it.action)}`);
        out.push(`        gate: ${yqv(it.gate)}`);
        if (isGiven(it.note))       out.push(`        note: ${yqv(it.note)}`);
        if (isGiven(it.userPhrase)) out.push(`        userPhrase: ${yqv(it.userPhrase)}`);
      }
    }
    const cfg = v[pre + 'config'];
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
      out.push('    config:');
      for (const [k, val] of Object.entries(cfg)) out.push(`      ${k}: ${yqv(val)}`);
    }
  }
  return out.length === 1 ? '' : out.join('\n');
}

const detectEol = (text) => (/\r\n/.test(text) ? '\r\n' : '\n');

function sectionRange(text, key) {
  // 段落 = 顶格键名行 + 紧随其后的缩进行（空行算段内，但段尾空行退回给下一段）。
  // 不用 YAML 解析再回写：那会把维护者写在模板里的注释全弄丢，而注释正是“这个字段为何不能留空”的载体。
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => new RegExp('^' + key + '[ \\t]*:').test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (/^[ \t]+\S/.test(lines[end]) || lines[end] === '')) end++;
  while (end > start + 1 && lines[end - 1] === '') end--;      // 段落后的空行留给下一段
  return { start, end, lines, eol };
}

function replaceSection(text, key, blockText) {
  const rng = sectionRange(text, key);
  // 段不存在（新模板把 db/drivers 写成注释形态）时追加到文件末尾：插入的换行必须跟随
  // 目标文件自己的 EOL，否则一份 CRLF 配置会混进 LF 行。
  if (!rng) {
    const eol = detectEol(text);
    return text.replace(/\s*$/, '') + eol + eol + blockText.split('\n').join(eol) + eol;
  }
  const next = [...rng.lines];
  next.splice(rng.start, rng.end - rng.start, ...blockText.split('\n'));
  return next.join(rng.eol);
}

function dropSection(text, key) {
  const rng = sectionRange(text, key);
  if (!rng) return text;
  const next = [...rng.lines];
  let start = rng.start, count = rng.end - rng.start;
  // 段前空行与段后空行同时存在时只领走一个：否则删完会留下连空两行（重复 init 时逐次累加）。
  if (start > 0 && next[start - 1] === '' && rng.end < next.length && next[rng.end] === '') { start--; count++; }
  next.splice(start, count);
  return next.join(rng.eol);
}

/**
 * 按接入清单重建 db / drivers 两段（不接 = 整段删除）。
 * export 只为测试：这两段的“删干不留假值”只能靠断言渲染文本锁住。
 */
export function applyConnectionChoices(text, values, conn) {
  const c = conn || planConnections(values);
  const v = values || {};
  let out = c.dbConfigured ? replaceSection(text, 'db', buildDbBlock(v)) : dropSection(text, 'db');
  const drivers = buildDriversBlock(v, c.connect, c.dbSlot);
  if (drivers) out = replaceSection(out, 'drivers', drivers);
  else out = dropSection(out, 'drivers');
  return out;
}

// ---- build the projects/<code>.yaml text from example + scan + values ----
// export 只为测试：落盘文本里“每个模块认自己的 entryPattern”与“branches 不能串台到 db.schemas”
// 都得真跑一遍渲染才能锁住，光测 scanProject 拦不住写回环节。
export function renderConfig(exampleText, plan, values) {
  const v = values || {};
  const setLine = (text, key, val, indent) => {
    if (val === undefined || val === null || val === '') return text;
    const ind = indent || '';
    const esc = String(val).replace(/"/g, '\\"');
    return text.replace(new RegExp(`^(${ind}\\s*${key}\\s*:\\s*).*?$`, 'm'), `$1"${esc}"`);
  };
  let out = exampleText;
  // identity + roots
  out = out.replace(/^codeRoot:\s*.*$/m, `codeRoot: ${plan.codeRoot}`);
  out = setLine(out, 'code', plan.code, '');
  out = setLine(out, 'displayName', v.displayName || plan.code, '  ');
  out = setLine(out, 'packageRoot', plan.packageRoot, '');
  out = setLine(out, 'tool', plan.build.tool, '  ');

  // db / drivers：由接入清单决定写还是整段删（见 applyConnectionChoices）
  out = applyConnectionChoices(out, v, plan.connections);

  // branches: 只重建真检出（或用户显式给的）那几个键；一个都没有 = 整段不写（F-8）。
  // 没把握的默认值不配被烤进配置：猜中也该让人看见，而不是长得象事实。
  out = applyBranchSection(out, plan);

  // workspaces: 绑定 cwd 供解析器匹配（写入方式见 setWorkspaces 为何不用行内正则）
  out = setWorkspaces(out, plan.codeRoot);

  // modules: 用扫描得到的逐个 entryPattern（每个模块认自己的目录）
  const plans = Array.isArray(plan.modulePlans) && plan.modulePlans.length
    ? plan.modulePlans
    : (plan.modules || []).map(n => ({ name: n, entryPattern: 'src/main/java/**/*.java' }));
  const modulesBlock = 'modules:\n'
    + plans.map(mm => `  - name: ${mm.name}\n    entryPattern: "${mm.entryPattern}"`).join('\n') + '\n';
  out = out.replace(/^modules:[\s\S]*?^(?=\S)/m, modulesBlock);

  return out;
}

// ---- build the menus/<code>.yaml text from menu.example + scan + values ----
// NOTE: uses EXACT-indent matching (unlike renderConfig's whitespace-tolerant
// regex) because `path` / `source` recur at different indent levels and a
// shallower indent anchored with `\s*` would swallow a deeper line.
//
// 两条“缺席即语义”规矩（与 §10.12 / §10.15 同纪律，都是 setLine “没答就不改写” 的推论）：
//  1) 未被选中的分支**整段删除**。旧实现只改写选中的那些行，于是 `source: code` 的项目
//     会把模板里完整的 database 段（sys_menu / menu_id / …）带回家；日后按 architecture.md
//     「换菜单来源只改这个文件」翻成 database 时，拿到的是一个长得像填好了、其实从没被回答过的表名列名。
//  2) 可选键没答就**删行**，不留模板示例值。最要紧的是 `menu.database.slot`：F-10 之后库槽位名
//     归用户，烤一个 `slot: database` 进去会让 /supperH-learn 去查一个本项目不存在的槽位（不报错，只是查不到）。
//     有明示缺省的键（`limit` = 5000、`database.source` = menu）不在删行之列 —— 那不是假值，是文档里的缺省。
const MENU_DROP_IF_ABSENT = [
  { key: 'slot', indent: '  ' },
  { key: 'order', indent: '    ' },
  { key: 'rootParentId', indent: '  ' },
  { key: 'extraFilter', indent: '  ' },
];

/** 删除一个顶格密钥所属的**整段**（含段内缩进行与属于它的注释行）。 */
function dropTopBlock(text, key) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const out = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^[^\s#]/.test(line)) skipping = line.startsWith(key + ':');
    if (!skipping) out.push(line);
  }
  return out.join(eol);
}

function renderMenuConfig(exampleText, plan, values) {
  const v = values || {};
  const setLine = (text, key, val, indent) => {
    if (val === undefined || val === null || val === '') return text;
    const ind = indent || '';
    const esc = String(val).replace(/"/g, '\\"');
    return text.replace(new RegExp(`^(${ind}${key}[ \\t]*:[ \\t]*).*?$`, 'm'), `$1"${esc}"`);
  };
  const dropLine = (text, key, indent) => {
    const ind = indent || '';
    return text.replace(new RegExp(`^${ind}${key}[ \\t]*:.*?\\r?\\n`, 'm'), '');
  };
  let out = exampleText;
  // identity + source
  out = setLine(out, 'project', plan.code, '');
  out = setLine(out, 'source',  v['menu.source'], '');
  // database branch
  out = setLine(out, 'slot',   v['menu.database.slot'],   '  ');
  out = setLine(out, 'source', v['menu.database.source'], '  ');
  out = setLine(out, 'table',  v['menu.database.table'],  '  ');
  out = setLine(out, 'id',       v['menu.database.columns.id'],       '    ');
  out = setLine(out, 'parentId', v['menu.database.columns.parentId'], '    ');
  out = setLine(out, 'name',     v['menu.database.columns.name'],     '    ');
  out = setLine(out, 'path',     v['menu.database.columns.path'],     '    ');
  out = setLine(out, 'order',    v['menu.database.columns.order'],    '    ');
  out = setLine(out, 'rootParentId', v['menu.database.rootParentId'], '  ');
  out = setLine(out, 'extraFilter',  v['menu.database.extraFilter'],  '  ');
  if (v['menu.database.limit'] !== undefined && v['menu.database.limit'] !== null && v['menu.database.limit'] !== '') {
    out = out.replace(/^(  limit[ \t]*:[ \t]*).*$/m, `$1${Number(v['menu.database.limit']) || v['menu.database.limit']}`);
  }
  // code branch
  out = setLine(out, 'path',   v['menu.code.path'],   '  ');
  out = setLine(out, 'format', v['menu.code.format'], '  ');
  // ---- 缺席即语义：没答的可选键删行，未被选中的分支删段 ----
  const optionalOf = {
    slot:         'menu.database.slot',
    order:        'menu.database.columns.order',
    rootParentId: 'menu.database.rootParentId',
    extraFilter:  'menu.database.extraFilter',
  };
  for (const { key, indent } of MENU_DROP_IF_ABSENT) {
    const val = v[optionalOf[key]];
    if (val === undefined || val === null || String(val).trim() === '') out = dropLine(out, key, indent);
  }
  const src = v['menu.source'];
  if (src === 'database') out = dropTopBlock(out, 'code');
  else if (src === 'code') out = dropTopBlock(out, 'database');
  return out;
}

// ---- build + self-validate the menus/<code>.yaml text ----
function buildMenuConfig(plan, values) {
  const exampleFile = path.join(TOOL_ROOT, 'schemas', 'menu.example.yaml');
  const schemaFile  = path.join(TOOL_ROOT, 'schemas', 'menu.schema.yaml');
  if (!fs.existsSync(exampleFile) || !fs.existsSync(schemaFile)) {
    return { ok: false, exitCode: 2, error: 'menu-template-missing' };
  }
  let exampleText = fs.readFileSync(exampleFile, 'utf8');
  if (exampleText.charCodeAt(0) === 0xFEFF) exampleText = exampleText.slice(1);
  const text = renderMenuConfig(exampleText, plan, values);
  let data;
  try { data = YAML.parse(text); }
  catch (e) { return { ok: false, exitCode: 2, error: 'menu-config-yaml-invalid: ' + e.message }; }
  const schema = YAML.parse(fs.readFileSync(schemaFile, 'utf8'));
  const errors = validateAgainstSchema(data, schema);
  if (errors.length) return { ok: false, exitCode: 2, error: 'menu-config-schema-invalid', errors };
  return { ok: true, text, data };
}

// ---- connectivity gate: run --health for each configured driver whose impl exists ----
// No pre-flight slot here (vpnPreCheck used to be one): a separate "is the network up"
// probe can only look at things that are not evidence - see docs/architecture.md §10.8.
// Each slot's own healthCheck is the probe, because only it speaks the real protocol.
const MCP_SHELL      = path.join(TOOL_ROOT, 'mcp-skeleton', 'shell.py');
const MCP_SHELL_REL  = 'mcp-skeleton/shell.py';

function runPy(file, args, privateRoot) {
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const r = spawnSync(py, [file, ...args], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, SUPPERH_PRIVATE_ROOT: privateRoot },
  });
  // A missing interpreter / timeout shows up as status===null (not a driver code).
  // Report it as unreachable with the reason in `detail`: an unreadable channel must
  // never read as "this data source has no data".
  const first = String(r.stdout || r.stderr || '').split(/\r\n?|\n/).find(l => l.trim()) || '';
  return {
    status: r.status,
    detail: first || (r.error ? r.error.code || String(r.error.message) : '') ||
            (r.signal ? 'killed by ' + r.signal + ' (timeout?)' : ''),
  };
}

/**
 * Rewrite `drivers.<slot>.kind` in the rendered text, keeping every other byte
 * (including comments) in place. YAML round-tripping through a parse+dump would
 * silently drop the operator notes that explain *why* a slot is on which channel.
 * Line endings are normalised to the dominant one in this file — the text here comes
 * straight out of renderConfig(), so it is uniform by construction.
 */
function setSlotKindInText(text, slot, kind) {
  const eol   = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => /^drivers:[ \t]*$/.test(l));
  if (start < 0) return { text, changed: false, reason: 'no drivers: section' };
  let end = start + 1;
  while (end < lines.length && (/^\s/.test(lines[end]) || lines[end] === '')) end++;
  const header = new RegExp('^  ' + slot.replace(/[-[\]/&*+?.^$|{}()#]/g, '\\$&') + ':[ \t]*$');
  let h = -1;
  for (let i = start + 1; i < end; i++) { if (header.test(lines[i])) { h = i; break; } }
  if (h < 0) return { text, changed: false, reason: 'drivers.' + slot + ' header not found' };
  let stop = h + 1;
  while (stop < end && !/^\S/.test(lines[stop])) stop++;

  const want = (indent) => indent + 'kind: ' + kind;
  for (let i = h + 1; i < stop; i++) {
    // Commented-out examples (`    # kind: mcp`) are prose, not config: `^\s+kind:` misses them.
    const m = lines[i].match(/^(\s+)kind:(.*)$/);
    if (!m) continue;
    if (lines[i] === want(m[1])) return { text, changed: false, reason: 'already ' + kind };
    lines[i] = want(m[1]);
    return { text: lines.join(eol), changed: true };
  }
  let at = stop;
  for (let i = h + 1; i < stop; i++) {
    const m = lines[i].match(/^(\s+)impl:/);
    if (m) { at = i; lines.splice(i, 0, want(m[1])); return { text: lines.join(eol), changed: true }; }
  }
  lines.splice(at, 0, want('    '));
  return { text: lines.join(eol), changed: true };
}

/**
 * Turn probe results into the channel decision the session will read later.
 *
 * Why a write-back and not a runtime check: an MCP server that fails to start takes
 * its tools away silently (no exit code, no stderr), so "is MCP usable here?" can
 * never be answered mid-session by the model. It is answered once, mechanically, at
 * registration, and persisted as `kind`. Slots that stay `mcp` were proven reachable.
 */
export function decideChannels(cfgText, probes) {
  const decisions = [];
  let text = cfgText;
  for (const p of probes || []) {
    if (p.channel !== 'mcp') continue;
    if (p.reachable) { decisions.push({ slot: p.slot, from: 'mcp', to: 'mcp', action: 'kept' }); continue; }
    if (p.fallback === 'none') {
      // An explicit `fallback: none` is a decision, not a default. Flipping it here
      // would be the model overriding the operator - exactly what this stage removes.
      decisions.push({ slot: p.slot, from: 'mcp', to: 'mcp', action: 'blocked',
        reason: p.detail || 'mcp 通道不可用',
        note: 'fallback: none 不得被探测悄悄改写：修好壳（或把 fallback 改成 script）后重新注册' });
      continue;
    }
    const edit = setSlotKindInText(text, p.slot, 'script');
    if (edit.changed) text = edit.text;
    decisions.push({ slot: p.slot, from: 'mcp', to: 'script', action: 'downgraded',
      reason: p.detail || 'mcp 通道不可用', written: edit.changed, note: edit.reason });
  }
  return { text, decisions };
}

/**
 * The connectivity gate arithmetic, kept in one exported place so the exclusion rule
 * below is testable without a writable private root: MCP plumbing probes carry
 * `gate: false` and must never count here.
 */
export function gateOf(probes) {
  const gated      = (probes || []).filter(p => p.gate !== false);
  const configured = gated.filter(p => p.present);
  const reachable  = gated.filter(p => p.reachable);
  return { gated, configured, reachable, passed: configured.length === 0 || reachable.length >= 1 };
}

export function probeDrivers(cfgText, code, privateRoot) {
  // Single source of truth for driver paths: expandDrivers() is what the runtime
  // resolver uses. The previous regex scan (`impl: "{{DRIVERS_ROOT}}/..."`) silently
  // skipped any impl written as a plain absolute/relative path, so such drivers
  // never entered the connectivity gate at all.
  let parsed;
  try {
    parsed = YAML.parse(cfgText);
  } catch {
    return [];
  }
  const drivers = expandDrivers(parsed, { privateRoot, toolRoot: TOOL_ROOT, code }) || {};
  const results = [];
  // 遍历配置里**实际存在的**槽位，而不是一个名单（F-11）。旧形态 for (const slot of DRIVER_SLOTS)
  // 不报错也不警告：自定义槽位的驱动文件根本不进连通门禁，“配了但永不被探”与“配了且健康”同形。
  for (const slot of Object.keys(drivers).sort()) {
    const slotCfg = drivers[slot];
    const impl = typeof slotCfg?.impl === 'string' ? slotCfg.impl.trim() : '';
    if (!impl) continue;
    const kind  = String(slotCfg?.kind ?? 'script');
    const shown = path.basename(impl.replace(/\.py(\s.*)?$/i, '.py'));
    if (!fs.existsSync(impl)) {
      results.push({ slot, channel: 'script', kind, impl: shown, present: false, reachable: false });
    } else {
      const r = runPy(impl, ['--project', code, '--health'], privateRoot);
      results.push({ slot, channel: 'script', kind, impl: shown, present: true,
        reachable: r.status === 0, exit: r.status, detail: r.detail });
    }
    if (kind !== 'mcp') continue;
    // The MCP channel gets its own probe: the shell's --health checks plumbing only
    // (private root, registry file, closed whitelist, adapter importable) and never
    // touches a backend. `gate: false` is deliberate - plumbing being fine is not the
    // same as data being reachable, and counting it would let "every script down, shell
    // healthy" slip past the exit-20 gate (R3.5: gates take local script exit codes).
    const present = fs.existsSync(MCP_SHELL);
    const r = present
      ? runPy(MCP_SHELL, ['--health', '--project', code, '--slot', slot], privateRoot)
      : { status: null, detail: MCP_SHELL_REL + ' 缺失（先跑 node scripts/sync-assets.mjs）' };
    results.push({ slot, channel: 'mcp', kind, gate: false, impl: MCP_SHELL_REL, present,
      fallback: String(slotCfg?.fallback ?? 'script'),
      reachable: r.status === 0, exit: r.status, detail: r.detail });
  }
  return results;
}

export function initWrite({ cwd, values, force = false } = {}) {
  const info = resolvePrivateRoot();
  if (!info.privateRootExists) {
    // private root missing -> caller should run /supperH-bootstrap first
    return { ok: false, error: 'no-private-root', privateRoot: info.privateRoot };
  }
  const v = values || {};
  const plan = applyStructuralOverrides(scanProject(cwd), v);
  // ---- 接入清单先过完整性关，再谈写盘（F-7）----
  // 写一半的 db 段比不写更糟：没答上来的字段会保留模板假值，而它长得像真凭据。
  const conn = planConnections(v);
  if (!conn.ok) {
    const problems = [
      conn.badNames.length
        ? `槽位名不合法：${conn.badNames.join(', ')}（须匹配 ${SLOT_KEY_RE.source}；名字由你定，但得能当 YAML 键用）` : '',
      ...conn.roleProblems,
      conn.dbMissing.length
        ? `接入数据库通道（drivers.${conn.dbSlot}），但这些值没给：${conn.dbMissing.join(', ')}` : '',
      ...Object.entries(conn.driverMissing).map(([s, need]) =>
        `声明接入 drivers.${s}，但缺：${need.map(f => `drivers.${s}.${f}`).join(', ')}`),
    ].filter(Boolean);
    return {
      ok: false, exitCode: 2, error: 'connection-choices-incomplete',
      code: plan.code, problems, scan: plan,
      hint: '不接外部源就一个都别选（省略 connect 与 db.*）：落盘时 db/drivers 两段会被整段删掉，不会留下 example_* 模板假值。' +
        '接了的每个槽位都要 desc（人话描述：这个源是什么、从哪里进去）：F-11 后槽位名归用户，' +
        '名字不再携带语义，后来的 agent 只能靠 desc 判断该不该用它。',
    };
  }
  plan.connections = conn;
  const exampleFile = path.join(TOOL_ROOT, 'schemas', 'project.example.yaml');
  if (!fs.existsSync(exampleFile)) return { ok: false, error: 'template-missing' };
  let exampleText = fs.readFileSync(exampleFile, 'utf8');
  if (exampleText.charCodeAt(0) === 0xFEFF) exampleText = exampleText.slice(1);

  // ---- menu-source HARD gate (FIRST registration only; NOT bypassable by --force) ----
  const menuTarget = path.join(info.privateRoot, 'menus', plan.code + '.yaml');
  const menuExists = fs.existsSync(menuTarget);
  if (!menuExists && !v['menu.source']) {
    return {
      ok: false, exitCode: 22, error: 'menu-source-required',
      code: plan.code, menuConfigFile: menuTarget, scan: plan,
      hint: 'first registration must specify menu.source (database|code) via --values; --force does not bypass this.',
    };
  }
  // 选了哪一支 → 那支的必填项必须逐条有值（脚本不补默认值，因为模板里那些值看着完全合法）。
  const menuPlan = planMenuChoices(v);
  if (!menuPlan.ok) {
    return {
      ok: false, exitCode: 2, error: 'menu-choices-incomplete', code: plan.code,
      menuConfigFile: menuTarget, scan: plan,
      problems: menuPlan.badSource
        ? [`menu.source 非法：${menuPlan.badSource}（只认 database | code）`]
        : [`菜单来源选了 ${menuPlan.source}，但这些值没给：${menuPlan.missing.join(', ')}`],
      hint: '不答就换一个选项（选 code 只需菜单定义文件路径与格式）：禁止沿用模板示例值。' +
        '这些字段会决定 /supperH-learn 跑哪条 SELECT、查哪个列名，写错不是“学不到”而是“学到错的菜单索引”。' +
        '（`menu.database.slot` 可省：不写 = 用数据库通道，那个槽位叫什么由你定。）',
    };
  }

  // let 而不是 const：下面 decideChannels 要把通道结论（kind）回写进同一份文本。
  // 这里曾经误写成 const —— 单测都只调 renderConfig/applyConnectionChoices，没人跑过完整
  // initWrite，于是 `--write` 每次在落盘前抛 TypeError 退 1；补了 e2e 用例后不可能再漏。
  let cfgText = renderConfig(exampleText, plan, v);
  const target = path.join(info.privateRoot, 'projects', plan.code + '.yaml');
  const exists = fs.existsSync(target);

  // ---- menu config: build + self-validate, then persist (<PRIVATE_ROOT>/menus/<code>.yaml) ----
  let menuWritten = false;
  if (v['menu.source']) {
    const built = buildMenuConfig(plan, v);
    if (!built.ok) return { ok: false, exitCode: built.exitCode || 2, error: built.error, errors: built.errors };
    fs.mkdirSync(path.join(info.privateRoot, 'menus'), { recursive: true });
    if (menuExists) fs.copyFileSync(menuTarget, menuTarget + '.bak');
    fs.writeFileSync(menuTarget, built.text, 'utf8');
    menuWritten = true;
  }

  // connectivity gate — script channel only. Entries marked `gate: false` (the MCP
  // plumbing probe) never join; see probeDrivers for why.
  const probes = probeDrivers(cfgText, plan.code, info.privateRoot);
  const { gated, configured, reachable, passed: gatePassed } = gateOf(probes);
  // “0 个已配置驱动”有两种完全不同的来历：用户显式选择不接（合法，纯代码模式），
  // 以及接了但驱动文件一个都没落地（该警告）。旧实现两者同形，都表现为门禁自动通过，
  // 于是“没配”读起来像“配好了且健康”。这里把它当成结果字段递出，不改退出码。
  const gateNote = configured.length ? null : (conn.connect.length
    ? `声明接入 ${conn.connect.join('/')}，但没有任何驱动文件可探测：连通门禁无判据可跑（视为通过），运行期取数会退化为不可用`
    : '本项目未接入任何外部数据源（纯代码模式）：门禁无判据 = 通过，这是用户的显式选择而不是探测失败');

  // Channel conclusion gets persisted as `kind`, so /supperH-bug step 0 only *reads*
  // a decided channel instead of re-probing every session (no per-session 30s timeout
  // surface). --force keeps meaning "downgrade to a warning", nothing else changed.
  const decided = decideChannels(cfgText, probes);
  cfgText = decided.text;

  // Informational (never affects the gate/exit code): which registered drivers are
  // not usable right now. F-11: this script cannot say "the anchor-lookup driver is
  // ready", because it no longer knows which slot plays that role - slot names belong
  // to the user, and /supperH-bug step F1.4 picks the lookup slot by reading each
  // slot's `desc` at runtime. So the honest signal is about *candidates*: zero healthy
  // drivers means F1.4 can only fall back to the full path.
  const driversAbsent     = gated.filter(p => !p.present).map(p => p.impl);
  const driversUnreachable = configured.filter(p => !p.reachable).map(p => p.impl);
  // 一个驱动都没登记时不得报 'ready'：那会把“没有可查的源”读成“查得到且健康”。
  const noDrivers = driversAbsent.length === 0 && driversUnreachable.length === 0 && configured.length === 0;
  const driverHints = {
    absent: driversAbsent,
    unreachable: driversUnreachable,
    anchorLookup: noDrivers ? 'n/a (no external driver registered)'
      : driversAbsent.length === 0 && driversUnreachable.length === 0
        ? 'candidates ready (every registered slot passed its healthCheck; which one serves F1.4 is decided at runtime by `desc`)'
      : 'degraded (any driver below is unavailable, so fast-path F1.4 anchor-lookup may fall back to full path)'
  };

  const result = {
    ok: true, code: plan.code, configFile: target, existed: exists,
    menuConfigFile: menuTarget, menuWritten,
    // 接入决定入结果：命令层要能原样告诉用户“本次没接任何外部源”，而不是沉默退 0
    connections: {
      declared: conn.connect, dbConfigured: conn.dbConfigured, dbSlot: conn.dbSlot ?? null,
      mode: conn.connect.length ? 'connected' : 'code-only',
    },
    // 分支映射同样得说出来（F-8）：答不出的键不写 = 盘上缺席，这是合法运行态而不是错误，
    // 但下次 --env 报“环境未声明”时必须是“当初就没答”，而不是“解析器坏了”。
    branches: branchMappingOf(plan),
    scan: plan, probes, configuredCount: configured.length, reachableCount: reachable.length,
    channelDecisions: decided.decisions,
    gatePassed, forced: !!force, driverHints, ...(gateNote ? { gateNote } : {}),
  };

  if (!gatePassed && !force) {
    return { ...result, ok: false, exitCode: 20,
      error: `connectivity gate failed: 0/${configured.length} configured drivers reachable. Fix connection or rerun with --force.` };
  }

  fs.mkdirSync(path.join(info.privateRoot, 'projects'), { recursive: true });
  if (exists) { fs.copyFileSync(target, target + '.bak'); result.backedUp = target + '.bak'; }
  fs.writeFileSync(target, cfgText, 'utf8');
  for (const sub of ['context', 'tasks']) fs.mkdirSync(path.join(info.privateRoot, sub, plan.code), { recursive: true });

  // verify the resolver now matches this cwd
  const res = resolveProject({ cwd: plan.codeRoot });
  result.resolved = res.ok ? { code: res.binding.code, contextRoot: res.binding.contextRoot } : { status: res.status, message: res.message };
  if (!res.ok) return { ...result, ok: false, exitCode: 21, error: 'wrote config but resolver does not match cwd: ' + res.message };
  result.next = `registered '${plan.code}'. Now run /supperH-learn to build its context pack.`;
  return result;
}

// ---- CLI ----
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const getArg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const cwd = getArg('--cwd') || process.cwd();
  const mode = argv.includes('--write') ? 'write' : 'scan';

  if (mode === 'scan') {
    console.log(JSON.stringify(scanProject(cwd), null, 2));
    process.exit(0);
  }

  let values = {};
  const vf = getArg('--values');
  if (vf) {
    try { values = JSON.parse(vf === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(vf, 'utf8')); }
    catch (e) { die('cannot read --values JSON: ' + e.message); }
  } else if (!process.stdin.isTTY) {
    try { const s = fs.readFileSync(0, 'utf8'); if (s.trim()) values = JSON.parse(s); } catch { /* keep {} */ }
  }
  const r = initWrite({ cwd, values, force: argv.includes('--force') });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : (r.exitCode || 2));
}
