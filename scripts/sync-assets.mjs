// scripts/sync-assets.mjs
// L1 -> dist pipeline with placeholder substitution + residual-block.
//
// Steps (registry-aware / multi-project):
//   1. resolve private root (SUPPERH_PRIVATE_ROOT env or sibling default)
//   2. wipe dist/supper-Han-java-plugin/
//   3. copy agents/ commands/ skills/ schemas/ drivers-skeleton/ into dist/
//   4. for every text file: strip BOM, normalise CRLF, then
//        - BAKE tool-global constants: {{TOOL_ROOT}} {{PRIVATE_ROOT}} {{DRIVERS_ROOT}} {{SYNC_TIMESTAMP}}
//        - RUNTIMEIFY project-specific refs into ${SUPPERH.*} tokens the agent fills at
//          run time from scripts/resolve-project.mjs: {{CONTEXT_ROOT}} {{TASKS_ROOT}}
//          {{EFFECTIVE_ROOT}} {{PACKAGE_ROOT_PATH}} {{MENU_CONFIG}} {{PROJECT.<dot.path>}}
//   5. scan residuals: any remaining {{...}} → hard fail (exit 3, no degrade).
//      ${SUPPERH.*} are sanctioned runtime tokens and are NOT counted as residual.
//   6. emit .qoder-plugin/plugin.json and the MCP shell registration .mcp.json
//      (plugin-relative, zero credentials) + mcp-skeleton/private-root.txt pointer
//   7. --check mode: run steps 1,4-5 only, no writes; additionally verify that
//      dist/ still matches the sources (exit 4 on stale / missing / orphan files),
//      that the MCP registration kept its shape (no absolute paths, shell present),
//      and that no L2 fact / local absolute path leaked into the uploaded text
//      (exit 5 either way - a leak blocks the build, not just the check)
//   8. optional install-to-qoder (best-effort; guarded by env var SKIP_QODER_INSTALL=1)

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import YAML from 'yaml';
import { pathToFileURL } from 'node:url';
import { resolvePrivateRoot } from './resolve-private-root.mjs';

const TOOL_ROOT_DEFAULT = path.resolve(import.meta.dirname, '..');
const PLUGIN_NAME = 'supper-Han-java-plugin';
const COPY_DIRS   = ['agents', 'commands', 'skills', 'schemas', 'drivers-skeleton', 'mcp-skeleton'];
const TEXT_EXT    = new Set(['.md', '.markdown', '.yaml', '.yml', '.json', '.txt', '.py', '.mjs', '.js', '.ts']);
const IGNORE_NAMES = new Set(['.git', 'node_modules', 'dist', '__pycache__', '.pytest_cache', '.venv', 'venv', '.DS_Store', 'Thumbs.db']);

function readText(p) {
  let s = fs.readFileSync(p, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return s;
}
function writeText(p, s, wasCRLF) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const norm = s.replace(/\r\n/g, '\n');
  fs.writeFileSync(p, wasCRLF ? norm.replace(/\n/g, '\r\n') : norm, 'utf8');
}
function isCRLF(p) { const b = fs.readFileSync(p); return b.includes(0x0d) && b.includes(0x0a); }

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (IGNORE_NAMES.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of walk(src)) {
    const rel = path.relative(src, f);
    const to  = path.join(dst, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f, to);
  }
}

// ---- Runtime token contract -------------------------------------------------
// Project-specific placeholders are NOT frozen at sync time; they are rewritten
// into ${SUPPERH.*} tokens. At run time the primary agent (via the step-0 gate)
// runs scripts/resolve-project.mjs and substitutes these from the returned JSON.
// Bare roots mapped 1:1:
const RUNTIME_BARE = ['CONTEXT_ROOT', 'TASKS_ROOT', 'EFFECTIVE_ROOT', 'PACKAGE_ROOT_PATH', 'MENU_CONFIG'];
// Tool-global constants that stay frozen per install (private root is fixed):
const BAKED_BARE = ['TOOL_ROOT', 'PRIVATE_ROOT', 'DRIVERS_ROOT', 'SYNC_TIMESTAMP'];

function buildVars(info) {
  return {
    TOOL_ROOT:      info.toolRoot,
    PRIVATE_ROOT:   info.privateRoot,
    DRIVERS_ROOT:   path.join(info.privateRoot, 'drivers'),
    SYNC_TIMESTAMP: new Date().toISOString(),
  };
}

