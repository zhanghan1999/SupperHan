// scripts/fastpath-gate.mjs
// /supperH-bug 快路径（fast path）准入门禁 —— 确定性求值，不含任何 LLM 判断。
//
// 设计立场（见 commands/supperH-bug.md「快路径」节）：
//   抽取归 LLM（从自然语言认出锚点字面量），判定归脚本（本文件）。
//   误判成本不对称：漏杀（该慢走快）= 线上回归且当场不可见；
//                    误杀（该快走慢）= 多花几十秒。故所有不确定路径一律保守出局。
//
// 本文件被 resolve-project.mjs 在进程内调用，因此它可以读取 CONTEXT_ROOT
// （位于 workspace 之外的私有根）而不需要给任何 agent 放开 external_directory。
import fs   from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';

/** index.md 格式代际；与 skills/supperH-prelearn/SKILL.md「index.md 规范格式」节一致 */
// /1 → /2：反查表新增 `sources` 列（batch → 可达源文件全集），G4b 靠它把
// 仓库粒度判据收窄到 batch 粒度。旧代际的表没有这一列 → 无法安全做交集 →
// 必须整表 32 出局重学，而不是"缺列就当它没依赖"。
export const INDEX_SCHEMA = 'supperh-index/2';

/**
 * 快路径退出码。30–37 属"正常分流"而非错误：非 0 时调用方落慢路径即可，
 * 不打回语、不阻断（与 10/11/12 的硬停语义区分开）。
 *
 * 40 被**故意排除在 30–37 连续段之外**：那一段的语义是「落完整路径」，而 40 的
 * 语义是「先问用户一次，问完再决定走哪条」——它不是分流结论。混进连续段会让
 * 「30–37 一律落完整路径」这条不变式裂开，而调用方敢拿退出码当分流依据，
 * 前提就是那段码的语义是同一种。
 */
export const EXIT = Object.freeze({
  PASS:        0,  // 全部门禁通过 → 允许快路径（--impact-* 模式下含义见 verifyImpactReport）
  NO_ROUTE:   30, // 锚点不可定位：类型不支持（G0）或在反查表零命中（G1）；也用于项目主动关闭快路径
  AMBIGUOUS:  31, // G1 锚点多命中歧义
  NO_INDEX:   32, // G2 CURRENT/index.md 缺失、不可读、不可解析、代际或列格式漂移
  VETO:       33, // 否决词表命中
  SHALLOW:    34, // G3 目标方法完整度 < L3
  STALE:      35, // G4 learnedAtCommit != HEAD **且** 本 batch 的 sources 与 diff 相交（或无从判定）；含 HEAD/diff 取不到、sources 不完整
  INCOMPLETE: 36, // 门禁未能完整求值：入参不成对（有 --anchor 无 --text）或脚本内部异常；
                  // 也用于「impact 回报结构不可用」——没东西可判时绝不假装判过
  IMPACT_WIDE: 37, // G5：supperH-bug-analyzer(lite) 回报影响半径 > 1 层，或 lite 契约被破（读了源码）

  /**
   * I0 意图欠定义：三槽位有空 / 原文引用验假 / 锚点在原话里找不到出处。
   * 只在「其余门禁全过、只差这一步」时成为最终码；否则更可行动的 30–37 先出局。
   * 但**判定结果永远随 JSON 一起回传**（`intent.ok` / `gates.I0_intent`），因为
   * 意图复述是两条路径共同的前置义务——落不落快路径都得问，那一问由命令执行。
   */
  INTENT_AMBIGUOUS: 40
});

/**
 * 不变式：**门禁未真正求值过就绝不返回 0**。返回 0 意味着 eligible=true 且
 * anchorResolved 一定有值——调用方（commands/supperH-bug.md 步骤 1.5）拿退出码
 * 当分流依据，任何「0 但字段缺失」的组合都等于把「判定归脚本」这条红线绕过。
 */

/** L1 内置默认阈值；L2 的 fastPath 段可收紧 */
export const DEFAULTS = Object.freeze({ maxDiffLines: 40, maxFiles: 2 });

/**
 * L2 收紧的硬上限：`fastPath` 覆盖段只允许把预算调小，不允许调大超过此值。
 * 缺这道夹取的话，L2 一个笔误（maxDiffLines: 4000）就能让规模门禁形同虚设。
 */
export const HARD_CAPS = Object.freeze({ maxDiffLines: 80, maxFiles: 4 });

/** 一期允许直接参与快路径的锚点类型 */
// codeFile：给一个源码文件路径（Controller/Service/DAO/Mapper 皆可乐），经 index.md 的
// `sources` 列（每行 = 该 route 调用链可达文件全集）**倒排**反查它落在哪些 route 的可达集里。
// 这是「反向 anchor」：正向是 route→文件，反向是文件→route，靠现成的 sources 列做确定性匹配，
// 不需 AST（AST 级精确反查归 F-15c）。
const SUPPORTED_KINDS = Object.freeze(['route', 'fqn', 'fileLine', 'codeFile']);

/**
 * A1 类锚点（traceId / ticketNo）：字面量本身不含代码位置，必须先经 driver（内网驱动
 * 脚本）反查出接口路由才能进门禁。**识别但拒绝直用**（supported=false）——这样即使
 * 调用方忘了跑 F1.4 反查，G0 也会保守出局（30），不可能“顺眼就当 route 用了”。
 * 识别本身仍有两个作用：给 command 递出 needsLookup 信号，以及让 jsonl 能统计到
 * “本项目有多少输入其实是 A1 类”——那是 P1-① 接 driver 后的真实收益预估。
 *
 * 递出的字段刻意叫 `lookupNeed`（要成什么关系）而不是 `lookupVia`（走哪个槽位）：
 * F-11 之后槽位名归用户，脚本一旦输出 `drivers.logs` 就等于替全天下规定“日志源
 * 得叫 logs”。反查用哪个槽位由调用方按各槽位的 `desc` 选，选不出唯一一个即出局 ——
 * 详见 skills/supperH-data-fetch/SKILL.md §anchor-lookup。
 */
const LOOKUP_KINDS = Object.freeze(['traceId', 'ticketNo']);

/**
 * 否决词表：命中任一即出局。词表只允许项目无关的通用 Java/Spring/SQL 词汇，
 * 不得出现具体包名、表名、接口路径。
 */
export const VETO = Object.freeze([
  // —— 变更面扩大 ——
  { id: 'methodSignature', re: /方法签名|函数签名|参数列表|入参增删|出参增删|改返回值|return\s*type|method\s+signature/i },
  { id: 'buildFile',       re: /pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle|依赖升级|新增依赖|版本升级/i },
  { id: 'configFile',      re: /application[-.\w]*\.(?:ya?ml|properties)|bootstrap\.(?:ya?ml|properties)|\.env|配置中心|nacos|apollo/i },
  { id: 'mapperXml',       re: /mapper\.xml|mybatis|ibatis|<select|<update|<insert|<delete|\bresultMap\b|\bSQL\s*语句/i },
  { id: 'publicApi',       re: /对外接口|公开方法|public\s+(?:类|接口|abstract)|\binterface\b|新增字段|删除字段|重命名|rename|契约变更|序列化兼容|反序列化/i },
  { id: 'migration',       re: /建表|删表|改表|字段类型变更|数据迁移|\bddl\b|(?:加|新建|重建|创建|删除|去掉)\s*索引|索引\s*(?:重建|新增)|create\s+index|alter\s+index|drop\s+index/i },
  // —— 风险语义 ——
  { id: 'txConcurrency',   re: /事务|@Transactional|\btransaction\b|回滚|原子性|锁|synchronized|并发|线程|线程池|\bexecutor\b|异步|\b@Async\b|幂等/i },
  { id: 'perf',            re: /超时|慢查询|慢\s*sql|\bslow\s+sql\b|很慢|偏慢|太慢|耗时|性能|吞吐|\bQPS\b|\bTPS\b|卡死|死锁|批量处理|大数据量|数据量大|内存溢出|OOM|内存泄漏|连接池/i },
  { id: 'nondeterministic',re: /偶发|偶發|间歇|間歇|时好时坏|有时|概率|随机|不稳定|不穩定|压测|並发|并发下|高并发/i },
  { id: 'security',        re: /鉴权|授权|越权|认证|登录态|\btoken\b|\bjwt\b|密钥|加密|解密|签名校验|脱敏|权限|\bacl\b|\bshiro\b|spring[\s-]*security/i },
  { id: 'cacheQueue',      re: /缓存|緩存|快取|redis|\bmq\b|消息队列|kafka|rocketmq|rabbitmq|\bmqtt\b/i },
  // —— 数据面 ——
  { id: 'dataFix',         re: /数据修复|刷数据|补数|订正|回刷|修数|存量数据|历史数据|刷數|補數/i },
  // 写库词故意用**子串匹配**而非 `\bdelete\b`：驼峰标识符里 `delete` 前后同为 `\w`，边界不成立，
  // 而 `deleteById` / `insertSelective` / `batchInsert` 恰恰是 Java 工单里最高频的写库说法。
  // 宁可因此多误杀（`updateFlag` 字段不对也会走完整路径），不可漏杀。
  { id: 'dbWrite',         re: /insert|update|delete|truncate|saveOrUpdate|\bsave\b|写库|入库|落库|批量写入|保存失败|保存不上|落表|持久化|\bduplicate\s+entry\b|主键冲突/i }
]);

