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
