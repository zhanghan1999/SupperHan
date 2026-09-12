// tests/l1-purity.test.mjs
// L1 纯度门禁：上传物里不得出现「注册条目里的项目专有值」与「本机绝对路径」。
//
// 为什么锁这条：本仓库的文档（drivers-skeleton/README.md、.qoder/rules/10-redlines.md R1）
// 一直宣称"sync 阶段的敏感字扫描会拦下"，而这条扫描此前**从未存在**。后果不是理论上的 ——
// 真实项目短码、真实包根、真实工作区路径曾经成片躺在 tests/ 夹具与 mcp-skeleton/README.md
// 的示例里，因为它们从没被任何机械判据看过一眼。
//
// 判据只能来自 L2 而不是写死的黑名单：把"某公司名"抄进 deny 列表，等于把该公司名再公开一遍。
// 于是这里比对的是「注册条目里有辨识度的值」+「本机三个专有路径」，二者都在运行期取值。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePrivateRoot } from '../scripts/resolve-private-root.mjs';
import { collectL2Facts, l1PurityProblems, checkL1Purity } from '../scripts/sync-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SYNC = path.join(ROOT, 'scripts', 'sync-assets.mjs');

const DOC = {
  identity: { code: 'acme', displayName: 'Acme Portal', aliases: ['acme-proj', 'ex', 'zz'] },
  packageRoot: 'com.acme.portal',
  codeRoot: 'C:\\ws\\acme-portal',
  modules: [{ name: 'order' }],
  branches: { prod: 'release-main', dev: 'develop' },
  db: {
    host: 'dw.acme-corp.cn',
    port: 5432,
    schemas: { prod: 'acme_prod', uat: 'acme_uat', test: 'acme_test' },
    readonlyUser: 'acme_ro',
    writableUser: 'acme_rw',
    forbidWriteSchemas: ['acme_prod', 'acme_uat'],
  },
};
const values = (facts) => facts.map((f) => f.value);

// ───────────────────────── 事实采集 ─────────────────────────

test('高信号 L2 字段进事实集：短码/显示名/包根/库名/账号/主机/代码根', () => {
  const v = values(collectL2Facts(DOC, 'acme.yaml'));
  for (const want of ['acme', 'Acme Portal', 'com.acme.portal', 'dw.acme-corp.cn',
    'acme_prod', 'acme_uat', 'acme_ro', 'acme_rw', 'C:\\ws\\acme-portal']) {
    assert.ok(v.includes(want), `${want} 应被当作项目专有事实`);
  }
});

test('通用形态的值不参与比对：模板自身与示例项目不该天天误报', () => {
  const tpl = collectL2Facts({
    identity: { code: 'example-proj', displayName: 'Example Java Project', aliases: ['example'] },
    packageRoot: 'com.example.proj',
    codeRoot: '/absolute/path/to/example-java-project',
    db: { schemas: { prod: 'example_prod' }, host: '<内网端点>' },
  }, 'example-proj.yaml');
  assert.deepEqual(tpl, [], 'example_* / <占位符> 一律不参与比对');
  // 短码太短（<=2）到处是巧合；模块名/分支名是高复用词，不进事实集
  assert.deepEqual(values(collectL2Facts(DOC, 'x').filter((f) => f.value === 'zz')), []);
  assert.ok(!values(collectL2Facts(DOC, 'x')).includes('order'));
  assert.ok(!values(collectL2Facts(DOC, 'x')).includes('release-main'));
});

// ───────────────────────── 命中判据 ─────────────────────────

const flat = (facts, text) => l1PurityProblems({ facts, files: [{ path: 'agents/x.md', text }] });

test('字面值命中不看分隔符：下划线/连字符/驼峰/大小写都得抓到', () => {
  const facts = [{ field: 'identity.code', value: 'acme', source: 'acme.yaml' }];
  for (const text of ['acme', '`acme-base` 模块', 'acme_order 表', 'ACME 门户', '路径 acme/src/main']) {
    assert.equal(flat(facts, text).length, 1, `应命中：${text}`);
  }
  // 前后是字母数字 = 属于更长的标识符，不算命中（避免 examples/README 之类的巧合）
  assert.equal(flat(facts, 'for example, an acmeoid word').length, 0);
  assert.equal(flat(facts, 'nothing here').length, 0);
});

