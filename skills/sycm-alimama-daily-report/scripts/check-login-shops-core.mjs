// 「逐店登录态体检」的纯逻辑（可离线测）。IO 全在 check-login-shops.mjs。
//
// 为什么要有这一层（2026-09-23 建）：
//   整条日报链**没有任何一步看登录态** —— 体检（runtime/xws-platform-health-preflight.mjs）
//   只跑 port / pages / egress，文件里对此有明确交代（IDENTITY / SESSION / END_TO_END 未实现）。
//   于是「某家店掉了登录」不会在开跑前被发现，只会等到采集阶段炸，然后发出 2026-09-23 实录里
//   那种告警：**「没跑完，但记录里没写停在哪一步」** —— 收信人拿到它，还是不知道该做什么。
//   这一层要在开跑**之前**把「哪家店的哪一个后台掉登录了、该用哪个账号登」说清楚。
//
// 与 login-merchant.mjs 的分工（刻意**不**重复实现探测）：
//   探测本身（读 /targets → 该站点页面恰好一个 → navigate 到探针地址 → 读 location.href →
//   站点判据）**全在 `login-merchant.mjs --check-only` 里**，本层只做三件事：
//     ① 按登记表把店铺逐个跑一遍（IO 侧）；
//     ② 把回执里的 `sites.*.loggedIn` 翻成「在登录态 / 掉登录 / 读不到」；
//     ③ 判「要不要人」，并渲染成收信人照着能做完的话。
//   ⇒ 站点词表、未登录 URL 判据、探针地址都只有一份（login-merchant-core.mjs 的 SITES），
//     连「哪个平台该显示哪个名字」也只有一份（shop-identities.mjs）。
//
// 权威字段只有一个：`sites[key].loggedIn`。
//   `true` ⇒ 在登录态；`false` ⇒ 掉登录（被踢回登录页）；`null` ⇒ **读不到**。
//   `null` 绝不算通过 —— 这是 2026-09-19 那次静默的教训（空窗口被判成 ALREADY_LOGGED_IN，
//   于是不叫人、不做事、安静地过）。本层把它翻成 `UNREADABLE`，单独成一类。
//
// **只体检五家店，不看商家浏览器**：那台的登录取自同一批账号，而它的两个页面
// （生意参谋 + 飞书底单页）与五家店的采集无关 —— 它掉了登录会在日报那一侧的失败里露出来。
// 这一层刻意不扩到它，理由写在 check-login-shops.mjs 的头部。
import { SITES } from './login-merchant-core.mjs';
import { shopIdentity } from './shop-identities.mjs';

/** 平台键。取自 login-merchant-core 的 SITES —— 不在这里另抄一份站点名。 */
export const SITE_KEYS = Object.freeze(Object.keys(SITES));

// ---------------------------------------------------------------------------
// 一个平台一次体检的结论
// ---------------------------------------------------------------------------
// 三个词，没有第四个：**没有「大概在」这种状态**。读不到就是读不到。
export const SITE_VERDICTS = Object.freeze(['LOGGED_IN', 'LOGGED_OUT', 'UNREADABLE']);

export function siteVerdictOf(loggedIn) {
  if (loggedIn === true) return 'LOGGED_IN';
  if (loggedIn === false) return 'LOGGED_OUT';
  return 'UNREADABLE';
}

// ---------------------------------------------------------------------------
// 一家店的结论
// ---------------------------------------------------------------------------
export const SHOP_VERDICTS = Object.freeze(['OK', 'NEEDS_LOGIN', 'UNKNOWN']);

/**
 * 把一条 `login-merchant.mjs --check-only` 的回执翻成一家店的结论。
 *
 * `receipt === null`（子进程没起来 / 输出不是 JSON）⇒ 两个平台都是 `UNREADABLE` ⇒ `UNKNOWN`。
 * 这一支刻意不抛错：五家店里有一家的回执读不出来，不该让另外四家的结论一起消失。
 */
export function judgeShopReceipt({ shop, receipt = null } = {}) {
  const sites = {};
  for (const key of SITE_KEYS) {
    sites[key] = siteVerdictOf(receipt?.sites?.[key]?.loggedIn);
  }
  const needsLogin = SITE_KEYS.filter((key) => sites[key] === 'LOGGED_OUT');
  const unreadable = SITE_KEYS.filter((key) => sites[key] === 'UNREADABLE');
  const verdict = needsLogin.length > 0 ? 'NEEDS_LOGIN' : (unreadable.length > 0 ? 'UNKNOWN' : 'OK');
  return {
    shop,
    verdict,
    sites,
    needsLogin,
    unreadable,
    // 探针读到的最终地址：复核时唯一能拿来核对的现场事实（`null` 是「没读到」，不是「没有」）。
    href: Object.fromEntries(SITE_KEYS.map((key) => [key, receipt?.sites?.[key]?.href ?? null])),
    // 子脚本自己报的结论与说明。**只抄，不替它下结论** —— 与登录那侧的纪律一致。
    scriptVerdict: receipt?.verdict ?? null,
    detail: receipt?.detail ?? null,
  };
}

