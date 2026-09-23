// 窗口标签页：让「这台浏览器是哪家店的」在**机器前**一眼可读。
//
// 为什么需要它（2026-09-18 用户原话）：
//   「飞书给我发了提醒，但是我不知道是哪一个店铺的浏览器需要登录，
//     还有我看到每个浏览器里面有多个界面，也没有登录」
//
// 告警能说出店名（`login-merchant-core.mjs` 的 `shopName`），但告警**没法替收信人点开某个窗口** ——
// 飞书里点不了本机的浏览器。所以「哪家店」这件事必须在机器那一侧也有落点：
// **窗口标题里写着店名**，收信人照着标题就能对上（任务栏、窗口列表里显示的就是这一行）。
//
// 四台窗口标题如果都是默认的页面名，它们长得一模一样，告警说了店名也等于没说。
// 这就是本模块唯一真正起作用的那一件事：把店名写进标题，并且在窗口里用大字再写一遍。
//
// 三条设计约束：
//   1) **纯函数与 IO 分开**（与本仓库其它地方同一条分界）：「标题该长什么样」「哪些页签是残留」
//      是判据，必须能离线测；真正去动浏览器的只有 `ensureLabelTabOn` 一个函数。
//   2) **只用各店自己的代理**（`/targets` `/navigate` `/new`），不直连调试端口 ——
//      裸 CDP 端口在 2026-09-18 实测「页面上什么都有，脚本一个也连不上」。
//   3) **默认不动任何东西**：CLI 不带 `--commit` 时只打印「哪台缺标签页 / 现在有哪些页签」。
import { SHOP_BROWSERS, shopBrowserKeys } from './browser-ports.mjs';
// 会员名从「店铺身份登记表」读 —— 那是唯一来源（逐字抄自运营的店铺底单，见 shop-identities.mjs）。
import { SHOP_IDENTITIES } from '../skills/sycm-alimama-daily-report/scripts/shop-identities.mjs';
// 「页面**实际登的是谁**」怎么读，不在这里另写一份 —— 复用采集链唯一那份判据（collect-core.mjs）。
// 各写一份选择器迟早会漂移，而漂移的表现是**结论错**：窗口上写着「登的是 A」，采集链却按另一套
// 判据取数。归一化（`normalizeShopName`）也一并复用：比对的两端必须是同一个口径。
import {
  alimamaIdentityExpression, normalizeShopName,
} from '../skills/sycm-alimama-daily-report/scripts/collect-core.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 标签页本身。放在仓库里（原先那份在 `D:/Retire/edge-profiles/` 下，是仓库外的临时件：
// 换一台机器就没有，也没人知道它是从哪来的 —— 一份行为定义不该只活在某台机器上）。
export const LABEL_PAGE_PATH = fileURLToPath(new URL('./shop-window-label.html', import.meta.url));
export const LABEL_PAGE_NAME = 'shop-window-label.html';

// 窗口标题的后缀。改这里就等于改「告警里那句指路」的前提，所以测试会把它和告警文案绑在一起看。
export const WINDOW_TITLE_SUFFIX = ' · 日报采集窗口';

export function windowTitleFor(shop) {
  const name = String(shop ?? '').trim();
  if (!name) throw new Error('windowTitleFor 需要一个店名 —— 没有店名的标题等于没标');
  return `${name}${WINDOW_TITLE_SUFFIX}`;
}

/**
 * 这家店的**阿里妈妈会员名**（形如 `j873522735:阿彦`）。
 *
 * 为什么这个要出现在窗口上（2026-09-18 深夜，用户原话「没有科塔啊，五个店铺哪里有科塔」）：
 * 他手里是运营同事按**会员名**给的账号（`里可林家居:阿彦` / `网林家居旗舰店:阿彦` /
 * `随心品质定制:阿彦` / `j873522735:阿彦`），而窗口标题写的是**运营叫法**（里可林淘宝／网林天猫／
 * 盖文淘宝／科塔淘宝）。两套名字对不上，于是他看不出「科塔」是哪一组账号 ——
 * 其中科塔的会员名干脆是一串数字（`j873522735`），字面上完全没有「科塔」二字。
 * 会员名放在窗口上，人一到机器前就能把两边对上。
 *
 * 口径：
 *   - 来源是登记表（`shop-identities.mjs`），**不许在这里另抄一份**；
 *   - 读不到（这家店没登记 / 没实测过）就返回 `null`，页面上那一行整个不显示 ——
 *     与登录状态同一口径（不写占位）；
 *   - **只放会员名，绝不放密码**（凭据不进任何仓库内的东西，这是硬纪律）；
 *   - `identities` 形状不对时**抛错**，不回落成 `null`。
 *
 * 最后那条是踩出来的（2026-09-18 深夜，本函数第一版）：登记表是**数组**（每行 `{ key, ... }`），
 * 我写成了对象下标 `identities[name]` ⇒ 它永远返回 `null`，页面上那一行永远空着，
 * 而且**没有任何报错** —— 症状与「这家店确实没登记」一模一样。是刚写的判据当场把它抓出来的。
 * 「找不到」与「传错了形状」后果完全不同，不能混成一个 null。
 */
export function memberNameFor(shop, identities = SHOP_IDENTITIES) {
  const name = String(shop ?? '').trim();
  if (!name) return null;
  if (!Array.isArray(identities)) {
    throw new TypeError('memberNameFor 的 identities 必须是登记表的数组形状（SHOP_IDENTITIES）');
  }
  return identities.find((row) => row?.key === name)?.alimamaMemberName ?? null;
}

