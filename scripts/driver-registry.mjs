// scripts/driver-registry.mjs
// /supperH-driver 的确定性后端：数据源条目（drivers.<槽位>）的增 / 改 / 删 / 查 + 探活。
//
// 为什么要有这个脚本，而不是让 agent 直接编辑 <PRIVATE_ROOT>/projects/<code>.yaml：
//   1) 登记这一刻必须硬拦缺 desc（F-11）。槽位名归用户之后，"这个源是什么、从哪里进去"只剩
//      desc 一个字段承载；而 schema 层对缺 desc 只告警（新增字段不得追认存量违法）。
//      "新条目必须带描述"因此只能在写盘之前拦 —— 落到盘上再发现就晚了。
//   2) 非法文档不得进私有根：先在内存里算出"改完之后"的文档，过 checkDocument()（schema +
//      全部跨字段规则），有错就不写盘。"先写再 validate"等于把运行期唯一读的那份配置污染一次。
//   3) 新登记的驱动当场探活，且比 /supperH-init 更严：文件不存在也算不合格（init 允许"登记了
//      库信息但驱动晚点再放"，一次显式的驱动登记不允许），不通退 20。
//   4) 文本手术，不 parse+dump：projects/<code>.yaml 里的注释是"这个字段为什么不能留空"的载体，
//      round-trip 一次全丢（与 init-project.mjs 的 setSlotKindInText 同一理由）。
//
// Usage:
//   node scripts/driver-registry.mjs list   --project <code> [--probe]
//   node scripts/driver-registry.mjs add    --project <code> --slot <name> [--values <f|->] [--force] [--dry-run]
//   node scripts/driver-registry.mjs update --project <code> --slot <name> [--values <f|->] [--force] [--dry-run]
//   node scripts/driver-registry.mjs remove --project <code> --slot <name> --yes [--dry-run]
//   node scripts/driver-registry.mjs health --project <code> [--slot <name>]
//
// --values 收 JSON（文件路径或 stdin），三种写法都接受，最终归一成"槽位字段对象"：
//   { "desc": "...", "impl": "{{DRIVERS_ROOT}}/x.py", "healthCheck": "..." }
//   { "drivers": { "<slot>": { ... } } }
//   { "drivers.<slot>.desc": "...", "drivers.<slot>.mcp.server": "..." }
// update 的删除语义：字段值给 null = 删掉该字段；writes 给 [] = 删掉整段（回到只读）。
//
// Exit codes:
//   0  ok
//   2  写入门禁拒绝（缺 desc / 槽位名非法 / 合并后文档非法 / remove 未带 --yes）
//   3  用法错误，或项目 / 槽位不存在
//   20 连通门禁失败（新登记的驱动不可达）—— --force 降级为警告
import fs   from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { pathToFileURL } from 'node:url';
import { resolvePrivateRoot } from './resolve-private-root.mjs';
import { loadProjectFile, loadSchema, checkDocument } from './validate-project.mjs';
import { buildDriversBlock, probeDrivers, decideChannels,
         SLOT_NAME_RE, DATABASE_ROLE, yamlQuote } from './init-project.mjs';

const USAGE = [
  'Usage: node scripts/driver-registry.mjs <list|add|update|remove|health> --project <code> [--slot <name>] [...]',
  '  list    --project <c> [--probe]              列出已登记的数据源（--probe 顺带探活）',
  '  add     --project <c> --slot <n> [--values <f|->] [--force] [--dry-run]',
  '  update  --project <c> --slot <n> [--values <f|->] [--force] [--dry-run]',
  '  remove  --project <c> --slot <n> --yes [--dry-run]     删除条目（--yes 必填：删的是用户给过的声明）',
  '  health  --project <c> [--slot <n>]                     只探活，不写盘',
  'exit: 0 ok | 2 写入门禁拒绝 | 3 用法错误/项目或槽位不存在 | 20 连通门禁失败（--force 降级）',
];

function log(...a) { console.error('[driver]', ...a); }

/** 统一出口：JSON 进 stdout（命令层读它），人类可读摘要进 stderr。 */
function emit(payload, exitCode) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(exitCode ?? (payload.ok ? 0 : (payload.exitCode || 2)));
}

