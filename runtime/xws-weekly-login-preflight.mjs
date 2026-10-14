#!/usr/bin/env node
// 周报竞品链的**登录态预检**（起跑前查小旺神登录，掉了就先叫人再跑）。
//
// 为什么需要它（2026-10-14 竞品周采 run4 的实测代价）：
//   小旺神插件会话过期后，点「市场分析」不再弹对话框，只会弹 xiaowangshen.com 的登录页。
//   原链路没有任何起跑前检查：十个段逐个跑到「点市场分析」才人道中止，每段白烧 20~60 秒，
//   而段级告警又因 EBUSY 一条都没发出去（supervise-collection.mjs 的 deliver，同批已修）。
//   本模块把「登录态」提前到**第一段之前**查：撞见登录墙就发飞书＋让驱动停，
//   不浪费后面的段，也不等人来问「怎么又挂了」。
//
// 判据只许一份：「哪个页签是小旺神登录页」「什么文本算已登录账号页」都从
// skills/xws-export-market-analysis/scripts/export-market-analysis.mjs 导入
// （isXiaowangshenLoginTarget / isLoggedInAccountText，ensurePluginSession 在用的同一对），
// 不在这里重抄 —— 重抄就会漂移。
//
// 只读：本模块只 GET /targets 与 /eval 读可见文本，不点、不导航、不开页。
//
// 退出码：0 = 放行（READY / 没页签可判 / 读不到——后两种是非阻断的「查不出」，
//          由采集宿主与监督环在后面兜底，它们现在的告警是通的）；
//          2 = LOGIN_REQUIRED（登录墙，需要人扫码，驱动应就此停下）；
//          3 = 预检自身出错（入参等）。
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isLoggedInAccountText, isXiaowangshenLoginTarget } from '../skills/xws-export-market-analysis/scripts/export-market-analysis.mjs';
// 端口唯一来源（3456 属于另一个项目且没有小旺神，默认值写它会静默指向错目标）。
import { PROJECT_PORTS } from './browser-ports.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_PROXY = `http://127.0.0.1:${PROJECT_PORTS.competitorProxy}`;
const DEFAULT_STATE_DIR = join(HERE, 'xws-weekly-login-preflight');
const DEFAULT_NOTIFY_CLI = join(HERE, 'notify-feishu.mjs');
const NOTIFY_TIMEOUT_MS = 30_000;
const PROXY_TIMEOUT_MS = 8_000;

const STATUS_VERSION = 'xws-weekly-login-preflight-v1';
const ALERT_VERSION = 'xws-weekly-login-operator-alert-v1';

// 状态词表（与 xws-sku-auth-preflight / xws-platform-health-preflight 对齐，只加不删）：
//   READY              有已登录账号页 ⇒ 放行
//   NO_XWS_TAB         没有任何小旺神页签 ⇒ 查不出，放行（会话有效时插件本就不开页）
//   TARGETS_UNREADABLE / PROXY_UNREACHABLE
//                      没读到 ⇒ **不**当成有问题（只对正面证据下判决），放行并如实记账
//   LOGIN_REQUIRED     有登录墙页 ⇒ 阻断＋告警（fail-closed 的方向）
export const LOGIN_STATES = Object.freeze({
  READY: 'READY',
  NO_XWS_TAB: 'NO_XWS_TAB',
  UNVERIFIABLE: 'UNVERIFIABLE',
  TARGETS_UNREADABLE: 'TARGETS_UNREADABLE',
  PROXY_UNREACHABLE: 'PROXY_UNREACHABLE',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
});

// 哪些状态要叫人。只有 LOGIN_REQUIRED —— 其余四种要么是好事、要么是「查不出」，
// 拿「查不出」去叫人是告警轰炸（本仓库已犯过，见 xws-sku-auth-preflight 文件头）。
export const ALERTING_STATUSES = Object.freeze(['LOGIN_REQUIRED']);

// 每个要叫人的状态一个 type（去重与恢复都按 type 成对）＋ 一句人话。
// 文案里不许出现 Markdown 强调标记：最终以飞书纯文本发出，星号会原样打进运营眼里
// （xws-sku-auth-preflight 2026-09-22 真发预览时踩过）。
export const ALERT_BY_STATUS = Object.freeze({
  LOGIN_REQUIRED: {
    type: 'XWS_WEEKLY_LOGIN_REQUIRED',
    action: '小旺神登录态已失效，竞品周采集会被它挡住（点「市场分析」只会弹登录页）。'
      + '请在采集用的那个浏览器窗口（装着小旺神插件的买家账号那个）里，任选一个'
      + '「用户登录」页签用微信扫码登录；登好后把其余残留的「用户登录」页签关掉或刷新，'
      + '然后再重跑竞品周采集。',
  },
});

