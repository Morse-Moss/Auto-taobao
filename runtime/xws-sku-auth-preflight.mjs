#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { updateSkuBatchIndex } from './xws-sku-batch-index.mjs';

const DEFAULT_PROXY = 'http://127.0.0.1:3456';
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
  return options;
}

const PAGE_EXPRESSION = `(() => {
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
  return {
    pageProductId: new URL(location.href).searchParams.get('id') || '',
    pluginPresent: Boolean(root),
    skuControlPresent: Boolean(root?.querySelector('.xws-sku-preview')),
    loginMarkers,
    visibleLoginDialog: visibleDialogs.some((value) => /登录|验证码|安全验证|风控/iu.test(value)),
  };
})()`;

export function classifyAuthSnapshot(snapshot, expectedProductId) {
  const pageProductId = String(snapshot?.pageProductId ?? '').trim();
  const expected = String(expectedProductId ?? '').trim();
  if (!expected || pageProductId !== expected) {
    return { status: 'SOURCE_MISMATCH', reason: 'Product page ID differs from the selected source' };
  }
  const loginMarkers = Array.isArray(snapshot?.loginMarkers) ? snapshot.loginMarkers.filter(Boolean) : [];
  if (loginMarkers.length > 0 || snapshot?.visibleLoginDialog === true) {
    return { status: 'AUTH_REQUIRED', reason: 'Xiaowangshen login is required', loginMarkers };
  }
  if (snapshot?.pluginPresent !== true) {
    return { status: 'PLUGIN_UNAVAILABLE', reason: 'Xiaowangshen toolbar is unavailable' };
  }
  if (snapshot?.skuControlPresent !== true) {
    return { status: 'PLUGIN_NOT_READY', reason: 'Xiaowangshen SKU control is unavailable' };
  }
  return { status: 'AUTH_READY', reason: 'No Xiaowangshen login wall was observed' };
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
  };
}

export function buildOperatorAlert({ checkedAt, source, statusPath, reason, status = 'OPEN' } = {}) {
  const normalizedStatus = String(status).trim() || 'OPEN';
  return {
    version: ALERT_VERSION,
    alertId: `xws-login-${String(source?.productId ?? 'unknown')}-${timestampId(checkedAt)}`,
    status: normalizedStatus,
    severity: normalizedStatus === 'OPEN' ? 'HIGH' : 'INFO',
    type: normalizedStatus === 'OPEN' ? 'XWS_LOGIN_REQUIRED' : 'XWS_LOGIN_RESOLVED',
    createdAt: new Date(checkedAt ?? Date.now()).toISOString(),
    source: safeSource(source),
    reason: String(reason ?? 'Xiaowangshen login is required').trim(),
    action: normalizedStatus === 'OPEN'
      ? '请在同一个 Edge 用户配置中登录小旺神，登录完成后重新运行采集预检。'
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

async function evaluateTarget(proxy, targetId) {
  const response = await requestJson(`${proxy}/eval?target=${encodeURIComponent(targetId)}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: PAGE_EXPRESSION,
  });
  return response.value ?? response;
}

async function persistAlert({ outputDirectory, source, statusPath, checkedAt, reason, notifyCommand }) {
  const alertPath = resolve(outputDirectory, 'xws-sku-operator-alert.json');
  const alert = buildOperatorAlert({ checkedAt, source, statusPath, reason });
  let previous;
  if (existsSync(alertPath)) {
    try { previous = JSON.parse(await readFile(alertPath, 'utf8')); } catch { /* replace invalid alert evidence */ }
  }
  const duplicateOpenAlert = previous?.status === 'OPEN'
    && previous?.type === 'XWS_LOGIN_REQUIRED'
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
  const snapshot = await evaluateTarget(options.proxy, target.targetId);
  const classification = classifyAuthSnapshot(snapshot, options.productId);
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
  if (classification.status === 'AUTH_REQUIRED') {
    alert = await persistAlert({
      outputDirectory,
      source,
      statusPath,
      checkedAt,
      reason: classification.reason,
      notifyCommand: options.notifyCommand,
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
    ...(alert ? {
      operatorAlertPath: basename(alert.alertPath),
      notification: alert.alert.delivery,
    } : {}),
    batchIndexPath: basename(batchIndexPath),
  };
  if (classification.status === 'AUTH_REQUIRED') {
    throw humanRequired('HUMAN_REQUIRED: Xiaowangshen login is required', result);
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