// ---- 字段模型（与 schemas/project.schema.yaml definitions.driverSlot 一一对应）----
const FIELD_ORDER = ['desc', 'role', 'impl', 'healthCheck', 'kind', 'fallback', 'mcp', 'writes', 'config'];
const SCALAR_KEYS = ['desc', 'role', 'impl', 'healthCheck', 'kind', 'fallback'];
const BLOCK_KEYS  = ['mcp', 'writes', 'config'];
// 闭集枚举值直接写裸词（与 buildDriversBlock 一致）；自由文本一律加引号，防止 `desc: 是: 什么` 破坏 YAML。
const BARE_KEYS   = new Set(['role', 'kind', 'fallback']);
const escRe = (s) => String(s).replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&');
const isGiven = (x) => x !== undefined && x !== null && String(x).trim() !== '';

/**
 * 把 --values 的三种写法归一成"槽位字段对象"。
 * @returns {{fields:object, unknown:string[]}} unknown 里是没被识别的键名（调用方拿它退 2）
 */
export function normalizeValues(raw, slot) {
  const out = {};
  const unknown = [];
  const pre = `drivers.${slot}.`;
  const put = (key, val) => {
    if (FIELD_ORDER.includes(key)) {
      if (key === 'mcp') out.mcp = { ...(out.mcp || {}), ...(val && typeof val === 'object' ? val : {}) };
      else out[key] = val;
    } else unknown.push(key);
  };
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'drivers' && v && typeof v === 'object') {
      const sub = v[slot] && typeof v[slot] === 'object' ? v[slot] : null;
      if (!sub) { if (Object.keys(v).length) unknown.push('drivers.' + Object.keys(v).join('/')); continue; }
      for (const [kk, vv] of Object.entries(sub)) put(kk, vv);
      continue;
    }
    if (k.startsWith(pre)) {
      const rest = k.slice(pre.length);
      if (rest.includes('.')) {
        const [a, b] = rest.split('.');
        if (a === 'mcp' && FIELD_ORDER.includes('mcp')) { out.mcp = { ...(out.mcp || {}), [b]: b === 'sources' ? v : String(v ?? '') }; continue; }
        if (a === 'config') { out.config = { ...(out.config || {}), [b]: v }; continue; }
        unknown.push(rest);
        continue;
      }
      put(rest, v);
      continue;
    }
    put(k, v);
  }
  return { fields: out, unknown };
}

/** 字段的 YAML 文本渲染（单槽位块内缩进：键 4 空格、子键 6 空格）。 */
function renderFieldLines(key, value) {
  if (value === null || value === undefined) return [];
  if (SCALAR_KEYS.includes(key)) {
    return [BARE_KEYS.has(key) ? `    ${key}: ${String(value).trim()}` : `    ${key}: ${yamlQuote(String(value).trim())}`];
  }
  if (key === 'mcp') {
    const m = value && typeof value === 'object' ? value : {};
    const lines = ['    mcp:'];
    if (isGiven(m.server)) lines.push(`      server: ${yamlQuote(String(m.server).trim())}`);
    const sources = Array.isArray(m.sources) ? m.sources : String(m.sources ?? '').split(/[,，]/);
    const list = sources.map((s) => String(s).trim()).filter(Boolean);
    if (list.length) lines.push('      sources: [' + list.map(yamlQuote).join(', ') + ']');
    return lines.length === 1 ? [] : lines;
  }
  if (key === 'writes') {
    const arr = Array.isArray(value) ? value : [];
    if (!arr.length) return [];                       // 空清单 = 删段（回到只读），不写 `writes: []`
    const out = ['    writes:'];
    for (const w of arr) {
      const it = w && typeof w === 'object' ? w : {};
      out.push(`      - action: ${yamlQuote(String(it.action ?? ''))}`);
      out.push(`        gate: ${yamlQuote(String(it.gate ?? ''))}`);
      if (isGiven(it.note))       out.push(`        note: ${yamlQuote(String(it.note).trim())}`);
      if (isGiven(it.userPhrase)) out.push(`        userPhrase: ${yamlQuote(String(it.userPhrase).trim())}`);
    }
    return out;
  }
  if (key === 'config') {
    const cfg = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const entries = Object.entries(cfg);
    if (!entries.length) return [];
    return ['    config:', ...entries.map(([k, v]) => `      ${k}: ${yamlQuote(String(v ?? ''))}`)];
  }
  return [];
}

