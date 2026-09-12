// tests/fastpath-gate.test.mjs
// 快路径门禁决策表回归。headCommit 一律显式注入，不依赖测试环境是否有 git 历史。
import { test } from 'node:test';
import assert  from 'node:assert/strict';
import fs      from 'node:fs';
import os      from 'node:os';
import path    from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  classifyAnchor, parseIndexMarkdown, matchRows, scanVeto, evaluateFastPath, commitMatches,
  verifyImpactReport, IMPACT_CODES, EVIDENCE_KINDS, DEFAULTS, HARD_CAPS, EXIT, INDEX_SCHEMA,
  parseSourcesCell, diffNameOnly, verifyIntent, INTENT_ABSENT
} from '../scripts/fastpath-gate.mjs';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// 反查表标准七列（/2 代际）。`sources` = 该 batch 调用链可达文件全集，G4b 拿它与
// git diff 求交集。同一 batch 的行写同一值（契约规定）。
const SRC01 = 'src/main/java/com/x/OrderController.java;src/main/java/com/x/OrderServiceImpl.java';
const SRC02 = 'src/main/java/com/x/LegacyController.java;src/main/java/com/x/NoteController.java';

/** 规范格式 index.md：一张反查表，等级可控 */
function indexDoc({ commit = HEAD, rows = null, kind = 'code', extra = '' } = {}) {
  const body = rows ?? [
    `| POST /api/v1/order/create | OrderController | create | batch-01.md | 40-88 | L3 | ${SRC01} |`,
    `| GET /api/v1/order/detail | OrderController | detail | batch-01.md | 90-120 | L3 | ${SRC01} |`,
    `| POST /api/v1/order/detail | OrderController | detail | batch-01.md | 122-160 | L3 | ${SRC01} |`,
    `| GET /api/v1/order/legacy | LegacyController | legacy | batch-02.md | 10-30 | L1 | ${SRC02} |`,
    `| GET /api/v1/order/note | NoteController | note | batch-02.md | - | L2 | ${SRC02} |`
  ];
  return [
    '---',
    `schema: ${INDEX_SCHEMA}`,
    'module: order',
    `kind: ${kind}`,
    'learnedAt: 2026-09-10T08:30:00+08:00',
    `learnedAtCommit: ${commit}`,
    'controllers: 5',
    'coveredControllers: 5',
    '---',
    '',
    '## route 反查表',
    '',
    '| route | controller | method | batch | lines | level | sources |',
    '|---|---|---|---|---|---|---|',
    ...body,
    '',
    extra
  ].join('\n');
}

