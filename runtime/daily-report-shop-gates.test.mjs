import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WAITING_OPERATOR_ACCOUNT,
  WAITING_OPERATOR_ACCOUNT_SHOPS,
  GATE_SCOPE,
  isWaitingOperatorAccountShop,
  isWaitingOperatorAccountStatus,
  waitingOperatorAccountRecord,
  waitingOperatorAccountShops,
} from './daily-report-shop-gates.mjs';

test('日报账号阻断登记：名单里的每一家都进入可恢复等待状态', () => {
  assert.equal(GATE_SCOPE, 'daily-report');
  // ⚠️ **刻意不断言名单长度**：这张表 2026-10-05 被用户清空了（销售1部要全跑）。
  // 写死 `6` 的话，清空那天这条会假红，而清空是**期望形态**不是故障；
  // 写死 `0` 更糟 —— 那样「名单非空」这个分支在现实里就永远没被考过。
  // 所以这里守的是**机制**：名单非空时，每一家都必须能被这套闸门正确识别与描述。
  assert.deepEqual(waitingOperatorAccountShops(), [...WAITING_OPERATOR_ACCOUNT_SHOPS]);
  for (const shop of WAITING_OPERATOR_ACCOUNT_SHOPS) {
    assert.equal(isWaitingOperatorAccountShop(shop), true);
    const record = waitingOperatorAccountRecord(shop);
    assert.equal(record.status, 'waiting');
    assert.equal(record.state, WAITING_OPERATOR_ACCOUNT);
    assert.equal(record.resumable, true);
    assert.equal(record.failedStage, 'shop-report');
    assert.equal(isWaitingOperatorAccountStatus(record), true);
  }
  // 机制自证：**负样本**必须在名单为空时也照样成立 ——
  // 否则「名单恰好为空」会让上面那个循环变成一次都没跑过的空检查
  // （坑：空结果不能被读成「没问题」）。
  assert.equal(isWaitingOperatorAccountShop('不存在的店'), false,
    '不在名单里的店不该被判等待（这条与名单是否为空无关，必须恒真）');
  assert.equal(waitingOperatorAccountRecord('不存在的店'), null,
    '不在名单里的店不该有等待记录（同上）');
});

test('日报账号阻断登记：未知店铺与普通失败不被误判为等待', () => {
  assert.equal(isWaitingOperatorAccountShop('不存在的店'), false);
  assert.equal(waitingOperatorAccountRecord('不存在的店'), null);
  assert.equal(isWaitingOperatorAccountStatus({ status: 'failed', failedStage: 'shop-report' }), false);
});