// ---- 文本手术：定位 / 插入 / 改字段 / 删块 ---------------------------------
const detectEol = (text) => (/\r\n/.test(text) ? '\r\n' : '\n');

/** drivers: 段范围（顶格键名行 + 其后非顶格行；段尾空行退回给下一段）。 */
function driversRange(lines) {
  const start = lines.findIndex((l) => /^drivers:[ \t]*(#.*)?$/.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\S/.test(lines[end])) end++;
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  return { start, end };
}

/** 单个槽位块 = `  <slot>:` 行 + 其后所有缩进行（同段兄弟槽位的键名行是边界）。 */
function slotRange(lines, slot) {
  const dr = driversRange(lines);
  if (!dr) return null;
  const header = new RegExp('^  ' + escRe(slot) + ':[ \\t]*(#.*)?$');
  for (let i = dr.start + 1; i < dr.end; i++) {
    if (!header.test(lines[i])) continue;
    let stop = i + 1;
    while (stop < dr.end && !/^  \S/.test(lines[stop])) stop++;
    while (stop > i + 1 && lines[stop - 1].trim() === '') stop--;
    return { start: i, end: stop, section: dr };
  }
  return { start: -1, end: -1, section: dr };
}

/** 在块内删掉某个键（标量行，或子块及其缩进行）。注释行不动。 */
function dropKey(lines, key) {
  const head = new RegExp('^    ' + escRe(key) + ':( |\\t|$)');
  for (let i = 0; i < lines.length; i++) {
    if (!head.test(lines[i])) continue;
    let stop = i + 1;
    if (BLOCK_KEYS.includes(key)) while (stop < lines.length && /^ {6,}\S/.test(lines[stop])) stop++;
    lines.splice(i, stop - i);
    return true;
  }
  return false;
}

/** 按 FIELD_ORDER 找插入点：排在它之后的第一个已有键之前。 */
function insertAt(lines, key) {
  const rank = FIELD_ORDER.indexOf(key);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^    ([A-Za-z]+):/);
    if (!m) continue;
    const at = FIELD_ORDER.indexOf(m[1]);
    if (at > rank) return i;
  }
  return lines.length;
}

/**
 * 改一个已存在槽位的若干字段。
 * @param {object} fields 键 → 值；值 null 表示删除该字段
 */
export function setSlotFields(text, slot, fields) {
  const eol   = detectEol(text);
  const lines = text.split(/\r?\n/);
  const rg    = slotRange(lines, slot);
  if (!rg || rg.start < 0) return { text, changed: false, reason: 'drivers.' + slot + ' 不存在' };
  const block = lines.slice(rg.start + 1, rg.end);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && !FIELD_ORDER.includes(key)) return { text, changed: false, reason: '未知字段 drivers.' + slot + '.' + key };
    dropKey(block, key);
    if (value === null) continue;
    block.splice(insertAt(block, key), 0, ...renderFieldLines(key, value));
  }
  const out = [...lines.slice(0, rg.start + 1), ...block, ...lines.slice(rg.end)];
  return { text: out.join(eol), changed: out.join(eol) !== text };
}

