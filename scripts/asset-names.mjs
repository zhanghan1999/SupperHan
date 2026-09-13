// scripts/asset-names.mjs
// 资产命名空间（namespace）的唯一真相：16 个 subagent / skill 的名字规则 + 旧裸名映射 + 中文角色名。
//
// 为什么要单独一个文件，而不是让各处的字符串各说各话：
//   改名之前，agent 名 = agents/<stem>.md 的文件名 stem（frontmatter 里没有 name: 字段），
//   skill 名 = SKILL.md frontmatter 的 name:（与目录名一致）。这两类标识符在 IDE 侧落在
//   **全局命名空间**里——同机器上另一个 enabled 插件导出同名文件，谁被加载取决于加载顺序，
//   没有任何报错。实测过一次：本插件 11 个 agent 全部被旧插件的同名文件遮蔽，
//   于是红线 R2 的写入锚点、刚收口的只读守卫全锁在没被加载的文件上——测试全绿而保护为零。
//   commands 之所以从未出事，是因为它们本来就带 supperH- 前缀。前缀就是这套资产的名字空间。
//
// 三条纪律：
//   1. **前缀不是装饰**：门禁（sync-assets.mjs namespaceProblems）判"目录里每个资产是否带前缀"，
//      不判"是否在下面这张表里"——新增资产忘登记不会让门禁变绿。
//   2. **旧裸名一次性切断**：不留别名、不留软链。留旧名等于保留撞面本身（旧插件用的就是旧名）。
//   3. **标识符只用 ASCII**：中文名要穿 sync → dist → 插件缓存 → opencode 全局目录四段链路，
//      任何一段对非 ASCII 文件名的处理不一致，失败方式都是"静默解析不到"——正是本次要修的病。
//      角色名（如"开发"）因此只出现在派单文案与 description 里，不进入标识符。
//
// Usage: 被 scripts/sync-assets.mjs 与 tests/asset-naming.test.mjs import；无 CLI。

/** 命名空间前缀。commands / agents / skills 三条通道共用同一个值。 */
export const NS = 'supperH-';

/** 资产标识符（文件名 stem / 目录名 / skill name:）必须匹配的形态。 */
export const ASSET_NAME_RE = /^supperH-[a-z0-9][a-z0-9-]*$/;

/**
 * 旧裸名 → 新名。改造只做一件事：加前缀，不重排内部语义
 * （bug-analyzer → supperH-bug-analyzer，而不是 supperH-analyzer）。
 * 理由：`bug-` / `prelearn-` 这段承载"属于哪条工作流"的信息，去掉它等于在改名之外
 * 顺手做一次重命名，一次性提交里混两种变化会让回归无法逐条核对。
 */
export const AGENT_RENAMES = {
  'bug-analyzer':          NS + 'bug-analyzer',
  'bug-code-generator':    NS + 'bug-code-generator',
  'bug-code-optimizer':    NS + 'bug-code-optimizer',
  'bug-dev':               NS + 'bug-dev',
  'bug-mybatis-optimizer': NS + 'bug-mybatis-optimizer',
  'bug-refactor':          NS + 'bug-refactor',
  'bug-test-writer':       NS + 'bug-test-writer',
  'bug-tester':            NS + 'bug-tester',
  'driver-author':         NS + 'driver-author',
  'prelearn-analyzer':     NS + 'prelearn-analyzer',
  'prelearn-writer':       NS + 'prelearn-writer',
};

export const SKILL_RENAMES = {
  'auto-fix':        NS + 'auto-fix',
  'data-fetch':      NS + 'data-fetch',
  'driver-contract': NS + 'driver-contract',
  'incident-triage': NS + 'incident-triage',
  'prelearn':        NS + 'prelearn',
};

/**
 * 中文角色名：派单文案与 description 里跟着标识符出现的那个括号。
 * 判据是"一句话说得清它干什么、且和邻居不重叠"，不是翻译标识符：
 *   bug-tester 是"跑测试"，bug-test-writer 是"写测试"——反过来的话两个人都会派错。
 * 角色名不掺 `·` 等额外分隔符：它会直接拼进标题（`# <名> · <角色>子 agent`），
 * 一个标题里两个中点就分不清哪段是角色了。
 */