/**
 * 把「登记表说应该是谁」（`expected`＝`memberNameFor` 那个值）与「页面**实际**登的是谁」
 * （`actual`＝从工作页读出来的会员名）摆在一起判定。
 *
 * 为什么需要它（2026-09-22 加。事故形态是 2026-09-13 那次：登录态完全正常、但登的是别人）：
 * `login-merchant.mjs` 的 `sites.*.loggedIn` 只回答「**有没有**会话」，不回答
 * 「**以谁的身份**持有会话」。而串号的下游代价是静默的 —— 采集照跑、文件照落、数字照进飞书，
 * 阿里妈妈那份产物里连一个店铺身份字段都没有，事后从产物里查不出来。
 * 所以「实际登的是谁」必须有一个**站在机器前就能看见**的落点，而不是只活在某次体检的日志里。
 *
 * 四种结果，含义各不相同，**不许混成一个布尔**：
 *   `null`            量不到实际值 ⇒ 页面上那一行整个不显示（不写占位）。
 *                     **这不是「一致」** —— 把「没量到」写成「对得上」正是本项目犯过两次的错。
 *   `'unregistered'`  登记表里没有这家的期望值（未实测）⇒ 只显示实际值，**不下判定**。
 *                     写成「一致」就等于用一个没核对过的判断题冒充核对过。
 *   `'match'`         逐字相同。
 *   `'mismatch'`      不一样 ⇒ 页面上标红。**这才是这个功能存在的全部理由。**
 *
 * 比对口径是**去空白后的逐字相等**，不做任何「像不像」的模糊判断：
 * 实测盖文淘宝的会员名是 `随心品质定制:阿彦`，与店名（盖文全卫定制）毫无字面关系 ——
 * 靠相似度认店在这个项目里已经被推翻过一次，这里不重犯。
 */
export function memberVerdictFor({ expected = null, actual = null } = {}) {
  const got = normalizeShopName(actual);
  if (!got) return null;
  const want = normalizeShopName(expected);
  if (!want) return 'unregistered';
  return got === want ? 'match' : 'mismatch';
}

// 标签页的 URL。`state` / `member` / `actual` 都是可选的：量到就带上，量不到就**整个参数不带**，
// 页面上那一行也就不显示 —— 不写「未知」去占位，那会让人以为量过了。
export function labelPageUrlFor({
  shop, port = null, state = null, ok = null, member = null, actual = null, pagePath = LABEL_PAGE_PATH,
} = {}) {
  const name = String(shop ?? '').trim();
  if (!name) throw new Error('labelPageUrlFor 需要一个店名');
  const query = new URLSearchParams({ shop: name });
  if (port !== null && port !== undefined && port !== '') query.set('port', String(port));
  const memberText = String(member ?? '').trim();
  if (memberText) query.set('member', memberText);
  // 实际登录的会员名（**读页面得来**，不是登记表里的期望值）。与 `member` 同一口径：量到才带。
  // 刻意**不给 `--actual` 这样的手工入口**：这一格的全部价值在于它是**机器读出来的**，
  // 允许人手填就等于把「机器说的」与「人说的」混进同一格 —— 那正是这个功能要治的病。
  const actualText = String(actual ?? '').trim();
  if (actualText) query.set('actual', actualText);
  const text = String(state ?? '').trim();
  if (text) {
    query.set('state', text);
    if (ok === true) query.set('ok', '1');
  }
  // file:// + 绝对路径。Windows 盘符必须转成 /D:/… 形式，否则 URL 会被解析成 host。
  const path = String(pagePath).replace(/\\/gu, '/');
  return `file:///${path.replace(/^\/+/u, '')}?${query.toString()}`;
}

// 这个窗口里出现的页签是什么性质。分类是为了回答用户那句「我看到每个浏览器里面有多个界面」——
// 让人知道哪些是链路要用的、哪些只是过程产物，而不是自己去猜。
export const TAB_KINDS = Object.freeze({
  work: Object.freeze({ label: '工作页（链路要用）', needed: true }),
  label: Object.freeze({ label: '窗口标签页（写着这是哪家店）', needed: true }),
  qianniu: Object.freeze({ label: '千牛工作台（预留槽位，日报链不读）', needed: false }),
  loginPage: Object.freeze({ label: '淘宝登录页（登录过程留下的）', needed: false }),
  blank: Object.freeze({ label: '空白页（残留）', needed: false }),
  browserPage: Object.freeze({ label: '浏览器自带页面或本地文件（与这条链无关）', needed: false }),
  other: Object.freeze({ label: '其它页面（残留）', needed: false }),
});

// 一个**工作页**的 URL 是否其实落在了登录页。
//
// 为什么需要这一条（2026-09-18 深夜，用户原话「也没有登录」）：生意参谋与阿里妈妈未登录时
// 不会报错，而是**把你重定向到自己的登录页**，URL 长这样：
//   https://sycm.taobao.com/custom/login.htm?_target=http://sycm.taobao.com/qos/...
//   https://one.alimama.com/index.html#!/login/index
// 这两种 URL 里都带 `sycm.taobao.com` / `one.alimama.com` ⇒ 按主机分类必然是 `work`，
// 于是窗口报告里把它显示成「工作页（链路要用）」—— **人眼完全看不出这家店没登录**。
// 这正是用户遇到的困境：他能看到有好几个界面，但看不出哪家要登录。
//
// 口径（重要）：这里只做**标注**，不改 `kind`。原因是不改就不会动清理行为 ——
// 若把它们改成 `loginPage`，分组键会退化成 kind 本身，`sycm` 与 `alimama` 的两个登录页
// 会被合成一组、只留一个 ⇒ 窗口少一个后台页面，而 SOP 的判据是「每个后台**恰好一个**」，
// 少一个同样会让整家店停在第一步。标注是加法，改 kind 是改写既有判据。
export const LOGIN_PAGE_PATTERNS = Object.freeze([
  /\/custom\/login\.htm/iu,
  /\/login\.htm/iu,
  /#!?\/login/iu,
]);