test('绝对路径的两种斜杠写法同判：C:\\a\\b 与 C:/a/b 是一回事', () => {
  const facts = [{ field: 'codeRoot', value: 'C:\\ws\\acme-portal', source: 'acme.yaml' }];
  assert.equal(flat(facts, 'impl: "C:\\\\ws\\\\acme-portal\\\\db.py"').length, 1, 'JS 字面量里的双反斜杠');
  assert.equal(flat(facts, 'codeRoot: C:/ws/acme-portal').length, 1, '正斜杠写法');
  assert.equal(flat(facts, 'codeRoot: c:\\ws\\ACME-PORTAL').length, 1, '大小写不同');
});

test('本机路径泄漏独立于注册条目：私有根/仓库父目录/家目录都算', () => {
  const leakPaths = [{ label: '家目录', abs: 'C:\\Users\\acme' }];
  const r = l1PurityProblems({ leakPaths, files: [{ path: 'docs/a.md', text: '跑 C:/Users/acme/x.mjs' }] });
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'local-path');
  assert.equal(r[0].field, '家目录');
});

test('--allow-l1-fact 放行确实撞车的值，其它违规照旧', () => {
  const facts = [
    { field: 'identity.code', value: 'acme', source: 'acme.yaml' },
    { field: 'packageRoot', value: 'org.foo.bar', source: 'acme.yaml' },
  ];
  const files = [{ path: 'skills/s.md', text: 'acme 与 org.foo.bar 都在' }];
  assert.equal(l1PurityProblems({ facts, files }).length, 2);
  assert.equal(l1PurityProblems({ facts, files, allow: ['acme'] }).length, 1);
});

// ───────────────────────── 真仓库 + CLI 接线 ─────────────────────────

test('当前仓库干净：真注册表 + 真上传物零违规（上传前的最后一道判据）', () => {
  const info = resolvePrivateRoot();
  if (!info.privateRootExists) return;                // 新克隆没有私有根：sync 自身会退 2，这里不判
  const problems = checkL1Purity(ROOT, info);
  assert.deepEqual(problems.map((p) => `${p.file}:${p.line} ${p.field}=${p.value}`), []);
});

/** 临时私有根：只放一份条目，用于断言 --check 真的会因泄漏而阻断。 */
function tempPrivateRoot(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-purity-'));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', `${code}.yaml`),
    `schemaVersion: 1\nidentity:\n  workspaces: ["${code}"]\n  code: ${code}\n`
    + `  displayName: "${code} sample"\ncodeRoot: /tmp/${code}\npackageRoot: com.${code}.app\n`, 'utf8');
  return dir;
}
function runCheck(extraArgs, priv) {
  return spawnSync(process.execPath, [SYNC, '--check', ...extraArgs], {
    encoding: 'utf8', cwd: ROOT, env: { ...process.env, SUPPERH_PRIVATE_ROOT: priv },
  });
}

// 取一个 L1 里本来就存在的词当"项目短码"，从而无需为了造泄漏而改仓库文件。
test('注册条目的短码出现在上传物里 → sync --check 退 5 并点名字段与位置', () => {
  const priv = tempPrivateRoot('supperh');
  try {
    const r = runCheck([], priv);
    assert.equal(r.status, 5, `应退 5，实退 ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /L1 纯度违规/);
    assert.match(r.stderr, /identity\.code/);
    assert.match(r.stderr, /supperh/);
  } finally { fs.rmSync(priv, { recursive: true, force: true }); }
});

test('--allow-l1-fact 放行后不再退 5（放行是显式决定，不是静默降级）', () => {
  const priv = tempPrivateRoot('supperh');
  try {
    const r = runCheck(['--allow-l1-fact', 'supperh'], priv);
    assert.notEqual(r.status, 5, `不该再以纯度阻断：\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /L1 纯度违规/);
  } finally { fs.rmSync(priv, { recursive: true, force: true }); }
});

test('--allow-l1-fact 缺值 → 用法错误退 2，不当成"没请求"放行', () => {
  const priv = tempPrivateRoot('supperh');
  try {
    const r = runCheck(['--allow-l1-fact'], priv);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /用法错误/);
  } finally { fs.rmSync(priv, { recursive: true, force: true }); }
});
