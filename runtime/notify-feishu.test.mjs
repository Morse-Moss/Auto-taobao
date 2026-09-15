import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTokenProvider,
  deliverAlert,
  formatLocalTime,
  redactSensitive,
  renderAlertText,
} from './notify-feishu-core.mjs';
import {
  main,
  parseAlertJson,
  parseNotifyArgs,
  resolveNotifyConfig,
} from './notify-feishu.mjs';

const APP_ID = 'cli_test_app_id';
const APP_SECRET = 'app-secret-that-must-never-be-rendered';
const TOKEN_ENDPOINT = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function tokenOk(token = 't-1', expire = 7200) {
  return () => jsonResponse(200, { code: 0, msg: 'ok', tenant_access_token: token, expire });
}

function messageOk(messageId = 'om_1') {
  return () => jsonResponse(200, { code: 0, msg: 'success', data: { message_id: messageId } });
}

function scriptedFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const handler = handlers.shift();
    if (!handler) throw new Error(`unexpected fetch call: ${url}`);
    return handler(String(url), init);
  };
  fetchImpl.calls = calls;
  fetchImpl.remaining = () => handlers.length;
  return fetchImpl;
}

function providerOf(fetchImpl, now = () => Date.now()) {
  return createTokenProvider({ fetchImpl, appId: APP_ID, appSecret: APP_SECRET, now });
}

const sampleAlert = Object.freeze({
  version: 'xws-sku-operator-alert-v1',
  alertId: 'xws-login-1234',
  status: 'OPEN',
  severity: 'HIGH',
  type: 'XWS_LOGIN_REQUIRED',
  createdAt: '2026-09-15T03:00:00.000Z',
  source: { productId: '678598686014', mainRecordId: 'rec1', unknownField: 'ignored' },
  reason: 'Xiaowangshen login is required',
  action: '请在同一个 Edge 用户配置中登录小旺神，登录完成后重新运行采集预检。',
  evidence: { authStatusFile: 'xws-sku-auth-status-1.json' },
});

// ---------------------------------------------------------------------------
// 渲染：人话、不吞字段、不泄凭据
// ---------------------------------------------------------------------------

test('renderAlertText 把已知类型翻成人话，并带上「下一步」', () => {
  const rendered = renderAlertText(sampleAlert);
  assert.match(rendered, /小旺神登录已失效/u);
  assert.match(rendered, /下一步：请在同一个 Edge 用户配置中登录小旺神/u);
  assert.match(rendered, /商品ID：678598686014/u);
  assert.match(rendered, /证据：xws-sku-auth-status-1\.json/u);
  assert.match(rendered, /告警编号：xws-login-1234/u);
  assert.ok(rendered.startsWith('【需要处理】'));
});

test('renderAlertText 对缺失字段整行不输出，而不是渲染成 undefined', () => {
  const rendered = renderAlertText({ type: 'XWS_LOGIN_REQUIRED' });
  assert.doesNotMatch(rendered, /undefined|null|NaN/u);
  assert.doesNotMatch(rendered, /商品ID/u);
  assert.match(rendered, /小旺神登录已失效/u);
});

test('renderAlertText 不把未知字段透传出去（避免把内部结构抄进通知）', () => {
  const rendered = renderAlertText(sampleAlert);
  assert.doesNotMatch(rendered, /unknownField/u);
  assert.doesNotMatch(rendered, /ignored/u);
});

test('renderAlertText 对 INFO 用「提示」而不是「需要处理」', () => {
  const rendered = renderAlertText({ type: 'XWS_LOGIN_RESOLVED', severity: 'INFO' });
  assert.ok(rendered.startsWith('【提示】'));
  assert.match(rendered, /小旺神登录已恢复/u);
});

test('redactSensitive 遮住应用 ID、Bearer 与长令牌', () => {
  const raw = `app=cli_a96ee8749078dbcf auth=Bearer abc.def-ghi token=${'A'.repeat(40)}`;
  const masked = redactSensitive(raw);
  assert.doesNotMatch(masked, /cli_a96ee8749078dbcf/u);
  assert.doesNotMatch(masked, /Bearer abc/u);
  assert.doesNotMatch(masked, new RegExp(`A{40}`, 'u'));
  assert.match(masked, /\[redacted-app-id\]/u);
  assert.match(masked, /\[redacted-token\]/u);
});