/** 归一化 path 比较键：折叠空白、method 大写、去尾斜杠 */
function normRoute(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim().replace(/\/+$/, '');
  const m = t.match(/^([a-zA-Z]+)\s+(\/.*)$/);
  if (!m) return t;
  return m[1].toUpperCase() + ' ' + m[2];
}

/** 判定字符串是否像一条 HTTP route（含 method 前缀或以 / 开头的 path） */
function looksLikeRoute(s) {
  return /^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)\s+\S/i.test(s) || /^\//.test(s);
}

/**
 * 源码文件锚点判据：单个无空格 token、以已知源码扩展名结尾。
 * 必须**先于 route 判**：绝对路径 `/x/y/Foo.java` 会被 looksLikeRoute 的 `/^\//` 抢走。
 * 没有 HTTP route 会以 `.java/.kt/.xml/.sql` 等结尾（`.do/.action` 不在集内），无冲突；
 * `Foo.java:42`（fileLine）以行号收尾、不匹配本正则，也不冲突。
 */
const CODE_FILE_RE = /^[^\s]+\.(?:java|kt|kts|scala|groovy|xml|sql)$/i;

/** 归一化源码文件路径为匹配键：反斜杠→斜杠、剥前导 `./`、小写（Windows 路径大小写不敏感） */
function normCodeFile(s) {
  return String(s).replace(/\\/g, '/').replace(/^\.\/+/, '').toLowerCase();
}

/**
 * A1 锚点的形态判据。**宁可少识别也不得多识别**：两个正则都要求带上稳定的
 * 英文/中文标签（trace_id / 工单号 / #12345 等），因为把一串无标签的随机字符
 * 认成 traceId 只会污染 anchorKind 统计（它无论如何都是 30 出局，不会漏杀）。
 * 放在 route / fileLine / fqn 之后判，不抢它们的形式。
 */
