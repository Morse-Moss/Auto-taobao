// 浏览器实例的「声明 vs 存活」对账 —— Browser Broker 的最小切片（BR-1 / BR-2）。
//
// 为什么需要它（本文件存在的唯一理由）：
//   到今天为止，「这台机器上现在到底活着几个实例、分别是谁」这个事实**系统自己不知道** ——
//   它一直是靠仓库外的探针（D:/Retire/probe-live/137-resource-budget.mjs 一类）人工盘点出来的。
//   每次换个人上手、每次换台机器，都要重做一遍这件事，而且做错了不会报错（只会记住错的结论）。
//
// 三条设计约束（每一条都能对上一个已经吃过的亏）：
//   1) **不新增第二份真相。** 「应该活着哪些实例」唯一的来源就是 runtime/browser-ports.mjs
//      （PROJECT_PORTS / BROWSER_PROFILES / SHOP_BROWSERS）。本文件不保存任何持久登记表 ——
//      持久化一份「我们起过谁」会立刻变成第二份真相，而且被重启之后它就是陈旧事实（坑 35 的同族）。
//   2) **只读。** 不启动、不导航、不关闭、不终止任何进程。发现对不上时，本文件只输出结论与建议，
//      处置权在人（项目铁律：任何存活进程的起停都要人明确点头，脚本自己打印的建议不构成授权）。
//   3) **不把「探针没读到」当证据。** 端口读不出来只报 `unknown`，不判 foreign、不判 missing。
//      这条与 classifyPortUsage 同源：凭一次网络抖动停线，会把抖动变成事故。
//
// 用法：
//   node runtime/browser-inventory.mjs              # 全部声明实例的现状（只读）
//   node runtime/browser-inventory.mjs --json       # 同样的结论，机器可读
//   node runtime/browser-inventory.mjs --listen     # 追加「谁在监听但登记表里没有」的清单
//   退出码：0＝每个声明实例都各就各位；1＝有缺失/外来/不可判定；2＝用法错误
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BROWSER_IDS,
  BROWSER_LABELS,
  BROWSER_PROFILES,
  FOREIGN_PORTS,
  PROJECT_PORTS,
  SHOP_BROWSERS,
  ROUTES,
  classifyPortUsage,
  describeOccupant,
  inspectPort,
  shopBrowserKeys,
  shopInstance,
} from './browser-ports.mjs';

/** 声明表：本项目认为「应该活着」的全部浏览器实例。唯一来源＝browser-ports.mjs。 */
export function buildDeclarationPlan() {
  const shared = [
    {
      kind: 'competitor',
      key: 'competitor',
      who: '竞品链（买家号 ＋ 小旺神）',
      routes: ROUTES.competitor.label,
      browserPort: PROJECT_PORTS.competitorBrowser,
      proxyPort: PROJECT_PORTS.competitorProxy,
      profile: BROWSER_PROFILES.competitor,
      browserId: BROWSER_IDS.competitor,
      label: BROWSER_LABELS.competitor,
    },
    {
      kind: 'dailyReport',
      key: 'dailyReport',
      who: '商家浏览器（日报/周表/灰豚）',
      routes: ROUTES.dailyReport.label,
      browserPort: PROJECT_PORTS.dailyReportBrowser,
      proxyPort: PROJECT_PORTS.dailyReportProxy,
      profile: BROWSER_PROFILES.dailyReport,
      browserId: BROWSER_IDS.dailyReport,
      label: BROWSER_LABELS.dailyReport,
    },
  ];
  const shops = shopBrowserKeys().map((key) => {
    const entry = shopInstance(key);
    return {
      kind: 'shop',
      key,
      who: key,
      routes: ROUTES.dailyReport.label,
      browserPort: entry.browserPort,
      proxyPort: entry.proxyPort,
      profile: entry.profile,
      browserId: entry.browserId,
      label: entry.label,
    };
  });
  return [...shared, ...shops];
}

/** 登记表声明的全部端口（含运营台）。给「未声明但被监听」那条判据用。 */
export function declaredPorts() {
  return [
    ...Object.values(PROJECT_PORTS),
    ...Object.values(SHOP_BROWSERS).flatMap((entry) => [entry.browserPort, entry.proxyPort]),
  ];
}

/**
 * 解析 `netstat -ano -p tcp` 的输出 → Map<port, pid>（只收 LISTENING 行）。
 *
 * 为什么不用 `-o` 之外的花样：这段解析要在离线测试里被喂样例文本，所以它是纯函数。
 * 实测的两种行形态都要认（Windows 中文/英文环境列宽不同）：
 *   TCP    127.0.0.1:19031    0.0.0.0:0    LISTENING    12345
 *   TCP    [::1]:19031        [::]:0       LISTENING    12345
 */