/** 删掉整个槽位块（含它自己的键行；块外注释不动）。 */
export function deleteSlot(text, slot) {
  const eol   = detectEol(text);
  const lines = text.split(/\r?\n/);
  const rg    = slotRange(lines, slot);
  if (!rg || rg.start < 0) return { text, changed: false, reason: 'drivers.' + slot + ' 不存在' };
  let out = [...lines.slice(0, rg.start), ...lines.slice(rg.end)];
  // 删掉最后一个槽位 → 整段 drivers: 一并删。段在而子项为空会被解成 null，过不了 schema 的
  // type: object；而“没登记任何源”本就等于纯代码模式（init 的 applyConnectionChoices 也删整段）。
  const dr = driversRange(out);
  const hasSlot = (arr) => arr.some((l) => /^  [A-Za-z][A-Za-z0-9_-]*:/.test(l));   // 注释行不算槽位
  if (dr && !hasSlot(out.slice(dr.start + 1, dr.end))) {
    out = [...out.slice(0, dr.start), ...out.slice(dr.end)];
    while (out.length > dr.start && dr.start > 0 && out[dr.start - 1].trim() === '') out.splice(dr.start - 1, 1);
  }
  return { text: out.join(eol), changed: true };
}

/** 追加一个新槽位块；没有 drivers: 段时整段新建（纯代码模式接第一个源就是这条路）。 */
export function insertSlot(text, slot, fieldLines) {
  const eol   = detectEol(text);
  const lines = text.split(/\r?\n/);
  const dr    = driversRange(lines);
  if (!dr) {
    const tail = ['', 'drivers:', ...fieldLines];
    return { text: lines.concat(tail).join(eol), changed: true, created: true };
  }
  if (slotRange(lines, slot)?.start >= 0) return { text, changed: false, reason: 'drivers.' + slot + ' 已存在（改字段请用 update）' };
  const out = [...lines.slice(0, dr.end), ...fieldLines, ...lines.slice(dr.end)];
  return { text: out.join(eol), changed: true };
}

// ---- 项目定位与读写 --------------------------------------------------------
function locateProjectFile(info, code) {
  const direct = path.join(info.projectsDir, code + '.yaml');
  if (fs.existsSync(direct)) return direct;
  try {
    for (const n of fs.readdirSync(info.projectsDir)) {
      if (!/\.ya?ml$/i.test(n)) continue;
      const f = path.join(info.projectsDir, n);
      if ((loadProjectFile(f).data?.identity?.code ?? null) === code) return f;
    }
  } catch { /* 目录不存在：下面走 legacy 单文件 */ }
  if (info.projectExists && (loadProjectFile(info.projectFile).data?.identity?.code ?? null) === code) return info.projectFile;
  return null;
}

function openProject(code) {
  const info = resolvePrivateRoot();
  if (!info.privateRootExists) {
    return { ok: false, exitCode: 3, error: `private root not found: ${info.privateRoot}`,
      hint: '先跑 /supperH-bootstrap，或设 SUPPERH_PRIVATE_ROOT' };
  }
  const file = locateProjectFile(info, code);
  if (!file) {
    return { ok: false, exitCode: 3, error: `project '${code}' not registered`,
      hint: `找不到 <PRIVATE_ROOT>/projects/${code}.yaml。先在该工作区跑 /supperH-init（注册项目本体），再用 /supperH-driver 加数据源。` };
  }
  const loaded = loadProjectFile(file);
  if (!loaded.ok) return { ok: false, exitCode: 2, error: `cannot parse ${file}: ${loaded.error}` };
  const data = loaded.data;
  if (!data || typeof data !== 'object') return { ok: false, exitCode: 2, error: `${file} 为空或不是 mapping` };
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return { ok: true, info, file, data, text, expectCode: path.basename(file).replace(/\.ya?ml$/i, '') };
}

/**
 * 只在内存里判：这一条登记本身合不合法 + 合并后的文档有没有“被这次改动新引入”的非法项。
 * 为什么差分而不是“整份文档零错误”：私有根里可能存在与本次无关的存量问题（模板假值、
 * 别的槽位缺 desc）。那些 validate 已经会退 2，但拿它们拦住“给缺 desc 的条目补上 desc”
 * 这件好事，等于让门禁阻止修复。新引入的非法项一律硬拦，存量项原样报出但不拦。
 */
