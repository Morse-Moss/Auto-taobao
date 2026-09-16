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

// ---------------------------------------------------------------------------
// 三条业务路线（关键词 / 竞品 / 日报）× 两个浏览器的归属，2026-09-16 定。
// ---------------------------------------------------------------------------
// 分线的判据不是「哪个 skill 顺手」，而是**站点要哪种账号**：
//   淘宝（买家视角、配小旺神插件）        → 买家浏览器 competitor
//   生意参谋 / 千牛 / 阿里妈妈（商家后台） → 商家浏览器 dailyReport
//
// 一个浏览器 profile 只能是一个淘宝身份。把商家号登进买家浏览器，小旺神采集会
// **静默退化**：页面能打开、导出能成功，但商品详情页看不到别家数据、小旺神面板读不出
// 市场数据（错误发生在数据层，而不是点击层）。反过来把买家号登进商家浏览器，
// 生意参谋直接停在登录墙。
// 用户原话：「卖家版的账号是用不了小旺神的，主要是规避这个风险」。
//
// 第三方平台（灰豚、飞书）用的是它自己的账号，与淘宝身份无关，
// 所以跟哪个浏览器同住都不冲突 —— 不冲突的前提是它**不受**淘宝登录态影响。
export const ACCOUNT_KINDS = Object.freeze({
  buyer: 'buyer',
  merchant: 'merchant',
  independent: 'independent',
});

// 站点 → 它要求的账号类型。写全是为了 fail-closed：
// 路线表里出现未登记的站点时单测直接失败，而不是「没人说得清这个站属于哪一边」。
export const SITE_ACCOUNT = Object.freeze({
  's.taobao.com': ACCOUNT_KINDS.buyer,
  'item.taobao.com': ACCOUNT_KINDS.buyer,
  'detail.tmall.com': ACCOUNT_KINDS.buyer,
  'sycm.taobao.com': ACCOUNT_KINDS.merchant,
  'one.alimama.com': ACCOUNT_KINDS.merchant,
  'myseller.taobao.com': ACCOUNT_KINDS.merchant,
  'qianniu.taobao.com': ACCOUNT_KINDS.merchant,
  'xhs.huitun.com': ACCOUNT_KINDS.independent,
  'dy.huitun.com': ACCOUNT_KINDS.independent,
  'feishu.cn': ACCOUNT_KINDS.independent,
});

// 每个浏览器承载的淘宝身份。这是「不能合并」的根因所在。
export const BROWSER_ACCOUNT = Object.freeze({
  competitor: ACCOUNT_KINDS.buyer,
  dailyReport: ACCOUNT_KINDS.merchant,
});

// 路线表。`browser: null` ＝ 这条链不需要浏览器（纯 API），或归属尚未定（那时必须带
// `browserPending: true` + `pendingReason`，把「待决」本身变成一个可被测试盯住的事实，
// 而不是一句口口相传的待办）。
export const ROUTES = Object.freeze({
  competitor: Object.freeze({
    label: '竞品（小旺神市场分析 / SKU / FAQ / 词库采集）',
    browser: 'competitor',
    account: ACCOUNT_KINDS.buyer,
    sites: Object.freeze(['s.taobao.com', 'item.taobao.com', 'detail.tmall.com']),
    needsExtension: '小旺神',
    skills: Object.freeze([
      'xws-export-market-analysis',
      'xws-sku-collection',
      'xws-faq-operator',
      'xws-faq-raw-collection',
      'xws-question-library-collection',
    ]),
  }),
  competitorImport: Object.freeze({
    label: '竞品入库（小旺神导出 → 飞书 API）',
    browser: null,
    noBrowser: true,
    noBrowserReason: '上传走飞书开放接口，不开浏览器、不读登录态；照片附件也走接口。',
    account: ACCOUNT_KINDS.independent,
    sites: Object.freeze(['feishu.cn']),
    needsExtension: null,
    skills: Object.freeze(['xws-to-feishu-base']),
  }),
  keywordRank: Object.freeze({
    label: '关键词·搜索排行（生意参谋）',
    browser: 'dailyReport',
    account: ACCOUNT_KINDS.merchant,
    sites: Object.freeze(['sycm.taobao.com']),
    needsExtension: null,
    skills: Object.freeze(['sycm-export-search-rank']),
  }),
  keywordHeat: Object.freeze({
    label: '关键词·灰豚话题热度（小红书）',
    browser: null,
    account: ACCOUNT_KINDS.independent,
    sites: Object.freeze(['xhs.huitun.com', 'dy.huitun.com']),
    needsExtension: null,
    skills: Object.freeze(['huitun-to-feishu-keyword-heat']),
    browserPending: true,
    pendingReason: '灰豚是第三方平台，两边都不冲突；现状走别的项目的共享代理 3456，归属待用户拍板（见 docs/ops/PROJECT-BROWSER-AND-PORTS.md §1.4）。',
  }),
  dailyReport: Object.freeze({
    label: '日报（生意参谋 + 万相台/阿里妈妈 + 飞书）',
    browser: 'dailyReport',
    account: ACCOUNT_KINDS.merchant,
    sites: Object.freeze(['sycm.taobao.com', 'one.alimama.com', 'feishu.cn']),
    needsExtension: null,
    skills: Object.freeze(['sycm-alimama-daily-report']),
  }),
  weeklyPaste: Object.freeze({
    label: '周表粘贴（周表 → 飞书网页）',
    browser: 'dailyReport',
    // 飞书用的是它自己的账号，与淘宝身份无关 —— 放乙是**决定而非必然**（乙是运营侧那个浏览器，
    // 飞书登录态跟着它走），所以这里如实写 independent，不写成 merchant 冒充必然性。
    account: ACCOUNT_KINDS.independent,
    sites: Object.freeze(['feishu.cn']),
    needsExtension: null,
    skills: Object.freeze(['sycm-to-feishu-base']),
  }),
  sellerWorkbench: Object.freeze({
    label: '千牛 / 卖家工作台（预留：仓库内暂无调用方）',
    browser: 'dailyReport',
    account: ACCOUNT_KINDS.merchant,
    sites: Object.freeze(['myseller.taobao.com', 'qianniu.taobao.com']),
    needsExtension: null,
    skills: Object.freeze([]),
  }),
});

