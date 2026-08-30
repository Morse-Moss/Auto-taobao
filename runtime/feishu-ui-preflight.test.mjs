import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFeishuPreflightReceipt,
  classifyFeishuUiSnapshot,
  resumeFeishuUi,
  runFeishuUiPreflight,
  selectFeishuTarget,
} from './feishu-ui-preflight.mjs';

const expected = {
  appToken: 'app123',
  tableId: 'tblHistory',
  automationLabel: 'competitor-dashboard',
  browserId: 'edge',
};

const readySnapshot = {
  pageUrl: 'https://tenant.feishu.cn/base/app123?table=tblHistory&view=vew1',
  loginMarkers: [],
  securityMarkers: [],
  permissionMarkers: [],
  baseVisible: true,
  tableVisible: true,
  dashboardVisible: true,
  editControls: {
    dashboardEdit: { present: true, disabled: false },
  },
};

function fakeRequestFactory({ health, targets, snapshot, replacementTarget } = {}) {
  const calls = [];
  let targetCalls = 0;
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/health') return health ?? { status: 'ok', connected: true, browser: { id: 'edge' } };
    if (path === '/targets') {
      targetCalls += 1;
      return targetCalls > 1 && replacementTarget ? [replacementTarget] : (targets ?? []);
    }
    if (path.startsWith('/eval')) return { value: snapshot };
    if (path.startsWith('/navigate')) return { ok: true };
    throw new Error(`Unexpected proxy path: ${path}`);
  };
  return { request, calls };
}

test('selects exactly one labeled target for the authorized Base table', () => {
  const result = selectFeishuTarget([
    { targetId: 'other', type: 'page', url: 'https://tenant.feishu.cn/base/other?table=tblHistory', automationLabel: expected.automationLabel },
    { targetId: 'target-1', type: 'page', url: 'https://tenant.feishu.cn/base/app123?table=tblHistory', automationLabel: expected.automationLabel },
  ], expected);
  assert.equal(result.targetId, 'target-1');
  assert.throws(() => selectFeishuTarget([
    { targetId: 'a', type: 'page', url: 'https://tenant.feishu.cn/base/app123?table=tblHistory', automationLabel: expected.automationLabel },
    { targetId: 'b', type: 'page', url: 'https://tenant.feishu.cn/base/app123?table=tblHistory', automationLabel: expected.automationLabel },
  ], expected), (error) => error.code === 'FEISHU_TARGET_AMBIGUOUS');
});

test('classifies the automated session login wall as a blocking login requirement', () => {
  const result = classifyFeishuUiSnapshot({
    ...readySnapshot,
    loginMarkers: ['登录/注册'],
  }, expected);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reasonCode, 'FEISHU_LOGIN_REQUIRED');
  assert.match(result.remediation, /自动化.*浏览器.*profile.*登录/iu);
});

test('classifies disabled dashboard editing controls as a permission block', () => {
  const result = classifyFeishuUiSnapshot({
    ...readySnapshot,
    editControls: { dashboardEdit: { present: true, disabled: true } },
  }, expected);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reasonCode, 'FEISHU_PERMISSION_REQUIRED');
});

test('accepts an exact target when the base selector is unavailable but the dashboard is usable', () => {
  const result = classifyFeishuUiSnapshot({
    ...readySnapshot,
    baseVisible: false,
  }, expected);
  assert.equal(result.status, 'READY');
});

test('does not confuse the user browser permission with the automation browser context', async () => {
  const fake = fakeRequestFactory({
    health: { status: 'ok', connected: true, browser: { id: 'browser-service' } },
    targets: [{ targetId: 'target-1', type: 'page', url: readySnapshot.pageUrl, automationLabel: expected.automationLabel }],
    snapshot: readySnapshot,
  });
  const result = await runFeishuUiPreflight({ proxy: 'http://proxy', expected, request: fake.request });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reasonCode, 'FEISHU_BROWSER_CONTEXT_MISMATCH');
  assert.equal(fake.calls.some(({ path }) => path.startsWith('/eval')), false);
});

test('builds sanitized preflight evidence without credentials or page dumps', () => {
  const receipt = buildFeishuPreflightReceipt({
    checkedAt: '2026-08-28T00:00:00.000Z',
    classification: { status: 'BLOCKED', reasonCode: 'FEISHU_LOGIN_REQUIRED', reason: '登录/注册 cookie=secret' },
    health: { browser: { id: 'edge' }, contextId: 'ctx-1' },
    target: { targetId: 'target-1', url: readySnapshot.pageUrl, automationLabel: expected.automationLabel },
    expected,
    visibleText: 'Authorization: Bearer secret localStorage password=secret',
  });
  const text = JSON.stringify(receipt);
  assert.equal(receipt.preflight.reasonCode, 'FEISHU_LOGIN_REQUIRED');
  assert.doesNotMatch(text, /cookie|token|password|authorization|localStorage|Bearer|secret/iu);
  assert.doesNotMatch(text, /登录\/注册/iu);
});

test('resume rediscoveries and refreshes without reusing the old target id', async () => {
  const fake = fakeRequestFactory({
    targets: [{ targetId: 'old-target', type: 'page', url: readySnapshot.pageUrl, automationLabel: expected.automationLabel }],
    replacementTarget: { targetId: 'new-target', type: 'page', url: readySnapshot.pageUrl, automationLabel: expected.automationLabel },
    snapshot: readySnapshot,
  });
  const result = await resumeFeishuUi({ proxy: 'http://proxy', expected, refresh: true, request: fake.request });
  assert.equal(result.status, 'READY');
  assert.equal(result.target.targetId, 'new-target');
  assert.ok(fake.calls.some(({ path }) => path.startsWith('/navigate')));
  assert.ok(fake.calls.filter(({ path }) => path === '/targets').length >= 2);
});