function clean(value) {
  const normalized = String(value ?? '').trim();
  return normalized || undefined;
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
  const temporary = `${target}.${randomUUID().slice(0, 8)}.tmp`;
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
  const response = await fetch(url, { signal: AbortSignal.timeout(PROXY_TIMEOUT_MS), ...options });
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

// ── 纯判据 ────────────────────────────────────────────────────────────────────

// 输入：/targets 的 page 列表 + 每个登录页签读到的可见文本（读不到的给 null）。
// 输出：{ status, reason, loginTargets: [{ targetId, url, verdict }] }。
//   verdict = 'wall'（登录墙）| 'account'（已登录账号页）| 'unreadable'（读不到）
// 优先级：有任一 wall ⇒ LOGIN_REQUIRED（fail-closed：残留的旧登录墙也是真证据，
// 人关掉它比脚本猜「它也许没用了」安全）。没有登录页签 ⇒ NO_XWS_TAB。
export function classifyLoginTargets({ targets, texts = {}, readable = true } = {}) {
  if (!readable) {
    return {
      status: LOGIN_STATES.TARGETS_UNREADABLE,
      reason: '读不到浏览器页签清单（/targets 没有返回可解析的结果），无法判断登录态。',
      loginTargets: [],
    };
  }
  const pages = (Array.isArray(targets) ? targets : []).filter((item) => item && item.type === 'page');
  const loginTargets = pages.filter(isXiaowangshenLoginTarget).map((target) => {
    const text = texts[target.targetId];
    const verdict = text == null ? 'unreadable' : (isLoggedInAccountText(text) ? 'account' : 'wall');
    return { targetId: target.targetId, url: clean(target.url) ?? '', verdict };
  });
  if (loginTargets.length === 0) {
    return {
      status: LOGIN_STATES.NO_XWS_TAB,
      reason: '浏览器里没有小旺神页签（会话有效时插件本就不会开页）——从页签判断不出登录态，放行由后续环节兜底。',
      loginTargets: [],
    };
  }
  const walls = loginTargets.filter((item) => item.verdict === 'wall');
  if (walls.length > 0) {
    return {
      status: LOGIN_STATES.LOGIN_REQUIRED,
      reason: `小旺神登录墙在位（${walls.length}/${loginTargets.length} 个登录页签未登录）：${walls.map((item) => item.url).join(' , ')}`,
      loginTargets,
    };
  }
  const unreadable = loginTargets.filter((item) => item.verdict === 'unreadable');
  if (unreadable.length > 0) {
    // 有登录页签但一个都读不到：**不许**落成 READY —— 那会把「没读」说成「已登录」。
    // 也不落成 LOGIN_REQUIRED：「读不到」不是登录墙的正面证据，拿它叫人就是误报。
    return {
      status: LOGIN_STATES.UNVERIFIABLE,
      reason: `有 ${unreadable.length} 个小旺神登录页签但可见文本读不到，无法判定登录态；放行由采集宿主与监督环兜底。`,
      loginTargets,
    };
  }
  return {
    status: LOGIN_STATES.READY,
    reason: `小旺神账号页在位（${loginTargets.length} 个页签均已登录）。`,
    loginTargets,
  };
}

// 驱动只问一个问题：要不要在第一段之前就停。只有 LOGIN_REQUIRED 需要停；
// 「查不出」不停（宿主与监督环在后面兜底，且它们的告警通道已修）。
export function shouldAbortForLogin(status) {
  return status === LOGIN_STATES.LOGIN_REQUIRED;
}

// ── 告警构造与投递 ────────────────────────────────────────────────────────────
// 投递形状与 supervise-collection.deliver 逐字一致：告警落临时文件，用 notify-feishu.mjs
// 本来就有的 --alert-file 传，stdio 显式 ['ignore','pipe','pipe']。
// **不许**改回 `input:` 或裸 spawnSync 缺省 stdio：那两种形状隐含 stdin 管道，
// 宿主沙箱下必 EBUSY（2026-10-14 已因此丢过 5 条段级告警，TOOLING-NOTES.md「EBUSY」条）。

export function buildLoginAlert({ checkedAt, statusPath, reason, alertStatus = 'OPEN', classificationStatus = null } = {}) {
  const normalized = String(alertStatus).trim() || 'OPEN';
  const byStatus = ALERT_BY_STATUS[String(classificationStatus ?? '').trim()] ?? ALERT_BY_STATUS.LOGIN_REQUIRED;
  return {
    version: ALERT_VERSION,
    alertId: `xws-weekly-login-${normalized === 'OPEN' ? byStatus.type : 'RESOLVED'}-${timestampId(checkedAt)}`,
    status: normalized,
    severity: normalized === 'OPEN' ? 'HIGH' : 'INFO',
    type: normalized === 'OPEN' ? byStatus.type : 'XWS_WEEKLY_LOGIN_RESOLVED',
    createdAt: new Date(checkedAt ?? Date.now()).toISOString(),
    source: { targetLabel: '浴缸竞品周采集', capability: 'xws.export.market-analysis' },
    reason: String(reason ?? 'Xiaowangshen login is required').trim(),
    action: normalized === 'OPEN'
      ? byStatus.action
      : '小旺神登录态已恢复，竞品周采集可以继续跑。',
    evidence: { statusFile: basename(String(statusPath ?? '')) },
    delivery: { status: 'PENDING' },
  };
}

function compactReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return undefined;
  const status = clean(receipt.status);
  if (!status) return undefined;
  const messageId = clean(receipt.attempts?.find?.((attempt) => attempt?.ok && attempt?.messageId)?.messageId);
  return {
    status,
    ...(clean(receipt.channel) ? { channel: clean(receipt.channel) } : {}),
    ...(clean(receipt.alertId) ? { alertId: clean(receipt.alertId) } : {}),
    ...(clean(receipt.sentAt) ? { sentAt: clean(receipt.sentAt) } : {}),
    ...(messageId ? { messageId } : {}),
    ...(clean(receipt.error) ? { error: clean(receipt.error).slice(0, 300) } : {}),
  };
}

