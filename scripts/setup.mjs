// scripts/setup.mjs
// One-shot installer: npm install → ensure private-root skeleton → sync → install to IDE.
// 它不生成项目条目（那是 /supperH-init 按当前工作区扫描 + 用户回答来做的）。
//
// Usage:
//   node scripts/setup.mjs [--target auto|qoder|opencode|portable]
//                          [--dest <absolute-path>]
//                          [--skip-npm] [--skip-sync] [--yes] [--dry-run]
//
// Exit codes:
//   0 ok | 2 prereq missing (npm install / 私有根里还没有注册条目) | 3 sync blocked
//   4 install target write failed | 5 unknown target

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolvePrivateRoot, ensurePrivateSkeleton } from './resolve-private-root.mjs';
import { detectIde, OPENCODE_CONFIG_FILES } from './detect-ide.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(__dirname, '..');
const PLUGIN_NAME = 'supper-Han-java-plugin';
// SUPPERH_DIST_DIR 是测试/CI 旋钮（与 SKIP_QODER_INSTALL 同类）：默认读仓库真 dist。
// 为什么需要：tests/mcp-manifest.test.mjs 会真跑 sync-assets（先 rmSync 再重建 dist），
// 而 node --test 是文件级并发——依赖真 dist 的安装测试会偶发拿到“已被删但还没重建完”的目录。
// 测试自带一份造好的 dist 副本：不跟真 dist 抢同一份目录，也不依赖构建顺序（克隆后未 sync 也能跑）。
const DIST_DIR = process.env.SUPPERH_DIST_DIR
  ? path.resolve(process.env.SUPPERH_DIST_DIR)
  : path.join(TOOL_ROOT, 'dist', PLUGIN_NAME);

// OpenCode: L1 dir → OpenCode-side dir mapping (singular on the OpenCode side).
// Adjust here if your OpenCode version uses different names.
const OPENCODE_MAP = {
  agents:   'agent',
  commands: 'command',
  skills:   'skill',
  // The MCP shell is not an agent/command/skill asset - it is a server process the
  // IDE launches. Mirror it beside the config so `command` has a stable location
  // (OpenCode has no plugin-relative cwd, so its entry needs an absolute path).
  'mcp-skeleton': 'mcp-skeleton',
};
// 安装清单：记录“本次 supperH 自己放了哪些文件”，下次安装只删清单里的路径。
// 直接 rm -rf 目标目录会连用户手放的同名目录里的东西一起抹掉，而“不删”又会让改名 / 删掉的
// 命令以陈旧副本继续被加载（两者都不可接受），所以走带边界的清单式清理。
const OPENCODE_MANIFEST = 'supperh-installed.json';
// 红线四件套在 Qoder 侧随插件一起装（plugin.json 声明 rules/）；OpenCode 没有 rules 目录，
// 但官方支持配置里的 `instructions` 指向文件 glob —— 指回工具仓就是单一真相，改红线不用重装。
const RULES_GLOB = () => (TOOL_ROOT.replace(/\\/g, '/') + '/.qoder/rules/*.md');
const QODER_PLUGIN_KEY = 'supper-Han-java';
// Must stay equal to the id baked into dist/.mcp.json by sync-assets.mjs.
const MCP_SERVER_ID = 'supperh-drivers';

// ---------- arg parsing ----------
function parseArgs(argv) {
  const out = { target: 'auto', dest: null, skipNpm: false, skipSync: false, yes: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target')       out.target = argv[++i];
    else if (a === '--dest')    out.dest   = argv[++i];
    else if (a === '--skip-npm') out.skipNpm = true;
    // dist 已经是新的时候跳过 sync（测试与反复安装用；跳过后仍会校验 dist 存在）
    else if (a === '--skip-sync') out.skipSync = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--dry-run' || a === '--check') out.dryRun = true;
    else if (a === '--help')    { usage(); process.exit(0); }
    else { console.error('[setup] unknown arg: ' + a); usage(); process.exit(5); }
  }
  return out;
}
function usage() {
  console.log(`Usage: node scripts/setup.mjs [flags]
  --target auto|qoder|opencode|portable   install channel (default auto-detect)
  --dest <path>                           override install dir (opencode/portable only)
  --skip-npm                              do not run npm install automatically
  --skip-sync                             do not re-run sync-assets (dist must be fresh)
  --yes | -y                              non-interactive; accept defaults
  --dry-run | --check                     plan only; write nothing (alias)
Env: SUPPERH_PRIVATE_ROOT overrides the private root; SUPPERH_DIST_DIR the dist to install from.
`);
}

