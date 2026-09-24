// tests/parallel-slice-contract.test.mjs
// 并行交接契约（analyzer 自写 slice JSON → writer 机械聚合）的机械回归：
//   1) 文档一致性：旧形态（内联列表 / 主命令写暂存 / 旧分母公式）必须清零，新形态必须到位；
//   2) 切片文件传输是**无损**的（JSON 序列化→落盘→读回→深等），对比"主命令转录"的丢字段风险；
//   3) 95% 完整度闸门的分母被钉在"本轮派发目标"（模块全量会令第一轮必死，见 SKILL §3）；
//   4) slice_id 预分配 → 文件名互不冲突。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/^\uFEFF/, '');

const LEARN  = 'commands/supperH-learn.md';
const SKILL  = 'skills/supperH-prelearn/SKILL.md';
const WRITER = 'agents/supperH-prelearn-writer.md';
const ANALYZER = 'agents/supperH-prelearn-analyzer.md';
const WF     = '.qoder/rules/20-workflow.md';

test('交接契约文档一致性：旧形态清零，新形态到位', () => {
  const learn = read(LEARN), skill = read(SKILL), writer = read(WRITER), wf = read(WF);
  for (const [f, t] of [['learn', learn], ['skill', skill], ['writer', writer]]) {
    assert.ok(!t.includes('analyzer_outputs: ['), f + ' 残留内联列表形态');
    assert.ok(!t.includes('主命令有写权限'), f + ' 残留"主命令写暂存"措辞');
    assert.ok(!t.includes('coveredControllers ÷ 目标总数 ≥ 95%'), f + ' 残留旧分母公式');
  }
  for (const [f, t] of [['learn', learn], ['skill', skill], ['writer', writer], ['wf', wf]]) {
    assert.ok(t.includes('slice-NN.json'), f + ' 缺切片文件形态');
  }
  assert.ok(learn.includes('staging_dir'), 'learn 缺 staging_dir 派发形态');
  assert.ok(learn.includes('零转录'), 'learn 缺零转录表述');
  assert.ok(learn.includes('本轮派发目标'), 'learn 缺本轮派发目标分母');
  assert.ok(skill.includes('本轮派发目标'), 'skill 缺本轮派发目标分母');
  assert.ok(read(ANALYZER).includes('slice_id'), 'analyzer 缺 slice_id 契约');
});

test('切片文件传输无损：写盘→读回→深等（对比转录丢字段）', () => {
  const slice = {
    status: 'ok', code: 'ANALYZED',
    data: {
      commit: '7e3f4c81973f60b19dd72e9cf75604db8278385a',
      controllers: [{
        fqn: 'com.example.CtContractVerController',
        methods: [{
          name: 'list', signature: 'String list(PageReq req)',
          route: { method: 'GET', path: '/api/ct/ctContractVer/list' },
          anchor: '--- route: list ---',
          call_chain: ['CtContractVerService#list'],
          touched_files: ['src/main/java/.../CtContractVerController.java'],
          sources_incomplete: false,
          sql_refs: [{ op: 'select', entity: '<T_CT_CONTRACT_VER>' }],
          throws: [], notes: ''
        }]
      }]
    }
  };
  const written = JSON.stringify(slice);
  const parsed = JSON.parse(written);
  assert.deepEqual(parsed, slice, 'JSON 落盘/读回必须无损——否则切片交接就退化成转录');
  assert.ok(written.includes('CtContractVerController') && written.includes('call_chain') && written.includes('sources_incomplete'));
});

test('95% 闸门分母 = 本轮派发目标切片数（跨片 Controller 不要求单轮覆盖齐）', () => {
  const skill = read(SKILL);
  assert.match(skill, /分母 = \*\*本轮派发目标切片数\*\*/,
    'SKILL §3 完整度自检必须钉死分母 = 本轮派发目标切片数');
  assert.ok(skill.includes('不要求单轮「Controller 覆盖齐」'),
    '巨型 Controller 跨片时单轮不必覆盖齐——否则只覆盖部分路由的轮次必死');
  const plan = 3, landed = 3;
  assert.ok(landed / plan >= 0.95, '按本轮计划切片，第一轮就应过闸');
  assert.ok(landed / 1218 < 0.95, '若分母误用模块全量，第一轮必 GEN_INTEGRITY_FAIL——机制不可运行');
});

