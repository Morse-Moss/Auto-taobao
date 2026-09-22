#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { updateSkuBatchIndex } from './xws-sku-batch-index.mjs';
import { PROJECT_PORTS } from './browser-ports.mjs';

// 本项目专用 CDP 代理端口来自 runtime/browser-ports.mjs（唯一来源），不是写死的字符串。
// 3456 属于另一个项目、挂在用户的日常 Edge 上且**没有小旺神**——默认值写成它会静默指向错目标。
const DEFAULT_PROXY = `http://127.0.0.1:${PROJECT_PORTS.competitorProxy}`;
const AUTH_STATUS_VERSION = 'xws-sku-auth-preflight-v1';
const ALERT_VERSION = 'xws-sku-operator-alert-v1';

// 通知出口的默认值 = 仓库里那条已经跑通的投递 CLI（`notify-feishu.mjs`：零参数、凭据从飞书
// profile 的 env 文件读、主通道个人消息→兜底群→webhook 三跳）。
//
// 为什么必须有个默认值：本文件原来把 notifyCommand 留空，于是 `notifyOperator` 直接返回
// `NOT_CONFIGURED` —— 告警**写进了证据文件，但没有任何人会被叫到**。2026-09-13 那一期的
// SKU 富化就是这么静默卡住的（docs/ops/WEEKLY-SUPERVISION-2026-09-13_2026-09-19.md:124
// 记的「飞书未收到提醒」就是它），LOGIN-STATE-MANAGEMENT.md:218 也把它列为待办。
//
// 为什么是 `node + .mjs` 而不是把 .mjs 当命令直接 spawn：Windows 上 .mjs 不是可执行文件，
// 直接 spawn 会 EINVAL。仓库里其它三条链（run-weekly-collection / supervise-collection /
// login-merchant）统一都是 `spawn(process.execPath, [NOTIFY_CLI])`，这里跟它们保持一致——
// **复用同一条投递链，不另造**。
//
// 为什么不用 `import` 直接调 `main()`：投递是外部副作用，这条边界是本文件与
// notify-feishu.mjs 文件头共同写死的（「判定」留给内核，「投递」留给子进程与退出码）。
const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_NOTIFY_CLI = join(HERE, 'notify-feishu.mjs');

// 投递命令最多等多久。默认出口要发两次 HTTPS（取 tenant_access_token + 发消息），
// 原来的 10 秒对真实网络偏紧：超时会 `kill` 掉子进程，而那时消息**可能已经发出去了** ——
// 那正是「结果未知」最难对账的形态（见 COMMIT_UNKNOWN 那条口径），所以宁可多等。
const NOTIFY_TIMEOUT_MS = 30_000;

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
  const options = { proxy: DEFAULT_PROXY, notifyDisabled: false };
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

// 「这一轮要不要叫人、叫谁」是一个决定，所以**只在这里决定一次**。
// 三个来源的优先级（高 → 低）：
//   1. `--no-notify`（显式静音）
//   2. `--notify-command <path>`（运营自备的投递目标：`.mjs`/`.js` 用 node 跑，其它按可执行文件起）
//   3. 默认 = 仓库内的投递 CLI（用 node 跑）
//
// 静音赢过另外两者：这个开关的语义就是「别发出去」，如果在冲突时让它输掉，
// 「明确说了不发」会变成「还是发了」——那是最不该出错的方向。
// 反过来，`--notify-command` 依旧压过默认值，所以老调用方（含运营自备包装器）行为不变。
export function resolveNotifyTarget(options = {}) {
  if (options.notifyDisabled) return null;
  const wrapper = clean(options.notifyCommand);
  if (wrapper) return notifyTargetForPath(wrapper);
  return { command: process.execPath, args: [DEFAULT_NOTIFY_CLI] };
}

