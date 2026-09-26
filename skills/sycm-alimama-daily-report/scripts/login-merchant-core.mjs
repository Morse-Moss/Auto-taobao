// 自动登录的纯逻辑（可离线测）：站点判据、参数解析、坐标选取、页面状态表达式。
// IO 全在 login-merchant.mjs 里 —— 这条分界与 collect-core.mjs 一致，理由也一样：
// 「测过的那份」和「真的在跑的那份」必须是同一份，而 IO 没法离线复现。

// 期望账号的唯一来源（身份守卫要用）。这份登记表本身是纯数据、无副作用，与「core 要可离线测」
// 不冲突 —— 同目录的 check-login-shops-core.mjs 早就这么 import 了。
import { shopIdentity } from './shop-identities.mjs';

// 登录入口候选表（2026-09-23 加）。**顺序即优先级，逐条打开试到浏览器肯填为止。**
//
// 2026-09-23 晚：这张表被**真机对照矩阵**校正过两次，下面是最终口径。
// 方法（可复现）：复制一份 profile 到临时目录 → 未登记端口起一次性实例 → 25ms 采样
// `#fm-login-id` / `#fm-login-password` 的 `value.length` 与 `:autofill`，
// 并挂钩 `HTMLInputElement.prototype.value` 的 setter 记录页面自己的写入。
// 全部原始输出在 `evidence/login-candidate-loop-2026-09-23/`。
//
// 实测矩阵（「填上了」＝采样里出现过账号+密码非空且 `:autofill=true`）。
// **数字全部来自 `evidence/login-candidate-loop-2026-09-23/raw/` 里留档的原始输出**
// （每一格都能指到具体文件，见该目录 `raw/INDEX.md`）：
//   `login.taobao.com/havanaone/login/login.htm?bizName=taobao`   里可林 ✓  网林 ✓  科塔 ✓                    → 3/3
//   `login.taobao.com/member/login.jhtml`                         里可林 ✓  商家   ✓  盖文天猫 ✗              → 2/3
//   `havanalogin.taobao.com/mini_login.htm?...`（带参数）          网林 ✗ 网林 ✗ 科塔 ✗ 商家 ✗ 商家 ✗        → 0/5（4 台机器）
//   对照组 `github.com/login`（同一个商家 profile）                ✓                                          → 1/1
//
// **这张表在 2026-09-23 晚被更正过一次**：原先 `member/login.jhtml` 那一行写的是
// 「商家 ✓ 里可林 ✓ 网林 ✗ 科塔 ✗ → 2/4」，但那两次「网林/科塔 + member」的运行**实际打开的是
// `havanalogin` 那条地址**（命令漏传 `--url`，标签与地址对不上）⇒ 那两个失败样本属于
// `havanalogin` 那一行、不属于这一行。原始输出里的「导航 → …」那一行是唯一的凭据，
// 所以判据/注释里引用数字时**必须回读它**，不能凭标签认。
//
// 四条硬事实（每一条都同时排除了一个曾被我写进注释的错误解释）：
//   ① **`havanalogin.taobao.com` 那条是死路，不是「还没试过的备选」。** 商家浏览器里明明有一条
//      `signon_realm=https://havanalogin.taobao.com/`、`times_used=11` 的凭据，开在它自己的
//      origin 上 `:autofill` 恒 false ⇒ 「同源就会填」在这条主机上**不成立**。故删除该候选。
//   ② **值只在一次真实点击（可信手势）之后才落下，不在页面加载时落下。** 所有成功样本的形状都是
//      「加载后 `:autofill=true`、值为空 → 真实点击 → 值出现」。所以主脚本的闸门必须保持
//      「`:autofill` 判定 + 补手势 + 回读」三步，不能只在加载后读一次。
//   ③ **Chromium 的填充本身是好的**，不能拿「这台机器的填充坏了」当解释：对照组用同一个 profile
//      打开 `github.com/login`，真实点击后 17/14 字符落地。
//   ④ **平台页面自己会清空输入框**：`x.alicdn.com/vip/havana-nlogin/0.10.37/index.js` 的
//      `clear()` 在导航后 ~150–650ms 往两个框各写一次空字符串（setter 挂钩抓到调用栈）。
//      它解释「为什么不能指望零点击填充留在页面上」，但**不是**「Chromium 不出手」的成因
//      （全程没出现过任何非空值 ⇒ 出手环节就没发生）。
//
// 顺序取舍：`havanaone` 排第一（实测 3/3 全中，且是历史上一直在用的入口，改动面最小）；
// `member/login.jhtml` 排第二 —— 实测 2/3，在两台机器上成功过，留着能覆盖「第一条改版」的情形；
// 但它**不能排第一**：它在盖文天猫那台上实测失败（`member/login.jhtml` 会跳到
// `havanaone/login/login.htm`，跳转链上的表单时序与直接打开第一条不同），
// 把它排第一等于让至少一台机器每次都先从一条已知会失败的路开始试、白付一次打开+点击。
//
// 注意：这张表**只解决「试哪几条」**。它不能凭空造出凭据 —— 某家店的 profile 如果在
// `https://login.taobao.com/` 这条 origin 上一条凭据都没有（2026-09-23 实测的盖文天猫就是），
// 那它在这两条地址上都会判 `NO_AUTOFILL`，只能靠人工去那台机器上登录一次并保存密码。
export const LOGIN_URL_CANDIDATES = Object.freeze([
  Object.freeze({
    id: 'havanaone',
    url: 'https://login.taobao.com/havanaone/login/login.htm?bizName=taobao',
  }),
  Object.freeze({
    id: 'member-login',
    url: 'https://login.taobao.com/member/login.jhtml',
  }),
]);

/**
 * 第一个候选 —— 保留这个名字是为了**不改动**既有调用方与既有判据的语义
 * （「脚本固定打开的那一页」）。新代码请不要用它来判断流程，用 `LOGIN_URL_CANDIDATES`：
 * 拿单个 URL 去描述一条会逐条试的流程，正是本仓反复踩过的「默认值即目标」。
 */
export const TAOBAO_LOGIN_URL = LOGIN_URL_CANDIDATES[0].url;

// 站点 → 判据。`loggedOut` 命中的是**实测到的**未登录 URL 形态，不是猜的选择器：
//   生意参谋：被踢回 `sycm.taobao.com/custom/login.htm?_target=…`
//   阿里妈妈：停在 `one.alimama.com/index.html#!/login/index`
export const SITES = Object.freeze({
  sycm: Object.freeze({
    label: '生意参谋',
    pageMatch: 'sycm.taobao.com',
    probeUrl: 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop',
    loggedOut: /\/custom\/login\.htm|\/member\/login|\/login\.htm/u,
  }),
  alimama: Object.freeze({
    label: '阿里妈妈',
    pageMatch: 'one.alimama.com',
    probeUrl: 'https://one.alimama.com/index.html',
    loggedOut: /login\/index|\/member\/login|\/login\.htm/u,
  }),
});