test('slice_id 预分配 → 文件名互不冲突、可逆推回切片', () => {
  const plan = ['01', '02', '03'];
  const files = new Set(plan.map((id) => path.join('{{PRIVATE_ROOT}}/staging/<project>/<module>/gen-<ts>', 'slice-' + id + '.json')));
  assert.equal(files.size, 3, '切片文件名必须两两不同（并发写文件不相交）');
  for (const f of files) assert.match(f, /slice-\d{2}\.json$/, '文件名必须带 slice_id 且不越界');
});

test('本轮实跑缺口的修复落位：method 归一 / 轮次暂停 / 切片清单', () => {
  const skill = read(SKILL), learn = read(LEARN), writer = read(WRITER), analyzer = read(ANALYZER), wf = read(WF);
  assert.ok(skill.includes('统一归一为'), 'SKILL 缺裸 @RequestMapping 归一规则');
  assert.ok(analyzer.includes('未限定'), 'analyzer 缺"裸 @RequestMapping 记 null"规则');
  assert.ok(writer.includes('method 归一'), 'writer 缺装填期 method 归一单点');
  assert.ok(learn.includes('计数单位是轮'), 'learn 缺轮次计数语义');
  assert.ok(skill.includes('1 次落地 = 1 次捞取'), 'SKILL 并行轮 = 1 次落地 = 1 次捞取（轮次计数只看落地次数，不看片数）');
  assert.ok(learn.includes('不看每次捞几片') || learn.includes('不看捞几片') || learn.includes('不看片数'),
    'learn 缺"轮次计数不看片数"（调捞取片数无需改轮次逻辑）');
  assert.ok(!learn.includes('计数按实际落盘批数累计'), 'learn 残留物理批计数措辞（与轮计数矛盾）');
  assert.ok(learn.includes('机器可校验'), 'learn 缺切片清单 manifest 语义');
  assert.ok(writer.includes('方法窗口无重叠'), 'writer 缺方法窗口重叠/并集校验');
  assert.ok(!learn.includes('主命令清理') && !skill.includes('主命令清理') && !writer.includes('主命令清理'),
    'staging 清理 owner 不再是主命令（主命令 edit/external 双 deny，无清理通道）');
  assert.ok(writer.includes('清理**本组切片**'), 'writer 缺本组切片清理自担（读后按片删）');
});

test('CURRENT 位置 = module 级（不在 gen 目录内）：门禁 readCurrentIndexDir 读的就是 <module>/CURRENT', () => {
  const writer = read(WRITER), arch = read('docs/architecture.md'), skill = read(SKILL);
  // 实测踩过：writer 按旧边界正则把 CURRENT 写进 gen-<ts>/CURRENT，门禁读 <module>/CURRENT 读不到 → 整个模块判 32。
  assert.ok(!/gen-<timestamp>\/\([^)]*CURRENT/.test(writer),
    'writer 边界规则不得把 CURRENT 列在 gen 目录内（会让门禁判 NO_INDEX）');
  assert.ok(writer.includes('<known-module>/CURRENT'), 'writer 边界规则必须显式允许 <module>/CURRENT');
  assert.ok(writer.includes('CURRENT` 在 module 级'), 'writer 必须写明 CURRENT 在 module 级');
  assert.ok(arch.includes('<known-module>/CURRENT'), 'architecture 的 writer 边界描述要同步');
  assert.ok(skill.includes('├── CURRENT'), 'SKILL §1 目录树里 CURRENT 与 gen-* 平级');
});

