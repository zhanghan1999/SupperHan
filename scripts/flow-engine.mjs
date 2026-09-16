// scripts/flow-engine.mjs
//
// flow 引擎（flows 保留分区的确定性计算与落盘）—— 需求书《supperH 流程学习（flow）· 一期开发需求书
// v2.7》§3/§4/§5/§6 的执行侧实现。
//
// 为什么存在一个脚本，而不是把这套算法全写在 writer 的提示词里：
//   §8 的 17 条用例要求"可机械断言"（字节一致、结构不变式、五类端点、诊断定位）。
//   提示词里的算法无法被测试证伪，只能被"看起来对"地执行一遍。凡是需要**可重生成**
//   的计算（§6 步骤 3 顺序无关性、§8 用例 12/17）都必须落在确定性的代码里。
//   writer 仍然是唯一的写者：它经 `bash: allow` 调用本脚本，本脚本进程写私有根
//   不消耗任何 agent 权限（与 `--emit-sql` 的既有先例同构，见 resolve-project.mjs 头部）。
//
// 职责边界（三条，越界即设计错误）：
//   1. 本脚本**不做任何推理**：谁是上一步由 analyzer 读码得出，本脚本只负责
//      折叠、去重、校验、渲染、切指针。它不读工作区源码。
//   2. 只存 prev 方向的边（§4-A）。本脚本**不写 next 侧的任何字段**，
//      next 一律由 `page==X` / `prev_page==X` 两个方向的现查得出。
//   3. `flow-check.md` 是**体检报告不是数据**（§4-B2）：任何消费方（含本脚本的
//      query 命令）都不得读它，只读 `flow-index.md`。
//
// 退出码（对外契约，additive；30–37 段专属 bug 快路径分流，40 专属 I0，故另起一段）：
//   0  = 成功
//   36 = 调用方入参不完整/非法（与 resolve-project 的 36 同义）
//   41 = 前置未就绪（`--flow-readiness` 的 blockers 非空）
//   42 = 流程完整性校验失败（`FLOW_INTEGRITY_FAIL`，载荷里有 diagnostics[]）
//   43 = 写入边界违规（`WRITE_BOUNDARY_VIOLATION`，不重试）
export const EXIT = Object.freeze({
  OK: 0, BAD_ARGS: 36, NOT_READY: 41, INTEGRITY_FAIL: 42, BOUNDARY: 43
});

import fs   from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ───────────────────────────────────────────────────────────────────────────
// 契约常量（L1 协议：列顺序写下来就是契约，代码按它解析；改列 = 代际升级）
// ───────────────────────────────────────────────────────────────────────────

export const FLOWS_KIND = 'flows';
export const FLOWS_SCHEMA = 'flows-v1';
export const FLOWS_PART_KIND = 'flows-part';

/** 节点表列（**只有一列状态**：`prev_status`。next 侧不得出现任何状态/计数列） */
export const NODE_COLS = Object.freeze(['page_key', 'route', 'title', 'module', 'prev_status', 'evidence_ref']);
/** 边表列（恰 7 列；`superseded_by` 是唯一的允许追加列） */
export const EDGE_COLS = Object.freeze(['edge_id', 'page', 'prev_page', 'kind', 'basis', 'evidence', 'status']);
/** 外部接口段列（全中文化字段名，见需求书 §4-E；**只登记、不入边表**） */
export const EXTERNAL_COLS = Object.freeze([
  'direction', 'endpoint', 'points_to', 'via_page', 'via_route',
  'counterpart', 'evidence', 'scope', 'linked_flow'
]);
/** 允许追加的边表列（§5：被推翻的旧边不静默删，记 `superseded_by`） */
export const EDGE_ALLOWED_EXTRA_COLS = Object.freeze(['superseded_by']);

export const PREV_ROOT = 'root';
export const PREV_NO_DATA = 'no_data';
export const PREV_UNRESOLVED_PREFIX = 'unresolved:';
/** prev 三态的原因码集合。**不得**出现"库"或"语言/剖面"类码（需求书 v2.2 ②③、§4-D） */
export const UNRESOLVED_CODES = Object.freeze(['no_table_inventory', 'sources_incomplete']);
export const EDGE_KINDS = Object.freeze(['data_predecessor', 'navigation']);
export const EDGE_BASIS = Object.freeze(['inventory', 'read_code']);
export const EDGE_STATUS = Object.freeze(['confirmed', 'inferred', 'superseded']);
export const EXTERNAL_DIRECTIONS = Object.freeze(['out', 'in']);
export const EXTERNAL_SCOPE = 'outOfScope';

/** 分区名与文件名（`flow-parts/` 是中间态，**不是数据源**，任何消费方不得读它） */
export const PARTS_DIR = 'flow-parts';
export const INDEX_FILE = 'flow-index.md';
export const CHECK_FILE = 'flow-check.md';
export const NOTES_PREFIX = 'flow-notes-';
export const OPEN_SENTINEL = '.open';
/** 半成品标记文件的用途见 `discardOpenGens()` */

// L1 固定值：不进任何配置、不开运行期放宽口子（需求书 D2 零配置、§6「并发度与片大小都是 L1 固定值」）
export const ROUTES_PER_PART = 3;   // 一片 ≤ 3 个 route
export const PARTS_PER_WAVE = 2;    // 一波 ≤ 2 片
export const MAX_DEPTH = 5;         // 推理收敛深度（analyzer 侧的收敛条件）
export const COVERAGE_MIN = 0.95;   // 与 code 模式 index 覆盖率同判据，不放宽
export const NOTES_MAX_BYTES = 30 * 1024;
export const GEN_KEEP = 2;          // 保留最近 2 代
export const GEN_GRACE_MS = 24 * 60 * 60 * 1000; // 超期才物理删除（沿用 writer 的惰性 GC 规则）

/** 校验失败的不变量名（writer 回报 `diagnostics[].invariant`，主命令据此决定重试策略） */
export const INVARIANT = Object.freeze({
  PART_SHAPE: 'PART_SHAPE',
  DANGLING_EDGE: 'DANGLING_EDGE',
  COVERAGE: 'COVERAGE',
  BOUNDARY: 'BOUNDARY'
});

// ───────────────────────────────────────────────────────────────────────────
// route 归一化（**单点**：flows 与 screens 共用，见需求书 §4-A 护栏②）
// ───────────────────────────────────────────────────────────────────────────

const VAR_SEGMENT_RE = /^(?:\{[^{}]*\}|:[A-Za-z0-9_]+|\d+)$/;

/**
 * 页面的**唯一节点键** = 归一化后的 path。
 *
 * 折叠的三类写法差异正是"反查单向失败"（上一步查得到、下一步查不到）的来源：
 *   1. 大小写      —— `GET /Order/Detail` 与 `get /order/detail`
 *   2. 末尾斜杠    —— `/order/list/` 与 `/order/list`
 *   3. 路径变量    —— `/order/{id}` / `/order/:id` / `/order/123` 三种写法同键
 *
 * **丢弃 method** 是有意的：flow 的单位是"页面"，同一路径上的 GET/POST/DELETE
 * 属于同一个页面的不同动作（R3-1「不存代码，指向一定是页面」）。副作用如实写明：
 * 同 path 不同 method 在 flows 里合成一个节点，需要按接口粒度区分时归 code 分区。
 *
 * 与 `fastpath-gate.mjs` 的 `normRoute()` 的关系：**故意不合并**。那个函数是 bug
 * 快路径 G1 锚点匹配键，改它等于改既有判据（大小写折叠会让歧义锚点不再报 31）；
 * 判据类改动得走独立演进，不能搭 flow 的车。两者对"规整写法"的结果一致。
 *
 * @param {string} raw
 * @returns {string} 形如 `/order/{}`；空输入返回空串（调用方按缺字段处理）
 */
export function normalizeRoute(raw) {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = s.match(/^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\s+(\/.*)$/i);
  if (m) s = m[1];
  if (!s.startsWith('/')) s = '/' + s;
  s = s.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (s === '') s = '/';
  s = s.split('/').map((seg) => (VAR_SEGMENT_RE.test(seg) ? '{}' : seg)).join('/');
  return s;
}

/** 取一个节点/边端的页面键：优先用已给的 `page_key`，否则从 `route` 归一化 */
export function pageKeyOf(o = {}) {
  const direct = String(o.page_key ?? '').trim();
  if (direct) return normalizeRoute(direct);
  return normalizeRoute(o.route ?? '');
}