// 收据里的结论词表。集中定义是为了让测试能盯住「谁也不会拼错一个词而静默降级」。
export const VERDICTS = Object.freeze([
  'ALREADY_LOGGED_IN',    // 两个站点都在登录态，什么都没做
  'READY_TO_GESTURE',     // 检测到填充预览态，但没给 --commit（只读排练）
  'READY_TO_SUBMIT',      // 值已落地，没给 --commit
  'LOGGED_IN',            // 提交后两个站点都验到登录态
  'PARTIAL',              // 提交了，但站点里有没进去的
  'NO_SAVED_CREDENTIAL',  // 密码库里没有凭据，或补手势后值仍不落地 —— 不猜账密
  // 2026-09-23 加。**这是一个 fail-closed 闸门，不是诊断信息。**
  //
  // 为什么必须有它：Chromium 填充是「按 origin 匹配」，而**同一个 origin 下可以有多条凭据**
  // （实测：商家浏览器那个 profile 里 `login.taobao.com` 下有两条，分属**两家不同的店**）。
  // 那时浏览器**自己挑一条**，脚本控制不了。挑错了不会报任何错 —— 页面照开、导出照成、
  // 报表里的数字看起来都对，而**每一个数字都属于另一家店**，链上没有任何一步会发现。
  // ⇒ 「登录失败」是响亮的安全失败；「登成了别人」是静默的、更贵的那种。
  //
  // 判据：提交之前读一次 `#fm-login-id` 的值，与**这家店登记的会员名**逐字比对；
  // 不一致就停下、**绝不提交**。读的是账号（不是密码），且只在内存里比对、不落盘。
  'WRONG_ACCOUNT',
  'MAIN_SESSION_ONLY',    // 登录页把我们送走了（主站会话还有效）⇒ 目标站点要单独登一次
  'CAPTCHA_REQUIRED',     // 滑块/验证码显形 —— 按 SOP §10.2 停手交人
  'LOGIN_NOT_CONFIRMED',  // 提交后仍停在登录页 —— 如实报没成
  // 2026-09-23 加，**只在 `--check-only` 下产生**：有站点没在登录态，而这次运行
  // 明确不许碰页面 ⇒ 如实报「要去登一次」，然后把决定权交回给人。
  //
  // 为什么它必须有一个自己的词，而不是复用 NO_SAVED_CREDENTIAL：那一条的「下一步」
  // 断言「登录页已经开在这个窗口里了」（登录流程确实开了）—— 而 check-only **刻意**
  // 一个页面都没开。照抄那句话会让收信人去窗口里找一个根本不存在的登录页。
  // 一个分类词只在一处拼错，症状是「照着做找不到东西」，而现场不会报任何错。
  'NEEDS_LOGIN',
  // 2026-09-24 加。**只在「会去登」的那一档（`--commit`）产生**：窗口里**没有**该站点的页面
  // （`loggedIn === null`，即「读不到」），且这次运行没有任何站点是**实锤掉登录**（false）。
  //
  // 为什么必须有它（2026-09-24 真机）：那一档进登录流程之前不看「页面在不在」，
  // 于是冷启动（浏览器刚起、还没归位）时它会**去开登录页**，而主站会话还在 ⇒ 登录页被直接送走
  // ⇒ 报 `MAIN_SESSION_ONLY`（「主站会话还在，这两个后台要单独登一次」）⇒ 那一条在
  // `VERDICTS_NEEDING_HUMAN` 里 ⇒ 一次预检并发 5 条飞书告警，而**每一家其实什么都没坏**：
  // 页面还没归位而已，链的第 0 步会自己补上。
  //   一个「页签不在」的问题被改写成「登录问题」，再被叫成人去处理 —— 这是本仓库反复在治的
  //   那类假事实：**结论看起来确定，而下一步动作完全相反**（前者什么都不用做）。
  //
  // 与 `NEEDS_LOGIN` 的区别（两个都不许混）：
  //   · `NEEDS_LOGIN` 是 `--check-only` 档的「要留意」，它把两种现场都收在 detail 里；
  //   · 这一条是「**这一层没有结论**」——它不进 `VERDICTS_NEEDING_HUMAN`，退出码 3（不是 2），
  //     也不产生任何告警。判据是「读不到」，不是「掉登录」。
  'PAGES_ABSENT',
  'STOP_AND_ALERT',
]);

// 读登录表单的真实状态。判据一律取 DOM 值，不取视觉
//（2026-09-18 实测：截图里账号框已经画出「盖文旗舰店 阿彦」，但 el.value 是空串）。
export const FORM_STATE_EXPRESSION = `(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      valueLen: (el.value || '').length,
      autofill: el.matches(':autofill'),
      checked: !!el.checked,
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      visible: r.width > 0 && r.height > 0,
    };
  };
  const wrapper = document.querySelector('#nc_1_wrapper, .nc-container, .nc_scale');
  const wrapperRect = wrapper ? wrapper.getBoundingClientRect() : null;
  return JSON.stringify({
    href: location.href,
    id: pick('#fm-login-id'),
    password: pick('#fm-login-password'),
    checkcode: pick('#fm-login-checkcode'),
    agreement: pick('#fm-agreement-checkbox'),
    submit: pick('button.fm-submit'),
    sliderVisible: !!wrapperRect && wrapperRect.width > 0 && wrapperRect.height > 0,
    captchaInputVisible: (() => {
      const el = document.querySelector('#nc_1_captcha_input');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })(),
  });
})()`;

export const LOGIN_TARGETS = Object.freeze(['sycm', 'alimama', 'both']);

// 只读**账号框的值**（2026-09-23 加，身份守卫用）。
//
// 为什么必须单独一个表达式、而不是把 `value` 加进 FORM_STATE_EXPRESSION：
//   `FORM_STATE_EXPRESSION` 的结果会被抄进回执、还会被 `--shots` 那一路写进证据目录。
//   它刻意只给长度、不给值（见它自己头部那句 2026-09-18 的实测）——
//   往里加 `value` 就等于给**所有**回执与证据目录开了一条凭据外泄的口子。
//   所以这里**只读账号**、且**只在这一处**读：账号不是秘密，密码才是。
//   **这个表达式永远不许扩到 `#fm-login-password`。**
export const LOGIN_ID_VALUE_EXPRESSION = `(() => {
  const el = document.querySelector('#fm-login-id');
  return el ? String(el.value ?? '') : null;
})()`;

// 站点键 → 这家店**应该**被填进去的账号。
//
// 期望值只有一个来源：`shop-identities.mjs` 的 `alimamaMemberName`
// （实测过的那 5 家店，它恰好等于密码库里那条凭据的 `username_value` —— 2026-09-23 逐台核对过）。
// **不派生成 `${店名}:阿彦`**：实测已推翻这个假设（盖文淘宝那家的会员名是「随心品质定制:阿彦」，
// 与店名毫无关系），派生值一旦进判据就会变成「在正确的窗口上拦人」。
//
// 拿不到期望值（没给店名、或这家店没实测过会员名）时返回 `null` —— **不许回落成「随便」**：
// 调用方按「没有期望值 ⇒ 这条守卫没有依据」处理，并如实把这一点写进回执（见 login-merchant.mjs）。
export function expectedMemberFor({ shop = null } = {}) {
  if (!shop) return null;
  return shopIdentity(shop).alimamaMemberName ?? null;
}

