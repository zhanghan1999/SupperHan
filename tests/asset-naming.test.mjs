// tests/asset-naming.test.mjs
// 资产标识符的命名空间（namespace）与中文角色名 —— 机械锁。
//
// 为什么要有这个文件（实测事故，不是假想风险）：
//   agent 名 = `agents/<stem>.md` 的文件名 stem（frontmatter 里没有 name: 可依赖），
//   skill 名 = `SKILL.md` 的 `name:` + 目录名。两者在 IDE 侧都落在**全局命名空间**。
//   本机曾经同时 enabled 两个插件（本仓 + 一个历史遗留插件），两边导出 11 个同名 agent
//   与 2 个同名 skill：加载顺序决定谁生效，**没有任何报错**。本会话实际加载的全是对方那份，
//   于是红线 R2 的写入锚点与数据库只读守卫锁在没被加载的文件上 —— 239 条测试全绿而保护为零。
//   commands 从没出过这个问题，因为它们的名字一直带 supperH- 前缀。
//
// 本文件把"前缀 = 名字空间"从巧合变成约束，并锁住改名之后的三件事：
//   1) 目录里的资产集合 == 改名表（新增不登记就红，防止"表与目录各说各话"）；
//   2) 每个资产在自己的 description / H1 上带 `标识符（中文角色名）`，派单侧文件首次提到它时
//      也要带 —— 重命名只解决撞面，可读性（"这名字到底干什么"）是同一个改名的另一半；
//   3) 退役裸名不得再出现在运行期加载目录（留旧名 = 把撞面本身留着）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  NS, ASSET_NAME_RE, AGENT_RENAMES, SKILL_RENAMES, AGENT_IDS, SKILL_IDS,
  ROLE_CN, LEGACY_NAMES, legacyRe, headingFor,
} from '../scripts/asset-names.mjs';
import { namespaceProblems } from '../scripts/sync-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const assetIds = [...Object.values(AGENT_RENAMES), ...Object.values(SKILL_RENAMES)];

/** 目录里真实存在的资产名（agent 取文件名 stem，skill 取目录名）。 */
function assetsOnDisk() {
  return {
    agents: fs.readdirSync(path.join(ROOT, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort(),
    skills: fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort(),
  };
}

// ---------- 1. 表与目录一致，且全部带前缀 ----------

test('agents/ 与 skills/ 里的资产集合恰好等于改名表（新增要登记，删名要同步）', () => {
  const disk = assetsOnDisk();
  assert.deepEqual(disk.agents, [...AGENT_IDS].sort(),
    'agent 文件与 AGENT_RENAMES 不一致：新加 subagent 必须同时登记 scripts/asset-names.mjs（角色名 + 撞面门禁靠它）');
  assert.deepEqual(disk.skills, [...SKILL_IDS].sort(),
    'skill 目录与 SKILL_RENAMES 不一致，同上');
});

test('三条通道的标识符全部带命名空间前缀（commands 一直没撞面就是靠它）', () => {
  const bad = [];
  for (const [dir, files] of [
    ['agents',  fs.readdirSync(path.join(ROOT, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))],
    ['commands', fs.readdirSync(path.join(ROOT, 'commands')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))],
    ['skills',   fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)],
  ]) for (const s of files) if (!ASSET_NAME_RE.test(s)) bad.push(`${dir}/${s}`);
  assert.deepEqual(bad, [], `未带 ${NS} 前缀的资产：${bad.join(', ')} —— 同名资产会被别的插件顶掉且不报错`);
});

test('真仓库当前过得了撞面门禁（namespaceProblems 为空）', () => {
  assert.deepEqual(namespaceProblems(ROOT), [],
    '撞面门禁红了：sync 会以 exit 7 拒绝烤 dist');
});

// ---------- 2. 角色名进了自我声明与派单文案 ----------

test('每个资产把「标识符（中文角色名）」写在自己的 description 与 H1 上', () => {
  const missingRole = [], badHeading = [];
  for (const id of assetIds) {
    const file = AGENT_IDS.has(id)
      ? path.join(ROOT, 'agents', id + '.md')
      : path.join(ROOT, 'skills', id, 'SKILL.md');
    const text = read(file);
    // description 在 frontmatter 里是整行；角色括号必须紧跟标识符
    if (!new RegExp('^description: ' + id + '（' + ROLE_CN[id] + '）', 'm').test(text)) missingRole.push(id);
    // 正文 H1（frontmatter 之后第一个 "# "）由 headingFor() 单点给出，skill 允许保留尾括号
    const fmEnd = text.indexOf('---', 3);
    const body = text.slice(fmEnd + 3);
    const h1 = (body.match(/^# [^\r\n]*/m) || [''])[0];
    if (!h1.startsWith(headingFor(id))) badHeading.push(`${id}: ${h1}`);
  }
  assert.deepEqual(missingRole, [], '这些资产没在 description 里声明中文角色名（改名只解决撞面，可读性靠这一半）');
  assert.deepEqual(badHeading, [], '正文 H1 与 asset-names.mjs 的 headingFor() 不一致');
});

/**
 * 非路径形提及：`skills/x/SKILL.md`、`x.md`、`supperH-a/supperH-b` 这类都不算，
 * 因为往路径里插中文括号会把路径写坏。围栏代码块整体跳过（同理，改代码块 = 改语义）。
 */
function proseLines(text, id) {
  let fence = false;
  const hits = [];
  text.split(/\r?\n/).forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return; }
    if (fence) return;
    for (let k = l.indexOf(id); k >= 0; k = l.indexOf(id, k + 1)) {
      const prev = k === 0 ? '' : l[k - 1];
      const next = l[k + id.length] || '';
      if (!/[A-Za-z0-9_./-]/.test(prev) && !/[A-Za-z0-9_/-]/.test(next)) hits.push(i + 1);
    }
  });
  return hits;
}