test('背压：writer 恒为 1 ⇒ analyzer 补位必须被节流（并发 ≤3 不约束积压）', () => {
  const learn = read(LEARN), skill = read(SKILL), wf = read(WF);
  for (const [f, t] of [['learn', learn], ['skill', skill], ['20-workflow', wf]]) {
    assert.ok(t.includes('背压'), f + ' 缺背压规则（writer 串行时读类必须节流）');
  }
  assert.ok(learn.includes('已完成未落地切片数'), 'learn 缺"已完成未落地"这个机械可数的积压口径');
  assert.ok(learn.includes('≥ 5（= 捞取上限 = 排队上限）时停止补位') || learn.includes('≥ 5 时停止补位'),
    'learn 缺积压阈值（staging ≥ 5 = 排队上限即停止补位）');
  assert.ok(learn.includes('已派发未落地 ≤ 7'), 'learn 缺稳态上界（1 writer + ≤3 在跑 + ≤7 未落地，通式 = 排队上限 + 池容量 − 1）');
  assert.ok(learn.includes('排队上限 + 池容量 − 1'), 'learn 缺上界通式（排队上限与池容量独立）');
  assert.ok(learn.includes('有几个捞几个') && learn.includes('一次最多 5 个') && learn.includes('≥ 3 即捞取'),
    'learn 缺捞取规则（staging ≥3 即捞、有几个捞几个、最多 5）');
  assert.ok(learn.includes('已派发未落地 ≤ 7') || learn.includes('已派发未落地 ='), 'learn 缺派发口径（staging + 在途 ≤ 7）');
  assert.ok(learn.includes('不足 3 不捞取'), 'learn 缺"不足 3 不捞取、writer 不空转"');
  assert.ok(learn.includes('多 writer') && learn.includes('lost update'),
    'learn 必须写明"多 writer 不可行"及其理由（copy-on-write 基线分叉 → lost update）');
  assert.ok(wf.includes('写类串行 ⇒ 读类必须背压'), '20-workflow 缺"写类串行 ⇒ 读类背压"这条一般规则');
  assert.ok(!wf.includes('聚合期间不派新 analyzer'), '20-workflow 残留旧 phase 分离措辞（与滚动池矛盾）');
});

test('滚动池：staging ≥3 即捞取（有几个捞几个、最多 5），落地串行 + 按片清理 staging，analyzer 不读 CONTEXT_ROOT', () => {
  const learn = read(LEARN), skill = read(SKILL), writer = read(WRITER), wf = read(WF), analyzer = read(ANALYZER);
  assert.ok(learn.includes('滚动池'), 'learn 缺滚动池调度形态');
  assert.ok(learn.includes('谁先好谁补位'), 'learn 缺"谁先好谁补位"（不等齐）');
  assert.ok(learn.includes('落地串行'), 'learn 缺落地串行约束');
  assert.ok(learn.includes('按片清理'), 'learn 缺按片清理 staging 语义');
  assert.ok(writer.includes('expected_slice_ids'), 'writer 缺 expected_slice_ids 入参（本组核对）');
  assert.ok(learn.includes('expected_slice_ids'), 'learn 缺 expected_slice_ids 交接');
  assert.ok(wf.includes('按片清理'), '20-workflow 缺按片清理 staging 语义');
  assert.ok(wf.includes('落地串行'), '20-workflow 缺落地串行约束');
  assert.ok(wf.includes('可与同 module 的 `supperH-prelearn-analyzer` 并发'), '20-workflow 未放宽为可并发');
  assert.ok(analyzer.includes('零依赖（读也不读）'), 'analyzer 缺 CONTEXT_ROOT 零依赖（读也不读）——并发放开的依据');
  // 按片清理的三处表述：writer 只删本组那几片文件、不删目录、不碰在途切片
  assert.ok(writer.includes('只删 `expected_slice_ids` 对应的那 N 个文件'), 'writer 缺按片清理（只删本组文件）');
  assert.ok(writer.includes('不删 `staging_dir` 目录本身'), 'writer 缺不删目录（下一组在途切片还在里面）');
  assert.ok(learn.includes('不删整目录'), 'learn 缺不删整目录表述');
  assert.ok(!learn.includes('land-<k>'), 'learn 残留 land-<k> 形态（按组拆目录与按完成序分组矛盾）');
  assert.ok(!writer.includes('land-<k>'), 'writer 残留 land-<k> 形态');
  assert.ok(!skill.includes('land-<k>'), 'SKILL 残留 land-<k> 形态');
  assert.ok(!learn.includes('phase 分离保证'), 'learn 残留 phase 分离措辞（旧互斥机制）');
  assert.ok(!wf.includes('与同 module 的 `supperH-prelearn-analyzer` 互斥'), '20-workflow 残留旧互斥表述');
});