/** 造一个最小 context 根：<root>/order/CURRENT + <root>/order/<gen>/index.md */
function makeContext(text, { gen = 'gen-20260101120000', withCurrent = true, withIndex = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-ctx-'));
  const modDir = path.join(dir, 'order');
  fs.mkdirSync(path.join(modDir, gen), { recursive: true });
  if (withCurrent) fs.writeFileSync(path.join(modDir, 'CURRENT'), gen + '\n', 'utf8');
  if (withIndex) fs.writeFileSync(path.join(modDir, gen, 'index.md'), text, 'utf8');
  return { contextRoot: dir, module: 'order', genDir: path.join(modDir, gen) };
}

/**
 * 由夹具文本自动派生一份**合规** intent 复述。
 *
 * 为何自动派生而不是逐例手写：I0 是门禁必需入参，而几十个既有用例的断言目标是
 * G0–G5——让它们各手写一遇 intent 只会把噪音摊到每一行。派生规则故意“取巧”：
 * 把描述按逗号/句号切开，含锚点的那句当 actual（症状），另一句当 expected（期望），
 * 两句原样登记为引用。这正是 I0 期望真实输入长成的样子（一句症状 + 一句期望）。
 *
 * 复述文本故意加了“实际：/期望：”前缀，与引用片段不相等：这样才会真正考到
 * “引用是拿到用户原话里验的”，而不是拿槽位自比。
 *
 * 要构造“欠定义”形态的用例（编造引用 / 整段拄 / 槽位空…）一律显式传 intent 覆盖。
 */
function intentOf(text, anchor) {
  const clauses = String(text).split(/[，,。;；]/).map((s) => s.trim()).filter(Boolean);
  const a = anchor ? String(anchor) : '';
  const actual = clauses.find((c) => a && c.includes(a)) ?? clauses[0] ?? '';
  const expected = clauses.find((c) => c !== actual) ?? '';
  const quotable = (s) => (s.length >= 8 ? [s] : []);
  return {
    expected: expected ? `期望：${expected}` : '',
    actual: actual ? `实际：${actual}` : '',
    repro: INTENT_ABSENT,
    quotes: { expected: quotable(expected), actual: quotable(actual) }
  };
}

function gate(ctx, anchor, text = '', headCommit = HEAD, extra = {}) {
  const base = { contextRoot: ctx.contextRoot, module: ctx.module, anchor, text, headCommit, ...extra };
  // 给了 text 就自动补一份合规 intent，让既有 G0–G5 用例不必各自关心 I0。
  // text 为空时**故意不补**——那些用例要验的是“缺描述 → 36”那条三态纪律。
  if (text && text.trim() && !('intent' in base)) base.intent = intentOf(text, anchor);
  return evaluateFastPath(base);
}

test('classifyAnchor：三类一期可用锚点 + 两类明确不支持', () => {
  assert.equal(classifyAnchor('POST /api/v1/order/create').kind, 'route');
  assert.equal(classifyAnchor('  post /api/x  ').value, 'POST /api/x', 'method 应大写化并折叠空白');
  assert.equal(classifyAnchor('com.x.OrderController#create').kind, 'fqn');
  assert.equal(classifyAnchor('OrderController#create').method, 'create');
  assert.equal(classifyAnchor('OrderController.java:88').kind, 'fileLine');
  assert.equal(classifyAnchor('OrderController.java:88').line, 88);
  assert.equal(classifyAnchor('trace_id=abcdef1234567890').supported, false, 'traceId 不含代码位置，不可直用');
  assert.equal(classifyAnchor('trace_id=abcdef1234567890').kind, 'traceId', '但仍应被识别');
  assert.equal(classifyAnchor('trace_id=abcdef1234567890').needsLookup, true, '需递出反查信号');
  assert.equal(classifyAnchor('工单号 task-1024').kind, 'ticketNo');
  assert.equal(classifyAnchor('工单号 task-1024').needsLookup, true);
  assert.equal(classifyAnchor('工单号 task-1024').supported, false);
  assert.equal(classifyAnchor('abc123def456').needsLookup, undefined, '无标签随机串不得乱认成 traceId');
  assert.equal(classifyAnchor('').supported, false);
});

test('parseIndexMarkdown：frontmatter + 首张 route 表 + 等级缺省保守降为 L1', () => {
  const p = parseIndexMarkdown(indexDoc());
  assert.equal(p.frontmatter.learnedAtCommit, HEAD);
  assert.equal(p.rows.length, 5);
  assert.equal(p.rows[0].level, 'L3');
  assert.equal(p.rows[0].batch, 'batch-01.md');
  assert.equal(p.rows[0].sources.usable, true, 'sources 列必须解出可用集');
  assert.deepEqual(p.rows[0].sources.files,
    ['src/main/java/com/x/OrderController.java', 'src/main/java/com/x/OrderServiceImpl.java'],
    '; 分隔、无空格、保序');

  const sloppy = parseIndexMarkdown(indexDoc({
    rows: [
      `| GET /a | A | a | batch-01.md | 1-2 | l2 | ${SRC01} |`,
      '| GET /b | B | b | batch-01.md | 1-2 |  | - |'
    ]
  }));
  assert.equal(sloppy.rows[0].level, 'L2', '小写 l2 应规范化');
  assert.equal(sloppy.rows[1].level, 'L1', 'level 留空一律按 L1（宁可判浅）');
  assert.equal(sloppy.rows[1].sources.usable, false, '`-` 占位 = 不可用（G4b 据此 fail-closed）');

  assert.equal(parseIndexMarkdown('# 只有散文没有表').rows.length, 0);
  assert.throws(() => parseIndexMarkdown('---\nschema: x\n未闭合'), /frontmatter/);

  // commit 字面值守护：YAML 会把纯数字 SHA 推定为 number，前导零丢失 = 静默判过期
  const zeros = '0000000000000000000000000000000000000000';
  assert.equal(parseIndexMarkdown(indexDoc({ commit: zeros })).learnedAtCommit, zeros, '全零 SHA 不得变成数字 0');
  assert.equal(parseIndexMarkdown(indexDoc({ commit: '0012345' })).learnedAtCommit, '0012345', '短零前缀 commit 不得丢前导零');
  assert.equal(parseIndexMarkdown(indexDoc({ commit: '"0a1b2c3"' })).learnedAtCommit, '0a1b2c3', '已加引号时剥引号');
  assert.equal(parseIndexMarkdown(indexDoc({ commit: '' })).learnedAtCommit, null);
});

test('G4：全零 SHA 与实际 HEAD 可比对（回归 YAML number 推定缺陷）', () => {
  const zeros = '0'.repeat(40);
  const ctx = makeContext(indexDoc({ commit: zeros }));
  const T = 'POST /api/v1/order/create 返回的创建人字段为空，期望返回创建人姓名';
  assert.equal(gate(ctx, 'POST /api/v1/order/create', T, zeros).status, EXIT.PASS, '字面相等应放行，不能因类型推定误判过期');
  assert.equal(gate(ctx, 'POST /api/v1/order/create', T, '1' + zeros.slice(1)).status, EXIT.STALE);
});

test('matchRows：route 全等 / 仅 path 匹配多变体 / fqn 末段 / 行号区间', () => {
  const { rows } = parseIndexMarkdown(indexDoc());
  assert.equal(matchRows(rows, classifyAnchor('POST /api/v1/order/create')).length, 1);
  assert.equal(matchRows(rows, classifyAnchor('GET /api/v1/order/detail')).length, 1);
  assert.equal(matchRows(rows, classifyAnchor('/api/v1/order/detail')).length, 2, '同 path 多 method 应全命中→歧义');
  assert.equal(matchRows(rows, classifyAnchor('OrderController#create')).length, 1, '按类末段 + method 反查');
  assert.equal(matchRows(rows, classifyAnchor('com.x.order.controller.OrderController#create')).length, 1, '全限定名同样命中');
  assert.equal(matchRows(rows, classifyAnchor('POST /api/v1/none')).length, 0);
  assert.equal(matchRows(rows, classifyAnchor('OrderController.java:50')).length, 1, '50 落在 40-88');
  assert.equal(matchRows(rows, classifyAnchor('OrderController.java:200')).length, 0, '200 越界');
  assert.equal(matchRows(rows, classifyAnchor('NoteController.java:999')).length, 1, 'lines 为 - 时视为可用');
});

test('scanVeto：命中面覆盖三类，且典型快路径描述不误伤', () => {
  assert.ok(scanVeto('接口偶发超时').length >= 1);
  assert.ok(scanVeto('需要调整事务边界').length >= 1);
  assert.ok(scanVeto('改一下 pom.xml 升个版本').length >= 1);
  assert.ok(scanVeto('帮忙刷数据').length >= 1);
  assert.ok(scanVeto('update the creator column').length >= 1);
  assert.equal(scanVeto('订单创建接口返回的创建人字段为空').length, 0, '典型快路径样本不得被否决');
  assert.equal(scanVeto('').length, 0);
});

test('G1–G4 + 否决表：退出码逐项命中', () => {
  const ok = makeContext(indexDoc());
  const pass = gate(ok, 'POST /api/v1/order/create', 'POST /api/v1/order/create 接口返回的创建人字段为空，期望返回创建人姓名');
  assert.equal(pass.status, EXIT.PASS);
  assert.equal(pass.eligible, true);
  assert.equal(pass.gates.G1_unique, 'pass');
  assert.equal(pass.gates.G5_impact, 'pending_agent', 'P0 不求值 G5');
  assert.equal(pass.anchorResolved.batch, 'batch-01.md');
  assert.deepEqual(pass.budget, { maxDiffLines: 40, maxFiles: 2, hardCaps: { maxDiffLines: 80, maxFiles: 4 } });

  // 注意：这里必须给真实描述。不传 --text 时否决表无法求值，只能保守出局。
  assert.equal(gate(ok, 'GET /api/v1/order/detail', 'GET /api/v1/order/detail 返回体缺少字段，期望返回全部字段').status, EXIT.PASS);
  assert.equal(gate(ok, '/api/v1/order/detail', '详情接口字段为空').status, EXIT.AMBIGUOUS, '多命中 31');
  assert.equal(gate(ok, 'POST /api/v1/order/nope').status, EXIT.NO_ROUTE, '零命中 30');
  const lookup = gate(ok, 'trace_id=abcdef1234567890', '创建人字段为空');
  assert.equal(lookup.status, EXIT.NO_ROUTE, 'traceId 未经反查直接进门禁 → 30');
  assert.equal(lookup.needsLookup, true, '应递出 needsLookup 信号供 F1.4 取用');
  assert.equal(gate(ok, 'GET /api/v1/order/legacy', '字段没返回').status, EXIT.SHALLOW, 'L1 不足 34');
  assert.equal(gate(ok, 'GET /api/v1/order/note', '字段没返回').status, EXIT.SHALLOW, 'L2 不足 34');
  assert.equal(gate(ok, 'POST /api/v1/order/create', '订单创建接口偶发超时').status, EXIT.VETO, '否决词 33');
  // 下面三条都是“无法按 batch 复核”的形态：未给 effectiveRoot → diff 取不到 → 保守 35。
  // 真正的 G4b 放行/拦截行为在「G4b 批量级新鲜度」那一组用例里用真 git 仓验证。
  assert.equal(gate(ok, 'POST /api/v1/order/create', '', OTHER).status, EXIT.STALE, 'commit 不一致且 diff 不可得 35');
  assert.equal(gate(ok, 'POST /api/v1/order/create', '', null).status, EXIT.STALE, 'HEAD 取不到 35（保守）');

  const noCommit = makeContext(indexDoc({ commit: '' }));
  assert.equal(gate(noCommit, 'POST /api/v1/order/create').status, EXIT.STALE, '缺 learnedAtCommit 35');
  assert.equal(noCommit && gate(noCommit, 'POST /api/v1/order/create').gates.G2_dataReady, 'pass', 'G2 仍应通过');
});

test('G2 数据就绪：CURRENT / index.md / 格式漂移 / menu 分区 一律 32', () => {
  assert.equal(gate(makeContext(indexDoc(), { withCurrent: false }), 'POST /api/v1/order/create').status, EXIT.NO_INDEX);
  assert.equal(gate(makeContext(indexDoc(), { withIndex: false }), 'POST /api/v1/order/create').status, EXIT.NO_INDEX);
  assert.equal(gate(makeContext('散文，无表'), 'POST /api/v1/order/create').status, EXIT.NO_INDEX);
  assert.equal(gate(makeContext(indexDoc({ kind: 'menu' })), 'POST /api/v1/order/create').status, EXIT.NO_INDEX, 'menu 分区不参与快路径');
  // 缺 module 是调用方入参不成对，不是"数据未就绪"：单独给 36，两者在 jsonl 里不得混淆
  assert.equal(gate(ok0(), 'POST /api/v1/order/create', '', HEAD, { module: undefined }).status,
    EXIT.INCOMPLETE, '缺 module 入参 → 36（门禁无法求值）');
});

test('反查表重复 route 判为歧义而非首个命中', () => {
  const dup = makeContext(indexDoc({
    rows: [
      `| POST /api/v1/order/create | OrderController | create | batch-01.md | 40-88 | L3 | ${SRC01} |`,
      `| POST /api/v1/order/create | OrderController | createV2 | batch-02.md | 1-9 | L3 | ${SRC02} |`
    ]
  }));
  const r = gate(dup, 'POST /api/v1/order/create');
  assert.equal(r.status, EXIT.AMBIGUOUS);
  assert.equal(r.candidates.length, 2);
});

test('决策表：12 条真实形态输入的路径选择', () => {
  const ctx = makeContext(indexDoc());
  const CASES = [
    ['POST /api/v1/order/create + 创建人字段为空',                 'fast', ['POST /api/v1/order/create', 'POST /api/v1/order/create 创建人字段为空，期望返回创建人姓名']],
    ['POST /api/v1/order/create + 保存失败写库报错',                'full', ['POST /api/v1/order/create', '保存失败，报 insert 异常']],
    ['精确 path 但同 path 有 GET/POST 两实现',                     'full', ['/api/v1/order/detail', '详情接口字段为空']],
    ['文件行号锚点 OrderController.java:50 + 返回缺字段',           'fast', ['OrderController.java:50', 'OrderController.java:50 返回体缺少 createBy，期望返回 createBy 字段']],
    ['文件行号越界',                                              'full', ['OrderController.java:200', '返回体缺少 createBy']],
    ['全限定类#方法 + 校验注解缺失',                              'fast', ['com.x.OrderController#create', 'com.x.OrderController#create 未做非空校验，期望空值时返回参数校验错误']],
    ['L1 骨架方法（只签名）',                                     'full', ['GET /api/v1/order/legacy', '字段没返回']],
    ['带 method 前缀但表里没有该 route',                          'full', ['DELETE /api/v1/order/create', '删不掉']],
    ['trace_id 锚点（需反查，直用保守出局）',                        'full', ['trace_id=abcdef1234567890', '创建人为空']],
    ['异常栈文本（不含可解析锚点）',                              'full', ['NullPointerException at OrderService', '偶发']],
    ['描述含"偶发" → 非确定性否决',                               'full', ['POST /api/v1/order/create', '偶发返回空']],
    ['描述含"改 Mapper.xml" → 变更面否决',                        'full', ['POST /api/v1/order/create', '改 Mapper.xml 的 select 就行']]
  ];
  for (const [desc, expect, [anchor, text]] of CASES) {
    const r = gate(ctx, anchor, text);
    assert.equal(r.eligible ? 'fast' : 'full', expect, `${desc} → 期望 ${expect}，实际 status=${r.status} ${r.message}`);
  }
});

// ---------- 以下为 code-review 后的回归加固（F2–F10）----------

function ok0() { return makeContext(indexDoc()); }

test('F2：各路门禁全过但缺 --text → 36 保守出局，绝不返回 0', () => {
  const ctx = ok0();
  const r = evaluateFastPath({ contextRoot: ctx.contextRoot, module: 'order', anchor: 'POST /api/v1/order/create', headCommit: HEAD });
  assert.equal(r.status, EXIT.INCOMPLETE, '未给 text 时否决表没扫过，不得判为准入');
  assert.equal(r.eligible, false);
  assert.equal(r.gates.veto, 'skipped', '必须与"扫了且无命中"（pass）区分');
  assert.equal(r.gates.G3_depth, 'pass', '其余门禁结果仍应如实给出');
  assert.ok(r.anchorResolved, '36 仍可带 anchorResolved，供完整路径复用');
  // 空白串等于没给
  const blank = evaluateFastPath({ contextRoot: ctx.contextRoot, module: 'order', anchor: 'POST /api/v1/order/create', text: '   ', headCommit: HEAD });
  assert.equal(blank.status, EXIT.INCOMPLETE);
  // 但真实阻塞点优先于"缺 text"：过期时仍报 35，而不是把数据问题掩盖成调用问题
  const stale = gate(ctx, 'POST /api/v1/order/create', '   ', OTHER);
  assert.equal(stale.status, EXIT.STALE);
});

test('F4：frontmatter 行内注释与引号处理（污染 commit 串会造成该模块永久 35）', () => {
  const p = (v) => parseIndexMarkdown(indexDoc({ commit: v })).learnedAtCommit;
  assert.equal(p('abc123 # 固定值'), 'abc123', '行内注释必须剥除');
  assert.equal(p('"abc123" # 说明'), 'abc123', '剥注释 + 剥**成对**引号，不得只剩一边');
  assert.equal(p("'abc123'"), 'abc123');
  assert.equal(p('#abc123'), '#abc123', '# 前无空白不算注释，不得误剥');
  assert.equal(p('null'), null, 'YAML null 形态归空');
  assert.equal(p('~'), null);
  const g = makeContext(indexDoc({ commit: 'abc123 # writer 照抄了 SKILL.md 示例里的注释' }));
  assert.equal(gate(g, 'POST /api/v1/order/create', 'POST /api/v1/order/create 字段为空，期望返回创建人姓名', 'abc123').status, EXIT.PASS,
    '带注释的 frontmatter 不得被误判为过期');
});

test('F5/F6：表格行尾竖线可选（省略时不得抛异常也不得静默降 L1）', () => {
  const HDR = '| route | controller | method | batch | lines | level | sources |';
  const ROW = `| POST /api/v1/order/create | OrderController | create | batch-01.md | 40-88 | L3 | ${SRC01} |`;
  const doc = (hdr, row) => [
    '---', `schema: ${INDEX_SCHEMA}`, 'module: order', 'kind: code', `learnedAtCommit: ${HEAD}`, '---', '',
    hdr, '|---|---|---|---|---|---|---|', row, ''
  ].join('\n');

  const withPipe = parseIndexMarkdown(doc(HDR, ROW));
  assert.equal(withPipe.rows.length, 1);
  assert.equal(withPipe.rows[0].level, 'L3');

  const noPipeHdr = parseIndexMarkdown(doc('| route | controller | method | batch | lines | level | sources', ROW));
  assert.equal(noPipeHdr.rows.length, 1, '表头缺行尾竖线仍可解析');
  assert.equal(noPipeHdr.rows[0].level, 'L3', 'level 列不得被吃掉');

  const noPipeRow = parseIndexMarkdown(doc(HDR, `| POST /api/v1/order/create | OrderController | create | batch-01.md | 40-88 | L3 | ${SRC01}`));
  assert.equal(noPipeRow.rows.length, 1);
  assert.equal(noPipeRow.rows[0].level, 'L3', '数据行缺行尾竖线不得抛异常也不得降 L1');

  const bold = parseIndexMarkdown(doc('| **route** | **controller** | **method** | **batch** | **lines** | **level** | **sources** |', ROW));
  assert.equal(bold.rows.length, 1, '加粗表头应能识别');
  assert.equal(bold.rows[0].level, 'L3');

  const shuffled = parseIndexMarkdown(doc('| route | level | sources | controller | method | batch | lines |',
    `| POST /api/v1/order/create | L3 | ${SRC01} | OrderController | create | batch-01.md | 40-88 |`));
  assert.equal(shuffled.rows[0].level, 'L3', '按列名取值：除首列外列序无关');
  assert.equal(shuffled.rows[0].sources.usable, true, '列序打乱后 sources 仍按列名取到');

  // 契约规定表头**以 route 开头**（SKILL.md：第一个以 `| route |` 开头的表即反查表）；
  // route 不在首列时不认这张表 → 落 32，而不是去抓一张看着像的其它表。
  const routeNotFirst = parseIndexMarkdown(doc('| level | route | controller | method | batch | lines | sources |',
    `| L3 | POST /api/v1/order/create | OrderController | create | batch-01.md | 40-88 | ${SRC01} |`));
  assert.equal(routeNotFirst.rows.length, 0);
  assert.match(routeNotFirst.drift, /未找到/);
  assert.equal(gate(makeContext(doc('| level | route | controller | method | batch | lines | sources |',
    `| L3 | POST /api/v1/order/create | OrderController | create | batch-01.md | 40-88 | ${SRC01} |`)),
    'POST /api/v1/order/create', '字段为空').status, EXIT.NO_INDEX);

  // 必需列缺失 = 格式漂移 → 32，而不是"静默把 level 当 L1"然后判 34
  const noLevel = parseIndexMarkdown(doc('| route | controller | method | batch | lines |',
    '| POST /api/v1/order/create | OrderController | create | batch-01.md | 40-88 |'));
  assert.deepEqual(noLevel.missingCols, ['level', 'sources']);
  assert.match(noLevel.drift, /缺列/);
  assert.equal(gate(makeContext(doc('| route | controller | method | batch | lines |',
    '| POST /api/v1/order/create | OrderController | create | batch-01.md | 40-88 |')),
    'POST /api/v1/order/create', '字段为空').status, EXIT.NO_INDEX, '缺列必须落 32 而非 34');

  // **只缺 sources 一列**也必须 32：不得"其它列齐了就尽力解析"。缺了它 G4b 无从求交集，
  // 当成"没依赖"就是总放行（漏杀），当成"有依赖"就是整模块永久 35（误杀）——两边都是坑。
  const noSources = parseIndexMarkdown(doc('| route | controller | method | batch | lines | level |', ROW));
  assert.deepEqual(noSources.missingCols, ['sources']);
  assert.equal(noSources.rows.length, 0, '缺 sources 列不得解出任何行');
  assert.equal(gate(makeContext(doc('| route | controller | method | batch | lines | level |', ROW)),
    'POST /api/v1/order/create', '字段为空').status, EXIT.NO_INDEX, '缺 sources 列 → 32，不是 35 也不是 0');
});

test('F7：写库词表覆盖 MyBatis 驼峰方法名（\\bdelete\\b 在 deleteById 里边界不成立）', () => {
  for (const s of [
    'orderMapper.deleteById 调用后数据仍在', 'insertSelective 报主键冲突',
    'updateById 没有更新 create_time', 'saveOrUpdate 重复插入两条', 'batchInsert 条数不对'
  ]) assert.ok(scanVeto(s).length >= 1, `应命中否决：${s}`);
  assert.ok(scanVeto('列表查询很慢要 8 秒').length >= 1, 'perf 应覆盖“很慢”');
  assert.ok(scanVeto('需要加索引').length >= 1, 'migration 应覆盖“加索引”');
  assert.ok(scanVeto('Spring Security 配置问题').length >= 1, 'security 应允许空格/连字符');
  assert.ok(scanVeto('ＴＲＡＮＳＡＣＴＩＯＮ 未提交').length >= 1, 'NFKC 应盖住全角');
  // 典型快路径样本仍不得被误伤
  for (const s of ['订单创建接口返回的创建人字段为空', '返回体缺少 createBy', '详情接口日期格式不对']) {
    assert.equal(scanVeto(s).length, 0, `不应误伤：${s}`);
  }
});

test('F8：短路出局时 jsonl 仍拿到真实 veto 命中面（否则词表命中率被系统性低估）', () => {
  const g = makeContext(indexDoc({ commit: OTHER }));
  const r = gate(g, 'POST /api/v1/order/create', '接口偶发超时');
  assert.equal(r.status, EXIT.STALE, 'G4 仍先于否决表短路');
  assert.ok(r.veto.some((v) => v.id === 'nondeterministic'), '但否决命中必须如实记账');
  assert.equal(r.gates.veto, undefined, 'veto 未被求值，不得写成 pass 骗人');
});

test('F10：schema 代际不符或缺失 → 32（SKILL.md 声称解析器据此判代际）', () => {
  const swap = (s) => indexDoc().replace(`schema: ${INDEX_SCHEMA}`, s);
  const T = 'POST /api/v1/order/create 字段为空，期望返回创建人姓名';
  assert.equal(gate(makeContext(swap('schema: supperh-index/3')), 'POST /api/v1/order/create', T).status, EXIT.NO_INDEX, '未来代际不得被当作可读');
  // /1 是“仓库粒度 G4”那一代：没有 sources 列，读到也不能判 G4b → 必须先重学。
  // 这条断言同时是“别拿旧代际将就”的护栏：有人想向后兼容时会先撞它。
  assert.equal(gate(makeContext(swap('schema: supperh-index/1')), 'POST /api/v1/order/create', T).status, EXIT.NO_INDEX, '上一代（无 sources 列）→ 32 重学');
  assert.equal(gate(makeContext(swap('schema: ""')), 'POST /api/v1/order/create', T).status, EXIT.NO_INDEX);
  assert.equal(gate(makeContext(indexDoc()), 'POST /api/v1/order/create', T).status, EXIT.PASS, '当代代际正常放行');
});

test('commitMatches：前缀匹配有 7 位下限，畸形短串不能骗过新鲜度', () => {
  assert.equal(commitMatches(HEAD, HEAD), true);
  assert.equal(commitMatches(HEAD, HEAD.slice(0, 7)), true, 'git 短哈希惯例');
  assert.equal(commitMatches(HEAD, HEAD.slice(0, 3)), false, '<7 位前缀不接受');
  assert.equal(commitMatches('a', HEAD), false);
  assert.equal(commitMatches('', HEAD), false);
  assert.equal(commitMatches(null, HEAD), false);
});

// ---------- P1：fastPath L2 覆盖接线（limits / enabled / allowAnchorKinds）----------

test('P1-③ limits 只允许收紧：超硬上限被夹回，非法值回退默认', () => {
  const ctx = ok0();
  const A = 'POST /api/v1/order/create';
  const T = 'POST /api/v1/order/create 创建人字段为空，期望返回创建人姓名';
  // 笔误写大：必须被夹到 HARD_CAPS，不得让规模门禁形同虚设
  const wide = gate(ctx, A, T, HEAD, { limits: { maxDiffLines: 4000, maxFiles: 10 } });
  assert.equal(wide.status, EXIT.PASS);
  assert.equal(wide.budget.maxDiffLines, HARD_CAPS.maxDiffLines, '4000 → 夹到 80');
  assert.equal(wide.budget.maxFiles, HARD_CAPS.maxFiles, '10 → 夹到 4');
  // 收紧：原样生效
  const tight = gate(ctx, A, T, HEAD, { limits: { maxDiffLines: 20, maxFiles: 1 } });
  assert.equal(tight.budget.maxDiffLines, 20);
  assert.equal(tight.budget.maxFiles, 1);
  // 非法（0/负/NaN）：回退 L1 默认，不得变成 0 预算（那会禁掉一切快路径）
  const bad = gate(ctx, A, T, HEAD, { limits: { maxDiffLines: 0, maxFiles: -3 } });
  assert.equal(bad.budget.maxDiffLines, DEFAULTS.maxDiffLines);
  assert.equal(bad.budget.maxFiles, DEFAULTS.maxFiles);
  // 缺省：等于 DEFAULTS
  assert.deepEqual(gate(ctx, A, T, HEAD).budget,
    { maxDiffLines: DEFAULTS.maxDiffLines, maxFiles: DEFAULTS.maxFiles, hardCaps: HARD_CAPS });
});

test('P1-③ enabled:false 在任何 I/O 前短路 → 30，不读 index.md', () => {
  const ctx = ok0();
  const r = gate(ctx, 'POST /api/v1/order/create', '创建人字段为空', HEAD, { enabled: false });
  assert.equal(r.status, EXIT.NO_ROUTE, '主动关闭走 30');
  assert.equal(r.eligible, false);
  assert.equal(r.disabled, true, '递出 disabled 标记供 jsonl 区分“主动关”与“不可用”');
  assert.equal(r.gates.G0_anchorKind, 'skipped', '连锚点都不应求值');
  assert.equal(r.gates.G2_dataReady, undefined, '不得去读学习数据');
});

test('P1-③ allowAnchorKinds 白名单：缺省不限，列了就只放行列内的', () => {
  const ctx = ok0();
  const T = 'OrderController#create 未做非空校验，期望空值时返回参数校验错误';
  const TR = 'POST /api/v1/order/create 创建人字段为空，期望返回创建人姓名';
  // 白名单只给 route → fqn 锚点出局
  const onlyRoute = gate(ctx, 'OrderController#create', T, HEAD, { allowAnchorKinds: ['route'] });
  assert.equal(onlyRoute.status, EXIT.NO_ROUTE, 'fqn 不在白名单 → 30');
  assert.equal(onlyRoute.gates.G0_anchorKind, 'fail');
  // 白名单包含 fqn → 正常进门禁
  assert.equal(gate(ctx, 'OrderController#create', T, HEAD, { allowAnchorKinds: ['fqn', 'route'] }).status, EXIT.PASS);
  // 空数组 = 什么都不放行（比缺省更严）
  assert.equal(gate(ctx, 'POST /api/v1/order/create', TR, HEAD, { allowAnchorKinds: [] }).status, EXIT.NO_ROUTE);
  // null/缺省 = 不限制
  assert.equal(gate(ctx, 'POST /api/v1/order/create', TR, HEAD, { allowAnchorKinds: null }).status, EXIT.PASS);
});

// ---------- P1-② G5 脚本化验收：verifyImpactReport ----------

// lite 回报的证据登记表：kind 只允许 batch / data（见 agents/bug-analyzer.md 的证据三态）
const EV = Object.freeze([
  { id: 'E1', kind: 'batch', ref: 'order/batch-01.md', lines: [40, 88], quote: 'create(): 入参非空校验' },
]);

test('P1-② verifyImpactReport：合法窄回报 → 0，且逐形状字段齐备', () => {
  const report = {
    status: 'ok', code: 'ANALYZED',
    target: { route: 'POST /api/v1/order/create' },
    data: { impact: { callers: [], callees: [], external_refs: [] } },
    evidence: EV.slice(),
    reads: []
  };
  const r = verifyImpactReport(report, { expectedRoute: 'POST /api/v1/order/create' });
  assert.equal(r.status, EXIT.PASS);
  assert.equal(r.narrow, true);
  assert.equal(r.code, 'ANALYZED');
  assert.deepEqual(r.problems, []);
  // 选配项未给时必须如实记 absent，不能假装 pass：账本要能区分“校过且通过”与“无从校”
  assert.equal(r.checks.flow, 'absent');
  assert.equal(r.checks.exception, 'absent');
  assert.equal(r.checks.scope, 'absent');
});

test('P1-② external_refs 非空 / code IMPACT_WIDE / reads 非空 → 37', () => {
  const base = { code: 'ANALYZED', target: { route: 'POST /api/x' }, data: { impact: { external_refs: [] } },
    evidence: EV.slice(), reads: [] };
  assert.equal(verifyImpactReport({ ...base, data: { impact: { external_refs: ['Other#call'] } } }).status, EXIT.IMPACT_WIDE,
    'owning class 被外部引用 → 37');
  assert.equal(verifyImpactReport({ ...base, code: 'IMPACT_WIDE' }).status, EXIT.IMPACT_WIDE);
  assert.equal(verifyImpactReport({ ...base, reads: [{ file: 'X.java' }] }).status, EXIT.IMPACT_WIDE,
    'lite 护栏被破（读了源码）→ 37');
});

test('P1-② 回报不可用一律 36：“看不清”绝不是“通过”', () => {
  assert.equal(verifyImpactReport(null).status, EXIT.INCOMPLETE, '非对象');
  assert.equal(verifyImpactReport([]).status, EXIT.INCOMPLETE, '数组不算对象');
  assert.equal(verifyImpactReport('nope').status, EXIT.INCOMPLETE, '字符串');
  assert.equal(verifyImpactReport({}).status, EXIT.INCOMPLETE, '缺 code');
  assert.equal(verifyImpactReport({ code: 'WEIRD' }).status, EXIT.INCOMPLETE, '未知 code 不得当 ANALYZED');
  assert.equal(verifyImpactReport({ code: 'INSUFFICIENT_LEARNING', reads: [] }).status, EXIT.INCOMPLETE,
    '没给出“影响窄”的证据 → 36 升格');
  assert.equal(verifyImpactReport({ code: 'ANALYZED', data: { impact: {} } }).status, EXIT.INCOMPLETE,
    '缺 reads 数组：无法证明未读源码');
});

test('P1-② depth > 1 与目标不一致 → 36；IMPACT_CODES 与 analyzer 契约同集', () => {
  const base = { code: 'ANALYZED', target: { route: 'POST /api/x' }, data: { impact: { external_refs: [] } },
    evidence: EV.slice(), reads: [] };
  assert.equal(verifyImpactReport({ ...base, depth: 2 }).status, EXIT.INCOMPLETE, 'lite 契约要求 depth<=1');
  assert.equal(verifyImpactReport({ ...base, depth: 1 }).status, EXIT.PASS);
  assert.equal(verifyImpactReport(base, { expectedRoute: 'POST /api/other' }).status, EXIT.INCOMPLETE,
    '分析目标与门禁锚点不一致 → 36');
  assert.equal(verifyImpactReport(base, { expectedRoute: 'post /api/x' }).status, EXIT.PASS, 'route 比较经归一，大小写/方法前缀不敏感');
  // 常量守护：新增退出码/回报 code 时两边必须同步
  assert.deepEqual([...IMPACT_CODES].sort(),
    ['ANALYZED', 'IMPACT_WIDE', 'INSUFFICIENT_LEARNING', 'TARGET_NOT_FOUND'].sort());
  assert.equal(EXIT.IMPACT_WIDE, 37);
});

// ---------- P2-b2 证据绑定 / 流程落位 / 例外声明 / scope 越界 ----------

const NARROW_BASE = () => ({
  code: 'ANALYZED', target: { route: 'POST /api/x' },
  data: { impact: { external_refs: [] } }, evidence: EV.map((e) => ({ ...e })), reads: [],
});

test('P2-b2 证据登记：零证据 / 坏形状 / 孤儿引用 → 36；lite 里出现 kind=read → 37', () => {
  const b = NARROW_BASE;
  assert.equal(verifyImpactReport(b()).status, EXIT.PASS, '带一条 batch 证据的窄回报应通过');
  assert.equal(verifyImpactReport({ ...b(), evidence: undefined }).status, EXIT.INCOMPLETE, 'ANALYZED 零证据 = 与“没看过”不可区分');
  assert.equal(verifyImpactReport({ ...b(), evidence: [] }).status, EXIT.INCOMPLETE);
  assert.equal(verifyImpactReport({ ...b(), evidence: [{ kind: 'batch', ref: 'a/b.md' }] }).status, EXIT.INCOMPLETE, '缺 id：没人能引用到它');
  assert.equal(verifyImpactReport({ ...b(), evidence: [{ id: 'E1', kind: 'guess', ref: 'x' }] }).status, EXIT.INCOMPLETE, 'kind 不在枚举：判不了它是否违反 lite 护栏');
  assert.equal(verifyImpactReport({ ...b(), evidence: [{ id: 'E1', kind: 'batch' }] }).status, EXIT.INCOMPLETE, '有 id 没 ref = 给一句话起了个名字');
  assert.equal(verifyImpactReport({ ...b(), evidence: [{ id: 'E1', kind: 'batch', ref: 'a' }, { id: 'E1', kind: 'batch', ref: 'b' }] }).status, EXIT.INCOMPLETE, 'id 重复：引用它没有确定含义');
  assert.equal(verifyImpactReport({ ...b(), evidence: { E1: 1 } }).status, EXIT.INCOMPLETE, 'evidence 不是数组');
  assert.equal(verifyImpactReport({
    ...b(), data: { impact: { external_refs: [] }, flow: [{ class: 'C', method: 'm', evidence: ['E404'] }] },
  }).status, EXIT.INCOMPLETE, '引用不存在的证据 id 比不引用更容易混过人眼');
  assert.equal(verifyImpactReport({
    ...b(), evidence: [...b().evidence, { id: 'E2', kind: 'read', ref: 'C:/x/Y.java' }],
  }).status, EXIT.IMPACT_WIDE, 'reads=[] 却有 kind=read 证据 = 两份申报互相矛盾，与“偷读源码”同一笔账');
  assert.deepEqual([...EVIDENCE_KINDS], ['read', 'batch', 'data'], '证据类型改了就要同步 agents/bug-analyzer.md 的三态表');
});

test('P2-b2 flow 每一跳必须落到 class#method 并绑证据（“某层处理了一下”不可核对也不可改）', () => {
  const withFlow = (flow) => verifyImpactReport({ ...NARROW_BASE(), data: { impact: { external_refs: [] }, flow } });
  assert.equal(withFlow([{ class: 'OrderController', method: 'create', evidence: ['E1'] }]).status, EXIT.PASS);
  assert.equal(withFlow([{ class: '  ', method: 'create', evidence: ['E1'] }]).status, EXIT.INCOMPLETE, '空白串不算给了 class');
  assert.equal(withFlow([{ class: 'C' }]).status, EXIT.INCOMPLETE, '缺 method：这一跳没落到可打开的位置');
  assert.equal(withFlow([{ class: 'C', method: 'm' }]).status, EXIT.INCOMPLETE, '这一跳没绑证据：读来的还是想出来的分不出来');
  assert.equal(withFlow([{ class: 'C', method: 'm', evidence: [] }]).status, EXIT.INCOMPLETE);
  assert.equal(withFlow('Service 层做了校验').status, EXIT.INCOMPLETE, 'flow 不是数组');
  assert.equal(withFlow([]).status, EXIT.PASS, '空数组 = 本次没给流程；不强制（lite 本职是影响半径）');
});

test('P2-b2 exception：比较类断言必须交代在哪一层比、两边各是什么类型', () => {
  const b = NARROW_BASE();
  const good = {
    assumptions: [{ claim: 'mapper 未做 trim', basis: 'batch-01.md 未列该校验' }],
    comparisons: [{ left: '1.11', right: '1.11', at: 'Java', types: ['BigDecimal', 'String'], risk: 'scale 不同' }],
  };
  assert.equal(verifyImpactReport({ ...b, exception: good }).status, EXIT.PASS);
  assert.equal(verifyImpactReport({ ...b, exception: { comparisons: [{ left: 'a', right: 'b' }] } }).status, EXIT.INCOMPLETE,
    '不交代 at/types = 真不相等与转出来的不相等分不开');
  assert.equal(verifyImpactReport({ ...b, exception: { comparisons: [{ left: 'a', right: 'b', at: 'DB', types: [] }] } }).status, EXIT.INCOMPLETE,
    '空数组 = 没给类型（types 写了但内容是空的）');
  assert.equal(verifyImpactReport({ ...b, exception: { assumptions: [{ claim: 'x' }] } }).status, EXIT.INCOMPLETE, '假设没写凭什么');
  assert.equal(verifyImpactReport({ ...b, exception: '没有例外' }).status, EXIT.INCOMPLETE, 'exception 不是对象');
  assert.equal(verifyImpactReport({ ...b, exception: { assumptions: [{ claim: 'x', basis: 'y', evidence: ['E9'] }] } }).status, EXIT.INCOMPLETE,
    '例外项同样受引用完整性约束');
});

test('P2-b2 scope：越界与相对路径都是“拿了不该拿的东西”→ 37；范围内 → 0', () => {
  const win = process.platform === 'win32';
  const root = win ? 'C:/work/demo' : '/work/demo';
  const inside = win ? 'C:/work/demo/src/A.java' : '/work/demo/src/A.java';
  const outside = win ? 'D:/other/B.java' : '/other/B.java';
  const withFile = (file) => ({
    ...NARROW_BASE(), data: { impact: { external_refs: [] }, flow: [{ class: 'A', method: 'm', file, evidence: ['E1'] }] },
  });
  assert.equal(verifyImpactReport(NARROW_BASE(), { scopeRoots: [root] }).status, EXIT.PASS, '回报里没文件路径 = 无可越界');
  assert.equal(verifyImpactReport(withFile(inside), { scopeRoots: [root] }).status, EXIT.PASS);
  assert.equal(verifyImpactReport(withFile(root), { scopeRoots: [root] }).status, EXIT.PASS, '根本身不算越界');
  assert.equal(verifyImpactReport(withFile(outside), { scopeRoots: [root] }).status, EXIT.IMPACT_WIDE, 'flow 里的文件在 scope 外');
  assert.equal(verifyImpactReport(withFile('src/A.java'), { scopeRoots: [root] }).status, EXIT.IMPACT_WIDE,
    '相对路径一律算越界：拼接基准由谁定没有定义，“看起来在范围内”不是证据');
  assert.equal(verifyImpactReport({ ...NARROW_BASE(), scope: { outside: [outside] } }, { scopeRoots: [root] }).status, EXIT.IMPACT_WIDE,
    '自报越界');
  assert.equal(verifyImpactReport(withFile(outside)).status, EXIT.PASS, '不给 scopeRoots = 不校这一项（同 expectedRoute 的选配纪律）');
});

// ---------- G4b：batch 级新鲜度（把仓库粒度判据收窄到“本 batch 的源文件变没变”）----------

test('parseSourcesCell：只有"合法相对 POSIX 路径"才算可用集', () => {
  const ok = parseSourcesCell('a/b.java;c/d.xml');
  assert.deepEqual(ok, { files: ['a/b.java', 'c/d.xml'], usable: true });
  assert.equal(parseSourcesCell('a/b.java ; c/d.xml').usable, true, '分隔符两侧空白应折叠');
  // 以下全部归为不可用 → G4b fail-closed 判 35
  assert.equal(parseSourcesCell('').usable, false, '空值不等于无依赖');
  assert.equal(parseSourcesCell('-').usable, false, '`-` = 追不全，保守出局');
  assert.equal(parseSourcesCell('—').usable, false, '全角破折号同等对待');
  assert.equal(parseSourcesCell('a/b.java;').usable, true, '尾部空段无害');
  assert.equal(parseSourcesCell('a/b.java;;').usable, true);
  assert.equal(parseSourcesCell('/abs/a.java').usable, false, '绝对路径：与 git 输出永不相等 → 当成可用就是漏杀');
  assert.equal(parseSourcesCell('C:\\x\\a.java').usable, false, '反斜杠 + 盘符');
  assert.equal(parseSourcesCell('C:/x/a.java').usable, false, '盘符开头');
  assert.equal(parseSourcesCell('./a.java').usable, false, '`./` 前缀与 git 形态不符');
  assert.equal(parseSourcesCell('http://x/a.java').usable, false);
  assert.equal(parseSourcesCell('a/b.java;/abs/c.java').usable, false, '混进一条坏形态即整格不可信');
});

test('diffNameOnly：取不到时必须返回 null（与"零变更"的 [] 分得开）', () => {
  assert.equal(diffNameOnly(undefined, HEAD, OTHER), null, '缺 root');
  assert.equal(diffNameOnly('C:\\', '', OTHER), null, '缺 from');
  assert.equal(diffNameOnly('C:\\', HEAD, ''), null, '缺 to');
  assert.equal(diffNameOnly(path.join(os.tmpdir(), 'supperh-no-such-repo'), HEAD, OTHER), null, '非 git 仓 → null，不抛');
});

/** 真 git 仓能力探测（一次性）：跑不通就把下面整组 skip，不判失败。 */
let GIT_PROBE;
function gitRepo(files = {}) {
  if (GIT_PROBE === 'no') return null;
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supperh-git-'));
    const run = (...args) => execFileSync('git', ['-C', root, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
    run('init', '-q');
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body, 'utf8');
    }
    run('add', '-A');
    run('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'c1');
    if (GIT_PROBE === undefined) GIT_PROBE = 'yes';
    return {
      root,
      head: () => run('rev-parse', 'HEAD').trim(),
      /** 追加一个 commit：改动 files，并可选地把 fromPath 重命名到 toPath */
      commit(nextFiles, msg = 'c2', rename = null) {
        if (rename) {
          // git mv 不会自动建目标目录，不先 mkdir 就报 128
          const dst = path.join(root, rename[1]);
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          run('mv', rename[0].replace(/\//g, path.sep), rename[1].replace(/\//g, path.sep));
        }
        for (const [rel, body] of Object.entries(nextFiles)) {
          const abs = path.join(root, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, body, 'utf8');
        }
        run('add', '-A');
        run('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false',
          'commit', '-q', '--allow-empty', '-m', msg);
        return run('rev-parse', 'HEAD').trim();
      }
    };
  } catch {
    GIT_PROBE = 'no';
    return null;
  }
}

/** 用给定 sources / learnedAtCommit 造一份 context，并按真实 HEAD 进门禁 */
function g4bGate({ commit, sources }, repo, headCommit, anchor = 'POST /api/v1/order/create') {
  const row = `| POST /api/v1/order/create | OrderController | create | batch-01.md | 40-88 | L3 | ${sources} |`;
  const ctx = makeContext(indexDoc({ commit, rows: [row] }));
  return gate(ctx, anchor, 'POST /api/v1/order/create 创建人字段为空，期望返回创建人姓名', headCommit, { effectiveRoot: repo.root });
}

const A_JAVA = 'src/main/java/com/x/OrderController.java';
const B_JAVA = 'src/main/java/com/x/OrderServiceImpl.java';

test('G4b-⓪ G4a 全等时根本不碰 git（常见路径零额外开销）', (t) => {
  const repo = gitRepo({ [A_JAVA]: 'x', 'README.md': 'x' });
  if (!repo) return t.skip('无 git');
  const c1 = repo.head();
  // learned == head，即使 effectiveRoot 有效也不应去算 diff
  const r = g4bGate({ commit: c1, sources: A_JAVA }, repo, c1);
  assert.equal(r.status, EXIT.PASS);
  assert.equal(r.gates.G4_fresh, 'pass', 'G4a 直接过，不是 pass_disjoint');
  assert.equal(r.g4b, null, '未进 G4b，不得留下求值痕迹');
});

test('G4b-① 无关提交不再误杀（这是整次改造的目的）', (t) => {
  const repo = gitRepo({ [A_JAVA]: 'x', [B_JAVA]: 'x' });
  if (!repo) return t.skip('无 git');
  const c1 = repo.head();
  const c2 = repo.commit({ 'README.md': '格式化了一下' });
  assert.notEqual(c1, c2, '确实产生了一个新 commit');

  const r = g4bGate({ commit: c1, sources: `${A_JAVA};${B_JAVA}` }, repo, c2);
  assert.equal(r.status, EXIT.PASS, '改 README 不该作废整个 batch');
  assert.equal(r.gates.G4_fresh, 'pass_disjoint', '必须与 G4a 全等区分开，账本才量得到收益');
  assert.equal(r.commit.stale_but_disjoint, true);
  assert.deepEqual(
    { ran: r.g4b.ran, outcome: r.g4b.outcome, intersect: r.g4b.intersect_count },
    { ran: true, outcome: 'disjoint', intersect: 0 });
});

test('G4b-② batch 粒度而非目录粒度：同目录其batch变了也不误杀', (t) => {
  const repo = gitRepo({ [A_JAVA]: 'x', 'src/main/java/com/x/PaymentServiceImpl.java': 'x' });
  if (!repo) return t.skip('无 git');
  const c1 = repo.head();
  const c2 = repo.commit({ 'src/main/java/com/x/PaymentServiceImpl.java': '改了点别的' });
  const r = g4bGate({ commit: c1, sources: A_JAVA }, repo, c2);
  assert.equal(r.status, EXIT.PASS, '本 batch 没声明依赖那个文件 → 放行');
  assert.equal(r.g4b.outcome, 'disjoint');
});

test('G4b-③ 改了 sources 里的文件 → 35，不得放行', (t) => {
  const repo = gitRepo({ [A_JAVA]: 'x', [B_JAVA]: 'x' });
  if (!repo) return t.skip('无 git');
  const c1 = repo.head();
  const c2 = repo.commit({ [B_JAVA]: 'SQL 换了' });
  const r = g4bGate({ commit: c1, sources: `${A_JAVA};${B_JAVA}` }, repo, c2);
  assert.equal(r.status, EXIT.STALE, 'Mapper/Service 改动会让 batch 结论全错，必须拦住');
  assert.equal(r.gates.G4_fresh, 'fail');
  assert.equal(r.g4b.outcome, 'intersect');
  assert.equal(r.g4b.intersect_count, 1);
  assert.ok(r.anchorResolved, '35 仍应带 anchorResolved 供完整路径复用');
});

test('G4b-④ 只改 Controller 自身（表结构本身变了）→ 35', (t) => {
  const repo = gitRepo({ [A_JAVA]: 'x' });
  if (!repo) return t.skip('无 git');
  const c1 = repo.head();
  const c2 = repo.commit({ [A_JAVA]: '方法改名了' });
  const r = g4bGate({ commit: c1, sources: A_JAVA }, repo, c2);
  assert.equal(r.status, EXIT.STALE, '「G4 先于 G1：过期表的命中结果不可信」这条不变式靠它成立');
});

test('G4b-⑤ sources 为 `-` → 35（“不知道”绝不是“无依赖”）', (t) => {
  const repo = gitRepo({ [A_JAVA]: 'x' });
  if (!repo) return t.skip('无 git');
  const c1 = repo.head();
  const c2 = repo.commit({ 'README.md': 'x' });
  const r = g4bGate({ commit: c1, sources: '-' }, repo, c2);
  assert.equal(r.status, EXIT.STALE, '追不上就保守出局。写成放行等于把误杀换成漏杀');
  assert.equal(r.g4b.outcome, 'sources_unusable');
});

test('G4b-⑥ 路径形态不合法 → 35 而非“交集为空以故放行”', (t) => {
  const repo = gitRepo({ [A_JAVA]: 'x' });
  if (!repo) return t.skip('无 git');
  const c1 = repo.head();
  const c2 = repo.commit({ 'README.md': 'x' });
  for (const bad of [`${repo.root}\\OrderController.java`, `/${A_JAVA}`, `./${A_JAVA}`, `${A_JAVA.replace(/\//g, '\\')}`]) {
    const r = g4bGate({ commit: c1, sources: bad }, repo, c2);
    assert.equal(r.status, EXIT.STALE, `形态错的 sources（${bad}）不得被当成"没依赖"`);
    assert.equal(r.g4b.outcome, 'sources_unusable');
  }
});

test('G4b-⑦ diff 不可得（commit 不在历史里）→ 35', (t) => {
  const repo = gitRepo({ [A_JAVA]: 'x' });
  if (!repo) return t.skip('无 git');
  const c2 = repo.head();
  const r = g4bGate({ commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', sources: A_JAVA }, repo, c2);
  assert.equal(r.status, EXIT.STALE, '浅克隆/rebase 丢掉左端点时保守出局，不新增退出码');
  assert.equal(r.g4b.outcome, 'diff_unavailable');
});

test('G4b-⑧ rename 不得被折叠掉旧路径（--no-renames）', (t) => {
  const repo = gitRepo({ [A_JAVA]: 'x' });
  if (!repo) return t.skip('无 git');
  const c1 = repo.head();
  const c2 = repo.commit({}, 'mv', [A_JAVA, 'src/main/java/com/y/RenamedController.java']);
  const r = g4bGate({ commit: c1, sources: A_JAVA }, repo, c2);
  assert.equal(r.status, EXIT.STALE, '折叠重命名后只剩新路径，旧 sources 永不相等 → 漏杀');
  assert.equal(r.g4b.outcome, 'intersect');
});

test('G4b-⑨ 非 ASCII 路径不被转义吃掉（core.quotePath=false）', (t) => {
  const repo = gitRepo({ 'src/main/java/订单控制器.java': 'x' });
  if (!repo) return t.skip('无 git');
  const c1 = repo.head();
  const c2 = repo.commit({ 'src/main/java/订单控制器.java': '改了什么' });
  const changed = diffNameOnly(repo.root, c1, c2);
  assert.ok(changed, 'diff 应取得到');
  assert.deepEqual(changed, ['src/main/java/订单控制器.java'], '不得被转义成 "\\346\\226\\207..."');
  const r = g4bGate({ commit: c1, sources: 'src/main/java/订单控制器.java' }, repo, c2);
  assert.equal(r.status, EXIT.STALE, '中文文件名同样要能拦住');
});

test('G4b-⑩ 两个 commit 之间零变更（HEAD 不等但树未变）→ 可放行', (t) => {
  const repo = gitRepo({ [A_JAVA]: 'x' });
  if (!repo) return t.skip('无 git');
  const c1 = repo.head();
  const c2 = repo.commit({}, 'empty-ish');
  if (c1 === c2) return t.skip('git 未产生新 commit');
  assert.deepEqual(diffNameOnly(repo.root, c1, c2), [], '零变更应返回 []而不是 null');
  const r = g4bGate({ commit: c1, sources: A_JAVA }, repo, c2);
  assert.equal(r.status, EXIT.PASS, '[] ≠ null：确实没文件变过，可以放行');
  assert.equal(r.g4b.outcome, 'disjoint');
});

test('G4b-⑪ readFreshness 仍是仓库级判据（与门禁故意不一致，不得被"顺手对齐"）', async () => {
  const { readFreshness } = await import('../scripts/fastpath-gate.mjs');
  const ctx = makeContext(indexDoc({ commit: OTHER }));
  const f = readFreshness({ contextRoot: ctx.contextRoot, module: 'order', headCommit: HEAD });
  assert.equal(f.available, true);
  assert.equal(f.stale, true, '它没有锚点、拿不到 batch，只能按仓库级全等判 stale');
  // 门禁在同样数据上可能放行（diff 与 sources 不相交）——两者粒度不同，不是矛盾
});

// ---------- I0 意图复述：唯一一道判"理解对不对"的门禁 ----------
//
// 与 G0–G5 的分工：那六项全在回答"代码在哪、能不能定位、波及多大"，没有一项
// 回答"我对需求的理解是不是你的意思"。一条被误读的描述可以六项全绿通过，
// 然后拿着错误的解读去精确执行正确的动作——定位越准、diff 越小，越难被发现。

const IA = 'POST /api/v1/order/create';
const IT = `${IA} 创建人字段为空，期望返回创建人姓名`;

/** 一份完全合格的 intent，按槽位 / 引用分别可覆盖 */
function intent(over = {}, quotesOver = {}) {
  const base = {
    expected: '期望：接口返回创建人姓名',
    actual: '实际：创建人字段为空',
    repro: INTENT_ABSENT,
    quotes: { expected: ['期望返回创建人姓名'], actual: [`${IA} 创建人字段为空`] }
  };
  return { ...base, ...over, quotes: { ...base.quotes, ...quotesOver } };
}

test('I0 合规复述 → 放行，且引用计数随 JSON 回传（命令那一层要打印给用户核对）', () => {
  const ctx = ok0();
  const r = gate(ctx, IA, IT, HEAD, { intent: intent() });
  assert.equal(r.status, EXIT.PASS);
  assert.equal(r.gates.I0_intent, 'pass');
  assert.deepEqual({ total: r.intent.quotes_total, ok: r.intent.quotes_verified, problems: r.intent.problems.length },
    { total: 2, ok: 2, problems: 0 });
});

test('I0 结构不可用 → 36（该修的是编排者），绝不与 40（该问用户）混成一个码', () => {
  const ctx = ok0();
  const cases = [
    ['完全不传 intent', { intent: undefined }],
    ['intent 不是对象', { intent: '创建人字段为空' }],
    ['缺 quotes', { intent: { expected: '期望返回创建人姓名', actual: '创建人字段为空', repro: INTENT_ABSENT } }],
    ['quotes 是数组（与 verifyImpactReport 同一姿态：数组不算对象）',
      { intent: { expected: 'a', actual: 'b', repro: INTENT_ABSENT, quotes: [] } }]
  ];
  for (const [why, extra] of cases) {
    const r = gate(ctx, IA, IT, HEAD, extra);
    assert.equal(r.status, EXIT.INCOMPLETE, `${why} → 36`);
    assert.equal(r.intent, null, `${why}：没求值就得回传 null，不得伪造一个判定`);
    assert.equal(r.intentSkipped, true, '递出标记供 jsonl 区分"没给结构"与"给了但欠定义"');
  }
});

test('I0 五条机械判据逐条命中 → 40，且 message 指向"问用户一次"而非"重跑"', () => {
  const ctx = ok0();
  const cases = [
    ['期望行为空白（= 没处理）', intent({ expected: '   ' }), /槽位缺失或过短/],
    ['实际行为空白', intent({ actual: '' }), /槽位缺失或过短/],
    ['复现条件留空（没答）', intent({ repro: '' }), /槽位缺失或过短/],
    ['复现条件写自造说法（同义词会漂，只认字面 absent）', intent({ repro: '没有' }), /槽位缺失或过短/],
    ['引用片段不在用户原话里（编造/意译）', intent({}, { actual: [`${IA} 金额字段为负数`] }), /找不到出处/],
    ['碎片引用低于 8 字符下限', intent({}, { expected: ['姓名'] }), /低于下限/],
    ['expected 未附任何引用（只有我自己的话）', intent({}, { expected: [] }), /未附用户原话引用/],
    ['整段抄一遍、两格共用', intent({}, { expected: [IT], actual: [IT] }), /整段抄/],
    ['actual 里没有一句落在症状句上', intent({}, { actual: [IA] }), /症状/]
  ];
  for (const [why, it, re] of cases) {
    const r = gate(ctx, IA, IT, HEAD, { intent: it });
    assert.equal(r.status, EXIT.INTENT_AMBIGUOUS, `${why} → 期望 40，实际 ${r.status} ${r.message}`);
    assert.equal(r.eligible, false);
    assert.equal(r.gates.I0_intent, 'fail');
    assert.match(r.message, re, `${why}：message 应点名这条判据`);
    assert.match(r.message, /一次性/, '必须要求一次问全三项，不搞挤牙膏式追问');
  }
});

test('I0 新能力：锚点"原字面取出"首次被机械校验（此前只写在命令里，从未验过）', () => {
  const ctx = ok0();
  // 用户只说了中文描述，这条 route 是我"意译"出来的——G0/G1 只会夸它合法且唯一
  const text = '订单创建接口返回的创建人字段为空，期望返回创建人姓名';
  const it = {
    expected: '期望：返回创建人姓名', actual: '实际：创建人为空', repro: INTENT_ABSENT,
    quotes: { expected: ['期望返回创建人姓名'], actual: ['返回的创建人字段为空'] }
  };
  const r = gate(ctx, IA, text, HEAD, { intent: it });
  assert.equal(r.status, EXIT.INTENT_AMBIGUOUS, '引用全真、归属也对，但锚点在原话里根本不存在');
  assert.ok(r.intent.problems.some((p) => p.includes('原字面取出')), '问题项应点名"要求原字面取出"');
  // 把锚点换成用户真说过的那句 → 立刻放行，证明拦的只是锚点出处
  const ok = gate(ctx, IA, `${IA} 返回的创建人字段为空，期望返回创建人姓名`, HEAD, { intent: it });
  assert.equal(ok.status, EXIT.PASS, ok.message);
});

test('I0 锚点验真对 lookup 豁免（反查得到的 route 本来就不在原话里，不是漂移）', () => {
  const ctx = ok0();
  const text = '工单号 task-1024 里说创建人字段为空，期望返回创建人姓名';
  const it = {
    expected: '期望：返回创建人姓名', actual: '实际：创建人字段为空', repro: INTENT_ABSENT,
    quotes: { expected: ['期望返回创建人姓名'], actual: ['task-1024 里说创建人字段为空'] }
  };
  assert.equal(gate(ctx, IA, text, HEAD, { intent: it }).status, EXIT.INTENT_AMBIGUOUS,
    '反查来的锚点没声明出处 → 照样拦（漏杀不可接受）');
  assert.equal(gate(ctx, IA, text, HEAD, { intent: it, anchorSource: 'lookup' }).status, EXIT.PASS,
    '带 anchorSource=lookup → 豁免，它自有"恰好一条"护栏');
});

test('I0 repro 三种合法形态：字面 absent / 一句真话；空串与短句非法', () => {
  const ctx = ok0();
  assert.equal(gate(ctx, IA, IT, HEAD, { intent: intent({ repro: INTENT_ABSENT }) }).status, EXIT.PASS, 'absent = 合法的"确实没有"');
  assert.equal(gate(ctx, IA, IT, HEAD, { intent: intent({ repro: '只在没有创建人的存量单上出现' }) }).status, EXIT.PASS,
    '≥8 字符的一句真话同样合法');
  // 强制非空的直接效果是奖励填空，所以"不知道"必须是合法输出
  assert.equal(verifyIntent({ expected: 'a', actual: 'b', repro: INTENT_ABSENT, quotes: {} }, 'x').slots_missing.length, 0,
    'repro=absent 不算缺失');
});

test('I0 拦不住"引用真句子但归属错"——这是写明的能力边界，不许后人当成安全保证', () => {
  const ctx = ok0();
  // 两句都是原话、都不重叠、都含症状形态，但期望/实际说反了：机械判据全过。
  // 那半分归用户人判——I0 的产出是"把理解以可核对的形式打印出来"，不是"保证理解对"。
  const text = `${IA} 创建人字段为空，订单号也没有回填`;
  const swapped = {
    expected: '期望：创建人字段为空', actual: '实际：订单号也没有回填', repro: INTENT_ABSENT,
    quotes: { expected: ['create 创建人字段为空'], actual: ['订单号也没有回填'] }
  };
  const r = gate(ctx, IA, text, HEAD, { intent: swapped });
  assert.equal(r.status, EXIT.PASS, '本用例断言的是"它拦不住"：若哪天变成 40，说明判据收紧了，回来改这条断言');
});

test('I0 与否决表同纪律：被更早门禁短路时判定仍回传，但更可行动的阻塞点优先', () => {
  const stale = gate(makeContext(indexDoc({ commit: OTHER })), IA, IT, HEAD, { intent: intent({ expected: '', actual: '', repro: '' }) });
  assert.equal(stale.status, EXIT.STALE, '数据过期比意图欠定义更可行动 → 35');
  assert.equal(stale.intent.ok, false, '但意图欠定义必须如实记账，否则以后据此调参会偏松');
  assert.equal(stale.gates.I0_intent, undefined, '未被求值的门禁不得写成 pass/fail 骗人');

  const vetoed = gate(ok0(), IA, `${IA} 偶发创建人字段为空，期望返回创建人姓名`, HEAD,
    { intent: intent({ expected: '', actual: '', repro: '' }) });
  assert.equal(vetoed.status, EXIT.VETO, '命中否决词必然升格完整路径 → 33；而完整路径同样要跑步骤 1.6 的复述');
  assert.equal(vetoed.intent.ok, false);
});

test('EXIT 码段守护：40 独立于 30–37「一律落完整路径」段', () => {
  const codes = Object.values(EXIT).filter((v) => typeof v === 'number');
  assert.equal(EXIT.INTENT_AMBIGUOUS, 40);
  assert.equal(codes.filter((v) => v >= 30 && v <= 37).length, 8, '30–37 恰好八档，语义同为"落完整路径"');
  assert.ok(!codes.includes(38) && !codes.includes(39), '38/39 留空：别让 40 被接成连续段，那条不变式是调用方敢拿退出码当分流依据的前提');
});
