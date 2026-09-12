// tests/git-delivery.test.mjs
// resolveGitDelivery() 的缺省与 fail-safe 方向（docs/architecture.md §10.10）。
// 这一层必须单独锁：CLI 用例（--preflight）只覆盖"合法 L2 → 递出正确值"这一条路，
// 而这里要钉住的是三条容易被写反的判断：
//   ① 没写 git 段 ≠ 出错，而是最安全的 `none`（不能让模型自己推断"没写该算什么"）；
//   ② 非法值折叠的方向必须是"更安全"，且**原值要留在 declared 里**——静默改用户意图
//      与静默放行同样糟，所以既不能抛错中断，也不能装作没看见；
//   ③ `push-pr` 是合法声明但一期不支持：解析层只标 supported:false，
//      拒绝动作在执行者那一层，不在这里偷偷改写成 none。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGitDelivery, GIT_SNAPSHOT_REF_PREFIX } from '../scripts/resolve-project.mjs';

test('整段缺失 / 非对象 / 空白值 → 全走最安全缺省（none + 7 天）', () => {
  for (const doc of [undefined, null, {}, { git: null }, { git: [] }, { git: {} },
                    { git: { deliveryMode: '   ' } }, { git: { deliveryMode: 42 } }]) {
    const r = resolveGitDelivery(doc);
    assert.equal(r.mode, 'none', JSON.stringify(doc));
    assert.equal(r.snapshotTtlDays, 7, JSON.stringify(doc));
    assert.equal(r.declared, null, JSON.stringify(doc));
    assert.equal(r.clamped, false, JSON.stringify(doc));
    assert.equal(r.supported, true, JSON.stringify(doc));
    assert.equal(r.refPrefix, GIT_SNAPSHOT_REF_PREFIX);
  }
});

test('三个合法值原样递出；push-pr 标 supported:false 但不被改写', () => {
  assert.equal(resolveGitDelivery({ git: { deliveryMode: 'none' } }).mode, 'none');
  const lc = resolveGitDelivery({ git: { deliveryMode: 'local-commit' } });
  assert.equal(lc.mode, 'local-commit');
  assert.equal(lc.supported, true);
  const pr = resolveGitDelivery({ git: { deliveryMode: 'push-pr' } });
  assert.equal(pr.mode, 'push-pr', '声明必须原样保留，拒绝动作在执行者层做，不在解析层偷改');
  assert.equal(pr.supported, false);
});

test('非法值折叠到 none 且 clamped:true + declared 留原值（折叠方向 = 更安全）', () => {
  for (const raw of ['force-push', 'None', 'NONE', 'local_commit', 'push']) {
    const r = resolveGitDelivery({ git: { deliveryMode: raw } });
    assert.equal(r.mode, 'none', `${raw} 必须落到最安全档，不能"近似匹配"到别的档`);
    assert.equal(r.clamped, true, `${raw} 得让上层能看出"用户写了但不被认"`);
    assert.equal(r.declared, raw, JSON.stringify(r));
  }
});

test('snapshotTtlDays：0 合法（= 不自动清扫）；越界/非整数回 7', () => {
  assert.equal(resolveGitDelivery({ git: { snapshotTtlDays: 0 } }).snapshotTtlDays, 0);
  assert.equal(resolveGitDelivery({ git: { snapshotTtlDays: 365 } }).snapshotTtlDays, 365);
  for (const bad of [-1, 366, 7.5, '7', NaN, null, true]) {
    assert.equal(resolveGitDelivery({ git: { snapshotTtlDays: bad } }).snapshotTtlDays, 7,
      `${String(bad)} 不是合法 TTL，必须回缺省而不是原样透传`);
  }
});