export const ROLE_CN = {
  [AGENT_RENAMES['bug-analyzer']]:          '代码分析',
  [AGENT_RENAMES['bug-code-generator']]:    '代码生成',
  [AGENT_RENAMES['bug-code-optimizer']]:    '代码优化',
  [AGENT_RENAMES['bug-dev']]:               '开发',
  [AGENT_RENAMES['bug-mybatis-optimizer']]: 'Mapper 优化',
  [AGENT_RENAMES['bug-refactor']]:          '重构',
  [AGENT_RENAMES['bug-test-writer']]:       '测试编写',
  [AGENT_RENAMES['bug-tester']]:            '测试执行',
  [AGENT_RENAMES['driver-author']]:         '驱动编写',
  [AGENT_RENAMES['prelearn-analyzer']]:     '预学习读码',
  [AGENT_RENAMES['prelearn-writer']]:       '预学习落笔',
  [SKILL_RENAMES['auto-fix']]:              '修复协议',
  [SKILL_RENAMES['data-fetch']]:            '取数协议',
  [SKILL_RENAMES['driver-contract']]:       '驱动契约',
  [SKILL_RENAMES['incident-triage']]:       '现象分诊',
  [SKILL_RENAMES['prelearn']]:              '预学习统筹',
};

/** 全部新名，按目录归类。门禁枚举资产目录时用这个键名。 */
export const ASSET_KINDS = { agents: AGENT_RENAMES, skills: SKILL_RENAMES };

/** 新名集合。判"某个名字是不是 agent"只能用这个——表的键是旧裸名，不是新名。 */
export const AGENT_IDS  = new Set(Object.values(AGENT_RENAMES));
export const SKILL_IDS  = new Set(Object.values(SKILL_RENAMES));
export const ASSET_IDS  = new Set([...AGENT_IDS, ...SKILL_IDS]);

/** 旧裸名全集（长度降序）。批量改写与"裸名不得再现"判据共用同一张表。 */
export const LEGACY_NAMES = Object.keys({ ...AGENT_RENAMES, ...SKILL_RENAMES })
  .sort((a, b) => b.length - a.length);

/** 旧裸名 → 新名（agents + skills 合并）。 */
export const RENAMES = { ...AGENT_RENAMES, ...SKILL_RENAMES };

/** 资产名是否已带命名空间。传文件名时先过 assetStem()。 */
export function isNamespaced(name) {
  return ASSET_NAME_RE.test(String(name ?? ''));
}

/** `agents/supperH-bug-dev.md` / `skills/supperH-prelearn/SKILL.md` → 资产名。 */
export function assetStem(p) {
  const s = String(p).replace(/\\/g, '/');
  const m = s.match(/(?:^|\/)(?:agents|skills)\/([^/]+?)(?:\.md)?$/);
  const base = m ? m[1] : s.replace(/^.*\//, '').replace(/\.md$/, '');
  return base === 'SKILL' ? s.split('/').filter(Boolean).slice(-2, -1)[0] : base;
}

/** 展示形：`supperH-bug-dev（开发）`。未登记角色名的资产回裸标识符，不编造。 */
export function displayName(id) {
  const role = ROLE_CN[id];
  return role ? `${id}（${role}）` : id;
}

/** 资产自己的正文标题（H1）：agent 与 skill 形态不同，但都由本函数单点给出。 */
export function headingFor(id) {
  const role = ROLE_CN[id];
  if (!role) throw new Error(`headingFor: ${id} 未登记中文角色名`);
  return AGENT_IDS.has(id) ? `# ${id} · ${role}子 agent` : `# skill: ${id} · ${role}`;
}

/**
 * 裸名匹配正则：前一个字符不能是标识符字符（含 `-`），后面也不能接标识符字符。
 * 后者用**前瞻**而不是吃掉——写成 `($|[^A-Za-z0-9_-])` 时，`a bug-dev bug-tester b`
 * 这种紧邻两处引用会吃掉中间那个空格，导致第二处漏改（全局正则是从上次结尾继续扫的）。
 * 前瞻不消耗字符，所以 `supperH-data-fetch` 里的 `data-fetch` 依然不会被再命中一次
 * （前面是 `-`），改名判据与门禁判据因此能用同一个正则。
 */
export function legacyRe(name) {
  return new RegExp('(^|[^A-Za-z0-9_-])' + name + '(?![A-Za-z0-9_-])', 'g');
}