/** 文件名安全且**与到达顺序无关**的稳定键（§6 步骤 3「parts 的文件名取自该页归一化 route」） */
export function partFileName(routeKey) {
  const key = normalizeRoute(routeKey) || '_empty';
  const safe = key.replace(/^\/+/, '').replace(/[^a-z0-9{}._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'root';
  return `part-${safe}-${shortHash(key)}.md`;
}

/** 短哈希用纯 JS 实现（不引依赖）：FNV-1a 32bit，稳定、与平台无关 */
function shortHash(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ───────────────────────────────────────────────────────────────────────────
// Markdown 表格读写（渲染是字典序全排序后的确定性输出 → 同输入必同字节）
// ───────────────────────────────────────────────────────────────────────────

function escCell(v) {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function renderTable(cols, rows) {
  const head = `| ${cols.join(' | ')} |`;
  const sep = `|${cols.map(() => '---').join('|')}|`;
  const body = rows.map((r) => `| ${cols.map((c) => escCell(r[c])).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

/** 拆一行表格 → 单元格数组（去掉首尾空段） */
function splitCells(line) {
  const t = String(line).trim();
  if (!t.startsWith('|')) return null;
  const inner = t.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isSeparatorRow(cells) {
  return Array.isArray(cells) && cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function isHeaderRow(cells, cols) {
  if (!Array.isArray(cells) || cells.length !== cols.length) return false;
  return cells.every((c, i) => c.toLowerCase().replace(/\*/g, '').trim() === cols[i]);
}

/**
 * 从一段 markdown 里取"表头恰好等于 cols（顺序敏感）"的那张表。
 * 表头不匹配 = 形状漂移，直接由调用方判 `PART_SHAPE`；**绝不"尽力解析"**
 * （少一根竖线会让整列丢失，而丢失看起来像空值）。
 * @returns {{rows: Array<object>, headerLine: number, cols: string[], mismatch: string|null}}
 */
export function extractTable(text, cols) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const cells = splitCells(lines[i]);
    if (!cells || !isHeaderRow(cells, cols)) continue;
    const headerCols = cells.map((c) => c.toLowerCase().replace(/\*/g, '').trim());
    const rows = [];
    for (let j = i + 1; j < lines.length; j++) {
      const cs = splitCells(lines[j]);
      if (!cs) break;
      if (isSeparatorRow(cs)) continue;
      if (cs.length !== headerCols.length) {
        return { rows: [], headerLine: i + 1, cols: headerCols, mismatch: `第 ${j + 1} 行列数 ${cs.length} ≠ 表头 ${headerCols.length}`, line: j + 1 };
      }
      const row = { _line: j + 1 };
      headerCols.forEach((c, k) => { row[c] = cs[k]; });
      rows.push(row);
    }
    return { rows, headerLine: i + 1, cols: headerCols, mismatch: null };
  }
  return { rows: [], headerLine: -1, cols: [], mismatch: `未找到表头 | ${cols.join(' | ')} |`, line: 0 };
}

// frontmatter：只做 `key: value` 的扁平读写（flow 产物没有嵌套结构，引掉 YAML 依赖的
// 必要性 —— 也避免 YAML 把 `learnedAtCommit: 0000000` 推定成数字、前导零丢失）
function parseFrontmatter(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const out = {};
  if (!src.startsWith('---\n')) return out;
  const end = src.indexOf('\n---', 4);
  if (end < 0) return out;
  for (const line of src.slice(4, end).split('\n')) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function renderFrontmatter(obj) {
  const lines = Object.entries(obj).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

// ───────────────────────────────────────────────────────────────────────────
// 判据：prev 三态 / 路径形态
// ───────────────────────────────────────────────────────────────────────────

export function isUnresolved(v) {
  return String(v ?? '').startsWith(PREV_UNRESOLVED_PREFIX);
}
export function unresolvedCode(v) {
  const s = String(v ?? '');
  return s.startsWith(PREV_UNRESOLVED_PREFIX) ? s.slice(PREV_UNRESOLVED_PREFIX.length) : null;
}
/** 三态判据：`root` / `no_data` / `unresolved:<原因码>`（原因码不在集合内即形状错） */
export function isLegalPrevStatus(v) {
  const s = String(v ?? '');
  if (s === PREV_ROOT || s === PREV_NO_DATA) return true;
  const code = unresolvedCode(s);
  return code !== null && UNRESOLVED_CODES.includes(code);
}
/** 状态严重度（同页两片给出不同状态时的确定性取舍：查不出 > 不适用 > 确无上游） */
function prevStatusRank(s) {
  if (isUnresolved(s)) return 0;
  if (s === PREV_NO_DATA) return 1;
  if (s === PREV_ROOT) return 2;
  return 3;
}

/** 产物里的路径一律 repo-relative POSIX；绝对路径进产物 = 跨机器/跨 worktree 必失效 */
const ILLEGAL_PATH_RE = /^(?:[A-Za-z]:[\\/]|[\\/]|.*\\)/;
/** 从 evidence 文本里挑出"像文件路径"的片段做形态校验（`a/b.xml:12 insert t_x` 这种写法） */
export function illegalPathProblems(text) {
  const out = [];
  for (const tok of String(text ?? '').split(/\s+/)) {
    const t = tok.replace(/:\d+$/, '');
    if (!t.includes('/') && !t.includes('\\')) continue;
    if (!/\.(?:java|kt|xml|sql|yml|yaml|properties|md|js|ts|vue|scala|groovy)$/i.test(t)) continue;
    if (ILLEGAL_PATH_RE.test(t) || t.startsWith('./')) out.push(tok);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// part：一片 = 一页的节点行 + 它的 prev 边行（+ 它发现的外部接口登记）
// ───────────────────────────────────────────────────────────────────────────

/** analyzer 一片的返回（压缩结构：表格行 + status，无解释性正文） */
export function normalizePartPayload(payload = {}) {
  const nodes = (Array.isArray(payload.nodes) ? payload.nodes : []).map((n) => ({
    page_key: pageKeyOf(n),
    route: String(n.route ?? n.page_key ?? '').trim(),
    title: String(n.title ?? '').trim(),
    module: String(n.module ?? '').trim(),
    prev_status: String(n.prev_status ?? '').trim(),
    evidence_ref: String(n.evidence_ref ?? '').trim()
  }));
  const edges = (Array.isArray(payload.edges) ? payload.edges : []).map((e) => ({
    page: pageKeyOf({ page_key: e.page, route: e.page }),
    prev_page: pageKeyOf({ page_key: e.prev_page, route: e.prev_page }),
    kind: String(e.kind ?? '').trim(),
    basis: String(e.basis ?? '').trim(),
    evidence: String(evidenceTextOf(e)).trim(),
    status: String(e.status ?? '').trim()
  }));
  const externals = (Array.isArray(payload.externals) ? payload.externals : []).map((x) => ({
    direction: String(x.direction ?? '').trim(),
    endpoint: String(x.endpoint ?? '').trim(),
    points_to: String(x.points_to ?? '').trim(),
    via_page: pageKeyOf({ page_key: x.via_page, route: x.via_page }),
    via_route: String(x.via_route ?? '').trim(),
    counterpart: String(x.counterpart ?? '').trim(),
    evidence: String(x.evidence ?? '').trim(),
    scope: String(x.scope ?? EXTERNAL_SCOPE).trim() || EXTERNAL_SCOPE,
    linked_flow: String(x.linked_flow ?? '').trim()
  }));
  return { nodes, edges, externals };
}

function evidenceTextOf(e) {
  if (typeof e.evidence === 'string') return e.evidence;
  if (Array.isArray(e.evidence)) return e.evidence.join('; ');
  if (e.evidence && typeof e.evidence === 'object') return JSON.stringify(e.evidence);
  return String(e.evidence_text ?? e.source ?? '');
}

/** 渲染一片（写入 `flow-parts/part-*.md`） */
export function renderPart(payload) {
  const { nodes, edges, externals } = normalizePartPayload(payload);
  const parts = [renderFrontmatter({ kind: FLOWS_PART_KIND, schema: FLOWS_SCHEMA })];
  parts.push('## 节点表（本片所含页面）', '', renderTable(NODE_COLS, nodes), '');
  // 边 id 由整理阶段统一重排（各 agent 之间不需要约定 id），这里一律占位 `-`
  parts.push('## 边表（page ← prev_page，只存 prev 方向）', '', renderTable(EDGE_COLS, edges.map((e) => ({ ...e, edge_id: '-' }))), '');
  if (externals.length) {
    parts.push('## 外部接口（只登记，不参与上一步/下一步推理，不进边表）', '', renderTable(EXTERNAL_COLS, externals), '');
  }
  return parts.join('\n') + '\n';
}

/**
 * 解析一片 → { nodes, edges, externals, problems }
 * problems 一律归 `PART_SHAPE`（表头不符 / 列数不对 / 枚举值非法 / 路径非法）。
 */
export function parsePart(text, origin = '(part)') {
  const problems = [];
  const fm = parseFrontmatter(text);
  if (fm.kind !== FLOWS_PART_KIND) problems.push({ part: origin, line: 1, invariant: INVARIANT.PART_SHAPE, message: `frontmatter kind='${fm.kind ?? '缺失'}' ≠ '${FLOWS_PART_KIND}'` });
  if (fm.schema !== FLOWS_SCHEMA) problems.push({ part: origin, line: 1, invariant: INVARIANT.PART_SHAPE, message: `frontmatter schema='${fm.schema ?? '缺失'}' ≠ '${FLOWS_SCHEMA}'` });

  const nt = extractTable(text, NODE_COLS);
  if (nt.mismatch) problems.push({ part: origin, line: nt.line || 1, invariant: INVARIANT.PART_SHAPE, message: `节点表：${nt.mismatch}` });
  const et = extractTable(text, EDGE_COLS);
  if (et.mismatch) problems.push({ part: origin, line: et.line || 1, invariant: INVARIANT.PART_SHAPE, message: `边表：${et.mismatch}` });
  const xt = extractTable(text, EXTERNAL_COLS); // 外部段可整段缺席，不算形状错
  const externalsAbsent = xt.headerLine < 0;

  const nodes = nt.rows.map((r) => ({
    page_key: normalizeRoute(r.page_key), route: r.route || '', title: r.title || '',
    module: r.module || '', prev_status: r.prev_status || '', evidence_ref: r.evidence_ref || '',
    _line: r._line, _part: origin
  }));
  const edges = et.rows.map((r) => ({
    page: normalizeRoute(r.page), prev_page: normalizeRoute(r.prev_page),
    kind: r.kind || '', basis: r.basis || '', evidence: r.evidence || '', status: r.status || '',
    _line: r._line, _part: origin
  }));
  const externals = externalsAbsent ? [] : xt.rows.map((r) => ({
    ...r, _line: r._line, _part: origin
  }));

  for (const n of nodes) {
    if (!n.page_key) problems.push({ part: origin, line: n._line, invariant: INVARIANT.PART_SHAPE, message: '节点表 page_key 归一化后为空' });
    if (!isLegalPrevStatus(n.prev_status)) problems.push({ part: origin, line: n._line, invariant: INVARIANT.PART_SHAPE, message: `prev_status='${n.prev_status}' 不是三态之一（root / no_data / unresolved:${UNRESOLVED_CODES.join('|')}）` });
  }
  for (const e of edges) {
    if (!EDGE_KINDS.includes(e.kind)) problems.push({ part: origin, line: e._line, invariant: INVARIANT.PART_SHAPE, message: `kind='${e.kind}' 不在 ${EDGE_KINDS.join('/')}` });
    if (!EDGE_BASIS.includes(e.basis)) problems.push({ part: origin, line: e._line, invariant: INVARIANT.PART_SHAPE, message: `basis='${e.basis}' 不在 ${EDGE_BASIS.join('/')}` });
    if (!EDGE_STATUS.includes(e.status)) problems.push({ part: origin, line: e._line, invariant: INVARIANT.PART_SHAPE, message: `status='${e.status}' 不在 ${EDGE_STATUS.join('/')}` });
    if (!e.evidence) problems.push({ part: origin, line: e._line, invariant: INVARIANT.PART_SHAPE, message: '边没有 evidence（一条边必须可否证）' });
    for (const bad of illegalPathProblems(e.evidence)) {
      problems.push({ part: origin, line: e._line, invariant: INVARIANT.PART_SHAPE, message: `evidence 里的路径不是 repo-relative POSIX：${bad}` });
    }
  }
  for (const x of externals) {
    if (!EXTERNAL_DIRECTIONS.includes(x.direction)) problems.push({ part: origin, line: x._line, invariant: INVARIANT.PART_SHAPE, message: `外部接口 direction='${x.direction}' 不在 out/in` });
    if (x.scope !== EXTERNAL_SCOPE) problems.push({ part: origin, line: x._line, invariant: INVARIANT.PART_SHAPE, message: `外部接口 scope 必须固定写 ${EXTERNAL_SCOPE}（实际 '${x.scope}'）` });
    if (!x.endpoint) problems.push({ part: origin, line: x._line, invariant: INVARIANT.PART_SHAPE, message: '外部接口缺 endpoint 标识' });
  }
  return { nodes, edges, externals, problems };
}

// ───────────────────────────────────────────────────────────────────────────
// 折叠与合并（**只发生在整理阶段这一个点**，需求书 §5 去重键）
// ───────────────────────────────────────────────────────────────────────────

export function edgeKey(e) {
  return `${e.page}\u0000${e.prev_page}`;
}
const BASIS_RANK = { inventory: 0, read_code: 1 };
const STATUS_RANK = { confirmed: 0, inferred: 1, superseded: 2 };
/** 比较两条"同一去重键"的边，返回更优的那条（evidence 更全 → basis 更主 → status 更硬 → 字典序） */
function betterEdge(a, b) {
  const la = (a.evidence || '').length, lb = (b.evidence || '').length;
  if (la !== lb) return la > lb ? a : b;
  const ba = BASIS_RANK[a.basis] ?? 9, bb = BASIS_RANK[b.basis] ?? 9;
  if (ba !== bb) return ba < bb ? a : b;
  const sa = STATUS_RANK[a.status] ?? 9, sb = STATUS_RANK[b.status] ?? 9;
  if (sa !== sb) return sa < sb ? a : b;
  return `${a.kind}|${a.evidence}` <= `${b.kind}|${b.evidence}` ? a : b;
}

function sameEdgeContent(a, b) {
  return a.kind === b.kind && a.basis === b.basis && a.evidence === b.evidence && a.status === b.status;
}

/** 按归一化 (page, prev_page) 折叠成一条 —— **分片与并发阶段一律不调用它** */
export function foldEdges(edges) {
  const map = new Map();
  for (const e of edges) {
    const k = edgeKey(e);
    const cur = map.get(k);
    map.set(k, cur ? betterEdge(cur, e) : e);
  }
  return map;
}

/** 合并节点（同 page_key 折叠：title/module/route 取非空字典序最小，prev_status 取最保守） */
export function foldNodes(nodes) {
  const map = new Map();
  for (const n of nodes) {
    const k = n.page_key || normalizeRoute(n.route);
    const cur = map.get(k);
    if (!cur) { map.set(k, { ...n, page_key: k }); continue; }
    const pick = (a, b) => (a && b ? (String(a) <= String(b) ? a : b) : (a || b || ''));
    map.set(k, {
      page_key: k,
      route: pick(cur.route, n.route),
      title: pick(cur.title, n.title),
      module: pick(cur.module, n.module),
      prev_status: prevStatusRank(cur.prev_status) <= prevStatusRank(n.prev_status) ? cur.prev_status : n.prev_status,
      evidence_ref: pick(cur.evidence_ref, n.evidence_ref)
    });
  }
  return map;
}

/**
 * 整代合并：新代边集 = 上一代全集 ∪ 本轮新算（§5）。
 * 同一条边冲突时**本轮为准**，被推翻的旧边 `status: superseded` + `superseded_by: <新边id>`，
 * **不静默删**，也绝不 in-place 改旧代目录。
 */
export function mergeGeneration(prev, incoming) {
  // prev.nodes 来自 parseIndex，是 Map（key→node）；incoming.nodes 是数组。
  // Map 直接 `[...map]` 展开会得到 `[key, value]` 元组数组，foldNodes 里
  // `n.page_key`/`n.route` 皆 undefined → 归一成空串，上一代节点整批丢失并
  // 产生空键幽灵节点。这里把两种形状统一成 node 对象数组再折叠。
  const toNodeArr = (x) => (x instanceof Map ? [...x.values()] : (x ?? []));
  const nodeMap = foldNodes([...toNodeArr(prev?.nodes), ...toNodeArr(incoming?.nodes)]);
  const prevKeyMap = foldEdges((prev?.edges ?? []).filter((e) => e.status !== 'superseded'));
  const newMap = foldEdges(incoming?.edges ?? []);
  const kept = [];
  for (const [k, e] of prevKeyMap) {
    const neu = newMap.get(k);
    // 同键且内容相同 = 同一条边被两片各推一次 → 折叠成一条，不产生 superseded 噪声
    if (neu && sameEdgeContent(e, neu)) continue;
    // 同键但内容不同 = 本轮推翻上一代：旧边不静默删，记 superseded_by
    kept.push(neu ? { ...e, status: 'superseded', _superseded_by_key: k } : { ...e });
  }
  const fresh = [...newMap.values()].map((e) => ({ ...e }));
  const edges = [...kept, ...fresh];
  const externals = mergeExternals([...(prev?.externals ?? []), ...(incoming?.externals ?? [])]);
  return { nodes: nodeMap, edges, externals };
}

function mergeExternals(list) {
  const map = new Map();
  for (const x of list) {
    const k = `${x.direction}|${x.via_page}|${x.endpoint}`;
    if (!map.has(k)) map.set(k, x);
  }
  return [...map.values()];
}

/** 统一重排边 id（各 agent 之间不需要约定 id）；返回带 `edge_id` 的行与 key→id 反查表 */
export function renumberEdges(edges) {
  const sorted = [...edges].sort((a, b) => {
    if (a.page !== b.page) return a.page < b.page ? -1 : 1;
    if (a.prev_page !== b.prev_page) return a.prev_page < b.prev_page ? -1 : 1;
    return a.status === 'superseded' ? -1 : 1;
  });
  const idByKey = new Map();
  const rows = sorted.map((e, i) => {
    const id = `E${i + 1}`;
    if (e.status !== 'superseded') idByKey.set(edgeKey(e), id);
    return { edge_id: id, ...e };
  });
  for (const r of rows) {
    if (r.status === 'superseded') {
      const nid = idByKey.get(r._superseded_by_key ?? edgeKey(r));
      if (nid) r.superseded_by = nid;
    }
  }
  return { rows, idByKey };
}

// ───────────────────────────────────────────────────────────────────────────
// 端点自检五类（§4-B2：体检报告，不是数据；只依赖 prev 边集）
// ───────────────────────────────────────────────────────────────────────────

/**
 * @param {object} g {nodes:Map, edges:[{page,prev_page,...}]}
 * @param {Set|null} pageSet 当前页面档案里的页面键集合（null = 取不到，悬挂边判不了）
 */
export function analyzeGraph(g, pageSet) {
  const nodeKeys = [...g.nodes.keys()];
  const nodeSet = new Set(nodeKeys);
  const liveEdges = g.edges.filter((e) => e.status !== 'superseded');
  const hasPrev = new Set(liveEdges.map((e) => e.page));
  const isPrevOf = new Set(liveEdges.map((e) => e.prev_page));

  const entryPages = nodeKeys.filter((k) => !hasPrev.has(k)).sort();
  const leafPages = nodeKeys.filter((k) => !isPrevOf.has(k)).sort();
  const entrySet = new Set(entryPages);
  // 孤立页 = 既是入口又是末叶，**且本轮页面集 > 1**（单页代次里一个节点天然两头空，不构成信号）
  const orphanPages = nodeKeys.length > 1 ? leafPages.filter((k) => entrySet.has(k)).sort() : [];

  const dangling = [];
  for (const e of liveEdges) {
    for (const end of [e.page, e.prev_page]) {
      if (pageSet && !pageSet.has(end)) {
        dangling.push({ page: e.page, prev_page: e.prev_page, missing: end, kind: e.kind });
        break;
      }
    }
  }
  dangling.sort((a, b) => (a.page + a.prev_page) < (b.page + b.prev_page) ? -1 : 1);

  // 悬挂边的第二来源：边指向的端点根本不在节点表里（EDGE_ENDPOINT_NOT_FOUND 的自检侧对应物）
  const endpointMissing = [];
  for (const e of liveEdges) {
    for (const end of [e.page, e.prev_page]) if (!nodeSet.has(end)) endpointMissing.push({ page: e.page, prev_page: e.prev_page, missing: end });
  }

  const cycles = findCycles(nodeKeys, liveEdges);
  // 入口页里的"查不出"细分（**只是呈现层拆分，不新增任何列**）：
  // entry_pages 的判据按需求书 §4-B2 只看边集，但"30 个入口页"到底是 30 个真第一步
  // 还是 30 个没推出上游，得能一眼分开——前者是结论，后者是证据链整级不可用。
  const nodeOf = (k) => g.nodes.get(k);
  const entryUnresolved = entryPages.filter((k) => isUnresolved(nodeOf(k)?.prev_status));
  const entryConfirmedRoot = entryPages.filter((k) => nodeOf(k)?.prev_status === PREV_ROOT);
  const entryNoData = entryPages.filter((k) => nodeOf(k)?.prev_status === PREV_NO_DATA);
  return {
    node_count: nodeKeys.length,
    edge_count: liveEdges.length,
    pageSetAvailable: !!pageSet,
    entry_pages: entryPages,
    entry_unresolved: entryUnresolved,
    entry_root: entryConfirmedRoot,
    entry_no_data: entryNoData,
    leaf_pages: leafPages,
    orphan_pages: orphanPages,
    dangling_edges: dangling,
    endpoint_missing: endpointMissing,
    cycles,
    entry_ratio: nodeKeys.length ? +(entryPages.length / nodeKeys.length).toFixed(4) : 0,
    leaf_ratio: nodeKeys.length ? +(leafPages.length / nodeKeys.length).toFixed(4) : 0,
    coverage: null
  };
}

/** 沿 prev_page 走能回到自己的环。返回每个环的页链（起点取字典序最小 → 与遍历顺序无关） */
export function findCycles(keys, edges) {
  const adj = new Map();
  for (const k of keys) adj.set(k, []);
  for (const e of edges) if (adj.has(e.page)) adj.get(e.page).push(e.prev_page);
  const state = new Map(); // 0/未记=white 1=grey 2=black
  const seen = new Set();
  const out = [];
  const sortedKeys = [...keys].sort();
  const dfs = (node, stack) => {
    state.set(node, 1);
    stack.push(node);
    for (const nxt of [...(adj.get(node) || [])].sort()) {
      if (state.get(nxt) === 1) {
        const at = stack.indexOf(nxt);
        const cyc = stack.slice(at >= 0 ? at : 0);
        const canon = canonicalCycle(cyc);
        if (!seen.has(canon)) { seen.add(canon); out.push(canon); }
      } else if (!state.get(nxt)) {
        dfs(nxt, stack);
      }
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const k of sortedKeys) if (!state.get(k)) dfs(k, []);
  return out.sort();
}

function canonicalCycle(cyc) {
  const arr = [...cyc];
  let minAt = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] < arr[minAt]) minAt = i;
  const rot = [...arr.slice(minAt), ...arr.slice(0, minAt)];
  return rot.join(' → ');
}

// ───────────────────────────────────────────────────────────────────────────
// 渲染：flow-index.md / flow-check.md / flow-notes-NN.md
// ───────────────────────────────────────────────────────────────────────────

export function renderIndex(o) {
  const nodeRows = [...o.nodes.values()].sort((a, b) => (a.page_key < b.page_key ? -1 : 1)).map((n) => ({
    page_key: n.page_key, route: n.route, title: n.title, module: n.module,
    prev_status: n.prev_status, evidence_ref: n.evidence_ref
  }));
  const { rows: edgeRows } = renumberEdges(o.edges);
  const fm = renderFrontmatter({
    kind: FLOWS_KIND,
    schema: FLOWS_SCHEMA,
    learnedAtCommit: `"${o.learnedAtCommit ?? ''}"`,
    generatedBy: o.generatedBy ?? 'supperH-prelearn-writer(mode:flow)',
    node_count: nodeRows.length,
    edge_count: edgeRows.filter((r) => r.status !== 'superseded').length,
    superseded_count: edgeRows.filter((r) => r.status === 'superseded').length,
    external_count: (o.externals ?? []).length,
    page_set_count: o.pageSet ? o.pageSet.size : 0
  });
  const parts = [fm];
  parts.push('# flows 索引（唯一读取入口）', '');
  parts.push('> 本表**只存 prev 方向的边**。"下一步有谁" = 现查所有 `prev_page == 本页` 的行；',
    '> next 侧不存在任何状态列（存了就等于存了 next，且两个真相源冲突时没有裁决者）。', '');
  parts.push('## 节点表', '', renderTable(NODE_COLS, nodeRows), '');
  parts.push('## 边表', '', renderTable(edgeColsOf(edgeRows), edgeRows), '');
  const extCols = (o.externals ?? []).length ? EXTERNAL_COLS : null;
  parts.push('## 外部接口（不参与上一步/下一步推理）', '');
  if (extCols) parts.push(renderTable(extCols, o.externals), '');
  else parts.push('本轮无外部接口登记。', '');
  return parts.join('\n') + '\n';
}

function edgeColsOf(rows) {
  return rows.some((r) => r.superseded_by !== undefined && r.superseded_by !== '')
    ? [...EDGE_COLS, ...EDGE_ALLOWED_EXTRA_COLS]
    : EDGE_COLS;
}

export function renderCheck(a, meta = {}) {
  const fm = renderFrontmatter({
    kind: FLOWS_KIND + '-check', schema: FLOWS_SCHEMA,
    derived_from: INDEX_FILE, blocking: a.dangling_edges.length > 0 ? 'true' : 'false',
    recomputed_at: meta.now ?? ''
  });
  const pct = (n) => `${(n * 100).toFixed(2)}%`;
  const L = [fm];
  L.push('# flows 端点自检报告', '');
  L.push('> **这份报告是派生物，不是数据源**：每次 flow 学习收尾时对整代边集全量重算 + 整体重写，',
    '> 可删可原样重生成。回答"下一步"时**绝不读它**（读了就等于把 next 存下来）。', '>');
  L.push('> 它是**呈现 + 建议**，不是判定失败。唯一例外：悬挂边 > 0 ⇒ flows 产物不可信 ⇒ `CURRENT` 不切（报 `FLOW_STALE_PAGESET`）。',
    '入口页/末叶页/孤立页/环**永不阻断**——它们都可能合法存在，判红会逼执行者去编边或静默断环。', '');
  L.push(`- 节点数：${a.node_count}　活边数：${a.edge_count}　页面档案可读：${a.pageSetAvailable ? 'yes' : 'no（悬挂边无法判定）'}`, '');
  L.push('| 检查项 | 数量 | 占比/说明 |');
  L.push('|---|---|---|');
  L.push(`| entry_pages（入口页：没有上一步） | ${a.entry_pages.length} | ${pct(a.entry_ratio)} 超出预期通常意味着证据链整级不可用，不是真有很多第一步 |`);
  L.push(`| leaf_pages（末叶页：没被任何页当作上一步） | ${a.leaf_pages.length} | ${pct(a.leaf_ratio)} 过多意味着有页面的下游没学全 |`);
  L.push(`| orphan_pages（孤立页：既是入口又是末叶） | ${a.orphan_pages.length} | 必须逐条列，见下 |`);
  L.push(`| dangling_edges（悬挂边：端点已不在页面档案里） | ${a.dangling_edges.length} | >0 即阻断 CURRENT 切换 |`);
  L.push(`| cycles（环：沿 prev 走回到自己） | ${a.cycles.length} | 只列不阻断，不得静默断环 |`);
  L.push('');
  L.push('## 明细', '');
  L.push('### entry_pages', '', ...(a.entry_pages.length ? a.entry_pages.map((k) => `- \`${k}\``) : ['- （无）']), '');
  if (a.entry_pages.length) {
    L.push('（拆分，仅呈现：真第一步 ' + (a.entry_root?.length ?? 0) + '　查不出 ' + (a.entry_unresolved?.length ?? 0)
      + '　无此类动作 ' + (a.entry_no_data?.length ?? 0) + '）', '');
  } else L.push('');
  L.push('### leaf_pages', '', ...(a.leaf_pages.length ? a.leaf_pages.map((k) => `- \`${k}\``) : ['- （无）']), '');
  L.push('### orphan_pages（逐条给补学建议）', '');
  if (!a.orphan_pages.length) L.push('- （无）', '');
  else for (const k of a.orphan_pages) L.push(`- \`${k}\` —— 整条边都没推出来：先确认它的新增动作写了哪张表，再用 \`/supperH-learn --flow ${k}\` 单页重跑`);
  L.push('');
  L.push('### dangling_edges（列边 + 列缺失端 + 建议）');
  if (!a.dangling_edges.length) L.push('- （无）', '');
  else for (const d of a.dangling_edges) L.push(`- \`${d.page}\` ← \`${d.prev_page}\`：端点 \`${d.missing}\` 已不在当前页面档案里 —— 建议重跑 \`/supperH-learn --screen\` 后再重跑这些 route`);
  L.push('');
  L.push('### cycles（逐条列出环上的页链，只呈现不切断）');
  if (!a.cycles.length) L.push('- （无）', '');
  else for (const c of a.cycles) L.push(`- \`${c}\``);
  L.push('');
  L.push('### 外部接口登记数（不计入以上任何判据）', '', `- 本代登记：${a.external_count ?? 0} 条`, '');
  return L.join('\n') + '\n';
}

/** 叙述体（树形呈现："第一步→第二步→…"）。存图呈树，这一段只是渲染结果 */
export function renderNotes(a) {
  const lines = ['# flows 叙述（按 prev 边集渲染出的流程树）', ''];
  lines.push('> 本节是**呈现**：入口页往下顺着"谁把我当上一步"走。数据只在 `flow-index.md` 的边表里。', '');
  const roots = [...a.entry_pages].sort();
  if (!roots.length) lines.push('（本代没有入口页：每个节点都有上一步，见 cycles）', '');
  for (const r of roots) {
    lines.push(`## 入口 \`${r}\``, '');
    walkForward(a, r, new Set(), lines, 0);
    lines.push('');
  }
  const text = lines.join('\n') + '\n';
  return splitByBytes(text, NOTES_MAX_BYTES, NOTES_PREFIX);
}

function walkForward(a, page, guard, lines, depth) {
  const kids = (a.nextIndex?.get(page) ?? []);
  if (!kids.length) { lines.push(`${'  '.repeat(depth)}- \`${page}\`（终点）`); return; }
  lines.push(`${'  '.repeat(depth)}- \`${page}\``);
  if (guard.has(page) || depth > MAX_DEPTH * 4) { lines.push(`${'  '.repeat(depth + 1)}- （环或超深，停止展开）`); return; }
  guard.add(page);
  for (const k of kids) walkForward(a, k, guard, lines, depth + 1);
  guard.delete(page);
}

function splitByBytes(text, maxBytes, prefix) {
  const chunks = [];
  const lines = String(text).split('\n');
  let cur = '', n = 0;
  const flush = () => { if (cur) { chunks.push({ name: `${prefix}${String(n + 1).padStart(2, '0')}.md`, text: cur }); n++; } cur = ''; };
  for (const ln of lines) {
    const candidate = cur ? cur + '\n' + ln : ln;
    if (Buffer.byteLength(candidate, 'utf8') > maxBytes && cur) { flush(); cur = ln; }
    else cur = candidate;
  }
  flush();
  if (!chunks.length) chunks.push({ name: `${prefix}01.md`, text: '' });
  return chunks;
}

// ───────────────────────────────────────────────────────────────────────────
// 私有根读写边界（`BOUNDARY` 类诊断的唯一出口）
// ───────────────────────────────────────────────────────────────────────────

export class BoundaryError extends Error {
  constructor(msg) { super(msg); this.name = 'BoundaryError'; this.code = 'WRITE_BOUNDARY_VIOLATION'; }
}

/**
 * 校验 contextRoot 的形态。**为什么要在脚本里再校一遍**：writer 自己有条文边界，
 * 但条文是提示词；这里是机械边界——非绝对路径、含 `..`、写成工具仓根目录的，一律 43。
 */
export function assertContextRoot(p) {
  const s = String(p ?? '').trim();
  if (!s) throw new BoundaryError('缺 --context-root：flow 引擎不自行解析私有根（单点解析在 resolve-project.mjs）');
  if (!path.isAbsolute(s)) throw new BoundaryError(`--context-root 必须是绝对路径，收到 '${s}'`);
  const norm = path.normalize(s);
  if (norm.split(path.sep).includes('..')) throw new BoundaryError('--context-root 含路径穿越');
  if (/[<>"|?*]/.test(norm)) throw new BoundaryError('--context-root 含非法文件名字符');
  const base = path.basename(norm);
  if (!base || base === path.parse(norm).root) throw new BoundaryError('--context-root 指向文件系统根，不可能是项目上下文目录');
  return norm;
}

function flowsDir(contextRoot) { return path.join(assertContextRoot(contextRoot), FLOWS_KIND); }

function genDirOf(contextRoot, gen) {
  if (!/^gen-\d{14}$/.test(String(gen ?? ''))) throw new BoundaryError(`gen 目录名不合法：'${gen}'（必须形如 gen-yyyymmddHHMMSS）`);
  return path.join(flowsDir(contextRoot), gen);
}

/** 当前代目录名（CURRENT 内容）；无指针返回 null */
export function readCurrentGen(contextRoot) {
  const f = path.join(flowsDir(contextRoot), 'CURRENT');
  if (!fs.existsSync(f)) return null;
  let v = '';
  try { v = fs.readFileSync(f, 'utf8').trim(); } catch { return null; }
  return /^gen-\d{14}$/.test(v) ? v : null;
}

function writeAtomic(dir, name, text) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, name + '.tmp');
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, path.join(dir, name));
}

/**
 * 原子切 `CURRENT`（tmp + rename）。**flow 全程只在整理阶段末尾切一次** —— 这是对
 * code 模式每批即切的有意偏离（半张流程图会主动误导，见需求书 §6 末尾）。
 */
export function switchCurrent(contextRoot, gen) {
  writeAtomic(flowsDir(contextRoot), 'CURRENT', gen + '\n');
  return path.join(flowsDir(contextRoot), 'CURRENT');
}

/** 上一代全集（整代合并的左操作数）；没有就返回 null */
export function readPrevGeneration(contextRoot) {
  const gen = readCurrentGen(contextRoot);
  if (!gen) return null;
  const dir = genDirOf(contextRoot, gen);
  const idx = path.join(dir, INDEX_FILE);
  if (!fs.existsSync(idx)) return null;
  let text;
  try { text = fs.readFileSync(idx, 'utf8'); } catch { return null; }
  return parseIndex(text, dir);
}

/** 解析 flow-index.md（唯一读取入口） */
export function parseIndex(text, origin = INDEX_FILE) {
  const fm = parseFrontmatter(text);
  const nt = extractTable(text, NODE_COLS);
  const edgeColsAll = [...EDGE_COLS, ...EDGE_ALLOWED_EXTRA_COLS];
  let et = extractTable(text, EDGE_COLS);
  let usedCols = EDGE_COLS;
  if (et.mismatch) { et = extractTable(text, edgeColsAll); usedCols = edgeColsAll; }
  const xt = extractTable(text, EXTERNAL_COLS);
  const nodes = new Map();
  for (const r of (nt.rows || [])) {
    const k = normalizeRoute(r.page_key);
    if (!k) continue;
    nodes.set(k, {
      page_key: k, route: r.route || '', title: r.title || '', module: r.module || '',
      prev_status: r.prev_status || '', evidence_ref: r.evidence_ref || ''
    });
  }
  const edges = (et.rows || []).map((r) => ({
    edge_id: r.edge_id || '', page: normalizeRoute(r.page), prev_page: normalizeRoute(r.prev_page),
    kind: r.kind || '', basis: r.basis || '', evidence: r.evidence || '', status: r.status || '',
    superseded_by: r.superseded_by || ''
  }));
  const externals = xt.headerLine < 0 ? [] : xt.rows.map((r) => ({
    direction: r.direction || '', endpoint: r.endpoint || '', points_to: r.points_to || '',
    via_page: normalizeRoute(r.via_page), via_route: r.via_route || '', counterpart: r.counterpart || '',
    evidence: r.evidence || '', scope: r.scope || EXTERNAL_SCOPE, linked_flow: r.linked_flow || ''
  }));
  return { fm, nodes, edges, externals, shapeProblems: [nt.mismatch && `节点表：${nt.mismatch}`, et.mismatch && `边表：${et.mismatch}`].filter(Boolean) };
}

/** 列出代次目录（字典序 = 时间序，gen 名定长） */
export function listGens(contextRoot) {
  const dir = flowsDir(contextRoot);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^gen-\d{14}$/.test(e.name))
    .map((e) => e.name).sort();
}