export function parseListenTable(text) {
  const byPort = new Map();
  if (typeof text !== 'string') return byPort;
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*TCP\s+\S*:(\d{1,5})\s+\S+\s+LISTENING\s+(\d+)\s*$/iu);
    if (!match) continue;
    const port = Number(match[1]);
    const pid = Number(match[2]);
    if (!byPort.has(port)) byPort.set(port, pid);
  }
  return byPort;
}

/**
 * 一个正在被监听的端口，属于谁？
 *   ours-declared  在登记表里（正常）
 *   foreign        别的项目的已知端口（FOREIGN_PORTS，只提示不处置）
 *   undeclared     不在登记表里 —— 可能是别的项目，也可能是我们自己用旧端口起的孤儿
 *
 * 注意用词：`undeclared` 不等于「孤儿」。判成孤儿需要「它用的是我们的 profile」这个正面证据，
 * 而那要逐端口去做 CDP 探测（inspectInstance 那一半）。这里只回答「登记表解释不了它」。
 */
export function classifyListener(port, { declared = declaredPorts(), foreign = Object.values(FOREIGN_PORTS) } = {}) {
  if (foreign.includes(port)) return 'foreign';
  if (declared.includes(port)) return 'ours-declared';
  return 'undeclared';
}

/**
 * 把探测结果折算成一句判决。分桶的判据不是「严重程度」，而是**下一步该做什么**：
 *   ready            浏览器 profile 一致 ＋ 代理在        → 什么都不用做
 *   proxy-missing    浏览器在、代理没起                    → 起代理（不用碰浏览器）
 *   browser-missing  代理在、浏览器没了                    → 起浏览器
 *   missing          两样都没有                            → 起一整套
 *   foreign          端口上是**别人的** profile（有正面证据）→ 先查清是谁的，不许直接抢
 *   unconfirmed      端口在监听但读不出身份                → 人看一眼；**不据此停线**（抖动不是事故）
 * 「读不出来」与「确定不对」必须分开：前者的正确动作是观察，后者才是处置。
 */
export function judgeInstance(entry, probe) {
  if (probe.verdict === 'foreign') return 'foreign';
  if (probe.verdict === 'ours') return probe.proxyReachable ? 'ready' : 'proxy-missing';
  if (probe.status === 'free') return probe.proxyReachable ? 'browser-missing' : 'missing';
  return 'unconfirmed';
}

const PROXY_TIMEOUT_MS = 1500;

/**
 * 「登记表解释不了的监听」里有价值的只有一种：**它是个浏览器**。
 *
 * 为什么必须过滤（2026-09-19 实测）：直接打印未声明监听会吐出 48 条 —— 135/139/445/5357 是
 * Windows 服务、49664+ 是 RPC 动态端口、3306/6379/5432 是数据库 —— 这种清单不会被读，
 * 只会训练人忽略它。所以判据从「在被监听」收紧为「CDP 能读出 Browser 产品名」：
 * 能自证是浏览器的才报，其余一律不报。
 *
 * 注意这不构成「清理建议」：报出来的东西**可能属于另一个项目**（用户本机有别的项目也在用
 * Edge 调试端口）。本命令只报告，处置权在人。
 */
export async function findUndeclaredBrowsers(listenTable, options = {}) {
  const inspect = options.inspect ?? inspectPort;
  const candidates = [...listenTable.entries()].filter(([port]) => classifyListener(port) === 'undeclared');
  const probed = await Promise.all(candidates.map(async ([port, pid]) => {
    const inspection = await inspect(port, { timeoutMs: options.timeoutMs ?? 900 });
    if (inspection.status !== 'occupied') return null;
    return { port, pid, product: inspection.product ?? null, profile: inspection.profile ?? null };
  }));
  return probed.filter(Boolean).sort((a, b) => a.port - b.port);
}

async function probeProxyAlive(port, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROXY_TIMEOUT_MS;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { reachable: false, httpStatus: response.status, health: null };
    const health = await response.json().catch(() => null);
    return { reachable: true, httpStatus: response.status, health };
  } catch {
    return { reachable: false, httpStatus: null, health: null };
  }
}

/** 探测一个声明实例：浏览器端口（CDP）＋ 代理端口（/health）。两件都只读。 */
export async function inspectInstance(entry, options = {}) {
  const inspection = await (options.inspect ?? inspectPort)(entry.browserPort, {
    timeoutMs: options.browserTimeoutMs ?? 1500,
  });
  const usage = classifyPortUsage(inspection, { expectedProfile: entry.profile });
  const proxy = await (options.probeProxy ?? probeProxyAlive)(entry.proxyPort, options);
  const probe = {
    status: inspection.status,
    verdict: usage.verdict,
    actualProfile: usage.profile ?? null,
    occupiedBy: describeOccupant(inspection),
    proxyReachable: proxy.reachable,
    proxyHealth: proxy.health,
  };
  return { ...entry, probe, judgement: judgeInstance(entry, probe) };
}

