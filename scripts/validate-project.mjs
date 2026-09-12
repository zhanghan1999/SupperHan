// scripts/validate-project.mjs
// Load and structurally validate project config(s) against project.schema.yaml.
// Minimal JSON-Schema-style validator covering: type, required, enum, const,
// pattern, minItems, minLength/maxLength, uniqueItems, additionalProperties:false,
// oneOf, $ref. It has NO if/then/allOf, so cross-field rules that need them live in
// checkDriverChannels() below rather than being written into the schema as a lie.
//
// Registry-aware (multi-project layout):
//   no args            validate EVERY <PRIVATE_ROOT>/projects/<code>.yaml
//   --project <code>   validate just one (matched by identity.code, filename as fallback)
//   --file <path>      validate an explicit file (drafts / pre-registration check)
//   --json             machine-readable output
// Falls back to the legacy single <PRIVATE_ROOT>/project.yaml when projects/ is
// absent (pre-migration window), warning about it.
//
// Exit codes: 0 all valid / 2 schema violation, unreadable file, or nothing to
// validate / 3 usage error (unknown arg, or --project code not registered).
//
// Beyond the schema, three cross-field rules run here because this repo's minimal
// validator has no if/then/allOf: driver-channel shape, write-guard coverage, and
// template-residue detection. The last one is what makes "I connected nothing" a
// supported answer instead of a silent fake config: db/drivers are optional in the
// schema, but if they ARE present their values must not still be the example_*
// literals from schemas/project.example.yaml.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { pathToFileURL } from 'node:url';
import { resolvePrivateRoot } from './resolve-private-root.mjs';

/**
 * @deprecated legacy single-file entry point, kept for existing importers.
 * New code wants validateRegistry() below.
 */
export function loadProject() {
  const info = resolvePrivateRoot();
  if (!info.ok) return { ok: false, error: info.error, info };
  return { ...loadProjectFile(info.projectFile), info };
}

/** Parse one YAML config file -> { ok, data } or { ok:false, error } */
export function loadProjectFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { ok: false, error: `read failed: ${e.message}` }; }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  try { return { ok: true, data: YAML.parse(text) }; }
  catch (e) { return { ok: false, error: `YAML parse: ${e.message}` }; }
}

export function loadSchema() {
  const schemaFile = path.resolve(import.meta.dirname, '..', 'schemas', 'project.schema.yaml');
  let text = fs.readFileSync(schemaFile, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return YAML.parse(text);
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
function resolveRef(node, root) {
  if (node && typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    const parts = node.$ref.slice(2).split('/');
    let cur = root;
    for (const p of parts) cur = cur[p];
    return cur;
  }
  return node;
}
function validate(node, schema, root, pathStr, errors) {
  schema = resolveRef(schema, root);
  const t = typeOf(node);
  if (schema.const !== undefined && node !== schema.const) {
    errors.push(`${pathStr}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(node)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(node)) {
    errors.push(`${pathStr}: value ${JSON.stringify(node)} not in enum ${JSON.stringify(schema.enum)}`);
    return;
  }
  if (schema.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = expected.some(e => e === t || (e === 'number' && t === 'integer'));
    if (!ok) { errors.push(`${pathStr}: type ${t}, expected ${expected.join('|')}`); return; }
  }
  if (t === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(node)) errors.push(`${pathStr}: pattern ${schema.pattern} not matched by "${node}"`);
    if (schema.minLength && node.length < schema.minLength) errors.push(`${pathStr}: minLength ${schema.minLength}`);
    if (schema.maxLength && node.length > schema.maxLength) errors.push(`${pathStr}: maxLength ${schema.maxLength}`);
  }
  if (t === 'integer' || t === 'number') {
    if (schema.minimum !== undefined && node < schema.minimum) errors.push(`${pathStr}: < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && node > schema.maximum) errors.push(`${pathStr}: > maximum ${schema.maximum}`);
  }
  if (t === 'array') {
    if (schema.minItems && node.length < schema.minItems) errors.push(`${pathStr}: minItems ${schema.minItems}`);
    if (schema.uniqueItems) {
      const seen = new Set();
      for (const [i, el] of node.entries()) {
        const key = JSON.stringify(el);
        if (seen.has(key)) { errors.push(`${pathStr}[${i}]: duplicate for uniqueItems`); break; }
        seen.add(key);
      }
    }
    if (schema.items) node.forEach((el, i) => validate(el, schema.items, root, `${pathStr}[${i}]`, errors));
  }
  if (t === 'object') {
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) if (!(k in node)) errors.push(`${pathStr}.${k}: required field missing`);
    }
    if (schema.properties) {
      for (const k of Object.keys(node)) {
        if (schema.properties[k]) validate(node[k], schema.properties[k], root, `${pathStr}.${k}`, errors);
        else if (schema.additionalProperties === false) errors.push(`${pathStr}.${k}: additional property not allowed`);
      }
    }
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(s => { const tmp = []; try { validate(node, s, root, pathStr, tmp); } catch(_) {} return tmp.length === 0; });
    if (matches.length !== 1) errors.push(`${pathStr}: oneOf matched ${matches.length} subschemas, expected exactly 1`);
  }
}

