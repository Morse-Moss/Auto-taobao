// 四层体检（`UNATTENDED-AGENT-RUNTIME-PLAN.md` 第 4 步）的落地模块。
//
// 设计依据：`docs/ops/LOGIN-STATE-MANAGEMENT.md` §3（四层判据）与 §4（状态词表）。
// 判据来源：`docs/ops/LOGIN-CRITERIA-MEASUREMENT-2026-09-18.md`（**实测**，不许凭记忆改）。
//
// 本文件当前只实现 L1 环境层，其余三层如实标为「未实现」并可被调用方看见。
// 为什么不全做：L0 的账号标识选择器四个平台一个都没采到（实测记录 §7），L2 的判据只在
// 「会话已失效」的凭证库上取过差（实测记录 §6），此时把它们写成检查，等于把「没做过的检查」
// 写成 OK —— 那正是 §7 禁止的假绿。L1 的判据已实测且不依赖登录态（§9 第 4 条），所以先做它。
//
// 三条硬约束（沿用现有实现，见 `xws-sku-auth-preflight.mjs` 与 `browser-ports.classifyPortUsage`）：
//
// 1. **只对「有正面证据」的问题下判决。** 探针读不出来 ≠ 有问题：
//    `classifyPortUsage` 已经写明「凭『探针没读到』停线，会让一次网络抖动变成一次事故」。
//    所以本模块把「读到了并且不对」判 blocking，「没读到」降级为不阻断的告警 finding。
//    与之相对，L0/L2 一旦实现，判据缺失要按 §4 的 `AUTH_UNKNOWN` **不放行**——
//    因为那两层的失败形态是「身份错了但一切看起来正常」，代价是静默写错数据。
//    两条口径不同，是因为代价不同，不是因为健忘。
// 2. **未实现的层不许静默。** 没跑过的层要在收据的 `note` 里逐条点名，
//    并且**不许**把它的缺席写成 OK。
// 3. **发出的每个理由都必须已在通知判据表里表态。** 表里查不到的理由会被 fail-closed 成
//    `HEALTH_BLOCKED`，运营收到的是「本轮体检未通过」这种没法处理的话。单测守住这条对齐。
import { BROWSER_PROFILES, classifyPortUsage, inspectPort, PROJECT_PORTS } from './browser-ports.mjs';

export const HEALTH_CONTRACT_VERSION = 'xws-platform-health-preflight-v1';

// ---------------------------------------------------------------- 词表

export const HEALTH_LAYERS = Object.freeze({
  IDENTITY: 'IDENTITY',     // L0 身份层：登的是不是目标身份（最贵的一层，也最容易被跳过）
  ENVIRONMENT: 'ENVIRONMENT', // L1 环境层：进程、端口、出网路径（0 成本）
  SESSION: 'SESSION',       // L2 会话层：凭证存在性与到期（只读，不发业务请求）
  END_TO_END: 'END_TO_END', // L3 端到端层：一次只读探针（最贵，一轮一次，失败不重试）
});

// §4 的状态词表：在 `xws-sku-auth-preflight.mjs` 的既有值上**只加不删**。
// `NOT_IMPLEMENTED` 是刻意与 `AUTH_UNKNOWN` 分开的两个值：
//   AUTH_UNKNOWN     = 有判据，但这会儿读不出来（平台改版/页面变了）⇒ 要停线
//   NOT_IMPLEMENTED  = 压根还没有判据（本模块的当前状态）⇒ 只记账，不冒充结论
// 把两者合成一个值，就会让「我们还没做过这项检查」看起来像「检查发现有问题」。
export const HEALTH_STATES = Object.freeze({
  AUTH_READY: 'AUTH_READY',
  AUTH_EXPIRING: 'AUTH_EXPIRING',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  ACCOUNT_MISMATCH: 'ACCOUNT_MISMATCH',
  RISK_BLOCKED: 'RISK_BLOCKED',
  PLUGIN_UNAVAILABLE: 'PLUGIN_UNAVAILABLE',
  PLUGIN_NOT_READY: 'PLUGIN_NOT_READY',
  SOURCE_MISMATCH: 'SOURCE_MISMATCH',
  AUTH_UNKNOWN: 'AUTH_UNKNOWN',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
});