function substituteOnce(text, vars) {
  // 1) bake tool-global constants to literals
  for (const k of BAKED_BARE) {
    text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), vars[k]);
  }
  // 2) runtimeify {{PROJECT.<dot.path>}} -> ${SUPPERH.PROJECT.<dot.path>}
  text = text.replace(/\{\{PROJECT\.([A-Za-z0-9_.\[\]]+)\}\}/g, (_m, p) => `\${SUPPERH.PROJECT.${p}}`);
  // 3) runtimeify bare project-scoped roots
  for (const k of RUNTIME_BARE) {
    text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), `\${SUPPERH.${k}}`);
  }
  return text;
}

function substitute(text, vars) {
  // Single pass — no nested expansion needed: baked values are constant paths
  // and runtimeified tokens carry no further placeholders.
  return substituteOnce(text, vars);
}

function findResiduals(text) {
  const out = [];
  const re = /\{\{[^{}\n]+\}\}/g;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) out.push({ line: i + 1, matches: m });
  }
  return out;
}

const PY_TOKEN_REASON = 'Python 源码不得写 token：sync 会把它烤成绝对路径，'
  + '而反斜杠在字符串字面量里是转义序列（C:\\Users 路径里的 \\U 直接 SyntaxError）。改用 <PRIVATE_ROOT> 这类写法。';

function pyTokenLandmines(file, rawText) {
  // '.py' is in TEXT_EXT, so unlike markdown a baked token lands *inside code*.
  // Checked on the pre-substitution text: after baking, the residual scan sees nothing.
  if (path.extname(file).toLowerCase() !== '.py') return [];
  return findResiduals(rawText).map((r) => ({ file, ...r, py: true }));
}

function printResiduals(list, prefix) {
  console.error(prefix + ' residual placeholders / unsafe tokens:');
  for (const r of list) {
    console.error(`  ${r.file}:${r.line}  ${r.matches.join(' | ')}`);
    if (r.py) console.error(`      ^ ${PY_TOKEN_REASON}`);
  }
}

function processDir(dir, vars, residuals) {
  for (const f of walk(dir)) {
    const ext = path.extname(f).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    const wasCRLF = isCRLF(f);
    let txt = readText(f);
    const before = txt;
    residuals.push(...pyTokenLandmines(f, before));
    txt = substitute(txt, vars);
    if (txt !== before) writeText(f, txt, wasCRLF);
    for (const r of findResiduals(txt)) residuals.push({ file: f, ...r });
  }
}

function ensureDist(toolRoot) {
  const dist = path.join(toolRoot, 'dist', PLUGIN_NAME);
  if (fs.existsSync(dist)) fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  return dist;
}

// ---- --check freshness of dist ----------------------------------------------
// Residual scanning alone cannot prove the shipped artefact matches the sources:
// dist/ is a *copy*, so editing agents/ or commands/ without re-running sync left
// "check OK" green while the runtime loaded the old file. Compare content instead.
const TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
// SYNC_TIMESTAMP is re-baked on every run; blind it on BOTH sides so it can never
// produce a false diff (and shared prose timestamps stay symmetric).
const blindTs = (s) => String(s).replace(TS_RE, '<SYNC_TIMESTAMP>');

// ---- MCP shell registration -------------------------------------------------
// Exactly ONE server entry ships with the plugin, written in plugin-relative form
// ("cwd": "." + relative args), the shape the bundled computer-use plugin proves
// Qoder accepts. Per-project adapters are importlib-loaded at run time by the shell
// from <PRIVATE_ROOT>/drivers/<code>/, so registering a new project never edits this
// file - "registration drift" cannot happen structurally.
// Invariants writeMcpManifest() must never break:
//   * no credentials, no project values, no absolute path inside .mcp.json
//   * the private root travels out-of-band in mcp-skeleton/private-root.txt
//   * only env *names* are declared (env_vars), never env values
const MCP_SERVER_ID        = 'supperh-drivers';
const MCP_ENV_ALLOWLIST    = ['SUPPERH_PRIVATE_ROOT', 'SUPPERH_TOOL_ROOT', 'SUPPERH_TRACE'];
const MCP_SHELL_ARGS       = ['mcp-skeleton', 'shell.py'];
const MCP_PRIVATE_ROOT_REL = path.join('mcp-skeleton', 'private-root.txt');
// Dist entries emitted by sync itself (no L1 source counterpart) - the orphan scan
// must not report them, and --check must keep asserting they exist.
const GENERATED_DIST = new Set([MCP_PRIVATE_ROOT_REL.split(path.sep).join('/')]);

function isAbsoluteStr(v) {
  return typeof v === 'string' && (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith('/') || v.startsWith('\\\\') || v.startsWith('\\'));
}

