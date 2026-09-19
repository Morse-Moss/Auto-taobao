// 飞书告警投递核心：只回答一件事——「这条告警发出去了没有」。
//
// 为什么单独一层：判定（哪些故障该响、哪些该静默）属于运行内核，属于离线用例能覆盖的纯逻辑；
// 投递（拿凭据、调接口、失败降级）属于外部副作用，属于必须注入假 fetch 才能覆盖的一层。
// 把两者分开，是为了让「该安静的时候安静」和「该响的时候响」都能被单独验证。
//
// 投递链（见 docs/ops/UNATTENDED-AGENT-RUNTIME-PLAN.md §6/§9）：
//   1) 自建应用消息 → 主收件人（唯一能发给**个人**、且零新增凭据的路径）
//   2) 自建应用消息 → 兜底收件人（通常是群；同一通道内的第二次尝试，覆盖「个人收件人不可达」）
//   3) 群自定义机器人 webhook（**换了认证路径**的兜底，能覆盖整个应用通道挂掉的情况）
//   全链失败 → FAILED，绝不假装成功。
//
// 本模块不做的事（都属于调用方的职责，别往上加）：
//   - 不判断哪类故障该通知（那是静默判据表的职责）
//   - 不按轮次聚合去重、不记恢复通知（那是运行内核的职责）
//   - 不重试业务失败（只处理「token 过期」这一类可自愈的认证失败，且只重试一次）

export const NOTIFY_RECEIPT_VERSION = 'feishu-notify-receipt-v1';

const DEFAULT_TOKEN_ENDPOINT =
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const DEFAULT_MESSAGE_ENDPOINT = 'https://open.feishu.cn/open-apis/im/v1/messages';

// token 提前 5 分钟视为过期。常驻进程里「恰好卡在过期瞬间发」是最难查的一类失败，
// 用一点提前量换掉它，比事后查 401 便宜得多。
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;
const MIN_TOKEN_TTL_MS = 60 * 1000;

// 认证/授权类错误码。99991663 = token 无效，99991668 = token 过期，
// 99991664 = tenant token 不合法。这三类清缓存重取一次有意义。
const AUTH_RETRY_CODES = new Set([99991663, 99991664, 99991668]);
// 99991672 = 应用缺少 scope。重试无意义，但必须给出「去哪开、开完要重新发布版本」的指引——
// 本项目 2026-09-14 与 2026-09-15 两次都在这条上花过时间。
const MISSING_SCOPE_CODE = 99991672;
const MISSING_SCOPE_HINT =
  '应用缺少 im:message:send_as_bot（控制台名称：以应用的身份发消息）；开通后必须「版本管理与发布 → 创建版本 → 发布」才生效';

const TITLE_BY_TYPE = Object.freeze({
  XWS_LOGIN_REQUIRED: '小旺神登录已失效',
  XWS_LOGIN_RESOLVED: '小旺神登录已恢复',
  LOGIN_REQUIRED: '平台登录已失效',
  ACCOUNT_MISMATCH: '登录的账号不对',
  RISK_BLOCKED: '遇到验证码或风控页，需要人工处理',
  COMMIT_UNKNOWN: '外部写入结果未知，需要人工对账（不要重跑）',
  BUG: '疑似系统自身缺陷，自动化已停止',
  BUDGET_EXHAUSTED: '自动重试次数已用尽',
});