// 「这一页填进来的账号，是不是这家店的」——**纯判据**，三个出口都对应一个明确的动作。
//
// 为什么不让调用方内联比较：这条判据决定了「提交 / 不提交」，而它是**静默的** ——
// 判错的后果是把这家店登成别家，链上不会报任何错。凡是这种判据都必须能离线钉住。
//
// 四个结果：
//   `ACCEPT`        —— 有期望值且逐字相同 ⇒ 可以往下走（补手势 → 提交）
//   `EMPTY`         —— 还没填上 ⇒ 交给上层：试下一个候选地址，或报 NO_SAVED_CREDENTIAL
//   `WRONG_ACCOUNT` —— 填了，但填的是别人 ⇒ **绝不提交**，试下一个候选地址；都不行就 fail-closed
//   `UNKNOWN`       —— 没有期望值可依 ⇒ 上层按「这条守卫没有依据」处理（不假装它过了）
export const FILLED_VERDICTS = Object.freeze(['ACCEPT', 'EMPTY', 'WRONG_ACCOUNT', 'UNKNOWN']);

export function judgeFilled({ filled = null, expected = null } = {}) {
  if (!expected) return 'UNKNOWN';
  const text = typeof filled === 'string' ? filled : '';
  if (text.length === 0) return 'EMPTY';
  // 逐字比对，不做大小写/空白归一：账号是可打印字符串，而「差不多」在这里就等于「登错家」。
  return text === expected ? 'ACCEPT' : 'WRONG_ACCOUNT';
}

// ---------------------------------------------------------------------------
// 「逐条试候选地址」这一步的结论与取舍（2026-09-23 加）
// ---------------------------------------------------------------------------

// 每一条候选地址试完之后，可能落在哪几种现场。**每一条都对应一个不同的下一步**，
// 所以不能合并成一个「登录没成」（合并的症状是：人收到一句「登录失败」，
// 而他要做的事在五种现场里完全不同）：
//
//   WRONG_ACCOUNT    填进来的是**别家店**的账号 ⇒ 绝不提交；人去用这一家的账号手工登一次
//   DETOUR           登录页把我们送走了（主站会话还有效）⇒ 人去把那两个后台各打开一次
//   NO_VALUE_LANDED  有填充预览、补了可信手势值仍不落地 ⇒ 人去登一次并点「保存密码」
//   NO_AUTOFILL      这一页有表单，但密码库里**这个 origin** 上没有凭据 ⇒ 同上
//   NO_FORM          这一页上没有可填的账号框 ⇒ 停手交人（不猜、不乱点）
//
// 数组顺序＝**报给人的优先级**（不是出现顺序）。取舍的两条理由：
//   1. `WRONG_ACCOUNT` 排第一 —— 它是唯一一条「做错了也不会报错」的（页面照开、导出照成、
//      数字看起来都对，而每一个数字都属于另一家店）。响亮的安全失败不如它贵。
//   2. `DETOUR` 排在两个 NO_* 前面 —— 它给出的下一步最省事（「去把那两个后台各打开一次」，
//      顺便也把「保存密码」带上了），而 NO_* 的下一步只是它的一半。
//      （2026-09-23 实测里这两条会被同时触发：主站会话还有效时第一条候选会绕走、
//       而第二条候选带 `notLoadSsoView=true`，照样能长出表单但填不上。）
export const ATTEMPT_OUTCOMES = Object.freeze([
  'WRONG_ACCOUNT', 'DETOUR', 'NO_VALUE_LANDED', 'NO_AUTOFILL', 'NO_FORM',
]);

// 现场 → 回执里的 verdict。两个 NO_* 合并成同一类（**下一步是同一件事**：
// 人去登一次并保存密码），但记录里保留区分 —— 它们是两个不同的现场，事后复盘要看得出是哪一种。
export const OUTCOME_TO_VERDICT = Object.freeze({
  WRONG_ACCOUNT: 'WRONG_ACCOUNT',
  DETOUR: 'MAIN_SESSION_ONLY',
  NO_VALUE_LANDED: 'NO_SAVED_CREDENTIAL',
  NO_AUTOFILL: 'NO_SAVED_CREDENTIAL',
  NO_FORM: 'STOP_AND_ALERT',
});

// 只有这两条结论的「下一步」会承诺**登录页已经开在窗口里**（见 ACTION_BY_VERDICT）。
// 它在这里单独存在，是因为**交付页要按它来选**：逐条试会把页签留在最后一条候选上，
// 而最后一条候选未必是那条结论产生的地方 —— 不把页导回去，那句承诺就是假的，
// 收信人跑过去发现没有登录页，下一次就不信这条提醒了。
// 「两条腿」由用例绑住：这张名单必须与 ACTION_BY_VERDICT 里真的以「登录页已经开在」开头的那批逐字一致。
export const LOGIN_PAGE_PROMISED_VERDICTS = Object.freeze(['NO_SAVED_CREDENTIAL', 'WRONG_ACCOUNT']);

/**
 * 候选全试完还没成时：报哪一条、把人送到哪一页。
 *
 * 为什么这也要进 core：这是一次**实打实的取舍**（五选一），而不是「循环结束了顺手报第一条」。
 * 取舍写错不会报错，只会把人引到错的动作上 —— 那正是这一节能被用例钉住的意义。
 *
 * 返回：
 *   verdict          回执里的结论
 *   outcome          取自 ATTEMPT_OUTCOMES，调用方据此挑 detail 文案
 *   stoppedAt        产生这条结论的**最后一次**尝试记录（告警承诺的登录页要落在它那一页上）
 *   parkOnLoginPage  交付前要不要把页签导回 stoppedAt 那一页（＝这条结论承诺了有登录页）
 */
export function finalLoginVerdict(attempts = []) {
  const list = Array.isArray(attempts) ? attempts : [];
  const seen = new Set(list.map((row) => row?.outcome));
  const outcome = ATTEMPT_OUTCOMES.find((word) => seen.has(word)) ?? null;
  if (!outcome) {
    // 一条记录都没有（或记录里没有已知现场）⇒ 这一层**没有结论**。
    // 回落成 STOP_AND_ALERT 让人来看，绝不猜一个「大概是什么」。
    return { verdict: 'STOP_AND_ALERT', outcome: null, stoppedAt: null, parkOnLoginPage: false };
  }
  const picked = [...list].reverse().find((row) => row?.outcome === outcome) ?? null;
  const verdict = OUTCOME_TO_VERDICT[outcome];
  return { verdict, outcome, stoppedAt: picked, parkOnLoginPage: LOGIN_PAGE_PROMISED_VERDICTS.includes(verdict) };
}