export function validateAgainstSchema(data, schema) {
  const errors = [];
  validate(data, schema, schema, '$', errors);
  return errors;
}

// ---- registry-aware validation ----------------------------------------------
// The resolver (resolve-project.mjs) reads projects/*.yaml and silently skips any
// file it cannot parse or that carries no identity.code - the operator then sees
// "exit 10: not registered" for a project that *is* on disk. So validation walks the
// whole registry and reports per-file results, plus the integrity problems the
// resolver cannot detect on its own (duplicate identity.code, filename mismatch).
function registryFiles(info) {
  try {
    if (fs.existsSync(info.projectsDir) && fs.statSync(info.projectsDir).isDirectory()) {
      const list = fs.readdirSync(info.projectsDir)
        .filter((n) => /\.ya?ml$/i.test(n))
        .sort((a, b) => a.localeCompare(b))
        .map((n) => ({ file: path.join(info.projectsDir, n), expectCode: n.replace(/\.ya?ml$/i, '') }));
      return { legacy: false, list };
    }
  } catch { /* fall through to the legacy single file */ }
  return info.projectExists
    ? { legacy: true, list: [{ file: info.projectFile, expectCode: null }] }
    : { legacy: false, list: [] };
}

// ---- cross-field rules the minimal validator cannot express (no if/then/allOf) ----
// Slots the contract used to declare but no longer acts on. They stay parseable on
// purpose: `drivers` is additionalProperties:false, so deleting a key outright would
// make every already-registered project.yaml fail validation overnight. A warning
// with the reason is the retirement path; the file keeps working until the owner removes it.
const DEPRECATED_DRIVER_SLOTS = {
  vpnPreCheck: 'drivers.vpnPreCheck 已废弃：执行前预检经实测无效（零信任网关对 VPN 网段任意端口都代答 accept，端口/网卡/ICMP 均不是可达性证据）。连通性只由各槽位自己的 healthCheck 退出码事后判定，请删除该槽位',
};

function checkDriverChannels(data) {
  const errors = [], warnings = [];
  const drivers = data?.drivers;
  if (!drivers || typeof drivers !== 'object') return { errors, warnings };
  for (const [slot, cfg] of Object.entries(drivers)) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (DEPRECATED_DRIVER_SLOTS[slot]) warnings.push(DEPRECATED_DRIVER_SLOTS[slot]);
    const kind = cfg.kind ?? 'script';
    if (!['script', 'mcp'].includes(kind)) continue;   // enum already reported above
    if (kind === 'mcp') {
      const m = cfg.mcp;
      if (!m || typeof m !== 'object') {
        errors.push(`drivers.${slot}.kind=mcp 但缺 mcp 绑定（需 mcp.server + mcp.sources）：运行期会没有可走的通道`);
      } else {
        if (!m.server) errors.push(`drivers.${slot}.mcp.server 不能为空（kind=mcp）`);
        if (!Array.isArray(m.sources) || m.sources.length === 0) {
          errors.push(`drivers.${slot}.mcp.sources 必须是非空白名单（kind=mcp）：未列出的 source 应当被拒（exit 2 语义）而不是被猜`);
        }
      }
      if (cfg.fallback === 'none') {
        warnings.push('kind=mcp 且 fallback=none：server 起不来时该源会静默不可用，确认下游不会因此跳过关键步骤');
      }
    } else if (cfg.mcp) {
      errors.push(`drivers.${slot}.mcp 仅在 kind=mcp 时有意义（当前 kind=script）：要么删掉 mcp 段，要么改 kind`);
    }
  }
  return { errors, warnings };
}