// ---------- helpers ----------
function log(...a)  { console.log('[setup]', ...a); }
function warn(...a) { console.warn('[setup]', ...a); }
function die(code, ...a) { console.error('[setup]', ...a); process.exit(code); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

// collect: 传入数组则记录每个**落地的目标文件绝对路径**，供安装清单使用（见 prunePrevious）。
function copyTree(src, dst, { filter, collect } = {}) {
  ensureDir(dst);
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    if (filter && !filter(s, d)) continue;
    const st = fs.statSync(s);
    if (st.isDirectory()) copyTree(s, d, { filter, collect });
    else { fs.copyFileSync(s, d); if (collect) collect.push(d); }
  }
}

async function ask(rl, q, def) {
  const suffix = def ? ` [${def}]` : '';
  const a = await new Promise(res => rl.question(q + suffix + ': ', res));
  return (a.trim() || def || '');
}

function runNode(script, args, { inherit = true } = {}) {
  const r = spawnSync(process.execPath, [path.join(TOOL_ROOT, 'scripts', script), ...args], {
    cwd: TOOL_ROOT, stdio: inherit ? 'inherit' : 'pipe', encoding: 'utf8',
  });
  return r.status ?? 1;
}

// ---------- opencode 安装清单（陈旧产物清理） ----------
function manifestPath(target) { return path.join(target, OPENCODE_MANIFEST); }