test('redactSensitive 不能吞掉我们自己的告警编号（带连字符的标识要留着）', () => {
  // 回归用例：真实入口干跑时发现 alertId 被当成令牌遮掉了，
  // 而编号正是运营与服务方对账时唯一能引用的东西。
  const alertId = 'xws-login-678598686014-20260915T030000';
  assert.match(renderAlertText({ ...sampleAlert, alertId, createdAt: undefined }), new RegExp(`${alertId}`, 'u'));
});

test('时间渲染成本机人读形式，而不是容易被读成凌晨的 ISO Z 形式', () => {
  const rendered = renderAlertText(sampleAlert);
  assert.doesNotMatch(rendered, /T03:00:00\.000Z/u);
  assert.match(rendered, /时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u);
  assert.equal(formatLocalTime(''), '', '空值不编时间');
  assert.equal(formatLocalTime('不是日期'), '不是日期', '解析不出来就原样返回');
});

// ---------------------------------------------------------------------------
// token：常驻进程下必须带过期时间
// ---------------------------------------------------------------------------

test('token 在有效期内复用，不再请求', async () => {
  const fetchImpl = scriptedFetch([tokenOk('t-cached')]);
  const provider = providerOf(fetchImpl);
  assert.equal(await provider.get(), 't-cached');
  assert.equal(await provider.get(), 't-cached');
  assert.equal(fetchImpl.calls.length, 1);
});

test('token 过期后重新获取', async () => {
  let clock = 1_000_000;
  const fetchImpl = scriptedFetch([tokenOk('t-1', 3600), tokenOk('t-2', 3600)]);
  const provider = providerOf(fetchImpl, () => clock);
  assert.equal(await provider.get(), 't-1');
  clock += 3600 * 1000 - 10 * 60 * 1000;
  assert.equal(await provider.get(), 't-1', '距过期 10 分钟（> 5 分钟提前量）时应仍复用');
  clock += 6 * 60 * 1000;
  assert.equal(await provider.get(), 't-2');
  assert.equal(fetchImpl.calls.length, 2);
});

test('取 token 失败时抛出可读错误，且错误里不含 secret', async () => {
  const fetchImpl = scriptedFetch([
    () => jsonResponse(401, { code: 10003, msg: 'invalid app_secret' }),
  ]);
  const provider = providerOf(fetchImpl);
  await assert.rejects(() => provider.get(), (error) => {
    assert.match(error.message, /tenant_access_token 获取失败/u);
    assert.doesNotMatch(error.message, new RegExp(APP_SECRET, 'u'));
    return true;
  });
});

// ---------------------------------------------------------------------------
// 投递：主通道成功 / 认证重试一次 / 缺 scope / 降级兜底 / 全失败
// ---------------------------------------------------------------------------

const baseArgs = {
  alert: sampleAlert,
  recipient: 'ops@example.com',
  recipientType: 'email',
};

// 收据里会带 skipped 的通道记录（「没配」而不是「试过又失败」），
// 断言「重试了几次」「试了几条路」时只数真的打出去的那些。
function attempted(receipt) {
  return receipt.attempts.filter((attempt) => !attempt.skipped);
}

test('主通道成功 → SENT/app，且请求体带 receive_id_type 与文本消息', async () => {
  const fetchImpl = scriptedFetch([tokenOk(), messageOk('om_42')]);
  const receipt = await deliverAlert({
    ...baseArgs,
    fetchImpl,
    tokenProvider: providerOf(fetchImpl),
  });
  assert.equal(receipt.status, 'SENT');
  assert.equal(receipt.channel, 'app');
  assert.equal(receipt.alertId, 'xws-login-1234');
  assert.equal(receipt.attempts.length, 1);
  assert.equal(receipt.attempts[0].messageId, 'om_42');
  assert.match(fetchImpl.calls[1].url, /receive_id_type=email/u);
  const body = JSON.parse(fetchImpl.calls[1].init.body);
  assert.equal(body.receive_id, 'ops@example.com');
  assert.match(body.content, /小旺神登录已失效/u);
});