const TRACE_RE  = /^(?:trace[\s_-]?id|traceid|链路\s*id|追踪\s*id)\s*[:=#]\s*([0-9a-f]{8,32}|[A-Za-z0-9][A-Za-z0-9-]{7,63})$/i;
const TICKET_RE = /^(?:#|\b(?:ticket|issue|bug|jira)\b|工单|缺陷|需求)(?:\s*(?:号|id|no\.?))?\s*[:#=-]?\s*([A-Za-z][A-Za-z0-9]*-\d{1,10}|\d{2,10})$/i;

/** 识别锚点类型并归一化成匹配器 */
export function classifyAnchor(raw) {
  const s = String(raw ?? '').replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!s) return { kind: 'none', value: '', supported: false, reason: 'empty anchor' };

  // codeFile 先于 route：绝对路径 `/...` 会被 looksLikeRoute 误抓（见 CODE_FILE_RE 注释）。
  if (CODE_FILE_RE.test(s)) return { kind: 'codeFile', value: s, file: normCodeFile(s), supported: true };

  if (looksLikeRoute(s)) return { kind: 'route', value: normRoute(s), supported: true, route: normRoute(s) };

  const fl = s.match(/([A-Za-z0-9_.$-]+)\.java:(\d+)$/);
  if (fl) return { kind: 'fileLine', value: s, supported: true, className: fl[1].split(/[.$/]/).pop(), line: Number(fl[2]) };

  const fq = s.match(/^(.{1,}?[#.])?([A-Z][A-Za-z0-9_$]*)#([A-Za-z_$][A-Za-z0-9_$]*)$/);
  if (fq) return { kind: 'fqn', value: s, supported: true, className: fq[2], method: fq[3] };

  const cn = s.match(/^([A-Z][A-Za-z0-9_$]*)#([A-Za-z_$][A-Za-z0-9_$]*)$/);
  if (cn) return { kind: 'fqn', value: s, supported: true, className: cn[1], method: cn[2] };

  const tr = s.match(TRACE_RE);
  if (tr) return {
    kind: 'traceId', value: s, id: tr[1], supported: false, needsLookup: true,
    lookupNeed: 'trace_id -> route',
    reason: 'traceId 不含代码位置：需先经一个能按 trace_id 换回接口路由的只读槽位反查（F1.4）再进门禁'
  };
  const tk = s.match(TICKET_RE);
  if (tk) return {
    kind: 'ticketNo', value: s, id: tk[1], supported: false, needsLookup: true,
    lookupNeed: 'ticket_no -> route',
    reason: '工单号不含代码位置：需先经一个能按工单号换回接口路由的只读槽位反查（F1.4）再进门禁'
  };

  return {
    kind: 'unknown', value: s, supported: false,
    reason: `无法识别锚点类型（直用支持 ${SUPPORTED_KINDS.join(' / ')}；需反查支持 ${LOOKUP_KINDS.join(' / ')}）`
  };
}

/**
 * YAML 行内标量的字面值归一：先剥 ` # 注释`（`#` 前必须有空白才算注释），
 * 再剥**成对**引号，最后把 YAML 的 null 形态折成空串。
 *
 * 两处曾经的坑：
 * - 不剥注释：`learnedAtCommit: abc # 说明` → 值带尾巴，与 HEAD 永不相等 →
 *   该模块所有 bug 永久判 35，而提示语会说「学习数据过期」，把人引向重学而非改格式。
 *   而 skills/supperH-prelearn/SKILL.md 的示例本身就带行内注释，writer 照抄即中招。
 * - 用 /^"'|"'$/g 各剥一边：`"abc" # x` → `abc" # x`，比不剥更糟。
 */
function normalizeScalar(v) {
  let s = String(v).replace(/\s+#.*$/, '').trim();
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) s = s.slice(1, -1).trim();
  if (s === 'null' || s === 'Null' || s === 'NULL' || s === '~') return '';
  return s;
}

/** 从 frontmatter 原文里拿一个标量的字面值（不走 YAML 类型推定） */
function rawFrontmatterScalar(text, key) {
  const src = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return null;
  const end = src.indexOf('\n---', 4);
  if (end < 0) return null;
  const m = new RegExp('^[ \\t]*' + key + '[ \\t]*:[ \\t]*(.*?)[ \\t]*$', 'm').exec(src.slice(4, end + 1));
  if (!m) return null;
  return normalizeScalar(m[1]) || null;
}

/**
 * 拆 markdown 表格行。**行尾 `|` 是可选的**（markdown 合法写法），所以只能
 * "真的以 `|` 收尾才削一边"，不能无条件 `split('|').slice(1, -1)`：
 * 那会恒丢最后一格 —— 数据行少一列会让 level 取到 undefined 直接抛，
 * 表头少一根竖线则 level 列整体丢失、全表静默降 L1（永久 34 且被归因成"学习深度不足"）。
 */
function splitCells(line) {
  let s = String(line).trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim().replace(/^\*{2}(.*)\*{2}$/, '$1').trim());
}

/** 反查表必需列。缺任一列 = 格式漂移（32 出局），不做"尽力解析" */
const REQUIRED_COLS = Object.freeze(['route', 'controller', 'method', 'batch', 'lines', 'level', 'sources']);

/**
 * 解析 `sources` 单元格 → { files: string[], usable: boolean }。
 *
 * `usable: false` 是 fail-closed 的入口：空值、`-` 占位、以及**形态不对**的路径
 * （绝对路径 / 反斜杠 / `./` 前缀 / 盘符）都归此类。形态不对绝不能当成"无依赖"——
 * 那会让 `diff ∩ sources` 恒为空集，把整套修复从"少误杀"翻转成"总放行"，
 * 比改造前更危险（漏杀且当场不可见）。宁可判 35。
 */
export function parseSourcesCell(cell) {
  const s = String(cell ?? '').trim();
  if (!s || s === '-' || s === '—') return { files: [], usable: false };
  const files = s.split(';').map((p) => p.trim()).filter(Boolean);
  if (!files.length) return { files: [], usable: false };
  const wellFormed = files.every((p) =>
    !p.includes('\\') && !p.startsWith('/') && !p.startsWith('./') && !p.includes('://') && !/^[A-Za-z]:/.test(p)
  );
  return wellFormed ? { files, usable: true } : { files: [], usable: false };
}

/**
 * 解析 index.md → { frontmatter, learnedAtCommit, rows, cols, missingCols, drift, headerIdx }。
 * 格式问题一律以 `rows: []` + `drift` 说明原因（调用方转 EXIT.NO_INDEX）；
 * 只有在 YAML 本身语法错 / frontmatter 未闭合时才抛出异常。
 */
export function parseIndexMarkdown(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  let frontmatter = {};
  if (src.startsWith('---\n')) {
    const end = src.indexOf('\n---', 4);
    if (end < 0) throw new Error('index.md frontmatter 未闭合');
    frontmatter = YAML.parse(src.slice(4, end + 1)) || {};
  }

  const lines = src.split('\n');
  // commit 必须取字面文本：YAML 会把 `0000000` / 纯数字 SHA 推定为 number，
  // 前导零丢失后与 HEAD 永远不相等 → 静默判过期 → 快路径默默死掉。
  const learnedAtCommit = rawFrontmatterScalar(src, 'learnedAtCommit')
    ?? (frontmatter.learnedAtCommit === undefined || frontmatter.learnedAtCommit === null
      ? null : normalizeScalar(frontmatter.learnedAtCommit) || null);
  const noTable = {
    frontmatter, rows: [], headerIdx: -1, cols: [], missingCols: [], learnedAtCommit,
    drift: '未找到以 `| route |` 开头的反查表'
  };
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    // 容忍：表头大小写、加粗 `| **route** |`、行首 ≤ 3 空格缩进
    if (/^\s{0,3}\|\s*\*{0,2}\s*route\s*\*{0,2}\s*\|/i.test(lines[i])) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return noTable;

  const cols = splitCells(lines[headerIdx]).map((c) => c.toLowerCase());
  const missingCols = REQUIRED_COLS.filter((c) => !cols.includes(c));
  if (missingCols.length) {
    // 必需列缺失即格式漂移。**绝不"尽力解析"**：表头少一根竖线会让 level 列整体丢失，
    // 一个已学到 L3 的模块会被静默当成 L1 → 永远判 34，而提示语把它归因成"学习深度不足"。
    return { ...noTable, headerIdx, cols, missingCols, drift: `反查表缺列：${missingCols.join(', ')}` };
  }

  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.trim().startsWith('|')) break;                    // 表格到此结束
    if (/^\|[\s|:-]+\|?$/.test(ln.trim())) continue;          // |---|---| 分隔行
    const cells = splitCells(ln);
    if (cells.length < 2) continue;
    const get = (name) => String(cells[cols.indexOf(name)] ?? '');
    const route = get('route');
    if (!route) continue;                                     // 空 route 不进表
    const lv = get('level').toUpperCase();
    rows.push({
      route,
      controller: get('controller'),
      method:     get('method'),
      batch:      get('batch'),
      lines:      get('lines'),
      level:      /^L[123]$/.test(lv) ? lv : 'L1',             // 留空或写了别的值一律按 L1（宁可判浅）
      sources:    parseSourcesCell(get('sources')),             // G4b 用；usable=false 即 fail-closed
      _rowNo: i + 1
    });
  }
  return {
    frontmatter, rows, headerIdx, cols, missingCols: [], learnedAtCommit,
    drift: rows.length ? null : '反查表零行'
  };
}

/** 反查表内按锚点匹配，返回命中行数组 */
export function matchRows(rows, anchor) {
  if (!anchor?.supported) return [];
  if (anchor.kind === 'route') {
    const want = normRoute(anchor.route);
    // 只带 path 不带 method 时，按 path 匹配所有 method 变体
    const pathOnly = /^\/.*$/.test(want) ? want.replace(/\/+$/, '') : null;
    return rows.filter((r) => {
      const nr = normRoute(r.route);
      if (nr === want) return true;
      if (pathOnly) {
        const m = nr.match(/^(?:[A-Z]+ )?(\/.*)$/);
        if (m && m[1].replace(/\/+$/, '') === pathOnly) return true;
      }
      return false;
    });
  }
  if (anchor.kind === 'fqn') {
    const cls = String(anchor.className).toLowerCase();
    const mtd = String(anchor.method).toLowerCase();
    return rows.filter((r) => {
      const rc = String(r.controller).split(/[.$]/).pop().toLowerCase();
      return rc === cls && String(r.method).toLowerCase() === mtd;
    });
  }
  // codeFile（反向 anchor）：把用户给的源码文件经 sources 列倒排——命中任一行的可达文件集。
  // 双向后缀匹配：用户可给仓内相对路径（stored.endsWith(want)）或绝对/长路径（want.endsWith(stored)），
  // 也可只给文件名。sources 用 `/` 边界比对，避免 FooOrderMapper.xml 误配 OrderMapper.xml。
  // usable=false（空/`-`/形态不对）的行 files 为空 → 天然不参与反查（与 G4b fail-closed 一致）。
  if (anchor.kind === 'codeFile') {
    const want = anchor.file;
    return rows.filter((r) => (r.sources?.files || []).some((p) => {
      const q = normCodeFile(p);
      return q === want || q.endsWith('/' + want) || want.endsWith('/' + q);
    }));
  }
  // fileLine：类名匹配 + 行号落在 lines 区间内（区间为 `-` 时视为可用但记低置信）
  const cls = String(anchor.className).toLowerCase();
  return rows.filter((r) => {
    const rc = String(r.controller).split(/[.$]/).pop().toLowerCase();
    if (rc !== cls) return false;
    const rg = /^(\d+)\s*-\s*(\d+)$/.exec(r.lines);
    if (!rg) return true;
    return anchor.line >= Number(rg[1]) && anchor.line <= Number(rg[2]);
  });
}

/** 扫描否决词，返回命中项 [{id}]。NFKC 归一化盖住全角字母/数字/标点（ＴＲＡＮＳＡＣＴＩＯＮ） */
export function scanVeto(text) {
  const s = String(text ?? '').normalize('NFKC');
  if (!s.trim()) return [];
  return VETO.filter((v) => v.re.test(s)).map((v) => ({ id: v.id }));
}

/** 在 effectiveRoot 里取 HEAD；非 git 仓库 / 无 git 时返回 null（保守判失败） */
export function readHeadCommit(effectiveRoot) {
  if (!effectiveRoot) return null;
  try {
    const out = execFileSync('git', ['-C', effectiveRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000
    });
    return out.trim().slice(0, 40) || null;
  } catch {
    return null;
  }
}

/**
 * commit 串比对。全等以外的前缀匹配只接受**两边都 ≥ 7 位**的情况
 * （git 短哈希惯例）：不设长度下限的话，一个畸形的 `0` / `a` 开头的串就能骗过新鲜度门禁。
 */
export function commitMatches(a, b) {
  const x = String(a ?? ''); const y = String(b ?? '');
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/**
 * 取 `<from>..<to>` 之间变更的文件名清单（G4b 的左操作数）。
 *
 * 这几个参数不是可选的装饰，每一个都对应一种会把"误杀"翻转成"漏杀"的失效形态：
 * - `-c core.quotePath=false`：git 默认把非 ASCII 路径转义成 `"\346\226\207..."`，
 *   转义后的串与 `sources` 里的原文永不相等 → 交集恒空 → 总放行。
 * - `--no-renames`：开了重名检测时 rename 只报目标路径，旧路径（即 `sources` 里
 *   登记的那条）消失 → 漏杀。不折叠则新旧都在，只会更保守。
 * - 两个 rev 分开传并以后置 `--` 收尾：`git diff A,B` 这种逗号形式对 commit **不成立**
 *   （git 会报 ambiguous argument 退出 128），写了它整个 G4b 会因永远取不到 diff
 *   而永远判 35 —— 不报错、不改变行为，只在账本里静默空转，是最难发现的一类写法错误。
 *   末尾的 `--` 则把两侧彻底固定成 revision，杜绝与同名路径的歧义。
 * - 失败一律 `null` 而非 `[]`：浅克隆 / commit 不在当前历史 / 非 git 仓 / 超时，
 *   与"确实零变更"必须分得开 —— 前者要判 35，后者才可放行。
 *
 * 取数形状与 {@link readHeadCommit} 保持一致（同 timeout、同屏蔽 stderr、同 catch）。
 * @returns {string[]|null} 变更文件（repo-relative POSIX）；取不到返回 null
 */
export function diffNameOnly(effectiveRoot, from, to) {
  if (!effectiveRoot || !from || !to) return null;
  try {
    const out = execFileSync(
      'git',
      ['-C', effectiveRoot, '-c', 'core.quotePath=false',
        'diff', '--name-only', '--no-renames', String(from), String(to), '--'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
    );
    return String(out).split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * 路径比较键。Windows 文件系统大小写不敏感，而 `sources` 由 LLM 驱动的 analyzer 写入、
 * git 输出取自索引，两者大小写可能对不上。只折叠大小写（不做其它归一），且只在
 * win32 上折叠：方向上多匹配 = 多判 35 = 保守，不会引入漏杀。
 */
function pathKey(p) {
  return process.platform === 'win32' ? String(p).toLowerCase() : String(p);
}

function readCurrentIndexDir(contextRoot, moduleName) {
  const modDir = path.join(contextRoot, moduleName);
  const curFile = path.join(modDir, 'CURRENT');
  if (!fs.existsSync(curFile)) return { code: 'NO_CURRENT' };
  let genName = '';
  try { genName = fs.readFileSync(curFile, 'utf8').trim(); } catch { return { code: 'UNREADABLE_CURRENT' }; }
  if (!genName) return { code: 'EMPTY_CURRENT' };
  const genDir = path.join(modDir, genName);
  const idxFile = path.join(genDir, 'index.md');
  if (!fs.existsSync(idxFile)) return { code: 'NO_INDEX_FILE' };   // 不返回 genDir，让调用方走缺数据分支
  // 全文件唯一的"读不包 try"角落就是它：Windows 上"文件存在但读不了"很常见
  // （杀软/编辑器独占 EBUSY、私有根在 OneDrive 占位文件、gen 目录半拷贝）。
  // 不包住的话异常会冒到 CLI，变成 exit 1 + stdout 零字节——而 1 不在任何退出码表里。
  try {
    return { genDir, genName, idxFile, text: fs.readFileSync(idxFile, 'utf8') };
  } catch (e) {
    return { code: 'UNREADABLE_INDEX_' + (e && e.code ? e.code : 'ERR') };
  }
}

/**
 * 只读新鲜度（供 /supperH-bug 步骤 3 与 /supperH-learn 使用）。
 * 主 agent 本身 `external_directory: deny` 且 bash 窄白名单，读不到也取不了 HEAD，
 * 故这一取数动作下沉到本脚本进程内完成。
 *
 * **与门禁 G4 的关系（故意不一致，不要"顺手对齐"）**：本函数没有锚点，拿不到
 * batch，因此 `stale` 只能是**仓库级**全等判据；而门禁在 G4a 不等后还会走 G4b
 * 按 batch 复核。所以完全可能出现「门禁 eligible=true 而这里 stale=true」——
 * 两者粒度不同，不是矛盾。若有人把这里改成与门禁同判据，等于把 G4b 的收窄作废。
 * @returns {{available:boolean, headCommit?:string|null, learnedAtCommit?:string|null,
 *            stale?:boolean, gen?:string, indexFile?:string, reason?:string}}
 */
export function readFreshness(o = {}) {
  const { contextRoot, module: moduleName, effectiveRoot, headCommit } = o;
  if (!contextRoot || !moduleName) return { available: false, reason: 'missing contextRoot/module' };
  const idx = readCurrentIndexDir(contextRoot, moduleName);
  if (!idx.genDir) return { available: false, reason: `no usable CURRENT under ${contextRoot}/${moduleName}` };
  let learned = null;
  try {
    learned = parseIndexMarkdown(idx.text).learnedAtCommit ?? null;
  } catch (e) {
    return { available: false, reason: `index.md unparsable: ${e.message}`, gen: idx.genName, indexFile: idx.idxFile };
  }
  const head = headCommit !== undefined ? headCommit : readHeadCommit(effectiveRoot);
  const stale = !learned || !head || !commitMatches(learned, head);
  return { available: true, headCommit: head, learnedAtCommit: learned, stale, gen: idx.genName, indexFile: idx.idxFile };
}

// ───────────────────────────────────────────────────────────────────────────
// I0 意图复述（intent echo）—— 与 G0–G5 正交的一道前置检查
//
// 为什么要有：G0–G5 六项全在回答“代码在哪、能不能定位、改了波及多大”，
// 没有一项回答“我对需求的理解是不是你的意思”。一条被误读的描述可以六项全绿
// 通过，然后拿着错误的解读去精确执行正确的动作——定位越准、编译越干净、
// diff 越小，错误越难被发现。
//
// 为什么判据是“引用原文”而不是“你自己复述一遍”：复述可以是意译，意译会静默
// 丢掉用户给出的约束条件（“其实 price 就是要保留 6 位小数”这类话最容易被吞）。
// 要求每个槽位附带**用户原话里的连续片段**，脚本才能用 includes 机械验真。
//
// 能力边界必须写清（否则会被后人误当成安全保证）：
//   ✅ 拦得住：没读原文就填、意译、跨句拼装、整段抄一遍蒙混、锚点凭印象补
//   ❌ 拦不住：引用了真句子但归属错（把“实际行为”的句子填进“期望行为”槽位）——
//              那仍归用户人判。I0 的产出是“把理解以可核对的形式打印出来”，
//              不是“保证理解对”。问模型“你确定吗”也不是替代方案：自报置信度
//              与实际正确性无稳定因果，那个行为本身只是一次文本生成。
// ───────────────────────────────────────────────────────────────────────────

/** 意图三槽位。expected/actual 强制非空；repro 允许显式 absent */
const INTENT_SLOTS = Object.freeze(['expected', 'actual', 'repro']);

/**
 * repro 唯一合法的“确实没有”标记。
 * 空串/空白**不是**这个意思——那是“我没处理这一项”，必须出局。
 * 把“不知道”做成合法输出，是为了让它被显式登记，而不是被编造填满：
 * 强制非空的直接效果是奖励填空，而填出来的那句会被当成“用户确认过的前提”往下传。
 */
export const INTENT_ABSENT = 'absent';

/** 原文引用片段的字符下限：低于此的碎片（“报错”、“1.11”）证明不了读过原话 */
const MIN_QUOTE_CHARS = 8;

/**
 * 症状形态：actual 的引用里至少一条要落在“出问题的那句话”上。
 * 与 VETO 同纪律：只允许项目无关的通用词汇，不得出现具体接口/类名/表名。
 *
 * 末项 `(?:没|未|无|缺|少)[汉字]` 是有意的宽匹配：中文症状说法是**开放集**
 * （未做非空校验 / 没返回 / 未生效 / 少了字段 / 无响应…），逐条枚举必然漏，
 * 而漏一条的代价是把真症状判成“没引用症状句”→ 40 → 白问用户一次。
 * 这一项只要求“至少一条命中”，放宽只会少拦，不会放进错的东西——
 * 引用验真（includes 原话）与跨字段不重叠才是主力判据。
 */
const SYMPTOM_RE = /报错|错误|异常|失败|不相等|不等|不一致|不对|不能|为空|超时|空白|500|[45]\d\d|exception|error|fail|not\s|cannot|unable|(?:没|未|无|缺|少)[\u4e00-\u9fa5]/i;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 校验意图复述的内容。
 *
 * 调用方保证：`intent` 已过结构检查（本函数只看内容），`text` 已给定。
 *
 * @param {{expected?:string,actual?:string,repro?:string,quotes?:object}} intent
 * @param {string} text  用户原始描述（与门禁已收的那个同一个，零新增采集通道）
 * @param {{anchorValue?:string|null,anchorKind?:string|null,anchorSource?:'direct'|'lookup'}} [o]
 * @returns {{ok:boolean,slots_missing:string[],quotes_total:number,quotes_verified:number,problems:string[]}}
 */
export function verifyIntent(intent, text, o = {}) {
  const { anchorValue = null, anchorKind = null, anchorSource = 'direct' } = o;
  const body = String(text ?? '');
  const clean = (v) => String(v ?? '').trim();
  const problems = [];
  const slots_missing = [];

  // ---- 1. 三槽位：期望/实际必须说清；复现条件必须“有内容”或“显式 absent” ----
  for (const slot of INTENT_SLOTS) {
    const v = clean(intent[slot]);
    if (!v) { slots_missing.push(slot); continue; }
    // repro 不要求引用原文：它经常被用户省略，强制引用只会逼出编造。
    // 但它要么是一句真话（≥下限长度），要么是字面 absent；不接受任何自造说法（同义词会漂）。
    if (slot === 'repro' && v !== INTENT_ABSENT && v.length < MIN_QUOTE_CHARS) slots_missing.push(slot);
  }
  if (slots_missing.length) problems.push(`槽位缺失或过短：${slots_missing.join(', ')}`);

  // ---- 2. 引用验真：expected / actual 各至少一条用户原话连续片段 ----
  const q = isPlainObject(intent.quotes) ? intent.quotes : {};
  const norm = (list) => (Array.isArray(list) ? list.map(clean).filter(Boolean) : []);
  const quoteSets = { expected: norm(q.expected), actual: norm(q.actual) };
  let quotes_total = 0, quotes_verified = 0;
  for (const slot of ['expected', 'actual']) {
    const list = quoteSets[slot];
    if (!list.length) { problems.push(`${slot} 未附用户原话引用（只有我自己的话，无法核对是否丢了他给的约束条件）`); continue; }
    for (const frag of list) {
      quotes_total++;
      if (frag.length < MIN_QUOTE_CHARS) { problems.push(`${slot} 引用片段仅 ${frag.length} 字符，低于下限 ${MIN_QUOTE_CHARS}：碎片证明不了读过原话`); continue; }
      if (!body.includes(frag)) { problems.push(`${slot} 引用片段在用户原话中找不到出处（属编造/意译）：'${frag.slice(0, 40)}'`); continue; }
      quotes_verified++;
    }
  }

  // ---- 3. 跨字段不得重叠：堵“整段抄一遍、两个槽位共用”这种蒙混 ----
  // 只给症状、没给期望的句子 → 这里会出局 → 去问“你期望的正确行为是什么”。
  // 这不是误拦：期望行为未说清时，我必然在猜。
  for (const a of quoteSets.expected) for (const b of quoteSets.actual) {
    if (a === b || a.includes(b) || b.includes(a)) {
      problems.push(`expected 与 actual 引用了同一句话（'${a.slice(0, 30)}'）——同一片段填两格等于没做区分，多半是整段抄的`);
    }
  }

  // ---- 4. actual 至少一条落在症状句上 ----
  if (quoteSets.actual.length && !quoteSets.actual.some((f) => SYMPTOM_RE.test(f))) {
    problems.push('actual 的引用里没有一条含症状/报错形态——说明我引用的不是“出问题的那句话”');
  }

  // ---- 5. 锚点必须真出自原话 ----
  // commands/supperH-bug.md 步骤 1 早就写了“从描述里**原字面取出**”，但从未被机械校验：
  // 我可以“意译”出一个原文里根本不存在的 route，而后面的 G0/G1 只会夸它合法且唯一。
  // 拦不住“原文里确实有这句、但说的不是这件事”，那一半归用户人判。
  if (anchorValue) {
    if (anchorSource === 'lookup') {
      // F1.4 反查得到的锚点：原话里本来就没有这条 route，设计如此不是漂移。
      // 它自有一道护栏（恰好一条，多条不许任选），不在此重复判。
    } else {
      // fileLine 的锚点是“文件:行号”拼出来的，行号常来自推断 → 只验文件名部分
      const probe = anchorKind === 'fileLine' ? String(anchorValue).split(':')[0] : String(anchorValue);
      if (probe && !body.includes(probe)) {
        problems.push(`锚点 '${anchorValue}' 在用户原话中找不到出处（要求原字面取出）。若它来自 traceId/ticketNo 反查，请带 --anchor-source lookup`);
      }
    }
  }

  return { ok: problems.length === 0, slots_missing, quotes_total, quotes_verified, problems };
}

/**
 * 求值快路径准入。
 * @param {object} o
 * @param {string} o.contextRoot      解析器已算出的学习数据根（含 project code 分区）
 * @param {string} o.module           业务模块名
 * @param {string} [o.anchor]         LLM 抽取的锚点字面量
 * @param {string} [o.text]           用户原始描述（否决词扫描与 I0 引用验真的**必需**输入）；
 *                                    缺省或空白时门禁返回 36，绝不返回 0
 * @param {object}  [o.intent]         步骤 1.6 的意图复述：{expected, actual, repro, quotes:{expected[], actual[]}}。
 *                                    非对象或缺 quotes = **结构不可用** → 36（该修的是编排者，问用户没用）；
 *                                    结构对但内容欠定义 → 40（该问用户）。两种情形绝不合并成一个码。
 * @param {'direct'|'lookup'} [o.anchorSource='direct'] 锚点出处：direct=从用户原话抽取（I0 验真）；
 *                                    lookup=经 F1.4 反查得到（豁免验真，它自有一道“恰好一条”护栏）
 * @param {string} [o.effectiveRoot]  取 HEAD 用
 * @param {string|null} [o.headCommit] 外部已取好的 HEAD（缺省时内部自取）
 * @param {object}  [o.limits]        L2 覆盖：{ maxDiffLines, maxFiles }，只允许收紧，硬夹到 HARD_CAPS
 * @param {boolean} [o.enabled=true]  L2 总开关：false = 本项目整体不走快路径（在任何解析之前短路）
 * @param {string[]|null} [o.allowAnchorKinds] L2 锚点白名单；缺省/null = 不限制（取并集于 SUPPORTED_KINDS）
 * @returns {{status:number, eligible:boolean, message:string,
 *            gates:object, anchorKind:string, anchorResolved:object|null, veto:object[],
 *            intent:object|null}}
 */
export function evaluateFastPath(o = {}) {
  const { contextRoot, module: moduleName, anchor: rawAnchor, limits = {}, enabled = true, allowAnchorKinds = null,
          intent: rawIntent, anchorSource = 'direct' } = o;
  // 三态：undefined / 空白串 = "没给描述"，与"给了描述但无否决词"必须区分开。
  // 压成同一个值的话，PowerShell 引号/换行/`$` 吃掉 --text 时否决表会**静默跳过**，
  // 还能返回 status 0 + gates.veto='pass'——那是漏杀，且当场没有任何信号。
  const textGiven = typeof o.text === 'string' && o.text.trim() !== '';
  const cap = (name) => {
    const want = Number(limits[name] ?? DEFAULTS[name]);
    const hard = HARD_CAPS[name];
    const v = Number.isFinite(want) && want > 0 ? Math.min(want, hard) : DEFAULTS[name];
    return v > hard ? hard : v;
  };
  const maxDiffLines = cap('maxDiffLines');
  const maxFiles = cap('maxFiles');
  const gates = {};

  const anchor = classifyAnchor(rawAnchor);
  // 否决词**前置求值但不决定短路顺序**：短路时也要把真实命中面交给 jsonl，
  // 否则「描述里有否决词、但因数据过期先出局」的样本一律记成 veto 未命中，
  // 词表命中率被系统性低估，以后据此调参会往松的方向调偏。
  const vetoHits = textGiven ? scanVeto(o.text) : [];
  // I0 与 veto 同纪律：**前置求值，但不决定短路顺序**。短路时也要把真实判定面
  // 交给 jsonl，否则「意图欠定义但因数据过期先出局」的样本一律记成 I0 通过，
  // 以后据此调参会偏。
  // 三态：null = 没求值（缺 text / 结构不可用），与「求值了但不合格」严格分开——
  // 这是 --text 那条三态教训的复用，不再让参数问题冒充内容问题。
  const intentVerdict = (textGiven && isPlainObject(rawIntent) && isPlainObject(rawIntent.quotes))
    ? verifyIntent(rawIntent, o.text, { anchorValue: anchor.value, anchorKind: anchor.kind, anchorSource })
    : null;
  const res = (status, eligible, message, extra = {}) => ({
    status, eligible, message, gates,
    anchorKind: anchor.kind, anchorResolved: null, veto: vetoHits, intent: intentVerdict, ...extra
  });
  const fail = (code, gate, msg) => { gates[gate] = 'fail'; return res(code, false, msg); };

  // ---- 输入合法性：缺 anchor 属"未申请快路径"，不是失败 ----
  if (!contextRoot || !moduleName) {
    return res(EXIT.INCOMPLETE, false, '缺少 contextRoot/module，门禁无法求值（调用方入参不成对）');
  }
  // L2 总开关排在所有 I/O 之前：项目主动关闭时连 index.md 都不应该去读。
  if (enabled === false) {
    gates.G0_anchorKind = 'skipped';
    return res(EXIT.NO_ROUTE, false, '本项目 fastPath.enabled=false：快路径已按 L2 配置整体关闭（按完整路径处理）', { disabled: true });
  }
  if (!anchor.supported) {
    gates.G0_anchorKind = 'fail';
    // needsLookup=true 是给调用方的行动指令（去跑 F1.4 反查），不是放行信号：
    // 本轮仍是 30，只有拿反查出的 route 重新调用才可能得到 0。
    return res(EXIT.NO_ROUTE, false, `锚点不可用：${anchor.reason || anchor.kind || 'none'}`,
      { needsLookup: anchor.needsLookup === true, lookupNeed: anchor.lookupNeed ?? null });
  }
  if (Array.isArray(allowAnchorKinds)) {
    if (!allowAnchorKinds.includes(anchor.kind)) {
      gates.G0_anchorKind = 'fail';
      return res(EXIT.NO_ROUTE, false, `锚点类型 ${anchor.kind} 不在本项目 fastPath.allowAnchorKinds 白名单（${allowAnchorKinds.join(', ') || '空集'}）内`);
    }
  }
  gates.G0_anchorKind = 'pass';

  // ---- G2 数据就绪：分区 / CURRENT / index.md 必须存在、可读、格式代际相符 ----
  const idx = readCurrentIndexDir(contextRoot, moduleName);
  if (!idx.genDir) return fail(EXIT.NO_INDEX, 'G2_dataReady', `模块 '${moduleName}' 在 ${contextRoot} 下无可用 CURRENT 或 index.md 不可读（${idx.code}）`);
  let parsed;
  try {
    parsed = parseIndexMarkdown(idx.text);
  } catch (e) {
    return fail(EXIT.NO_INDEX, 'G2_dataReady', `index.md 解析失败：${e.message}`);
  }
  const fm = parsed.frontmatter || {};
  if (fm.schema !== INDEX_SCHEMA) {
    return fail(EXIT.NO_INDEX, 'G2_dataReady', `index.md 格式代际不符：schema='${fm.schema ?? '缺失'}' ≠ '${INDEX_SCHEMA}'`);
  }
  if (!parsed.rows.length) {
    return fail(EXIT.NO_INDEX, 'G2_dataReady', `index.md 格式漂移：${parsed.drift || '反查表不可用'}`);
  }
  if (fm.kind === 'screens') return fail(EXIT.NO_INDEX, 'G2_dataReady', 'screens 保留分区不参与 bug 快路径');
  gates.G2_dataReady = 'pass';

  // ---- G4a 新鲜度·仓库级（先于 G1：全等就无需碰反查表，最快也最省）----
  // 不等时**不再直接判 35**：交给 G4b 按 batch 粒度复核。这不是放宽——G4b 只在
  // "本 batch 一个源文件都没变"时放行；拿不到 diff 、sources 不全一律 35。
  const head = o.headCommit !== undefined ? o.headCommit : readHeadCommit(o.effectiveRoot);
  const learned = parsed.learnedAtCommit || null;
  const short = (s) => String(s).slice(0, 7);
  if (!learned) { gates.G4_fresh = 'fail'; return res(EXIT.STALE, false, 'index.md frontmatter 缺 learnedAtCommit，无法判新鲜度', { gen: idx.genName }); }
  if (!head)    { gates.G4_fresh = 'fail'; return res(EXIT.STALE, false, `无法取得 ${o.effectiveRoot || 'effectiveRoot'} 的 git HEAD，保守落慢路径`, { gen: idx.genName }); }
  const g4aPass = commitMatches(learned, head);
  gates.G4_fresh = g4aPass ? 'pass' : 'pending_batch';

  // ---- G1 锚点唯一命中 ----
  const hits = matchRows(parsed.rows, anchor);
  if (hits.length === 0) { gates.G1_unique = 'fail'; return res(EXIT.NO_ROUTE, false, `锚点 '${anchor.value}' 在 ${idx.genName}/index.md 反查表零命中（G4a ${g4aPass ? 'pass' : 'pending_batch'}）`, { rowsScanned: parsed.rows.length }); }
  if (hits.length > 1) {
    gates.G1_unique = 'fail';
    return res(EXIT.AMBIGUOUS, false, `锚点 '${anchor.value}' 命中 ${hits.length} 条 route，歧义`, { candidates: hits.map((h) => h.route) });
  }
  gates.G1_unique = 'pass';

  const hit = hits[0];
  const resolved = {
    route: hit.route, controller: hit.controller, method: hit.method,
    batch: hit.batch, lineRange: hit.lines, level: hit.level,
    gen: idx.genName, indexFile: idx.idxFile
  };

  // ---- G4b 新鲜度·batch 级（仅 G4a 不等时进入）----
  // 「G4 先于 G1：过期表的命中结果不可信」这条不变式仍成立，前提在契约里：
  // `sources` 必含 Controller 自身文件，所以 route→batch 映射本身变了（方法迁走/
  // 改名/删除）也一定落进 diff 交集 → 照样 35。拿一张过期表去解锚点是安全的，
  // 因为"表过期"这件事就是 sources 的一部分。
  let staleButDisjoint = false;
  let g4b = null;   // 结构化记账：让 jsonl 能统计 G4b 的真实收益，不必从 message 里回推
  if (!g4aPass) {
    const src = hit.sources || { files: [], usable: false };
    g4b = { ran: true, outcome: null, sources_count: src.files.length };
    const stale = (why) => {
      gates.G4_fresh = 'fail';
      return { ...res(EXIT.STALE, false, why, { gen: idx.genName, g4b }), anchorResolved: resolved };
    };
    if (!src.usable) {
      g4b.outcome = 'sources_unusable';
      return stale(`学习数据过期（${short(learned)} != ${short(head)}）且无法按 batch 复核：` +
        `${hit.batch} 的 sources 列为空/'-' 或路径形态不合法（绝对路径、反斜杠、带 ./ 前缀），保守落慢路径`);
    }
    const changed = diffNameOnly(o.effectiveRoot, learned, head);
    if (changed === null) {
      g4b.outcome = 'diff_unavailable';
      return stale(`学习数据过期（${short(learned)} != ${short(head)}）且 diff 不可得（浅克隆 / commit 不在当前历史 / 非 git 仓 / 超时），保守落慢路径`);
    }
    const changedSet = new Set(changed.map(pathKey));
    const intersect = src.files.filter((p) => changedSet.has(pathKey(p)));
    g4b.changed_count = changed.length;
    g4b.intersect_count = intersect.length;
    if (intersect.length) {
      g4b.outcome = 'intersect';
      const shown = intersect.slice(0, 3).join(', ') + (intersect.length > 3 ? ' …' : '');
      return stale(`学习数据过期：${hit.batch} 的 ${intersect.length} 个源文件在 ${short(learned)}..${short(head)} 之间变了（${shown}）`);
    }
    // 无关变更：本 batch 的可达文件一个都没动 → 结论仍可信，但要把这件事记进账本。
    g4b.outcome = 'disjoint';
    gates.G4_fresh = 'pass_disjoint';
    staleButDisjoint = true;
  }

  // ---- G3 完整度充分：仅 L3 放行 ----
  if (hit.level !== 'L3') {
    gates.G3_depth = 'fail';
    return { ...res(EXIT.SHALLOW, false, `目标方法完整度 ${hit.level} < L3，影响半径无法静态判定；建议 /supperH-learn --mode update 补深`, { gen: idx.genName }), anchorResolved: resolved };
  }
  gates.G3_depth = 'pass';

  // ---- 否决词表（命中面已在顶部算好，这里只决定归因）----
  // 放在最后一道：G2/G4/G1/G3 的失败原因比"你没传 --text"更可行动，先短路能让
  // jsonl 与用户看到真实阻塞点。但走到这一步还缺 text 时，**绝不返回 0**。
  if (!textGiven) {
    gates.veto = 'skipped';
    return { ...res(EXIT.INCOMPLETE, false, '缺少 --text（用户原始描述），否决词表无法求值；按完整路径处理', { gen: idx.genName, vetoSkipped: true }), anchorResolved: resolved };
  }
  const vetoIds = vetoHits.map((v) => v.id);
  if (vetoHits.length) {
    gates.veto = 'fail';
    return { ...res(EXIT.VETO, false, `命中否决词 ${vetoIds.join(', ')}，强制走完整流程`, { gen: idx.genName }), anchorResolved: resolved };
  }
  gates.veto = 'pass';

  // ---- I0 意图复述（判定面已在顶部算好，这里只决定归因）----
  // 排在否决词之后：命中否决词必然升格完整路径，而完整路径**同样**要跑步骤 1.6 的
  // 复述，所以报“33”比报“40”更可行动。无论谁先出局，I0 判定都已随 JSON 回传，
  // 命令那一层总是看得见——因为意图复述是两条路径共同的前置义务，与分流结论无关。
  if (!intentVerdict) {
    gates.I0_intent = 'skipped';
    return { ...res(EXIT.INCOMPLETE, false,
      '未提供 --intent-json/--intent-report 或结构不可用（应为 {expected, actual, repro, quotes:{expected[], actual[]}}），I0 无法求值；按完整路径处理',
      { gen: idx.genName, intentSkipped: true }), anchorResolved: resolved };
  }
  if (!intentVerdict.ok) {
    gates.I0_intent = 'fail';
    return { ...res(EXIT.INTENT_AMBIGUOUS, false,
      `意图欠定义（${intentVerdict.problems.length} 项）：${intentVerdict.problems.join('；')}。` +
      `请向用户**一次性**复述并补齐三项（期望行为 / 实际行为 / 复现条件，没有就答 absent），拿到答复后重跑本门禁`,
      { gen: idx.genName }), anchorResolved: resolved };
  }
  gates.I0_intent = 'pass';

  // ---- G5 影响半径：本脚本不算（它没读源码），由调用方将 analyzer-lite 回报回灌 verifyImpactReport ----
  gates.G5_impact = 'pending_agent';

  return {
    status: EXIT.PASS, eligible: true, gates,
    message: '快路径准入通过（G1–G4 + 否决表无命中 + I0 意图复述已补齐）；下一步必须派 supperH-bug-analyzer(lite) 并把回报回灌 --impact-json 验 G5，不得自行判定',
    anchorKind: anchor.kind, anchorResolved: resolved, veto: [], intent: intentVerdict,
    budget: { maxDiffLines, maxFiles, hardCaps: HARD_CAPS },
    g4b,
    commit: { head: short(head), learned: short(learned), stale_but_disjoint: staleButDisjoint }
  };
}

/** supperH-bug-analyzer(lite) 回报里被允许出现的 code 值（与 agents/supperH-bug-analyzer.md 输出契约逐字一致） */
export const IMPACT_CODES = Object.freeze(['ANALYZED', 'INSUFFICIENT_LEARNING', 'TARGET_NOT_FOUND', 'IMPACT_WIDE']);

/** 证据出处类型：read=读过源码行 / batch=学习记录条目 / data=一次取数信封 */
export const EVIDENCE_KINDS = Object.freeze(['read', 'batch', 'data']);

/**
 * 结论与出处必须成对出现（P2-b2）。
 *
 * 为什么把这件事搬进脚本：回报一旦允许“只有结论没有出处”，下游就分不清
 * “真读过那段代码”与“把类名拼得像读过”——而后者才是模型高频出现的失误，因为它
 * 语言上更流利。下面这些判据全部只看形状、不读源码：它们拦不住“引用了真句子但
 * 归属错”（同 I0 的能力边界），能保证的是“没出处 / 出处指不到 / 自己跟自己对矛盾”
 * 这三类一定会出局。把能机械验的那部分验掉，剩下的才是真正需要人看的。
 *
 * 一律“给了才验形状”，但 ANALYZED 必须至少一条证据：零证据的影响结论没有可核对的
 * 落点，与“没看过”无法区分。向后兼容只用在**新增可选字段**上（见 schema 那条铁律），
 * 不适用于“声称已完成分析”这种结论位。
 */
function collectEvidenceRefs(report) {
  const refs = [];
  const flow = report?.data?.flow;
  if (Array.isArray(flow)) {
    flow.forEach((s, i) => refs.push([`data.flow[${i}]`, Array.isArray(s?.evidence) ? s.evidence : null]));
  }
  const ex = report?.exception;
  if (ex && typeof ex === 'object' && !Array.isArray(ex)) {
    for (const key of ['assumptions', 'comparisons']) {
      const arr = ex[key];
      if (Array.isArray(arr)) {
        arr.forEach((s, i) => refs.push([`exception.${key}[${i}]`, Array.isArray(s?.evidence) ? s.evidence : null]));
      }
    }
  }
  return refs;
}

/** 空值判据：空串/空白/空数组/空对象都算没给；0 与 false 算给了 */
function blankValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/** 回报里出现过的一切文件路径（scope 越界判据的取材面） */
function collectReportFiles(report) {
  const out = [];
  for (const r of Array.isArray(report.reads) ? report.reads : []) {
    if (!blankValue(r?.file)) out.push(['reads.file', String(r.file)]);
  }
  for (const s of Array.isArray(report?.data?.flow) ? report.data.flow : []) {
    if (!blankValue(s?.file)) out.push(['data.flow.file', String(s.file)]);
  }
  for (const e of Array.isArray(report.evidence) ? report.evidence : []) {
    if (e?.kind === 'read' && !blankValue(e?.ref)) out.push(['evidence.ref', String(e.ref)]);
  }
  for (const f of Array.isArray(report?.scope?.touched) ? report.scope.touched : []) {
    if (!blankValue(f)) out.push(['scope.touched', String(f)]);
  }
  return out;
}

/** 路径归一（仅供“在某个根下”比较）：正反斜杠互认、折叠重复分隔符、Windows 不看大小写 */
function pathKeyForScope(p) {
  let s = String(p).replace(/\\/g, '/');
  s = s.replace(/\/+/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/**
 * G5 影响半径的**脚本化验收**（P1-②）。
 *
 * 为什么要有这个函数：P0 时代 G5 只活在 commands/supperH-bug.md 的一句文字约定里
 * （“回报 IMPACT_WIDE → 升级完整路径”），等于整套门禁里唯一一处由 LLM 自行判定，
 * 直接违反“判定归脚本”的立场。本函数把那个判断搬进代码。
 *
 * 局限必须写清楚：脚本**只能验回报的形状（shape）**，它没读源码，无从判断 analyzer
 * 是否漏报了真实引用。所以 G5 永久弱于 G1–G4——信它的结论，但验它的格式。
 *
 * 归因分两条（结果都是落完整路径，但账本必须能分开）：
 *   37 = 回报明确说“影响不窄”（IMPACT_WIDE / external_refs 非空 / 违反 reads:[] 护栏），
 *        以及它自报或被判定的 **越界**（scope 外的文件、evidence 与 reads 互斥）——
 *        那同样是“事实层面的面比允许的大”，不是格式问题
 *   36 = 回报结构不可用（缺字段、类型错、未知 code、深度越界、目标与锚点不一致、
 *        证据引用指不到东西、流程未落到 class#method、例外声明缺项）
 *
 * @param {any} report 已解析的 supperH-bug-analyzer(lite) 回报对象
 * @param {{expectedRoute?:string|null, scopeRoots?:string[]}} [o]
 *        expectedRoute：门禁解出的 anchorResolved.route，校“它分析的是不是同一个目标”；
 *        scopeRoots：主 agent 派单时圈定的允许范围（绝对路径），回报里任何一个文件路径
 *        落在它们之外即算越界。不给 = 不校这一项（同 expectedRoute 的选配纪律）。
 * @returns {{status:number, narrow:boolean, code:string|null, problems:string[], checks:object}}
 */
export function verifyImpactReport(report, o = {}) {
  const checks = {};
  const problems = [];
  const codeOf = () => (report && typeof report === 'object' && typeof report.code === 'string' ? report.code : null);
  const out = (status, narrow) => ({ status, narrow, code: codeOf(), problems, checks });
  const fail = (status, key, why) => { checks[key] = 'fail'; problems.push(why); return out(status, false); };

  // 结构层：拿不到可判的东西一律 36——“看不清”绝不是“通过”。
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return fail(EXIT.INCOMPLETE, 'shape', 'impact 回报不是 JSON 对象（内联 JSON 被 shell 引号吃掉时就是这个形态）');
  }
  checks.shape = 'pass';

  const code = codeOf();
  if (!code) return fail(EXIT.INCOMPLETE, 'code', 'impact 回报缺 code 字段（字符串）：无法判定 G5');
  if (!IMPACT_CODES.includes(code)) {
    return fail(EXIT.INCOMPLETE, 'code', `impact 回报 code='${code}' 不在契约枚举（${IMPACT_CODES.join(' | ')}）内`);
  }

  const refs = report?.data?.impact?.external_refs;
  if (Array.isArray(refs) && refs.length) {
    return fail(EXIT.IMPACT_WIDE, 'externalRefs', `owning class 被其它 batch/module 引用 ${refs.length} 处，影响半径 > 1 层`);
  }
  checks.externalRefs = Array.isArray(refs) ? 'pass' : 'absent';

  if (code === 'IMPACT_WIDE') return fail(EXIT.IMPACT_WIDE, 'code', 'analyzer 回报 IMPACT_WIDE：影响半径超出 1 层');

  // lite 护栏：它必须**显式**回报 reads: []。缺这个字段等于无法证明它没读源码。
  if (!Array.isArray(report.reads)) {
    return fail(EXIT.INCOMPLETE, 'reads', 'impact 回报缺 reads 数组：lite 契约要求显式给出 reads: []，缺列即无法证明未读源码');
  }
  if (report.reads.length) {
    return fail(EXIT.IMPACT_WIDE, 'reads', `lite 护栏被破：reads 非空（${report.reads.length} 项），本次结论不再只依赖学习记录`);
  }
  checks.reads = 'pass';

  if (code !== 'ANALYZED') {
    return fail(EXIT.INCOMPLETE, 'code', `analyzer 未给出影响结论（code='${code}'）：没有“影响窄”的证据，不得进快路径`);
  }

  const depth = report.depth ?? report?.data?.impact?.depth;
  if (depth !== undefined && Number.isFinite(Number(depth)) && Number(depth) > 1) {
    return fail(EXIT.INCOMPLETE, 'depth', `lite 契约违约：depth=${depth} > 1`);
  }
  checks.depth = 'pass';

  // 可选的一致性校验：它报的目标必须就是门禁解出来的那条 route。
  if (o.expectedRoute) {
    const got = report?.target?.route ?? report?.data?.impact?.route ?? null;
    if (got && normRoute(got) !== normRoute(o.expectedRoute)) {
      return fail(EXIT.INCOMPLETE, 'target', `analyzer 分析的目标（${got}）与门禁锚点（${o.expectedRoute}）不一致`);
    }
    checks.target = got ? 'pass' : 'absent';
  }

  // ---- b2 证据绑定：声称“分析完了”就必须挂得住出处 ----
  const ev = report.evidence;
  if (ev !== undefined && !Array.isArray(ev)) {
    return fail(EXIT.INCOMPLETE, 'evidence', 'evidence 不是数组：给了就要能被引用，写成对象/字符串都指不到东西');
  }
  const declared = new Set();
  for (const [i, item] of (Array.isArray(ev) ? ev : []).entries()) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id) return fail(EXIT.INCOMPLETE, 'evidence', `evidence[${i}] 缺 id：结论里的 evidence:["..."] 无法指向它`);
    if (declared.has(id)) {
      return fail(EXIT.INCOMPLETE, 'evidence', `evidence id '${id}' 重复：同名两条时“引用它”没有确定含义`);
    }
    if (!EVIDENCE_KINDS.includes(item?.kind)) {
      return fail(EXIT.INCOMPLETE, 'evidence',
        `evidence[${i}].kind='${String(item?.kind)}' 不在 ${EVIDENCE_KINDS.join('|')} 内：判不了它是否违反 lite 的未读源码护栏`);
    }
    if (blankValue(item?.ref)) {
      return fail(EXIT.INCOMPLETE, 'evidence', `evidence[${i}]（${id}）缺 ref：有 id 没出处，等于给一句话起了个名字`);
    }
    declared.add(id);
  }
  if (!declared.size) {
    return fail(EXIT.INCOMPLETE, 'evidence',
      'code=ANALYZED 却零证据：影响结论没有任何可核对的落点，与“没看过”不可区分');
  }
  // reads 是 lite 硬护栏（必须为 []）。evidence 里出现 read 类出处而 reads 为空
  // = 两份申报互相矛盾，此时哪一份都不能信：归 37，与“reads 非空”记同一笔账。
  if (report.reads.length === 0 && ev.some((e) => e.kind === 'read')) {
    return fail(EXIT.IMPACT_WIDE, 'evidence',
      'lite 护栏被破：evidence 含 kind=read，reads 却是 []（两者必有一个在说谎）');
  }
  const orphan = [];
  for (const [at, ids] of collectEvidenceRefs(report)) {
    if (ids === null) continue;                       // 未给 evidence 字段，由下面的 flow 规则单独管
    for (const id of ids) if (!declared.has(String(id).trim())) orphan.push(`${at}→${String(id)}`);
  }
  if (orphan.length) {
    return fail(EXIT.INCOMPLETE, 'evidenceRefs',
      `证据引用指向不存在的 id：${orphan.slice(0, 5).join('、')}`
      + `${orphan.length > 5 ? ` 等 ${orphan.length} 处` : ''}（引用一个不存在的出处，比不引用更容易混过人眼）`);
  }
  checks.evidence = 'pass';

  // ---- b2 流程必须落到 class#method：停在“某层处理了一下”的既有核对不了也改不动 ----
  const flow = report.data?.flow;
  if (flow !== undefined) {
    if (!Array.isArray(flow)) return fail(EXIT.INCOMPLETE, 'flow', 'data.flow 不是数组');
    for (const [i, s] of flow.entries()) {
      if (blankValue(s?.class) || blankValue(s?.method)) {
        return fail(EXIT.INCOMPLETE, 'flow',
          `data.flow[${i}] 未同时给出 class 与 method：这一跳没落到可打开的位置`);
      }
      if (!Array.isArray(s.evidence) || !s.evidence.length) {
        return fail(EXIT.INCOMPLETE, 'flow',
          `data.flow[${i}]（${s.class}#${s.method}）没绑证据：这一跳是读来的还是想出来的，从回报上分不出来`);
      }
    }
    checks.flow = flow.length ? 'pass' : 'absent';
  } else {
    checks.flow = 'absent';
  }

  // ---- b2 例外声明：推断环节与精度/类型比较必须可定位 ----
  // “1.11 与 1.11 不相等”这类误判的共同点：比较发生在哪一层、两边各是什么类型，
  // 回报里看不见。看不见就没法判断它是真不等还是被转成了不等。
  const ex = report.exception;
  if (ex !== undefined) {
    if (!ex || typeof ex !== 'object' || Array.isArray(ex)) {
      return fail(EXIT.INCOMPLETE, 'exception', 'exception 不是对象');
    }
    for (const key of ['assumptions', 'comparisons']) {
      const arr = ex[key];
      if (arr === undefined) continue;
      if (!Array.isArray(arr)) return fail(EXIT.INCOMPLETE, 'exception', `exception.${key} 不是数组`);
      const need = key === 'comparisons' ? ['left', 'right', 'at', 'types'] : ['claim', 'basis'];
      for (const [i, it] of arr.entries()) {
        const missing = need.filter((f) => blankValue(it?.[f]));
        if (missing.length) {
          return fail(EXIT.INCOMPLETE, 'exception',
            `exception.${key}[${i}] 缺 ${missing.join('/')}：` +
            (key === 'comparisons'
              ? '不交代比较发在哪一层、两边各是什么类型，就无法区分真不相等与转出来的不相等'
              : '一句没写凭什么的假设，会被当成已验证前提往下传'));
        }
      }
    }
    checks.exception = 'pass';
  } else {
    checks.exception = 'absent';
  }

  // ---- b2 scope：越界等于拿不该拿的东西得结论，归 37（事实，不是形状问题）----
  const selfOutside = Array.isArray(report?.scope?.outside) ? report.scope.outside.filter((s) => !blankValue(s)) : [];
  if (selfOutside.length) {
    return fail(EXIT.IMPACT_WIDE, 'scope',
      `analyzer 自报越界 ${selfOutside.length} 处（${selfOutside.slice(0, 3).join('、')}）：它读了未授权范围内的东西`);
  }
  const scopeRoots = Array.isArray(o.scopeRoots) ? o.scopeRoots.filter((s) => !blankValue(s)).map(pathKeyForScope) : [];
  if (scopeRoots.length) {
    const offenders = [];
    for (const [at, f] of collectReportFiles(report)) {
      const k = pathKeyForScope(f);
      const isAbs = /^[a-z]:\//.test(k) || k.startsWith('/');
      // 相对路径同样算越界：拼接基准由谁定没有定义，所以“看起来在范围内”不算证据。
      if (!isAbs) { offenders.push(`${at}:${f}（相对路径）`); continue; }
      if (!scopeRoots.some((r) => k === r || k.startsWith(r + '/'))) offenders.push(`${at}:${f}`);
    }
    if (offenders.length) {
      return fail(EXIT.IMPACT_WIDE, 'scope',
        `超出 --scope 允许范围 ${offenders.length} 处：${offenders.slice(0, 3).join('、')}`
        + `（文件路径必须给绝对路径，行号放 lines）`);
    }
    checks.scope = 'pass';
  } else {
    checks.scope = 'absent';
  }

  checks.verdict = 'pass';
  return out(EXIT.PASS, true);
}
