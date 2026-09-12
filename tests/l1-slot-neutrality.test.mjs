// tests/l1-slot-neutrality.test.mjs
//
// 这条测试锁的是 F-11 的结论：**L1 提示词文件里不得出现任何具体槽位名引用**。
//
// 为什么值得单独钉：`{{PROJECT.drivers.database.impl}}` 这类写法在 sync 阶段**不会**
// 报错（runtimeify 只按语法把 `{{PROJECT.<dot.path>}}` 改成 token，不看字段存不存在），
// 项目没接、或用户把那个源取成了别的名字时，它只在运行期"填不上值" —— 静默失效的一类
// 缺陷。上一代机制就是这么把"四个数据源"钉成契约的：改 L1 加第 5 个源，看起来像正常
// 演进，实际是在替所有项目规定源的名字与个数。
//
// 边界刻意做成**无分支**的：只禁 prompt 侧四类文件（agents/commands/skills/.qoder），
// 它们没有任何合法理由提到槽位名。scripts/ 里的 legacy 兼容分支与解释性注释、docs/ 与
// schemas/ 里"以前写死了四个名字"的历史说明句都允许 —— 那些是在**讲述**这条纪律，不是
// 在**违反**它。给测试开"除了说明句"这种例外，等于把判据交回模型判断（见本仓库对
// external_directory 例外的同一套论证：含分支的边界判据会退化）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** prompt 侧目录：出现槽位名 = 缺陷，无例外 */
const STRICT_DIRS = ['agents', 'commands', 'skills'];
/** 被禁的槽位名：历史上被写死进 L1 的四个，以及它们可能被拼成的 token 形态 */
const SLOT_NAMES = ['database', 'logs', 'tickets', 'efficiency'];
const SLOT_REF_RE = new RegExp(`drivers\\.(?:${SLOT_NAMES.join('|')})\\b`, 'g');
/** 四名单的枚举形态（"database / logs / tickets / efficiency"）——prompt 侧同样不许 */
const ROSTER_RE = /\bdatabase\s*\/\s*logs|logs\s*\/\s*tickets|tickets\s*\/\s*efficiency/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.md$/.test(name)) yield p;
  }
}

/** 收集 prompt 侧全部 markdown 文件（含 .qoder/rules，它走零配置通道、不进 sync） */
function promptFiles() {
  const out = [];
  for (const d of STRICT_DIRS) for (const f of walk(join(ROOT, d))) out.push(f);
  for (const f of walk(join(ROOT, '.qoder', 'rules'))) out.push(f);
  return out;
}

test('prompt 侧文件不得引用任何具体驱动槽位名', () => {
  const hits = [];
  for (const f of promptFiles()) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(SLOT_REF_RE)) {
      hits.push(`${f.replace(ROOT + '/', '')}: ${m[0]}`);
    }
  }
  assert.deepEqual(hits, [], 'L1 只该规定槽位的形状与 role 语义；要指认数据库通道用 `dbDriver` 别名，其它源按 `desc` 选');
});

test('prompt 侧文件不得写出"四个槽位名清单"的枚举形态', () => {
  const hits = promptFiles()
    .map((f) => [f, readFileSync(f, 'utf8')])
    .filter(([, text]) => ROSTER_RE.test(text))
    .map(([f]) => f.replace(ROOT + '/', ''));
  assert.deepEqual(hits, [], '名单归 L2：加一个外部源不得改 L1');
});

test('.qoder/rules 里不得出现 {{...}} 占位符（它不走 sync 替换）', () => {
  const offenders = readdirSync(join(ROOT, '.qoder', 'rules'))
    .filter((n) => n.endsWith('.md'))
    .filter((n) => readFileSync(join(ROOT, '.qoder', 'rules', n), 'utf8').includes('{{'));
  assert.deepEqual(offenders, [], 'rules 走零配置通道，占位符会原样留在盘上');
});

test('dist 产物同样不得带槽位名引用（sync 不生产这类内容）', () => {
  const distPlugin = join(ROOT, 'dist', 'supper-Han-java-plugin');
  let distFiles;
  try {
    distFiles = [...walk(join(distPlugin, 'agents')), ...walk(join(distPlugin, 'commands')), ...walk(join(distPlugin, 'skills'))];
  } catch {
    // 从未跑过 sync：本条无判据可跑，交给 `sync --check` 那一侧兜
    return;
  }
  const hits = [];
  for (const f of distFiles) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(SLOT_REF_RE)) hits.push(`${f.replace(ROOT + '/', '')}: ${m[0]}`);
    if (ROSTER_RE.test(text)) hits.push(`${f.replace(ROOT + '/', '')}: 槽位名单枚举`);
  }
  assert.deepEqual(hits, [], 'dist 是源的展开，源干净则产物干净；这里红了说明 sync 漏跑或源被改脏');
});