/** 纯函数：把逐实例的探测结果折成一份可读的账。 */
export function summarize(results) {
  const buckets = {
    ready: [], 'proxy-missing': [], 'browser-missing': [], missing: [], foreign: [], unconfirmed: [],
  };
  for (const item of results) buckets[item.judgement].push(item);
  return {
    buckets,
    counts: Object.fromEntries(Object.entries(buckets).map(([key, list]) => [key, list.length])),
    allReady: results.length > 0 && results.every((item) => item.judgement === 'ready'),
  };
}

function formatLine(item) {
  const mark = {
    ready: 'ok  ', 'proxy-missing': '缺代理', 'browser-missing': '缺浏览器',
    missing: '缺  ', foreign: '外来', unconfirmed: '待确认',
  }[item.judgement];
  const parts = [`${mark} ${item.who}`];
  parts.push(`浏览器:${item.browserPort}=${item.probe.status}${item.probe.verdict === 'ours' ? '(profile 一致)' : `(${item.probe.verdict})`}`);
  parts.push(`代理:${item.proxyPort}=${item.probe.proxyReachable ? '在' : '连不上'}`);
  if (item.judgement === 'foreign') parts.push(`端口上是 ${item.probe.occupiedBy}`);
  return parts.join('  ');
}

// --- 进程表：端口只能告诉我们「pid 在监听」，要停掉一个实例还得认出它的启动器 ----------
//
// 为什么需要这一层（2026-09-19）：停一个店铺实例要动三个进程 —— 代理 node、启动器 node、
// msedge 的一整棵树。端口只能抓到前两个里的代理与浏览器，**启动器 node 不监听任何端口**。
// 它的命令行又是 `node runtime/start-project-browser.mjs`，5 个实例逐字相同（profile 与端口
// 走环境变量，环境变量不在命令行里）⇒ 按命令行认它是不可能的。
// 唯一可靠的抓手是**父子关系**：msedge 主进程是启动器 node 的**子进程**。
// 于是「端口 → pid → 父进程」这条链每一步都有操作系统当场作证，不需要 pidfile。

/**
 * PowerShell 一次问回全部进程（名字 + pid + 父 pid + 命令行）。读不到就如实报读不到。
 *
 * 开头那句 `[Console]::OutputEncoding` 不是装饰（2026-09-19 实测）：
 * PowerShell 在输出被重定向时按**控制台代码页**（本机是 GBK/936）写 stdout，
 * 而这里按 UTF-8 解码 ⇒ 任何**中文参数**都会变成一串 `�`。
 * 实测到的后果：店铺代理的命令行 `node …\start-shop-proxy.mjs 里可林淘宝` 读回来是
 * `… ������è`，于是 stop-all 里「店铺代理还要认得出店名」那条证据**永远为假**——
 * 它不报错，只是安静地少一条证据（stop-all 仍会凭脚本名放行，所以症状是「守卫比设计的弱」）。
 * 强制 stdout 用 UTF-8 之后，中文参数原样可读。
 */
const PROC_QUERY = 'powershell -NoProfile -Command "'
  + '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
  + 'Get-CimInstance Win32_Process '
  + '| Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"';

/** ConvertTo-Json 单条结果是对象而不是数组 —— 这个坑不处理会在「只有 1 个进程」时静默返回空。 */
export function parseProcessTable(payload) {
  const list = Array.isArray(payload) ? payload : payload ? [payload] : [];
  return list
    // pid 必须是个正整数。为什么不用 `Number.isFinite(Number(...))`：`Number(null)` 是 0，
    // 于是 `{ProcessId: null}` 这种坏行会被留下，而 pid 0 在 Windows 上表示「系统空闲进程」——
    // 停进程的脚本拿着它去动手，等于把「读不出来」当成了「就是它」。
    .filter((row) => row && Number.isInteger(Number(row.ProcessId)) && Number(row.ProcessId) > 0)
    .map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId) || 0,
      name: String(row.Name ?? '').toLowerCase(),
      cmd: String(row.CommandLine ?? '').replace(/\s+/gu, ' ').trim(),
    }))
    .sort((a, b) => a.pid - b.pid);
}

/**
 * 读本机进程表。**失败只报失败**：不能返回空表 —— 空表与「一个进程都没有」不可区分，
 * 而后者会让停止脚本得出「什么都没在跑」这个假结论。所以错误必须带出去。
 */