// 本模块会发出的 finding 理由。每一个都必须在 `round-notify-policy.mjs` 的表里有结论
// （否则运营收到的是没法处理的那句话）。对齐由 `xws-platform-health-preflight.test.mjs` 守住。
export const HEALTH_REASONS = Object.freeze({
  BROWSER_DEBUG_PORT: 'BROWSER_DEBUG_PORT',           // 复用既有：端口不可用/被别的东西占着
  EGRESS_PROXY_UNREACHABLE: 'EGRESS_PROXY_UNREACHABLE', // 新增：出网代理不通报
  TARGET_PAGE_MISSING: 'TARGET_PAGE_MISSING',         // 新增：目标页面不在，或多于一个
});

export const HEALTH_CODES = Object.freeze({
  CDP_ENDPOINT_MISSING: 'CDP_ENDPOINT_MISSING',
  CDP_ENDPOINT_UNIDENTIFIED: 'CDP_ENDPOINT_UNIDENTIFIED',
  BROWSER_PROFILE_FOREIGN: 'BROWSER_PROFILE_FOREIGN',
  BROWSER_PROFILE_UNREADABLE: 'BROWSER_PROFILE_UNREADABLE',
  EGRESS_PROXY_NOT_DECLARED: 'EGRESS_PROXY_NOT_DECLARED',
  EGRESS_PROXY_UNREACHABLE: 'EGRESS_PROXY_UNREACHABLE',
  EGRESS_PROXY_UNREADABLE: 'EGRESS_PROXY_UNREADABLE',
  TARGET_PAGE_MISSING: 'TARGET_PAGE_MISSING',
  TARGET_PAGE_AMBIGUOUS: 'TARGET_PAGE_AMBIGUOUS',
  TARGET_PAGE_UNREADABLE: 'TARGET_PAGE_UNREADABLE',
});

// 每层的实现状态。**未实现必须写明卡在哪**，否则下一个人只能靠猜。
export const LAYER_IMPLEMENTATION = Object.freeze({
  [HEALTH_LAYERS.IDENTITY]: Object.freeze({
    implemented: false,
    blockedBy: '账号标识选择器四个平台一个都没采到（LOGIN-CRITERIA-MEASUREMENT-2026-09-18.md §7），'
      + '需要先换定位手段（按可见用户名文本反查 / 读账号接口）并恢复淘宝系登录态。',
  }),
  [HEALTH_LAYERS.ENVIRONMENT]: Object.freeze({
    implemented: true,
    blockedBy: null,
  }),
  [HEALTH_LAYERS.SESSION]: Object.freeze({
    implemented: false,
    blockedBy: '实测的判据只在「会话已失效」的凭证库上取过差（同文件 §6），'
      + '现在分不出「会话凭证」与「长期标记」——用错会把登出后的残留当成已登录，因此先不做。',
  }),
  [HEALTH_LAYERS.END_TO_END]: Object.freeze({
    implemented: false,
    blockedBy: '只读探针要导航+预算+冷却；现有 resolveTarget 已在每一步 fail-loud 认页面，'
      + '体检层再抄一遍只会多一份要维护的判据（这层等 L0/L2 落地后再补）。',
  }),
});

// ---------------------------------------------------------------- 纯函数（判据都在这里）

// CDP 端口上现在是什么、是不是我们那个 profile。
export function classifyBrowserPort({ inspection, expectedProfile, port } = {}) {
  const usage = classifyPortUsage(inspection ?? { status: 'free' }, { expectedProfile });
  // 正面证据：读出了 --user-data-dir 且与期望一致。
  if (usage.verdict === 'ours') return null;

  const base = { layer: HEALTH_LAYERS.ENVIRONMENT, reason: HEALTH_REASONS.BROWSER_DEBUG_PORT };
  if (usage.verdict === 'foreign') {
    // 读到了，而且**不是**我们的 profile：这是正面证据，判停线（在错的浏览器上查登录态，
    // 会得到「已登录」而实际那是另一个账号 —— 正是最该拦、却最容易被漏掉的一侧）。
    return {
      ...base,
      code: HEALTH_CODES.BROWSER_PROFILE_FOREIGN,
      state: HEALTH_STATES.AUTH_UNKNOWN,
      detail: `端口 ${port} 上的浏览器 profile 是 ${usage.profile}，不是期望的 ${expectedProfile}；`
        + '在这个浏览器上做采集会把另一个账号的数据当成目标账号的。',
      blocking: true,
    };
  }
  if (usage.verdict === 'unknown' && inspection?.status === 'occupied-unidentified') {
    // 端口在监听，但不是可读的 CDP 端点 ⇒ 启动器会因为这个端口「被占」而拒绝启动我们的浏览器。
    return {
      ...base,
      code: HEALTH_CODES.CDP_ENDPOINT_UNIDENTIFIED,
      state: HEALTH_STATES.AUTH_UNKNOWN,
      detail: `端口 ${port} 在监听，但读不出 CDP 端点（不是浏览器，或还没就绪）；`
        + '我们的浏览器起不来，采集链一步都跑不了。',
      blocking: true,
    };
  }
  if (usage.verdict === 'unknown') {
    // 端口有 CDP 端点，但 command line 没读出来 ⇒ **只警告不拦**（见文件头第 1 条）。
    return {
      ...base,
      code: HEALTH_CODES.BROWSER_PROFILE_UNREADABLE,
      state: HEALTH_STATES.AUTH_UNKNOWN,
      detail: `端口 ${port} 上能连到 CDP，但读不出 --user-data-dir，无法确认是不是期望的 profile`
        + `（${expectedProfile}）。本次不停线，但登录态检查的结论要打折扣看。`,
      blocking: false,
    };
  }
  // free：端口没人监听 ⇒ 浏览器没起来。
  return {
    ...base,
    code: HEALTH_CODES.CDP_ENDPOINT_MISSING,
    state: HEALTH_STATES.AUTH_UNKNOWN,
    detail: `端口 ${port} 上没有浏览器（CDP 端点连不上）；自动化浏览器没启动或已被回收。`,
    blocking: true,
  };
}

