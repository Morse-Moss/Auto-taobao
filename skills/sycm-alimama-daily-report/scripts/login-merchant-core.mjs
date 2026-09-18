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

export function parseArgs(argv, { defaultProxy } = {}) {
  const opts = {
    target: 'both', commit: false, proxy: defaultProxy, shots: null, notify: 'auto', help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--commit') { opts.commit = true; continue; }
    if (token === '--help' || token === '-h') { opts.help = true; continue; }
    const valueFlags = ['--target', '--proxy', '--shots', '--notify'];
    if (!valueFlags.includes(token)) throw new Error(`Unknown argument: ${token}`);
    const value = argv[i + 1];
    // 先认名字再看值：否则 `--nope` 会被报成「需要一个值」，把「参数拼错」伪装成「忘了给值」。
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    if (token === '--target') opts.target = value;
    if (token === '--proxy') opts.proxy = value;
    if (token === '--shots') opts.shots = value;
    if (token === '--notify') opts.notify = value;
    i += 1;
  }
  if (!LOGIN_TARGETS.includes(opts.target)) {
    throw new Error(`Unknown --target ${opts.target} (known: ${LOGIN_TARGETS.join(', ')})`);
  }
  if (!NOTIFY_MODES.includes(opts.notify)) {
    throw new Error(`Unknown --notify ${opts.notify} (known: ${NOTIFY_MODES.join(', ')})`);
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

// 「要不要为这个站点跑登录」——已登录不跑，读不出来（null）也不跑（宁可少动，不可乱动）。
export function sitesNeedingLogin(siteStates) {
  return Object.entries(siteStates)
    .filter(([, state]) => state?.loggedIn === false)
    .map(([key]) => key);
}

// 验证码/滑块是否显形（三种载体任一可见即为真）。
export function captchaVisible(state) {
  return Boolean(state?.sliderVisible || state?.captchaInputVisible || state?.checkcode?.visible);
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
//   2. **必须带一条可点的链接**（`loginUrl`）——只说「登录已失效」，收信人还得先找入口；
//   3. 不出现结论代号（`NO_SAVED_CREDENTIAL` 之类）、不出现内部术语（会话/判据/风控/幂等）。
//
// 「下一步」必须是**一个人照着做就能做完**的一句话。只写「登录已失效」等于把
// 「去哪台机器、动哪个配置、做完之后干嘛」留给收信人自己猜 —— 而登录恰恰是唯一
// 无法远程代劳的事，收信人看完还得先找机器。
const ACTION_BY_VERDICT = Object.freeze({
  NO_SAVED_CREDENTIAL:
    '在上面那个浏览器窗口里人工登录一次，登录时点「保存密码」，下次就不用再来了。',
  CAPTCHA_REQUIRED:
    '在上面那个浏览器窗口里把滑块/短信验证做完即可 —— 账号密码已经在页面上了。',
  LOGIN_NOT_CONFIRMED:
    '在上面那个浏览器窗口里打开登录页看它的提示：要求验证就验证，提示密码不对就先改密码。'
    + '系统不会自己再试一遍（连着试会把账号锁住）。',
  PARTIAL: '在上面那个浏览器窗口里，把没进去的那个后台登一次。',
  STOP_AND_ALERT: '照「原因」那一条处理（系统已经停手，没有留下半成品）。',
});

// 「原因」用一句人话，不写结论代号。detail 由调用方补细节，拼在后面。
const REASON_BY_VERDICT = Object.freeze({
  NO_SAVED_CREDENTIAL: '这个浏览器里没有存这家店的账号密码，系统没法自动填。',
  CAPTCHA_REQUIRED: '登录时平台要求滑块或短信验证，这一步只能由人来完成。',
  LOGIN_NOT_CONFIRMED: '账号密码填了、登录按钮也点了，页面却还停在登录页。',
  PARTIAL: '两个后台里有一个没登进去。',
  STOP_AND_ALERT: '系统在动手之前停住了。',
});

// 收信人该点开哪个链接：
//   - 只缺一个站点 ⇒ 点那个业务后台，它自己会把人带到登录页（最少一步）；
//   - 两个都缺（或认不出来）⇒ 点淘宝登录页：一次登录同时管生意参谋与阿里妈妈。
export function loginUrlFor(sites = []) {
  const known = sites.filter((key) => SITES[key]);
  if (known.length === 1) return SITES[known[0]].probeUrl;
  return TAOBAO_LOGIN_URL;
}


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
    // 同一站点同一天只叫一次：alertId 是可被调用方拿去去重的锚（同日重复失败不会刷屏）。
    alertId: `sycm-login-${sites.join('-') || 'unknown'}-${localDateStamp(when)}`,
    createdAt: when.toISOString(),
    reason: detail ? `${plainReason} ${detail}` : plainReason,
    action: ACTION_BY_VERDICT[verdict] ?? '人工处理后再跑这一轮。',
    source: {
      targetLabel: labels.join(' / ') || null,
      shopName,
      // 必须可点：这是「照着做」的入口，不是参考资料。
      loginUrl: loginUrlFor(sites),
      machine,
      browserProfile,
    },
  };
}