/**
 * 丢弃半成品：带 `.open` 标记的 gen 目录 = 有波次追加过但没走完整理阶段。
 * 「半成品无法证明自己完整」→ 整代重做，绝不复用（§6 步骤 3）。
 */
export function discardOpenGens(contextRoot) {
  const removed = [];
  for (const g of listGens(contextRoot)) {
    const d = genDirOf(contextRoot, g);
    if (fs.existsSync(path.join(d, OPEN_SENTINEL))) {
      try { fs.rmSync(d, { recursive: true, force: true }); removed.push(g); } catch { /* 删不掉就留着，下面也不会切指针到它 */ }
    }
  }
  return removed;
}

/** 惰性 GC：保留最近 GEN_KEEP 代；更早且超期的才物理删除（sync 不做任何 GC） */
export function pruneGens(contextRoot, { now = Date.now(), keep = GEN_KEEP } = {}) {
  const gens = listGens(contextRoot).reverse();
  const doomed = [];
  gens.forEach((g, i) => {
    if (i < keep) return;
    const mtime = fs.statSync(genDirOf(contextRoot, g)).mtimeMs;
    if (now - mtime > GEN_GRACE_MS) doomed.push(g);
  });
  for (const g of doomed) {
    try { fs.rmSync(genDirOf(contextRoot, g), { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  }
  return { kept: gens.slice(0, keep), removed: doomed };
}

function newGenName(now = Date.now()) {
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `gen-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ───────────────────────────────────────────────────────────────────────────
// 整理阶段：折叠 → 生成 → 校验（五类自检 + EDGE_ENDPOINT_NOT_FOUND + 覆盖率）→ 切指针
// ───────────────────────────────────────────────────────────────────────────

/** 读入一个 gen 目录里所有 part（文件名字典序，与到达顺序无关） */
export function readParts(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^part-.+\.md$/.test(f)).sort()
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

/** 把 parts + 上一代 合并成"待校验的整代视图" */
export function assemble({ parts = [], prev = null, pageSet = null, targetKeys = null }) {
  const shapeProblems = [];
  const nodes = [], edges = [], externals = [];
  const routesByPart = new Map();
  for (const p of parts) {
    const parsed = parsePart(p.text, p.name);
    shapeProblems.push(...parsed.problems.map((x) => ({ ...x, part: x.part || p.name })));
    nodes.push(...parsed.nodes); edges.push(...parsed.edges); externals.push(...parsed.externals);
    // 存 Set：下方诊断分支用 `ks.has(...)` 反查该边/端点归属哪一片（Set API），
    // 若存成数组则在触发悬挂边/端点缺失/覆盖率任一分支时 TypeError 崩溃。
    routesByPart.set(p.name, new Set([...parsed.nodes.map((n) => n.page_key), ...parsed.edges.map((e) => e.page)]));
  }
  // §6 步骤3 / §8 用例16：PART_SHAPE 诊断必须携带 rerun_routes（= 该片所含 route 集合），
  // 否则"重跑单位"丢失，analyzer 无法只重试这一片（需求书：PART_SHAPE 只回带 rerun_routes
  // 让 analyzer 重试一次）。parsePart 产出的形状问题本身不带该字段，这里按 part 名回填。
  for (const sp of shapeProblems) {
    if (!Array.isArray(sp.rerun_routes) || sp.rerun_routes.length === 0) {
      const ks = routesByPart.get(sp.part);
      sp.rerun_routes = ks ? [...ks] : [];
    }
  }
  const incoming = { nodes, edges, externals };
  const merged = mergeGeneration(prev, incoming);
  const edgeRows = [...merged.edges];
  const analysis = analyzeGraph({ nodes: merged.nodes, edges: edgeRows }, pageSet);

  // EDGE_ENDPOINT_NOT_FOUND：端点必须在节点表里（外部接口不进边表，因此也不受此校验约束）
  const endpointProblems = [];
  for (const e of edgeRows) {
    for (const end of [e.page, e.prev_page]) {
      if (!merged.nodes.has(end)) {
        const src = [...routesByPart.entries()].find(([, ks]) => ks.has(e.page) || ks.has(e.prev_page));
        endpointProblems.push({
          part: src ? src[0] : '(merge)', line: e._line || 0, invariant: INVARIANT.DANGLING_EDGE,
          message: `EDGE_ENDPOINT_NOT_FOUND：边 \`${e.page}\` ← \`${e.prev_page}\` 的端点 \`${end}\` 不在节点表里`,
          rerun_routes: src ? [...src[1]] : [e.page]
        });
        break;
      }
    }
  }

  // 悬挂边（端点已不在页面档案里）→ 同级阻断
  const danglingProblems = analysis.dangling_edges.map((d) => {
    const src = [...routesByPart.entries()].find(([, ks]) => ks.has(d.page) || ks.has(d.prev_page));
    return {
      part: src ? src[0] : '(merge)', line: 0, invariant: INVARIANT.DANGLING_EDGE,
      message: `悬挂边：\`${d.page}\` ← \`${d.prev_page}\` 的端点 \`${d.missing}\` 已不在当前页面档案里（FLOW_STALE_PAGESET）`,
      rerun_routes: src ? [...src[1]] : [d.page]
    };
  });

  // 覆盖率：本轮目标页面集里有多少真的进了节点表
  let coverage = null;
  const coverageProblems = [];
  if (Array.isArray(targetKeys) && targetKeys.length) {
    const want = new Set(targetKeys.map(normalizeRoute));
    const got = [...want].filter((k) => merged.nodes.has(k));
    coverage = +(got.length / want.size).toFixed(4);
    if (coverage < COVERAGE_MIN) {
      const missing = [...want].filter((k) => !merged.nodes.has(k));
      const hitParts = [...routesByPart.entries()].filter(([, ks]) => missing.some((k) => ks.has(k)));
      coverageProblems.push({
        part: hitParts.length ? hitParts.map((x) => x[0]).join(',') : '(merge)',
        line: 0, invariant: INVARIANT.COVERAGE,
        message: `index 覆盖率 ${(coverage * 100).toFixed(1)}% < ${(COVERAGE_MIN * 100).toFixed(0)}%：缺 ${missing.join(', ')}`,
        rerun_routes: [...new Set(missing)]
      });
    }
  }
  analysis.coverage = coverage;
  analysis.shape_problems = shapeProblems;
  analysis.endpoint_problems = endpointProblems;
  analysis.dangling_problems = danglingProblems;
  analysis.coverage_problems = coverageProblems;
  analysis.part_routes = routesByPart;
  return { merged, analysis, diagnostics: [...shapeProblems, ...endpointProblems, ...danglingProblems, ...coverageProblems] };
}