// 只渲染白名单里的键。**白名单而不是黑名单**：source 是调用方填的自由对象，
// 黑名单意味着「以后谁往里塞一个键，它就会出现在告警里」——而告警会被复制到群、邮件、诊断包。
//
// 末两行是 2026-09-18 加的（见 docs/ops/LOGIN-RECOVERY-OPTIONS.md 的 B 项）：
// 「平台登录已失效」这类告警原来只说「登录失效」，没说**哪台机器、哪个浏览器配置**——
// 而登录恰恰是唯一无法远程代劳的事，运营看完还得先找到底该去哪台机器。缺值的键整行不输出，
// 所以对没填这两项的旧来源，渲染结果与加它们之前逐字相同。
//
// `loginUrl` 是 2026-09-18 加的，起因是用户的一句反馈：「提醒太笼统，要把操作的链接提出来」。
// 位置刻意排在「店铺」之后、「机器」之前。缺这个键的旧来源整行不输出，渲染结果仍逐字不变。
//
// 2026-09-19 补一条实测 —— **别再把「给条链接」当默认做法**。用户点了那条链接，
// 「直接跳到我的默认浏览器（QQ 浏览器）而不是目标浏览器」：点 http 链接走的是**系统默认浏览器**，
// 到不了目标 profile 的实例。所以：
//   · 日报链那边的新来源（login-merchant）**已经不再给这个字段**，
//     改成由脚本自己把登录页开在目标窗口里并把窗口置前；
//   · 白名单这里**保留**这个键，只为兼容仍在用它的旧来源
//     （例如 runtime/question-library-collection/ 下的 alert.json）。
//     **保留 ≠ 推荐**：新写的告警不要再往里塞 URL。
const READABLE_SOURCE_KEYS = Object.freeze([
  ['targetLabel', '对象'],
  ['productId', '商品ID'],
  ['shopName', '店铺'],
  ['loginUrl', '打开这个链接'],
  ['mainRecordId', '主表记录'],
  ['period', '数据周期'],
  ['capability', '任务'],
  ['machine', '机器'],
  ['browserProfile', '浏览器配置'],
]);

function text(value) {
  return String(value ?? '').trim();
}

// 时间要给运营看的，不是给机器看的。ISO 的 `2026-09-15T03:45:00.000Z`
// 会被读成凌晨 3 点（实际是本机上午 11:45），所以按本机时区渲染成 `2026-09-15 11:45`。
// 解析不出来时原样返回——不猜、不编一个时间出来。
export function formatLocalTime(value) {
  const raw = text(value);
  if (!raw) return '';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.valueOf())) return raw;
  const pad = (n) => String(n).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} `
    + `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

// 空值不是零：缺字段就整行不输出，而不是渲染成 "undefined" / "（空）" 让人误判。
function line(label, value) {
  const normalized = text(value);
  return normalized ? `${label}：${normalized}\n` : '';
}

// 凭据不外泄：告警文本可能被日志、通知、诊断包三处复制，
// 所以在最靠近出口的地方做一次遮盖（应用 ID、Bearer、32 位以上连续令牌）。
//
// 遮盖范围要**窄**：令牌是不含分隔符的长串，而我们自己的编号（alertId 形如
// xws-login-678598686014-20260915T030000）是**带连字符**的。把连字符也纳入字符集，
// 会把告警编号一起吞掉——而编号正是运营和服务方对账时唯一能引用的东西。
// 这条是干跑真实入口时发现的，离线用例当时没覆盖。
export function redactSensitive(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gu, 'Bearer [redacted]')
    .replace(/\bcli_[A-Za-z0-9]{8,}\b/gu, '[redacted-app-id]')
    .replace(/\b[A-Za-z0-9]{32,}\b/gu, '[redacted-token]');
}

export function resolveAlertTitle(alert) {
  const explicit = text(alert?.title);
  if (explicit) return explicit;
  const type = text(alert?.type);
  if (type && TITLE_BY_TYPE[type]) return TITLE_BY_TYPE[type];
  if (type) return type;
  return '系统告警';
}

export function renderAlertText(alert) {
  const severity = text(alert?.severity).toUpperCase();
  const head = severity === 'INFO' ? '【提示】' : '【需要处理】';
  const source = alert?.source ?? alert?.target ?? {};
  let body = '';
  for (const [key, label] of READABLE_SOURCE_KEYS) {
    body += line(label, source?.[key]);
  }
  body += line('原因', alert?.reason ?? alert?.message ?? alert?.detail);
  body += line('下一步', alert?.action ?? alert?.nextAction);
  const evidence = alert?.evidence;
  if (evidence && typeof evidence === 'object') {
    const artifacts = Object.values(evidence).map(text).filter(Boolean);
    if (artifacts.length) body += line('证据', artifacts.join('、'));
  }
  body += line('时间', formatLocalTime(alert?.createdAt));
  body += line('告警编号', alert?.alertId);
  return redactSensitive(`${head}${resolveAlertTitle(alert)}\n${body}`.trimEnd());
}