function readManifest(target) {
  try {
    const doc = JSON.parse(fs.readFileSync(manifestPath(target), 'utf8'));
    return Array.isArray(doc?.files) ? doc.files.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}

function writeManifest(target, placed) {
  const files = placed.map(f => path.relative(target, f).replace(/\\/g, '/')).sort();
  fs.writeFileSync(manifestPath(target), JSON.stringify({ toolRoot: TOOL_ROOT, files }, null, 2) + '\n', 'utf8');
  return files.length;
}

// 删掉空目录（只在 target 之内、且真的空了才删；有用户文件时 rmdir 会失败 → 静默停止上溯）。
function removeEmptyUpwards(start, stopRoot) {
  let dir = start;
  for (;;) {
    if (dir === stopRoot || !dir.startsWith(stopRoot + path.sep)) return;
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    if (entries.length > 0) return;
    try { fs.rmdirSync(dir); } catch { return; }
    dir = path.dirname(dir);
  }
}

// 只删「上一次 supperH 自己按清单放下的文件」：
// rm -rf 目标目录会连用户手放进 agent/command/skill 的东西一起抹掉；
// 完全不删则改名/删掉的命令会以陈旧副本继续被加载。两者都不可接受，故走清单 + 边界校验。
function prunePrevious(target) {
  const roots = Object.values(OPENCODE_MAP).map(n => path.resolve(target, n));
  let removed = 0;
  for (const rel of readManifest(target)) {
    const abs = path.resolve(target, rel);           // rel 是绝对路径（换机器的旧清单）时原样返回 → 下面越界判定拦下
    if (!roots.some(r => abs.startsWith(r + path.sep))) {
      warn('install manifest 条目越界，拒绝删除: ' + rel);
      continue;
    }
    if (!fs.existsSync(abs)) continue;
    try { fs.rmSync(abs, { force: true }); removed++; removeEmptyUpwards(path.dirname(abs), target); }
    catch (e) { warn('stale file not removed: ' + abs + ' - ' + e.message); }
  }
  return removed;
}

// ---------- steps ----------
function stepNpmInstall(opts) {
  if (opts.skipNpm) { log('npm install skipped (--skip-npm)'); return; }
  if (fs.existsSync(path.join(TOOL_ROOT, 'node_modules', 'yaml'))) {
    log('node_modules present; skipping npm install');
    return;
  }
  log('running npm install ...');
  if (opts.dryRun) { log('[dry-run] would exec: npm install'); return; }
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: TOOL_ROOT, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (r.status !== 0) die(2, 'npm install failed; re-run manually');
}

function stepEnsurePrivateRoot(opts) {
  const info = resolvePrivateRoot();
  // “就绪”的判据是**注册表里有项目条目**（resolvePrivateRoot().ok = projects/*.yaml 非空，
  // 或迁移前的 legacy project.yaml 存在），不是“legacy 文件存在”。
  if (info.privateRootExists && info.ok) {
    // 骨架子目录仍然补齐（mkdir -p 幂等）：真实机器上出现过“只有 projects/ 没有 menus/”的私有根
    // （迁移脚本造的），菜单学习写盘时才会撞上 ENOENT。补目录不会改变任何已定结论。
    // 子目录清单不在本文件里写：它住在 resolve-private-root.mjs，与 /supperH-bootstrap 共用一份。
    const sk = ensurePrivateSkeleton(info.privateRoot, { dryRun: !!opts.dryRun });
    if (sk.created.length) log(`private root skeleton +${sk.created.join('/')}${opts.dryRun ? ' (dry-run, not created)' : ''}`);
    log(`private root ok: ${info.privateRoot} (${info.registryCount} project(s) registered)`);
    return info;
  }
  if (opts.dryRun) { log('[dry-run] would create private root skeleton dirs under ' + info.privateRoot); return info; }
  if (!info.privateRootExists) log('creating private root: ' + info.privateRoot);
  ensurePrivateSkeleton(info.privateRoot);
  // 旧实现在这里做一件危险事：legacy project.yaml 不在就 copyFileSync(project.example.yaml →
  // project.yaml)，并提示“至少得改 db.host / db.schemas.*”。F-7 花力气消灭的正是“没答的字段
  // 长成 db.example.internal 这种看着像凭据的假值”，而这条分支会把它重新造回私有根。
  // 现在只建目录 + 把路指回正确入口：条目由 /supperH-init 按当前工作区扫描 + 用户回答生成。
  warn('私有根里还没有任何注册条目（projects/*.yaml 为空）。');
  warn('  到要修的那个项目的工作区里跑 /supperH-init（扫完会问你接哪些外部源，可以一个都不接）；');
  warn('  只有连私有根目录都还不存在时才先跑 /supperH-bootstrap。');
  if (!opts.yes) {
    die(2, 'no project registered yet; run /supperH-init in the target workspace, or re-run with --yes to install assets anyway');
  }
  return resolvePrivateRoot();
}

function stepSync(opts) {
  log('running sync-assets (validates registered projects + builds dist) ...');
  if (opts.dryRun) { log('[dry-run] would exec: node scripts/sync-assets.mjs'); return; }
  const code = runNode('sync-assets.mjs', []);
  if (code === 2) die(2, 'project registry failed validation; fix per messages above then re-run');
  if (code === 3) die(3, 'residual placeholders after substitution; check sync output');
  if (code !== 0) die(3, 'sync failed with exit ' + code);
  if (!isDir(DIST_DIR)) die(3, 'sync completed but dist missing: ' + DIST_DIR);
  log('dist ok: ' + DIST_DIR);
}

function stepChooseTarget(opts) {
  if (opts.target !== 'auto') return { primary: opts.target, evidence: {} };
  const d = detectIde({ workspaceCwd: process.cwd() });
  log('detected: ' + d.all.join(' | ') + ' (evidence: ' + JSON.stringify(d.evidence) + ')');
  return d;
}

async function stepConfirmTarget(detection, opts) {
  if (opts.target !== 'auto' || opts.yes || opts.dryRun) return detection.primary;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const def = detection.primary;
    log('pick install target:');
    detection.all.forEach((t, i) => log('  ' + (i + 1) + ') ' + t));
    const a = (await ask(rl, 'target', def)).toLowerCase();
    if (!detection.all.includes(a)) die(5, 'unknown target: ' + a);
    return a;
  } finally { rl.close(); }
}

