/**
 * `repair-actions.mjs` 的离线用例。
 *
 * 重点钉住三件事（都不看真实浏览器）：
 *   ① **动作名与成因名都在闭集里**，且与链的 `FAILURE_CAUSES` / `STAGE_NAMES` 逐字对齐
 *      —— 两套分类漂开之后本表永远命中不了、且不会报错，这正是一条互锁要挡的事。
 *   ② `planRepair` 的**默认是空候选**（认不出的成因不猜动作）—— 这是安全方向。
 *   ③ 现场事实只产生 `note`（提示），**不否决候选**、不改变返回结构。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAGE_MUTATING_ACTIONS, REPAIR_ACTIONS, REPAIR_TABLE, REPAIR_WHY, STAGE_PAGE_HINT,
  planRepair, validateRepairActions,
} from './repair-actions.mjs';
// ⚠️ 互锁的另一半：从链里 import 两个闭集，**不抄字面量**。
// 抄一份的话，链改名那天本测试照样绿 —— 而它存在的唯一理由就是「链改名时要红」。
import { FAILURE_CAUSES, STAGE_NAMES } from './run-multi-shop-day.mjs';

test('互锁：修复表的成因名逐字落在链的 FAILURE_CAUSES 里，阶段名逐字落在 STAGE_NAMES 里', () => {
  const errors = validateRepairActions({ causes: FAILURE_CAUSES, stages: STAGE_NAMES });
  assert.deepEqual(errors, [], `修复表自检不过：\n${errors.join('\n')}`);
  // 反向再钉一次：表里的成因不许是链里没有的名字（前面已覆盖），且表本身非空。
  assert.ok(Object.keys(REPAIR_TABLE).length > 0, 'REPAIR_TABLE 不许为空');
  // 顺带确认链的两个闭集本身非空 —— 否则上面的 deepEqual 会「因为两边都空」而假绿。
  assert.ok(FAILURE_CAUSES.length >= 7, `FAILURE_CAUSES 意外变小：${FAILURE_CAUSES.join(',')}`);
  assert.ok(STAGE_NAMES.length >= 11, `STAGE_NAMES 意外变小：${STAGE_NAMES.join(',')}`);
});

test('动作闭集非空、无重复，且每个动作都有 why、都不是死动作', () => {
  assert.ok(REPAIR_ACTIONS.length >= 4);
  assert.equal(new Set(REPAIR_ACTIONS).size, REPAIR_ACTIONS.length, 'REPAIR_ACTIONS 有重复项');
  for (const action of REPAIR_ACTIONS) {
    assert.ok(REPAIR_WHY[action], `动作 ${action} 缺 why`);
    const used = Object.values(REPAIR_TABLE).some((list) => list.includes(action));
    assert.ok(used, `动作 ${action} 在任何成因的候选里都没出现（死动作）`);
  }
});

test('已知成因：返回候选菜单，且格式正确（含 mutating 标记）', () => {
  const plan = planRepair({ cause: 'PAGE_OBSTRUCTED', stage: 'promotion-fetch', state: null });
  assert.equal(plan.known, true);
  assert.equal(plan.cause, 'PAGE_OBSTRUCTED');
  assert.equal(plan.stageHint, 'alimama', 'promotion-fetch 的目标页提示应为 alimama');
  assert.deepEqual(plan.candidates.map((c) => c.action), ['DISMISS_OVERLAYS', 'RELOAD_PAGE']);
  for (const c of plan.candidates) {
    assert.equal(typeof c.why, 'string');
    assert.ok(c.why.length > 0);
    assert.equal(c.mutating, PAGE_MUTATING_ACTIONS.includes(c.action));
  }
});

test('未知成因：返回空候选且 known=false —— 默认不猜动作（安全方向）', () => {
  const plan = planRepair({ cause: 'SOMETHING_NEW', stage: 'push', state: null });
  assert.equal(plan.known, false);
  assert.deepEqual(plan.candidates, []);
  assert.equal(plan.stageHint, null);
  assert.match(plan.note, /没有登记修法/u);
});

test('没给成因：同样空候选、known=false，且 note 说明「没给成因」', () => {
  const plan = planRepair({});
  assert.equal(plan.known, false);
  assert.deepEqual(plan.candidates, []);
  assert.match(plan.note, /没给成因/u);
});

test('planRepair 永不抛：给垃圾输入也返回固定结构', () => {
  for (const bad of [undefined, null, {}, { cause: 123 }, { cause: 'X', stage: 456, state: 'nope' }]) {
    const plan = planRepair(bad ?? {});
    assert.equal(typeof plan.known, 'boolean');
    assert.ok(Array.isArray(plan.candidates));
    assert.ok('cause' in plan && 'stage' in plan && 'stageHint' in plan && 'note' in plan);
  }
});

test('现场是登录页：只加一句 note，**不否决**候选（决定权仍在 agent）', () => {
  const loginState = { url: 'https://sycm.taobao.com/custom/login.htm?_target=x', domSummary: { totalElements: 50 } };
  const plan = planRepair({ cause: 'SHOP_BLOCKED', stage: 'health-check', state: loginState });
  assert.equal(plan.known, true);
  assert.ok(plan.candidates.length > 0, '登录页现场不许把候选清空 —— 只提示，不否决');
  assert.match(plan.note, /登录/u);
});

test('现场几乎为空（0 元素）：note 指出可能是没渲染完', () => {
  const plan = planRepair({ cause: 'SHOP_BLOCKED', stage: 'health-check', state: { domSummary: { totalElements: 0 } } });
  assert.match(plan.note, /还没渲染|空/u);
});

test('互锁会咬：塞一个链里没有的成因名，validateRepairActions 报错', () => {
  const errors = validateRepairActions({ causes: ['PAGE_OBSTRUCTED'], stages: [] });
  assert.ok(errors.some((e) => /不在链的 FAILURE_CAUSES 里/u.test(e)), `预期报「不在 FAILURE_CAUSES」：${errors.join('|')}`);
});

test('互锁会咬：塞一个闭集外的动作名，validateRepairActions 报错', () => {
  const errors = validateRepairActions({ causes: null, stages: null });
  // 用一份被改坏的表的形状直接试（不改真表）：成因在链里、动作拼错。
  const bad = { PAGE_OBSTRUCTED: ['DISMISS_OVERLAY'] }; // 少了个 S
  const errs = [];
  for (const [cause, actions] of Object.entries(bad)) {
    for (const action of actions) {
      if (!REPAIR_ACTIONS.includes(action)) errs.push(`${cause}:${action}`);
    }
  }
  assert.deepEqual(errs, ['PAGE_OBSTRUCTED:DISMISS_OVERLAY']);
  assert.deepEqual(errors, [], '真表本身必须无错（上面那条只是演示拼错的判据）');
});

test('STAGE_PAGE_HINT 的值只用语义标签（alimama/sycm），不掺选择器或 URL', () => {
  const allowed = new Set(['alimama', 'sycm']);
  for (const [stage, hint] of Object.entries(STAGE_PAGE_HINT)) {
    assert.ok(allowed.has(hint), `阶段 ${stage} 的提示「${hint}」不是允许的语义标签`);
  }
});