export function routesOnBrowser(browserKey) {
  return Object.entries(ROUTES)
    .filter(([, route]) => route.browser === browserKey)
    .map(([name]) => name);
}

// 给启动器念的一句话：这个端口承载哪几条路线、必须登哪种账号。
export function describeBrowserRoutes(browserKey) {
  const names = routesOnBrowser(browserKey);
  const kinds = new Set(names.map((name) => ROUTES[name].account));
  const ext = names.map((name) => ROUTES[name].needsExtension).filter(Boolean);
  const parts = [`账号=${[...kinds].join('/') || '(无路线)'}`];
  if (ext.length > 0) parts.push(`插件=${[...new Set(ext)].join('/')}`);
  parts.push(`路线=${names.join(', ') || '(无)'}`);
  return parts.join(' ');
}

// 别的项目的端口 —— 记下来是为了**避开**，不是为了兜底。
// 3456 是别的项目的共享 CDP 代理，挂在用户的日常 Edge 上：那里登的是商家账号，
// 而且**没装小旺神**（见 docs/ops/PROJECT-BROWSER-AND-PORTS.md §3）。
export const FOREIGN_PORTS = Object.freeze({
  sharedProxy: 3456,
});

// 已知欠债：仍然把**代理默认值**指向 FOREIGN_PORTS.sharedProxy 的文件。
// 判据是「出现了 http://<host>:3456 这样的 URL 字面量」—— 注释里提到这个端口不算，
// 文档里写清「不要碰它」更不算（那种提到是好事，不该被守卫逼着删掉）。
//
// 为什么这算债：这些文件能跑，只是因为**恰好**别的项目的代理在跑、且那个浏览器里
// 恰好是我们要的账号。失败不会发生在自己代码里，而会在别人关掉代理的那一刻到来
// （坑 35 默认值即目标 ＋ 坑 38 能力删在生产者、故障显在消费者）。
//
// 清单必须与现实逐字一致（双向）：修好一处就删一行，新写一处测试会失败。
// 分两桶只是为了读懂「债在哪一类代码里」：
//   A 生产链路（skills/）—— 跑一次真实业务就会走到的地方。
//   B runtime/ 人工维护探针 —— 改飞书表结构、排查页面时手工敲的脚本。
// 两组指向同一件事：**飞书网页登录态现在挂在用户日常 Edge（3456）上**，
// 而不是本项目的商家浏览器（19023）—— 这是 §1.4 待决项的根因。
export const FOREIGN_PROXY_DEFAULT_FILES = Object.freeze([
  // --- A 生产链路 -----------------------------------------------------------
  'skills/huitun-to-feishu-keyword-heat/SKILL.md',
  'skills/huitun-to-feishu-keyword-heat/scripts/flow.mjs',
  'skills/huitun-to-feishu-keyword-heat/scripts/run-huitun-topic-heat.mjs',
  'skills/sycm-export-search-rank/scripts/export-search-rank.mjs',
  'skills/sycm-to-feishu-base/scripts/adapter.feishu-weekly.mjs',
  'skills/sycm-to-feishu-base/scripts/copy-weekly-table.mjs',
  'skills/sycm-to-feishu-base/scripts/inspect-feishu-fields.mjs',
  'skills/sycm-to-feishu-base/scripts/run-weekly-pre-ai.mjs',
  'skills/xws-export-market-analysis/scripts/export-market-analysis.mjs',
  'skills/xws-export-market-analysis/scripts/flow.mjs',
  'skills/xws-export-market-analysis/scripts/segments.mjs',
  // --- B runtime/ 人工维护探针 ----------------------------------------------
  'runtime/eval-feishu-expression.mjs',
  'runtime/feishu-ui-add-fields.mjs',
  'runtime/feishu-ui-eval-once.mjs',
  'runtime/feishu-ui-field-menu.mjs',
  'runtime/feishu-ui-find-text.mjs',
  'runtime/feishu-ui-menu-action.mjs',
  'runtime/feishu-ui-open-add.mjs',
  'runtime/feishu-ui-preflight.mjs',
  'runtime/feishu-ui-probe.mjs',
  'runtime/get-feishu-state.mjs',
  'runtime/inspect-ai-editor.mjs',
  'runtime/inspect-feishu-field-config-ui.mjs',
  'runtime/inspect-field-containers.mjs',
  'runtime/inspect-popovers.mjs',
  'runtime/inspect-visible-text.mjs',
  'runtime/paste-history-import.mjs',
  'runtime/repair-history-types-v2.mjs',
  'runtime/repair-history-types.mjs',
  'runtime/set-history-types.mjs',
  'runtime/tmp-inspect-feishu-ui.mjs',
]);

// 判据与清单一起导出，免得测试再抄一份（两份判据迟早会漂）。
export const FOREIGN_PROXY_URL_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost):3456/;

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