test('token 过期（401）会清缓存重取一次，第二次成功', async () => {
  const fetchImpl = scriptedFetch([
    tokenOk('t-old'),
    () => jsonResponse(401, { code: 99991668, msg: 'token expired' }),
    tokenOk('t-new'),
    messageOk(),
  ]);
  const receipt = await deliverAlert({
    ...baseArgs,
    fetchImpl,
    tokenProvider: providerOf(fetchImpl),
  });
  assert.equal(receipt.status, 'SENT');
  assert.equal(receipt.attempts.length, 2);
  assert.equal(receipt.attempts[0].ok, false);
  assert.equal(receipt.attempts[0].retryable, true);
  assert.equal(fetchImpl.calls.length, 4);
});

test('缺 scope（99991672）不重试，并指出「开权限 + 重新发布版本」', async () => {
  const fetchImpl = scriptedFetch([
    tokenOk(),
    () => jsonResponse(400, { code: 99991672, msg: 'Access denied' }),
  ]);
  const receipt = await deliverAlert({
    ...baseArgs,
    fetchImpl,
    tokenProvider: providerOf(fetchImpl),
  });
  assert.equal(receipt.status, 'FAILED');
  // 断言只针对「真的打出去的尝试」：收据里还会带一条 skipped 的兜底通道记录，
  // 那条是「没配」而不是「试过又失败」，混进计数里会把断言说得比实际更强。
  assert.equal(attempted(receipt).length, 1, '缺 scope 重试没有意义，不应重试');
  assert.equal(receipt.attempts.some((attempt) => attempt.skipped === 'NO_WEBHOOK'), true);
  assert.match(receipt.attempts[0].hint, /im:message:send_as_bot/u);
  assert.match(receipt.attempts[0].hint, /发布/u);
  assert.equal(fetchImpl.calls.length, 2);
});

test('主通道失败 → 降级群机器人，收据保留主通道的失败原因', async () => {
  const fetchImpl = scriptedFetch([
    tokenOk(),
    () => jsonResponse(400, { code: 99991672, msg: 'Access denied' }),
    () => jsonResponse(200, { code: 0, msg: 'success' }),
  ]);
  const receipt = await deliverAlert({
    ...baseArgs,
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx',
    fetchImpl,
    tokenProvider: providerOf(fetchImpl),
  });
  assert.equal(receipt.status, 'SENT');
  assert.equal(receipt.channel, 'webhook');
  assert.deepEqual(attempted(receipt).map((attempt) => attempt.ok), [false, true]);
  assert.equal(receipt.attempts.some((attempt) => attempt.skipped === 'NO_FALLBACK_RECIPIENT'), true);
});

test('群机器人历史字段 StatusCode 也认', async () => {
  const fetchImpl = scriptedFetch([
    () => jsonResponse(200, { StatusCode: 0, StatusMessage: 'success' }),
  ]);
  const receipt = await deliverAlert({
    alert: sampleAlert,
    fetchImpl,
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx',
  });
  assert.equal(receipt.status, 'SENT');
  assert.equal(receipt.channel, 'webhook');
});

// ---------------------------------------------------------------------------
// 投递链第二跳：同一通道内的兜底收件人（个人失败 → 群）
// ---------------------------------------------------------------------------

test('主收件人失败 → 兜底收件人成功，收据标 app_fallback', async () => {
  const fetchImpl = scriptedFetch([
    tokenOk(),
    () => jsonResponse(400, { code: 230002, msg: 'user not in app scope' }),
    () => jsonResponse(200, { code: 0, msg: 'success', data: { message_id: 'om_group' } }),
  ]);
  const receipt = await deliverAlert({
    ...baseArgs,
    fallbackRecipient: 'oc_group_id',
    fallbackRecipientType: 'chat_id',
    fetchImpl,
    tokenProvider: providerOf(fetchImpl),
  });
  assert.equal(receipt.status, 'SENT');
  assert.equal(receipt.channel, 'app_fallback');
  assert.deepEqual(attempted(receipt).map((attempt) => [attempt.channel, attempt.ok]), [
    ['app', false],
    ['app_fallback', true],
  ]);
  assert.match(fetchImpl.calls[2].url, /receive_id_type=chat_id/u);
});

test('兜底收件人与主收件人相同 → 不重复发（只留下一条 skipped 说明）', async () => {
  const fetchImpl = scriptedFetch([
    tokenOk(),
    () => jsonResponse(400, { code: 230002, msg: 'nope' }),
  ]);
  const receipt = await deliverAlert({
    ...baseArgs,
    fallbackRecipient: baseArgs.recipient,
    fetchImpl,
    tokenProvider: providerOf(fetchImpl),
  });
  assert.equal(receipt.status, 'FAILED');
  assert.equal(receipt.attempts.some((attempt) => attempt.skipped === 'SAME_AS_PRIMARY'), true);
  assert.equal(fetchImpl.calls.length, 2, '相同收件人不该再发一次');
});