// ---------------------------------------------------------------------------
// 「这次到底在动哪一台浏览器」—— 店名与端口必须对得上（2026-09-23 加）
// ---------------------------------------------------------------------------
//
// 硬事实（2026-09-22 实测，见 .workbuddy/memory 与 docs）：`--proxy` 是**唯一的实例选择器**，
// 而 `--shop` 只影响回执与告警里的店名，**不切实例**。两者一旦对不上，
// 得到的是「我以为在给盖文淘宝登、实际动的是商家浏览器」：五份输出逐字相同，
// 从文字上看不出来 —— 2026-09-22 就是这么把那个共用浏览器登进了某个淘宝卖家号的。
//
// 所以判据是「给了店名，就必须落在那家店自己的代理端口上」。三种情形**刻意分成三个出口**，
// 因为它们的下一步不同（合成一句「参数不对」就没人知道该改什么）：
//   judged + ok           端口属于这家店 ⇒ 过
//   judged + !ok（other_shop）      端口属于**另一家**店 ⇒ 停手（两边都在指名道姓，且互相矛盾）
//   judged + !ok（not_a_shop_port） 端口不属于任何一家店 ⇒ 停手（给了店名却指着一台共用/未知的浏览器）
//   !judged               端口说不出来是哪台（非本机、或地址解析不了）⇒ **不下结论**
//
// 为什么 !judged 时放行而不是停手：端口 ⇒ 店铺 这张映射只在**本机**成立
// （另一台机器上的 19045 未必是盖文天猫）。拿一张本机的表去判一个远端地址，
// 得到的是假结论 —— 而假结论会去拦一个本来正确的调用。宁可这一层没有结论，
// 也不能从没有依据的地方推出一个有依据的样子（这是本项目反复钉过的一条）。
//
// 没给店名时不判：不带 `--shop` 的裸调用是 `--shop` 出现之前的老用法，行为必须不变
// （它没有「店名 vs 端口」可对），而且**它仍然要能跑通** —— 用户 2026-09-23 的原话
// 「可以自动登录把项目规则改了」针对的正是那条路径。
export function proxyPortOf(proxy) {
  const text = String(proxy ?? '').trim();
  if (!text) return null;
  let url = null;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(text) ? text : `http://${text}`);
  } catch {
    return null; // 解析不出主机就当「不知道是哪台」，**不猜**
  }
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return null;
  const port = Number(url.port);
  return Number.isInteger(port) && port > 0 ? port : null;
}

export function shopForProxy({ proxy = null, shops = null } = {}) {
  const port = proxyPortOf(proxy);
  if (port === null || !shops || typeof shops !== 'object') return null;
  const hit = Object.entries(shops).find(([, conf]) => conf?.proxyPort === port);
  return hit ? hit[0] : null;
}

export function judgeShopTarget({ shop = null, proxy = null, shops = null } = {}) {
  const port = proxyPortOf(proxy);
  if (!shop) return { ok: true, judged: false, shop: null, owner: null, port, reason: 'no_shop_given' };
  if (port === null) return { ok: true, judged: false, shop, owner: null, port: null, reason: 'port_unresolvable' };
  const owner = shopForProxy({ proxy, shops });
  if (owner === shop) return { ok: true, judged: true, shop, owner, port, reason: null };
  return { ok: false, judged: true, shop, owner, port, reason: owner ? 'other_shop' : 'not_a_shop_port' };
}


// 通知模式。默认 `auto` 的口径是「**真的试过了**并且没成，才叫人」：
//   - 不带 --commit 是只读排练，没试过 ⇒ 不叫人（排练撞到登录墙不该惊动人）；
//   - `send`/`dry` 是显式要求（跑演练、验证文案时用），仍只在「需要人」的结论上生效；
//   - `off` 完全闭嘴。
export const NOTIFY_MODES = Object.freeze(['auto', 'send', 'dry', 'off']);

export function parseArgs(argv, { defaultProxy, shops = null } = {}) {
  const opts = {
    target: 'both', commit: false, proxy: defaultProxy, shots: null, notify: 'auto', help: false,
    // 2026-09-23 加。`--check-only` ＝ **只回答「有没有登录态」，一个页面都不许碰**。
    //
    // 为什么要它：只要有一个站点不在登录态，主流程的下一步就是 `ensureLoginPage()`，
    // 而它会 `/new` 一个淘宝登录页。也就是说**不带 --check-only 时，「只读检测」在
    // 掉登录的现场恰恰会开一个页签**。体检要接进定时链、在没人看着的时候跑，
    // 一次体检顺手开个登录页是没人授权过的副作用 ⇒ 用一个显式开关把它切成纯读。
    //
    // 默认 false：不带这个开关时，行为与从前**逐字相同**（打开登录页仍是自动登录的第一步，
    // 告警里那句「登录页已经开在…了」依赖它）。
    checkOnly: false,
    // `--shop` 是**运营叫法**（＝登记表 SHOP_BROWSERS 的键，如「盖文淘宝」）。
    // 它唯一的用途是让告警**点名是哪一家店** —— 2026-09-18 用户原话：
    // 「我不知道是哪一个店铺的浏览器需要登录」。缺了它，五家店发出的告警逐字相同。
    shop: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--commit') { opts.commit = true; continue; }
    if (token === '--check-only') { opts.checkOnly = true; continue; }
    if (token === '--help' || token === '-h') { opts.help = true; continue; }
    const valueFlags = ['--target', '--proxy', '--shots', '--notify', '--shop'];
    if (!valueFlags.includes(token)) throw new Error(`Unknown argument: ${token}`);
    const value = argv[i + 1];
    // 先认名字再看值：否则 `--nope` 会被报成「需要一个值」，把「参数拼错」伪装成「忘了给值」。
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    if (token === '--target') opts.target = value;
    if (token === '--proxy') opts.proxy = value;
    if (token === '--shots') opts.shots = value;
    if (token === '--notify') opts.notify = value;
    if (token === '--shop') opts.shop = value;
    i += 1;
  }
  if (!LOGIN_TARGETS.includes(opts.target)) {
    throw new Error(`Unknown --target ${opts.target} (known: ${LOGIN_TARGETS.join(', ')})`);
  }
  if (!NOTIFY_MODES.includes(opts.notify)) {
    throw new Error(`Unknown --notify ${opts.notify} (known: ${NOTIFY_MODES.join(', ')})`);
  }
  // 店名拼错必须当场抛错并列出合法值：否则告警会带着一个**看起来像店名、实际不存在**的名字发出去，
  // 而收信人会拿着一个不存在的店名去浏览器里找窗口 —— 这比不写店名更坏。
  // 调用方传 `shops` 时才校验（离线用例可以不传，保持这条函数的既有用法不变）。
  if (opts.shop !== null && Array.isArray(shops) && !shops.includes(opts.shop)) {
    throw new Error(`Unknown --shop ${opts.shop} (known: ${shops.join(' / ')})`);
  }
  opts.sites = opts.target === 'both' ? ['sycm', 'alimama'] : [opts.target];
  return opts;
}