// 运营自备的投递目标：**两种形状**都收。
//   · `.mjs` / `.js` → 用 node 跑（零参数，同默认出口的契约）
//   · 其它（真 .exe 等）→ 按可执行文件直接 spawn
// 为什么认 .mjs/.js：文档把 `--notify-command` 写成「path-to-wrapper」，并建议
// 「.mjs 外面包一个 .cmd」——而 `.cmd` 在 Node ≥18.20.2 的 shell:false 下**同步抛 EINVAL**
// （2026-09-22 实测）。那条路是死的，所以直接把 .mjs/.js 收进来，别让运营去撞。
export function notifyTargetForPath(wrapper) {
  return /\.m?js$/iu.test(wrapper)
    ? { command: process.execPath, args: [wrapper] }
    : { command: wrapper, args: [] };
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
      // `false` 的意思是「看过页面了，它不在」；`null` 的意思是「压根没读到页面」。
      // 上一轮（页面不在位）原来会把这两件事都写成 `false` —— 那是把「没读」说成「插件不在」，
      // 会把运营送去重装插件。缺页面时这里必须是 null，读过了才允许是布尔。
      pluginPresent: snapshot == null ? null : snapshot.pluginPresent === true,
      skuControlPresent: snapshot == null ? null : snapshot.skuControlPresent === true,
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
// 导出是为了让用例能跨模块钉住两件事：①每个 type 在投递侧都有一个人话标题；
// ②ALERTING_STATUSES 里的每个状态这里都有文案。这两条都是「少写一行就静默失效」的地方。
export const ALERT_BY_STATUS = Object.freeze({
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
  // 2026-09-22 新增。这个状态**发生在分类器之前**：目标页根本没找到（或读页失败），
  // 所以它不是「登录墙看到了」而是「连看的地方都没有」。它是 2026-09-20 那一期的真实断点
  // （evidence/sku-step6-2026-09-20/INDEX.md：STALLED「Product page target is unavailable」），
  // 而当时这条路上一个告警都不会产生 —— 现在补上。
  PAGE_UNAVAILABLE: {
    type: 'XWS_PAGE_UNAVAILABLE',
    // 文案里**不许出现 Markdown 强调标记**（`**x**`）：这条字最终是以飞书**纯文本**消息发出去的，
    // 星号不会被渲染、会原样打进运营眼里。2026-09-22 真发预览时看到的就是 `**买家**`。
    // 配套判据：本文件用例「动作文案不能带 Markdown 强调标记」遍历 ALERT_BY_STATUS 逐条挡。
    action: '在采集用的那个 Edge 用户配置里（装着「小旺神」插件的买家账号那个）把这个商品的'
      + '页面打开、等它加载完，再重新运行预检。页面本来就开着还报这个，说明窗口被切走或浏览器'
      + '被回收了：先确认采集浏览器还在运行、代理端口没变，再打开商品页。',
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
    // 初始值只表示「还没投递」，落盘前一定会被 persistAlert / resolveAlert 覆盖。
    // 这里原来写的是 `NOT_CONFIGURED` —— 那个值现在的含义是「线没接上」，留作占位会误导读者，
    // 也会让「某个未来分支忘了覆盖」看起来像正常的未配置状态。
    delivery: { status: 'PENDING' },
  };
}

// 投递收据只留下「判断送达与否要用的字段」。特别注意**不留 `attempts`**：
// 它逐条带着 `target`（收件人的 open_id / chat_id），没理由把它抄进证据文件。
//
// 但 `messageId` **必须留**。它原来是被连坐剥掉的——因为它长在 `attempts[]` 里，而那一项同时
// 带着收件人 id，于是「剥掉收件人」顺手把「平台回执号」也剥了。代价是这份收据**没法被独立复验**：
// 事后想确认「这条到底发出去了没有」，手上没有任何可以去 `GET /im/v1/messages/{message_id}`
// 的凭据，只能选择相信本文件自己写的那句 `SENT`。而 messageId 本身不含收件人信息
// （`om_x100…` 是平台给这条消息的编号），留着它不泄露任何东西，却把证据链补齐了。
// 2026-09-22 真发那一条时发现的：收据里只有 status 与 sentAt，回读无从下手。
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
    // 平台回执号：有了它，任何人事后都能拿 GET /open-apis/im/v1/messages/{id} 独立复验。
    ...(messageId ? { messageId } : {}),
    ...(clean(receipt.error) ? { error: clean(receipt.error).slice(0, 300) } : {}),
  };
}

function parseReceiptFromStdout(stdout) {
  const raw = String(stdout ?? '').trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    // 运营自备的包装器可以往 stdout 打任何东西（日志、空）。那不是错误，回落到退出码判断。
    return undefined;
  }
}

