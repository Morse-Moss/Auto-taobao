#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { updateSkuBatchIndex } from './xws-sku-batch-index.mjs';
import { PROJECT_PORTS } from './browser-ports.mjs';

// 本项目专用 CDP 代理端口来自 runtime/browser-ports.mjs（唯一来源），不是写死的字符串。
// 3456 属于另一个项目、挂在用户的日常 Edge 上且**没有小旺神**——默认值写成它会静默指向错目标。
const DEFAULT_PROXY = `http://127.0.0.1:${PROJECT_PORTS.competitorProxy}`;
const AUTH_STATUS_VERSION = 'xws-sku-auth-preflight-v1';
const ALERT_VERSION = 'xws-sku-operator-alert-v1';

function required(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function clean(value) {
  const normalized = String(value ?? '').trim();
  return normalized || undefined;
}

function safeSource(source = {}) {
  return Object.fromEntries([
    ['mainRecordId', source.mainRecordId],
    ['productId', source.productId],
    ['productUrl', source.productUrl],
    ['classification', source.classification],
    ['validity', source.validity],
  ].flatMap(([key, value]) => {
    const normalized = clean(value);
    return normalized ? [[key, normalized]] : [];
  }));
}

function timestampId(value) {
  const timestamp = new Date(value ?? Date.now());
  if (Number.isNaN(timestamp.valueOf())) throw new Error('checkedAt must be a valid date');
  return `${timestamp.toISOString().replace(/[-:.]/gu, '')}-${randomUUID().slice(0, 12)}`;
}

function jsonText(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

async function writeJson(path, value, { exclusive = false } = {}) {
  const target = resolve(path);
  await mkdir(resolve(target, '..'), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, jsonText(value), { encoding: 'utf8', flag: 'wx' });
  try {
    if (exclusive && existsSync(target)) {
      throw new Error(`Refusing to overwrite existing evidence: ${target}`);
    }
    if (!exclusive && existsSync(target)) {
      await writeFile(target, jsonText(value), { encoding: 'utf8', flag: 'w' });
      await unlink(temporary);
      return target;
    }
    await rename(temporary, target);
  } catch (error) {
    try { await unlink(temporary); } catch { /* best effort cleanup */ }
    throw error;
  }
  return target;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const source = await response.text();
  let body;
  try {
    body = source ? JSON.parse(source) : {};
  } catch {
    throw new Error('Proxy returned non-JSON');
  }
  if (!response.ok || body?.error) throw new Error(String(body?.error || response.status));
  return body;
}

function humanRequired(reason, details = {}) {
  const error = new Error(reason);
  error.code = 'HUMAN_REQUIRED';
  error.details = details;
  return error;
}

function stalled(reason, details = {}) {
  const error = new Error(reason);
  error.code = 'STALLED';
  error.details = details;
  return error;
}

export function parsePreflightArgs(argv = []) {
  const options = { proxy: DEFAULT_PROXY };
  const valueOptions = new Map([
    ['--proxy', 'proxy'],
    ['--product-id', 'productId'],
    ['--product-url', 'productUrl'],
    ['--record-id', 'recordId'],
    ['--classification', 'classification'],
    ['--validity', 'validity'],
    ['--output-directory', 'outputDirectory'],
    ['--target-label', 'targetLabel'],
    ['--notify-command', 'notifyCommand'],
    ['--checked-at', 'checkedAt'],
    // 身份判据（可选，但必须成对给）：声明「期望账号」+「从页面哪儿读账号」。
    // 不给就是没做身份核对 —— 不会被当成通过，状态里会如实写 identity.verdict。
    ['--expected-account', 'expectedAccount'],
    ['--account-selector', 'accountSelector'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const key = valueOptions.get(argument);
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    options[key] = value;
    index += 1;
  }
  for (const [key, flag] of [
    ['productId', '--product-id'],
    ['productUrl', '--product-url'],
    ['recordId', '--record-id'],
    ['classification', '--classification'],
    ['validity', '--validity'],
    ['outputDirectory', '--output-directory'],
  ]) {
    options[key] = required(options[key], flag);
  }
  options.proxy = required(options.proxy, '--proxy');
  options.targetLabel = clean(options.targetLabel);
  options.expectedAccount = clean(options.expectedAccount);
  options.accountSelector = clean(options.accountSelector);
  // 身份判据必须成对：只给一个就是「要比对但没给读法」或「给了读法但没给期望值」，
  // 静默接受半个等于悄悄跳过核对，所以直接拒。
  if (Boolean(options.expectedAccount) !== Boolean(options.accountSelector)) {
    throw new Error('--expected-account and --account-selector must be supplied together');
  }
  return options;
}

// 身份判据的选择器由**调用方给出**，不在这里猜平台 DOM：
// 关键选择器必须先在真实环境实测一次再写进配置（见 docs/ops/LOGIN-STATE-MANAGEMENT.md §7 第 1 条），
// 猜错的后果是「读不到」被当成「没问题」——那正是要避免的假绿。
function pageExpression(accountSelector = null) {
  const selectorLiteral = accountSelector ? JSON.stringify(accountSelector) : 'null';
  return `(() => {
  const accountSelector = ${selectorLiteral};
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
      && rect.width > 0 && rect.height > 0;
  };
  const text = (value) => String(value || '').replace(/\\s+/gu, ' ').trim();
  const root = document.querySelector('#xws-detail-tool');
  const visibleDialogs = [...document.querySelectorAll('.el-dialog__wrapper,[role="dialog"]')]
    .filter(visible)
    .map((element) => text(element.innerText || element.getAttribute('aria-label')));
  const combinedText = visibleDialogs.join('\\n');
  const loginMarkers = [];
  if (/(?:登录小旺神|小旺神登录|登录\\/验证后)/iu.test(combinedText)) loginMarkers.push('XWS_LOGIN');
  if (/(?:当前浏览器不支持弹窗登录|即将往小旺神官网进行登录)/iu.test(combinedText)) {
    loginMarkers.push('XWS_LOGIN_REDIRECT');
  }
  let accountId = '';
  let accountReadError = null;
  if (accountSelector) {
    try {
      const node = document.querySelector(accountSelector);
      if (node) accountId = text(node.innerText || node.textContent);
      else accountReadError = 'SELECTOR_NOT_FOUND';
    } catch {
      accountReadError = 'SELECTOR_INVALID';
    }
  }
  return {
    pageProductId: new URL(location.href).searchParams.get('id') || '',
    pluginPresent: Boolean(root),
    skuControlPresent: Boolean(root?.querySelector('.xws-sku-preview')),
    loginMarkers,
    visibleLoginDialog: visibleDialogs.some((value) => /登录|验证码|安全验证|风控/iu.test(value)),
    accountId,
    accountReadError,
  };
})()`;
}
// 探测完整性的判据：这三个字段是分类器必需的输入。读不到它们时**不许**继续往下判 ——
// 否则「探测什么都没拿到」会被判成 SOURCE_MISMATCH（页面商品不对），
// 把运营送到错的方向去修（改 URL、换商品），而真问题是页面/代理没就绪。
const REQUIRED_SNAPSHOT_FIELDS = ['pageProductId', 'pluginPresent', 'skuControlPresent'];

function unreadableSnapshotFields(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return [...REQUIRED_SNAPSHOT_FIELDS];
  return REQUIRED_SNAPSHOT_FIELDS.filter((field) => (
    field === 'pageProductId' ? typeof snapshot[field] !== 'string' : typeof snapshot[field] !== 'boolean'
  ));
}

// `identity` 只在调用方声明了期望账号时才有判据（`--expected-account`）。
// 没声明＝没核对，不当成通过；声明了却读不到观察值＝AUTH_UNKNOWN（fail-closed，不放行）。
export function classifyAuthSnapshot(snapshot, expectedProductId, identity = {}) {
  const unreadable = unreadableSnapshotFields(snapshot);
  if (unreadable.length > 0) {
    return {
      status: 'AUTH_UNKNOWN',
      reason: `Preflight probe returned no usable reading (missing: ${unreadable.join(', ')})`,
      unreadable,
    };
  }
  const pageProductId = String(snapshot.pageProductId).trim();
  const expected = String(expectedProductId ?? '').trim();
  if (!expected || pageProductId !== expected) {
    return { status: 'SOURCE_MISMATCH', reason: 'Product page ID differs from the selected source' };
  }
  const loginMarkers = Array.isArray(snapshot.loginMarkers) ? snapshot.loginMarkers.filter(Boolean) : [];
  if (loginMarkers.length > 0 || snapshot.visibleLoginDialog === true) {
    return { status: 'AUTH_REQUIRED', reason: 'Xiaowangshen login is required', loginMarkers };
  }
  const expectedAccount = String(identity.expectedAccount ?? '').trim();
  if (expectedAccount) {
    const observedAccount = String(snapshot.accountId ?? '').trim();
    if (!observedAccount) {
      return {
        status: 'AUTH_UNKNOWN',
        reason: snapshot.accountReadError
          ? `Account identity is unreadable (${snapshot.accountReadError}); the configured selector must be measured again`
          : 'Account identity is unreadable; the configured selector matched nothing',
        identity: { expected: expectedAccount, observed: null, verdict: 'UNREADABLE' },
      };
    }
    if (observedAccount !== expectedAccount) {
      return {
        status: 'ACCOUNT_MISMATCH',
        reason: `Logged-in account is "${observedAccount}", but this source needs "${expectedAccount}"`,
        identity: { expected: expectedAccount, observed: observedAccount, verdict: 'MISMATCH' },
      };
    }
  }
  if (snapshot.pluginPresent !== true) {
    return { status: 'PLUGIN_UNAVAILABLE', reason: 'Xiaowangshen toolbar is unavailable' };
  }
  if (snapshot.skuControlPresent !== true) {
    return { status: 'PLUGIN_NOT_READY', reason: 'Xiaowangshen SKU control is unavailable' };
  }
  return {
    status: 'AUTH_READY',
    reason: 'No Xiaowangshen login wall was observed',
    ...(expectedAccount
      ? { identity: { expected: expectedAccount, observed: String(snapshot.accountId ?? '').trim(), verdict: 'MATCH' } }
      : {}),
  };
}

export function buildAuthStatus({ checkedAt, source, targetUrl, snapshot, classification } = {}) {
  const status = classification?.status ?? 'UNKNOWN';
  return {
    version: AUTH_STATUS_VERSION,
    checkedAt: new Date(checkedAt ?? Date.now()).toISOString(),
    source: safeSource(source),
    page: {
      url: clean(targetUrl),
      productId: clean(snapshot?.pageProductId),
      pluginPresent: snapshot?.pluginPresent === true,
      skuControlPresent: snapshot?.skuControlPresent === true,
    },
    status,
    reason: classification?.reason ?? 'Unknown preflight result',
    ...(classification?.loginMarkers?.length ? { loginMarkers: [...classification.loginMarkers] } : {}),
    ...(classification?.identity ? { identity: { ...classification.identity } } : {}),
    ...(classification?.unreadable?.length ? { unreadable: [...classification.unreadable] } : {}),
  };
}

// 「通知必须带下一步做什么」（docs/ops/LOGIN-STATE-MANAGEMENT.md §4 硬规则 2）：
// 每个状态一个 type（去重与恢复都按 type 成对）+ 一句人话。只报状态码等于没说话。
const ALERT_BY_STATUS = Object.freeze({
  AUTH_REQUIRED: {
    type: 'XWS_LOGIN_REQUIRED',
    action: '请在同一个 Edge 用户配置中登录小旺神，登录完成后重新运行采集预检。',
  },
  ACCOUNT_MISMATCH: {
    type: 'XWS_ACCOUNT_MISMATCH',
    action: '当前登录的不是这次采集要用的账号：在这个 Edge 用户配置里换成正确账号'
      + '（卖家版账号用不了小旺神，这条链必须是买家账号），再重新运行采集预检。',
  },
  AUTH_UNKNOWN: {
    type: 'XWS_AUTH_UNKNOWN',
    action: '这次预检读不到确定结论，系统按「不放行」处理：先确认商品页已打开并加载完成，'
      + '再重新运行预检；连续几轮都读不到，说明平台改版了，判据需要更新（这不是重试能解决的）。',
  },
  PLUGIN_UNAVAILABLE: {
    type: 'XWS_PLUGIN_NOT_READY',
    action: '小旺神插件没有加载：在这个 Edge 用户配置里重开一次浏览器，确认插件图标出现，再重新运行采集预检。',
  },
  PLUGIN_NOT_READY: {
    type: 'XWS_PLUGIN_NOT_READY',
    action: '小旺神插件在、但 SKU 控件还没就绪：等商品页加载完再重试一次预检；仍然失败就重开浏览器。',
  },
  SOURCE_MISMATCH: {
    type: 'XWS_SOURCE_MISMATCH',
    action: '当前页面不是要采集的那个商品：打开正确的商品页后重新运行预检。',
  },
});

export function buildOperatorAlert({ checkedAt, source, statusPath, reason, status = 'OPEN', classificationStatus = null } = {}) {
  const normalizedStatus = String(status).trim() || 'OPEN';
  const byStatus = ALERT_BY_STATUS[String(classificationStatus ?? '').trim()] ?? ALERT_BY_STATUS.AUTH_REQUIRED;
  return {
    version: ALERT_VERSION,
    alertId: `xws-login-${String(source?.productId ?? 'unknown')}-${timestampId(checkedAt)}`,
    status: normalizedStatus,
    severity: normalizedStatus === 'OPEN' ? 'HIGH' : 'INFO',
    type: normalizedStatus === 'OPEN' ? byStatus.type : 'XWS_LOGIN_RESOLVED',
    createdAt: new Date(checkedAt ?? Date.now()).toISOString(),
    source: safeSource(source),
    reason: String(reason ?? 'Xiaowangshen login is required').trim(),
    action: normalizedStatus === 'OPEN'
      ? byStatus.action
      : '小旺神登录预检已恢复通过，可以继续 SKU 采集。',
    evidence: { authStatusFile: basename(String(statusPath ?? '')) },
    delivery: { status: 'NOT_CONFIGURED' },
  };
}

async function notifyOperator(command, alert) {
  if (!clean(command)) return { status: 'NOT_CONFIGURED' };
  return new Promise((resolveNotification, rejectNotification) => {
    const child = spawn(command, [], { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectNotification(new Error('Operator notification command timed out'));
    }, 10_000);
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectNotification(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectNotification(new Error(`Operator notification command failed with exit ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      resolveNotification({ status: 'SENT' });
    });
    child.stdin.end(jsonText(alert));
  });
}

async function discoverTarget(proxy, options) {
  const targets = await requestJson(`${proxy}/targets`);
  const target = (Array.isArray(targets) ? targets : []).find((item) => (
    item.type === 'page'
    && String(item.url || '').includes(`id=${options.productId}`)
    && (!options.targetLabel || item.automationLabel === options.targetLabel || !item.automationLabel)
  ));
  if (!target) throw stalled(`Product page target is unavailable: ${options.productId}`, { productId: options.productId });
  return target;
}

async function evaluateTarget(proxy, targetId, accountSelector = null) {
  const response = await requestJson(`${proxy}/eval?target=${encodeURIComponent(targetId)}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: pageExpression(accountSelector),
  });
  return response.value ?? response;
}

async function persistAlert({ outputDirectory, source, statusPath, checkedAt, reason, notifyCommand, classificationStatus = null }) {
  const alertPath = resolve(outputDirectory, 'xws-sku-operator-alert.json');
  const alert = buildOperatorAlert({ checkedAt, source, statusPath, reason, classificationStatus });
  let previous;
  if (existsSync(alertPath)) {
    try { previous = JSON.parse(await readFile(alertPath, 'utf8')); } catch { /* replace invalid alert evidence */ }
  }
  // 去重按「同一个 type + 同一个来源 + 同一句原因」成对判定：type 由状态决定，
  // 所以 AUTH_REQUIRED 与 ACCOUNT_MISMATCH 不会互相顶掉（前者解决不了后者，反之亦然）。
  const duplicateOpenAlert = previous?.status === 'OPEN'
    && previous?.type === alert.type
    && previous?.source?.productId === alert.source.productId
    && previous?.source?.mainRecordId === alert.source.mainRecordId
    && previous?.reason === alert.reason;
  if (duplicateOpenAlert) {
    alert.delivery = { status: 'DEDUPED', previousAlertId: previous.alertId };
  } else {
    try {
      alert.delivery = await notifyOperator(notifyCommand, alert);
    } catch (error) {
      alert.delivery = { status: 'FAILED', error: String(error?.message ?? error).slice(0, 300) };
    }
  }
  await writeJson(alertPath, alert);
  return { alertPath, alert };
}

async function resolveAlert({ outputDirectory, source, statusPath, checkedAt, notifyCommand }) {
  const alertPath = resolve(outputDirectory, 'xws-sku-operator-alert.json');
  if (!existsSync(alertPath)) return undefined;
  let previous;
  try { previous = JSON.parse(await readFile(alertPath, 'utf8')); } catch { return undefined; }
  if (previous?.status !== 'OPEN' || previous?.source?.productId !== source.productId
    || previous?.source?.mainRecordId !== source.mainRecordId) return undefined;
  const alert = buildOperatorAlert({
    checkedAt,
    source,
    statusPath,
    reason: 'Xiaowangshen login preflight recovered',
    status: 'RESOLVED',
  });
  try {
    alert.delivery = await notifyOperator(notifyCommand, alert);
  } catch (error) {
    alert.delivery = { status: 'FAILED', error: String(error?.message ?? error).slice(0, 300) };
  }
  await writeJson(alertPath, alert);
  return { alertPath, alert };
}

// 哪些状态要写告警（即「需要人动手」）。与 docs/ops/LOGIN-STATE-MANAGEMENT.md §4 的表一致：
// SOURCE_MISMATCH 不通知（属流程参数问题，记证据即可），AUTH_READY 不通知（只在恢复时补一条）。
const ALERTING_STATUSES = Object.freeze([
  'AUTH_REQUIRED',
  'ACCOUNT_MISMATCH',
  'AUTH_UNKNOWN',
  'PLUGIN_UNAVAILABLE',
  'PLUGIN_NOT_READY',
]);

export async function runAuthPreflight(options) {
  const checkedAt = new Date(options.checkedAt ?? Date.now()).toISOString();
  const source = {
    mainRecordId: options.recordId,
    productId: options.productId,
    productUrl: options.productUrl,
    classification: options.classification,
    validity: options.validity,
  };
  const outputDirectory = resolve(options.outputDirectory);
  const target = await discoverTarget(options.proxy, options);
  const snapshot = await evaluateTarget(options.proxy, target.targetId, options.accountSelector);
  const classification = classifyAuthSnapshot(snapshot, options.productId, {
    expectedAccount: options.expectedAccount,
  });
  const status = buildAuthStatus({
    checkedAt,
    source,
    targetUrl: target.url,
    snapshot,
    classification,
  });
  const runId = timestampId(checkedAt);
  const statusPath = await writeJson(
    resolve(outputDirectory, `xws-sku-auth-status-${runId}.json`),
    status,
    { exclusive: true },
  );
  const artifacts = { authStatus: statusPath };
  let alert;
  if (ALERTING_STATUSES.includes(classification.status)) {
    alert = await persistAlert({
      outputDirectory,
      source,
      statusPath,
      checkedAt,
      reason: classification.reason,
      notifyCommand: options.notifyCommand,
      classificationStatus: classification.status,
    });
    artifacts.operatorAlert = alert.alertPath;
  } else if (classification.status === 'AUTH_READY') {
    const resolved = await resolveAlert({
      outputDirectory,
      source,
      statusPath,
      checkedAt,
      notifyCommand: options.notifyCommand,
    });
    if (resolved) artifacts.operatorAlert = resolved.alertPath;
  }
  const batchIndexPath = await updateSkuBatchIndex({
    directory: outputDirectory,
    source,
    artifacts,
    status: classification.status,
    updatedAt: checkedAt,
  });
  const result = {
    status: classification.status,
    reason: classification.reason,
    source: safeSource(source),
    authStatusPath: basename(statusPath),
    // 把「下一步做什么」一起带出来：界面（运营台）渲染一张账号卡需要的原因与动作都在这里，
    // 不必再去打开 alert 文件（没有告警的状态就没有动作，本来就是无事可做）。
    ...(classification.identity ? { identity: { ...classification.identity } } : {}),
    ...(alert ? {
      operatorAlertPath: basename(alert.alertPath),
      notification: alert.alert.delivery,
      action: alert.alert.action,
      alertType: alert.alert.type,
    } : {}),
    batchIndexPath: basename(batchIndexPath),
  };
  if (classification.status === 'AUTH_REQUIRED') {
    throw humanRequired('HUMAN_REQUIRED: Xiaowangshen login is required', result);
  }
  if (classification.status === 'ACCOUNT_MISMATCH') {
    throw humanRequired(`HUMAN_REQUIRED: ${classification.reason}`, result);
  }
  if (classification.status !== 'AUTH_READY') {
    throw stalled(`Xiaowangshen preflight did not pass: ${classification.status}`, result);
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parsePreflightArgs(argv);
  const result = await runAuthPreflight(options);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(JSON.stringify({
      status: error.code || 'FAILED',
      error: String(error?.message ?? error),
      details: error.details || {},
    }));
    process.exitCode = error.code === 'HUMAN_REQUIRED' ? 2 : error.code === 'STALLED' ? 3 : 1;
  });
}