test('派单侧文件（commands / 红线 / README）提到某资产时必须 spelled out 一次角色名', () => {
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'commands')).map((f) => path.join(ROOT, 'commands', f)),
    ...fs.readdirSync(path.join(ROOT, '.qoder', 'rules')).map((f) => path.join(ROOT, '.qoder', 'rules', f)),
    path.join(ROOT, 'README.md'),
  ].filter((f) => f.endsWith('.md'));
  const missing = [];
  for (const f of files) {
    const t = read(f);
    for (const id of assetIds) {
      if (!proseLines(t, id).length) continue;                       // 只在路径里出现 = 不要求注角色
      if (new RegExp(id + '`{0,1}（' + ROLE_CN[id] + '）').test(t)) continue;
      missing.push(`${path.basename(f)} 缺 ${id}（${ROLE_CN[id]}）`);
    }
  }
  assert.deepEqual(missing, [], '派单文案里只出现英文标识符、没带中文角色名 = 读的人不知道该派谁');
});

test('角色名不与邻居撞车：16 个资产各说各话', () => {
  const seen = new Map();
  for (const id of assetIds) {
    const r = ROLE_CN[id];
    assert.ok(r && r.length >= 2, `${id} 的角色名缺失或过短`);
    if (seen.has(r)) assert.fail(`角色名 "${r}" 同时给了 ${seen.get(r)} 和 ${id}`);
    seen.set(r, id);
  }
});

// ---------- 3. 退役裸名不得回来（门禁自己会不会红） ----------

test('撞面门禁真会红：裸名文件 / name 与目录不符 / 资产目录被清空', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-naming-'));
  const write = (rel, text) => {
    const p = path.join(base, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
  };
  const kindOf = (list, file) => list.filter((p) => p.file === file).map((p) => p.kind);

  // (a) agent 文件名回到裸名：前缀不合规 + 裸名出现在文件名里都要红
  write('agents/bug-dev.md', '---\ndescription: x\n---\n\n# bug-dev\n');
  write('commands/supperH-bug.md', '---\ndescription: y\n---\n\n# 入口\n');
  write('skills/supperH-demo/SKILL.md', '---\nname: supperH-demo\ndescription: z\n---\n\n# skill: supperH-demo\n');
  write('.qoder/rules/10-redlines.md', '# 红线\n\n不点名任何资产。\n');
  let probs = namespaceProblems(base);
  assert.ok(kindOf(probs, 'agents/bug-dev.md').includes('prefix'), '裸名文件没被前缀判据抓到');
  assert.ok(probs.some((p) => p.kind === 'legacy' && p.file === 'agents/bug-dev.md'),
    '裸名资产要被两条判据同时抓到（前缀形态 + 历史名回潮），只中一条也算拦住');

  // (b) skill 的 name: 与目录名不一致：加载方按哪个认不确定
  fs.rmSync(path.join(base, 'agents'), { recursive: true, force: true });
  write('agents/supperH-bug-dev.md', '---\ndescription: x\n---\n\n# ok\n');
  write('skills/supperH-demo/SKILL.md', '---\nname: demo\ndescription: z\n---\n');
  probs = namespaceProblems(base);
  assert.deepEqual(probs.map((p) => p.kind).sort(), ['mismatch'],
    `清掉裸名文件后应只剩 name/目录不符，实得 ${JSON.stringify(probs)}`);

  // (c) 没有 name: 字段
  write('skills/supperH-demo/SKILL.md', '---\ndescription: z\n---\n');
  assert.ok(kindOf(namespaceProblems(base), 'skills/supperH-demo/SKILL.md').includes('noname'),
    'frontmatter 缺 name: 必须红（agent 靠文件名认，skill 靠它，缺了就是猜）');

  // (d) 资产目录被清空：dist 会被烤成"没有 agent 的插件"，而 sync 自己不会报
  fs.rmSync(path.join(base, 'agents'), { recursive: true, force: true });
  fs.mkdirSync(path.join(base, 'agents'));
  assert.ok(kindOf(namespaceProblems(base), 'agents/').includes('empty'), '空目录必须红');

  fs.rmSync(base, { recursive: true, force: true });
});

test('改名表自身是唯一允许出现退役裸名的地方（sync-assets 与 tests 除外）', () => {
  const src = read(path.join(ROOT, 'scripts', 'sync-assets.mjs'));
  assert.ok(/namespaceProblems/.test(src), 'sync-assets.mjs 没接撞面门禁');
  assert.match(src, /process\.exit\(7\)/, '撞面违规必须单独一个退出码，不能混进 5/6');
  // 历史表里保留裸名是设计（它就是"旧名 → 新名"），所以扫描必须显式跳过它
  for (const n of LEGACY_NAMES) assert.ok(legacyRe(n).test(`派 \`${n}\` 干活`), `裸名 ${n} 的边界正则失效`);
  assert.ok(!legacyRe('data-fetch').test('supperH-data-fetch/SKILL.md'), '带前缀的名字不该再被裸名规则命中');
  assert.ok(!legacyRe('prelearn').test('supperH-prelearn-analyzer'), '长名内部不能误命中短名规则');
});