// 写保护清单必须真盖住生产/预发库。schema 只能校 forbidWriteSchemas 非空，管不了它装的是不是
// 真存在的库名：模板值 example_prod/example_uat 与用户改后的 db.schemas.* 脱钩时，清单依旧合法、
// 依旧“非空”，但 driver 的 ReadOnlyGuard 与 bug-dev 的 DB 门禁一次也不会命中（写错库不报错）。
function checkWriteGuard(data) {
  const errors = [];
  const db = data?.db;
  if (!db || typeof db !== 'object') return errors;
  const list = (Array.isArray(db.forbidWriteSchemas) ? db.forbidWriteSchemas : []).map(String);
  for (const k of ['prod', 'uat']) {
    const name = db.schemas?.[k];
    if (typeof name === 'string' && name && !list.includes(name)) {
      errors.push(`db.forbidWriteSchemas 未包含 db.schemas.${k}='${name}'：写保护对该库形同虚设（driver ReadOnlyGuard / bug-dev DB 门禁都拦不住），请补进清单`);
    }
  }
  return errors;
}

// 模板假值残留检测（F-7 的校验侧）。为什么只查 db / drivers 两棵子树：
// 这两段里的值会被当真凭据、真库名、真驱动路径拿去用（driver 连库、ReadOnlyGuard 比库名、
// bug-dev 的 DB 门禁），所以“看着像配好了其实一个都没填”是安全缺陷。
// codeRoot/packageRoot 里的 EXAMPLE 路径不会造成同类伤害（解析器匹配不上就是匹配不上），
// 不在本规则范围内——把一切形似占位符的字符串都当错误，只会让人把真库名改个写法绕过检查。
const RESIDUE_RE = /(^|[^0-9a-z])example([-_.$]|$)/i;

function collectStrings(node, keyPath, out) {
  if (typeof node === 'string') { if (RESIDUE_RE.test(node)) out.push({ at: keyPath, value: node }); return; }
  if (Array.isArray(node)) { node.forEach((el, i) => collectStrings(el, `${keyPath}[${i}]`, out)); return; }
  if (node && typeof node === 'object') {
    for (const [k, val] of Object.entries(node)) collectStrings(val, keyPath ? `${keyPath}.${k}` : k, out);
  }
}

function checkTemplateResidue(data) {
  const errors = [];
  for (const section of ['db', 'drivers']) {
    const hits = [];
    collectStrings(data?.[section], section, hits);
    for (const h of hits) {
      errors.push(`${h.at} 仍是模板假值 '${h.value}'：不接这个外部源就把整段（db / drivers）删掉，接了就填真值。` +
        `留着 example_* 等于骗过写保护与连通门禁：假库名永远不会命中 forbidWriteSchemas，假驱动路径只会“没配”而不是“配错了”`);
    }
  }
  return errors;
}

// db 与 drivers.database 必须彼此成立。两个方向严重程度不同（与 schema 的 description 一致）：
//   有驱动没 db 段 = 错误。ReadOnlyGuard 拿不到 forbidWriteSchemas 清单，而空清单是一条都不拦（
//   mcp-skeleton/supperh_contract/guards.py: select_only_guard），等于把写保护默认关掉；
//   有 db 段没驱动 = 警告。库信息是事实（环境名、禁写清单都在），只是暂时没通道去读它。
function checkDbDriverCoherence(data) {
  const errors = [], warnings = [];
  const hasDb = !!(data?.db && typeof data.db === 'object');
  const hasDbDriver = !!(data?.drivers && typeof data.drivers === 'object' && data.drivers.database);
  if (hasDbDriver && !hasDb) {
    errors.push('drivers.database 已登记但项目没有 db 段：ReadOnlyGuard 与 bug-dev 的 DB 门禁拿不到 forbidWriteSchemas 清单，而空清单 = 任何库都不拦（写保护默认失效）。要么补 db，要么删掉该槽位');
  }
  if (hasDb && !hasDbDriver) {
    warnings.push('项目登记了 db 但没有 drivers.database：没有任何通道能连上它，DB 取数与 DB 门禁在运行期不可用（不阻断；纯代码模式可以接受）');
  }
  return { errors, warnings };
}

function checkOne(entry, schema) {
  const res = { file: entry.file, code: null, errors: [], warnings: [] };
  const loaded = loadProjectFile(entry.file);
  if (!loaded.ok) { res.errors.push(loaded.error); return res; }
  const data = loaded.data;
  if (!data || typeof data !== 'object') { res.errors.push('文件为空或不是 mapping'); return res; }
  res.code = data?.identity?.code ?? null;
  res.errors.push(...validateAgainstSchema(data, schema));
  const chan = checkDriverChannels(data);
  res.errors.push(...chan.errors);
  res.warnings.push(...chan.warnings);
  res.errors.push(...checkWriteGuard(data));
  res.errors.push(...checkTemplateResidue(data));
  const cohere = checkDbDriverCoherence(data);
  res.errors.push(...cohere.errors);
  res.warnings.push(...cohere.warnings);
  const want = schema.properties?.schemaVersion?.const;
  if (want !== undefined && data.schemaVersion !== want) {
    res.errors.push(`schemaVersion: got ${JSON.stringify(data.schemaVersion)}, expected ${want}`);
  }
  if (!res.code) {
    res.errors.push('identity.code 缺失/为空 —— resolve-project 会静默跳过该文件（表现为已注册却报 exit 10 未注册）');
  }
  if (entry.expectCode && res.code && entry.expectCode !== res.code) {
    res.warnings.push(`文件名 '${entry.expectCode}.yaml' ≠ identity.code '${res.code}'（不阻断；约定由 /supperH-init 与 migrate-registry.mjs 保证）`);
  }
  return res;
}

