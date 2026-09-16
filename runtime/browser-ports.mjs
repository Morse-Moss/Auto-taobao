// 项目专用端口与浏览器身份的登记表（唯一来源，2026-09-16 建立）。
//
// 为什么需要它：端口原先散落在 starter、CDP 代理、skill 脚本默认值、文档和测试里，
// 各写一份就会漂移，最后表现为「脚本看起来成功、其实连到了另一个浏览器」
// —— 本项目坑 35（默认值即目标）。2026-09-16 实测到两处实例：
//   1) `runtime/isolated-proxy/browser-discovery.mjs` 的默认浏览器端口是 9223，
//      而 9223 是**日报用的商家浏览器**；裸跑 cdp-proxy 会把自己标成 `edge-isolated`
//      却挂在商家号上（两个账号连的是不同的人）。
//   2) 日报侧原来用 9223 / 3458：9222/9223 是 Chrome/Edge 远程调试的常见取值，
//      3456/3457/3458 是本机其他项目也在用的一段 —— 撞号后表现为
//      「点击/导航都成功，但操作的是别人的浏览器」。
//
// 选端口的原则：不用「常见默认值 ＋ 1」这种会被别的项目顺手占掉的数。
//   - 竞品链保留 9222 / 3457：历史收据（evidence/ 与 runtime/ 下的 manifest）
//     里记着这两个值，改名会让旧证据对不上（坑 37），收益不抵风险。
//   - 日报链改用 19022 / 19023：与本机其他项目（3456、3458、19000、19001）不重叠。
//
// 账号前提 —— 客户交付必须交代（详见 docs/ops/PROJECT-BROWSER-AND-PORTS.md §1）：
//   生意参谋 / 阿里妈妈 / 飞书 = **商家账号**；小旺神插件 = **只有买家账号能用**。
//   同一个浏览器 profile 不可能同时是商家与买家 ⇒ 两条链必须各自独立实例、
//   独立调试端口、独立代理端口，「省一个浏览器」在这里是行不通的。

export const PROJECT_PORTS = Object.freeze({
  // 竞品链：项目专用调试 Edge（买家号 ＋ 小旺神）
  competitorBrowser: 9222,
  competitorProxy: 3457,
  // 日报链：商家号（生意参谋 / 阿里妈妈 / 飞书）
  dailyReportBrowser: 19022,
  dailyReportProxy: 19023,
});

export const BROWSER_IDS = Object.freeze({
  competitor: 'edge-isolated',
  dailyReport: 'edge-daily-report',
});

// /health 里回报的 label。导出侧拿 XWS_BROWSER_ID 跟 /health 的 browser.id 比对，
// 这里对不上就硬失败，所以两份必须同源。
export const BROWSER_LABELS = Object.freeze({
  competitor: 'Microsoft Edge (isolated)',
  dailyReport: 'Microsoft Edge (daily report)',
});

export const BROWSER_PROFILES = Object.freeze({
  competitor: 'D:/Retire/edge-debug-profile',
  dailyReport: 'D:/Retire/edge-daily-report-profile',
});

// 显式传了环境变量就用显式的，否则回落到登记表；非法值直接抛错而不是静默取默认
// （「静默回落」正是坑 35 的成因）。
export function resolvePort(envName, fallback) {
  const raw = process.env[envName];
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${envName} 必须是 1-65535 的整数端口，收到 ${JSON.stringify(raw)}`);
  }
  return value;
}

export function normalizeProfile(value) {
  if (typeof value !== 'string') return null;
  // 先 trim 再剥尾斜杠：`"D:\a\b" `（尾部带空格）与 `D:/a/b/` 必须归一到同一个字符串，
  // 否则同一个 profile 会因为写法不同被判成「别人的浏览器」而拒绝启动。
  const stripped = value.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  return stripped.length > 0 ? stripped.toLowerCase() : null;
}

// 从 CDP `SystemInfo.getInfo` 的 commandLine 里取 --user-data-dir。
// 这是**唯一**能证明「这个端口上的浏览器是不是我们的那个 profile」的证据源：
// /json/version 只给 Browser / User-Agent，给不出 profile。
export function extractProfileFromCommandLine(commandLine) {
  if (typeof commandLine !== 'string') return null;
  const match = commandLine.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/);
  const raw = match?.[1] ?? match?.[2] ?? null;
  return raw === null ? null : raw.trim().replaceAll('\\', '/').replace(/\/+$/, '');
}

async function isPortListening(port, timeoutMs) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function readCommandLineViaCdp(wsUrl, timeoutMs) {
  if (typeof WebSocket === 'undefined' || !wsUrl) return null;
  return new Promise((resolve) => {
    let socket = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* 已经关了 */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      finish(null);
      return;
    }
    socket.addEventListener('error', () => finish(null));
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'SystemInfo.getInfo' }));
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (message?.id !== 1) return;
      finish(typeof message.result?.commandLine === 'string' ? message.result.commandLine : null);
    });
  });
}

// 端口上现在到底是什么？
//   free                   端口没在监听
//   occupied               有 CDP 端点，可读出 Browser / profile
//   occupied-unidentified  端口在监听但 /json/version 读不出来（不是浏览器，或还没就绪）
export async function inspectPort(port, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  const version = await (async () => {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  })();
  if (!version) {
    const listening = await (options.listeningProbe ?? isPortListening)(port, timeoutMs);
    return { status: listening ? 'occupied-unidentified' : 'free' };
  }
  const wsUrl = version.webSocketDebuggerUrl ?? null;
  const commandLine = wsUrl
    ? await (options.commandLineReader ?? readCommandLineViaCdp)(wsUrl, timeoutMs)
    : null;
  return {
    status: 'occupied',
    product: version.Browser ?? null,
    userAgent: version['User-Agent'] ?? null,
    webSocketDebuggerUrl: wsUrl,
    commandLine,
    profile: extractProfileFromCommandLine(commandLine),
  };
}

// 只对「有正面证据」的冲突下判决：读出了 --user-data-dir 且与期望不一致才判 foreign。
// 读不出来（unknown）只警告不拦 —— 凭「探针没读到」停线，会让一次网络抖动变成一次事故。
export function classifyPortUsage(inspection, { expectedProfile } = {}) {
  if (inspection.status === 'free') return { verdict: 'free' };
  const expected = normalizeProfile(expectedProfile);
  const actual = normalizeProfile(inspection.profile);
  if (actual !== null && expected !== null) {
    return actual === expected
      ? { verdict: 'ours', profile: inspection.profile }
      : { verdict: 'foreign', profile: inspection.profile };
  }
  return { verdict: 'unknown', profile: inspection.profile ?? null, status: inspection.status };
}

// 给启动器用的一句话交代（谁占了我的端口、该怎么处理）。
export function describeOccupant(inspection) {
  const parts = [`product=${inspection.product ?? '(未识别)'}`];
  parts.push(`profile=${inspection.profile ?? '(未识别)'}`);
  if (inspection.status === 'occupied-unidentified') parts.push('（端口在监听，但不是可读的 CDP 端点）');
  return parts.join(' ');
}