// 目标页面：按 URL 片段数一遍，必须**恰好**每个站一个。
// 判据取自已经在跑的 `date-picker.resolveTarget`（同一个片段、同样「恰好一个」的口径），
// 页面片段由调用方注入，避免在第二处再写一遍。
export function classifyExpectedPages({ targets, expectedPages, readable = true } = {}) {
  const findings = [];
  if (!Array.isArray(expectedPages) || expectedPages.length === 0) return findings;
  if (!readable) {
    // 列页面失败 = 没读到，不是「页面不在」。这两件事的处置完全不同，不能合并。
    findings.push({
      layer: HEALTH_LAYERS.ENVIRONMENT,
      code: HEALTH_CODES.TARGET_PAGE_UNREADABLE,
      state: HEALTH_STATES.AUTH_UNKNOWN,
      reason: HEALTH_REASONS.TARGET_PAGE_MISSING,
      detail: '读不到页面清单（/targets 没有返回可解析的结果），无法判断目标页面在不在。',
      blocking: false,
    });
    return findings;
  }
  const list = Array.isArray(targets) ? targets : [];
  for (const page of expectedPages) {
    const fragment = String(page?.urlFragment ?? '');
    const name = String(page?.name ?? fragment);
    if (!fragment) continue;
    const hits = list.filter((target) => target?.type === 'page' && String(target.url ?? '').includes(fragment));
    if (hits.length === 1) continue;
    findings.push({
      layer: HEALTH_LAYERS.ENVIRONMENT,
      code: hits.length === 0 ? HEALTH_CODES.TARGET_PAGE_MISSING : HEALTH_CODES.TARGET_PAGE_AMBIGUOUS,
      state: HEALTH_STATES.AUTH_UNKNOWN,
      reason: HEALTH_REASONS.TARGET_PAGE_MISSING,
      detail: hits.length === 0
        ? `目标页面「${name}」不在这个浏览器里（按片段 ${fragment} 找到 0 个）；采集会从落位那一步就失败。`
        : `目标页面「${name}」不唯一（按片段 ${fragment} 找到 ${hits.length} 个）；`
          + '而认页面靠的是「恰好一个」，多出来的会让流水线挑错那一页。',
      blocking: true,
    });
  }
  return findings;
}