/**
 * @param {{code?:string, file?:string}} [opts]
 * @returns {{exitCode:number, error?:string, legacy?:boolean, checked:number, results:object[]}}
 */
export function validateRegistry(opts = {}) {
  const info = resolvePrivateRoot();
  if (!info.privateRootExists) {
    return { exitCode: 2, results: [], error: `private root not found: ${info.privateRoot}. run /supperH-bootstrap or set SUPPERH_PRIVATE_ROOT` };
  }
  const schema = loadSchema();
  let { list, legacy } = registryFiles(info);

  if (opts.file) {
    if (!fs.existsSync(opts.file)) return { exitCode: 3, results: [], error: `no such file: ${opts.file}` };
    list = [{ file: opts.file, expectCode: null }];
    legacy = false;
  } else if (opts.code) {
    list = list.filter((e) => (loadProjectFile(e.file).data?.identity?.code ?? e.expectCode) === opts.code);
    if (!list.length) {
      return { exitCode: 3, results: [], error: `project '${opts.code}' not registered under ${info.projectsDir}. run /supperH-init in that workspace.` };
    }
  }
  if (!list.length) {
    return { exitCode: 2, results: [], error: `no project to validate: neither projects/*.yaml nor project.yaml exists under ${info.privateRoot}. run /supperH-init` };
  }

  const results = list.map((e) => checkOne(e, schema));
  // Two files claiming the same code: the resolver would emit two bindings with one
  // identity, so "which project is this workspace" stops having a unique answer.
  const byCode = new Map();
  for (const r of results) if (r.code) byCode.set(r.code, [...(byCode.get(r.code) || []), r.file]);
  for (const [code, files] of byCode) {
    if (files.length < 2) continue;
    for (const r of results.filter((x) => x.code === code)) {
      r.errors.push(`identity.code '${code}' 重复：${files.map((f) => path.basename(f)).join(', ')}（一个 code 只能对应一个文件）`);
    }
  }
  return { exitCode: results.some((r) => r.errors.length) ? 2 : 0, legacy, checked: results.length, results, privateRoot: info.privateRoot };
}

// CLI
const USAGE = [
  'Usage: node scripts/validate-project.mjs [--project <code>] [--file <path>] [--json]',
  '  no args         validate every <PRIVATE_ROOT>/projects/<code>.yaml',
  '  --project <c>   validate only the project whose identity.code is <c>',
  '  --file <path>   validate an explicit yaml file',
  'exit: 0 valid | 2 schema violation / nothing to validate | 3 usage error'
].join('\n');
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '--json') opts.json = true;
    else if (a === '--project' || a === '--code') {
      if (i + 1 >= argv.length) { console.error('[validate] ' + a + ' needs a value\n' + USAGE); process.exit(3); }
      opts.code = argv[++i];
    } else if (a === '--file') {
      if (i + 1 >= argv.length) { console.error('[validate] --file needs a path\n' + USAGE); process.exit(3); }
      opts.file = path.resolve(argv[++i]);
    } else {
      console.error('[validate] unknown argument: ' + a + '\n' + USAGE);
      process.exit(3);
    }
  }

  const r = validateRegistry(opts);
  if (opts.json) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.exitCode);
  }
  if (r.error) { console.error('[validate] ' + r.error); process.exit(r.exitCode); }

  let failed = 0;
  for (const res of r.results) {
    const label = res.code || path.basename(res.file, path.extname(res.file));
    if (res.errors.length) {
      failed++;
      console.error(`[validate] FAIL: ${label}  ${res.file}`);
      for (const e of res.errors) console.error('  - ' + e);
    } else {
      console.log(`[validate] OK: ${label}  ${res.file}`);
    }
    for (const w of res.warnings) console.error(`  ! ${label}: ${w}`);
  }
  if (r.legacy) console.error('[validate] ! legacy single project.yaml detected — run `node scripts/migrate-registry.mjs` to move to projects/<code>.yaml');
  console.log(`[validate] ${r.checked - failed} passed / ${r.checked} checked`);
  process.exit(r.exitCode);
}