function gateProblems(merged, op, slot, ctx, baseErrors = []) {
  const problems = [];
  if (!SLOT_NAME_RE.test(slot)) {
    problems.push(`槽位名 '${slot}' 不合法：须匹配 ${SLOT_NAME_RE.source}（长度 2-40，字母开头，可用 -/_）。名字由你定，但得能当 YAML 键用。`);
  }
  const cfg = merged?.drivers?.[slot];
  if (op !== 'remove') {
    const desc = typeof cfg?.desc === 'string' ? cfg.desc.trim() : '';
    if (!desc) {
      problems.push(`drivers.${slot}.desc 不能为空：槽位名归用户之后，desc 是"这个源是什么、从哪里进去"的唯一载体。` +
        `请给出人话描述（含接入点：地址/入口/从哪进去），不要复读槽位名，也不要复述 impl 路径。`);
    } else if (op === 'add' && (desc.toLowerCase() === slot.toLowerCase() || desc === String(cfg.impl ?? '').trim())) {
      problems.push(`drivers.${slot}.desc='${desc}' 只是名字或 impl 的复读，没有回答"这个源是什么、从哪里进去"：后来的 agent 靠它判断该不该用这个源`);
    }
  }
  if (op === 'add') {
    for (const k of ['impl', 'healthCheck']) {
      if (!isGiven(cfg?.[k])) problems.push(`新登记 drivers.${slot} 必须给 ${k}：驱动文件路径与探活命令是这条通道能不能用的判据`);
    }
  }
  const doc = checkDocument(merged, loadSchema(), { expectCode: ctx.expectCode });
  const fresh = doc.errors.filter((e) => !baseErrors.includes(e));
  for (const e of fresh) problems.push('这次改动新引入的非法项：' + e);
  return { problems, warnings: doc.warnings, preexisting: doc.errors.filter((e) => baseErrors.includes(e)) };
}

/** 探一个槽位（其他槽位不陪跑：每个 healthCheck 最长 30s，全跑一遍会变成分钟级等待）。 */
function probeOne(text, code, slot, privateRoot) {
  let parsed;
  try { parsed = YAML.parse(text); } catch { return { probes: [], parseError: true }; }
  const solo = YAML.stringify({ drivers: { [slot]: parsed?.drivers?.[slot] } });
  return { probes: probeDrivers(solo, code, privateRoot), parseError: false };
}

// ---- 三个动作 -------------------------------------------------------------
export function listDrivers({ code, probe = false } = {}) {
  const p = openProject(code);
  if (!p.ok) return p;
  const drivers = p.data.drivers && typeof p.data.drivers === 'object' ? p.data.drivers : {};
  let slots = Object.keys(drivers).sort().map((slot) => {
    const cfg = drivers[slot] || {};
    return {
      slot,
      desc: typeof cfg.desc === 'string' ? cfg.desc : null,
      role: cfg.role ?? null,
      kind: cfg.kind ?? 'script',
      impl: cfg.impl ?? null,
      healthCheck: cfg.healthCheck ?? null,
      writes: Array.isArray(cfg.writes)
        ? cfg.writes.map((w) => ({ action: w?.action ?? null, gate: w?.gate ?? null,
            note: w?.note ?? null, userPhrase: w?.userPhrase ?? null }))
        : null,                                    // null = 整段缺席 = 只读源（不是"没有声明"）
        // 递全量而不是 action:gate 摘要：/supperH-driver 的归类学习闭环要靠 userPhrase
        // 比对用户上次的原话，只看得到动作名的话每次都只能重新猜一次。
    };
  });
  if (probe) {
    const all = probeDrivers(YAML.stringify({ drivers }), code, p.info.privateRoot);
    for (const s of slots) {
      const mine = all.filter((x) => x.slot === s.slot);
      const sc = mine.find((x) => x.channel === 'script');
      const mc = mine.find((x) => x.channel === 'mcp');
      s.present   = !!sc?.present;
      s.reachable = !!sc?.reachable;
      s.mcpUsable = mc ? !!mc.reachable : null;      // null = 该槽位没声明 mcp 通道
      s.detail    = mine.map((x) => x.detail).filter(Boolean).join(' | ') || null;
    }
  }
  return { ok: true, code, file: p.file, privateRoot: p.info.privateRoot, count: slots.length,
    dbSlot: slots.find((s) => s.role === DATABASE_ROLE)?.slot ?? null, drivers: slots };
}