// 元素中心点。零尺寸矩形算出来的「中心」是 (0,0) —— 点了会落到页面左上角，
// 而这一页点错**不报错**（本项目反复出现的形态），所以这里 fail-closed 返回 null。
export function centerOf(state, field) {
  const box = state?.[field];
  if (!box || box.visible !== true) return null;
  const rect = box.rect;
  if (!Array.isArray(rect) || rect.length !== 4) return null;
  const [x, y, w, h] = rect;
  if (!(w > 0 && h > 0)) return null;
  if (!(x > 0 || y > 0)) return null;
  return [Math.round(x + w / 2), Math.round(y + h / 2)];
}

// 「这个站点现在能不能直接用」——**只有确认已登录（true）才算通过**。
//
// 2026-09-19 改（实测出来的静默，用户当场撞到）：原先这里只收 `loggedIn === false`，
// 把「读不出来」（null）留在了两边 —— 于是 `needLogin.length === 0`
// ⇒ `attempt()` 判 `ALREADY_LOGGED_IN` ⇒ **不叫人、不做事、安静地过**。
// 实测现场：一个只剩 about:blank 的隔离窗口（刚起浏览器、还没开任何后台页），
// 两个站点都报 `expected one 生意参谋 page, got 0` / `expected one 阿里妈妈 page, got 0`，
// 脚本输出却是 `"verdict": "ALREADY_LOGGED_IN"`，连 `--commit` 都什么都不做。
// 这条静默最坏的地方是**它长成「一切正常」的样子**，所以没人会去查它。
//
// 旧注释写的意图是「宁可少动，不可乱动」，本身没错 —— 错在把「读不到」当成了
// 「不需要动」的唯一依据。新语义：**「读不到」不是「已登录」的证据**。
//
// 为什么敢让读不到的站点进登录流程：这个函数只决定「去不去看一眼」；
// 登录流程第一步本来就是打开登录页（打开一个页面无害，而且窗口里没有页面时正需要这一步），
// 真正的动作（填账密、提交）在 IO 层，且提交前有「验证码」与「坐标可疑即停」两道 fail-closed；
// 真登录态还在的话，第六步会重新验一遍并判 `LOGGED_IN`（不会白跑）。
export function sitesNeedingLogin(siteStates) {
  return Object.entries(siteStates)
    .filter(([, state]) => state?.loggedIn !== true)
    .map(([key]) => key);
}

// 上面那个回答的是「要不要去看一眼」，**不回答「为什么」**。2026-09-24 把「为什么」拆成两个：
//
//   absentSites  —— `loggedIn === null`：**读不到**（这个窗口里没有它的页面，或连不上这个窗口）
//   loggedOutSites —— `loggedIn === false`：**被平台踢回登录页**，实锤
//
// 为什么非拆不可：这两件事的**下一步动作完全相反**（一个什么都不用做、链的归位会自己补上；
// 一个要人去登一次），而它们此前在后半段共用同一个结论 `MAIN_SESSION_ONLY`。
// 一个可核对的事实（读不到）被推成一个确定的结论（主站会话还在、后台要单独登），
// 再去叫人 —— 2026-09-24 那 5 条告警就是这么来的，且它们**看起来完全正常**。
export function absentSites(siteStates = {}) {
  return Object.entries(siteStates)
    .filter(([, state]) => state?.loggedIn === null)
    .map(([key]) => key);
}

export function loggedOutSites(siteStates = {}) {
  return Object.entries(siteStates)
    .filter(([, state]) => state?.loggedIn === false)
    .map(([key]) => key);
}

// 验证码/滑块是否显形（三种载体任一可见即为真）。
export function captchaVisible(state) {
  return Boolean(state?.sliderVisible || state?.captchaInputVisible || state?.checkcode?.visible);
}

// 「这一页上有一套能填的登录表单吗」——账号框与密码框都真的占了位。
//
// 为什么要单独一个判据（2026-09-23）：逐条试候选地址时，每一步都要先回答「这一页到底是不是表单」，
// 而**三种完全不同的现场在这个问题上长得很像**：① 还没加载完；② 被送去别处了；③ 这一页压根不是登录页。
// 用「URL 像不像」去猜会得到印象；用「两个框都可见吗」去问页面，得到的是事实。
//
// 为什么要求**两个框都可见**而不是只要账号框：只有一个框的页面（半渲染、骨架屏、
// 或者平台改了版式）去点它就是「在没准备好的页面上乱点」，而这一页点错不报错。
export function loginFormVisible(state) {
  return Boolean(state?.id?.visible && state?.password?.visible);
}

// 「这一页还是不是淘宝登录页」—— 全仓只有这一处解释。
//
// 为什么要单独一个函数（2026-09-19）：原先这个判断在 login-merchant.mjs 里内联过一次
// （判「提交后有没有离开登录页」），现在又要用它判「登录页是不是压根没进来」——
// 抄第二份的话，两处的口径会各自漂移，而漂移的表现是**结论错**：
// 一处说「已经离开登录页 ⇒ 登录成功」，另一处说「没离开 ⇒ 没成」，同一份现场两个结论。
//
// 主脚本用它判两件事，语义都是「现在还在登录页上吗」：
//   ① 打开登录页之后立刻读一次 —— 不在 ⇒ 被送走了（主站会话还有效），报 MAIN_SESSION_ONLY；
//   ② 点完登录之后再读一次 —— 还在 ⇒ 登录没成，报 LOGIN_NOT_CONFIRMED。
//   ③ （2026-09-23 加）候选表里还有没有下一个可以试 —— 逐条试的前提是「怎么认一个登录页」只有一个口径。
//
// 2026-09-23 改：**从字符串子串判据改成按 URL 结构判**。
//
// 旧写法是 `/login\.taobao\.com\/.*login/u`，而它对本批新增的第二个候选地址给出的答案是**假命中**：
// `https://havanalogin.taobao.com/...` 里**恰好含有子串** `login.taobao.com`
// （`havana` + `login.taobao.com`）⇒ 正则照样命中。也就是说旧判据**靠巧合才对**，
// 而巧合的代价是：任何一台叫 `somethinglogin.taobao.com` 的主机都会被当成登录页。
// 本仓对这类判据有明确的纪律 —— **归属按结构判，不按子串 includes**。
// 改完之后行为在实测到的两个地址上逐字不变（两条都仍为 true），但不再依赖巧合。
//
// 名单刻意**列全**而不是「以 taobao.com 结尾就算」：登录页只有这两台主机
// （`login.taobao.com` 与 `havanalogin.taobao.com`），而 `sycm.taobao.com/custom/login.htm`
// 这种「业务站自己弹的登录页」**不是**顶层淘宝登录页 —— 它不该被算进来（那会让 `--check-only`
// 那条「有没有开过页面」的账算错）。
export const TAOBAO_LOGIN_HOSTS = Object.freeze(['login.taobao.com', 'havanalogin.taobao.com']);