/**
 * 整理阶段主流程。校验通过才原子切 `CURRENT`（**唯一一次**）。
 * 未通过 → 新代目录留着（带 `.open`）但不切指针，外部照常读上一代。
 */
export function finalize(o = {}) {
  const contextRoot = assertCrOrThrow(o.contextRoot);
  const dir = genDirOf(contextRoot, o.gen);
  const prevGen = readCurrentGen(contextRoot);
  const parts = readParts(path.join(dir, PARTS_DIR));
  const prev = o.mergePrev === false ? null : readPrevGeneration(contextRoot);
  const pageSet = asPageSet(o.pageSet);
  const { merged, analysis, diagnostics } = assemble({ parts, prev, pageSet, targetKeys: o.targetKeys });

  if (diagnostics.length) {
    return {
      ok: false, status: EXIT.INTEGRITY_FAIL, code: 'FLOW_INTEGRITY_FAIL',
      data: {
        gen_dir: dir, current_gen: prevGen, prev_gen: prevGen, switched: false,
        parts_read: parts.length, nodes: merged.nodes.size, edges: analysis.edge_count,
        check: summarizeAnalysis(withExternals(analysis, merged)),
        rerun_routes: [...new Set(diagnostics.flatMap((d) => d.rerun_routes || []))]
      },
      diagnostics: diagnostics.map((d) => ({
        part: d.part, line: d.line, invariant: d.invariant,
        message: d.message, rerun_routes: d.rerun_routes || []
      }))
    };
  }

  const indexText = renderIndex({
    nodes: merged.nodes, edges: merged.edges, externals: merged.externals,
    learnedAtCommit: o.commit ?? '', pageSet,
    generatedBy: o.generatedBy
  });
  const checkText = renderCheck(withExternals(analysis, merged), { now: o.nowStamp ?? '' });
  const notes = renderNotes(attachNextIndex(analysis, merged));
  if (prevGen && prevGen === o.gen) throw new BoundaryError(`拒绝向 CURRENT 已指向的代次整理切换（它是已启用代）：${o.gen}`);
  writeAtomic(dir, INDEX_FILE, indexText);
  writeAtomic(dir, CHECK_FILE, checkText);
  for (const n of notes) writeAtomic(dir, n.name, n.text);
  fs.rmSync(path.join(dir, OPEN_SENTINEL), { force: true });
  const switchedTo = switchCurrent(contextRoot, o.gen);
  const pruned = pruneGens(contextRoot);
  return {
    ok: true, status: EXIT.OK, code: 'WRITTEN',
    data: {
      gen_dir: dir, prev_gen: prevGen, current: switchedTo,
      parts_read: parts.length, notes_files: notes.map((n) => n.name),
      index_updated: true, check_updated: true, switched: true,
      nodes: merged.nodes.size, edges_added: analysis.edge_count,
      edges_superseded: merged.edges.filter((e) => e.status === 'superseded').length,
      externals: merged.externals.length,
      prev_status_counts: countPrevStatus(merged.nodes),
      rerun_routes: [],
      check: summarizeAnalysis(withExternals(analysis, merged)),
      gens_kept: pruned.kept, gens_removed: pruned.removed
    },
    diagnostics: []
  };
}