// ---------- per-target installers ----------
function installToQoder(opts) {
  // sync-assets.mjs already tried to install to Qoder; verify.
  const base = path.join(os.homedir(), '.qoder-cn', 'plugins', 'cache', 'local', QODER_PLUGIN_KEY);
  const reg  = path.join(os.homedir(), '.qoder-cn', 'plugins', 'installed_plugins_v2.json');
  if (isDir(base)) {
    log('qoder plugin already at: ' + base);
    if (fs.existsSync(reg)) log('qoder registry present: ' + reg);
    return base;
  }
  // Re-run sync with QODER_INSTALL forced (sync skips on non-win by default).
  log('retrying qoder install via sync-assets ...');
  if (opts.dryRun) { log('[dry-run] would re-run sync-assets to trigger qoder install'); return null; }
  const code = runNode('sync-assets.mjs', []);
  if (code !== 0) die(4, 'qoder install failed; sync exit ' + code);
  return base;
}

// The MCP entry shape differs per IDE. Qoder reads dist/.mcp.json (plugin-relative,
// baked by sync-assets.mjs, no credentials). OpenCode has no plugin-relative cwd, so
// its entry needs an absolute shell path plus the private root passed via environment.
function mcpEntryFor(targetDir) {
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const shell = path.join(targetDir, 'mcp-skeleton', 'shell.py');
  const info = resolvePrivateRoot();
  const entry = {
    type: 'local',
    command: [py, shell],
    enabled: true,
  };
  // Only inject a literal we can resolve; never write an empty value, because an
  // empty SUPPERH_PRIVATE_ROOT makes the shell fail closed at startup.
  if (info.privateRoot && info.privateRootExists) {
    entry.environment = { SUPPERH_PRIVATE_ROOT: info.privateRoot };
  }
  return entry;
}

// 严格 JSON 解析失败时用来区分“用户写了注释”和“文件真的坏了”：
// 先把字符串字面量整段抹成 ""，否则 URL (`https://…`) 里的 `//` 会被当成注释而误判。
function looksCommented(text) {
  const stripped = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return /\/\/|\/\*/.test(stripped);
}

// 我们自己上一版写进去的 rules glob（含工具仓搬家前的旧绝对路径）都长这个尾。
function isOurRulesEntry(s) {
  return /\/\.qoder\/rules\/\*\.md$/.test(String(s).replace(/\\/g, '/'));
}

// 幂等关键：丢弃自己旧的 glob 再 append 当前的，反复 setup 不累积重复条目。
// 用户手写的其它 instructions 一律保留。
function mergeInstructions(existing) {
  let list;
  if (existing === undefined) list = [];
  else if (typeof existing === 'string') list = [existing];
  else if (Array.isArray(existing) && existing.every(x => typeof x === 'string')) list = existing.slice();
  else return { ok: false, reason: 'instructions 字段既不是字符串也不是字符串数组，拒绝改写配置文件' };
  const kept = list.filter(s => !isOurRulesEntry(s));
  kept.push(RULES_GLOB());
  return { ok: true, value: kept };
}