/** Render the registration entry exactly as it is shipped (single source for sync + --check). */
function mcpManifest() {
  return {
    mcpServers: {
      [MCP_SERVER_ID]: {
        // Interpreter is tool-local and platform-fixed at sync time (same rule
        // init-project.mjs applies); a venv, when a project needs one, is resolved
        // *inside* shell.py - naming it here would put an absolute path in the registry.
        command: process.platform === 'win32' ? 'python' : 'python3',
        args:    [MCP_SHELL_ARGS.join('/')],
        cwd:     '.',
        env_vars: MCP_ENV_ALLOWLIST
      }
    }
  };
}

function writeMcpManifest(distDir, info) {
  fs.writeFileSync(path.join(distDir, '.mcp.json'), JSON.stringify(mcpManifest(), null, 2) + '\n', 'utf8');
  // Tool-global constant, same policy as BAKED_BARE: fixed per install, holds no secret.
  fs.mkdirSync(path.join(distDir, 'mcp-skeleton'), { recursive: true });
  fs.writeFileSync(path.join(distDir, MCP_PRIVATE_ROOT_REL), info.privateRoot + '\n', 'utf8');
}

function distProblems(toolRoot, rendered) {
  const problems = [];
  const dist = path.join(toolRoot, 'dist', PLUGIN_NAME);
  const show = (p) => String(p).split(path.sep).join('/');
  if (!fs.existsSync(dist)) return [`dist missing: ${dist} (run: node scripts/sync-assets.mjs)`];
  // source dir -> dir name inside dist. `.qoder/rules/` is mirrored to `rules/`.
  const pairs = [...COPY_DIRS.map((d) => [d, d]), ['.qoder' + path.sep + 'rules', 'rules']];
  for (const [srcRel, dstRel] of pairs) {
    const srcDir = path.join(toolRoot, srcRel);
    if (!fs.existsSync(srcDir)) continue;
    const dstDir = path.join(dist, dstRel);
    const relOf = (dir) => new Set(walk(dir).map((f) => path.relative(dir, f)));
    const srcFiles = relOf(srcDir);
    const dstFiles = fs.existsSync(dstDir) ? relOf(dstDir) : new Set();
    for (const rel of srcFiles) {
      const dstFile = path.join(dstDir, rel);
      if (!dstFiles.has(rel)) { problems.push(`missing in dist: ${show(path.join(dstRel, rel))}`); continue; }
      if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) continue;
      // Sources are substituted at sync time; compare against the same rendering.
      const key = `${srcRel}/${rel}`;
      const want = srcRel.startsWith('.qoder')
        ? readText(path.join(srcDir, rel))            // mirrored verbatim, no substitution
        : (rendered.get(key) ?? null);
      if (want === null) continue;                    // non-text source: byte copy checked via file set
      const got = readText(dstFile);
      if (blindTs(want) !== blindTs(got)) {
        problems.push(`stale in dist: ${show(path.join(dstRel, rel))} (run: node scripts/sync-assets.mjs)`);
      }
    }
    for (const rel of dstFiles) {
      // rel is relative to dstRel, so the generated-file set is keyed by the
      // dist-relative path the message reports - not by the bare file name.
      const distRel = show(path.join(dstRel, rel));
      if (srcFiles.has(rel) || GENERATED_DIST.has(distRel)) continue;
      problems.push(`orphan in dist: ${distRel} (source deleted; run: node scripts/sync-assets.mjs)`);
    }
  }
  if (!fs.existsSync(path.join(dist, '.qoder-plugin', 'plugin.json'))) {
    problems.push('missing in dist: .qoder-plugin/plugin.json (run: node scripts/sync-assets.mjs)');
  }
  return problems;
}

/**
 * Verify the shipped MCP registration kept its shape. dist/.mcp.json is generated,
 * so a byte-compare against a source file cannot express these constraints.
 */
