import { PROJECT_PORTS } from './browser-ports.mjs';
// 飞书网页登录态挂在**商家浏览器（乙）**上；端口来自 runtime/browser-ports.mjs。
// 2026-09-16：原先写死的 http://127.0.0.1:3456 是**别的项目**的共享代理 ——
// 那样能不能跑取决于别人的代理是否活着、以及那个浏览器里登的是谁。
const FEISHU_PROXY = `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;
const DEFAULT_PROXY = FEISHU_PROXY;

const REASONS = Object.freeze({
  FEISHU_LOGIN_REQUIRED: '当前自动化浏览器未检测到有效的飞书登录会话',
  FEISHU_QR_REQUIRED: '当前飞书会话需要二维码登录',
  FEISHU_SMS_REQUIRED: '当前飞书会话需要短信验证',
  FEISHU_CAPTCHA_REQUIRED: '当前飞书会话需要完成验证码或滑块验证',
  FEISHU_SECURITY_CHALLENGE: '当前飞书会话触发了安全或风控校验',
  FEISHU_PERMISSION_REQUIRED: '当前飞书页面没有可用的编辑权限',
  FEISHU_BROWSER_CONTEXT_MISMATCH: '自动化连接的浏览器上下文不是要求的浏览器上下文',
  FEISHU_TARGET_NOT_FOUND: '未找到授权飞书页面 target',
  FEISHU_TARGET_AMBIGUOUS: '找到多个授权飞书页面 target',
  FEISHU_BASE_MISMATCH: '当前页面不是目标飞书 Base',
  FEISHU_TABLE_MISMATCH: '当前页面不是目标飞书数据表或仪表盘',
  FEISHU_UI_NOT_READY: '飞书页面或编辑控件尚未就绪',
  FEISHU_REFRESH_FAILED: '用户恢复会话后的页面刷新或重新定位失败',
});

const REMEDIATION = '请在自动化使用的浏览器 profile 中登录有目标 Base 编辑权限的账号，保持页面打开并回复“已登录并刷新”；随后将重新发现 target、刷新并复检。';

function plain(value) {
  if (Array.isArray(value)) return value.map(plain).filter(Boolean).join(' ');
  if (value && typeof value === 'object') return plain(value.text ?? value.value ?? value.name ?? '');
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function pageUrl(target) {
  return plain(target?.url);
}

function parseUrl(value) {
  try { return new URL(value); } catch { return null; }
}

function matchesTarget(target, expected) {
  if (target?.type !== 'page' || !target.targetId) return false;
  const url = parseUrl(pageUrl(target));
  if (!url || !url.hostname.endsWith('.feishu.cn')) return false;
  if (expected?.appToken && url.pathname !== `/base/${expected.appToken}`) return false;
  if (expected?.tableId && url.searchParams.get('table') !== expected.tableId) return false;
  if (expected?.automationLabel && target.automationLabel !== expected.automationLabel) return false;
  return true;
}

function blocking(status, reasonCode, details = {}) {
  return {
    status,
    reasonCode,
    reason: REASONS[reasonCode] ?? '飞书自动化预检未通过',
    remediation: REMEDIATION,
    ...details,
  };
}

export function selectFeishuTarget(targets, expected = {}) {
  const matches = (Array.isArray(targets) ? targets : []).filter((target) => matchesTarget(target, expected));
  if (matches.length === 0) {
    const error = new Error(REASONS.FEISHU_TARGET_NOT_FOUND);
    error.code = 'FEISHU_TARGET_NOT_FOUND';
    throw error;
  }
  if (matches.length > 1) {
    const error = new Error(REASONS.FEISHU_TARGET_AMBIGUOUS);
    error.code = 'FEISHU_TARGET_AMBIGUOUS';
    throw error;
  }
  return matches[0];
}

function markerCode(snapshot) {
  const markers = [
    ...(Array.isArray(snapshot?.loginMarkers) ? snapshot.loginMarkers : []),
    ...(Array.isArray(snapshot?.securityMarkers) ? snapshot.securityMarkers : []),
    ...(Array.isArray(snapshot?.permissionMarkers) ? snapshot.permissionMarkers : []),
  ].map(plain).filter(Boolean).join('\n');
  if (/验证码|滑块验证/iu.test(markers)) return 'FEISHU_CAPTCHA_REQUIRED';
  if (/扫码登录|二维码登录/iu.test(markers)) return 'FEISHU_QR_REQUIRED';
  if (/短信验证|手机验证/iu.test(markers)) return 'FEISHU_SMS_REQUIRED';
  if (/安全验证|账号异常|风控|访问受限|操作频繁/iu.test(markers)) return 'FEISHU_SECURITY_CHALLENGE';
  if (/登录|注册|请登录/iu.test(markers)) return 'FEISHU_LOGIN_REQUIRED';
  return null;
}

function urlMatchesExpected(value, expected) {
  const url = parseUrl(value);
  if (!url || !url.hostname.endsWith('.feishu.cn')) return false;
  if (expected?.appToken && url.pathname !== `/base/${expected.appToken}`) return false;
  if (expected?.tableId && url.searchParams.get('table') !== expected.tableId) return false;
  return true;
}

export function classifyFeishuUiSnapshot(snapshot = {}, expected = {}) {
  const marker = markerCode(snapshot);
  if (marker) return blocking('BLOCKED', marker);
  if (snapshot.pageUrl && !urlMatchesExpected(snapshot.pageUrl, expected)) {
    const url = parseUrl(snapshot.pageUrl);
    const reasonCode = expected?.tableId && url?.pathname === `/base/${expected.appToken}`
      ? 'FEISHU_TABLE_MISMATCH'
      : 'FEISHU_BASE_MISMATCH';
    return blocking('BLOCKED', reasonCode);
  }
  if (snapshot.tableVisible === false || (expected?.dashboard && snapshot.dashboardVisible === false)) {
    return blocking('BLOCKED', 'FEISHU_TABLE_MISMATCH');
  }
  const controls = Object.values(snapshot.editControls ?? {});
  if (controls.some((control) => control?.present === true && control?.disabled === true)) {
    return blocking('BLOCKED', 'FEISHU_PERMISSION_REQUIRED');
  }
  if (expected?.requireEditControl && !controls.some((control) => control?.present === true && control?.disabled !== true)) {
    return blocking('BLOCKED', 'FEISHU_UI_NOT_READY');
  }
  return { status: 'READY', reasonCode: null, reason: '飞书自动化预检通过', remediation: null };
}

function safeTarget(target) {
  if (!target) return null;
  return {
    targetId: plain(target.targetId) || null,
    url: plain(target.url) || null,
    automationLabel: plain(target.automationLabel) || null,
  };
}

export function buildFeishuPreflightReceipt({ checkedAt, classification, health, target, expected } = {}) {
  const reasonCode = classification?.reasonCode ?? null;
  return {
    version: 'feishu-ui-preflight-v1',
    checkedAt: new Date(checkedAt ?? Date.now()).toISOString(),
    preflight: {
      status: classification?.status ?? 'BLOCKED',
      reasonCode,
      reason: reasonCode ? (REASONS[reasonCode] ?? '飞书自动化预检未通过') : '飞书自动化预检通过',
    },
    browserContext: {
      browserId: plain(health?.browser?.id) || null,
      contextId: plain(health?.contextId ?? health?.browser?.contextId) || null,
    },
    target: safeTarget(target),
    expected: {
      tableId: plain(expected?.tableId) || null,
      automationLabel: plain(expected?.automationLabel) || null,
      baseHost: parseUrl(target?.url)?.host ?? null,
    },
  };
}

export const FEISHU_PAGE_EXPRESSION = `(() => {
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
      && rect.width > 0 && rect.height > 0;
  };
  const text = (value) => String(value || '').replace(/\\s+/gu, ' ').trim();
  const visibleText = [...document.querySelectorAll('body *')]
    .filter((element) => visible(element) && element.children.length === 0)
    .map((element) => text(element.innerText || element.getAttribute('aria-label')))
    .filter(Boolean);
  const source = visibleText.join('\\n');
  const button = (selectors) => selectors.map((selector) => document.querySelector(selector)).find(Boolean);
  const dashboardEdit = button(['.dashboard-add-chart', '[aria-label="添加组件"]', 'button']);
  return {
    pageUrl: location.href,
    loginMarkers: /登录|注册/iu.test(source) ? ['登录/注册'] : [],
    securityMarkers: /验证码|滑块验证|扫码登录|二维码登录|短信验证|安全验证|账号异常|风控|访问受限/iu.test(source) ? [source.slice(0, 120)] : [],
    permissionMarkers: /无权限|权限不足/iu.test(source) ? ['权限提示'] : [],
    baseVisible: Boolean(document.querySelector('[data-testid*="base" i], .bitable-app')),
    tableVisible: Boolean(document.querySelector('.bitable-sheet, .sheet-block-DASHBOARD, [data-testid*="table" i]')),
    dashboardVisible: Boolean(document.querySelector('.sheet-block-DASHBOARD, [data-testid*="dashboard" i]')),
    editControls: { dashboardEdit: { present: Boolean(dashboardEdit), disabled: Boolean(dashboardEdit?.disabled || dashboardEdit?.classList.contains('ud__button--disabled') || dashboardEdit?.classList.contains('disabled')) } },
  };
})()`;

async function requestJson(proxy, path, options, request) {
  if (request) return request(path, options);
  const response = await fetch(`${proxy}${path}`, options);
  const body = await response.json();
  if (!response.ok || body?.error) throw new Error(String(body?.error ?? response.status));
  return body;
}

function resultFromError(error) {
  const reasonCode = error?.code?.startsWith('FEISHU_') ? error.code : 'FEISHU_UI_NOT_READY';
  return blocking('BLOCKED', reasonCode, { error: String(error?.message ?? error).slice(0, 200) });
}

export async function runFeishuUiPreflight({ proxy = DEFAULT_PROXY, expected = {}, request } = {}) {
  try {
    const health = await requestJson(proxy, '/health', undefined, request);
    if (health?.connected !== true) return blocking('BLOCKED', 'FEISHU_BROWSER_CONTEXT_MISMATCH');
    if (expected.browserId && plain(health?.browser?.id) !== expected.browserId) {
      return blocking('BLOCKED', 'FEISHU_BROWSER_CONTEXT_MISMATCH');
    }
    if (expected.contextId && plain(health?.contextId ?? health?.browser?.contextId) !== expected.contextId) {
      return blocking('BLOCKED', 'FEISHU_BROWSER_CONTEXT_MISMATCH');
    }
    const targets = await requestJson(proxy, '/targets', undefined, request);
    const target = selectFeishuTarget(targets, expected);
    const response = await requestJson(proxy, `/eval?target=${encodeURIComponent(target.targetId)}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: FEISHU_PAGE_EXPRESSION,
    }, request);
    const snapshot = response?.value ?? response;
    const classification = classifyFeishuUiSnapshot(snapshot, expected);
    return {
      ...classification,
      target: safeTarget(target),
      health: { browser: { id: plain(health?.browser?.id) || null }, contextId: plain(health?.contextId ?? health?.browser?.contextId) || null },
      receipt: buildFeishuPreflightReceipt({ classification, health, target, expected }),
    };
  } catch (error) {
    return { ...resultFromError(error), receipt: buildFeishuPreflightReceipt({ classification: resultFromError(error), expected }) };
  }
}

