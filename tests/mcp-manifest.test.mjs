// tests/mcp-manifest.test.mjs
// MCP 注册表形状 + 三张契约表的一致性。
//
// 为什么锁这些：
//   1) `.mcp.json` 是插件里唯一一条 server 注册项，靠"相对路径 + importlib 查找 adapter"
//      实现"加项目不改注册表"。一旦有人把绝对路径/env 值写进去，注册漂移就回来了，
//      而且凭据会进到一个 agent 可读的文件里。
//   2) 退出码与写守卫在三个地方各有一份声明（base_driver.py 脚本通道、
//      supperh_contract/codes.py+guards.py MCP 通道、driver-response.schema.json 契约）。
//      双通道的前提是同构：同一次失败必须给出同一个码、同一条 deny 消息。
//      这三份只能靠机械比对保证一致，"记得手动同步"就是漂移的开始。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePrivateRoot } from '../scripts/resolve-private-root.mjs';

const ROOT    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST    = path.join(ROOT, 'dist', 'supper-Han-java-plugin');
const MCP_ID  = 'supperh-drivers';
const PY      = process.platform === 'win32' ? 'python' : 'python3';
const SHELL   = path.join(ROOT, 'mcp-skeleton', 'shell.py');

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');

function pyAvailable() { return spawnSync(PY, ['--version'], { encoding: 'utf8' }).status === 0; }
function yamlAvailable() {
  return spawnSync(PY, ['-c', 'import yaml'], { encoding: 'utf8' }).status === 0;
}
function runShell(args, extraEnv) {
  const r = spawnSync(PY, [SHELL, ...args], {
    encoding: 'utf8', cwd: ROOT,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
/** First stdout line as JSON: the envelope is a single compact line by contract. */
function shellEnvelope(args, extraEnv) {
  const r = runShell(args, extraEnv);
  const line = r.out.split(/\r?\n/).find((l) => l.trim().startsWith('{'));
  return { ...r, env: line ? JSON.parse(line) : null };
}
function exitTable(src) {
  const out = {};
  for (const m of src.matchAll(/^EXIT_([A-Z_]+)\s*=\s*(\d+)\s*$/gm)) out[m[1]] = Number(m[2]);
  return out;
}
function keywordTuple(src, name) {
  const m = src.match(new RegExp(name + '\\s*=\\s*\\(([\\s\\S]*?)\\)'));
  if (!m) return null;
  return [...m[1].matchAll(/["']([A-Z]+)["']/g)].map((x) => x[1]);
}
/** driver-response.schema.json is JSON with trailing `#` comment lines (draft-07 doc style). */
function readDriverSchema() {
  const raw = read(path.join(ROOT, 'schemas', 'driver-response.schema.json'));
  return { doc: JSON.parse(raw.split(/\r?\n/).filter((l) => !/^#/.test(l)).join('\n')), raw };
}

/**
 * Minimal draft-07 subset validator, enough for the shapes this contract declares
 * (type / minimum / required / properties / additionalProperties / enum / const /
 * $ref / oneOf-of-null / allOf+if+then). Written here rather than pulled from npm because
 * the point of this file is to check *our* contract against *our* implementations,
 * so the checking rules must be as boring and reviewable as possible.
 */
function schemaProblems(schema, value, at = '$', problems = []) {
  const deref = (s) => (s && typeof s.$ref === 'string')
    ? s.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], schema) : s;
  const types = (t) => Array.isArray(t) ? t : (t ? [t] : []);
  const jsonType = (v) => Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v);
  const s = deref(schema) || {};
  if (s.const !== undefined && value !== s.const) problems.push(`${at}: 应为 ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value)))
    problems.push(`${at}: 值 ${JSON.stringify(value)} 不在 enum ${JSON.stringify(s.enum)}`);
  const t = types(s.type);
  // draft-07 里 integer 是 number 的子集：JSON.parse 出来只有 number 一种类型，
  // 不特判就会把每个整数字段都报成"类型不符"，校验器比实现还先坏掉。
  const typeOk = (want, v) => {
    const got = jsonType(v);
    if (want === 'integer') return got === 'number' && Number.isInteger(v);
    return got === want;
  };
  if (t.length && !t.some((w) => typeOk(w, value))) { problems.push(`${at}: 类型应为 ${t.join('|')}，实为 ${jsonType(value)}`); return problems; }
  if (typeof s.minimum === 'number' && typeof value === 'number' && value < s.minimum)
    problems.push(`${at}: 值 ${value} 小于契约声明的 minimum ${s.minimum}`);
  if (s.oneOf) {
    const hits = s.oneOf.filter((sub) => schemaProblems(sub, value, at, []).length === 0).length;
    if (hits !== 1) problems.push(`${at}: oneOf 命中 ${hits} 个分支（应恰好 1 个）`);
  }
  if (jsonType(value) === 'object') {
    for (const r of s.required || []) if (!(r in value)) problems.push(`${at}.${r}: 缺失（契约 required）`);
    const props = s.properties || {};
    for (const k of Object.keys(value)) {
      if (props[k]) schemaProblems(props[k], value[k], `${at}.${k}`, problems);
      else if (s.additionalProperties === false) problems.push(`${at}.${k}: 契约未声明此顶层字段`);
    }
    for (const frag of s.allOf || []) {
      if (!frag.if) continue;
      const okIf = schemaProblems(frag.if, value, at, []).length === 0;
      if (okIf && frag.then) schemaProblems({ ...frag.then, type: 'object' }, value, at, problems);
    }
  }
  if (Array.isArray(value) && s.items) {
    value.forEach((v, i) => schemaProblems(s.items, v, `${at}[${i}]`, problems));
  }
  return problems;
}

let hasPy = false;
let hasYaml = false;
before(() => {
  hasPy = pyAvailable();
  hasYaml = hasPy && yamlAvailable();
});

// ---------- 注册表形状 ----------
test('dist/.mcp.json：唯一一条 server、全相对、cwd "."、只声明 env 变量名', (t) => {
  const file = path.join(DIST, '.mcp.json');
  if (!fs.existsSync(file)) return t.skip('dist 未构建（run: node scripts/sync-assets.mjs）');
  const raw = read(file);
  const mcp = JSON.parse(raw);
  const ids = Object.keys(mcp.mcpServers || {});
  assert.deepEqual(ids, [MCP_ID], '只允许一条注册项：多条目＝注册漂移又回来了');
  const e = mcp.mcpServers[MCP_ID];
  assert.ok(!/^[A-Za-z]:[\\/]/.test(e.command) && !e.command.startsWith('/') && !e.args[0].startsWith('/'),
    `command/args 必须是插件相对形态：${JSON.stringify([e.command, e.args])}`);
  assert.ok(!/[A-Za-z]:[\\/]/.test(raw), '.mcp.json 里不得出现任何盘符绝对路径');
  assert.equal(e.cwd, '.');
  assert.deepEqual(e.args, ['mcp-skeleton/shell.py']);
  assert.ok(!e.env || !Object.keys(e.env).length, '凭据/端点不得以 env 值写进注册表（agent 可读该文件）');
  assert.deepEqual(e.env_vars, ['SUPPERH_PRIVATE_ROOT', 'SUPPERH_TOOL_ROOT', 'SUPPERH_TRACE']);
  const pr = resolvePrivateRoot();
  assert.ok(!raw.includes(pr.privateRoot), '私有根只能经 mcp-skeleton/private-root.txt 传递');
});

test('plugin.json 声明 mcpServers 指针，且指向的文件真的存在', () => {
  const manifest = JSON.parse(read(path.join(DIST, '.qoder-plugin', 'plugin.json')));
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.ok(manifest.mcpServers.startsWith('./'), '注册表必须挂在插件根，不指到仓外');
  const target = path.join(DIST, manifest.mcpServers.replace(/^\.\//, ''));
  assert.ok(fs.existsSync(target), `${manifest.mcpServers} 指向的文件不存在：${target}`);
});

test('私有根指针文件已烤入，内容就是当前私有根（安装态靠它定位）', (t) => {
  const ptr = path.join(DIST, 'mcp-skeleton', 'private-root.txt');
  if (!fs.existsSync(ptr)) return t.skip('dist 未构建（run: node scripts/sync-assets.mjs）');
  assert.equal(read(ptr).trim(), resolvePrivateRoot().privateRoot);
});

test('schema 声明了通道字段：kind 只两值、mcp 绑定必填 server+sources', () => {
  const y = read(path.join(ROOT, 'schemas', 'project.schema.yaml'));
  assert.match(y, /kind:\s*\r?\n\s+type: string\s*\r?\n\s+enum: \[script, mcp\]/,
    'kind 只能是 script|mcp（三通道分类已被否定）');
  assert.match(y, /fallback:\s*\r?\n\s+type: string\s*\r?\n\s+enum: \[script, none\]/);
  assert.doesNotMatch(y, /mcp-official|mcp-local/, '官方/自研是配置选型，不能回退成 L2 枚举');
  assert.match(y, /mcpBinding:/);
  assert.match(y, /required: \[server, sources\]/, '缺绑定会让 kind=mcp 无通道可走');
});

test('project.example.yaml 通过校验（additionalProperties:false 下的模板回归）', () => {
  const r = spawnSync(process.execPath,
    [path.join(ROOT, 'scripts', 'validate-project.mjs'), '--file', path.join(ROOT, 'schemas', 'project.example.yaml')],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---------- --check 的 MCP 断言会真拦 ----------
test('sync --check 能识别注册表被改坏（绝对路径 / cwd 非相对 / env 值）', (t) => {
  const file = path.join(DIST, '.mcp.json');
  if (!fs.existsSync(file)) return t.skip('dist 未构建（run: node scripts/sync-assets.mjs）');
  const bak = read(file);
  const bad = JSON.stringify({ mcpServers: { [MCP_ID]: {
    command: 'python', args: ['C:/somewhere/shell.py'], cwd: 'C:/x',
    env: { DB_PASSWORD: 'hunter2' }, env_vars: ['SUPPERH_TRACE'] } } });
  try {
    fs.writeFileSync(file, bad, 'utf8');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-assets.mjs'), '--check'],
      { encoding: 'utf8' });
    assert.equal(r.status, 4, '注册表坏掉必须阻断，不能只打印');
    const err = String(r.stderr || '');
    assert.match(err, /args\[0\] 是绝对路径/);
    assert.match(err, /cwd 应为 "\."（相对插件目录）/);
    assert.match(err, /写了 env 值/);
    assert.match(err, /指向的壳不存在/);
  } finally {
    fs.writeFileSync(file, bak, 'utf8');
  }
});

test('sync 拒绝把 token 写进 .py 源码（烤成绝对路径后反斜杠会变转义序列）', () => {
  const probe = path.join(ROOT, 'drivers-skeleton', 'tmp-token-probe.py');
  try {
    fs.writeFileSync(probe, '"""probe"""\nX = "{{PRIVATE_ROOT}}/drivers"\n', 'utf8');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-assets.mjs')],
      { encoding: 'utf8' });
    assert.equal(r.status, 3, '.py 里的 token 必须阻断构建');
    assert.match(String(r.stderr || ''), /Python 源码不得写 token/);
  } finally {
    fs.rmSync(probe, { force: true });
    // dist 被上面那次中断留了半成品，重新 sync 回干净状态
    assert.equal(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-assets.mjs')],
      { encoding: 'utf8' }).status, 0);
  }
});

// ---------- 三张契约表一致 ----------
test('退出码表三处一致：base_driver / supperh_contract / driver-response.schema.json', () => {
  const script = exitTable(read(path.join(ROOT, 'drivers-skeleton', 'base_driver.py')));
  const mcp = exitTable(read(path.join(ROOT, 'mcp-skeleton', 'supperh_contract', 'codes.py')));
  const want = {
    OK: 0, PROJECT_UNREGISTERED: 1, BAD_ARGS: 2,
    SOURCE_UNREACHABLE: 3, AUTH_EXPIRED: 4, SCHEMA_VIOLATION: 5
  };
  assert.deepEqual(script, want, '脚本通道的码表被改动了？');
  assert.deepEqual(mcp, want, 'MCP 通道与脚本通道给出不同的码 = 模型拿到互相矛盾的指令');
  const { doc } = readDriverSchema();
  assert.deepEqual(doc.definitions.errorObj.properties.code.enum, [1, 2, 3, 4, 5],
    '契约文件允许的 error.code 必须与两张实现表同集（0 不入 error，它只当退出码）');
});

test('写守卫关键字表两处一致，且 deny 消息带 DB_GATE_DENY 标记', () => {
  const scriptSrc = read(path.join(ROOT, 'drivers-skeleton', 'base_driver.py'));
  const mcpSrc = read(path.join(ROOT, 'mcp-skeleton', 'supperh_contract', 'guards.py'));
  const a = keywordTuple(scriptSrc, 'WRITE_SQL_KEYWORDS');
  const b = keywordTuple(mcpSrc, 'WRITE_SQL_KEYWORDS');
  assert.ok(a && a.length, 'base_driver 的关键字表没解析到');
  assert.deepEqual(b, a, '两条通道必须拒绝同一批语句');
  assert.match(mcpSrc, /DB_GATE_DENY: write keyword/, 'deny 文案与脚本通道同形，日志 grep 才能一处通吃');
});

// ---------- 壳的 CLI（退出码 = driver 码，探测项靠这个） ----------
test('shell --self-test 无参：定位到私有根并以退出码 0 报告来源', (t) => {
  if (!hasPy) return t.skip(`${PY} 不可用：只影响 MCP 通道探测，不判定失败`);
  const r = shellEnvelope(['--self-test']);
  assert.equal(r.status, 0, r.out + r.err);
  assert.equal(r.env.ok, true);
  assert.equal(r.env.meta.server, MCP_ID);
  assert.ok(['env', 'private-root.txt', 'tool-root-sibling'].includes(r.env.meta.rootVia),
    'rootVia 要说清是哪一级链命中的');
});

test('shell --self-test --project：MCP 槽位与 adapter 存在性可被探测（缺依赖也要显式失败）', (t) => {
  if (!hasPy) return t.skip(`${PY} 不可用`);
  const r = shellEnvelope(['--self-test', '--project', 'example-proj']);
  if (!hasYaml) {
    // 弱解析会把"读不到白名单"变成"白名单为空"，那是放行；必须炸得看得懂
    assert.equal(r.status, 1);
    assert.match(JSON.stringify(r.env), /requirements\.txt/);
    return;
  }
  assert.equal(r.status, 0, JSON.stringify(r.env));
  assert.equal(r.env.ok, true);
  assert.equal(r.env.meta.adapterPresent, false, '本仓库不携带公司专有 adapter');
  assert.equal(r.env.meta.mcpSlots, 0, 'example-proj 当前全部走 script 通道');
});

test('shell --query：source 不在 mcp.sources 白名单 → 退出码 2 并指回 script 通道', (t) => {
  if (!hasPy || !hasYaml) return t.skip('需要 python + PyYAML 才能读注册文件');
  const r = shellEnvelope(['--query', '--project', 'example-proj', '--source', 'anything', '--params', '{}']);
  assert.equal(r.status, 2, JSON.stringify(r.env));
  assert.match(r.env.error.message, /白名单/);
  assert.match(r.env.error.detail, /script 通道/);
});

test('壳的 stdout 是 UTF-8：中文诊断能被 Node 正确解码', (t) => {
  if (!hasPy) return t.skip(`${PY} 不可用`);
  // Windows 上 CPython 默认按控制台代码页（cp936）编码 stdout，而 IDE/Node 按 UTF-8 解码。
  // 不显式 reconfigure，这里拿到的就是一串乱码 —— 报错文本读不懂等于没报错。
  const r = shellEnvelope(['--query', '--project', 'no-such-code', '--source', 'x', '--params', '{}']);
  assert.equal(r.status, 1);
  assert.match(r.env.error.message, /[\u4e00-\u9fff]/, '中文未被正确解码：' + r.env.error.message);
});

// ---------- 谁可以绑壳 server（R3.5：跑 driver 必须派子 agent） ----------
const MCP_BOUND_AGENTS = [
  'bug-analyzer.md', 'bug-test-writer.md', 'bug-tester.md', 'prelearn-analyzer.md',
];

function frontmatterOf(file) {
  const m = read(file).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : '';
}

function agentsWithMcp(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).filter((n) => n.endsWith('.md'))
    .filter((n) => /^mcpServers:[ \t]*\r?\n(?:[ \t]*-[ \t]*\S+[\r\n?]*)+/m.test(frontmatterOf(path.join(dir, n))))
    .sort();
}

test('只有名单内的子 agent 绑壳 server，其余 agent 一律不绑', () => {
  assert.deepEqual(agentsWithMcp(path.join(ROOT, 'agents')), MCP_BOUND_AGENTS.slice().sort(),
    '绑宽了 = 取数能力回到主 agent（绕过窄 bash 白名单）；绑漏了 = 该子 agent 走不到 mcp 通道');
  const distAgents = agentsWithMcp(path.join(DIST, 'agents'));
  assert.deepEqual(distAgents, MCP_BOUND_AGENTS.slice().sort(), 'dist 与源不一致，先跑 node scripts/sync-assets.mjs');
  // 绑的 id 必须是 sync 烤进 .mcp.json 的那个；写错 id = frontmatter 合法但 server 找不到，静默失效
  for (const n of MCP_BOUND_AGENTS) {
    const fm = frontmatterOf(path.join(ROOT, 'agents', n));
    const block = fm.match(/^mcpServers:[ \t]*\r?\n((?:[ \t]*-[ \t]*\S+\r?\n?)+)/m);
    const ids = block ? [...block[1].matchAll(/-[ \t]*(\S+)/g)].map((x) => x[1]) : [];
    assert.deepEqual(ids, [MCP_ID], n + ' 绑的 server id 与 dist/.mcp.json 不一致');
  }
});

test('主 agent 入口（commands/）绝不绑 mcpServers：分流依据只能是脚本退出码', () => {
  for (const dir of [path.join(ROOT, 'commands'), path.join(DIST, 'commands')]) {
    if (!fs.existsSync(dir)) continue;
    for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      assert.doesNotMatch(read(path.join(dir, n)), /^mcpServers:/m, 'commands/' + n + ' 绑了 MCP');
    }
  }
});

// ---------- 信封离线校验（两通道同一份契约，不碰任何后端） ----------
const FIXTURE_ROOT = path.join(ROOT, 'tests', 'fixtures', 'priv-mcp');
const DRIVER = path.join(ROOT, 'drivers-skeleton', 'example_json_driver.py');

function runDriver(args) {
  const r = spawnSync(PY, [DRIVER, ...args], {
    encoding: 'utf8', cwd: ROOT,
    env: { ...process.env, SUPPERH_PRIVATE_ROOT: FIXTURE_ROOT },
  });
  const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.trim().startsWith('{'));
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''),
           env: line ? JSON.parse(line) : null };
}

test('示例驱动（script 通道）的成功信封逐个字段符合契约文件', (t) => {
  if (!hasPy) return t.skip(`${PY} 不可用`);
  const { doc } = readDriverSchema();
  const r = runDriver(['--project', 'fx-mcp', '--source', 'demo', '--limit', '2']);
  assert.equal(r.status, 0, r.out + r.err);
  assert.deepEqual(schemaProblems(doc, r.env), [], '实现与契约文件形状已不一致');
  assert.equal(r.env.meta.project, 'fx-mcp', '信封要说清是为哪个项目取的（多项目串包防线）');
  assert.equal(r.env.meta.count, 2);
  assert.equal(r.env.meta.truncated, true, '命中 limit 必须如实回填 truncated，上层负责提醒“结果被截”');
  assert.equal(r.env.data.rows.length, 2);
  assert.equal(r.env.data.columns.length, r.env.data.rows[0].length, 'columns 与 rows 必须等长同序');
});

test('失败信封也符合契约，且 error.code 就是进程退出码', (t) => {
  if (!hasPy) return t.skip(`${PY} 不可用`);
  const { doc } = readDriverSchema();
  const r = runDriver(['--project', 'fx-mcp', '--source', 'no-such-source']);
  assert.equal(r.status, 2, r.out + r.err);
  assert.deepEqual(schemaProblems(doc, r.env), [], '失败形状漂移比成功更难查（消费方走的是降级分支）');
  assert.equal(r.env.ok, false);
  assert.equal(r.env.error.code, r.status, 'error.code 与退出码不一致 = 同一个失败在不同通道两个码，模型拿到矛盾指令');
});

test('两条通道的 ok 信封键集完全相同（同构是“上层只写一份解析”的前提）', (t) => {
  if (!hasPy) return t.skip(`${PY} 不可用`);
  const { doc } = readDriverSchema();
  const script = runDriver(['--project', 'fx-mcp', '--source', 'users']).env;
  const mcp = shellEnvelope(
    ['--query', '--project', 'fx-mcp', '--source', 'app_logs', '--params', '{}'],
    { SUPPERH_PRIVATE_ROOT: FIXTURE_ROOT },
  ).env;
  assert.ok(mcp, '壳未返回信封（进不了同构比对）');
  assert.deepEqual(schemaProblems(doc, mcp), [], 'MCP 信封不合规');
  assert.deepEqual(Object.keys(script).sort(), Object.keys(mcp).sort(), '顶层字段集已分叉');
  // meta 只比契约声明过的键：驱动自带的附加键（script 侧 datasetFile/totalMatches、
  // mcp 侧 rootVia/server/slot）是各自通道的诊断信息，允许不同；
  // 但契约点过名的字段一边缺一边有 = 上层只写一份解析时就会读到 undefined。
  const declared = Object.keys(doc.properties.meta.properties);
  const coreOf = (o) => declared.filter((k) => k in o).sort();
  assert.deepEqual(coreOf(script.meta), coreOf(mcp.meta), '契约声明的 meta 字段集已分叉');
  assert.deepEqual(Object.keys(script.data).sort(), Object.keys(mcp.data).sort(), 'data 字段集已分叉');
  assert.equal(mcp.meta.project, 'fx-mcp');
});

// ---------- 可复现性对（meta.query / meta.params / meta.queryOmitted） ----------
// 为什么单独锁：只输出答案而不输出产生答案的语句，审阅者无法区分“对的”与“恰好能对”，
// 而“驱动没报”与“本就没有语句”必须是两个可机械区分的状态——前者是驱动缺陷，后者是事实。
function pySnippet(code) {
  return spawnSync(PY, ['-c', code], { encoding: 'utf8', cwd: ROOT });
}
function omittedReasons() {
  const m = read(path.join(ROOT, 'mcp-skeleton', 'supperh_contract', 'envelope.py'))
    .match(/QUERY_OMITTED_REASONS\s*=\s*\(([\s\S]*?)\)/);
  return m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : null;
}

test('契约声明了语句三态，且 queryOmitted 枚举与 envelope.py 逐值相同', () => {
  const { doc } = readDriverSchema();
  const meta = doc.properties.meta.properties;
  for (const k of ['query', 'params', 'queryOmitted']) {
    assert.ok(meta[k], `契约未声明 meta.${k}：消费方读到它时没有任何文件说明它是什么`);
  }
  assert.deepEqual(meta.queryOmitted.enum, omittedReasons(),
    '枚举漂移：一侧改了另一侧没改，就会造出 query_state 认不出的“既非申报也非合法省略”状态');
  // 向后兼容铁律：新增字段不得让已注册项目突然全灭
  const required = doc.properties.meta.required || [];
  assert.ok(!required.includes('query'),
    'query 进 required 会让存量驱动一夜全红；强制靠 skills/data-fetch 的 query_missing 上报');
});

test('脚本通道：执行了什么就报什么，绑定值留在 params 里而不是塞进语句', (t) => {
  if (!hasPy) return t.skip(`${PY} 不可用`);
  const r = runDriver(['--project', 'fx-mcp', '--source', 'demo',
    '--filter', 'status=open', '--filter', 'id=1']);
  assert.equal(r.status, 0, r.out + r.err);
  assert.equal(r.env.meta.query, 'select * from demo where status = ? AND id = ?',
    '语句必须按实际生效顺序展开谓词，且保留占位符');
  assert.deepEqual(r.env.meta.params, { status: 'open', id: '1' });
  assert.ok(!('queryOmitted' in r.env.meta), '有语句又声明“没有语句” = 自相矛盾');
});

test('MCP 通道：adapter 能通过第三元自己申报语句（壳只能看到“我看不到”）', (t) => {
  if (!hasPy) return t.skip(`${PY} 不可用`);
  const r = shellEnvelope(
    ['--query', '--project', 'fx-mcp', '--source', 'app_logs', '--params', '{"id": 1}', '--limit', '1'],
    { SUPPERH_PRIVATE_ROOT: FIXTURE_ROOT },
  );
  assert.equal(r.status, 0, r.out + r.err);
  assert.equal(r.env.meta.query, 'select id, message from app_logs where id = ? limit 1');
  assert.deepEqual(r.env.meta.params, { id: 1 });
  assert.ok(!('queryOmitted' in r.env.meta));
});

test('本就没有语句的通道（--health / --dry-run / self-test）显式说 not_applicable，而不是留空', (t) => {
  if (!hasPy) return t.skip(`${PY} 不可用`);
  const h = runDriver(['--project', 'fx-mcp', '--source', 'demo', '--health']);
  assert.equal(h.status, 0, h.out + h.err);
  assert.equal(h.env.meta.queryOmitted, 'not_applicable',
    '留空会被上层当成 query_missing：健康探测被报成驱动缺陷，报假警比漏报更消耗信任');
  const d = runDriver(['--project', 'fx-mcp', '--source', 'demo', '--dry-run']);
  assert.equal(d.env.meta.queryOmitted, 'not_applicable');
  const s = shellEnvelope(['--self-test']);
  assert.equal(s.env.meta.queryOmitted, 'not_applicable');
});

test('query_state 把“申报 / 合法省略 / 没报”判成三态，矛盾与越界值归入第三态', (t) => {
  if (!hasPy) return t.skip(`${PY} 不可用`);
  const code = [
    'import json,sys',
    "sys.path.insert(0, 'mcp-skeleton')",
    'from supperh_contract import query_state',
    'cases = [',
    "  {'meta': {'query': 'select 1', 'params': [1]}},",
    "  {'meta': {'queryOmitted': 'not_applicable'}},",
    "  {'meta': {'query': '   '}},",
    "  {'meta': {}},",
    "  {'meta': {'query': 'select 1', 'queryOmitted': 'redacted'}},",
    "  {'meta': {'queryOmitted': 'I forgot'}},",
    '  None,',
    ']',
    'print(json.dumps([query_state(c) for c in cases], ensure_ascii=False))',
  ].join('\n');
  const r = pySnippet(code);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()).map((x) => x[0]),
    ['declared', 'omitted', 'missing', 'missing', 'missing', 'missing', 'missing'],
    '三态判定漂移：消费方就无法稳定地决定“该提醒用户还是该修驱动”');
});

test('两通道的语句三元参同名同序（query/params/queryOmitted 分叉 = 一份解析代码读不了另一边）', () => {
  // 按顶层逗号切分取形参名。已知限制：形参默认值里不得出现括号外的逗号（目前两侧都没有）；
  // 真出现时这条会报“解析不到函数”，而不是默默比错。
  // 不比整张签名：project / started_at 在脚本通道是模块全局（_PROJECT_CODE / _START_TS），
  // 同构的强制对象是“驱动输出什么”，不是“驱动怎么传参”——比错了会误导后人去改错的一侧。
  const sig = (src, name) => {
    const m = src.match(new RegExp('def ' + name + '\\(([\\s\\S]*?)\\)\\s*(?:->[^:]*)?:'));
    if (!m) return null;
    return m[1].split(',').map((p) => p.trim().split(/[\s:=]/)[0]).filter(Boolean);
  };
  const trio = (names) => names.filter((n) => n === 'query' || n === 'params' || n === 'query_omitted');
  const script = sig(read(path.join(ROOT, 'drivers-skeleton', 'base_driver.py')), 'emit_ok');
  const mcp = sig(read(path.join(ROOT, 'mcp-skeleton', 'supperh_contract', 'envelope.py')), 'ok_envelope');
  assert.ok(script && mcp, '签名解析失败（函数被改成单行式？回来同步这条断言）');
  assert.deepEqual(trio(script), ['query', 'params', 'query_omitted'],
    '语句字段从 emit_ok 签名里消失或改了位：脚本通道将重新无法申报 query');
  assert.deepEqual(trio(mcp), trio(script),
    '两条通道的语句参已分叉：一边能传、另一边传不进 = 静默能力差');
});