export function isTaobaoLoginUrl(href) {
  const text = String(href ?? '').trim();
  if (!text) return false;
  let url = null;
  try { url = new URL(text); } catch { return false; }
  if (!TAOBAO_LOGIN_HOSTS.includes(url.host)) return false;
  // 主机对了还要看路径像个登录页：`/havanaone/login/login.htm`、`/mini_login.htm`、
  // `/member/login.jhtml` 都命中；而 `https://login.taobao.com/`（只剩根路径）不算 ——
  // 那一步的语义是「还没进到登录页」，把它算成登录页会让「被送走了」这条判据永远判不出来。
  return /login/u.test(url.pathname);
}

// 「业务站自己弹的那个登录页」。它**不是**上面那条（那条判的是「有没有被送去顶层登录页」，
// 刻意把这一族排除在外），所以必须单独一条：
//   `sycm.taobao.com/custom/login.htm?_target=http://sycm.taobao.com/`  ← 2026-09-25 商家浏览器掉登录的现场
//   `sycm.taobao.com/custom/login.htm?_target=…/qos/serv`              ← 2026-09-22 五家店全部落在这里
// 为什么要有它：页签停在登录墙上 = **掉了登录**，不是「页面不齐」——
// 2026-09-25 那次告警就是把这一种归成了「页面不齐」，让人去开页面（开几个都会被弹回来）。
// 判据按**结构**（host 相等 + path 相等），不按子串 includes。
export const SYCM_LOGIN_WALL_HOST = 'sycm.taobao.com';
export const SYCM_LOGIN_WALL_PATH = '/custom/login.htm';

export function isSycmLoginWallUrl(href) {
  const text = String(href ?? '').trim();
  if (!text) return false;
  let url = null;
  try { url = new URL(text); } catch { return false; }
  return url.host === SYCM_LOGIN_WALL_HOST && url.pathname === SYCM_LOGIN_WALL_PATH;
}

// 两族合起来问一句「这个页签是不是停在登录墙上」。
// 驻留轮询（`scripts/hold-and-resume.mjs`）用的就是这一句：判据必须是**同一个**东西 ——
// 分开写两份，迟早有一份漏掉新出现的那种登录页，而「漏掉」的症状是「一直等到超时」。
export function isLoginWallUrl(href) {
  return isTaobaoLoginUrl(href) || isSycmLoginWallUrl(href);
}

// 「登录页把我们送走了吗」—— 送走了返回结论，没送走返回 null。
//
// 2026-09-19 实测：淘宝**主站**会话还有效时，打开顶层登录页会被直接送去卖家后台
// （19033 上落到 `myseller.taobao.com/home.htm/QnworkbenchHome/`），页面上没有任何输入框
// ⇒ 原先那句「拿不到 :autofill」会把它误判成 NO_SAVED_CREDENTIAL，而告警让人去点浏览器
// 提示里的「保存密码」。凭据其实在，缺的是这两个后台**自己的**会话 —— 照着做问题不会好。
//
// 为什么做成纯函数而不是内联在主脚本里的 `if`：主脚本一 import 就干活（末尾 await main()），
// 内联的分支没有测试碰得到 —— 那正是「判据写了但证明不了它会走到」的形态。
// 做成函数之后，用例可以拿实测的 URL 直接问它。
export function detectLoginDetour(href) {
  // 还在登录页上 ⇒ 没有绕路，后面的填表流程照旧。
  if (isTaobaoLoginUrl(href)) return null;
  // **读不到地址就不下结论**：这一条与「读不到 ≠ 已登录」同源。
  // 这里若顺手判成「主站会话还在」，就是又一个假事实 —— 而这次连证据都没有。
  const text = String(href ?? '').trim();
  if (!text) return null;
  let host = null;
  try { host = new URL(text).host; } catch { host = null; }
  return { verdict: 'MAIN_SESSION_ONLY', host, href: text };
}

// ---------------------------------------------------------------------------
// 飞书提醒：哪些结论要叫人、叫人的话怎么说
// ---------------------------------------------------------------------------
//
// 为什么要在这里定「哪些结论要叫人」：通知的**判定**属于离线可测的纯逻辑，
// **投递**属于外部副作用（`runtime/notify-feishu.mjs` 三跳链）。这条分界与
// `notify-feishu-core.mjs` 文件头写的是同一条 —— 不能把判定散进 IO 里。
//
// 词表而不是内联判断：漏一个词的症状是「有一类失败永远不叫人」，
// 那是最难发现的一类静默（页面不报错、脚本也退出码非 0，但没人被通知）。
export const VERDICTS_NEEDING_HUMAN = Object.freeze([
  'NO_SAVED_CREDENTIAL',  // 密码库里没有凭据 / 补了手势值也不落地 ⇒ 只能人来一次
  'WRONG_ACCOUNT',        // 填进来的是**别的店**的账号 ⇒ 停手交人（下面的处置与 NO_SAVED_CREDENTIAL 不同）
  'MAIN_SESSION_ONLY',    // 登录页被送走 ⇒ 目标站点要人去单独登（脚本在这条路上没有能填的表单）
  'CAPTCHA_REQUIRED',     // 滑块或验证码 ⇒ 人的动作，脚本按纪律不硬闯
  'LOGIN_NOT_CONFIRMED',  // 提交了但没离开登录页 ⇒ 可能密码不对，也可能是风控
  'PARTIAL',              // 提交了，但有站点没进去
  'NEEDS_LOGIN',          // check-only：有站点没在登录态（掉登录，或它的页面还没打开）
  'STOP_AND_ALERT',       // fail-closed 停手（坐标可疑、页面堆叠等）
]);
// ⚠️ `PAGES_ABSENT` 刻意**不在**上面这张表里（2026-09-24）：它是「这一层没有结论」，
// 不是「要人做什么」。放进去的症状已经实测过一次 —— 冷启动后的预检并发 5 条告警，
// 而五家店其实只是页面还没归位。**别为了「让它可见」把它加进来**：
// 它可见的地方是报告与 `login-preflight.json`（链的告警会如实引用），不是收信人的手机。

export function needsHuman(verdict) {
  return VERDICTS_NEEDING_HUMAN.includes(verdict);
}

export function shouldNotify({ verdict, commit = false, mode = 'auto' } = {}) {
  if (mode === 'off') return false;
  if (!needsHuman(verdict)) return false;
  if (mode === 'auto') return commit === true;
  return true; // send / dry：显式要求，且结论确实需要人
}

