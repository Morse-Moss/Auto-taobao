import { readFileSync } from 'node:fs';

export const INQUIRY_HEADERS = Object.freeze(['商品名称','商品编号','咨询人数','询单人数','当日询单人数','询单转化率','当日询单转化率','当日付款人数','当日付款金额','延最终付款人数','延最终付款金额','延最终付款件数']);
const TARGET = Object.freeze({ 商品名称:'名称', 商品编号:'商品ID', 延最终付款人数:'最终付款人数', 延最终付款金额:'最终付款金额', 延最终付款件数:'最终付款件数' });
const NUMERIC = new Set(['咨询人数','当日询单人数','当日付款人数','当日付款金额']);

// 飞书日期字段一律用「北京时间零点」。理由（2026-09-28 实测）：
// 「商品数据看板」里带日期条件的查找引用要求两个日期字段的**时间戳精确相等**，而看板是人工维护的
// （全仓无代码写它）、两张底单 2026-09-01~09-19 的历史数据也都是北京时间零点。
// 原先写 `Date.UTC(y, m-1, d)`（世界时零点）比看板早 8 小时 ⇒ 看板上 09-23 起整天引用不到值。
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

/** 北京时区某天的零点，返回飞书日期字段要的毫秒数。入参 month 为 1~12。 */
const toBeijingMidnight = (year, month, day) => Date.UTC(year, month - 1, day) - BEIJING_OFFSET_MS;

/** 把飞书返回的日期时间戳读成 `YYYY-MM-DD`。加 8 小时对「北京零点」与「世界时零点」两种存法都读得对。 */
const readBeijingDay = (value) => new Date(Number(value) + BEIJING_OFFSET_MS).toISOString().slice(0, 10);

// 同一列在导出侧出现过两种写法。**必须都认**，理由是实测出来的（2026-09-27）：
//   · 仓库里 2026-09-23 存档的原始导出 `evidence/product-inquiry-2026-09-23/gaiwen-*.xls`
//     （契约就是照着它写的）真实列名是 `最终付款人数/最终付款金额/最终付款件数`，**没有「延」**；
//   · 2026-09-26 新采的五份导出，列名同样是这三个无「延」写法。
// 那么契约里的「延」从哪来？它是那一次「跑通」时的产物：当时走 xlrd 读、中文 BIFF 标签变成乱码，
// 匹配命中的是下面 ③ 那个「第 6 个使用行 + 12 列形状」的兜底（形状对得上，真列名根本没被读出来）。
// 于是这条链一直「能跑」，直到 2026-09-26 的机器上 COM（pywin32）可用、中文被正确解出来 ⇒
// 逐字匹配与乱码兜底同时失效 ⇒ 五家店询单全灭（报「缺少 12 列标准表头」）。
// 注意：别名只影响**识别**；写回飞书的列序与目标字段仍由 INQUIRY_HEADERS / TARGET 决定，不受影响。
const HEADER_ALIASES = Object.freeze({
  延最终付款人数: ['延最终付款人数', '最终付款人数'],
  延最终付款金额: ['延最终付款金额', '最终付款金额'],
  延最终付款件数: ['延最终付款件数', '最终付款件数'],
});

/** 某一行是不是契约表头（逐列接受该列的任一别名写法）。导出侧换个写法不该让整条链停摆。 */
export function headerMatches(row) {
  return INQUIRY_HEADERS.every((name, index) => (HEADER_ALIASES[name] ?? [name]).includes(String(row[index] ?? '').trim()));
}

export function parseInquiryRows(rows, date, sourceShop) {
  const headerIndex = rows.findIndex(headerMatches);
  // 乱码兜底：xlrd 路径下中文 BIFF 标签会变成 `���…`，那时只能靠形状认。
  const fallback = headerIndex >= 0 ? headerIndex : rows.findIndex((r, i) => i >= 4 && r.length >= INQUIRY_HEADERS.length && String(r[1] ?? '').includes('���'));
  // 失败时把**实际看到的表头**带出去：上一版只报「缺少 12 列标准表头」，
  // 于是「到底是列名变了、还是采到了另一张表」只能靠人重新解一遍文件才知道（2026-09-27 就是这么被卡住的）。
  if (fallback < 0) {
    const seen = rows.find((r) => String(r[0] ?? '').trim() === '商品名称' && r.length >= 6) ?? [];
    throw new Error(`询单报表缺少 12 列标准表头：实际表头=${JSON.stringify(seen.map((value) => String(value)))}`);
  }
  const data = rows.slice(fallback + 1).filter((r) => r.length >= INQUIRY_HEADERS.length
    && r[1] && !['平均值','汇总值'].includes(String(r[0]).trim()) && String(r[1]).trim() !== '-');
  return data.map((row) => ({ header: INQUIRY_HEADERS, row: [date, ...row], sourceShop }));
}