function readPrevGenName(prev) { return prev?.fm?.gen ?? null; }
function withExternals(a, merged) { return { ...a, external_count: (merged?.externals ?? []).length }; }
function attachNextIndex(a, merged) {
  const nextIndex = new Map();
  for (const e of merged.edges) {
    if (e.status === 'superseded') continue;
    if (!nextIndex.has(e.prev_page)) nextIndex.set(e.prev_page, []);
    nextIndex.get(e.prev_page).push(e.page);
  }
  for (const v of nextIndex.values()) v.sort();
  return { ...a, nextIndex };
}
function countPrevStatus(nodeMap) {
  const c = { root: 0, no_data: 0, unresolved_no_table_inventory: 0, unresolved_sources_incomplete: 0, other: 0 };
  for (const n of nodeMap.values()) {
    const code = unresolvedCode(n.prev_status);
    if (code && Object.prototype.hasOwnProperty.call(c, `unresolved_${code}`)) c[`unresolved_${code}`]++;
    else if (n.prev_status === PREV_ROOT) c.root++;
    else if (n.prev_status === PREV_NO_DATA) c.no_data++;
    else c.other++;
  }
  return c;
}
export function summarizeAnalysis(a) {
  return {
    entry_pages: a.entry_pages.length, leaf_pages: a.leaf_pages.length,
    orphan_pages: a.orphan_pages.length, dangling_edges: a.dangling_edges.length,
    cycles: a.cycles.length, external_registered: a.external_count ?? 0,
    coverage: a.coverage, blocking: a.dangling_edges.length > 0,
    orphan_list: a.orphan_pages, cycle_list: a.cycles,
    entry_unresolved: (a.entry_unresolved ?? []).length
  };
}