// 2026-09-18 用户反馈「提醒太笼统、讲一堆术语，要给出操作链接和内容」⇒ 这一节的文案重写：
//   1. **先说人该做什么**，再说为什么；
//   2. 不出现结论代号（`NO_SAVED_CREDENTIAL` 之类）、不出现内部术语（会话/判据/风控/幂等）。
//
// 2026-09-19 再改：**「必须带一条可点的链接」这条规范被实测证伪，已删**。
// 用户原话：「我点了你发的链接直接跳到我的默认浏览器（QQ 浏览器）而不是目标浏览器」。
// 根因不是链接写错了，而是**点 http 链接走的是系统默认浏览器** —— 这是 OS 行为，改不了；
// 而这里真正要的是把人带到**我们那个 profile 的 Edge 实例**里，那条路根本不通。
// 链接不但到不了目标窗口，还会把人送进一个没有登录态的浏览器里，凭空多一层困惑。
//
// 替代方案（2026-09-19 起）：**由脚本自己把登录页开在目标窗口里、并把窗口置前**
// （登录流程本来就有的"打开登录页"那一步 ＋ login-merchant.mjs 里无条件执行的 bringToFront），
// 告警正文只负责说清「去哪个窗口、做什么」。用户原话：
// 「你要让业务人员知道要干什么，而不是单单弹个窗口出来」。
//
// 「下一步」必须是**一个人照着做就能做完**的一句话。只写「登录已失效」等于把
// 「去哪台机器、动哪个配置、做完之后干嘛」留给收信人自己猜 —— 而登录恰恰是唯一
// 无法远程代劳的事，收信人看完还得先找机器。
// 「下一步」必须是**一个人照着做就能做完**的一句话，而且必须能定位到**哪一个**窗口。
//
// 2026-09-18 用户原话：「我不知道是哪一个店铺的浏览器需要登录」。原来这里写的是
// 「在上面那个浏览器窗口里」—— 而告警里根本没有「上面那个窗口」这个东西：
// 四台浏览器长得一模一样，收信人到了机器前仍然要猜。所以改成用**店名**定位，
// 而店名能被用来定位的前提是：那个窗口的标题里真的写着店名
// （见 `runtime/shop-window-label.mjs`）。
//
// 2026-09-22 更正：这里原先写的是「SOP 第 1 步起浏览器时会挂上」—— **不成立**。
// 标签页不会随 `scripts/start-all.mjs` 自动挂，要有人显式跑
// `node runtime/shop-window-label.mjs --commit`（SOP §1.3）才有；而且没被 `--pin` 钉住的
// 标签页会被代理的闲置回收（`CDP_TAB_IDLE_TIMEOUT`，15 分钟）关掉。
// 所以「浏览器重启过一次」＝「窗口标志全没了」，而这句错注释会让人以为它自己会回来
// （用户 2026-09-22 原话：「之前我记得每个浏览器都有一个专门的窗口是来标志是什么店铺的，现在怎么没有」）。
//
// `{窗口}` 是占位符，由 buildLoginAlert 按有没有店名替换；没有店名时退化成不承诺标题的说法，
// 而不是留一个空括号或直接写「标题写着「null」」。
const ACTION_BY_VERDICT = Object.freeze({
  // 前三条都是在**登录流程里**判出来的 ⇒ 登录页此刻一定还开在那个窗口里
  // （见 login-merchant.mjs 的 ensureLoginPage），所以文案直接断言这件事 ——
  // 收信人不用再想「我去哪儿登」。
  NO_SAVED_CREDENTIAL: '登录页已经开在{窗口}了。人工登录一次，登录时点浏览器提示里的「保存密码」，下次就不用再来了。',
  // 2026-09-23 加。**不能**抄上面那句：上面让人「点保存密码」，而这一条的问题恰恰是
  // 这一台浏览器里存着**不止一家店**的账号 —— 再让人去「保存密码」只会把问题坐实。
  // 该做的是**人工用这一家的账号登一次**，并且**别让这台继续混着多家店的凭据**。
  WRONG_ACCOUNT: '登录页已经开在{窗口}了。请改用手工登录：这台浏览器里存着不止一家店的账号，'
    + '系统不确定自己填的是哪一家，所以没有替你提交。请用这一家的账号登一次。',
  // 这一条**不能**承诺「登录页开着」：它恰恰是「登录页被送走了」判出来的。
  // 也别让人去找那个被送走的页 —— 该做的是打开这两个后台。
  MAIN_SESSION_ONLY: '去{窗口}里把「生意参谋」和「阿里妈妈」各打开一次，按页面提示登录（登录页现在被自动送走了，'
    + '脚本在那条路上没有可填的表单）；登录时点浏览器提示里的「保存密码」。',
  CAPTCHA_REQUIRED: '登录页已经开在{窗口}了。把滑块/短信验证做完即可 —— 账号密码已经在页面上了。',
  LOGIN_NOT_CONFIRMED: '登录页已经开在{窗口}了。看它的提示：要求验证就验证，提示密码不对就先改密码。'
    + '系统不会自己再试一遍（连着试会把账号锁住）。',
  // 后两条不承诺「登录页开着」：PARTIAL 是提交后已经跳走，STOP_AND_ALERT 可能停在打开页面那一步。
  PARTIAL: '去{窗口}里，把没进去的那个后台登一次。',
  // check-only 下**同样**不许承诺「登录页开着」——它一个页面都没开。
  // 也因此它把「页面还没打开」这种情形也一并纳入：那一种同样要人去那个窗口动一下手。
  NEEDS_LOGIN: '去{窗口}里把「生意参谋」和「阿里妈妈」各看一眼：哪一个停在登录页，就登哪一个'
    + '（登录时点浏览器提示里的「保存密码」）。这一步只是体检，系统没有动过任何页面。',
  STOP_AND_ALERT: '去{窗口}里照「原因」那一条处理（系统已经停手，没有留下半成品）。',
});

// 把 `{窗口}` 换成收信人真的能在机器上认出来的说法。
export function resolveAction(verdict, shopName = null) {
  const template = ACTION_BY_VERDICT[verdict] ?? '人工处理后再跑这一轮。';
  // 有店名时用**窗口标题**指路。括号里那句「任务栏里就能看到」是给非技术收信人看的 ——
  // 他可能不知道「窗口标题」是什么，但知道去任务栏哪一行找。
  const where = shopName
    ? `标题写着「${shopName}」的那个浏览器窗口（任务栏里就能看到）`
    : '那台电脑的浏览器窗口';
  return template.replace('{窗口}', where);
}

// 「原因」用一句人话，不写结论代号。`detail` 由调用方补细节，**补的必须是增量信息**，
// 不能把上面这句再说一遍 —— 2026-09-18 渲染出来发现「原因」是同一句话读两遍：
//     「这个浏览器里没有存这家店的账号密码，系统没法自动填。 这台浏览器里没有存这家店的账号密码，系统没法自动填。…」
// 静态原因只交代「出了什么事」，detail 只交代「这一次具体是什么情况」。
// 导出是为了让用例能真的比对「主脚本补的 detail」有没有把这里再说一遍（那是渲染出来才发现的缺陷）。
export const REASON_BY_VERDICT = Object.freeze({
  NO_SAVED_CREDENTIAL: '这个浏览器里没有存这家店的账号密码，系统没法自动填。',
  // 「原因」只交代出了什么事，不讲机制别名（见本节头部那条 2026-09-18 的措辞纪律）。
  WRONG_ACCOUNT: '往登录框里填的是另一家店的账号 —— 这台浏览器里存着不止一家店的账号密码，'
    + '系统不肯替你猜是哪一家，所以停在这里没有提交。',
  MAIN_SESSION_ONLY: '这台机器上淘宝主站是登录着的，所以打开登录页会被直接送去卖家后台；'
    + '但生意参谋/阿里妈妈这两个后台要单独进一次，而脚本没有可填的表单。',
  CAPTCHA_REQUIRED: '登录时平台要求滑块或短信验证，这一步只能由人来完成。',
  LOGIN_NOT_CONFIRMED: '账号密码填了、登录按钮也点了，页面却还停在登录页。',
  PARTIAL: '账号密码提交成功了，但两个后台里还有没进去的。',
  NEEDS_LOGIN: '这个窗口里至少有一个后台现在不在登录态：要么掉登录了，要么它的页面还没打开。',
  STOP_AND_ALERT: '系统在动手之前停住了。',
});

