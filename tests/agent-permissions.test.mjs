// tests/agent-permissions.test.mjs
// 跨 workspace 写文件的能力（external_directory）到底放开了给谁 —— 机械点名。
//
// 为什么要有这个文件：
//   `.qoder/rules/10-redlines.md` R2 第一条一直是「禁止 supperH-prelearn-writer 之外任何 agent 用
//   external_directory: allow」，但**从来没有一条测试锁过它** —— 于是它是纯文字契约，
//   谁加一个 frontmatter 都不会红。同一个仓库里"MCP 只绑 4 个只读子 agent"却是有名单测试的
//   （mcp-manifest.test.mjs），一条靠测试一条靠自觉，靠自觉那条必然漂。
//   本文件把它焊上：名单外的 allow 即红，名单内的必须自带路径前缀自检。
//
// 顺带锁住"一个 agent 只能有一个前缀"：把两个职责塞进同一个放开面 agent（曾评估把写驱动
//   并入 supperH-prelearn-writer）会让判据从「路径必须以 X 开头」退化成「先判模式再查前缀」，
//   等于把边界交还给模型判断。那种写法在这里过不了测试（锚点行只能有一条）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'supper-Han-java-plugin');

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const frontmatterOf = (text) => {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : '';
};

/**
 * 放开 external_directory 的 subagent 名单，以及**唯一**允许它写入的私有根子目录锚点。
 * 加一个例外要同时改三处：本名单、`.qoder/rules/10-redlines.md` R2、`docs/architecture.md` §5。
 * 只改文案不改这里 = 本测试红；只改这里不改文案 = 文档开始说谎（评审抓不到，但下一次决策会错）。
 */
const BOUND_AGENTS = [
  { file: 'supperH-prelearn-writer.md', anchor: 'CONTEXT_ROOT' },
  { file: 'supperH-driver-author.md',   anchor: 'DRIVERS_ROOT' },
];
// command 入口（primary）侧的放开面同样点名：它们不是 subagent，但同样跨 workspace 写盘。
const BOUND_COMMANDS = [
  'supperH-bootstrap.md',   // 建私有根骨架
  'supperH-init.md',        // 写 projects/<code>.yaml + screens/<code>.yaml
  'supperH-driver.md',      // 写 projects/<code>.yaml（经 driver-registry.mjs）与临时 values JSON
  'supperH-setup.md',       // 写 IDE 加载目录
];

