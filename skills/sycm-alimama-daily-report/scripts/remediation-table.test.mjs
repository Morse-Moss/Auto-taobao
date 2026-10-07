import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REMEDIATION_ACTIONS,
  REMEDIATION_TABLE,
  lookupRemediation,
  triageFailures,
  validateRemediationTable,
} from './remediation-table.mjs';
// 互锁的另一半：成因闭集。**必须从生产代码 import**，不许在这里手抄一份 ——
// 手抄那天两边就会漂开，而漂开的症状是「查表永远命中不了兜底」，不报错。
import { FAILURE_CAUSES } from './run-multi-shop-day.mjs';

test('表的键与生产代码的成因闭集逐字一致（漏一条 = 那一类永远走兜底叫人）', () => {
  const tableKeys = Object.keys(REMEDIATION_TABLE).sort();
  const causeKeys = [...FAILURE_CAUSES].sort();
  assert.deepEqual(tableKeys, causeKeys,
    `表的键与 FAILURE_CAUSES 漂开了。表里多：${tableKeys.filter((k) => !causeKeys.includes(k))}；`
    + `表里缺：${causeKeys.filter((k) => !tableKeys.includes(k))}`);
});

test('加载期自检：本仓现表零错误', () => {
  assert.deepEqual(validateRemediationTable(), []);
});

test('自检真的会咬：动作名拼错要报', () => {
  const bad = { X: { action: 'RETRY', notifyLevel: 'human', why: 'w', verify: 'v' } };
  const errors = validateRemediationTable(bad);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /动作名「RETRY」不在闭集/);
});

test('自检真的会咬：notifyLevel 写错要报（写错会让「该叫人」变「不叫人」）', () => {
  const bad = { X: { action: 'HUMAN', notifyLevel: 'none', why: 'w', verify: 'v' } };
  const errors = validateRemediationTable(bad);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /notifyLevel「none」/);
});

test('自检真的会咬：缺 why 或缺 verify 都要报（缺 verify 的自动处置＝自证）', () => {
  assert.equal(validateRemediationTable({ X: { action: 'HUMAN', notifyLevel: 'human', verify: 'v' } }).length, 1);
  assert.equal(validateRemediationTable({ X: { action: 'HUMAN', notifyLevel: 'human', why: 'w' } }).length, 1);
});

test('查表：登记过的成因返回 known=true 且动作来自闭集', () => {
  for (const cause of FAILURE_CAUSES) {
    const plan = lookupRemediation(cause);
    assert.equal(plan.known, true, `${cause} 应已登记`);
    assert.ok(REMEDIATION_ACTIONS.includes(plan.action), `${cause} 的动作 ${plan.action} 不在闭集`);
    assert.ok(['silent', 'human'].includes(plan.notifyLevel));
    assert.ok(plan.why && plan.verify);
  }
});

test('查表 fail-closed：未登记成因（含 null/undefined）一律交给人、不抛', () => {
  for (const cause of ['NO_SUCH_CAUSE', null, undefined, '']) {
    const plan = lookupRemediation(cause);
    assert.equal(plan.action, 'HUMAN');
    assert.equal(plan.notifyLevel, 'human');
    assert.equal(plan.known, false);
  }
});

test('分诊：DUPLICATE_TARGET 进 silent（不打扰人），其余进 needsHuman', () => {
  const failed = [
    { key: '网林天猫', record: {}, cause: 'DUPLICATE_TARGET' },
    { key: '盖文淘宝', record: {}, cause: 'DUPLICATE_TARGET' },
    { key: '科塔淘宝', record: {}, cause: 'STAGE_FAILED' },
    { key: '网林天猫', record: {}, cause: 'NEEDS_LOGIN' },
  ];
  const out = triageFailures(failed);
  assert.equal(out.total, 4);
  assert.equal(out.silentCount, 2);
  assert.equal(out.needsHumanCount, 2);
  assert.deepEqual(out.silent.map((r) => r.key), ['网林天猫', '盖文淘宝']);
  assert.deepEqual(out.needsHuman.map((r) => r.key), ['科塔淘宝', '网林天猫']);
  for (const row of out.needsHuman) assert.ok(row.plan.why && row.plan.verify);
});

test('分诊空输入不崩，返回全零', () => {
  const out = triageFailures([]);
  assert.deepEqual(out, { silent: [], needsHuman: [], total: 0, silentCount: 0, needsHumanCount: 0 });
});

test('分诊对未登记成因也 fail-closed 进 needsHuman（不是 silent）', () => {
  const out = triageFailures([{ key: 'X', record: {}, cause: 'BRAND_NEW_THING' }]);
  assert.equal(out.silentCount, 0);
  assert.equal(out.needsHumanCount, 1);
  assert.equal(out.needsHuman[0].plan.known, false);
});

test('安全底座：STAGE_FAILED（兜底）必须在表里且是叫人 —— 新问题就该出现在这里', () => {
  const plan = lookupRemediation('STAGE_FAILED');
  assert.equal(plan.known, true);
  assert.equal(plan.notifyLevel, 'human');
});

test('duplicate 那条刻意是 silent：每天为「今天已经跑过了」喊狼来了就是磨注意力', () => {
  const plan = lookupRemediation('DUPLICATE_TARGET');
  assert.equal(plan.notifyLevel, 'silent');
});

test('平台无此行那条也是 silent（2026-10-06 加）：它是不叫人**也**不驻留的判据', () => {
  const plan = lookupRemediation('SOURCE_NO_ROW_FOR_DATE');
  assert.equal(plan.known, true);
  assert.equal(plan.notifyLevel, 'silent');
  // `notifyLevel: 'silent'` 在本仓是**两件事**共用的一条判据：不分诊给人 + 不驻留
  //（后者见 `run-multi-shop-day.mjs` 的 `buildRepairRequest.noActionRequired` 与
  //  `runtime/hold-and-resume-plan.mjs` 的 `unfixableShopsOf`）。落成 human 的代价
  // 不止一条告警，还有每天早上白挂几小时 —— 所以这一条不许被「顺手改成 human」。
  assert.match(plan.why, /变不出来/u, '要说清「谁都变不出这一行」，否则下一个人会以为可以重试出来');
});

test('飞书缺行那条是 human（与「平台没出数」那条相反）：一个能补、一个变不出来', () => {
  // 两条成因长得像（都表现为「询单量那一格是空的」），处置**相反** —— 这正是它们必须分开的原因：
  //   · SOURCE_NO_ROW_FOR_DATE —— 平台那一天没有出数，谁都不用动 ⇒ silent（不叫人**也**不驻留）；
  //   · INQUIRY_ROW_MISSING    —— 飞书那张表缺这一天的行，补一行就好 ⇒ human（要人看一眼，
  //     为什么「建行」那一步没成功）。
  // 反过来（把它也标成 silent）的代价是：自己的修复步骤失败了，却静默放掉，谁也发现不了。
  const plan = lookupRemediation('INQUIRY_ROW_MISSING');
  assert.equal(plan.known, true);
  assert.equal(plan.notifyLevel, 'human');
  assert.notEqual(plan.notifyLevel, lookupRemediation('SOURCE_NO_ROW_FOR_DATE').notifyLevel,
    '两条的处置不许一样（一样就没必要分成两类）');
  assert.match(plan.why, /建|补/u, '要说清「这一条是可以补的」，否则下一个人会当成无解缺口放掉');
  assert.match(plan.verify, /恰好一行/u, '判定要可核对：建完重跑后该日该店恰好一行');
});
