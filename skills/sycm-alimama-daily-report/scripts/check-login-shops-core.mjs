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
// 权威字段是 `sites[key].loggedInAfter ?? sites[key].loggedIn`（2026-09-23 加后半截）。
//   `true` ⇒ 在登录态；`false` ⇒ 掉登录（被踢回登录页）；`null` ⇒ **读不到**。
//   `null` 绝不算通过 —— 这是 2026-09-19 那次静默的教训（空窗口被判成 ALREADY_LOGGED_IN，
//   于是不叫人、不做事、安静地过）。本层把它翻成 `UNREADABLE`，单独成一类。
//   为什么有两个字段：带 `--login` 时子进程会真的去登一次，登完写 `loggedInAfter`；
//   而 `loggedIn` 是**登录之前**那一眼。只读前者的后果是「一次成功的自动登录被报成掉登录」，
//   于是收信人被叫去做一件机器人刚做完的事 —— 详见 judgeShopReceipt 的注释。
//
// **只体检五家店，不看商家浏览器**：那台的登录取自同一批账号，而它的两个页面
// （生意参谋 + 飞书底单页）与五家店的采集无关 —— 它掉了登录会在日报那一侧的失败里露出来。
// 这一层刻意不扩到它，理由写在 check-login-shops.mjs 的头部。
import { SITES, localDateStamp, resolveAction } from './login-merchant-core.mjs';
import { shopIdentity } from './shop-identities.mjs';
// 整轮告警的 source 字段名必须落在渲染器的白名单里，否则渲染时会被静默丢掉
//（告警照发、收信人看不到那一行）。**import 渲染器自己那份**，不在这里另抄一份键名清单。
import { READABLE_SOURCE_KEYS } from '../../../runtime/notify-feishu-core.mjs';

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
 * 把一条 `login-merchant.mjs` 的回执翻成一家店的结论。
 *
 * `receipt === null`（子进程没起来 / 输出不是 JSON）⇒ 两个平台都是 `UNREADABLE` ⇒ `UNKNOWN`。
 * 这一支刻意不抛错：五家店里有一家的回执读不出来，不该让另外四家的结论一起消失。
 *
 * **看哪个字段**（2026-09-23 加 `--login` 时定的）：权威字段是 `loggedInAfter ?? loggedIn`。
 *   - 带 `--login` 时子进程会**真的去登一次**，登完把结果写进 `loggedInAfter`；
 *     而 `loggedIn` 仍是**登录之前**那一眼。只读 `loggedIn` 的话，**一次成功的自动登录会被报成
 *     「还是掉登录」** —— 于是收信人被叫去窗口里做一件机器人刚刚做完的事（假红，比不报更坏）。
 *   - 不带 `--login`（`--check-only`）时 `loggedInAfter` **根本不存在**，
 *     `??` 原样落到 `loggedIn` ⇒ 行为与从前逐字相同。
 */