// ---------------------------------------------------------------------------
// 整轮（N 家店）的结论
// ---------------------------------------------------------------------------
export const PREFLIGHT_VERDICTS = Object.freeze(['ALL_IN', 'NEEDS_LOGIN', 'INCONCLUSIVE']);

export function judgePreflight(rows = []) {
  const needHuman = rows
    .filter((row) => row.verdict === 'NEEDS_LOGIN')
    .map((row) => ({ shop: row.shop, sites: row.needsLogin }));
  const unknown = rows
    .filter((row) => row.verdict === 'UNKNOWN')
    .map((row) => ({ shop: row.shop, sites: row.unreadable }));
  const verdict = needHuman.length > 0
    ? 'NEEDS_LOGIN'
    : (unknown.length > 0 ? 'INCONCLUSIVE' : 'ALL_IN');
  return { verdict, needHuman, unknown, checked: rows.length };
}

/**
 * 退出码的失败方向（三条都要能被上层区分开，不能糊成「非 0」）：
 *   0 只有**全部都正面确认在登录态**时才给 —— 「读不到」不算通过；
 *   2 有后台**明确掉登录**（有人要做的事是确定的）；
 *   3 既没确认、也没判出掉登录（读不到 / 子进程失败）—— **这一层没有结论**。
 * 为什么 0 与 3 要分开：定时链那一步拿它当「跑前那一眼」的记录。若读不到也回 0，
 * 日志里的这一行就与「体检真的过了」长得一模一样 —— 那正是本仓库反复在治的那种静默。
 */