/** 把 analyzer 各片原样追加进**尚未启用**的新代 `flow-parts/`（不校验、不切 CURRENT） */
export function appendWave(o = {}) {
  const contextRoot = assertCrOrThrow(o.contextRoot);
  let gen = o.gen;
  let discarded = [];
  if (!gen) {
    discarded = discardOpenGens(contextRoot);
    gen = newGenName(o.now ?? Date.now());
    while (listGens(contextRoot).includes(gen)) gen = newGenName((o.now ?? Date.now()) + 1000);
  }
  if (!/^gen-\d{14}$/.test(gen)) throw new BoundaryError(`gen 目录名不合法：'${gen}'`);
  const cur = readCurrentGen(contextRoot);
  if (cur === gen) throw new BoundaryError(`拒绝向 CURRENT 指向的代次追加半成品：${gen}`);
  const dir = genDirOf(contextRoot, gen);
  const partsDir = path.join(dir, PARTS_DIR);
  fs.mkdirSync(partsDir, { recursive: true });
  fs.writeFileSync(path.join(dir, OPEN_SENTINEL), String(o.wave ?? '') + '\n', { flag: 'a' });
  const written = [];
  for (const item of o.items || []) {
    const payload = normalizePartPayload(item);
    const keys = [...new Set(payload.nodes.map((n) => n.page_key))];
    const owner = item.page_key || keys[0] || payload.edges[0]?.page;
    if (!owner) throw new BoundaryError('某片返回里既没有节点也没有边，无法确定 part 文件名的稳定键');
    const name = partFileName(owner);
    fs.writeFileSync(path.join(partsDir, name), renderPart(item), 'utf8');
    written.push({ part: name, page_keys: keys });
  }
  return {
    ok: true, status: EXIT.OK, code: 'PARTS_APPENDED',
    data: {
      gen, gen_dir: dir, wave: o.wave ?? null, parts_written: written.map((w) => w.part),
      detail: written, current_untouched: cur, discarded_incomplete_gens: discarded,
      switched: false
    }
  };
}