export function writeDriver({ code, op, slot, values, force = false, dryRun = false, confirmed = false } = {}) {
  const p = openProject(code);
  if (!p.ok) return p;
  const exists = !!p.data.drivers?.[slot];
  if (op === 'add' && exists) {
    return { ok: false, exitCode: 2, error: `drivers.${slot} 已存在`, hint: '要改字段请用 update；要换实现请更新 impl（会自动重新探活）' };
  }
  if ((op === 'update' || op === 'remove') && !exists) {
    return { ok: false, exitCode: 3, error: `drivers.${slot} 不存在`,
      hint: `当前已登记：${Object.keys(p.data.drivers || {}).join(', ') || '（无）'}。先跑 list 看清名字再动手。` };
  }
  if (op === 'remove' && !confirmed) {
    return { ok: false, exitCode: 2, error: 'remove 需要 --yes',
      hint: '删条目会连带删掉用户给过的写能力声明（writes）与 desc。请先向用户复述要删的槽位与其描述，得到明确同意后再带 --yes 重跑。' };
  }

  const { fields, unknown } = normalizeValues(values, slot);
  if (unknown.length) {
    return { ok: false, exitCode: 3, error: `--values 里有不认识的字段：${unknown.join(', ')}`,
      hint: `可用字段：${FIELD_ORDER.join(', ')}（写盘前逐条过 schema，枚举错了会被点名）` };
  }
  // 存量非法项先拿一份底牌：下面只拦“这次改动新引入”的（差分理由见 gateProblems）。
  const baseErrors = checkDocument(p.data, loadSchema(), { expectCode: p.expectCode }).errors;
  let text = p.text;
  let createdSection = false;
  if (op === 'add') {
    // 渲染只有一处实现：递一份 init 形状的 flat values 给 buildDriversBlock，避免“init 渲染出的
    // 条目”与“/supperH-driver 登记的条目”长成两套形状（字段顺序、引号方式、writes 展开必须一致）。
    const flat = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'mcp') {
        flat[`drivers.${slot}.mcp.server`]  = v?.server;
        flat[`drivers.${slot}.mcp.sources`] = v?.sources;
      } else flat[`drivers.${slot}.${k}`] = v;
    }
    const rendered = buildDriversBlock(flat, [slot],
      String(fields.role ?? '').trim() === DATABASE_ROLE ? slot : null);
    const block = rendered ? rendered.split('\n').slice(1) : [];   // 去掉 'drivers:' 头
    if (!block.length) {
      return { ok: false, exitCode: 2, action: op, code, slot,
        problems: [`drivers.${slot} 什么都没渲染出来：新登记至少需要 desc + impl + healthCheck`],
        hint: '这三项是“这条通道存在且可用”的最小证据；缺一项就是把登记了一个用不到的源' };
    }
    const r = insertSlot(text, slot, block);
    if (!r.changed) return { ok: false, exitCode: 2, error: r.reason };
    text = r.text; createdSection = !!r.created;
  } else if (op === 'update') {
    const r = setSlotFields(text, slot, fields);
    if (!r.changed) return { ok: false, exitCode: 2, error: r.reason };
    text = r.text;
  } else {
    const r = deleteSlot(text, slot);
    if (!r.changed) return { ok: false, exitCode: 2, error: r.reason };
    text = r.text;
  }

  let merged;
  try { merged = YAML.parse(text); }
  catch (e) { return { ok: false, exitCode: 2, error: '改写后的文本不是合法 YAML：' + e.message, hint: '这是脚本缺陷，请把本消息原样报出来（勿手工改盘）' }; }
  const gate = gateProblems(merged, op, slot, p, baseErrors);
  if (gate.problems.length) {
    return { ok: false, exitCode: 2, action: op, code, slot, problems: gate.problems,
      warnings: gate.warnings, hint: op === 'add'
        ? '补齐后重跑 add。描述不足时先回问用户（这个源从哪里进去），不要先写一个含糊的 desc 占位。' : '补齐后重跑。' };
  }

  // 探活：只有"会影响可达性"的改动才跑（update 只改 desc 不必让驱动文件陪跑 30s）。
  const touchReachability = op === 'add'
    || (op === 'update' && ['impl', 'healthCheck', 'kind', 'mcp', 'fallback'].some((k) => k in fields));
  let probes = [], channelDecisions = [], gateNote = null;
  if (touchReachability && op !== 'remove') {
    const pr = probeOne(text, code, slot, p.info.privateRoot);
    probes = pr.probes;
    const decided = decideChannels(text, probes);      // kind=mcp 探不通 → 按声明降级为 script
    text = decided.text;
    channelDecisions = decided.decisions;
    merged = YAML.parse(text);
    const again = checkDocument(merged, loadSchema(), { expectCode: p.expectCode });
    const freshAgain = again.errors.filter((e) => !baseErrors.includes(e));
    if (freshAgain.length) {
      return { ok: false, exitCode: 2, action: op, code, slot, problems: freshAgain.map((e) => '通道降级后新引入的非法项：' + e),
        hint: '多半是 kind 改成 script 后 mcp 段残留（schema 不允许）：请改用 update 显式把 kind 设为 script 并把 mcp 置 null' };
    }
    const sc = probes.find((x) => x.channel === 'script');
    if (!force) {
      if (!sc || !sc.present) {
        gateNote = '驱动文件不存在';
        return { ok: false, exitCode: 20, action: op, code, slot, problems: [
          `drivers.${slot}.impl 指向的文件不存在：${sc?.impl ?? '(未给出)'}`,
        ], probes, warnings: gate.warnings,
        hint: '先把驱动实现落到 <PRIVATE_ROOT>/drivers/ 下（/supperH-driver 的探索分支），再登记；确认要"先登记后补实现"请加 --force' };
      }
      if (!sc.reachable) {
        return { ok: false, exitCode: 20, action: op, code, slot, problems: [
          `drivers.${slot} 探活未通过（healthCheck 退出码 ${sc.exit}）：${sc.detail || '无输出'}`,
        ], probes, warnings: gate.warnings,
        hint: '连通门禁取的是本地退出码（R3.5）。修好网络/凭据后重跑；确认要带病登记请加 --force（会原样记下不可达）' };
      }
    } else {
      gateNote = '连通门禁失败，--force 降级为警告';
      gate.warnings.push(`${gateNote}：drivers.${slot} 当前 ${!sc || !sc.present ? '驱动文件不存在（' + (sc?.impl ?? '未给出') + '）'
        : '探活未通过（退出码 ' + sc.exit + '）' + (sc.detail ? '：' + sc.detail : '')}。登记后运行期取数会退化为不可用`);
    }
  }

  const result = {
    ok: true, action: op, code, slot, file: p.file, dryRun: !!dryRun,
    createdDriversSection: createdSection,
    dbSlot: Object.entries(merged?.drivers || {}).find(([, c]) => c?.role === DATABASE_ROLE)?.[0] ?? null,
    entry: merged?.drivers?.[slot] ?? null,
    channelDecisions, probes, warnings: gate.warnings,
    // 与本次无关的存量非法项：不阻断（否则修不了单个字段），但必须说出来，
    // 因为同一个项目的 validate 仍会退 2，命令层要能解释“为什么写成功了报表还是红的”。
    ...(gate.preexisting.length ? { preexistingErrors: gate.preexisting } : {}),
    ...(gateNote ? { gateNote } : {}),
  };
  if (dryRun) { result.text = text; result.next = 'dry-run：未写盘。去掉 --dry-run 即落盘（会先备份为 <code>.yaml.bak）'; return result; }

  fs.copyFileSync(p.file, p.file + '.bak');
  fs.writeFileSync(p.file, text, 'utf8');
  result.backedUp = p.file + '.bak';
  result.next = `已写入 ${path.relative(p.info.privateRoot, p.file)}。跑 node scripts/validate-project.mjs --project ${code} 复核，`
    + '并在需要时跑 node scripts/sync-assets.mjs —— 新增槽位不改 L1 文本，通常无需重烤 dist。';
  return result;
}