// 出网路径。
//
// 为什么是「声明式」而不是去读注册表：2026-09-18 实测到的失败模式是
// **机器级系统代理**（WinINET `ProxyEnable=1` / `ProxyServer=127.0.0.1:7897`）指向一个没开的
// 代理软件，浏览器跟随它 ⇒ **所有**页面报 `ERR_PROXY_CONNECTION_FAILED`，页面标题只剩域名。
// profile 自己没有任何代理配置，所以这不是本项目配置能修的问题。
//
// 读注册表是这条判据最直接的做法，但**本机 `reg.exe` 被安全策略拉黑、且明确禁止等价绕过**，
// 我无法把那条实现端到端验证一遍 —— 按本项目纪律，不发布没验证过的判据。
// 于是改成：出网代理由调用方**显式声明**（配置层/环境变量），声明了就探它的可达性；
// 没声明就如实说「判不出出网路径」，并把这个缺口本身报出来（它正是那次全站打不开的成因）。
export function classifyEgress({ declaration, reachable = null } = {}) {
  if (!declaration || !declaration.host) {
    return {
      layer: HEALTH_LAYERS.ENVIRONMENT,
      code: HEALTH_CODES.EGRESS_PROXY_NOT_DECLARED,
      state: HEALTH_STATES.AUTH_UNKNOWN,
      reason: null,
      detail: '没有声明出网代理，判不出浏览器走哪条路出网。浏览器默认跟随机器级系统代理，'
        + '机器级代理不可达时**所有**页面都报 ERR_PROXY_CONNECTION_FAILED（2026-09-18 实测）。'
        + '要么显式声明出网代理，要么启动浏览器时固定用 --no-proxy-server。',
      blocking: false,
    };
  }
  if (reachable === null) {
    return {
      layer: HEALTH_LAYERS.ENVIRONMENT,
      code: HEALTH_CODES.EGRESS_PROXY_UNREADABLE,
      state: HEALTH_STATES.AUTH_UNKNOWN,
      reason: HEALTH_REASONS.EGRESS_PROXY_UNREACHABLE,
      detail: `探不动出网代理 ${declaration.host}:${declaration.port}（探测自身出错），`
        + '得不到结论。本次不停线，但页面打不开时要先怀疑这里。',
      blocking: false,
    };
  }
  if (reachable) return null;
  return {
    layer: HEALTH_LAYERS.ENVIRONMENT,
    code: HEALTH_CODES.EGRESS_PROXY_UNREACHABLE,
    state: HEALTH_STATES.AUTH_UNKNOWN,
    reason: HEALTH_REASONS.EGRESS_PROXY_UNREACHABLE,
    detail: `声明的出网代理 ${declaration.host}:${declaration.port} 连不上（TCP 拒绝/超时）。`
      + '浏览器会跟随它 ⇒ 所有页面打不开，而报错信息指向站点、不指向代理。',
    blocking: true,
  };
}

// ---------------------------------------------------------------- 汇总

export function buildHealthResult(findings = []) {
  const list = findings.filter(Boolean);
  const blocking = list.filter((finding) => finding.blocking);
  return {
    ok: blocking.length === 0,
    findings: list,
    blocking,
  };
}

function describeUnimplementedLayers() {
  return Object.entries(LAYER_IMPLEMENTATION)
    .filter(([, value]) => !value.implemented)
    .map(([layer]) => layer);
}

function buildNote({ findings, layersRun }) {
  const blocking = findings.filter((finding) => finding.blocking);
  const missing = describeUnimplementedLayers();
  const ran = `已跑 ${layersRun.join('/')}`;
  const skipped = missing.length > 0
    ? `；未实现的层：${missing.join('/')}（这几层**没有检查过**，不表示通过）`
    : '';
  if (blocking.length > 0) {
    return `${ran}；未通过 ${blocking.length} 项：${blocking.map((finding) => finding.code).join(', ')}${skipped}`;
  }
  const warnings = findings.length;
  return `${ran}；通过${warnings > 0 ? `（另有 ${warnings} 项不阻断的告警）` : ''}${skipped}`;
}

// ---------------------------------------------------------------- IO（全部可注入，便于离线用例）

function proxyUrlFor(browserKey) {
  const name = `${browserKey}Proxy`;
  const port = PROJECT_PORTS[name];
  // 未登记的浏览器键 ⇒ 直接抛，不要退回某个默认端口 —— 退回去就是静默指向别人的浏览器。
  if (!Number.isInteger(port)) {
    throw new Error(`unknown browser key for health check: ${browserKey} (expected one of ${Object.keys(PROJECT_PORTS).join(' | ')})`);
  }
  return `http://127.0.0.1:${port}`;
}

function browserPortFor(browserKey) {
  const name = `${browserKey}Browser`;
  const port = PROJECT_PORTS[name];
  if (!Number.isInteger(port)) {
    throw new Error(`unknown browser key for health check: ${browserKey} (expected one of ${Object.keys(PROJECT_PORTS).join(' | ')})`);
  }
  return port;
}