function preflightError(result) {
  const error = new Error(result.reason ?? 'Feishu UI preflight blocked');
  error.code = result.reasonCode ?? 'FEISHU_UI_NOT_READY';
  error.details = result;
  return error;
}

export async function guardedUiAction({ proxy = DEFAULT_PROXY, expected = {}, request, action } = {}) {
  const before = await runFeishuUiPreflight({ proxy, expected, request });
  if (before.status !== 'READY') throw preflightError(before);
  const result = await action({ target: before.target, health: before.health });
  const after = await runFeishuUiPreflight({ proxy, expected, request });
  if (after.status !== 'READY') throw preflightError(after);
  return { result, before, after };
}

export async function resumeFeishuUi({ proxy = DEFAULT_PROXY, expected = {}, refresh = true, request } = {}) {
  const before = await runFeishuUiPreflight({ proxy, expected, request });
  if (before.status !== 'READY') return before;
  if (!refresh) return before;
  try {
    await requestJson(proxy, `/navigate?target=${encodeURIComponent(before.target.targetId)}&url=${encodeURIComponent(before.target.url)}`, undefined, request);
  } catch (error) {
    const classification = blocking('BLOCKED', 'FEISHU_REFRESH_FAILED', { error: String(error?.message ?? error).slice(0, 200) });
    return { ...classification, receipt: buildFeishuPreflightReceipt({ classification, expected }) };
  }
  return runFeishuUiPreflight({ proxy, expected, request });
}

export { DEFAULT_PROXY, REASONS, REMEDIATION };