// Merge-not-clobber，两条约束不能退：
//  1) 只拥有 opencode.json。带注释的 .jsonc 是用户文件，JSON.stringify dump 会把注释抹掉，
//     而两个配置文件 OpenCode 都会读 —— 写 .json 就足以让 mcp / instructions 生效。
//  2) parse 失败 / 顶层非对象 / instructions 形状不认识 → 一个字节都不动，只打印待粘贴片段。
function mergeOpencodeConfig(target, { withMcp } = {}) {
  const file  = path.join(target, OPENCODE_CONFIG_FILES[0]);
  const jsonc = path.join(target, OPENCODE_CONFIG_FILES[1]);
  const snippet = {};
  if (withMcp) snippet.mcp = { [MCP_SERVER_ID]: mcpEntryFor(target) };
  snippet.instructions = [RULES_GLOB()];

  let doc = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    if (looksCommented(text)) {
      return { written: null, reason: path.basename(file) + ' 含注释（严格 JSON 解析不了），不覆盖用户文件', snippet };
    }
    try { doc = JSON.parse(text); }
    catch (e) { return { written: null, reason: path.basename(file) + ' 解析失败，拒绝覆盖: ' + e.message, snippet }; }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return { written: null, reason: path.basename(file) + ' 顶层不是对象，拒绝覆盖: ' + file, snippet };
    }
  }
  if (withMcp) {
    const mcp = (doc.mcp && typeof doc.mcp === 'object' && !Array.isArray(doc.mcp)) ? doc.mcp : {};
    mcp[MCP_SERVER_ID] = mcpEntryFor(target);
    doc.mcp = mcp;
  }
  const ins = mergeInstructions(doc.instructions);
  if (!ins.ok) return { written: null, reason: ins.reason, snippet };
  doc.instructions = ins.value;
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');

  const notes = [];
  if (fs.existsSync(jsonc)) {
    // 只陈述实测事实（两边都会被加载），不猜 OpenCode 的同名键合并顺序 —— 未实测。
    notes.push('同时存在 ' + path.basename(jsonc) + '（用户文件，未改写）；OpenCode 会加载 ' + OPENCODE_CONFIG_FILES.join(' / ') + '，建议同名键只写在一处');
  }
  return { written: file, reason: notes.join('；') || 'ok', snippet };
}

function installToOpencode(opts, dest) {
  const target = dest
    || process.env.SUPPERH_OPENCODE_HOME
    || path.join(os.homedir(), '.config', 'opencode');
  const conf = path.join(target, OPENCODE_CONFIG_FILES[0]);
  if (opts.dryRun) {
    log('[dry-run] would prune files listed in ' + OPENCODE_MANIFEST + ', copy dist/{agents,commands,skills,mcp-skeleton} → ' + target + ', then merge mcp + instructions into ' + conf);
    return target;
  }
  ensureDir(target);
  const pruned = prunePrevious(target);
  if (pruned) log('opencode: 清理上次安装产物 ' + pruned + ' 个文件（按清单，不动用户自放文件）');
  const placed = [];
  for (const [srcDir, dstName] of Object.entries(OPENCODE_MAP)) {
    const s = path.join(DIST_DIR, srcDir);
    if (!isDir(s)) { warn('skip missing ' + srcDir + ' in dist'); continue; }
    const d = path.join(target, dstName);
    copyTree(s, d, { collect: placed });
    log('opencode: ' + srcDir + ' → ' + d);
  }
  log('opencode: install manifest ' + manifestPath(target) + ' (' + writeManifest(target, placed) + ' files)');
  // 红线（instructions）比 MCP 壳重要：dist/mcp-skeleton 缺失时也要写 instructions，
  // 否则会出现“装了半年没人发现红线从未生效”的静默失效。
  const withMcp = isDir(path.join(DIST_DIR, 'mcp-skeleton'));
  if (!withMcp) warn('dist/mcp-skeleton 缺失：不写 mcp 块。kind=mcp 的槽位会没有可走通道，先跑 `node scripts/sync-assets.mjs`');
  const r = mergeOpencodeConfig(target, { withMcp });
  if (r.written) {
    log('opencode: ' + (withMcp ? 'mcp + instructions' : 'instructions') + ' 合并写入 ' + r.written);
    if (r.reason !== 'ok') warn('  ' + r.reason);
  } else {
    warn('opencode: 未改写配置文件 - ' + r.reason);
    warn('  请手工粘贴下面片段到你的 opencode 配置（缺 instructions = 红线不生效，缺 mcp = kind=mcp 不可用）：');
    console.warn(JSON.stringify(r.snippet, null, 2));
  }
  return target;
}

function installPortable(opts, dest, privateRoot) {
  const target = dest || path.join(privateRoot, 'dist-portable');
  if (opts.dryRun) { log('[dry-run] would mirror dist into ' + target); return target; }
  ensureDir(target);
  copyTree(DIST_DIR, target, { filter: (s) => !s.includes('.qoder-plugin') });
  log('portable mirror at: ' + target);
  warn('manual step: copy the sub-folders you need from there into your IDE loading dir');
  log('manual step: MCP shell - paste this into your IDE mcp config (id must stay "' + MCP_SERVER_ID + '"):');
  log(JSON.stringify({ [MCP_SERVER_ID]: mcpEntryFor(target) }, null, 2));
  return target;
}