export function buildInquiryFields(entry) {
  const [, ...row] = entry.row;
  const [year, month, day] = String(entry.row[0]).split('-').map(Number);
  const fields = { 数据日期: toBeijingMidnight(year, month, day) };
  INQUIRY_HEADERS.forEach((name, i) => {
    const target = TARGET[name] ?? name; const value = String(row[i] ?? '').trim();
    if (name === '商品名称' || name === '商品编号' || !NUMERIC.has(name)) fields[target] = value;
    else if (value !== '') fields[target] = Number(value.replaceAll(',', ''));
  });
  return fields;
}

export function inquiryKey(date, id) { return `${date}|${String(id)}`; }

export function planInquiryImport({ rows, existing = [] }) {
  const existingKeys = new Set(existing.map((r) => inquiryKey(readBeijingDay(r.fields?.['数据日期']), r.fields?.['商品ID'] ?? '')));
  const seen = new Set(); const records = []; const manifest = [];
  for (const entry of rows) {
    const key = inquiryKey(entry.row[0], entry.row[2]);
    if (existingKeys.has(key) || seen.has(key)) continue;
    seen.add(key); const fields = buildInquiryFields(entry);
    const prior = existing.find((r) => String(r.fields?.['商品ID'] ?? '') === String(entry.row[2]));
    if (prior?.fields?.名称 && String(fields.名称).includes('�')) fields.名称 = prior.fields.名称;
    records.push(fields); manifest.push({ date: entry.row[0], productId: String(entry.row[2]), shop: entry.sourceShop });
  }
  return { records, manifest };
}

export function readInquiryRows(file, date, sourceShop, readXls) { return parseInquiryRows(readXls(file), date, sourceShop); }

// ---------------------------------------------------------------------------
// 「商品分析 → 商品咨询分析」两级入口的**轮询决策**（采集脚本 collect-inquiry-report.mjs 用）
// ---------------------------------------------------------------------------
// 这两级入口是 SPA 渲染出来的：页面刚导航完时，父菜单和子入口**都读不到**。
// 2026-10-09 网林天猫真机复现（同批另 4 家成；该店 10-05/10-06/10-07 三轮也都成 ⇒ 间歇、非永久）；
// 事后只读复读：`readyState=complete` 时父菜单命中 1 个、子入口 0 个；点一下父菜单后子入口立刻出现。
// 原版的病根是「进轮询前只点一次父菜单」——点空一次（元素还没渲染出来）就再也没有第二次机会，
// 于是必然轮询到超时。所以决策必须是**三态且每一轮重判**：
//   done        子入口已出现 ⇒ 结束轮询；
//   click-parent 父菜单在、子入口不在 ⇒ **重新**点父菜单（幂等；这一步就是原版缺的那一下）；
//   wait        父菜单也还没渲染出来 ⇒ 只等，不许盲点（点了也不会有反应，还会掩盖真错）。
export function planEntryPollStep({ hasInquiry, hasParent, pageMarker, downloadBtn } = {}) {
  // 2026-10-23：`hasInquiry`（左侧「商品咨询分析」这行文案）在**父菜单展开后**就成了 true，
  // 而报表还没加载 ⇒ 原来据此 return 'done' 会让循环在报表打开之前收工（下载按钮 0 个）。
  // 所以「到没到报表」只看结构特征（询单人数 / 导出按钮），文案只回答「子项能不能点」。
  const onReport = pageMarker === true || Number(downloadBtn ?? 0) > 0;
  if (onReport) return 'done';
  if (hasInquiry) return 'click-entry';
  if (hasParent) return 'click-parent';
  return 'wait';
}