test('主收件人与兜底收件人都失败 → 再走 webhook', async () => {
  const fetchImpl = scriptedFetch([
    tokenOk(),
    () => jsonResponse(400, { code: 230002, msg: 'user unreachable' }),
    () => jsonResponse(400, { code: 230002, msg: 'chat unreachable' }),
    () => jsonResponse(200, { code: 0, msg: 'success' }),
  ]);
  const receipt = await deliverAlert({
    ...baseArgs,
    fallbackRecipient: 'oc_group_id',
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx',
    fetchImpl,
    tokenProvider: providerOf(fetchImpl),
  });
  assert.equal(receipt.status, 'SENT');
  assert.equal(receipt.channel, 'webhook');
  assert.deepEqual(attempted(receipt).map((attempt) => attempt.ok), [false, false, true]);
});

test('两个通道都失败 → FAILED，并把两条原因都写进 error', async () => {
  const fetchImpl = scriptedFetch([
    tokenOk(),
    () => jsonResponse(500, { code: 230001, msg: 'server error' }),
    () => jsonResponse(200, { code: 19021, msg: 'webhook invalid' }),
  ]);
  const receipt = await deliverAlert({
    ...baseArgs,
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx',
    fetchImpl,
    tokenProvider: providerOf(fetchImpl),
  });
  assert.equal(receipt.status, 'FAILED');
  assert.match(receipt.error, /app:/u);
  assert.match(receipt.error, /webhook:/u);
});

test('都没配置 → NOT_CONFIGURED，而不是 FAILED', async () => {
  const fetchImpl = scriptedFetch([]);
  const receipt = await deliverAlert({ alert: sampleAlert, fetchImpl });
  assert.equal(receipt.status, 'NOT_CONFIGURED');
  assert.equal(fetchImpl.calls.length, 0);
  assert.deepEqual(
    receipt.attempts.map((attempt) => attempt.skipped),
    ['NO_RECIPIENT', 'NO_FALLBACK_RECIPIENT', 'NO_WEBHOOK'],
  );
});

test('网络异常不抛出，变成一条 FAILED 收据（通知失败不能影响主流程）', async () => {
  const fetchImpl = scriptedFetch([
    tokenOk(),
    () => { throw new Error('socket hang up'); },
  ]);
  const receipt = await deliverAlert({
    ...baseArgs,
    fetchImpl,
    tokenProvider: providerOf(fetchImpl),
  });
  assert.equal(receipt.status, 'FAILED');
  assert.match(receipt.error, /socket hang up/u);
});

test('收据里不出现 app secret 与 token 明文', async () => {
  const fetchImpl = scriptedFetch([tokenOk('t-secret-value'), messageOk()]);
  const receipt = await deliverAlert({
    ...baseArgs,
    fetchImpl,
    tokenProvider: providerOf(fetchImpl),
  });
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, new RegExp(APP_SECRET, 'u'));
  assert.doesNotMatch(serialized, /t-secret-value/u);
});

// ---------------------------------------------------------------------------
// CLI 的纯逻辑
// ---------------------------------------------------------------------------

test('parseNotifyArgs 支持 --dry-run 与取值参数，未知参数报错', () => {
  assert.deepEqual(parseNotifyArgs(['--dry-run']), { dryRun: true });
  assert.deepEqual(parseNotifyArgs(['--recipient', 'a@b.com']), {
    dryRun: false,
    recipient: 'a@b.com',
  });
  assert.throws(() => parseNotifyArgs(['--nope']), /Unknown argument/u);
  assert.throws(() => parseNotifyArgs(['--recipient']), /requires a value/u);
});