// [已删] `loginUrlFor()` —— 告警不再给链接。
// 留一行历史说明而不是让它悄悄消失：将来有人想「把链接加回来」时，先看到它为什么被删
// （点 http 链接走系统默认浏览器，到不了目标 profile 的 Edge 实例；见本节头部 2026-09-19 那条）。
// `TAOBAO_LOGIN_URL` 仍然保留：登录流程自己要用它（ensureLoginPage 打开登录页）。


// 导出（2026-09-24）：跑前体检那一层要拼**整轮**告警的编号（`sycm-login-round-<日期戳>`），
// 而「日期戳怎么拼」只能有一个实现 —— 两处各写一份，就会在同一天里拼出两个不同的锚，
// 去重随之失效（症状：同一天叫两次，而两次看起来都「合理地」发了）。
export function localDateStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

// 拼一条告警对象。字段名必须落在 `runtime/notify-feishu-core.mjs` 的
// `READABLE_SOURCE_KEYS` 白名单里，否则渲染时会被静默丢掉（告警还能发出去，
// 但收信人看不到最关键的「哪台机器、哪个配置」）。
//
// 这里**永远不接收也不渲染凭据**：reason 只允许是本脚本自己产出的说明文字。
export function buildLoginAlert({
  verdict,
  detail = null,
  sites = [],
  machine = null,
  browserProfile = null,
  shopName = null,
  now = () => new Date(),
} = {}) {
  if (!needsHuman(verdict)) {
    throw new Error(`${verdict} 不需要人处理，不该生成告警（这是调用方的判定错误）`);
  }
  const when = now();
  const labels = sites.map((key) => SITES[key]?.label).filter(Boolean);
  const plainReason = REASON_BY_VERDICT[verdict] ?? '这一步需要人来做。';
  return {
    type: 'LOGIN_REQUIRED',
    severity: 'ERROR',
    // 标题自带店名：收信人扫一眼就知道「哪家店要我干什么」，不必点开正文找。
    // 这也让 `TITLE_BY_TYPE` 那张通用表只在「没给 title」的旧来源上继续生效。
    title: shopName ? `${shopName} 需要你登录一次` : '需要你登录一次',
    // 同一家店同一天只叫一次：alertId 是可被调用方拿去去重的锚（同日重复失败不会刷屏）。
    //
    // **店名必须进这个锚**（2026-09-18 修）：原先只含站点，于是五家店同一天共用
    // `sycm-login-sycm-alimama-20260918` 一条 —— 任何按 alertId 去重的调用方
    // 会把后四家当成「重复」直接吞掉，现场表现就是「五家店只叫了一家」。
    // 缺店名时不加前缀，对没给店名的旧来源渲染结果逐字不变。
    alertId: [
      'sycm-login',
      ...(shopName ? [shopName] : []),
      sites.join('-') || 'unknown',
      localDateStamp(when),
    ].join('-'),
    createdAt: when.toISOString(),
    reason: detail ? `${plainReason} ${detail}` : plainReason,
    action: resolveAction(verdict, shopName),
    source: {
      targetLabel: labels.join(' / ') || null,
      shopName,
      // 刻意**不放链接**（2026-09-19）：点 http 链接会走系统默认浏览器，
      // 到不了这个 profile 的 Edge 实例（见本节头部那条实测）。
      // 入口由脚本自己开：登录页会被打开在那个窗口里并置前，正文只说去哪个窗口。
      machine,
      browserProfile,
    },
  };
}

// 「这家店用哪个浏览器 profile」——**必须是选出来的，不是回落出来的**。
//
// 为什么单独一个函数（2026-09-18 实测缺陷）：原先主脚本恒写
// `process.env.PROJECT_BROWSER_PROFILE || BROWSER_PROFILES.dailyReport`，
// 于是四家店发出的告警都写着同一个 `edge-daily-report-profile`；
// 收信人照着这个路径去机器上找，四个窗口长得一模一样，等于没给。
//
// 两条 fail-closed 都刻意选了「抛错」而不是「回落」：
//   - 给了店名却没给登记表 ⇒ 抛错。回落的话，一次「忘了传参」就会静默退回那个
//     全体共用的日报 profile —— 那正是要消灭的现象，而它**不会报错**。
//   - 店名不在登记表里 ⇒ 抛错，并把已登记的都列出来。
// 只有「压根没给店名」时才回落到 `fallback`：那是 `--shop` 出现之前的老用法，行为必须不变。
export function profileForShop({ shop = null, shops = null, fallback = null } = {}) {
  if (!shop) return fallback;
  if (!shops || typeof shops !== 'object') {
    throw new Error(`给了店铺「${shop}」却拿不到店铺登记表 ⇒ 无法确定该用哪个浏览器配置（不回落成共用 profile）`);
  }
  const found = shops[shop];
  if (!found || !found.profile) {
    throw new Error(`未登记的店铺实例「${shop}」；已登记：${Object.keys(shops).join(' / ')}`);
  }
  return found.profile;
}

// 「这次运行该不该叫人、叫人的话是谁」——把**从命令行参数到告警对象**这一段收进纯函数。
//
// 为什么非收不可（2026-09-18 的真实缺陷）：`buildLoginAlert` 早就支持并渲染 `shopName`，
// 离线用例也一直在测「给了店名 ⇒ 标题带店名」；但**主脚本调用它时没把店名传进去**，
// 于是发出去的告警逐字是「需要你登录一次」+「浏览器配置：D:\Retire\edge-daily-report-profile」，
// 五家店一模一样，收信人无从知道该去哪台机器。契约齐、测试绿、接线没接上 —— 这类缺陷
// 是「在 IO 脚本里写装配逻辑」的直接后果：IO 脚本离线测不到，所以没人守得住它。
// 收进这里之后，「接线接对了没有」变成一条可以直接断言的纯函数行为。
export function alertForRun({
  args = {},
  receipt = {},
  machine = null,
  shops = null,
  fallbackProfile = null,
  now = () => new Date(),
} = {}) {
  const verdict = receipt?.verdict ?? null;
  const mode = args?.notify ?? 'auto';
  if (!shouldNotify({ verdict, commit: args?.commit === true, mode })) return null;
  return buildLoginAlert({
    verdict,
    detail: receipt?.detail ?? null,
    sites: args?.sites ?? [],
    machine,
    browserProfile: profileForShop({ shop: args?.shop ?? null, shops, fallback: fallbackProfile }),
    shopName: args?.shop ?? null,
    now,
  });
}