export function exitCodeForPreflight(verdict) {
  if (verdict === 'ALL_IN') return 0;
  if (verdict === 'NEEDS_LOGIN') return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// 命令行参数（纯函数，拼错必须当场抛错）
// ---------------------------------------------------------------------------
/**
 * 刻意**没有** `--target`：这一层只做「两个平台各看一眼」。
 * 只查一个平台是 login-merchant.mjs `--target` 的用法，不在这里再开一个口子 ——
 * 多一个开关就多一种「四个平台里只查了两个」的现场，而那种现场看起来是绿的。
 *
 * @param {string[]} argv
 * @param {{ shops?: string[]|null }} ctx
 *   `shops` 是**登记表里的合法店名**（运行时由 browser-ports.shopBrowserKeys() 给）。
 *   不传时跳过店名校验 —— 保持「解析」与「登记表」解耦，用例可以只测解析本身。
 */
export function parseCheckShopsArgs(argv, { shops = null } = {}) {
  const opts = { shops: null, json: false, timeoutMs: 180000, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') { opts.json = true; continue; }
    if (token === '--help' || token === '-h') { opts.help = true; continue; }
    const valued = ['--shops', '--timeout'];
    if (!valued.includes(token)) throw new Error(`Unknown argument: ${token}`);
    const value = argv[i + 1];
    // 先认名字再看值：否则 `--nope` 会被报成「需要一个值」，把「参数拼错」伪装成「忘了给值」。
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    if (token === '--shops') opts.shops = value.split(',').map((s) => s.trim()).filter(Boolean);
    if (token === '--timeout') {
      const ms = Number(value);
      if (!Number.isInteger(ms) || ms < 1000) {
        throw new Error(`--timeout 必须是 ≥1000 的整数毫秒，收到 ${JSON.stringify(value)}`);
      }
      opts.timeoutMs = ms;
    }
    i += 1;
  }
  if (opts.shops !== null && opts.shops.length === 0) {
    throw new Error('--shops 是空的（给一个店名，或整个去掉这个参数）');
  }
  // 店名拼错必须当场抛错并列出合法值：否则会去体检一个**不存在**的实例，
  // 拿回来的「连不上」看起来像故障，而真相是名字打错了。
  if (opts.shops !== null && Array.isArray(shops)) {
    for (const key of opts.shops) {
      if (!shops.includes(key)) throw new Error(`Unknown --shops ${key} (known: ${shops.join(' / ')})`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// 渲染：给人看的那几行
// ---------------------------------------------------------------------------
// 「这个平台该显示什么名字」——**每个平台各说各的**（用户 2026-09-22 定的汇报口径：
// 提到某家店必须按平台分别说名字，不许把生意参谋页头店名当成它在阿里妈妈那儿的名字）。
// 名字只有一个来源：shop-identities.mjs。这里读不到它时如实说「没登记」，不猜。
export function platformNameHint(shop, siteKey) {
  let row = null;
  try { row = shopIdentity(shop); } catch { row = null; }
  if (!row) return null;
  if (siteKey === 'sycm') return row.sycmHeader ? { kind: 'shop', value: row.sycmHeader } : null;
  if (siteKey === 'alimama') {
    return row.alimamaMemberName ? { kind: 'member', value: row.alimamaMemberName } : null;
  }
  return null;
}

/** 收信人要去登录时，用的是**会员名**（阿里妈妈页头那个），不是店铺名。 */
export function loginAccountFor(shop) {
  return platformNameHint(shop, 'alimama')?.value ?? null;
}

const SITE_RESULT_TEXT = Object.freeze({
  LOGGED_IN: '在登录态',
  LOGGED_OUT: '掉登录了',
  UNREADABLE: '读不到',
});

function siteLine(shop, key, state) {
  const hint = platformNameHint(shop, key);
  const whose = hint
    ? (hint.kind === 'shop' ? `这一页应显示店名「${hint.value}」` : `这个窗口登的会员名应是「${hint.value}」`)
    : '（这家店在这个平台没有登记名字）';
  const text = SITE_RESULT_TEXT[state] ?? '读不到';
  // 「读不到」必须自解释：否则收信人会把它当成「有问题」，去找一个其实还没建的页面。
  const why = state === 'LOGGED_OUT' ? '（被平台踢回了登录页）'
    : (state === 'UNREADABLE' ? '（这个窗口里没有它的页面，或者连不上这个窗口）' : '');
  return `    ${SITES[key].label}：${text}${why} —— ${whose}`;
}

/** 一家店一段。结论为「都在登录态」时压成一行 —— 没有问题就不该占两行。 */
export function renderShopBlock(row) {
  if (row.verdict === 'OK') {
    const all = SITE_KEYS.map((key) => `${SITES[key].label}在登录态`).join('，');
    return [`  ${row.shop}：${all}`];
  }
  const lines = [`  ${row.shop}（${row.verdict === 'NEEDS_LOGIN' ? '要处理' : '没结论'}）`];
  for (const key of SITE_KEYS) lines.push(siteLine(row.shop, key, row.sites[key]));
  return lines;
}

/** 末尾那段「要人做什么」。只在真的需要人 / 真的没结论时才出现。 */
export function renderVerdictLines(rows, judged = judgePreflight(rows)) {
  const { verdict, needHuman, unknown } = judged;
  const lines = [];
  if (verdict === 'ALL_IN') {
    lines.push(`[判据] ${rows.length} 家店、${rows.length * SITE_KEYS.length} 个平台都在登录态 —— 可以开跑。`);
    return lines;
  }
  if (needHuman.length > 0) {
    lines.push(`[判据] 有 ${needHuman.length} 家店要你去窗口里动一下手：`);
    for (const item of needHuman) {
      const which = item.sites.map((key) => SITES[key].label).join('、');
      const account = loginAccountFor(item.shop);
      const how = account ? `用「${account}」登录` : '用这家店自己的账号登录';
      lines.push(`  · ${item.shop}（${which}）—— 在标题写着「${item.shop}」的那个浏览器窗口里，${how}一次`
        + '（登录时点浏览器提示里的「保存密码」，下次就不用再来）。');
    }
    lines.push('  这一层只是体检：它没有打开过任何页面、也没有点过任何东西。');
  }
  if (unknown.length > 0) {
    lines.push(`[判据] 还有 ${unknown.length} 家店**这一层没有结论**（读不到不等于通过）：`);
    for (const item of unknown) {
      const which = item.sites.map((key) => SITES[key].label).join('、');
      lines.push(`  · ${item.shop}（${which}）`);
    }
    lines.push('  多数情况下这是「它的页面还没归位」—— 链的第 0 步会自己补上再体检。');
  }
  return lines;
}

/** 整份报告（stdout 上看到的那段）。 */
export function renderReport({ rows, machine = null } = {}) {
  const lines = [
    `[跑前体检] 登录态 · ${rows.length} 家店 × ${SITE_KEYS.length} 个平台`
    + `（${SITE_KEYS.map((key) => SITES[key].label).join(' + ')}）`
    + `｜只读：不开页面、不点任何东西${machine ? `｜本机 ${machine}` : ''}`,
  ];
  for (const row of rows) lines.push(...renderShopBlock(row));
  lines.push(...renderVerdictLines(rows, judgePreflight(rows)));
  return lines.join('\n');
}