/**
 * 现查（回答期语义，§4-A5 三种情形）。
 * `pageSet` 给了就做范围判定：**范围外直接返回「不在回答范围之内」**，
 * 不提示学习、不猜最像的、不做模糊匹配。
 */
export function query(o = {}) {
  const contextRoot = assertCrOrThrow(o.contextRoot);
  const gen = readCurrentGen(contextRoot);
  const key = normalizeRoute(o.page ?? o.route ?? '');
  const OUT_OF_SCOPE = '不在回答范围之内';
  if (!key) return { ok: false, status: EXIT.BAD_ARGS, message: '缺 --page' };
  const pageSet = asPageSet(o.pageSet);
  if (pageSet && !pageSet.has(key)) {
    return { ok: true, in_scope: false, answer_zh: OUT_OF_SCOPE, page_key: key, direction: o.direction ?? 'both' };
  }
  if (!gen) return { ok: false, status: EXIT.NOT_READY, code: 'FLOWS_NOT_LEARNED', message: 'flows 分区尚无已启用的代次（CURRENT 不存在或不可读）' };
  const prev = readPrevGeneration(contextRoot);
  if (!prev) return { ok: false, status: EXIT.NOT_READY, code: 'FLOWS_NOT_LEARNED', message: `CURRENT 指向的 ${gen} 缺 ${INDEX_FILE}` };
  const live = prev.edges.filter((e) => e.status !== 'superseded');
  const node = prev.nodes.get(key) || null;
  const prevs = live.filter((e) => e.page === key).map((e) => e.prev_page).sort();
  const nexts = live.filter((e) => e.prev_page === key).map((e) => e.page).sort();
  const uncertain = [...prev.nodes.values()].some((n) => isUnresolved(n.prev_status)) || analyzeGraph({ nodes: prev.nodes, edges: live }, pageSet).dangling_edges.length > 0;
  return {
    ok: true, in_scope: true, page_key: key, gen, direction: o.direction ?? 'both',
    node, prev_pages: prevs,
    next_pages: nexts,
    next_annotation: `下一步（已学到 ${nexts.length} 条，是否还有未知的：${uncertain ? '不确定' : '无'}）`,
    prev_status_view: prevs.length ? 'has_prev' : (node ? node.prev_status : 'no_row'),
    external_count: (prev.externals ?? []).filter((x) => x.via_page === key).length
  };
}

