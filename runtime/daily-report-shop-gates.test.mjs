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

test('日报账号阻断登记：6 家店进入可恢复等待状态', () => {
  assert.equal(GATE_SCOPE, 'daily-report');
  assert.equal(WAITING_OPERATOR_ACCOUNT_SHOPS.length, 6);
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
});

test('日报账号阻断登记：未知店铺与普通失败不被误判为等待', () => {
  assert.equal(isWaitingOperatorAccountShop('不存在的店'), false);
  assert.equal(waitingOperatorAccountRecord('不存在的店'), null);
  assert.equal(isWaitingOperatorAccountStatus({ status: 'failed', failedStage: 'shop-report' }), false);
});