test('resolveNotifyConfig 优先级：命令行 > env 文件 > 进程环境', () => {
  const config = resolveNotifyConfig({
    options: { recipient: 'cli@x.com' },
    values: {
      SYCM_NOTIFY_RECIPIENT: 'file@x.com',
      SYCM_NOTIFY_RECIPIENT_TYPE: 'open_id',
      SYCM_NOTIFY_FALLBACK_RECIPIENT: 'oc_from_file',
    },
    env: {
      SYCM_NOTIFY_RECIPIENT: 'env@x.com',
      SYCM_NOTIFY_WEBHOOK: 'https://hook/env',
      SYCM_NOTIFY_FALLBACK_RECIPIENT: 'oc_from_env',
    },
  });
  assert.equal(config.recipient, 'cli@x.com');
  assert.equal(config.recipientType, 'open_id');
  assert.equal(config.fallbackRecipient, 'oc_from_file');
  assert.equal(config.webhook, 'https://hook/env');
  const defaults = resolveNotifyConfig({});
  assert.equal(defaults.recipientType, 'email', '缺省主收件人类型是邮箱');
  assert.equal(defaults.fallbackRecipientType, 'chat_id', '缺省兜底收件人类型是群');
});

test('parseAlertJson 拒绝空值、数组与非法 JSON', () => {
  assert.deepEqual(parseAlertJson('{"a":1}'), { a: 1 });
  assert.throws(() => parseAlertJson(''), /required/u);
  assert.throws(() => parseAlertJson('[1,2]'), /must be an object/u);
  assert.throws(() => parseAlertJson('{oops'), /not valid JSON/u);
});

function fakeStdin(text) {
  return {
    isTTY: false,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, 'utf8');
    },
  };
}

function cliEnv(readImpl) {
  const output = [];
  return {
    output,
    deps: {
      env: {},
      read: readImpl,
      stdin: fakeStdin(JSON.stringify(sampleAlert)),
      write: (value) => output.push(value),
    },
  };
}

test('CLI dry-run 只渲染不发送，且不请求任何接口', async () => {
  const fetchImpl = scriptedFetch([]);
  const { deps, output } = cliEnv(() => `FEISHU_APP_ID=${APP_ID}\nFEISHU_APP_SECRET=${APP_SECRET}\n`);
  const receipt = await main(['--dry-run'], { ...deps, fetchImpl });
  assert.equal(receipt.status, 'DRY_RUN');
  assert.match(receipt.text, /小旺神登录已失效/u);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(output.length, 1);
});

test('CLI 未配置收件人 → NOT_CONFIGURED 并入 error 分支（非零退出）', async () => {
  const fetchImpl = scriptedFetch([]);
  const { deps } = cliEnv(() => `FEISHU_APP_ID=${APP_ID}\nFEISHU_APP_SECRET=${APP_SECRET}\n`);
  await assert.rejects(
    () => main([], { ...deps, fetchImpl }),
    (error) => {
      assert.equal(error.receipt.status, 'NOT_CONFIGURED');
      assert.match(error.message, /not delivered/u);
      return true;
    },
  );
});

test('CLI 走 env 文件里的收件人完成一次真实投递（注入假 fetch）', async () => {
  const fetchImpl = scriptedFetch([tokenOk(), messageOk()]);
  const { deps } = cliEnv(
    () => `FEISHU_APP_ID=${APP_ID}\nFEISHU_APP_SECRET=${APP_SECRET}\nSYCM_NOTIFY_RECIPIENT=ops@example.com\n`,
  );
  const receipt = await main([], { ...deps, fetchImpl });
  assert.equal(receipt.status, 'SENT');
  assert.equal(receipt.channel, 'app');
});

test('CLI 在 env 文件缺凭据时直接报错，不静默降级', async () => {
  const fetchImpl = scriptedFetch([]);
  const { deps } = cliEnv(() => 'SYCM_NOTIFY_RECIPIENT=ops@example.com\n');
  await assert.rejects(() => main([], { ...deps, fetchImpl }), /must define FEISHU_APP_ID/u);
  assert.equal(fetchImpl.calls.length, 0);
});

test('CLI 的 token 请求打到真实的租户令牌端点（接口路径不能写错）', async () => {
  const fetchImpl = scriptedFetch([tokenOk(), messageOk()]);
  const { deps } = cliEnv(
    () => `FEISHU_APP_ID=${APP_ID}\nFEISHU_APP_SECRET=${APP_SECRET}\nSYCM_NOTIFY_RECIPIENT=ops@example.com\n`,
  );
  await main([], { ...deps, fetchImpl });
  assert.equal(fetchImpl.calls[0].url, TOKEN_ENDPOINT);
  assert.match(fetchImpl.calls[1].url, /\/open-apis\/im\/v1\/messages/u);
});