function mcpManifestProblems(toolRoot, info) {
  const problems = [];
  const dist = path.join(toolRoot, 'dist', PLUGIN_NAME);
  const file = path.join(dist, '.mcp.json');
  if (!fs.existsSync(file)) return ['missing in dist: .mcp.json (run: node scripts/sync-assets.mjs)'];

  let txt;
  try { txt = readText(file); } catch (e) { return [`dist .mcp.json unreadable: ${e.message}`]; }
  // The private root is user/machine specific: the shell locates it through the
  // pointer file, never through the registry - .mcp.json is readable by the agent.
  if (info.privateRoot && txt.includes(info.privateRoot)) {
    problems.push('dist/.mcp.json 含私有根绝对路径：只能通过 mcp-skeleton/private-root.txt 传递（私有根不入注册表）');
  }
  let mcp;
  try { mcp = JSON.parse(txt); }
  catch (e) { return [...problems, `dist/.mcp.json is not valid JSON: ${e.message}`]; }

  const servers = mcp?.mcpServers;
  if (!servers || typeof servers !== 'object' || !Object.keys(servers).length) {
    problems.push('dist/.mcp.json 无 mcpServers 条目：壳未注册，kind=mcp 的槽位会静默无通道');
  } else {
    for (const [id, entry] of Object.entries(servers)) {
      if (typeof entry !== 'object' || entry === null) { problems.push(`dist/.mcp.json mcpServers.${id} 不是 object`); continue; }
      const launchables = [['command', entry.command], ...(entry.args || []).map((a, i) => [`args[${i}]`, a])];
      for (const [field, v] of launchables) {
        if (isAbsoluteStr(v)) problems.push(`dist/.mcp.json mcpServers.${id}.${field} 是绝对路径：注册表只允许插件相对形态（${v}）`);
      }
      if (entry.cwd !== '.') problems.push(`dist/.mcp.json mcpServers.${id}.cwd 应为 "."（相对插件目录），实际 ${JSON.stringify(entry.cwd)}`);
      if (entry.env && Object.keys(entry.env).length) {
        problems.push(`dist/.mcp.json mcpServers.${id} 写了 env 值：凭据不得进注册表，只允许 env_vars 名字白名单`);
      }
      if (!Array.isArray(entry.env_vars)) problems.push(`dist/.mcp.json mcpServers.${id}.env_vars 缺失：需要显式声明可透传的环境变量名`);
      const shellRel = (entry.args || [])[0];
      if (typeof shellRel !== 'string' || !fs.existsSync(path.join(dist, ...String(shellRel).split('/')))) {
        problems.push(`dist/.mcp.json mcpServers.${id} 指向的壳不存在: ${JSON.stringify(shellRel)} (run: node scripts/sync-assets.mjs)`);
      }
    }
    if (!servers[MCP_SERVER_ID]) {
      problems.push(`dist/.mcp.json 缺 server id '${MCP_SERVER_ID}'：L2 的 drivers.<slot>.mcp.server 必须写这个名字`);
    }
  }
  if (!fs.existsSync(path.join(dist, MCP_PRIVATE_ROOT_REL))) {
    problems.push('missing in dist: mcp-skeleton/private-root.txt (run: node scripts/sync-assets.mjs)');
  }
  return problems;
}

// ---- L1 purity: 上传物里不得出现 L2 事实 / 本机路径 ------------------------------
// drivers-skeleton/README.md 与 .qoder/rules/10-redlines.md R1 一直宣称“sync 阶段的敏感字
// 扫描会拦下”，但这条扫描从未存在 —— 于是真实项目短码、真实包名、真实工作区路径曾经
// 直接躺在 L1 的测试夹具与文档示例里，靠人记得去扫。本节的判据是机械的，两条：
//   (a) 本机路径泄漏：私有根、仓库父目录、家目录这三个绝对路径的任何一种斜杠写法；
//   (b) L2 事实泄漏：注册条目里**有辨识度**的值（项目短码/别名/包根/库名/账号/显示名）
//       逐字出现在仓库上传的任何文本文件里。
// 值集合来自 L2 而不是写死的黑名单：写死“某公司名”等于把该公司名再抄进公开仓库一遍。
// 太通用的值（example/demo/test/… 与占位符形态）被过滤掉，否则模板自身会天天误报。
const L1_SCAN_DIRS = ['agents', 'commands', 'skills', 'schemas', 'drivers-skeleton',
  'mcp-skeleton', 'scripts', 'tests', 'docs', '.qoder', '.githooks'];
// 根目录那些“随仓库一起发布、但不进 dist”的文档同样得扫：它们是用户先看到的东西。
// 两份适配说明原本不在名单里 → 其中一份整份躺 \r\r\n 而没人发现，直到一次普通编辑
// 把 250 行文件重排成 500 行（工具按行读写时把多余 CR 当成空行）。纯度与行尾两条体检共用这份名单。
const L1_SCAN_FILES = ['README.md', 'package.json', '.gitignore',
  'qoder适配说明.md', 'opencode适配说明.md'];