// ---------------------------------------------------------------------------
// 「已进入商品咨询分析页」的判据（2026-10-22 加）
// ---------------------------------------------------------------------------
// 病根：原判据是 `body.innerText.includes('商品咨询分析')`。那是**左侧 Tab 的文字**，
// 但它不是稳定的页面特征 —— 2026-10-22 里可林天猫现场（`inquiry.xls.failure.png`）证明：
// 页面**已经进了「商品咨询分析」标签、数据也渲染出来了**（统计时间 2026-10-21、
// 「商品咨询分析/商品推荐分析/商品销售分析」三个 Tab 都在、下载按钮在、商品表格 4+ 行），
// 可整页 innerText 里**一次「商品咨询分析」都搜不到** ⇒ 判据自己判负，轮询空转到 30s。
// 也就是说：那条判据测的不是「我在不在询单页」，而是「某个 Tab 的文案今天在不在」，
// 平台一改文案/改成图标 + tooltip，判据就静默失效 —— 而失败文案仍然是
// 「找不到商品咨询分析入口」，把人指到「入口没渲染」上去（我上一轮就是这么误判的）。
//
// 现在只认**报表本身的结构特征**，三选一即可（任一出现即认定已在询单页）：
//   · `统计时间 <日期>`  —— 询单报表页头，与后面 `READ_PAGE_STATE` 的日期解析同一套正则；
//   · `询单人数`           —— 询单报表专属列名（商品底单/推广报表都没有这一列）；
//   · `商品咨询分析`       —— 保留原来的文案判据，它没有错，只是**不够**。
// Tab 文案与父菜单 `商品分析` 只用于「要不要再点一下父菜单」（`planEntryPollStep`），
// 不再用于判定「到没到页」。两条判据分工不同，别再把它们合并回一条。
// 2026-10-23 再修：词表原来含 `统计时间`，而**每个生意参谋业绩页都有「统计时间」**
// ⇒ 总览页就被判成「已在询单页」，轮询立刻收工、从不点「商品分析」，
// 于是 `a.lowcode-service-download-btn` 根本不在页面上、导出链接恒为空：
// 8/8 家全部报「页面状态不满足：{"hasInquiry":true,"date":"...","link":""}」。
// 真机只读探针（网林淘宝，2026-10-23）：
//   业绩总览页：统计时间=true、询单人数=false、下载按钮 0 个；
//   点一下「商品分析」后：询单人数=true、下载按钮 1 个、表格 18 行。
// ⇒ `询单人数` 与「下载按钮在场」才是询单报表独有的结构特征；`统计时间` 只用来读日期。
const PAGE_TITLE_PATTERN = /统计时间\s*(\d{4}-\d{2}-\d{2})/u;
export const INQUIRY_PAGE_MARKERS = Object.freeze(['询单人数']);

/** 读字符串里是否出现某个 marker（纯函数，供 node 侧与页面侧共用同一份词表）。 */
export function hasInquiryPageMarker(text) {
  const body = String(text ?? '');
  return INQUIRY_PAGE_MARKERS.some((marker) => body.includes(marker)) || body.includes('商品咨询分析');
}

/**
 * 把一次页面读数判成「在不在询单页」。
 *
 * 入参就是采集脚本里 `READ_ENTRY_STATE` 的返回（`hasInquiry` / `pageMarker` / `statDate` / `downloadBtn`）。
 * `pageMarker` 是页面侧用 `hasInquiryPageMarker` 算好的布尔值 —— 页面侧拿不到这个函数，
 * 所以两边**共用同一份词表**（`INQUIRY_PAGE_MARKERS`）而共用不了函数体，改词表只改一处。
 *
 * ⚠️ `statDate`（统计时间）**不参与**这条判定：它在业绩总览页上也有，
 * 拿它当「已在询单页」的证据会让轮询在总览页就收工（2026-10-23 实测 8/8 家）。
 */
export function isInquiryPage({ pageMarker, downloadBtn } = {}) {
  // 2026-10-23 再收：`hasInquiry`（左侧「商品咨询分析」文案）**不能**算「已在页」——
  // 父菜单一展开，这行文案就在了，而报表还没加载、导出按钮 0 个 ⇒ 8/8 家读到 link="".
  // 只承认两件报表级事实：专属列名「询单人数」、导出按钮在场。
  if (pageMarker === true) return true;
  return Number(downloadBtn ?? 0) > 0;
}