async function probeTcp({ host, port, timeoutMs = 1500 }) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function readTargets(proxyUrl, timeoutMs) {
  const response = await fetch(`${proxyUrl}/targets`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`GET /targets → HTTP ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload) ? payload : payload?.targets ?? [];
}

// 把「出网代理怎么声明」收敛到一个地方：`PROJECT_EGRESS_PROXY=http://127.0.0.1:7897` 这种写法。
// 解析不出来就当成**没声明**，而不是猜一个端口 —— 猜错会把一个死代理探成活的。
export function parseEgressProxy(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = /^(?:https?:\/\/)?([^/:]+):(\d{1,5})$/u.exec(text);
  if (!match) return null;
  const port = Number.parseInt(match[2], 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1], port };
}

// ---------------------------------------------------------------- 体检入口

const DEFAULT_BROWSER_KEY = 'dailyReport';

// 生成给 `round-runner.runRound` 的 `healthCheck` 端口。
// 传进来的 `expectedPages` 属于**注入**而不是内置：页面片段已经在 `date-picker.SITES` 里有一份
// 权威定义，在这里再写一遍就是第二个真相源。
export function createPlatformHealthCheck(options = {}) {
  const {
    browserKey = DEFAULT_BROWSER_KEY,
    expectedPages = [],
    egressProxy = process.env.PROJECT_EGRESS_PROXY ?? null,
    inspectPortImpl = inspectPort,
    readTargetsImpl = readTargets,
    probeTcpImpl = probeTcp,
    expectedProfile = null,
    timeoutMs = 1500,
  } = options;

  // 浏览器键写错要**立刻**抛，不能等体检跑起来才抛：那时 round-runner 会把它当成
  // 「体检自己崩了」（状态 UNKNOWN，照常发起），一个配置笔误就变成「体检长期没在工作」。
  browserPortFor(browserKey);
  proxyUrlFor(browserKey);

  const declared = typeof egressProxy === 'string' ? parseEgressProxy(egressProxy) : egressProxy;
  // profile 身份的期望值取自登记表（唯一来源）；调用方可以覆盖，但要显式给。
  const profile = expectedProfile ?? BROWSER_PROFILES[browserKey] ?? null;

  return async function healthCheck(args = {}) {
    const findings = [];
    const layersRun = [];
    const browserPort = browserPortFor(browserKey);
    const proxyUrl = proxyUrlFor(browserKey);

    // ── L1-① 浏览器与 profile 身份 ──────────────────────────────────────────
    try {
      const inspection = await inspectPortImpl(browserPort, { timeoutMs });
      findings.push(classifyBrowserPort({ inspection, expectedProfile: profile, port: browserPort }));
    } catch (error) {
      // 探针自己出错 = 没拿到结论，不改判成「有问题」（见文件头第 1 条）。
      findings.push({
        layer: HEALTH_LAYERS.ENVIRONMENT,
        code: HEALTH_CODES.CDP_ENDPOINT_UNIDENTIFIED,
        state: HEALTH_STATES.AUTH_UNKNOWN,
        reason: HEALTH_REASONS.BROWSER_DEBUG_PORT,
        detail: `探测端口 ${browserPort} 时出错（${String(error?.message ?? error).slice(0, 120)}），未拿到结论。`,
        blocking: false,
      });
    }
    layersRun.push(`${HEALTH_LAYERS.ENVIRONMENT}:port`);

    // ── L1-② 目标页面恰好一个 ───────────────────────────────────────────────
    if (expectedPages.length > 0) {
      try {
        const targets = await readTargetsImpl(proxyUrl, timeoutMs);
        findings.push(...classifyExpectedPages({ targets, expectedPages, readable: true }));
      } catch {
        findings.push(...classifyExpectedPages({ targets: [], expectedPages, readable: false }));
      }
      layersRun.push(`${HEALTH_LAYERS.ENVIRONMENT}:pages`);
    }

    // ── L1-③ 出网路径 ──────────────────────────────────────────────────────
    let reachable = null;
    if (declared) {
      try {
        reachable = await probeTcpImpl({ host: declared.host, port: declared.port, timeoutMs });
      } catch {
        reachable = null;
      }
    }
    findings.push(classifyEgress({ declaration: declared, reachable }));
    layersRun.push(`${HEALTH_LAYERS.ENVIRONMENT}:egress`);

    const { ok, findings: kept, blocking } = buildHealthResult(findings);
    return {
      version: HEALTH_CONTRACT_VERSION,
      ok,
      findings: kept,
      blocking,
      note: buildNote({ findings: kept, layersRun }),
      layers: Object.fromEntries(Object.entries(LAYER_IMPLEMENTATION).map(([layer, value]) => [
        layer,
        value.implemented ? 'CHECKED' : 'NOT_IMPLEMENTED',
      ])),
      checkedAt: new Date(Number(args.now ?? Date.now())).toISOString(),
    };
  };
}