// 只有这些 L2 字段值得当“事实”比对：模块名/分支名一类高复用词（order、dev）会淹没信号。
const FACT_FIELDS = [
  ['identity.code', (d) => d?.identity?.code],
  ['identity.displayName', (d) => d?.identity?.displayName],
  ['identity.aliases[]', (d) => d?.identity?.aliases],
  ['packageRoot', (d) => d?.packageRoot],
  ['codeRoot', (d) => d?.codeRoot],
  ['db.host', (d) => d?.db?.host],
  ['db.readonlyUser', (d) => d?.db?.readonlyUser],
  ['db.writableUser', (d) => d?.db?.writableUser],
  ['db.schemas.*', (d) => Object.values(d?.db?.schemas ?? {})],
  ['db.forbidWriteSchemas[]', (d) => d?.db?.forbidWriteSchemas],
];
// 形态上就像示例/占位符的值不参与比对（它们本来就是要公开的模板文字）。
// 按**段**判定：`com.example.proj` 里有一段 example → 跳过；`com.acme.corp` 一段都不通用 → 参与比对。
// 不把 com/org/cn 列进来：真实包根几乎总是 `com.<公司>.<域>`，列了就把这个最高信号字段屏蔽了。
// 也**不列环境词**（prod/uat/dev/release/…）：它们会一并屏蔽掉 `acme_prod` 这类真库名，
// 而事实字段集里根本没有分支/模块名，列它们没有收益只有漏报。
const GENERIC_WORDS = new Set(['example', 'examples', 'demo', 'sample', 'test', 'tests', 'my', 'your',
  'foo', 'bar', 'xxx', 'localhost', 'absolute', 'path', 'workspace', 'work', 'user', 'users',
  'home', 'dir', 'tmp', 'temp', 'proj', 'project', 'projects', 'app', 'apps']);

function factUsable(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < 3) return false;                     // 太短的词到处是巧合
  if (/[<>{}*|]/.test(s)) return false;               // 占位符形态（<内网端点>）不配当事实
  if (/^[\d.]+$/.test(s)) return false;               // 纯数字/端口
  const segs = s.split(/[-_./\s]+/).filter(Boolean);
  if (!segs.length) return false;
  if (segs.some((x) => GENERIC_WORDS.has(x.toLowerCase()))) return false;
  return true;
}