// ---------- main ----------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  log('tool root: ' + TOOL_ROOT);

  stepNpmInstall(opts);
  const info = stepEnsurePrivateRoot(opts);
  if (opts.skipSync) {
    // 跳过 sync 只意味着“不重建 dist”，不意味着“可以没有 dist”。
    if (!isDir(DIST_DIR)) die(3, '--skip-sync 但 dist 不存在，先跑 node scripts/sync-assets.mjs');
    log('sync skipped (--skip-sync); reusing dist: ' + DIST_DIR);
  } else {
    stepSync(opts);
  }

  const detection = stepChooseTarget(opts);
  const target = await stepConfirmTarget(detection, opts);

  let installed = null;
  if (opts.dryRun) {
    log('[dry-run] skipping install to ' + target);
    installed = '(dry-run)';
  } else {
    switch (target) {
      case 'qoder':    installed = installToQoder(opts); break;
      case 'opencode': installed = installToOpencode(opts, opts.dest); break;
      case 'portable': installed = installPortable(opts, opts.dest, info.privateRoot); break;
      default:         die(5, 'unknown target: ' + target);
    }
  }

  log('');
  log('=== done ===');
  log('target:   ' + target);
  log('installed: ' + (installed || '(skipped)'));
  if (!opts.dryRun) {
    // Re-detect after install: `kind: mcp` slots are only usable when this says
    // registered. A script-channel-only setup prints NOT registered and that is fine.
    // opencode 装到 --dest 时必须探那个目录，不然报的是默认 config dir 的状态（假阴性）。
    const probe = { workspaceCwd: process.cwd() };
    if (target === 'opencode' && installed && installed !== '(dry-run)') probe.opencodeHome = installed;
    const st = detectIde(probe).mcp[target];
    if (st) {
      log('mcp shell: ' + (st.registered ? 'registered ' + st.path : 'NOT registered - ' + st.reason));
    }
  }
  log('');
  log('next steps:');
  if (target === 'qoder') {
    log('  1) fully quit Qoder (system tray too) then reopen it');
    log('  2) type /supperH in the input box → 5 commands should appear:');
    log('     /supperH-setup  /supperH-bootstrap  /supperH-init  /supperH-bug  /supperH-learn');
    log('  3) 首次接入一个项目：在**那个项目的工作区**里跑 /supperH-init（条目写进私有根，跟 IDE 无关）');
    log('  4) smoke test: /supperH-learn --module <one-of-your-modules>');
  } else if (target === 'opencode') {
    log('  1) reopen OpenCode (or run `opencode` in a fresh terminal)');
    log('  2) type / → 5 supperH-* commands should appear (setup / bootstrap / init / bug / learn)');
    log('  3) if not visible, check OpenCode config dir; re-run with --dest <that-dir>');
    log('     `node scripts/setup.mjs --target opencode --dest <path>`');
    log('  4) 首次接入一个项目：在**那个项目的工作区**里跑 /supperH-init');
    log('     注册表在私有根，和 Qoder 共用同一份数据 —— 已用 Qoder init 过的项目，这边直接 /supperH-bug');
    log('  5) 红线四件套不做拷贝件：已把 instructions 写成 ' + RULES_GLOB());
    log('     （改 rules 即改行为、无需重装；工具仓不能删/改名，搬家后重跑一次 setup）');
    log('  6) MCP 通道默认不启用（全部槽位 kind=script）。只有项目 yaml 写了 kind: mcp 才需要');
    log('     装依赖：`pip install -r ' + path.join(installed && installed !== '(dry-run)' ? installed : '<install-dir>', 'mcp-skeleton', 'requirements.txt') + '`');
  } else {
    log('  1) inspect ' + (installed || '<portable>') + ' and copy sub-folders into your IDE');
    log('  2) or re-run with --target qoder / --target opencode --dest <path>');
  }
}

main().catch(e => { console.error('[setup] fatal:', e); process.exit(5); });