/** 只重算体检报告（证明它是派生物：删掉能原样重生成） */
export function regenCheck(o = {}) {
  const contextRoot = assertCrOrThrow(o.contextRoot);
  const gen = o.gen || readCurrentGen(contextRoot);
  if (!gen) return { ok: false, status: EXIT.NOT_READY, message: 'CURRENT 不存在，无报告可重算' };
  const dir = genDirOf(contextRoot, gen);
  const idx = path.join(dir, INDEX_FILE);
  if (!fs.existsSync(idx)) return { ok: false, status: EXIT.NOT_READY, message: `缺 ${INDEX_FILE}` };
  const parsed = parseIndex(fs.readFileSync(idx, 'utf8'));
  const pageSet = asPageSet(o.pageSet);
  const a = analyzeGraph({ nodes: parsed.nodes, edges: parsed.edges }, pageSet);
  const text = renderCheck(withExternals(a, parsed), { now: o.nowStamp ?? '' });
  if (o.write) writeAtomic(dir, CHECK_FILE, text);
  return { ok: true, status: EXIT.OK, data: { gen, file: path.join(dir, CHECK_FILE), written: !!o.write, bytes: Buffer.byteLength(text, 'utf8'), check: summarizeAnalysis(a) } };
}

// ───────────────────────────────────────────────────────────────────────────
// 确定性分片计划（§6 步骤 2a）—— 归属不得由遍历顺序决定
// ───────────────────────────────────────────────────────────────────────────

/**
 * @param {Array<{route:string, controller:string, module?:string}>} rows 来自 code 分区 index.md
 * @param {Set|null} pageSet screens 页面清单（有则只保留在清单内的 route）
 */
export function buildPlan(rows, pageSet = null) {
  const byController = new Map();
  for (const r of rows) {
    const key = normalizeRoute(r.route);
    if (!key) continue;
    if (pageSet && !pageSet.has(key)) continue;
    const ctrl = String(r.controller ?? '').trim() || '(unknown)';
    if (!byController.has(ctrl)) byController.set(ctrl, new Set());
    byController.get(ctrl).add(key);
  }
  const parts = [];
  for (const ctrl of [...byController.keys()].sort()) {
    const keys = [...byController.get(ctrl)].sort();
    for (let i = 0; i < keys.length; i += ROUTES_PER_PART) {
      parts.push({ controller: ctrl, page_keys: keys.slice(i, i + ROUTES_PER_PART) });
    }
  }
  parts.sort((a, b) => (a.controller + a.page_keys.join(',')) < (b.controller + b.page_keys.join(',')) ? -1 : 1);
  const waves = [];
  for (let i = 0; i < parts.length; i += PARTS_PER_WAVE) {
    waves.push({ wave: waves.length + 1, parts: parts.slice(i, i + PARTS_PER_WAVE) });
  }
  return {
    algorithm: 'controller-group;route-sort;chunk',
    routes_per_part: ROUTES_PER_PART, parts_per_wave: PARTS_PER_WAVE, max_depth: MAX_DEPTH,
    total_routes: parts.reduce((n, p) => n + p.page_keys.length, 0),
    total_parts: parts.length, total_waves: waves.length,
    waves
  };
}

/** 把一个 Set 变成可 JSON 序列化的排序数组（输出确定性的一部分） */
export function sortedArray(set) { return [...(set ?? [])].sort(); }

/** 读页面档案清单（screens 代次 index.md 的 route 列 → 页面键集合）。取不到返回 null */
export function readPageInventory(contextRoot, parseIndexRows) {
  try {
    const rows = parseIndexRows();
    if (!Array.isArray(rows) || !rows.length) return null;
    return new Set(rows.map((r) => normalizeRoute(r.route)).filter(Boolean));
  } catch { return null; }
}

// ───────────────────────────────────────────────────────────────────────────
// CLI（writer 经 bash 调用；测试也走这一层做端到端断言）
// ───────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const cmd = argv[0];
  const o = { command: cmd, flags: {}, positional: argv.slice(1) };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!String(a).startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || String(next).startsWith('--')) { o.flags[key] = true; }
    else { o.flags[key] = next; i++; }
  }
  return o;
}

function readJsonFile(p) {
  const raw = fs.readFileSync(path.resolve(String(p)), 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function out(obj, code) {
  console.log(JSON.stringify(obj, null, 2));
  process.exit(code ?? (obj.ok ? 0 : (obj.status ?? 1)));
}

export function main(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgs(argv);
  const cr = flags['context-root'];
  const pagesFile = flags['pages-file'];
  const pageSet = pagesFile && pagesFile !== true ? new Set((() => {
    const v = readJsonFile(pagesFile);
    const arr = Array.isArray(v) ? v : (v.page_keys || v.pages || []);
    return arr.map(normalizeRoute).filter(Boolean);
  })()) : null;
  try {
    if (command === 'append') {
      const items = flags['wave-file'] ? (readJsonFile(flags['wave-file']).items ?? []) : [];
      if (!items.length) return out({ ok: false, status: EXIT.BAD_ARGS, message: 'append 需要 --wave-file <path>（{items:[<analyzer data>...]}）' });
      return out(appendWave({ contextRoot: cr, gen: flags.gen === true ? undefined : flags.gen, wave: flags.wave, items, now: flags.now ? Number(flags.now) : undefined }));
    }
    if (command === 'finalize') {
      if (flags.gen === true || !flags.gen) return out({ ok: false, status: EXIT.BAD_ARGS, message: 'finalize 需要 --gen <gen-…>（整理阶段的目标代次）' });
      const targetKeys = flags['target-keys'] ? (readJsonFile(flags['target-keys']) || []) : null;
      const r = finalize({
        contextRoot: cr, gen: flags.gen, pageSet, targetKeys,
        mergePrev: flags['no-merge-prev'] !== true,
        commit: flags.commit === true ? '' : flags.commit,
        nowStamp: flags.now === true ? '' : String(flags.now ?? '')
      });
      return out(r, r.status);
    }
    if (command === 'check') {
      const r = regenCheck({ contextRoot: cr, gen: flags.gen === true ? undefined : flags.gen, pageSet, write: flags.write === true, nowStamp: flags.now === true ? '' : String(flags.now ?? '') });
      return out(r, r.status);
    }
    if (command === 'query') {
      const r = query({ contextRoot: cr, page: flags.page === true ? '' : flags.page, direction: flags.direction, pageSet });
      return out(r, r.status ?? EXIT.OK);
    }
    if (command === 'plan') {
      const rowsFile = flags['rows-file'];
      if (!rowsFile || rowsFile === true) return out({ ok: false, status: EXIT.BAD_ARGS, message: 'plan 需要 --rows-file <path>（[{route,controller,module}]）' });
      return out({ ok: true, status: EXIT.OK, data: buildPlan(readJsonFile(rowsFile), pageSet) });
    }
    return out({ ok: false, status: EXIT.BAD_ARGS, message: `未知命令 '${command ?? ''}'（可用：append | finalize | check | query | plan）` });
  } catch (e) {
    if (e instanceof BoundaryError) {
      return out({ ok: false, status: EXIT.BOUNDARY, code: 'WRITE_BOUNDARY_VIOLATION', message: e.message, diagnostics: [{ part: '(engine)', line: 0, invariant: INVARIANT.BOUNDARY, message: e.message, rerun_routes: [] }] }, EXIT.BOUNDARY);
    }
    return out({ ok: false, status: EXIT.BAD_ARGS, message: `flow-engine 内部错误：${e && e.message ? e.message : String(e)}` });
  }
}

// 只有作为脚本直接执行时才跑 CLI（被 import 时不得劫持进程）——沿用 resolve-project.mjs 的同一段惯用法
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (IS_MAIN) main();

/** 把 contextRoot 的形态校验包成"抛 BoundaryError"，让 CLI 统一落到 43 */
function assertCrOrThrow(p) {
  try { return assertContextRoot(p); }
  catch (e) { throw new BoundaryError(e && e.message ? e.message : String(e)); }
}

/** pageSet 可以是 Set / 数组 / null（三态：给了就判，没给就判不了） */
function asPageSet(v) {
  if (v instanceof Set) return v.size ? v : null;
  if (Array.isArray(v)) { const s = new Set(v.map(normalizeRoute).filter(Boolean)); return s.size ? s : null; }
  return null;
}