export function healthDrivers({ code, slot } = {}) {
  const p = openProject(code);
  if (!p.ok) return p;
  if (!p.data.drivers || !Object.keys(p.data.drivers).length) {
    return { ok: true, code, file: p.file, probes: [], note: '该项目未登记任何外部数据源（纯代码模式）' };
  }
  if (slot && !p.data.drivers[slot]) {
    return { ok: false, exitCode: 3, error: `drivers.${slot} 不存在`, hint: `已登记：${Object.keys(p.data.drivers).join(', ')}` };
  }
  const text = slot ? YAML.stringify({ drivers: { [slot]: p.data.drivers[slot] } }) : p.text;
  const probes = probeDrivers(text, code, p.info.privateRoot);
  const bad = probes.filter((x) => x.gate !== false && !x.reachable);
  return { ok: true, code, slot: slot ?? null, file: p.file, probes,
    reachable: probes.filter((x) => x.gate !== false && x.reachable).length,
    configured: probes.filter((x) => x.gate !== false && x.present).length,
    unhealthy: bad.map((x) => `${x.slot}/${x.channel}: ${x.detail || (x.present ? '退出码 ' + x.exit : '文件缺失')}`) };
}

// ---- CLI ----
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const getArg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const action = argv.find((a) => !a.startsWith('--'));
  const code   = getArg('--project') || getArg('--code');
  const slot   = getArg('--slot');

  if (!action || action === 'help' || argv.includes('--help')) {
    console.error(USAGE.join('\n'));
    process.exit(action === 'help' || argv.includes('--help') ? 0 : 3);
  }
  if (!['list', 'add', 'update', 'remove', 'health'].includes(action)) {
    console.error('[driver] 未知动作：' + action); console.error(USAGE.join('\n')); process.exit(3);
  }
  if (!code) { console.error('[driver] 缺 --project <code>'); console.error(USAGE.join('\n')); process.exit(3); }
  if (['add', 'update', 'remove'].includes(action) && !slot) {
    console.error('[driver] ' + action + ' 需要 --slot <名字>（槽位名由你定，须匹配 ' + SLOT_NAME_RE.source + '）'); process.exit(3);
  }

  let values = {};
  if (action === 'add' || action === 'update') {
    const vf = getArg('--values');
    try {
      if (vf) values = JSON.parse(vf === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(vf, 'utf8'));
      else if (!process.stdin.isTTY) { const s = fs.readFileSync(0, 'utf8'); if (s.trim()) values = JSON.parse(s); }
    } catch (e) { emit({ ok: false, exitCode: 3, error: 'cannot read --values JSON: ' + e.message }); }
    if (!Object.keys(values).length) {
      emit({ ok: false, exitCode: 3, error: action + ' 需要 --values（JSON：文件路径或 stdin），至少给 desc',
        hint: 'add 至少三项：desc（人话描述：这个源是什么、从哪里进去）、impl、healthCheck' });
    }
  }

  const r = action === 'list'   ? listDrivers({ code, probe: argv.includes('--probe') })
    : action === 'health' ? healthDrivers({ code, slot })
    : writeDriver({ code, op: action, slot, values, force: argv.includes('--force'),
        dryRun: argv.includes('--dry-run'), confirmed: argv.includes('--yes') });

  if (r.ok && action === 'list') {
    if (!r.count) log(`项目 ${code} 未登记任何数据源（纯代码模式）`);
    for (const d of r.drivers) {
      const wsum = d.writes ? d.writes.map((w) => `${w.action}:${w.gate}`).join(',') : '(只读)';
      log(`${d.slot}${d.role ? ' [role:' + d.role + ']' : ''} kind=${d.kind} `
        + `writes=${wsum} :: ${d.desc ?? '（缺 desc：新登记会被拦，存量请补）'}`);
      if (argv.includes('--probe')) log(`    present=${d.present} reachable=${d.reachable}${d.detail ? ' ' + d.detail : ''}`);
    }
  } else if (!r.ok && (r.problems || []).length) {
    for (const x of r.problems) log('REJECT: ' + x);
  } else if (!r.ok && r.error) log('ERROR: ' + r.error + (r.hint ? ' — ' + r.hint : ''));

  emit(r);
}