export function looksLikeLoginPage(url) {
  const value = String(url ?? '');
  return LOGIN_PAGE_PATTERNS.some((pattern) => pattern.test(value));
}

export function tabKindOf(url) {
  const value = String(url ?? '');
  if (value.includes(LABEL_PAGE_NAME) || value.includes('_window-label')) return 'label';
  if (value.includes('sycm.taobao.com') || value.includes('one.alimama.com')) return 'work';
  if (value.includes('login.taobao.com') || value.includes('havanalogin.taobao.com')) return 'loginPage';
  if (value.includes('myseller.taobao.com') || value.includes('qianniu.taobao.com')) return 'qianniu';
  if (/^about:(blank|newtab)/u.test(value)) return 'blank';
  // 浏览器自带的页面（`edge://nurturing/` 这类引导页会在新建标签页时被 Edge 顺带打开）。
  // 单列一类而不是塞进 other，是为了报告里能说清它是什么 —— 「其它页面」等于没说。
  if (/^[a-z-]+:\/\//u.test(value) && !/^https?:\/\//u.test(value)) return 'browserPage';
  return 'other';
}

function hostOf(url) {
  const match = String(url ?? '').match(/^[a-z]+:\/\/([^/?#]+)/iu);
  return match ? match[1] : String(url ?? '');
}

// 把一个窗口的页签清单分成「链路要用的」与「残留」。
// 只报告、不决定要不要关：千牛是 SOP 里的预留槽位，登录页是登录过程留下的，
// 一律当垃圾关掉会误伤 —— 判据说清性质，处置留给 `--prune`（默认不开）。
export function classifyShopTabs(targets = []) {
  const pages = targets.filter((t) => (t?.type ?? 'page') === 'page');
  return pages.map((t) => {
    const url = String(t?.url ?? '');
    const kind = tabKindOf(url);
    return {
      targetId: t?.targetId ?? t?.id ?? null,
      url,
      kind,
      label: TAB_KINDS[kind].label,
      needed: TAB_KINDS[kind].needed,
      // 只对工作页有意义：这一页虽然是那个后台的地址，但现在停在登录页。
      loggedOut: kind === 'work' && looksLikeLoginPage(url),
    };
  });
}

// 报告里的一行。`loggedOut` 的提示必须落在**人看的那一行**上 ——
// 只是把字段挂在对象里、不显示出来，等于还是没人知道这家店没登录。
export function describeTab(tab) {
  const base = `${tab.label}  ${tab.url}`;
  if (tab?.loggedOut !== true) return base;
  return `${base}   ← 这一页现在停在登录页，说明这家店还没登录`;
}

/**
 * 从页签清单里读「这家店要不要人登录」。
 *
 * 只在**有正面证据**（确实看到一个停在登录页的后台页面）时才给值；
 * 没有任何证据时返回 `null` —— 页面上那一行状态就整个不显示。
 *
 * **绝不因为「没看到登录页」就写「已登录」**：URL 不是登录页只说明这一页不是登录页，
 * 不代表会话有效（会话可能在点下去的那一刻才过期）。把「尚未触发」写成「不需要」
 * 是这个项目里犯过两次的同类错误，这里不重犯。
 */
export function loginStateHint(classified = []) {
  const lost = classified.filter((t) => t.kind === 'work' && t.loggedOut === true);
  if (lost.length === 0) return null;
  return { state: '需要登录', ok: false, sites: [...new Set(lost.map((t) => hostOf(t.url)))] };
}

export function leftoverTabs(classified = []) {
  return classified.filter((t) => t.needed !== true);
}

export function isLabelTab(url) {
  const value = String(url ?? '');
  return value.includes(LABEL_PAGE_NAME) || value.includes('_window-label');
}

// ---------------------------------------------------------------------------
// 清理计划（纯函数）：哪些页签可以关、为什么、留哪个
// ---------------------------------------------------------------------------
//
// 为什么必须显式开关、且默认不开：关页签是**中断性动作**（本项目的纪律：未经许可不动任何进程/窗口，
// 见 SOUL.md 与 USER.md）。所以 `--prune` 默认关，且规则写成一张可离线测的策略表，而不是一串 if。
//
// 为什么"重复的工作页"也要清（不是可选项）：链的判据是"这个后台**恰好一个**页面"
// （`expected one <site> page, got N`）。同一个后台出现两个页面时，**判据直接失败**，
// 整家店停在这一步 —— 所以重复的工作页不是"看着乱"，是真的会拦人。
export const PRUNE_POLICY = Object.freeze({
  work: Object.freeze({ keepFirst: true, why: '同一个后台只留一个：多一个会让「恰好一个」的判据失败' }),
  label: Object.freeze({ keepFirst: true, why: '只留一个：堆了多个说明上一轮挂标签页时没按幂等走' }),
  qianniu: Object.freeze({ keepFirst: true, why: '只留一个：日报链不读千牛，它只是 SOP 里的预留槽位' }),
  loginPage: Object.freeze({ keepFirst: true, why: '只留一个：登录过程留下的，留一个以防人正准备登录' }),
  blank: Object.freeze({ keepFirst: false, why: '空白页，没有用途' }),
  browserPage: Object.freeze({
    unclosable: true,
    why: '浏览器自带页面：实测 /close 对它返回 success 但页面不消失，列进关闭计划只会报一个假动作（报告说关了、事实没变）',
  }),
  other: Object.freeze({ keepFirst: false, why: '与这条链无关的页面' }),
});

// 分组键：`work` 按**主机**分组（生意参谋与阿里妈妈是两个后台，各留一个；
// 同一个后台出现两个才是重复）。
function groupKeyOf(tab) {
  if (tab.kind !== 'work') return tab.kind;
  const value = String(tab.url ?? '');
  const match = value.match(/^[a-z]+:\/\/([^/?#]+)/iu);
  return `work:${match ? match[1] : value}`;
}

/**
 * 算出「关哪些、留哪些」。
 *
 * 安全阀（任何一条不成立就整体不关，不做部分执行）：
 *   1. `unclosable` 的类**一律不关**（实测关不掉，列进去只会报假动作）；
 *   2. 每个 kind 里**第一个**永不被关（`keepFirst`），所以清理永远不会把某一类清成零；
 *   3. `work` 与 `label` 永不因「重复」被清空 —— 同 2；
 *   4. 计划为空时返回空计划，不产生「看起来做了什么」的动作。
 */
export function prunePlan(classified = []) {
  const seen = new Map();
  const keep = [];
  const close = [];
  for (const tab of classified) {
    const policy = PRUNE_POLICY[tab.kind] ?? PRUNE_POLICY.other;
    // 关不掉的东西不进关闭计划：否则每轮都报「关掉 1 个」而事实没变。
    // 「报告说做了、事实没变」比不做更坏 —— 它会让人以为这里已经被清理过了。
    if (policy.unclosable) { keep.push({ ...tab, unclosable: true }); continue; }
    const key = groupKeyOf(tab);
    const already = seen.get(key) ?? 0;
    seen.set(key, already + 1);
    // 只有「这一类保留第一个」且它确实是第一个时才留；其余一律进关闭计划。
    // 注意方向：`keepFirst: false`（空白页/无关页）是**永远关**，不是「永远留」——
    // 这里写反过一次（写成 `!policy.keepFirst || already === 0` ⇒ 空白页全被留下），
    // 是判据抓出来的。
    if (policy.keepFirst && already === 0) { keep.push(tab); continue; }
    close.push({ ...tab, reason: policy.why });
  }
  return { keep, close };
}

// ---------------------------------------------------------------------------
// IO：以下都打各店自己的代理（不直连调试端口）
// ---------------------------------------------------------------------------

async function readTargets(proxyUrl, fetchImpl) {
  const response = await fetchImpl(`${proxyUrl}/targets`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`GET /targets → HTTP ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload) ? payload : (payload?.targets ?? []);
}

/**
 * 读「这个窗口**现在实际登的是谁**」—— 阿里妈妈页头的登录会员名。
 *
 * 为什么读的是阿里妈妈那一页：运营同事手里那串账号就是**阿里妈妈会员名**
 * （`随心品质定制:阿彦` / `j873522735:阿彦`），窗口上写的也是它，拿它比对才是同一种东西。
 * 生意参谋页头写的是**店铺名**（`盖文全卫定制`），它与会员名**本来就可以不同名**
 * （实测：盖文淘宝这两个名字毫无关系）—— 把两者并进同一行，会让「不一致」这句话变得有歧义
 * （是串号了？还是只是两套名字？）。所以这一轮只做会员名；另一个独立见证**刻意留到下一步**，
 * 不是漏了（见 `.workbuddy/memory/` 当日实录）。
 *
 * 三条口径：
 *   1) 表达式**不在这里另写一份** —— 用采集链唯一那份（`alimamaIdentityExpression`）；
 *   2) 读不到**不抛错**，返回 `{ memberName: null, reason }`：登录前本来就读不到
 *      （这一页会被重定向到登录页），那不是故障。与 `pinLabelTab` 同一处理 ——
 *      如实回报，既不假装读到、也不让「挂标签页」整件事因为这一步失败；
 *   3) 代理回的是 `{ value: '<表达式自己 stringify 的那层 JSON>' }` ⇒ **要解两层**
 *      （`cdp-proxy.mjs` 的 `/eval` 把 `Runtime.evaluate` 的返回值原样放进 `value`，
 *      而表达式返回的是一个 JSON 字符串）。解不出来就如实说「读到的不是预期的 JSON」。
 */
export async function readLoggedInMemberOn({
  proxyUrl, targets = null, fetchImpl = fetch, timeoutMs = 15000,
} = {}) {
  const list = targets ?? await readTargets(proxyUrl, fetchImpl);
  // 按主机找那一页，不看页签顺序：顺序会随人手动点动而变，主机不会。
  const page = list.find((t) => String(t?.url ?? '').includes('one.alimama.com'));
  const targetId = page?.targetId ?? page?.id ?? null;
  if (!targetId) {
    return { memberName: null, targetId: null, reason: '这个窗口里没有阿里妈妈页签（还停在登录页时就是这样）' };
  }
  let raw;
  try {
    const response = await fetchImpl(`${proxyUrl}/eval?target=${encodeURIComponent(targetId)}`, {
      method: 'POST', body: alimamaIdentityExpression(), signal: AbortSignal.timeout(timeoutMs),
    });
    raw = await response.text();
    if (!response.ok) {
      return { memberName: null, targetId, reason: `代理 /eval 回 HTTP ${response.status}：${String(raw).slice(0, 160)}` };
    }
  } catch (error) {
    return {
      memberName: null,
      targetId,
      reason: `/eval 没打通：${String(error?.message ?? error).slice(0, 140)}`,
    };
  }
  let reading;
  try {
    reading = JSON.parse(JSON.parse(raw).value);
  } catch {
    return { memberName: null, targetId, reason: `读到的不是预期的 JSON：${String(raw).slice(0, 160)}` };
  }
  const memberName = normalizeShopName(reading?.memberName) || null;
  return {
    memberName,
    memberId: reading?.memberId ?? null,
    href: reading?.href ?? null,
    targetId,
    // 读到了就没原因；读不到要把「为什么」带上 —— 否则「没读到」与「页面还没登录」分不开。
    reason: memberName ? null : '页面上没有「会员名 + ID」那一段（多半还停在登录页）',
  };
}

/**
 * 把店名标签页**钉住**。
 *
 * 为什么必须有这一步（2026-09-19 实测出来的，不是设想）：
 * 代理 (`runtime/isolated-proxy/cdp-proxy.mjs`) 有一张 managedTabs 表，
 * `/new` 建的所有页都在里面，**空闲 15 分钟（CDP_TAB_IDLE_TIMEOUT）就被自动关掉**，
 * 代理退出时还会再关一轮。店名标签页也是 `/new` 建的 ⇒ 一样会被收走。
 * 症状就是本项目反复见到的「页面自己消失了」：客户打开窗口，标签页没了，
 * 四个窗口又长得一模一样 —— 而「让人知道哪个窗口是哪家店」恰恰是它存在的唯一理由。
 * 代理那边加了 `pinned` 语义（闲置不回收、退出也不关），这里负责把标记打上。
 *
 * 钉不住**不抛错**：那只是退回「会过期」的旧行为，不该让挂标签页这件事整个失败；
 * 但要把结果如实返回，让调用方看得见（假绿灯比红灯危害大）。
 */
export async function pinLabelTab(proxyUrl, targetId, fetchImpl = fetch) {
  if (!targetId) return { pinned: false, reason: '没有 targetId' };
  try {
    const response = await fetchImpl(`${proxyUrl}/pin?target=${encodeURIComponent(targetId)}`,
      { method: 'POST', signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      return { pinned: false, reason: `代理回 HTTP ${response.status}（旧版代理没有 /pin？那就先重启代理）` };
    }
    const payload = JSON.parse(await response.text());
    return { pinned: payload?.pinned === true, reason: null };
  } catch (error) {
    return { pinned: false, reason: String(error?.message ?? error).slice(0, 140) };
  }
}

/**
 * 让这家店的窗口里恰好有一个窗口标签页，且它写的是这家店、（可选）当前登录状态、
 * 以及（可选）**实际登录的会员名**。`actual` 由调用方用 `readLoggedInMemberOn` 读好再传进来 ——
 * 本函数只管「把它写到页面上」，不在写路径里顺手读页面（读与写分开，各自可离线测）。
 *
 * 幂等：已存在就导航它（不会越堆越多）；不存在时**优先接管一个空白页**（见函数里那段注释），
 * 连空白页都没有才新建。
 * **只动标签页，外加至多一个空白页**：链路要用的工作页、千牛、登录页一概不碰，其余残留页签只报告。
 */
export async function ensureLabelTabOn({
  proxyUrl,
  shop,
  port = null,
  state = null,
  ok = null,
  member = null,
  actual = null,
  fetchImpl = fetch,
} = {}) {
  const targets = await readTargets(proxyUrl, fetchImpl);
  const classified = classifyShopTabs(targets);
  const labels = classified.filter((t) => t.kind === 'label');
  const url = labelPageUrlFor({ shop, port, state, ok, member, actual });

  if (labels.length > 1) {
    // 堆了多个标签页时按纪律停手：navigate 哪个都不对，关掉哪个都是替人做决定。
    return { ok: false, shop, classified, error: `这个窗口里堆了 ${labels.length} 个标签页，先去关到只剩一个` };
  }
  if (labels.length === 1) {
    await fetchImpl(`${proxyUrl}/navigate?target=${encodeURIComponent(labels[0].targetId)}&url=${encodeURIComponent(url)}`,
      { method: 'POST', signal: AbortSignal.timeout(15000) });
    // 复用**也要钉一次**：这个标签页可能是「还没有 pinned 语义的那版」挂的，
    // 不钉的话它照样会在 15 分钟后被收走 —— 而那种失效要等一刻钟才显形。
    const pinned = await pinLabelTab(proxyUrl, labels[0].targetId, fetchImpl);
    // `adoptedBlank: false` 与另外两条路保持同一组字段：三种来源（复用 / 接管空白页 / 新建）
    // 各自可判，而不是靠「某个键不存在」去反推 —— 靠缺键反推的判据，等加了字段就会静默失效。
    return {
      ok: true, shop, reused: true, adoptedBlank: false,
      targetId: labels[0].targetId, url, classified, pinned,
    };
  }
  // 没有标签页时：**先找一个空白页接管**，实在没有才新建。
  //
  // 为什么（2026-09-23 用户原话「相当于替换原本的空白页，不要空白页了」）：
  // 新建会让页签总数 +1，于是窗口里从此永远躺着那个 `about:blank` —— 它是链路用完没关的残留，
  // 而 `prunePlan` 对它的策略本来就是「永远关」。把那个空白页**导航**成标签页，
  // 一步同时做到「多了个店名」与「少了个空白页」：页签条数不变，位置也不变（不会突然跳到最后）。
  // 只有在完全没有可接管对象时才新建 —— 新建是能力，不是首选。
  //
  // 前提（这条假设成立，因为链路的中间态页都带 URL）：稳态下窗口里剩下的 `about:blank`
  // 都是上一轮留下的残渣；链路正在跑的时候，它用的是 sycm / alimama 那两个工作页。
  // 所以取「第一个空白页」不会抢走链路要用的东西。
  const blanks = classified.filter((t) => t.kind === 'blank' && t.targetId);
  if (blanks.length > 0) {
    const adopted = blanks[0];
    await fetchImpl(`${proxyUrl}/navigate?target=${encodeURIComponent(adopted.targetId)}&url=${encodeURIComponent(url)}`,
      { method: 'POST', signal: AbortSignal.timeout(15000) });
    // 接管**也要钉一次**：它的 targetId 是当初 `/new` 建出来的，同样躺在代理的 managedTabs 里，
    // 不钉的话照样会在 15 分钟后被收走 —— 而那种失效要等一刻钟才显形。
    const pinned = await pinLabelTab(proxyUrl, adopted.targetId, fetchImpl);
    // 其余空白页**不在这里关**：本函数只接管一个。「替人关掉别的页」是另一个决定，
    // 交给 `--prune` 做（它的策略表里 blank 是「永远关」，开着 prune 时它们会被一并清掉）。
    return {
      ok: true, shop, reused: false, adoptedBlank: true,
      targetId: adopted.targetId, url, classified, pinned, extraBlanks: blanks.length - 1,
    };
  }

  const created = JSON.parse(await fetchImpl(
    `${proxyUrl}/new?url=${encodeURIComponent(url)}&label=window-label&pinned=1`,
    { method: 'POST', signal: AbortSignal.timeout(15000) },
  ).then((r) => r.text()));
  const targetId = created?.targetId ?? null;
  // 新建分支也显式钉一次：`pinned=1` 只对认这个参数的代理有效，
  // 旧版代理会把它当无关参数忽略掉 —— 那一步的失败要看得见，而不是让人以为钉住了。
  const pinned = await pinLabelTab(proxyUrl, targetId, fetchImpl);
  return { ok: true, shop, reused: false, adoptedBlank: false, targetId, url, classified, pinned };
}

/**
 * 按 `prunePlan` 关掉多余的页签。
 *
 * 四个必须交代的点：
 *   - **关的是这个窗口里我们自己的页签**，关不掉的如实记进 `failed`，不重试、不假装成功；
 *   - `dryRun` 是默认口径：只回报计划，不关任何东西；
 *   - **不信 `/close` 的返回码，关完回读一遍**（2026-09-18 深夜实测）：
 *     `edge://nurturing/` 那个页签，`/close` 返回 `{"success":true}`，但 3 秒后回读**同一个 targetId 仍在**。
 *     如果只信返回码，清理报告就会写「关掉了」而事实没变 —— 这正是本项目最贵的坑
 *     （「每步都成功 ≠ 结果对」）。所以 `closed` 只收**回读确认消失**的，仍在的一律进 `failed`。
 *   - **回读也不能只读一遍**（2026-09-20 实测，这条是上面那条的镜像）：真机上 `about:blank`
 *     从 `/close` 到从 `/targets` 里消失要 **270ms**（探针 `measure-close-latency.mjs`，
 *     采样：8ms 还在 → 270ms 已消失）。而回读原先紧接着 `/close` 就做 ⇒ 把**成功的关闭**
 *     报成失败，报告写「关完回读它还在」而其实已经关掉了。**这与「只信返回码」是两个相反的
 *     坑，合起来才是完整口径：返回码不可信，回读要等一拍**。
 *     等待预算按实测取：3 次读 × 600ms（覆盖 270ms 有余，又不至于让「真关不掉」的用例空等太久）。
 */
export async function pruneTabsOn({
  proxyUrl, dryRun = true, fetchImpl = fetch,
  readAttempts = 3, readIntervalMs = 600,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
} = {}) {
  const targets = await readTargets(proxyUrl, fetchImpl);
  const classified = classifyShopTabs(targets);
  const plan = prunePlan(classified);
  if (dryRun || plan.close.length === 0) {
    return { ok: true, dryRun, plan, closed: [], attempted: [], failed: [], reads: 0, classified };
  }
  const attempted = [];
  for (const tab of plan.close) {
    try {
      await fetchImpl(`${proxyUrl}/close?target=${encodeURIComponent(tab.targetId)}`,
        { method: 'POST', signal: AbortSignal.timeout(15000) });
      attempted.push(tab);
    } catch (error) {
      attempted.push({ ...tab, thrown: String(error?.message ?? error).slice(0, 160) });
    }
  }
  // 回读校验：HTTP 200 不等于关掉了；但**读一遍也不等于关不掉**（见上面那一段）。
  // 读满 readAttempts 次，只要中途全部消失就收手（不等满预算）。
  let stillThere = new Set();
  let reads = 0;
  for (let attempt = 0; attempt < readAttempts; attempt += 1) {
    if (attempt > 0) await sleep(readIntervalMs);
    const after = await readTargets(proxyUrl, fetchImpl);
    reads += 1;
    stillThere = new Set(after.map((t) => t.targetId ?? t.id));
    if (attempted.every((t) => !stillThere.has(t.targetId))) break;
  }
  const closed = attempted.filter((t) => !stillThere.has(t.targetId) && !t.thrown);
  const failed = attempted
    .filter((t) => t.thrown || stillThere.has(t.targetId))
    .map((t) => ({ ...t, error: t.thrown ?? `关完回读 ${reads} 次它还在：/close 返回成功但页面没有真的关掉` }));
  return { ok: failed.length === 0, dryRun: false, plan, closed, attempted, failed, reads, classified };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
//
// 用法：
//   node runtime/shop-window-label.mjs                       # 只报告，不动浏览器
//   node runtime/shop-window-label.mjs --commit              # 给每家店挂/更新标签页（幂等）
//   node runtime/shop-window-label.mjs --commit --only 盖文淘宝
//   node runtime/shop-window-label.mjs --commit --front      # 顺便把标签页置前（窗口标题=店名，一眼可辨）
//   node runtime/shop-window-label.mjs --commit --state "需要登录" --ok 0
//   node runtime/shop-window-label.mjs --prune               # 只报告「哪些多余页签会被关」
//   node runtime/shop-window-label.mjs --prune --commit      # 只关多余页签（**默认不开，必须显式给**）
//   node runtime/shop-window-label.mjs --label --prune --commit   # 两件一起做
//
// 标签页上现在有四类信息，全部**量到才显示**（量不到整行不出现，不写占位）：
//   店名（大标题，同时进 window.title）/ 登记表里的会员名 / **实际登录的会员名** / 登录状态。
// 「实际登录的会员名」是 2026-09-22 加的：它与登记表不符就是**串号的现场证据** ——
// 那一行在窗口上标红即等于「这台登错店了」。两种模式都会读它（只读报告也会报一次）；
// 只有 `--prune`（清页签）不读 —— 清页签与「登的是谁」无关，读了是白花时间。
//
// `--prune` 是**独占意图**：带上它就只清页签；挂标签页要么不带 `--prune`，要么显式加 `--label`。
// 一个开关管两件事的写法在这里踩过（见 parseCli 注释）：两步被并成一步，中间那次对照就作废了。
//
// 不带 `--commit` 时是**只读报告**：它同时回答用户那句「我看到每个浏览器里面有多个界面」——
// 每个页签是什么性质、哪些是链路要用的、哪些是残留、**哪一家还停在登录页**、
// **哪一台实际登的是谁**，都列出来，不用人去猜。

export function parseCli(argv) {
  const opts = {
    commit: false, prune: false, label: null, front: false,
    only: null, state: null, ok: null, member: null, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--commit') { opts.commit = true; continue; }
    // `--prune` 必须显式给：关页签是中断性动作。**没有「顺手清一下」这个默认。**
    if (token === '--prune') { opts.prune = true; continue; }
    if (token === '--label') { opts.label = true; continue; }
    if (token === '--front') { opts.front = true; continue; }
    if (token === '--help' || token === '-h') { opts.help = true; continue; }
    const flags = ['--only', '--state', '--ok', '--member'];
    if (!flags.includes(token)) throw new Error(`Unknown argument: ${token}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    if (token === '--only') opts.only = value;
    if (token === '--state') opts.state = value;
    if (token === '--member') opts.member = value;
    if (token === '--ok') opts.ok = value === '1' || value === 'true';
    i += 1;
  }
  // `--prune` 是**独占意图**：带上它就只清页签，不带 `--prune` 才是挂标签页。
  //
  // 为什么必须这样（2026-09-18 深夜踩到）：原先 `--commit` 是全局开关，`--prune --commit`
  // 会**既清页签又挂标签页** —— 我原计划「先清、量内存、再挂」的两步被并成一步，
  // 中间那次内存对照里混进了 2 个新建标签页，收益数字直接作废。
  // 一个开关管两件事，就无法把它们分开下达；分开之后，「先做 A 再做 B」才是可表达的。
  // 要两件一起做：显式写 `--label --prune --commit`。
  if (opts.label === null) opts.label = !opts.prune;
  if (opts.only !== null && !shopBrowserKeys().includes(opts.only)) {
    throw new Error(`Unknown --only ${opts.only} (known: ${shopBrowserKeys().join(' / ')})`);
  }
  return opts;
}

// 判定词（只用于 CLI 报告这一侧）。页面上那一份措辞是 HTML 里手写的 ——
// file:// 页面没法 import 仓库模块，所以这两处**只能是两份文字**。
// 能共享的是**判定本身**（`memberVerdictFor` 的四种结果）；措辞不一致只是不好看，
// 判定不一致才是错的，所以这里只管把 `memberVerdictFor` 的结果翻成人话，不自己再判一次。
const MEMBER_VERDICT_TEXT = Object.freeze({
  match: '与登记表一致',
  mismatch: '与登记表不一致 —— 这就是登错了店（窗口上这一行会标红）',
  unregistered: '登记表里没有这家的期望值（未实测）：只报实际值，不下判定',
});

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    console.log('node runtime/shop-window-label.mjs [--commit] [--front] [--only 店名] [--state 文本] [--ok 1|0]');
    console.log('  （不带 --prune 时：挂/更新标签页；带 --prune 时只清页签，两者都要写 --label --prune）');
    return;
  }
  const shops = opts.only ? [opts.only] : shopBrowserKeys();
  const report = { commit: opts.commit, prune: opts.prune, label: opts.label, shops: {} };
  let failed = 0;

  for (const shop of shops) {
    const entry = SHOP_BROWSERS[shop];
    const proxyUrl = `http://127.0.0.1:${entry.proxyPort}`;
    try {
      const targets = await readTargets(proxyUrl, fetch);
      const classified = classifyShopTabs(targets);
      const labels = classified.filter((t) => t.kind === 'label');
      const hint = loginStateHint(classified);
      const row = {
        browserPort: entry.browserPort,
        proxyPort: entry.proxyPort,
        windowTitle: windowTitleFor(shop),
        // 核对用：这一行把「窗口标题上的运营叫法」与「运营同事手里那个会员名」摆在一起。
        // 只读报告就有，不需要 `--commit` —— 因为「哪一组账号是哪一家」是随时会问的问题。
        memberName: memberNameFor(shop),
        labelTabs: labels.length,
        tabs: classified.map(describeTab),
        leftover: leftoverTabs(classified).map(describeTab),
      };
      // 登录提示只挂在这一行上。它不改任何行为，只回答用户那句「也没有登录」。
      if (hint) row.loginHint = `这家店还没登录：看到登录页的是 ${hint.sites.join('、')}`;

      // 顺序说明：清理排在「挂标签页」**之前**（2026-09-18 拆开关时就定下的结构，见上面 parseCli 那段）。
      // 所以在 `--label --prune --commit` 这种组合下，空白页会**先**被关掉，
      // 于是 ensureLabelTabOn 里「接管空白页」那条路走不到 —— 结果仍然对（窗口里没有空白页、
      // 有一个标签页），只是那个标签页是**新建**的、排在页签条最后，而不是原地接管的。
      // 要它**原地**接管（页签位置也不变），分两步下达：先 `--commit --front`，再 `--prune --commit`。
      if (opts.prune) {
        const plan = prunePlan(classified);
        row.prunePlan = plan.close.map((t) => `${describeTab(t)}  ← ${t.reason}`);
        row.pruneKeeps = plan.keep.map((t) => (t.unclosable
          ? `${describeTab(t)}   ← 浏览器自带，脚本关不掉，忽略即可`
          : describeTab(t)));
        if (opts.commit) {
          const result = await pruneTabsOn({ proxyUrl, dryRun: false });
          row.pruneClosed = result.closed.map(describeTab);
          row.pruneFailed = result.failed;
          if (!result.ok) failed += 1;
        }
      }

      if (opts.commit && opts.label) {
        // 没显式给 `--state` 时用从页签 URL 读出来的登录态；读不到就整条不带。
        const explicit = opts.state !== null;
        const state = opts.state ?? hint?.state ?? null;
        const ok = opts.ok !== null ? opts.ok : (hint ? hint.ok : null);
        // 会员名从登记表读 —— 它存在的理由就是「让人把窗口和手里的账号对上」。
        const member = opts.member ?? memberNameFor(shop);
        // 实际登的是谁：**读页面**得来（读不到就是 null，页面上那一行整个不显示）。
        // 这里刻意不提供手工入口 —— 这一格的全部价值在于它是机器读出来的。
        const reading = await readLoggedInMemberOn({ proxyUrl, targets, fetchImpl: fetch });
        const actual = reading.memberName;
        const verdict = memberVerdictFor({ expected: member, actual });
        const result = await ensureLabelTabOn({
          proxyUrl, shop, port: entry.browserPort, state, ok, member, actual,
        });
        row.labelTab = result.ok
          ? {
            ok: true,
            reused: result.reused,
            // 标签页是**接管**来的还是新建的：接管意味着那个空白页被替换掉了（页签总数不变）。
            // 这一格必须能看见 —— 否则「窗口里的空白页怎么没了」就只能靠猜。
            ...(result.adoptedBlank === true ? { adoptedBlank: true } : {}),
            ...(result.extraBlanks > 0
              ? {
                extraBlanks: result.extraBlanks,
                hint: `窗口里还剩 ${result.extraBlanks} 个空白页，加 --prune 一并关掉`,
              }
              : {}),
            targetId: result.targetId,
            // 钉住的结果必须如实报出来：钉不住（例如代理还是旧版、没有 /pin）时，
            // 标签页会在 15 分钟后被代理收走 —— 那是**延迟出现**的失效，
            // 不写进输出就等于没有人会知道。
            pinned: result.pinned?.pinned === true,
            ...(result.pinned?.pinned === true ? {} : { pinReason: result.pinned?.reason ?? '未知' }),
          }
          : { ok: false, error: result.error };
        row.labelState = state === null
          ? '没读到登录状态 ⇒ 标签页上不显示状态行（不写占位）'
          : `${state}（来源：${explicit ? '--state 参数' : '从页签 URL 读出来'}）`;
        row.labelMember = member === null
          ? '登记表里没有这家店的会员名 ⇒ 标签页上不显示这一行'
          : member;
        row.labelActual = actual === null
          ? `没读到实际登录的会员名 ⇒ 标签页上不显示这一行（${reading.reason ?? '原因未知'}）`
          : `${actual}（${MEMBER_VERDICT_TEXT[verdict] ?? verdict}）`;
        if (!result.ok) failed += 1;
        if (result.ok && opts.front && result.targetId) {
          await fetch(`${proxyUrl}/bringToFront?target=${encodeURIComponent(result.targetId)}`, { method: 'POST' })
            .then((r) => r.text()).catch(() => null);
          row.fronted = true;
        }
      } else if (!opts.prune) {
        row.needsLabelTab = labels.length === 0;
        // 只读报告也读一次「实际登的是谁」：用户问的「哪台登的是谁」正是这一格，
        // 而 /eval 是只读的（表达式只读文本、不点任何控件）—— 报告模式不必因为它是 POST 就回避。
        const reading = await readLoggedInMemberOn({ proxyUrl, targets, fetchImpl: fetch });
        const verdict = memberVerdictFor({ expected: memberNameFor(shop), actual: reading.memberName });
        row.actualMember = reading.memberName === null
          ? `没读到（${reading.reason ?? '原因未知'}）`
          : `${reading.memberName}（${MEMBER_VERDICT_TEXT[verdict] ?? verdict}）`;
      }

      report.shops[shop] = row;
    } catch (error) {
      // 「没读到」不算失败：浏览器可能这轮没起。如实记下来，不编一个结论。
      report.shops[shop] = { ok: false, unreachable: true, error: String(error?.message ?? error).slice(0, 200) };
      failed += 1;
    }
  }

  report.failed = failed;
  console.log(JSON.stringify(report, null, 1));
  if (failed) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