function listWith(dir, predicate) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).filter((n) => n.endsWith('.md'))
    .filter((n) => predicate(frontmatterOf(read(path.join(dir, n)))))
    .sort();
}
// permission 下的键是缩进的（`  external_directory: allow   # 注释`），所以前导空白必须允匹配。
const hasAllow = (fm) => /^[ \t]*external_directory:[ \t]*allow[ \t]*(#.*)?$/m.test(fm);
const hasDeny  = (fm) => /^[ \t]*external_directory:[ \t]*deny[ \t]*(#.*)?$/m.test(fm);
const allowAgents = (dir) => listWith(dir, hasAllow);
const allowCmds   = (dir) => listWith(dir, hasAllow);

// ---------- 名单本身 ----------

test('放开 external_directory 的 subagent 恰好是指定名单，不多一个', () => {
  assert.deepEqual(allowAgents(path.join(ROOT, 'agents')),
    BOUND_AGENTS.map((b) => b.file).sort(),
    '名单外出现 allow = R2 红线被无声突破；名单内漏掉 = 该 agent 走不到它该写的目录');
});

test('其余 subagent 必须显式写 deny（缺省不算收紧）', () => {
  const dir = path.join(ROOT, 'agents');
  const allowSet = new Set(BOUND_AGENTS.map((b) => b.file));
  const loose = [];
  for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    if (allowSet.has(n)) continue;
    const fm = frontmatterOf(read(path.join(dir, n)));
    if (!hasDeny(fm)) loose.push(n);
  }
  assert.deepEqual(loose, [], '这些 agent 没写 external_directory: deny —— 权限缺省由 IDE 决定，等于没关');
});

test('放开 external_directory 的 command 入口恰好是指定名单', () => {
  assert.deepEqual(allowCmds(path.join(ROOT, 'commands')), BOUND_COMMANDS.slice().sort());
});

test('dist 里的放开面与源一致（防止只改了源没重烤产物）', () => {
  const distAgents = allowAgents(path.join(DIST, 'agents'));
  assert.ok(distAgents, 'dist 未生成，先跑 node scripts/sync-assets.mjs');
  assert.deepEqual(distAgents, BOUND_AGENTS.map((b) => b.file).sort(),
    'dist 与源不一致：加载的是旧产物，红线改了也没用');
  const distCmds = allowCmds(path.join(DIST, 'commands'));
  assert.deepEqual(distCmds, BOUND_COMMANDS.slice().sort());
});

// ---------- 名单内的人得真的把自己关住 ----------

/** 锚点行：「`filePath` 必须以 `{{X_ROOT}}/` 开头」。整个文件只允许出现一条。 */
function anchorsOf(text) {
  return [...text.matchAll(/必须以\s*`\{\{([A-Z_]+_ROOT)\}\}\/?`\s*开头/g)].map((m) => m[1]);
}

for (const { file, anchor } of BOUND_AGENTS) {
  test(`${file}：只有一个写入锚点，且带 WRITE_BOUNDARY_VIOLATION 兜底`, () => {
    const text = read(path.join(ROOT, 'agents', file));
    const list = anchorsOf(text);
    assert.deepEqual([...new Set(list)], [anchor],
      '放开面 agent 必须只有**一个**路径前缀；出现两个说明判据变成了含分支的条件式（先判模式再判边界）');
    assert.equal(list.length, 1, '锚点行重复 = 哪一条生效要看模型读哪条，不再是机械判据');
    assert.match(text, /WRITE_BOUNDARY_VIOLATION/,
      '越界必须有一个不成解释、不重试、不请求确认的确定回报码');
    assert.match(text, /## 严格写入边界/, '必须有一节专门写边界，而不是散落在角色描述里');
  });
}

test('红线文案与本名单同步（文档说谎就是评审失效）', () => {
  const rules = read(path.join(ROOT, '.qoder', 'rules', '10-redlines.md'));
  for (const { file } of BOUND_AGENTS) {
    const name = file.replace(/\.md$/, '');
    assert.ok(rules.includes(name), `R2 名单里缺 ${name} —— 红线句子与实际放开面已经不一致`);
  }
  const arch = read(path.join(ROOT, 'docs', 'architecture.md'));
  assert.match(arch, /只放开 \*\*2 个 subagent \+ 4 个 command\*\*/,
    'architecture §5 的口径没跟上（写少而盘上多 = 下一次 review 拿假数字做判断）');
  assert.match(arch, /agent-permissions\.test\.mjs/, '§5 应指向本测试，否则读者以为这仍是一条靠自觉的规则');
});

test('rules 文件自身合规：不得含双花括号占位符（它们不走 sync 替换）', () => {
  for (const n of fs.readdirSync(path.join(ROOT, '.qoder', 'rules')).filter((x) => x.endsWith('.md'))) {
    assert.doesNotMatch(read(path.join(ROOT, '.qoder', 'rules', n)), /\{\{/, n + ' 含占位符：写了也不会被展开');
  }
});

// ---------- S2 类缺陷护栏：deny 角色的正文不许"伸手"私有根去读 ----------
// 背景：本仓既定纪律（`commands/supperH-learn.md` 步骤 2 / architecture C5）——
//   拿不到学习产物的角色既不亲自读私有根也不亲自跑 git，需要就用 `resolve-project.mjs`
//   把结果作为入参喂进来。但曾出现两处 subagent 正文违背自身 frontmatter：
//   `supperH-bug-test-writer` / `supperH-bug-mybatis-optimizer` 写着"从 {{CONTEXT_ROOT}} 读"，
//   而它们 `external_directory: deny` —— 声明禁止的事，正文要求它做。frontmatter 与 prose
//   之间没有任何机械校验，这类互斥能全绿通过（和 entryPattern"只存在于设计文档也算违反"同盲区）。
//   本测试把"肯定式伸手私有根"这一可机械识别的形态钉死：deny 文件正文命中即红。
// 诚实边界（地板不是天花板）：只抓 `[从/由/直读]`（否定后瞻排除"亲自/自己 读"）或 `[写到/写进/写入]` + 占位符 这种最直白的伸手句式；
//   换措辞（如"落盘到 {{...}}"、"经 --emit-sql 落盘"）仍可能绕过——prose 无法完全机械判定，这条只挡最典型
//   的复发。以下**不该**被算作伸手、故不匹配：① 否定句"你不亲自读 {{CONTEXT_ROOT}}"（无伸手前缀）；
//   ② 描述 allow-agent 落点的句子"产物落 {{CONTEXT_ROOT}}"（"落"不在动词集）；③ 经 node 落盘的正确写法
//   "确定式落盘到 {{TASKS_ROOT}}"（无"写到/写进/写入"前缀）——写侧的正解就是把落盘下沉进 node，
//   只禁"deny 角色用自己的编辑工具伸手"，不禁"叙述一个 node 落盘的目标路径"。
const bodyOf = (text) => {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? text.slice(m[0].length) : text;
};
// 伸手前缀 = 读（从/由/直读 私有根取数）或 写（写到/写进/写入 私有根）；后（可夹反引号+空白）紧跟私有根占位符。
// 读侧曾漏网 `supperH-bug-test-writer` / `supperH-bug-mybatis-optimizer`（S2，F-17）；写侧曾漏网
// `supperH-bug` 主命令与 `supperH-bug-dev`（F-18：正文让它俩把 SQL 文件写到 {{TASKS_ROOT}}，而都 external_directory: deny）。
// F-19 补上无"从/由"前缀的肯定式"直读/只读 {{CONTEXT_ROOT}}"（`supperH-bug-dev` L70 / `supperH-bug-analyzer` L37）：
// 用否定后瞻区分肯定式与否定式——本仓否定式修正句只有"亲自读"与"自己去读"两种（都以 读 结尾但表否定），
// 分别被 (?<!亲自) / (?<!自己去) 排除；而肯定式"只读"（前置 只）、行首列表项"读"（前置空白）无这些前缀，仍命中。
const REACH_PRIVATE_RE = /(?:[从由]|(?<!亲自)(?<!自己去)(?<!自己)读|写(?:到|进|入))[\s`]*\{\{(?:CONTEXT|PRIVATE|DRIVERS|TASKS)_ROOT\}\}/;

test('deny 的 agent/command：正文不得出现"从/由/直读 私有根"或"写到 私有根"指令（S2 权限声明与正文互斥）', () => {
  const offenders = [];
  for (const dir of ['agents', 'commands']) {
    const base = path.join(ROOT, dir);
    for (const n of fs.readdirSync(base).filter((x) => x.endsWith('.md'))) {
      const text = read(path.join(base, n));
      if (hasAllow(frontmatterOf(text))) continue;   // allow 面本就合法跨边界，跳过
      const hits = bodyOf(text).split(/\r?\n/).filter((line) => REACH_PRIVATE_RE.test(line));
      if (hits.length) offenders.push(`${dir}/${n}: ${hits.map((h) => h.trim()).join(' | ')}`);
    }
  }
  assert.deepEqual(offenders, [],
    '这些 deny 角色正文要求"从私有根读/往私有根写"，但 external_directory: deny 让它做不到——读取应改由命令层经 resolve-project.mjs 注入入参（见 supperH-learn 步骤 2 纪律），落盘应下沉进 node（见 resolve-project.mjs --emit-sql）');
});
