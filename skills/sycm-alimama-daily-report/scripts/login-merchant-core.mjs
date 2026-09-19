// 自动登录的纯逻辑（可离线测）：站点判据、参数解析、坐标选取、页面状态表达式。
// IO 全在 login-merchant.mjs 里 —— 这条分界与 collect-core.mjs 一致，理由也一样：
// 「测过的那份」和「真的在跑的那份」必须是同一份，而 IO 没法离线复现。

export const TAOBAO_LOGIN_URL = 'https://login.taobao.com/havanaone/login/login.htm?bizName=taobao';

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
  'MAIN_SESSION_ONLY',    // 登录页把我们送走了（主站会话还有效）⇒ 目标站点要单独登一次
  'CAPTCHA_REQUIRED',     // 滑块/验证码显形 —— 按 SOP §10.2 停手交人
  'LOGIN_NOT_CONFIRMED',  // 提交后仍停在登录页 —— 如实报没成
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

// 通知模式。默认 `auto` 的口径是「**真的试过了**并且没成，才叫人」：
//   - 不带 --commit 是只读排练，没试过 ⇒ 不叫人（排练撞到登录墙不该惊动人）；
//   - `send`/`dry` 是显式要求（跑演练、验证文案时用），仍只在「需要人」的结论上生效；
//   - `off` 完全闭嘴。
export const NOTIFY_MODES = Object.freeze(['auto', 'send', 'dry', 'off']);

export function parseArgs(argv, { defaultProxy, shops = null } = {}) {
  const opts = {
    target: 'both', commit: false, proxy: defaultProxy, shots: null, notify: 'auto', help: false,
    // `--shop` 是**运营叫法**（＝登记表 SHOP_BROWSERS 的键，如「盖文淘宝」）。
    // 它唯一的用途是让告警**点名是哪一家店** —— 2026-09-18 用户原话：
    // 「我不知道是哪一个店铺的浏览器需要登录」。缺了它，五家店发出的告警逐字相同。
    shop: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--commit') { opts.commit = true; continue; }
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

// 验证码/滑块是否显形（三种载体任一可见即为真）。
export function captchaVisible(state) {
  return Boolean(state?.sliderVisible || state?.captchaInputVisible || state?.checkcode?.visible);
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
export function isTaobaoLoginUrl(href) {
  return /login\.taobao\.com\/.*login/u.test(String(href ?? ''));
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
  'MAIN_SESSION_ONLY',    // 登录页被送走 ⇒ 目标站点要人去单独登（脚本在这条路上没有能填的表单）
  'CAPTCHA_REQUIRED',     // 滑块或验证码 ⇒ 人的动作，脚本按纪律不硬闯
  'LOGIN_NOT_CONFIRMED',  // 提交了但没离开登录页 ⇒ 可能密码不对，也可能是风控
  'PARTIAL',              // 提交了，但有站点没进去
  'STOP_AND_ALERT',       // fail-closed 停手（坐标可疑、页面堆叠等）
]);

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
// （见 `runtime/shop-window-label.mjs`，SOP 第 1 步起浏览器时会挂上）。
//
// `{窗口}` 是占位符，由 buildLoginAlert 按有没有店名替换；没有店名时退化成不承诺标题的说法，
// 而不是留一个空括号或直接写「标题写着「null」」。
const ACTION_BY_VERDICT = Object.freeze({
  // 前三条都是在**登录流程里**判出来的 ⇒ 登录页此刻一定还开在那个窗口里
  // （见 login-merchant.mjs 的 ensureLoginPage），所以文案直接断言这件事 ——
  // 收信人不用再想「我去哪儿登」。
  NO_SAVED_CREDENTIAL: '登录页已经开在{窗口}了。人工登录一次，登录时点浏览器提示里的「保存密码」，下次就不用再来了。',
  // 这一条**不能**承诺「登录页开着」：它恰恰是「登录页被送走了」判出来的。
  // 也别让人去找那个被送走的页 —— 该做的是打开这两个后台。
  MAIN_SESSION_ONLY: '去{窗口}里把「生意参谋」和「阿里妈妈」各打开一次，按页面提示登录（登录页现在被自动送走了，'
    + '脚本在那条路上没有可填的表单）；登录时点浏览器提示里的「保存密码」。',
  CAPTCHA_REQUIRED: '登录页已经开在{窗口}了。把滑块/短信验证做完即可 —— 账号密码已经在页面上了。',
  LOGIN_NOT_CONFIRMED: '登录页已经开在{窗口}了。看它的提示：要求验证就验证，提示密码不对就先改密码。'
    + '系统不会自己再试一遍（连着试会把账号锁住）。',
  // 后两条不承诺「登录页开着」：PARTIAL 是提交后已经跳走，STOP_AND_ALERT 可能停在打开页面那一步。
  PARTIAL: '去{窗口}里，把没进去的那个后台登一次。',
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
  MAIN_SESSION_ONLY: '这台机器上淘宝主站是登录着的，所以打开登录页会被直接送去卖家后台；'
    + '但生意参谋/阿里妈妈这两个后台要单独进一次，而脚本没有可填的表单。',
  CAPTCHA_REQUIRED: '登录时平台要求滑块或短信验证，这一步只能由人来完成。',
  LOGIN_NOT_CONFIRMED: '账号密码填了、登录按钮也点了，页面却还停在登录页。',
  PARTIAL: '账号密码提交成功了，但两个后台里还有没进去的。',
  STOP_AND_ALERT: '系统在动手之前停住了。',
});

// [已删] `loginUrlFor()` —— 告警不再给链接。
// 留一行历史说明而不是让它悄悄消失：将来有人想「把链接加回来」时，先看到它为什么被删
// （点 http 链接走系统默认浏览器，到不了目标 profile 的 Edge 实例；见本节头部 2026-09-19 那条）。
// `TAOBAO_LOGIN_URL` 仍然保留：登录流程自己要用它（ensureLoginPage 打开登录页）。


function localDateStamp(date) {
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