export function deliverLoginAlert(alert, { spawnImpl = spawnSync, tmpDir = HERE } = {}) {
  const alertFile = join(resolve(tmpDir), `weekly-login-alert-${process.pid}-${Date.now()}.json`);
  try {
    writeFileSync(alertFile, jsonText(alert), 'utf8');
    const result = spawnImpl(process.execPath, [DEFAULT_NOTIFY_CLI, '--alert-file', alertFile], {
      cwd: resolve(HERE, '..'),
      encoding: 'utf8',
      timeout: NOTIFY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) {
      return { status: 'FAILED', error: `spawn ${result.error.code ?? '?'}: ${String(result.error.message ?? '').slice(0, 200)}` };
    }
    const stdout = String(result.stdout ?? '').trim();
    if (result.status !== 0) {
      return { status: 'FAILED', error: `exit ${result.status}: ${(stdout || String(result.stderr ?? '')).slice(0, 200)}` };
    }
    let parsed;
    try { parsed = JSON.parse(stdout); } catch { parsed = undefined; }
    return compactReceipt(parsed) ?? { status: 'SENT' };
  } catch (error) {
    return { status: 'FAILED', error: String(error?.message ?? error).slice(0, 300) };
  } finally {
    try { unlinkSync(alertFile); } catch { /* 临时文件清不掉不影响主流程 */ }
  }
}

// 去重按「同一个 type + 同一句原因」成对判定；恢复通知只在之前真有 OPEN 告警时发。
export async function persistLoginAlert({ stateDir, statusPath, checkedAt, reason, classificationStatus, deliver = deliverLoginAlert }) {
  const alertPath = resolve(stateDir, 'operator-alert.json');
  const alert = buildLoginAlert({ checkedAt, statusPath, reason, classificationStatus });
  let previous;
  if (existsSync(alertPath)) {
    try { previous = JSON.parse(await readFile(alertPath, 'utf8')); } catch { /* replace invalid alert evidence */ }
  }
  const duplicateOpenAlert = previous?.status === 'OPEN'
    && previous?.type === alert.type
    && previous?.reason === alert.reason;
  if (duplicateOpenAlert) {
    alert.delivery = { status: 'DEDUPED', previousAlertId: previous.alertId };
  } else {
    alert.delivery = deliver(alert);
  }
  await writeJson(alertPath, alert);
  return { alertPath, alert };
}

export async function resolveLoginAlert({ stateDir, statusPath, checkedAt, deliver = deliverLoginAlert }) {
  const alertPath = resolve(stateDir, 'operator-alert.json');
  if (!existsSync(alertPath)) return undefined;
  let previous;
  try { previous = JSON.parse(await readFile(alertPath, 'utf8')); } catch { return undefined; }
  if (previous?.status !== 'OPEN' || previous?.type !== ALERT_BY_STATUS.LOGIN_REQUIRED.type) return undefined;
  const alert = buildLoginAlert({
    checkedAt,
    statusPath,
    reason: 'Xiaowangshen login preflight recovered',
    alertStatus: 'RESOLVED',
  });
  alert.delivery = deliver(alert);
  await writeJson(alertPath, alert);
  return { alertPath, alert };
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

export function parsePreflightArgs(argv = []) {
  const options = { proxy: DEFAULT_PROXY, stateDir: DEFAULT_STATE_DIR, notifyDisabled: false };
  const valueOptions = new Map([
    ['--proxy', 'proxy'],
    ['--state-dir', 'stateDir'],
  ]);
  // 旗标（不带值）。`--no-notify` 是**显式静音**：不给它才是默认「出事就叫人的」。
  const flagOptions = new Map([['--no-notify', 'notifyDisabled']]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const flagKey = flagOptions.get(argument);
    if (flagKey) {
      options[flagKey] = true;
      continue;
    }
    const key = valueOptions.get(argument);
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    options[key] = value;
    index += 1;
  }
  options.proxy = String(options.proxy ?? '').trim() || DEFAULT_PROXY;
  options.stateDir = String(options.stateDir ?? '').trim() || DEFAULT_STATE_DIR;
  return options;
}

async function readLoginTabTexts(proxy, loginTargets) {
  const texts = {};
  for (const target of loginTargets) {
    try {
      const response = await requestJson(`${proxy}/eval?target=${encodeURIComponent(target.targetId)}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'document.body ? (document.body.innerText || "").slice(0, 1500) : ""',
      });
      texts[target.targetId] = String(response?.value ?? response ?? '');
    } catch {
      texts[target.targetId] = null; // 读不到这一个页签 ≠ 它是登录墙（见 classifyLoginTargets）
    }
  }
  return texts;
}

export async function runLoginPreflight(options = {}, { fetchTargetsImpl = null, readTextsImpl = null, deliver = null } = {}) {
  const checkedAt = new Date().toISOString();
  const stateDir = resolve(options.stateDir ?? DEFAULT_STATE_DIR);
  const notifyDisabled = options.notifyDisabled === true;

  let targets = [];
  let readError = null;
  try {
    const payload = fetchTargetsImpl
      ? await fetchTargetsImpl(options.proxy)
      : await requestJson(`${options.proxy}/targets`);
    targets = (Array.isArray(payload) ? payload : payload?.targets ?? []).filter((item) => item && item.type === 'page');
  } catch (error) {
    readError = String(error?.message ?? error).slice(0, 300);
  }

  const loginPages = readError === null ? targets.filter(isXiaowangshenLoginTarget) : [];
  const texts = loginPages.length > 0
    ? await (readTextsImpl
      ? readTextsImpl(options.proxy, loginPages)
      : readLoginTabTexts(options.proxy, loginPages))
    : {};

  const classification = readError === null
    ? classifyLoginTargets({ targets, texts, readable: true })
    : {
      status: LOGIN_STATES.PROXY_UNREACHABLE,
      reason: `预检读不到买家浏览器页签（${readError}）——这不代表登录态有问题，放行由采集宿主与监督环兜底。`,
      loginTargets: [],
    };

  const status = {
    version: STATUS_VERSION,
    checkedAt,
    proxy: options.proxy,
    status: classification.status,
    reason: classification.reason,
    blocking: classification.status === LOGIN_STATES.LOGIN_REQUIRED,
    loginTargets: classification.loginTargets,
    notify: notifyDisabled ? 'MUTED' : 'default-cli',
  };
  const runId = timestampId(checkedAt);
  const statusPath = await writeJson(join(stateDir, `login-status-${runId}.json`), status, { exclusive: true });

  const result = {
    status: classification.status,
    reason: classification.reason,
    blocking: status.blocking,
    statusPath: basename(statusPath),
  };

  if (ALERTING_STATUSES.includes(classification.status)) {
    if (notifyDisabled) {
      result.notification = { status: 'MUTED' };
    } else {
      const { alert } = await persistLoginAlert({
        stateDir,
        statusPath,
        checkedAt,
        reason: classification.reason,
        classificationStatus: classification.status,
        ...(deliver ? { deliver } : {}),
      });
      result.notification = alert.delivery;
      result.action = alert.action;
      result.alertType = alert.type;
    }
  } else if (classification.status === LOGIN_STATES.READY && !notifyDisabled) {
    const resolved = await resolveLoginAlert({ stateDir, statusPath, checkedAt, ...(deliver ? { deliver } : {}) });
    if (resolved) result.notification = resolved.alert.delivery;
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parsePreflightArgs(argv);
  } catch (error) {
    console.error(JSON.stringify({ status: 'FAILED', error: String(error?.message ?? error) }));
    process.exitCode = 3;
    return;
  }
  const result = await runLoginPreflight(options);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === LOGIN_STATES.LOGIN_REQUIRED) process.exitCode = 2;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: 'FAILED', error: String(error?.message ?? error) }));
    process.exitCode = 3;
  });
}