/**
 * 把导出接口 URL 的日期对齐到目标日（2026-10-23 加）。
 *
 * 平台把导出地址从 React props 挪进了 `cacheParse`，那里带着**当时页面那一天**的
 * `startDate/endDate`（形如 `20261022`）。补跑别的日期时不能照抄 —— 那样会导出一份
 * 日期不对的文件，而导入端的去重键是（统计日期+商品ID），写进去就成了错日数据。
 * 没有这两个参数就原样返回（不猜）。
 */
export function alignExportUrlDate(url, date) {
  const raw = String(url ?? '');
  const iso = String(date ?? '').trim();
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/u.test(iso)) return raw;
  const compact = iso.replaceAll('-', '');
  const absolute = /^https?:\/\//iu.test(raw);
  let parsed;
  try { parsed = new URL(raw, 'https://sycm.taobao.com'); } catch { return raw; }
  let touched = false;
  for (const key of ['startDate', 'endDate']) {
    if (parsed.searchParams.has(key)) { parsed.searchParams.set(key, compact); touched = true; }
  }
  if (!touched) return raw;
  return absolute ? `${parsed.origin}${parsed.pathname}${parsed.search}` : `${parsed.pathname}${parsed.search}`;
}

/** 从页面正文里取统计日期（`统计时间 2026-10-21`）。取不到返回空串。 */
export function readStatDate(text) {
  return String(text ?? '').match(PAGE_TITLE_PATTERN)?.[1] ?? '';
}

// ---------------------------------------------------------------------------
// 「导出链接」的轮询决策（2026-10-21 加）
// ---------------------------------------------------------------------------
// 现场：2026-10-20 网林家居。入口找到了、身份对、统计日期对、「日」按钮也在，唯独
// `link` 是空串 —— 而原版脚本**只读一次**就判死（`if(...!state.link) throw`）。
//
// 为什么会空：`link` 取自 React fiber 的 `memoizedProps.link`，它是导出接口的 URL，
// 要等报表数据请求回来、组件重新渲染之后才会被填进 props。
// **「入口 DOM 出现」不等于「数据请求完成」** —— 原版把异步填充的字段当成同步可读的用，
// 所以判据本身就会偶发假红。
//
// 19 分钟后同一家店、同一条命令就成功了（`link` 有值、8 行写入），这就是竞态而不是配置问题的铁证。
//
// 三态（每一轮重判，与入口轮询同一套风格）：
//   done        拿到 link ⇒ 立刻结束，不为等满窗口空转；
//   wrong-date  日期不是目标日 ⇒ **立刻失败**，这是真错，等下去也不会变；
//   wait        其余（link 为空）⇒ 继续等。
//
// 为什么先判日期再判 link：两者同时不满足时，先报日期能省掉一整个轮询窗口，
// 且「日期错」远比「link 慢」值得马上让人看见。身份不符同理，由调用方在读之前就判掉。
export function planLinkPollStep({ link, date, expectedDate } = {}) {
  if (expectedDate && date && date !== expectedDate) return 'wrong-date';
  if (String(link ?? '').trim()) return 'done';
  return 'wait';
}

/**
 * 有界轮询等 `link` 出现。`read` / `delay` / `now` 可注入 ⇒ 用例用假时钟，不必真等 20 秒。
 *
 * 超时**不抛**，把最后一次读数交回去 —— 由调用方用同一套文案报错（保留原来的可见症状），
 * 同时能在现场里带上「读了几次」，把「根本没读」和「读了十几次还是空」区分开。
 */
export async function pollInquiryLink({
  read, expectedDate, timeoutMs = 20000, intervalMs = 1000, delay, now = Date.now,
} = {}) {
  if (typeof read !== 'function') throw new Error('pollInquiryLink 需要 read()（读一次页面状态）');
  if (!(timeoutMs >= 0)) throw new Error(`pollInquiryLink 的 timeoutMs 必须是非负数，收到 ${JSON.stringify(timeoutMs)}`);
  const wait = delay ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const deadline = now() + timeoutMs;
  let reads = 0; let last = null;
  for (;;) {
    last = (await read()) ?? {};
    reads += 1;
    const step = planLinkPollStep({ link: last.link, date: last.date, expectedDate });
    if (step === 'done') return { state: last, reads, timedOut: false, step };
    if (step === 'wrong-date') return { state: last, reads, timedOut: false, step };
    if (now() >= deadline) return { state: last, reads, timedOut: true, step };
    await wait(intervalMs);
  }
}
