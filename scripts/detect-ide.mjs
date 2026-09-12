// scripts/detect-ide.mjs
// Detects which IDE / agent runtime is available on the current machine.
// Used by scripts/setup.mjs to pick an install target.
//
// Returns: { primary, all, evidence, mcp }
//   primary : 'qoder' | 'opencode' | 'portable'
//   all     : array of all detected targets in priority order
//   evidence: { target: path | reason }
//   mcp     : { target: { registered, path?, reason } } - shell server registration state

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = os.homedir();

function isDir(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); }
  catch { return false; }
}

function firstExisting(candidates) {
  for (const c of candidates) {
    if (isDir(c)) return c;
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

// Must stay equal to the id baked into dist/.mcp.json by sync-assets.mjs.
const MCP_SERVER_ID = 'supperh-drivers';

// OpenCode 的两个配置文件名**都会被读**（实测 1.18.21 二进制里的 ["opencode.json","opencode.jsonc"] 加载列表）。
// 只探 `.json` 会在“用户只有 `.jsonc`”的机器上永久报未注册（假阴性），所以两边共用这一张表。
// 顺序即写入门面：supperH 只拥有 `opencode.json`（纯 JSON，可安全 parse+dump），
// 绝不改写 `.jsonc` —— 那是用户文件，JSON.stringify 会把里面的注释抹掉。
export const OPENCODE_CONFIG_FILES = ['opencode.json', 'opencode.jsonc'];

// Read-only probe: is the MCP shell actually reachable from this channel?
// Absence is NOT an error - every slot defaults to kind=script, so the plugin works
// without any mcp registration. We report it so `kind: mcp` slots are never assumed.
function probeQoderMcp(qoderHome) {
  const dir = path.join(qoderHome, 'plugins', 'cache', 'local', 'supper-Han-java');
  const file = path.join(dir, '.mcp.json');
  if (!isDir(dir)) return { registered: false, reason: 'plugin not installed' };
  if (!fs.existsSync(file)) return { registered: false, path: file, reason: 'no .mcp.json (re-run `node scripts/sync-assets.mjs`)' };
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ok = !!(doc.mcpServers && doc.mcpServers[MCP_SERVER_ID]);
    return { registered: ok, path: file, reason: ok ? 'ok' : 'server id ' + MCP_SERVER_ID + ' missing' };
  } catch (e) {
    return { registered: false, path: file, reason: 'unparseable: ' + e.message };
  }
}

// 只用于“读”。.jsonc 里带注释 / 多一个尾逗号是完全合法的（OpenCode 自己读得懂），
// 严格 JSON.parse 读不懂而已 —— 不做宽松解析就会在“只有带注释 .jsonc”的机器上误报未注册。
// 写路径绝不得使用它：JSON.stringify dump 会把用户注释抹掉。
function parseJsoncLoose(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 1; out += ' '; continue; }
    out += c;
  }
  try { return JSON.parse(out); }
  catch { return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')); }   // 尾逗号
}

function probeOpencodeMcp(opencodeHome) {
  const home = isDir(opencodeHome) ? opencodeHome : path.dirname(opencodeHome);
  // 两个候选文件都看：命中 id 的那个直接算已注册；都未命中时报告看过哪几个、各自是什么状态。
  const tried = [];
  for (const name of OPENCODE_CONFIG_FILES) {
    const file = path.join(home, name);
    if (!fs.existsSync(file)) { tried.push(name + ': absent'); continue; }
    try {
      const doc = parseJsoncLoose(fs.readFileSync(file, 'utf8'));
      if (doc && doc.mcp && doc.mcp[MCP_SERVER_ID]) {
        return { registered: true, path: file, reason: 'ok' };
      }
      tried.push(name + ': present, mcp.' + MCP_SERVER_ID + ' missing');
    } catch (e) {
      tried.push(name + ': unparseable even after comment stripping (' + e.message + ')');
    }
  }
  const reason = tried.some(t => !/absent$/.test(t))
    ? tried.join('; ') + ' — supperH 会把 mcp 块写进 ' + OPENCODE_CONFIG_FILES[0]
    : 'no ' + OPENCODE_CONFIG_FILES.join(' / ') + ' (run `node scripts/setup.mjs --target opencode`)';
  return { registered: false, path: path.join(home, OPENCODE_CONFIG_FILES[0]), reason };
}

export function detectIde({ workspaceCwd, opencodeHome: opencodeHomeOverride } = {}) {
  const env = process.env;
  const all = [];
  const evidence = {};
  const mcp = {};

  // ---- Qoder -------------------------------------------------------------
  const qoderHomeCandidates = [
    env.QODER_HOME,
    path.join(HOME, '.qoder-cn'),
    path.join(HOME, '.qoder'),
  ].filter(Boolean);
  const qoderHome = firstExisting(qoderHomeCandidates);
  if (qoderHome) {
    all.push('qoder');
    evidence.qoder = qoderHome;
    mcp.qoder = probeQoderMcp(qoderHome);
  }

  // ---- OpenCode ----------------------------------------------------------
  // Known layouts (varies by version):
  //   ~/.config/opencode/     (XDG, most recent)
  //   ~/.opencode/            (legacy)
  //   <workspace>/.opencode/  (project-scope)
  const opencodeCandidates = [
    env.SUPPERH_OPENCODE_HOME,
    env.OPENCODE_HOME,
    path.join(HOME, '.config', 'opencode'),
    path.join(HOME, '.opencode'),
  ].filter(Boolean);
  if (workspaceCwd) {
    opencodeCandidates.push(path.join(workspaceCwd, '.opencode'));
  }
  // 显式给定安装目录时（setup --dest / 测试用临时根）以它为准，否则会在“其实已注册”的
  // 目录上误报 NOT registered —— 安装位置非默认家的机器上，这一行是唯一回执。
  const opencodeHome = opencodeHomeOverride || firstExisting(opencodeCandidates);
  if (opencodeHome) {
    all.push('opencode');
    evidence.opencode = opencodeHome;
    mcp.opencode = probeOpencodeMcp(opencodeHome);
    // also probe a project-scope opencode dir separately
    if (workspaceCwd) {
      const ws = path.join(workspaceCwd, '.opencode');
      if (isDir(ws)) evidence.opencodeWorkspace = ws;
    }
  }

  // ---- portable fallback (always available) -----------------------------
  all.push('portable');
  evidence.portable = 'falls back to <PRIVATE_ROOT>/dist-portable/ for manual copy';
  mcp.portable = { registered: false, reason: 'manual paste of the printed mcp entry' };

  return {
    primary: all[0],
    all,
    evidence,
    mcp,
  };
}

// CLI entry
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const r = detectIde({ workspaceCwd: process.cwd() });
  console.log(JSON.stringify(r, null, 2));
}