/** 从一份注册条目里取出可被当作“项目专有事实”的字符串值。 */
export function collectL2Facts(doc, source) {
  const out = [];
  for (const [field, pick] of FACT_FIELDS) {
    let v;
    try { v = pick(doc); } catch { continue; }
    for (const item of (Array.isArray(v) ? v : [v])) {
      const s = typeof item === 'string' ? item.trim() : '';
      if (factUsable(s)) out.push({ field, value: s, source });
    }
  }
  return out;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * 斜杠展平：`C:\a\b`、`C:/a/b`、以及 JS/Python 字面量里的 `C:\\a\\b` 在文本里是同一个路径。
 * 比对前两边都归一到单分隔符，否则“源码里的双反斜杠”这一类写法会漏报（实测漏过）。 */
const slashFlat = (s) => String(s).replace(/[\\/]+/g, '/');
const isPathShaped = (v) => /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('/');

/**
 * 纯函数：给定事实清单与“路径 -> 文本”，返回违规条目。
 * 字面值：边界只圈字母数字（`acme` 要能在 `acme_order`、`acme-base` 里被抓到），大小写不敏感。
 * 路径值：两边先斜杠展平再比（反斜杠/正斜杠/双反斜杠三种写法同判）。
 * 宁可多报（可用 --allow-l1-fact 放行），不可漏报。
 */
export function l1PurityProblems({ facts = [], leakPaths = [], files = [], allow = [] }) {
  const problems = [];
  const allowSet = new Set(allow.map((s) => String(s).trim().toLowerCase()));
  for (const { path: p, text } of files) {
    const lines = String(text).split(/\r?\n/);
    const flat = lines.map(slashFlat);
    const report = (kind, field, value, source, i) =>
      problems.push({ file: p, line: i + 1, kind, field, value, source });
    for (const { field, value, source } of facts) {
      if (allowSet.has(value.toLowerCase())) continue;
      if (isPathShaped(value)) {
        const re = new RegExp(escRe(slashFlat(value).replace(/\/+$/, '')), 'i');
        const at = flat.findIndex((l) => re.test(l));
        if (at >= 0) report('local-path', field, value, source, at);
        continue;
      }
      const re = new RegExp(`(?<![A-Za-z0-9])${escRe(value)}(?![A-Za-z0-9])`, 'i');
      const at = lines.findIndex((l) => re.test(l));
      if (at >= 0) report('l2-fact', field, value, source, at);
    }
    for (const { label, abs } of leakPaths) {
      if (!abs || allowSet.has(label.toLowerCase())) continue;
      const re = new RegExp(escRe(slashFlat(abs).replace(/\/+$/, '')), 'i');
      const at = flat.findIndex((l) => re.test(l));
      if (at >= 0) report('local-path', label, abs, label, at);
    }
  }
  return problems;
}

/** 上传物里的“文本文件”判据：行尾体检与 L2 事实扫描共用，两边口径必须一致。 */
function isL1TextFile(full) {
  const base = path.basename(full);
  return TEXT_EXT.has(path.extname(full).toLowerCase())
    || /^(pre-commit|LICENSE|README.*|\.[Dg]itignore)$|\.md$|\.markdown$/i.test(base);
}

/** 收集仓库内被上传的文本文件（不依赖 git，克隆后无 git 也能跑；dist/ 不在清单里）。 */
function l1UploadFiles(toolRoot) {
  const out = [];
  const push = (full, rel) => {
    if (!isL1TextFile(full)) return;
    let text;
    try { text = readText(full); } catch { return; }
    out.push({ path: rel.split(path.sep).join('/'), text });
  };
  for (const d of L1_SCAN_DIRS) {
    const dir = path.join(toolRoot, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of walk(dir)) push(f, path.relative(toolRoot, f));
  }
  for (const f of L1_SCAN_FILES) {
    const full = path.join(toolRoot, f);
    if (fs.existsSync(full)) push(full, f);
  }
  return out;
}

// ---- 行尾体检：\r\r\n 与裸 \r -------------------------------------------------
// 实测后果（不是洁癖）：这类文件在编辑器/工具侧会被拆成“每行后多一个空行”，
// 于是一次改几行的补丁写回时把整份文件重排（391 行 → 813 行），git diff 里根本
// 看不出真正改了什么。判据是机械的：文本文件里不得出现 \r\r\n，也不得出现不跟 LF 的 \r。
// 只查源文件：dist 由 readText 统一过，不在范围内。
export function eolProblems(toolRoot) {
  const problems = [];
  const scan = (full, rel) => {
    if (!isL1TextFile(full)) return;   // 二进制文件不参与行尾体检（修它会把文件改坏）
    let buf;
    try { buf = fs.readFileSync(full, 'utf8'); } catch { return; }
    const pair = (buf.match(/\r\r\n/g) || []).length;
    const lone = (buf.match(/\r(?!\n)/g) || []).length;
    if (pair || lone) {
      problems.push({ file: rel.split(path.sep).join('/'), crlfCr: pair, loneCr: lone });
    }
  };
  for (const d of L1_SCAN_DIRS) {
    const dir = path.join(toolRoot, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of walk(dir)) scan(f, path.relative(toolRoot, f));
  }
  for (const f of L1_SCAN_FILES) {
    const full = path.join(toolRoot, f);
    if (fs.existsSync(full)) scan(full, f);
  }
  return problems;
}

/** --fix-eol：把 \r\r\n / 裸 \r 统一成 CRLF。只改行尾字节，不碰内容。 */
function fixEol(toolRoot) {
  const list = eolProblems(toolRoot);
  for (const p of list) {
    const full = path.join(toolRoot, p.file);
    const raw = fs.readFileSync(full, 'utf8');
    const out = raw.split('\r\r\n').join('\r\n').replace(/\r(?=\r)/g, '');
    const fixed = out.replace(/\r(?!\n)/g, '');
    fs.writeFileSync(full, fixed, 'utf8');
    console.log(`[sync --fix-eol] ${p.file}: \\r\\r\\n=${p.crlfCr} 裸\\r=${p.loneCr} → 统一 CRLF`);
  }
  if (!list.length) console.log('[sync --fix-eol] 无需修正：上传物里没有 \\r\\r\\n / 裸 \\r');
  return list.length;
}

/** 两条阻断路径共用：把 eolProblems 的清单打成人话 + 给出修复命令。 */
function printEol(list, tag) {
  console.error(`${tag} 行尾异常（出现 \\r\\r\\n 或不跟 LF 的裸 \\r）：`);
  for (const p of list) console.error(`  ${p.file}: \\r\\r\\n=${p.crlfCr} 裸\\r=${p.loneCr}`);
  console.error(`${tag} 这类文件在编辑工具里会被拆成「每行后多一个空行」，小改动写回时整份重排、diff 失真。`);
  console.error(`${tag} run: node scripts/sync-assets.mjs --fix-eol`);
}

/** 整条纯度扫描的入口：读注册表 + 列上传物 + 求违规。测试直接拿它断言“真仓库当前干净”。 */
export function checkL1Purity(toolRoot, info, allow = []) {
  const facts = [];
  const readDoc = (file) => {
    try { return YAML.parse(readText(file)); } catch { return null; }
  };
  if (fs.existsSync(info.projectsDir)) {
    for (const n of fs.readdirSync(info.projectsDir).filter((x) => /\.ya?ml$/i.test(x))) {
      const file = path.join(info.projectsDir, n);
      const doc = readDoc(file);
      if (doc) facts.push(...collectL2Facts(doc, `projects/${n}`));
    }
  }
  if (info.projectExists) {
    const doc = readDoc(info.projectFile);
    if (doc) facts.push(...collectL2Facts(doc, 'project.yaml(legacy)'));
  }
  // 这三个路径本身就是机器专有的，不需要 factUsable 再筛一轮。
  const leakPaths = [
    { label: 'PRIVATE_ROOT', abs: info.privateRoot },
    { label: '仓库父目录', abs: path.dirname(info.toolRoot) },
    { label: '家目录', abs: os.homedir() },
  ];
  return l1PurityProblems({ facts, leakPaths, files: l1UploadFiles(toolRoot), allow });
}

function printPurity(problems, prefix) {
  console.error(prefix + ' L1 纯度违规（上传物里出现了项目专有事实或本机绝对路径）：');
  for (const p of problems) {
    const what = p.kind === 'local-path' ? `本机路径 ${p.field}` : `L2 字段 ${p.field}（来自 ${p.source}）`;
    console.error(`  ${p.file}:${p.line}  ${what} = ${p.value}`);
  }
  console.error(prefix + ' 处置：把该值换成通用示例（demo / <内网端点> / <PRIVATE_ROOT>），'
    + '或在确实需要它时把它留在私有根里。确认误报可加 --allow-l1-fact <值>（可重复）。');
}

function writePluginJson(distDir, toolRoot) {
  const pkg = JSON.parse(readText(path.join(toolRoot, 'package.json')));
  const manifestDir = path.join(distDir, '.qoder-plugin');
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifest = {
    name: 'supper-han-java',
    displayName: 'supper-Han-java (L1)',
    version: pkg.version,
    description: 'Cross-tool universal Java bug/learn workflow agents.',
    descriptionZh: '跨工具通用 Java Bug/学习工作流 Agent 集合（L1 层）。',
    author: pkg.author,
    license: pkg.license,
    agents:   './agents/',
    commands: './commands/',
    skills:   './skills/',
    rules:    './rules/',
    mcpServers: './.mcp.json'
  };
  fs.writeFileSync(path.join(manifestDir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
  // mirror .qoder/rules into dist so plugin can ship them too
  const rulesSrc = path.join(toolRoot, '.qoder', 'rules');
  if (fs.existsSync(rulesSrc)) copyTree(rulesSrc, path.join(distDir, 'rules'));
}

function installToQoder(distDir, toolRoot) {
  if (process.env.SKIP_QODER_INSTALL === '1') return { skipped: true, reason: 'env SKIP_QODER_INSTALL=1' };
  if (process.platform !== 'win32') return { skipped: true, reason: 'non-win platform; manual install required' };
  const base = path.join(os.homedir(), '.qoder-cn', 'plugins', 'cache', 'local', 'supper-Han-java');
  try {
    if (fs.existsSync(base)) fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(base), { recursive: true });
    copyTree(distDir, base);
    // idempotent upsert into installed_plugins_v2.json (best-effort)
    const regFile = path.join(os.homedir(), '.qoder-cn', 'plugins', 'installed_plugins_v2.json');
    if (fs.existsSync(regFile)) {
      const raw = readText(regFile);
      let reg; try { reg = JSON.parse(raw); } catch { return { ok: true, installed: base, warn: 'registry parse failed; skip registration' }; }
      const key = 'supper-Han-java';
      const entry = { path: base, version: JSON.parse(readText(path.join(toolRoot,'package.json'))).version, enabled: true };
      reg[key] = Array.isArray(reg[key]) ? (reg[key][0] = entry, reg[key]) : [entry];
      fs.writeFileSync(regFile, JSON.stringify(reg, null, 2), 'utf8');
      return { ok: true, installed: base, registered: regFile };
    }
    return { ok: true, installed: base, warn: 'installed_plugins_v2.json not found; plugin dir copied only' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  // --allow-l1-fact <值> 可重复：只用于“真巧合”（注册项目的某个值确实和 L1 用词撞了）。
  const allow = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--allow-l1-fact') continue;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) {
      console.error('[sync] 用法错误：--allow-l1-fact 需要一个值');
      process.exit(2);
    }
    allow.push(v); i++;
  }
  const checkOnly = args.has('--check');
  const info = resolvePrivateRoot();
  // --fix-eol 是独立一条路：只修行尾字节，不烤 dist、不装 qoder，也就不需要 private root。
  if (args.has('--fix-eol')) {
    const n = fixEol(info.toolRoot);
    console.log(`[sync --fix-eol] 处理文件 ${n} 个`);
    process.exit(0);
  }
  if (!info.privateRootExists) {
    console.error(`[sync] private root not found: ${info.privateRoot}`);
    console.error('[sync] run /supperH-bootstrap (creates it) or set SUPPERH_PRIVATE_ROOT, then retry.');
    process.exit(2);
  }
  if (info.registryCount > 0) {
    console.log(`[sync] registry: ${info.registryCount} project(s) under projects/ (dist is project-agnostic)`);
  } else if (info.projectExists) {
    console.log('[sync] legacy project.yaml detected — run `node scripts/migrate-registry.mjs` to move to projects/<code>.yaml');
  } else {
    console.log('[sync] no project registered yet — building project-agnostic dist (run /supperH-init per project later)');
  }

  const vars = buildVars(info);
  const residuals = [];

  if (checkOnly) {
    // dry-run: substitute in-memory over source files
    const rendered = new Map();
    for (const d of COPY_DIRS) {
      const src = path.join(info.toolRoot, d);
      if (!fs.existsSync(src)) continue;
      for (const f of walk(src)) {
        const ext = path.extname(f).toLowerCase();
        if (!TEXT_EXT.has(ext)) continue;
        let txt = readText(f);
        residuals.push(...pyTokenLandmines(f, txt));
        txt = substitute(txt, vars);
        for (const r of findResiduals(txt)) residuals.push({ file: f, ...r });
        rendered.set(`${d}/${path.relative(src, f)}`, txt);
      }
    }
    if (residuals.length) {
      printResiduals(residuals, '[sync --check]');
      process.exit(1);
    }
    const purity = checkL1Purity(info.toolRoot, info, allow);
    if (purity.length) {
      printPurity(purity, '[sync --check]');
      console.error('[sync --check] BLOCKING. 这些值不能进公开仓库。');
      process.exit(5);
    }
    const eol = eolProblems(info.toolRoot);
    if (eol.length) {
      printEol(eol, '[sync --check]');
      process.exit(6);
    }
    const distDir = path.join(info.toolRoot, 'dist', PLUGIN_NAME);
    // A fresh clone has no dist/ at all (it is git-ignored). That is "not built yet",
    // not "built from stale sources" - only the latter is worth blocking on.
    if (!fs.existsSync(distDir)) {
      console.log('[sync --check] OK: 0 residual placeholders; dist/ not built yet (run `node scripts/sync-assets.mjs` to build)');
      process.exit(0);
    }
    const stale = distProblems(info.toolRoot, rendered);
    const mcpBad = mcpManifestProblems(info.toolRoot, info);
    if (stale.length || mcpBad.length) {
      if (stale.length) {
        console.error('[sync --check] dist/ does not match the L1 sources:');
        for (const p of stale) console.error(`  ${p}`);
      }
      if (mcpBad.length) {
        console.error('[sync --check] MCP registration (dist/.mcp.json) is broken:');
        for (const p of mcpBad) console.error(`  ${p}`);
      }
      console.error('[sync --check] BLOCKING. run: node scripts/sync-assets.mjs');
      process.exit(4);
    }
    console.log('[sync --check] OK: 0 residual placeholders; L1 purity clean; EOL uniform; dist matches sources; mcp registration valid');
    process.exit(0);
  }

  const purity = checkL1Purity(info.toolRoot, info, allow);
  if (purity.length) {
    printPurity(purity, '[sync]');
    console.error('[sync] BLOCKING. 先清掉上传物里的专有值，再重跑。');
    process.exit(5);
  }
  const eol = eolProblems(info.toolRoot);
  if (eol.length) {
    printEol(eol, '[sync]');
    process.exit(6);
  }
  const distDir = ensureDist(info.toolRoot);
  for (const d of COPY_DIRS) {
    const src = path.join(info.toolRoot, d);
    if (!fs.existsSync(src)) continue;
    copyTree(src, path.join(distDir, d));
  }
  for (const d of COPY_DIRS) {
    const tgt = path.join(distDir, d);
    if (fs.existsSync(tgt)) processDir(tgt, vars, residuals);
  }
  if (residuals.length) {
    printResiduals(residuals, '[sync]');
    console.error('[sync] BLOCKING. Fix L1 sources or project.yaml fields, then re-run.');
    process.exit(3);
  }
  writePluginJson(distDir, info.toolRoot);
  writeMcpManifest(distDir, info);
  const inst = installToQoder(distDir, info.toolRoot);
  console.log('[sync] dist: ' + distDir);
  console.log(`[sync] mcp shell registered as '${MCP_SERVER_ID}' -> ${MCP_SHELL_ARGS.join('/')} (plugin-relative)`);
  if (inst.skipped)      console.log('[sync] qoder install skipped: ' + inst.reason);
  else if (inst.ok)      console.log('[sync] qoder installed: ' + inst.installed);
  else                   console.error('[sync] qoder install failed: ' + inst.error);
  console.log('[sync] timestamp: ' + vars.SYNC_TIMESTAMP);
}

// 守卫：测试要 import 纯函数（collectL2Facts / l1PurityProblems / checkL1Purity），
// 而无守卫的 `main()` 会在 import 时就把 dist 重烤一遍、还顺手 process.exit。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