async function parseJsonResponse(response) {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return { code: 'NON_JSON', msg: raw.slice(0, 200) };
  }
}

export function createTokenProvider({
  fetchImpl,
  appId,
  appSecret,
  now = () => Date.now(),
  endpoint = DEFAULT_TOKEN_ENDPOINT,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createTokenProvider requires fetchImpl');
  if (!text(appId) || !text(appSecret)) throw new Error('createTokenProvider requires appId and appSecret');
  let cached = null;
  return {
    invalidate() {
      cached = null;
    },
    isCached() {
      return cached !== null;
    },
    async get() {
      const nowMs = now();
      if (cached && cached.expiresAt > nowMs) return cached.token;
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const body = await parseJsonResponse(response);
      if (!response.ok || body?.code !== 0 || !text(body?.tenant_access_token)) {
        throw new Error(
          `tenant_access_token 获取失败：http=${response.status} code=${body?.code ?? 'n/a'} msg=${body?.msg ?? ''}`,
        );
      }
      const expiresInSeconds = Number(body.expire);
      const ttl = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
        ? expiresInSeconds * 1000 - TOKEN_SAFETY_MARGIN_MS
        : MIN_TOKEN_TTL_MS;
      cached = { token: body.tenant_access_token, expiresAt: nowMs + Math.max(ttl, MIN_TOKEN_TTL_MS) };
      return cached.token;
    },
  };
}

async function attemptAppMessage({
  fetchImpl,
  tokenProvider,
  recipient,
  recipientType,
  message,
  messageEndpoint,
  channel = 'app',
}) {
  try {
    const token = await tokenProvider.get();
    const response = await fetchImpl(
      `${messageEndpoint}?receive_id_type=${encodeURIComponent(recipientType)}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          receive_id: recipient,
          msg_type: 'text',
          content: JSON.stringify({ text: message }),
        }),
      },
    );
    const body = await parseJsonResponse(response);
    if (response.ok && body?.code === 0) {
      return { channel, ok: true, target: recipient, messageId: text(body?.data?.message_id) || null };
    }
    const code = Number(body?.code);
    return {
      channel,
      ok: false,
      target: recipient,
      http: response.status,
      code: body?.code ?? null,
      msg: text(body?.msg) || 'unknown',
      retryable: response.status === 401 || AUTH_RETRY_CODES.has(code),
      ...(code === MISSING_SCOPE_CODE ? { hint: MISSING_SCOPE_HINT } : {}),
    };
  } catch (error) {
    // 网络层失败也返回收据，不抛出——投递失败必须变成一条可记录的结论，
    // 而不是一个让调用方崩掉的异常（通知失败不能影响主流程）。
    return { channel, ok: false, target: recipient, error: text(error?.message ?? error), retryable: false };
  }
}

async function attemptWebhook({ fetchImpl, webhookUrl, message }) {
  try {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ msg_type: 'text', content: { text: message } }),
    });
    const body = await parseJsonResponse(response);
    // 群机器人成功时返回 {"code":0} 或 {"StatusCode":0}（历史字段），两者都认。
    const code = body?.code ?? body?.StatusCode;
    if (response.ok && (code === 0 || code === undefined)) {
      return { channel: 'webhook', ok: true };
    }
    return {
      channel: 'webhook',
      ok: false,
      http: response.status,
      code: code ?? null,
      msg: text(body?.msg ?? body?.StatusMessage) || 'unknown',
    };
  } catch (error) {
    return { channel: 'webhook', ok: false, error: text(error?.message ?? error) };
  }
}

function buildReceipt({ status, channel, alertId, attempts, sentAt }) {
  const failed = attempts.filter((attempt) => !attempt.ok && !attempt.skipped);
  const receipt = {
    version: NOTIFY_RECEIPT_VERSION,
    status,
    channel: channel ?? null,
    alertId: alertId ?? null,
    sentAt,
    attempts,
  };
  if (status === 'FAILED' || (status === 'NOT_CONFIGURED' && failed.length)) {
    receipt.error = failed
      .map((attempt) => {
        const detail = attempt.error ?? `http=${attempt.http ?? 'n/a'} code=${attempt.code ?? 'n/a'} ${attempt.msg ?? ''}`.trim();
        return `${attempt.channel}: ${detail}${attempt.hint ? ` | ${attempt.hint}` : ''}`;
      })
      .join(' ; ')
      .slice(0, 500);
  }
  return receipt;
}

// 投递入口。除了「token 过期」这一类可自愈的认证失败会清缓存重试一次，
// 其余失败一律顺链降级，不做业务重试。
export async function deliverAlert({
  alert,
  fetchImpl,
  tokenProvider = null,
  recipient = null,
  recipientType = 'email',
  fallbackRecipient = null,
  fallbackRecipientType = 'chat_id',
  webhookUrl = null,
  now = () => Date.now(),
  messageEndpoint = DEFAULT_MESSAGE_ENDPOINT,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('deliverAlert requires fetchImpl');
  const message = renderAlertText(alert);
  const alertId = text(alert?.alertId) || null;
  const sentAt = new Date(now()).toISOString();
  const attempts = [];

  const primary = text(recipient);
  const fallback = text(fallbackRecipient);
  const hasWebhook = Boolean(text(webhookUrl));

  const sendToRecipient = async (channel, target, targetType) => {
    const first = await attemptAppMessage({
      fetchImpl,
      tokenProvider,
      recipient: target,
      recipientType: targetType,
      message,
      messageEndpoint,
      channel,
    });
    attempts.push(first);
    if (!first.ok && first.retryable) {
      tokenProvider.invalidate();
      attempts.push(
        await attemptAppMessage({
          fetchImpl,
          tokenProvider,
          recipient: target,
          recipientType: targetType,
          message,
          messageEndpoint,
          channel,
        }),
      );
    }
    return attempts[attempts.length - 1].ok;
  };

  let sentChannel = null;
  if (primary) {
    if (!tokenProvider) throw new Error('deliverAlert requires tokenProvider when a recipient is configured');
    if (await sendToRecipient('app', primary, recipientType)) sentChannel = 'app';
  } else {
    attempts.push({ channel: 'app', ok: false, skipped: 'NO_RECIPIENT' });
  }

  if (!sentChannel) {
    if (!fallback) {
      attempts.push({ channel: 'app_fallback', ok: false, skipped: 'NO_FALLBACK_RECIPIENT' });
    } else if (fallback === primary) {
      // 主收件人与兜底收件人相同时不再发一次：那只是重复打扰，
      // 而且会让收据看起来「试过兜底」，把话说过头。
      attempts.push({ channel: 'app_fallback', ok: false, skipped: 'SAME_AS_PRIMARY' });
    } else {
      if (!tokenProvider) throw new Error('deliverAlert requires tokenProvider when a fallback recipient is configured');
      if (await sendToRecipient('app_fallback', fallback, fallbackRecipientType)) sentChannel = 'app_fallback';
    }
  }

  if (sentChannel) return buildReceipt({ status: 'SENT', channel: sentChannel, alertId, attempts, sentAt });

  if (hasWebhook) {
    const webhookAttempt = await attemptWebhook({ fetchImpl, webhookUrl, message });
    attempts.push(webhookAttempt);
    if (webhookAttempt.ok) {
      return buildReceipt({ status: 'SENT', channel: 'webhook', alertId, attempts, sentAt });
    }
  } else {
    attempts.push({ channel: 'webhook', ok: false, skipped: 'NO_WEBHOOK' });
  }

  if (!primary && !fallback && !hasWebhook) {
    return buildReceipt({ status: 'NOT_CONFIGURED', channel: null, alertId, attempts, sentAt });
  }
  return buildReceipt({ status: 'FAILED', channel: null, alertId, attempts, sentAt });
}