async function notifyOperator(target, alert) {
  // 静音是一个**决定**，不是「没配」：所以它有自己的收据值。
  // 这里刻意不再用 `NOT_CONFIGURED` —— 那个值原来的含义就是「线没接上」，2026-09-13 那期
  // 就是它把「卡点无人知晓」盖成了「一切照常」。让静音与断线长得一样，等于把坑留着。
  //
  // ⚠️ 下游口径提醒：`MUTED` **不在** `runtime/sop-runtime/round-history.mjs` 的
  // `undelivered`（它只数 FAILED / NOT_CONFIGURED）。今天到不了那里——那条链有自己的投递实现，
  // 这个函数只服务于本文件；但如果哪天把这里的收据并进轮次账本，「静音」会被那张表**静默漏掉**。
  // 那种「新枚举只活在 N 处中的 1 处」的坑本项目已经踩过两次（006/008 的失败分类），所以先写在这。
  if (!target) return { status: 'MUTED' };
  return new Promise((resolveNotification, rejectNotification) => {
    let child;
    try {
      child = spawn(target.command, target.args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // **同步抛**，不是 'error' 事件：Node ≥18.20.2（CVE-2024-27980 加固）之后
      // `spawn('x.cmd', [], { shell: false })` 直接抛 EINVAL —— 也就是说
      // 「.mjs 外面包一个 .cmd」这条文档里的兜底做法在本机 Node 22 上是**跑不通的**
      // （2026-09-22 实测，见 tmp/_probe-cmd-spawn.out.txt / evidence）。
      // 所以这里显式兜住并给出可做的动作，而不是留一句裸的「spawn EINVAL」。
      rejectNotification(new Error(
        `Operator notification command could not be started (${String(error?.message ?? error)}); `
        + 'pass a real .exe, or an .mjs/.js path (those are run with node) — .cmd/.bat wrappers '
        + 'cannot be spawned with shell:false on this Node version',
      ));
      return;
    }
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectNotification(new Error('Operator notification command timed out'));
    }, NOTIFY_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
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
      // 退出码 0 只说明「命令跑完了」，不说明「消息出去了」。投递 CLI 会把自己的收据 JSON
      // 打到 stdout（`feishu-notify-receipt-v1`），**那个才是结论**；拿不到收据时
      // （运营自备的包装器不打印 JSON）才回落到「按退出码算送达」。
      // 仓库里同一原则：login-merchant.mjs 也不替 CLI 下结论，只抄它报的状态。
      resolveNotification(compactReceipt(parseReceiptFromStdout(stdout)) ?? { status: 'SENT' });
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

async function persistAlert({ outputDirectory, source, statusPath, checkedAt, reason, notifyTarget, classificationStatus = null }) {
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
      alert.delivery = await notifyOperator(notifyTarget, alert);
    } catch (error) {
      alert.delivery = { status: 'FAILED', error: String(error?.message ?? error).slice(0, 300) };
    }
  }
  await writeJson(alertPath, alert);
  return { alertPath, alert };
}

async function resolveAlert({ outputDirectory, source, statusPath, checkedAt, notifyTarget }) {
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
    alert.delivery = await notifyOperator(notifyTarget, alert);
  } catch (error) {
    alert.delivery = { status: 'FAILED', error: String(error?.message ?? error).slice(0, 300) };
  }
  await writeJson(alertPath, alert);
  return { alertPath, alert };
}

// 哪些状态要写告警（即「需要人动手」）。与 docs/ops/LOGIN-STATE-MANAGEMENT.md §4 的表一致：
// SOURCE_MISMATCH 不通知（属流程参数问题，记证据即可），AUTH_READY 不通知（只在恢复时补一条）。
export const ALERTING_STATUSES = Object.freeze([
  'AUTH_REQUIRED',
  'ACCOUNT_MISMATCH',
  'AUTH_UNKNOWN',
  'PLUGIN_UNAVAILABLE',
  'PLUGIN_NOT_READY',
  // 2026-09-22 补：读页阶段就失败（目标页不在位 / 代理不通）。它以前连告警都不产生，
  // 是本期真实卡住的那条路，所以必须在「要叫人」的名单里。
  'PAGE_UNAVAILABLE',
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
  const notifyTarget = resolveNotifyTarget(options);

  // 「读页面」这一段（找到目标标签页 → 在页面上跑探测）失败时**也要落告警**。
  // 原实现在这里直接 throw：既没进分类器、也没写 alert —— 「商品页不在位」这条本期真断点
  // 因此一声不响地卡住（evidence/sku-step6-2026-09-20）。现在把它归到 PAGE_UNAVAILABLE，
  // 走同一条告警与去重路径；**退出码语义不变**（末尾仍走 stalled → exit 3）。
  //
  // 归到「需要人」而不是「BUG」的理由：这一段的两种失败（找不到目标页 / 代理读不到）都是现场问题，
  // 人打开页面或拉起浏览器就能解 —— 与 docs/ops/LOGIN-STATE-MANAGEMENT.md §4 的分类口径一致。
  // reason 里保留原始报文，真要是代码缺陷，看「原因」那行看得出来。
  let target = null;
  let snapshot = null;
  let classification;
  try {
    target = await discoverTarget(options.proxy, options);
    snapshot = await evaluateTarget(options.proxy, target.targetId, options.accountSelector);
    classification = classifyAuthSnapshot(snapshot, options.productId, {
      expectedAccount: options.expectedAccount,
    });
  } catch (error) {
    classification = {
      status: 'PAGE_UNAVAILABLE',
      reason: `Preflight could not read the product page: ${String(error?.message ?? error)}`.slice(0, 300),
    };
  }
  const status = buildAuthStatus({
    checkedAt,
    source,
    targetUrl: target?.url,
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
      notifyTarget,
      classificationStatus: classification.status,
    });
    artifacts.operatorAlert = alert.alertPath;
  } else if (classification.status === 'AUTH_READY') {
    const resolved = await resolveAlert({
      outputDirectory,
      source,
      statusPath,
      checkedAt,
      notifyTarget,
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