export function judgeShopReceipt({ shop, receipt = null } = {}) {
  const sites = {};
  for (const key of SITE_KEYS) {
    sites[key] = siteVerdictOf(receipt?.sites?.[key]?.loggedInAfter ?? receipt?.sites?.[key]?.loggedIn);
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
    // 告警那一侧的收据（2026-09-23 透传）。子进程发没发、被没被去重、发失败没有，
    // 只有它知道 —— 不透传的话，「自动登录失败会叫人」这句话在日志里**无从核对**
    // （报告会照旧只写「要你去窗口里动手」，与「已经叫过你了」长得一样）。
    // 只读档下这个字段是 `null`（子进程 `--notify off`，连这个键都不产生）。
    notify: receipt?.notify ?? null,
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
// 「这一层要不要替子进程发飞书」——告警必须与「有没有真的去登」绑在一起
// ---------------------------------------------------------------------------
/**
 * 子进程该拿哪个 `--notify`。
 *
 * 用户 2026-09-23 拍板的口径（原话）：
 *   「如果自动登录失败就飞书告警，但是前提是你要先自动登录」。
 * ⇒ 两个条件缺一不可：**① 这一轮真的去登过（带 `--login`）② 登完仍需要人**。
 *
 * **2026-09-24 改：这个函数恒返回 `off`，投递权整体收到本层（整轮一条）**。原先是
 * 「带 `--login` ⇒ 子进程 `auto`」，于是每个店子进程各自发一条 —— 真出故障时收信人会收到
 * 「5 条预检 + 1 条链」，而 2026-09-24 那次更糟：**5 条全是假红**（页面还没归位，
 * 子进程把 `MAIN_SESSION_ONLY` 当成了要人处理）。
 *
 * 为什么必须收到本层（两个理由，都不是「少发几条更好看」）：
 *   ① **两层判定不一致**：子进程按自己的 `receipt.verdict` 判要不要叫人，而本层按
 *      `judgeShopReceipt`（两个站点的 `loggedIn`）判 —— 同一次运行，本层算出
 *      `needHuman=[]`（什么都不用做），子进程却发了 5 条。判定与投递分居两层，
 *      收信人看到的话就与「整轮到底要不要人」无关了。
 *   ② **去重没有落点**：`alertId` 逐个店一个编号，本层没有「整轮一条」的锚，
 *      于是这一条链根本不进 `runtime/alert-throttle.json` 的去重（实测：5 条全发了）。
 * 收上来之后：判定用 `judgePreflight`（本层唯一那份整轮结论）、投递用 `shouldNotifyRound`、
 * 去重用公共模块 `runtime/alert-throttle.mjs` —— 三者都只有一个来源。
 *
 * 「没去登就不许叫人」这条纪律**没有变**，只是落在 `shouldNotifyRound` 上了。
 */
export function notifyModeFor() {
  return 'off';
}

/**
 * 整轮那一层要不要叫一个人。**纯函数**（判定不许活在 IO 里：IO 脚本离线测不到）。
 *
 * 两个条件缺一不可（第一条是用户 2026-09-23 拍板的那句「前提是你要先自动登录」）：
 *   ① `login`：这一轮真的去登过（`--login`）。没去登却叫人，是在为一件没做的事叫 ——
 *      2026-09-23 之前正是这样：只读体检撞到登录墙也发告警。
 *   ② `judged.verdict === 'NEEDS_LOGIN'`：**确定**有店要人动手。
 *      `INCONCLUSIVE`（读不到，例如页面不在/代理连不上）与 `ALL_IN` 都不叫：
 *      前者是「这一层没有结论」，链的第 0 步会自己补页面；后者本来就没事。
 *      ⚠️ 这里**绝不能**退成「有 unknown 也叫一声」——那就是 2026-09-24 那 5 条假红的形态。
 */
export function shouldNotifyRound({ login = false, judged = null } = {}) {
  if (!login) return false;
  return judged?.verdict === 'NEEDS_LOGIN';
}

// ---------------------------------------------------------------------------
// 整轮告警：**一条**说清「哪几家要人、去哪几个窗口、各做什么」
// ---------------------------------------------------------------------------
//
// 为什么是「一条」而不是「一家一条」（2026-09-24）：一家一条的来源是「每店一个子进程、各自发」，
// 而收信人需要回答的问题是**跨店**的 ——「今天一共要动几台机器、哪几台」。一次 5 条既答不了这个问题，
// 又会把这个通道训练成噪音（而它往往是唯一会叫人动手的通道）。
// 判定用 `judgePreflight`（本层唯一那份整轮结论）、去重用 `runtime/alert-throttle.mjs`。
const READABLE_SOURCE_KEY_NAMES = new Set(READABLE_SOURCE_KEYS.map(([key]) => key));

/**
 * 拼整轮那一条登录告警。**只有真的需要人时才允许调用** —— 不需要人却发一条，
 * 是在教人忽略这个通道（fail-closed：调用方判错了就当场抛，而不是发出去一条不该有的）。
 *
 * 内容取舍（收信人看完要能直接动手，不用再去翻日志）：
 *   · 标题带**家数**（一眼看出今天要动几台机器；一家时直接写店名）；
 *   · `reason` 逐店列出「哪家店、哪个后台」；
 *   · `action` 逐店给一句「照着做就能做完」的话 —— 用 `resolveAction` 的**同一份文案**
 *     （它已经把「去哪个窗口、做什么」写全了，包括「登录页已经开着」这种承诺的取舍），
 *     但**把 `{窗口}` 占位符按「不带店名」渲染**：店名已经在本行开头，重复五遍只会让话变长。
 *   · `source` 只放白名单里的键，且**不放机器名/浏览器配置**：这一条是给业务收信人看的，
 *     技术串留在报告与 job.log 里（键名由下面那条断言拦住，不是靠写的人记得）。
 */
export function buildRoundLoginAlert({ rows = [], judged = judgePreflight(rows), now = () => new Date() } = {}) {
  const { verdict, needHuman } = judged;
  if (verdict !== 'NEEDS_LOGIN' || needHuman.length === 0) {
    throw new Error('这一轮没有「确定要人处理」的店，不该生成登录告警（调用方判定错误）—— '
      + '不需要人时发一条，等于在教收信人忽略这个通道');
  }
  const when = now();
  const shops = needHuman.map((item) => item.shop);
  const rowOf = (shop) => rows.find((row) => row.shop === shop) ?? null;
  const sitesOf = (item) => item.sites.map((key) => SITES[key].label).join('、');
  const alert = {
    type: 'LOGIN_REQUIRED',
    severity: 'ERROR',
    title: shops.length === 1 ? `${shops[0]} 需要你登录一次` : `${shops.length} 家店需要你登录一次`,
    // 同一轮同一天共用一条锚（`sycm-login-round-<日期戳>`）：**这是去重能不能生效的前提**
    // （投递链本身不去重，只认调用方传进来的编号）。日期戳来自 login-merchant-core 的
    // `localDateStamp` —— 不在这里再拼一份，两份日期戳会在同一天里拼出两个锚。
    //
    // 与逐店那条（`sycm-login-<店>-sycm-alimama-<日>`）**刻意不同**：那个编号是子进程自己发的
    // （2026-09-24 起子进程一律不发），保留它只为让历史记录仍能对上。
    alertId: `sycm-login-round-${localDateStamp(when)}`,
    // 指纹 = 「哪几家、哪几个后台」。变了才算新信息（例如第一次是 2 家、第二次多了 1 家）。
    fingerprint: needHuman
      .map((item) => `${item.shop}:${[...item.sites].sort().join(',')}`)
      .sort()
      .join('|'),
    createdAt: when.toISOString(),
    reason: `跑前登录体检 + 自动登录都试过之后，这 ${shops.length} 家店的后台仍不在登录态：\n`
      + needHuman.map((item) => `· ${item.shop}（${sitesOf(item)}）`).join('\n'),
    action: `去标题写着店名的那个浏览器窗口里各处理一次（任务栏里就能看到窗口标题）：\n`
      + needHuman.map((item) => `· ${item.shop}：${resolveAction(rowOf(item.shop)?.scriptVerdict ?? 'NEEDS_LOGIN', null)}`)
        .join('\n'),
    source: {
      targetLabel: `日报跑前登录体检 · ${shops.length} 家店`,
      capability: '各店铺日报',
      shopName: shops.join('、'),
    },
  };
  // 键名写错时渲染器会**静默丢掉**那一行（告警照发、收信人看不到），所以在这里当场拦。
  const unknown = Object.keys(alert.source).filter((key) => !READABLE_SOURCE_KEY_NAMES.has(key));
  if (unknown.length) {
    throw new Error(`整轮登录告警的 source 里有渲染器不认识的键（${unknown.join('、')}）—— `
      + '它们会被白名单静默丢掉：收信人看不到，而你以为发出去了。要么改白名单，要么别给。');
  }
  return alert;
}

// ---------------------------------------------------------------------------
// 命令行参数（纯函数，拼错必须当场抛错）
// ---------------------------------------------------------------------------
/**
 * 刻意**没有** `--target`：这一层只做「两个平台各看一眼」。
 * 只查一个平台是 login-merchant.mjs `--target` 的用法，不在这里再开一个口子 ——
 * 多一个开关就多一种「四个平台里只查了两个」的现场，而那种现场看起来是绿的。
 *
 * `--login`（2026-09-23 加，**默认关**）：把「查」升级成「查 + 掉了就自己登一次」。
 *   - 不带它：子进程走 `--check-only`，**一个页面都不碰**（只读），行为与从前逐字相同。
 *   - 带它：子进程走 `--commit`，会开登录页、补一次可信手势、提交表单。
 *     ⇒ **这一层就从只读变成了写入方**，调用方必须知道自己要的是哪一种。
 *   默认关不是保守，是分工：本模块同时被「跑前那一眼的体检」和「跑前登录守卫」用，
 *   两者对「能不能碰页面」的答案相反，所以由调用方显式选，不由这里替它猜。
 *
 * @param {string[]} argv
 * @param {{ shops?: string[]|null }} ctx
 *   `shops` 是**登记表里的合法店名**（运行时由 browser-ports.shopBrowserKeys() 给）。
 *   不传时跳过店名校验 —— 保持「解析」与「登记表」解耦，用例可以只测解析本身。
 */
export function parseCheckShopsArgs(argv, { shops = null } = {}) {
  const opts = { shops: null, json: false, timeoutMs: 180000, help: false, login: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') { opts.json = true; continue; }
    if (token === '--login') { opts.login = true; continue; }
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

// 「自动登录为什么没成」—— 词是 login-merchant-core.mjs 的 VERDICTS，**不在这里另造一套**。
// 每一条都要能回答「接下来人该做什么」，所以只写「人该怎么办」，不复述内部机制。
// 漏一条的后果是收了告警的人看到一句内部代号（或什么都没有），所以宁可写得直白。
//
// 导出是为了让用例能**逐个核对覆盖**：漏一个词的现场表现是「运营看到 `WRONG_ACCOUNT` 这种
// 内部代号」（2026-09-23 之前那条兜底文案正是这么写的），而它不会报任何错 ——
// 所以覆盖这件事必须由判据来守，不能靠「写的人记得加」。
export const LOGIN_FAIL_TEXT = Object.freeze({
  NEEDS_LOGIN: '这一轮只做体检，系统没有去登',
  NO_SAVED_CREDENTIAL: '浏览器没把账号密码填进去 —— 这一家的密码库里没有这份凭据，或填充没落地',
  // 2026-09-23 加。与上一句**刻意不同**：这一条不是「没凭据」，而是「这台机器里存着不止一家店的账号，
  // 而浏览器自己挑了一条」，所以人该做的是「用这一家的账号登一次」并把多余的凭据清掉，
  // 不是「去点保存密码」（那会把问题坐实）。
  WRONG_ACCOUNT: '浏览器填进来的是**另一家店**的账号 —— 这台机器里存着不止一家店的账号密码，系统没有替你提交',
  CAPTCHA_REQUIRED: '出现了滑块或图片验证码，这一步只能人来过',
  MAIN_SESSION_ONLY: '淘宝主站会话还在，是这两个后台自己的会话没了，得单独登一次',
  LOGIN_NOT_CONFIRMED: '提交之后还停在登录页（密码不对，或平台要求额外验证）',
  STOP_AND_ALERT: '页面结构和预期不一样，系统没有乱点',
  PARTIAL: '只进去了一部分后台',
});

/** 把子脚本次次报的结论翻成一句人话。认不出来就如实说认不出来 —— 不猜。 */
export function loginFailReason(scriptVerdict) {
  if (!scriptVerdict) return null;
  return LOGIN_FAIL_TEXT[scriptVerdict] ?? `自动登录没成（内部结论：${scriptVerdict}）`;
}

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

/**
 * 末尾那段「要人做什么」。只在真的需要人 / 真的没结论时才出现。
 *
 * `autoLogin`（2026-09-23 加）只改**措辞**，不改任何判定：
 *   不带它时，这一层是只读体检，话是「你去窗口里登一次」；
 *   带它时，这一层已经**自己试过了**，话必须改成「自动登录也试过了、没成」，
 *   并且把子进程报的失败原因抄出来 —— 否则收信人会以为「机器什么都没做」，
 *   而其实机器做过一次（那次尝试本身就是他需要知道的信息）。
 */
export function renderVerdictLines(rows, judged = judgePreflight(rows), { autoLogin = false } = {}) {
  const { verdict, needHuman, unknown } = judged;
  const lines = [];
  const rowOf = (shop) => rows.find((row) => row.shop === shop) ?? null;
  if (verdict === 'ALL_IN') {
    lines.push(`[判据] ${rows.length} 家店、${rows.length * SITE_KEYS.length} 个平台都在登录态 —— 可以开跑。`);
    // 只在**真的去登过**（`autoLogin`）而且**确实登进去了**（子进程回 `LOGGED_IN`）时才多这一行。
    // 两个条件缺一不可：只读模式下「这一次自己登进去的」这句话本身就是假的
    // （那一轮没有任何登录发生过）。只读回执里也不会出现 `LOGGED_IN` 这个结论，
    // 但把这句的成立条件**写出来**，比依赖「那个值不会出现」更可靠。
    const autoFixed = autoLogin
      ? rows.filter((row) => row.scriptVerdict === 'LOGGED_IN').map((row) => row.shop)
      : [];
    if (autoFixed.length > 0) {
      lines.push(`  其中 ${autoFixed.length} 家是**这一次自己登进去的**（其余本来就在登录态）：${autoFixed.join(' / ')}`);
    }
    return lines;
  }
  if (needHuman.length > 0) {
    lines.push(autoLogin
      ? `[判据] 有 ${needHuman.length} 家店**自动登录也试过了、没成**，要你去窗口里动一下手：`
      : `[判据] 有 ${needHuman.length} 家店要你去窗口里动一下手：`);
    for (const item of needHuman) {
      const which = item.sites.map((key) => SITES[key].label).join('、');
      const account = loginAccountFor(item.shop);
      const how = account ? `用「${account}」登录` : '用这家店自己的账号登录';
      lines.push(`  · ${item.shop}（${which}）—— 在标题写着「${item.shop}」的那个浏览器窗口里，${how}一次`
        + '（登录时点浏览器提示里的「保存密码」，下次就不用再来）。');
      // 原因那一行**只在真的去登过时才印**：只读模式下子进程的结论是 `NEEDS_LOGIN`，
      // 照抄那句话会写成「自动登录没成：这一轮只做体检」—— 一件根本没发生的事被说成失败了。
      const why = autoLogin ? loginFailReason(rowOf(item.shop)?.scriptVerdict) : null;
      if (why) lines.push(`      自动登录没成的原因：${why}。`);
    }
    lines.push(autoLogin
      ? '  这一层**已经自己试过登录了**（打开过登录页、补过一次可信手势、提交过表单）；上面列出的是试完仍然没进去的那些。'
      : '  这一层只是体检：它没有打开过任何页面、也没有点过任何东西。');
  }
  if (unknown.length > 0) {
    lines.push(`[判据] 还有 ${unknown.length} 家店**这一层没有结论**（读不到不等于通过）：`);
    for (const item of unknown) {
      const which = item.sites.map((key) => SITES[key].label).join('、');
      lines.push(`  · ${item.shop}（${which}）`);
    }
    // 措辞按 2026-09-24 的改动更新：**这一层开跑前已经归位过一次**（见 [归位] 段），
    // 所以「页面还没归位」不再是默认解释 —— 归位后仍读不到，说明归位也没做成
    // （代理没起、页面被人手关掉等），该说的是「下一步谁还会再试一次」。
    lines.push('  这是「这个窗口里没有它的页面」或「连不上这个窗口」——**不是掉登录**。'
      + '本次开跑前已经归位过一次（见上面的 [归位] 段）；链的第 0 步还会再补一次，'
      + '届时采集阶段会如实报出来。');
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 渲染：告警那一侧发生了什么（**整轮一条**，2026-09-24 起）
// ---------------------------------------------------------------------------
// 状态词是**投递方报的**（`runtime/notify-feishu.mjs` 的收据），这里只翻译，不另造一套。
// 每一条都要能回答收件人的下一个问题：
//   「我已经被告知了吗？」「为什么没发？」「发了但失败了怎么办？」
// 漏一条的症状是「报告上写着要人处理，而没有人被通知」—— 那正是本次要消灭的形态。
const NOTIFY_STATUS_TEXT = Object.freeze({
  SENT: '已发飞书告警',
  DEDUPED: '同一天、同一轮已经叫过一次了，本次不重复发（去重按告警编号 + 停的地方）',
  MUTED: '这条告警被显式静音了（不是发送失败）',
  DRY_RUN: '只渲染了告警文案，没有真发（调试档）',
  NOT_CONFIGURED: '告警没发出去：通知通道没有配置',
  FAILED: '告警发送失败 —— 必须有人接手（这一轮的结论只在日志里）',
  SKIPPED: '没发',
});

/**
 * 整轮告警收据那几行。
 *
 * `receipt === null` ⇒ 这一整段不出现（只读档、以及「没有需要人」的那两档都不产生收据）。
 * 为什么单列成一段、而不是塞进每家店那两行里：它回答的是一个**跨店**的问题
 * （「这一轮一共叫没叫到人」），而每家店那两行回答的是「这家店怎么了」——
 * 混在一起的后果是「告警发失败了」这件事被淹没在五行店名里，收信人扫过去不会注意到。
 */
export function renderRoundNotifyLines(receipt = null) {
  if (!receipt) return [];
  const id = receipt.alertId ? `（编号 ${receipt.alertId}）` : '';
  const note = receipt.reason ? ` —— ${receipt.reason}` : '';
  if (receipt.status === 'SENT') return [`[告警] 已发 1 条飞书${id}`];
  const text = NOTIFY_STATUS_TEXT[receipt.status] ?? `告警状态 ${receipt.status}（认不出来，别当成发过了）`;
  const tail = receipt.error ? ` —— ${String(receipt.error).slice(0, 200)}` : note;
  return [`[告警] ${text}${id}${tail}`];
}

/**
 * 归位那一段（2026-09-24 加）：这一轮**开跑前**把五家店的页面补齐到「恰好各一个」。
 *
 * 为什么要把它打进报告：它改变了「登录态体检读到的东西」这个前提 ——
 * 不写出来，人看到「读不到」时会去猜页面到底在不在（而这一步已经回答过了）。
 * 只读档（`asked === false`）要把「没有归位」说明白，否则那一段看起来像「归位过了、一切正常」。
 */
export function renderNormalizeLines(normalize = null) {
  if (!normalize || normalize.asked !== true) return [];
  const entries = Array.isArray(normalize.shops) ? normalize.shops : [];
  const lines = ['[归位] 开跑前把页面补齐到「恰好各一个」（缺的先领回、确认没有的才新建）：'];
  for (const entry of entries) {
    if (entry.error) { lines.push(`  · ${entry.shop}：没做成 —— ${entry.error}`); continue; }
    const why = entry.detail ? `（${entry.detail}）` : '';
    lines.push(`  · ${entry.shop}：${entry.ok === false ? '⚠️ 仍不齐' : '已就位'}${why}`);
  }
  if (entries.length === 0) lines.push('  （没有可归位的店。）');
  return lines;
}

/** 整份报告（stdout 上看到的那段）。 */
export function renderReport({ rows, machine = null, autoLogin = false, normalize = null, roundNotify = null } = {}) {
  const mode = autoLogin
    ? '｜会自己登：开跑前先把页面归位，掉登录的当场用浏览器密码库登一次，没成才发飞书叫人（整轮一条）'
    : '｜只读：不开页面、不点任何东西、不归位、也不发任何告警';
  const lines = [
    `[跑前体检] 登录态 · ${rows.length} 家店 × ${SITE_KEYS.length} 个平台`
    + `（${SITE_KEYS.map((key) => SITES[key].label).join(' + ')}）`
    + `${mode}${machine ? `｜本机 ${machine}` : ''}`,
  ];
  // 归位排在最前：它发生在体检**之前**，报告的顺序要跟时间顺序一致 ——
  // 否则读报告的人会以为「先读了登录态，然后才补的页面」。
  lines.push(...renderNormalizeLines(normalize));
  for (const row of rows) lines.push(...renderShopBlock(row));
  lines.push(...renderVerdictLines(rows, judgePreflight(rows), { autoLogin }));
  // 告警段吃的是**整轮那一份收据**（不是逐店行 —— 子进程从 2026-09-24 起不再自己发）。
  lines.push(...renderRoundNotifyLines(roundNotify));
  return lines.join('\n');
}