export async function readProcessTable(options = {}) {
  const { execSync } = await import('node:child_process');
  try {
    const raw = (options.execSync ?? execSync)(PROC_QUERY, { maxBuffer: 64 * 1024 * 1024 })
      .toString('utf8').trim();
    return { rows: parseProcessTable(raw ? JSON.parse(raw) : []), error: null };
  } catch (error) {
    return { rows: [], error: error.message.split('\n')[0] };
  }
}

/**
 * 沿父链找某个进程（默认找 node.exe）。上限是防御：进程表里理论上不该有环，
 * 但真出现环时，这里宁可返回 null 也不要挂死在一个杀死进程的脚本里。
 */
export function findAncestorByPid(rows, pid, { name = 'node.exe', maxDepth = 6 } = {}) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  let cursor = byPid.get(pid)?.ppid ?? 0;
  for (let depth = 0; depth < maxDepth && cursor > 0; depth += 1) {
    const row = byPid.get(cursor);
    if (!row) return null;
    if (row.name === name) return row;
    cursor = row.ppid;
  }
  return null;
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const withListen = argv.includes('--listen');
  const unknownArg = argv.find((value) => value.startsWith('--') && !['--json', '--listen'].includes(value));
  if (unknownArg) {
    console.error(`未知参数 ${unknownArg}；可用：--json --listen`);
    process.exit(2);
  }

  const plan = buildDeclarationPlan();
  const results = [];
  for (const entry of plan) results.push(await inspectInstance(entry));
  const account = summarize(results);

  const report = {
    at: new Date().toISOString(),
    declared: plan.length,
    counts: account.counts,
    allReady: account.allReady,
    instances: results.map((item) => ({
      who: item.who, kind: item.kind, key: item.key,
      browserPort: item.browserPort, proxyPort: item.proxyPort,
      judgement: item.judgement, ...item.probe,
    })),
  };

  if (withListen) {
    const { execSync } = await import('node:child_process');
    let listen = new Map();
    try {
      listen = parseListenTable(execSync('netstat -ano -p tcp', { maxBuffer: 32 * 1024 * 1024 }).toString('latin1'));
    } catch (error) {
      report.listenScanError = error.message;
    }
    // 只保留「能自证是浏览器」的那些（见 findUndeclaredBrowsers 的说明）。
    report.undeclaredBrowsers = await findUndeclaredBrowsers(listen);
    report.undeclaredListenerCount = [...listen.keys()].filter((port) => classifyListener(port) === 'undeclared').length;
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 1));
  } else {
    console.log(`[实例对账] 声明 ${plan.length} 个实例（来源：runtime/browser-ports.mjs）`);
    for (const item of results) console.log(`  ${formatLine(item)}`);
    const { ready, missing, foreign, unconfirmed } = account.buckets;
    const proxyMissing = account.buckets['proxy-missing'];
    const browserMissing = account.buckets['browser-missing'];
    if (browserMissing.length) console.log(`  [缺浏览器] ${browserMissing.map((i) => i.who).join('、')} —— 代理在，浏览器没了`);
    if (proxyMissing.length) console.log(`  [缺代理] ${proxyMissing.map((i) => i.who).join('、')} —— 浏览器在，代理没起（这一档不用碰浏览器）`);
    if (missing.length) console.log(`  [整套缺] ${missing.map((i) => i.who).join('、')} —— 浏览器与代理都没起来`);
    if (foreign.length) console.log(`  [外来] ${foreign.map((i) => i.who).join('、')} —— 端口被别的 profile 占着，先查清再说`);
    if (unconfirmed.length) console.log(`  [待确认] ${unconfirmed.map((i) => i.who).join('、')} —— 端口在监听但读不出身份，人看一眼；不据此停线`);
    if (report.undeclaredBrowsers?.length) {
      console.log(`  [登记表解释不了的浏览器] ${report.undeclaredBrowsers
        .map((i) => `${i.port}(pid ${i.pid}${i.product ? ` ${i.product}` : ''})`).join('、')}`);
      console.log('     —— 能自证是浏览器的才列在这里；它可能属于别的项目。本命令不处置，处置权在人');
    } else if (report.undeclaredBrowsers) {
      console.log(`  [登记表解释不了的浏览器] 无（另有 ${report.undeclaredListenerCount} 个非浏览器监听未列出）`);
    }
    console.log(`[判据] ${account.allReady ? `全部 ${ready.length} 个实例就位` : '有未就位项（见上）'}`
      + (unconfirmed.length ? '；其中「读不出来」不构成停线理由' : ''));
  }

  // 退出码只由「确定性的不对」决定：缺件与外来停线，读不出来不停线（与 classifyPortUsage 同一原则）。
  const hardFail = account.buckets.missing.length + account.buckets.foreign.length
    + account.buckets['proxy-missing'].length + account.buckets['browser-missing'].length;
  process.exit(hardFail > 0 ? 1 : 0);
}
