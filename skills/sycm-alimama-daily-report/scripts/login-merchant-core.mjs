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

export function parseArgs(argv, { defaultProxy } = {}) {
  const opts = { target: 'both', commit: false, proxy: defaultProxy, shots: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--commit') { opts.commit = true; continue; }
    if (token === '--help' || token === '-h') { opts.help = true; continue; }
    const valueFlags = ['--target', '--proxy', '--shots'];
    if (!valueFlags.includes(token)) throw new Error(`Unknown argument: ${token}`);
    const value = argv[i + 1];
    // 先认名字再看值：否则 `--nope` 会被报成「需要一个值」，把「参数拼错」伪装成「忘了给值」。
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    if (token === '--target') opts.target = value;
    if (token === '--proxy') opts.proxy = value;
    if (token === '--shots') opts.shots = value;
    i += 1;
  }
  if (!LOGIN_TARGETS.includes(opts.target)) {
    throw new Error(`Unknown --target ${opts.target} (known: ${LOGIN_TARGETS.join(', ')})`);
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
