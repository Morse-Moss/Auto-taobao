// 自动登录的离线用例。IO 全在 login-merchant.mjs，这里只测判据与纯函数 ——
// 理由和 collect-core.test.mjs 一样：判据错了不会报错，只会静默地「多做一件事」或「少做一件事」。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  FORM_STATE_EXPRESSION, LOGIN_TARGETS, NOTIFY_MODES, REASON_BY_VERDICT, SITES, VERDICTS,
  VERDICTS_NEEDING_HUMAN, alertForRun, buildLoginAlert, captchaVisible, centerOf, loginUrlFor, needsHuman,
  parseArgs, profileForShop, resolveAction, shouldNotify, sitesNeedingLogin,
} from './login-merchant-core.mjs';
// 用**真的那份登记表**（不是测试自己造的假表）来验「哪家店 → 哪个 profile」：
// 造一张假表只能证明这个函数会查表，证明不了四家店各自指向自己的 profile。
import { SHOP_BROWSERS } from '../../../runtime/browser-ports.mjs';
// 告警承诺「找标题写着 X 的窗口」，那句话的落点在窗口标签页那一侧 —— 两边必须一起测。
import { windowTitleFor } from '../../../runtime/shop-window-label.mjs';
// 用**真的那份渲染器**去验告警文案：白名单是 notify-feishu-core 的，
// 键名写错时字段会被静默丢掉（告警照发，收信人看不到「哪台机器」）—— 那条只有真渲染才测得出来。
import { renderAlertText } from '../../../runtime/notify-feishu-core.mjs';

const DEFAULTS = { defaultProxy: 'http://127.0.0.1:19023' };

// 断言对象必须是**收信人真正看到的那段文本**（走真渲染器），而不是「告警对象里有没有某个字段」——
// 渲染器的白名单会把键名写错的字段静默丢掉，只有渲染出来才看得见。
// 「告警点名了哪家店」这件事，用户看到的是文本，所以判据也必须落在文本上。
const rendered = (alert) => renderAlertText(alert);

test('站点判据：实测的「未登录」URL 命中，实测的「已登录」URL 不命中', () => {
  // 正例来自 2026-09-18 实测：生意参谋被踢回 custom/login.htm、阿里妈妈停在 #!/login/index
  assert.equal(SITES.sycm.loggedOut.test('https://sycm.taobao.com/custom/login.htm?_target=http://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop'), true);
  assert.equal(SITES.alimama.loggedOut.test('https://one.alimama.com/index.html#!/login/index'), true);
  // 反例：登录成功之后的真实 URL —— 判据在这里误报，会把「已登录」读成「要登录」
  assert.equal(SITES.sycm.loggedOut.test('https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop'), false);
  assert.equal(SITES.alimama.loggedOut.test('https://one.alimama.com/index.html'), false);
  // 阿里妈妈的已登录首页里含 "index" 字样，但判据认的是 login/index —— 这一条钉住它
  assert.equal(SITES.alimama.loggedOut.test('https://one.alimama.com/index.html#/report/account'), false);
});

test('两个站点都声明了探测页与标签，且探测页自身不会被自己的判据命中', () => {
  for (const [key, site] of Object.entries(SITES)) {
    assert.ok(site.label, `${key} 缺 label`);
    assert.ok(site.pageMatch, `${key} 缺 pageMatch`);
    assert.match(site.probeUrl, /^https:\/\//u, `${key} 的 probeUrl 必须是 https`);
    assert.equal(site.loggedOut.test(site.probeUrl), false,
      `${key}: probeUrl 会被自己的未登录判据命中 ⇒ 每次都会误判成掉登录`);
  }
});

test('parseArgs：默认只读排练，--commit 才动手', () => {
  const a = parseArgs([], DEFAULTS);
  assert.equal(a.commit, false);
  assert.deepEqual(a.sites, ['sycm', 'alimama']);
  assert.equal(a.proxy, DEFAULTS.defaultProxy);
  assert.equal(a.shots, null);

  const b = parseArgs(['--commit', '--target', 'alimama', '--shots', 'D:/tmp/s'], DEFAULTS);
  assert.equal(b.commit, true);
  assert.deepEqual(b.sites, ['alimama']);
  assert.equal(b.shots, 'D:/tmp/s');
});

test('parseArgs：未知参数要报「未知」，不能报成「需要一个值」', () => {
  // 先认名字再看值 —— 否则拼错的参数会被伪装成「忘了给值」，排查方向整个错
  assert.throws(() => parseArgs(['--nope'], DEFAULTS), /Unknown argument: --nope/u);
  assert.throws(() => parseArgs(['--target'], DEFAULTS), /--target requires a value/u);
  assert.throws(() => parseArgs(['--target', '--commit'], DEFAULTS), /--target requires a value/u);
  assert.throws(() => parseArgs(['--target', 'taobao'], DEFAULTS), /Unknown --target taobao/u);
});

test('LOGIN_TARGETS 与 SITES 的键一致（多一个值就会变成「谁也不会被处理」）', () => {
  assert.deepEqual([...LOGIN_TARGETS].sort(), ['alimama', 'both', 'sycm']);
  for (const key of Object.keys(SITES)) assert.ok(LOGIN_TARGETS.includes(key), `SITES 里的 ${key} 不在 LOGIN_TARGETS`);
});

test('centerOf：零尺寸矩形算出来的中心是 (0,0) ⇒ 必须 fail-closed 返回 null', () => {
  // 点了 (0,0) 会落在页面左上角，而这一页点错不报错（本项目反复踩到的形态）
  assert.equal(centerOf({ id: { visible: true, rect: [0, 0, 0, 0] } }, 'id'), null);
  assert.equal(centerOf({ id: { visible: false, rect: [744, 297, 370, 48] } }, 'id'), null);
  assert.equal(centerOf({ id: null }, 'id'), null);
  assert.equal(centerOf({}, 'id'), null);
  assert.equal(centerOf({ id: { visible: true, rect: [-5, 0, 370, 48] } }, 'id'), null, '负 x 且 y=0 也算可疑');
  assert.deepEqual(centerOf({ id: { visible: true, rect: [744, 297, 370, 48] } }, 'id'), [929, 321]);
  assert.deepEqual(centerOf({ submit: { visible: true, rect: [744, 465, 370, 48] } }, 'submit'), [929, 489]);
});

test('sitesNeedingLogin：读不出来（null）不等于要登录 —— 宁可少动，不可乱动', () => {
  assert.deepEqual(sitesNeedingLogin({ sycm: { loggedIn: false }, alimama: { loggedIn: false } }), ['sycm', 'alimama']);
  assert.deepEqual(sitesNeedingLogin({ sycm: { loggedIn: true }, alimama: { loggedIn: false } }), ['alimama']);
  assert.deepEqual(sitesNeedingLogin({ sycm: { loggedIn: null }, alimama: { loggedIn: true } }), []);
  assert.deepEqual(sitesNeedingLogin({}), []);
});

test('captchaVisible：三种载体任一可见即为真（SOP §10.2 停手交人的判据）', () => {
  assert.equal(captchaVisible({}), false);
  assert.equal(captchaVisible({ sliderVisible: true }), true);
  assert.equal(captchaVisible({ captchaInputVisible: true }), true);
  assert.equal(captchaVisible({ checkcode: { visible: true } }), true);
  assert.equal(captchaVisible({ checkcode: { visible: false }, sliderVisible: false, captchaInputVisible: false }), false);
});

test('登录表单表达式：只认那五个具名元素（id 来自实测），并且读的是 DOM 值不是视觉', () => {
  for (const selector of ['#fm-login-id', '#fm-login-password', '#fm-login-checkcode', '#fm-agreement-checkbox', 'button.fm-submit']) {
    assert.ok(FORM_STATE_EXPRESSION.includes(selector), `表达式没有读 ${selector}`);
  }
  assert.ok(FORM_STATE_EXPRESSION.includes("matches(':autofill')"), '必须读 :autofill（用来判断密码库里有没有凭据）');
  assert.ok(FORM_STATE_EXPRESSION.includes('valueLen'), '必须读 value 长度（这才是「值落地了没有」的判据）');
});

test('主脚本用到的结论词都在 VERDICTS 里（拼错一个词就是一次静默降级）', () => {
  const source = readFileSync(new URL('./login-merchant.mjs', import.meta.url), 'utf8');
  // 两种写法都要认：`verdict: 'X'`（抛出路径的对象字面量）与 `receipt.verdict = 'X'`（正常路径的赋值）
  const used = new Set([...source.matchAll(/verdict\s*[:=]\s*'([A-Z_]+)'/gu)].map((m) => m[1]));
  assert.ok(used.size >= 5, `只扫到 ${used.size} 个结论词，源码扫描多半失效了`);
  for (const word of used) assert.ok(VERDICTS.includes(word), `主脚本用了未登记的结论词 ${word}`);
  // 反向：词表里有、主脚本从不产生的，多半是残留
  const dead = VERDICTS.filter((v) => !used.has(v));
  assert.ok(dead.length <= 3, `词表里有 ${dead.length} 个从不出现在的词：${dead.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 飞书提醒：哪些结论要叫人
// ---------------------------------------------------------------------------

test('「需要人」的结论词都在 VERDICTS 里，且恰好是那五个失败结论', () => {
  for (const word of VERDICTS_NEEDING_HUMAN) {
    assert.ok(VERDICTS.includes(word), `VERDICTS_NEEDING_HUMAN 里的 ${word} 不在 VERDICTS —— 拼错就是「永远不叫人」`);
  }
  // 反向钉死：成功的、排练的结论**一个都不许**进「需要人」——
  // 多进去一个的症状是「每跑一轮都发一条飞书」，那正是通知疲劳的成因。
  const quiet = VERDICTS.filter((v) => !VERDICTS_NEEDING_HUMAN.includes(v));
  assert.deepEqual([...quiet].sort(), [
    'ALREADY_LOGGED_IN', 'LOGGED_IN', 'READY_TO_GESTURE', 'READY_TO_SUBMIT',
  ]);
});

test('shouldNotify：只有「真的试过了并且没成」才默认叫人', () => {
  // 默认 auto：没带 --commit 的只读排练撞到登录墙**不惊动人**（排练不是一次尝试）
  assert.equal(shouldNotify({ verdict: 'NO_SAVED_CREDENTIAL', commit: false, mode: 'auto' }), false);
  assert.equal(shouldNotify({ verdict: 'NO_SAVED_CREDENTIAL', commit: true, mode: 'auto' }), true);
  // 成功与排练结论：任何模式都不发
  for (const mode of NOTIFY_MODES) {
    assert.equal(shouldNotify({ verdict: 'LOGGED_IN', commit: true, mode }), false, `${mode} 不该为 LOGGED_IN 发`);
    assert.equal(shouldNotify({ verdict: 'READY_TO_SUBMIT', commit: true, mode }), false, `${mode} 不该为 READY_TO_SUBMIT 发`);
  }
  // 显式要求：演练时要能发出去（哪怕没带 --commit）
  assert.equal(shouldNotify({ verdict: 'CAPTCHA_REQUIRED', commit: false, mode: 'send' }), true);
  assert.equal(shouldNotify({ verdict: 'CAPTCHA_REQUIRED', commit: false, mode: 'dry' }), true);
  // off 是彻底的闭嘴
  assert.equal(shouldNotify({ verdict: 'CAPTCHA_REQUIRED', commit: true, mode: 'off' }), false);
  // 未登记的结论词一律不发（fail-closed：宁可少叫，不可乱叫）
  assert.equal(shouldNotify({ verdict: 'TYPO_VERDICT', commit: true, mode: 'auto' }), false);
});

test('parseArgs：--notify 默认 auto，取值受词表约束', () => {
  assert.equal(parseArgs([], DEFAULTS).notify, 'auto');
  assert.equal(parseArgs(['--notify', 'dry'], DEFAULTS).notify, 'dry');
  assert.throws(() => parseArgs(['--notify', 'yes'], DEFAULTS), /Unknown --notify yes/u);
  assert.throws(() => parseArgs(['--notify'], DEFAULTS), /--notify requires a value/u);
  assert.deepEqual([...NOTIFY_MODES].sort(), ['auto', 'dry', 'off', 'send']);
});

test('buildLoginAlert：拿到「不需要人」的结论就抛，不生成一条不该有的告警', () => {
  assert.throws(() => buildLoginAlert({ verdict: 'LOGGED_IN' }), /不需要人处理/u);
  assert.throws(() => buildLoginAlert({ verdict: 'ALREADY_LOGGED_IN' }), /不需要人处理/u);
});

test('告警真渲染一遍：链接、机器、浏览器配置、下一步都在（键名写错会被白名单静默丢掉）', () => {
  const alert = buildLoginAlert({
    verdict: 'NO_SAVED_CREDENTIAL',
    detail: '这个窗口的密码库里没有这家店的密码',
    sites: ['sycm', 'alimama'],
    shopName: '里可林家居:阿彦',
    machine: 'DEPLOY-01',
    browserProfile: 'D:/Retire/edge-profiles/likelin-home',
    now: () => new Date('2026-09-18T14:30:00+08:00'),
  });
  const rendered = renderAlertText(alert);
  assert.match(rendered, /【需要处理】/u, 'severity=ERROR 必须渲染成「需要处理」而不是「提示」');
  // 2026-09-18：标题改成自带店名的人话（用户反馈「太笼统」），不再借用通用标题表的「平台登录已失效」
  assert.match(rendered, /【需要处理】里可林家居:阿彦 需要你登录一次/u);
  assert.match(rendered, /打开这个链接：https:\/\/login\.taobao\.com\//u,
    '必须给出可点的登录入口 —— 只说「登录已失效」，收信人还得先自己找入口');
  assert.match(rendered, /对象：生意参谋 \/ 阿里妈妈/u, '站点没渲染出来');
  assert.match(rendered, /机器：DEPLOY-01/u, '缺了「哪台机器」，收信人还得先找机器');
  assert.match(rendered, /浏览器配置：D:\/Retire\/edge-profiles\/likelin-home/u, '缺了「哪个配置」，人不知道该动哪个浏览器');
  assert.match(rendered, /原因：这个浏览器里没有存这家店的账号密码/u, '「原因」要写人话，不是结论代号');
  assert.match(rendered, /下一步：.+人工登录一次/u, '「下一步」必须是一句能照着做的事');
});

test('告警文案里不许出现结论代号与内部术语（用户 2026-09-18：「不要讲一堆术语」）', () => {
  const jargon = ['会话', '判据', '风控', '幂等', 'fail-closed', 'capability', 'sycm.alimama.daily'];
  for (const verdict of VERDICTS_NEEDING_HUMAN) {
    const rendered = renderAlertText(buildLoginAlert({
      verdict, sites: ['sycm', 'alimama'], shopName: '某店:阿彦', machine: 'M', browserProfile: 'P',
    }));
    assert.equal(rendered.includes(verdict), false, `${verdict} 这个结论代号不该出现在收信人看得到的文案里`);
    for (const word of jargon) {
      assert.equal(rendered.includes(word), false, `${verdict} 的文案里出现了内部术语「${word}」`);
    }
    assert.match(rendered, /https:\/\//u, `${verdict} 的文案里没有可点的链接`);
  }
});

test('每个「要叫人」的结论都必须有自己的原因和下一步——漏一个就会悄悄退化成兜底文案', () => {
  for (const verdict of VERDICTS_NEEDING_HUMAN) {
    const alert = buildLoginAlert({ verdict, sites: ['sycm'] });
    assert.notEqual(alert.reason, '这一步需要人来做。', `${verdict} 没有专属的「原因」文案`);
    assert.notEqual(alert.action, '人工处理后再跑这一轮。', `${verdict} 没有专属的「下一步」文案`);
  }
});

test('loginUrlFor：只缺一个站点时给那个后台，两个都缺时给淘宝登录页', () => {
  assert.match(loginUrlFor(['sycm']), /sycm\.taobao\.com/u);
  assert.match(loginUrlFor(['alimama']), /one\.alimama\.com/u);
  assert.match(loginUrlFor(['sycm', 'alimama']), /login\.taobao\.com/u);
  assert.match(loginUrlFor([]), /login\.taobao\.com/u, '认不出站点时退到「一次登录管两个」的那个入口');
  assert.match(loginUrlFor(['不认识']), /login\.taobao\.com/u);
});

test('告警里不含任何凭据面：没有密码/账号字段，也没有登录表单的状态', () => {
  const alert = buildLoginAlert({
    verdict: 'CAPTCHA_REQUIRED', detail: '出现滑块', sites: ['sycm'], machine: 'M', browserProfile: 'P',
  });
  const flat = JSON.stringify(alert);
  for (const forbidden of ['password', 'fm-login', 'credential', 'autofill', 'valueLen', 'idLen']) {
    assert.equal(flat.includes(forbidden), false, `告警里出现了 ${forbidden} —— 凭据面不许进通知`);
  }
  // 只允许白名单里的 source 键（多出来的会被渲染器丢掉，等于白填）
  assert.deepEqual(Object.keys(alert.source).sort(),
    ['browserProfile', 'loginUrl', 'machine', 'shopName', 'targetLabel']);
});

test('alertId 是「同站点同一天一条」——它是去重的锚，不能每次都变', () => {
  const at = (iso) => buildLoginAlert({
    verdict: 'CAPTCHA_REQUIRED', sites: ['sycm'], now: () => new Date(iso),
  }).alertId;
  assert.equal(at('2026-09-18T09:00:00+08:00'), at('2026-09-18T23:59:00+08:00'));
  assert.notEqual(at('2026-09-18T23:59:00+08:00'), at('2026-09-19T00:01:00+08:00'));
  assert.equal(at('2026-09-18T09:00:00+08:00'), 'sycm-login-sycm-20260918');
});

test('主脚本确实把通知接到了失败路径上（不是只写了两个导出函数）', () => {
  const source = readFileSync(new URL('./login-merchant.mjs', import.meta.url), 'utf8');
  // 只检查**代码**：注释里出现某个名字不代表代码里调了它。
  // 这一条踩过：写了一句「拼装留在 alertForRun 里」的注释，结果把下面的
  // `buildLoginAlert === false` 判成了红 —— 判据被注释左右就是假红。
  const code = source.replace(/^\s*\/\/.*$/gmu, '');
  assert.ok(code.includes('alertForRun'), '主脚本没走 core 的 alertForRun ⇒ 判定与装配会重新散回 IO 里，离线再也守不住');
  // 2026-09-18：装配搬进 core 之后，主脚本**不该**再自己拼告警 ——
  // 之前正是「主脚本自己拼」造成了「buildLoginAlert 支持店名、主脚本没传店名」这个缺陷。
  assert.equal(code.includes('buildLoginAlert'), false,
    '主脚本又在自己拼告警了；拼装必须留在 core 的 alertForRun 里，否则「接线接对了没有」离线测不到');
  assert.ok(code.includes('shops: SHOP_BROWSERS'),
    '主脚本没把真登记表交给告警装配 ⇒ 某家店会静默落回共用的日报 profile（这正是修掉的那个缺陷）');
  assert.ok(code.includes('notify-feishu.mjs'), '主脚本没走既有的通知出口（不该另造投递链）');
  // 通知必须发生在打印之前，否则收据里看不到「发没发出去」
  const notifyAt = code.indexOf('await deliverAlert(args, finalReceipt)');
  const printAt = code.indexOf('console.log(JSON.stringify(finalReceipt, null, 1))');
  assert.ok(notifyAt > 0 && printAt > notifyAt, '通知必须在打印收据之前完成');
});

// ---------------------------------------------------------------------------
// 「告警点名是哪一家店」—— 2026-09-18 用户亲自撞到的缺陷
// ---------------------------------------------------------------------------
//
// 现场：飞书收到「需要你登录一次」，但收信人不知道是哪家店；打开浏览器，
// 四个窗口看起来一模一样，而且都停在未登录。根因不是文案写得不清楚，
// 而是**主脚本压根没把店名传进 buildLoginAlert** —— 契约早就支持，接线没接上。
// 下面这组判据落在 `alertForRun` 这个纯函数上，让「接线接对了没有」变成行为可断言的事。
test('alertForRun：带 --shop 时，告警必须点名是哪一家店', () => {
  const alert = alertForRun({
    args: { shop: '盖文淘宝', sites: ['sycm', 'alimama'], commit: true, notify: 'auto' },
    receipt: { verdict: 'NO_SAVED_CREDENTIAL', detail: '这台浏览器里没有存这家店的账号密码。' },
    machine: 'DEPLOY-01',
    shops: SHOP_BROWSERS,
    fallbackProfile: 'D:/Retire/edge-daily-report-profile',
    now: () => new Date('2026-09-18T11:02:00+08:00'),
  });
  assert.ok(alert, '「真的试过且没成」却不发告警');
  assert.match(rendered(alert), /盖文淘宝 需要你登录一次/u, '标题没点名店铺 —— 收信人无法据此行动');
  assert.match(rendered(alert), /店铺：盖文淘宝/u, '正文里没有独立的「店铺」一行');
  assert.match(rendered(alert), /浏览器配置：D:\/Retire\/edge-profiles\/suixin-custom/u,
    '浏览器配置必须是这家店自己的 profile；写成日报那个 profile 等于四个窗口长得一样，等于没给');
});

test('alertForRun：没给 --shop 时行为与加店名之前逐字相同（旧来源不受影响）', () => {
  const alert = alertForRun({
    args: { sites: ['sycm', 'alimama'], commit: true, notify: 'auto' },
    receipt: { verdict: 'NO_SAVED_CREDENTIAL' },
    fallbackProfile: 'D:/Retire/edge-daily-report-profile',
    now: () => new Date('2026-09-18T11:02:00+08:00'),
  });
  assert.equal(alert.title, '需要你登录一次');
  assert.equal(alert.source.shopName, null);
  assert.equal(alert.source.browserProfile, 'D:/Retire/edge-daily-report-profile', '没给店名时才回落到日报那个 profile');
  assert.equal(alert.alertId, 'sycm-login-sycm-alimama-20260918', '缺店名时 alertId 必须保持旧格式');
  assert.equal(rendered(alert).includes('店铺：'), false, '没有店名时不该多出一行空的「店铺：」');
});

test('profileForShop：四家店各自指向自己的 profile，谁也不是日报那个', () => {
  const profileOf = (shop) => profileForShop({ shop, shops: SHOP_BROWSERS, fallback: 'D:/Retire/edge-daily-report-profile' });
  const profiles = Object.keys(SHOP_BROWSERS).map(profileOf);
  assert.equal(new Set(profiles).size, Object.keys(SHOP_BROWSERS).length,
    `四家店的 profile 必须互不相同，实际：${profiles.join(' / ')}`);
  assert.equal(profiles.includes('D:/Retire/edge-daily-report-profile'), false,
    '有一家店落回了共用 profile —— 收信人按这个路径去找，四个窗口长得一模一样');
  assert.equal(profileOf('盖文淘宝'), SHOP_BROWSERS['盖文淘宝'].profile);
});

test('profileForShop：fail-closed —— 给了店名却拿不到登记表，宁可抛错也不回落成共用 profile', () => {
  // 这一条是「忘传参数就静默退回全体共用」那条通道的封条：
  // 回落不会报错，只会让四家店的告警长得一模一样 —— 静默比抛错坏得多。
  assert.throws(() => profileForShop({ shop: '盖文淘宝', shops: null }), /不回落成共用 profile/u);
  assert.throws(() => profileForShop({ shop: '不存在的店', shops: SHOP_BROWSERS }),
    /未登记的店铺实例「不存在的店」/u);
  assert.equal(profileForShop({ shop: null, shops: SHOP_BROWSERS, fallback: 'F' }), 'F', '没给店名时才回落');
});

test('alertForRun：该安静的时候必须安静（判定在 core 里，不散在 IO 里）', () => {
  const send = (args, verdict) => alertForRun({ args: { sites: ['sycm'], ...args }, receipt: { verdict } });
  assert.equal(send({ commit: false, notify: 'auto' }, 'NO_SAVED_CREDENTIAL'), null, '只读排练撞到登录墙不该叫人');
  assert.equal(send({ commit: true, notify: 'off' }, 'NO_SAVED_CREDENTIAL'), null, '--notify off 就该完全闭嘴');
  assert.equal(send({ commit: true, notify: 'auto' }, 'LOGGED_IN'), null, '登录成功了不该叫人');
  assert.equal(send({ commit: true, notify: 'auto' }, 'ALREADY_LOGGED_IN'), null);
  assert.ok(send({ commit: true, notify: 'auto' }, 'PARTIAL'), '四家店里真有一家没登进去时，必须叫人');
});

test('alertId 含店名：五家店同一天必须是五条锚，不能共用一条（共用会被去重吞掉四家）', () => {
  const idOf = (shop) => alertForRun({
    args: { shop, sites: ['sycm', 'alimama'], commit: true, notify: 'auto' },
    receipt: { verdict: 'NO_SAVED_CREDENTIAL' },
    shops: SHOP_BROWSERS,
    now: () => new Date('2026-09-18T11:02:00+08:00'),
  }).alertId;
  const ids = ['里可林淘宝', '网林天猫', '盖文淘宝', '科塔淘宝'].map(idOf);
  assert.equal(new Set(ids).size, 4, `四家店的 alertId 必须互不相同，实际：${ids.join(' / ')}`);
  assert.match(ids[2], /盖文淘宝/u);
});

test('「原因」不许读两遍：主脚本补的 detail 不能把静态原因整句再说一遍', () => {
  // 渲染出来才发现的缺陷（2026-09-18）：
  //   「原因：这个浏览器里没有存这家店的账号密码，系统没法自动填。 这台浏览器里没有存这家店的账号密码，系统没法自动填。…」
  // 静态原因与 detail 各自都通顺，合起来才是病 —— 所以判据必须在**拼好之后**看。
  const code = readFileSync(new URL('./login-merchant.mjs', import.meta.url), 'utf8');
  const details = [...code.matchAll(/receipt\.detail = '([^']+)'/gu)].map((m) => m[1]);
  assert.ok(details.length >= 4, `从主脚本里只抓到 ${details.length} 条 detail，这条判据会空转`);
  for (const detail of details) {
    for (const reason of Object.values(REASON_BY_VERDICT)) {
      assert.equal(detail.includes(reason), false,
        `detail 把静态原因整句重说了一遍（渲染出来「原因」就是同一句话读两遍）：${detail}`);
    }
  }
});

test('告警里不许让人去做收信人做不到的事（截图、本地路径、日志）', () => {
  // PARTIAL 原来写的是「按顺序先看截图再重跑」—— 截图落在**那台机器**的证据目录里，
  // 收信人在飞书里根本看不到它。这类文案比不写更坏：它让人以为少了东西。
  const code = readFileSync(new URL('./login-merchant.mjs', import.meta.url), 'utf8');
  for (const detail of [...code.matchAll(/receipt\.detail = '([^']+)'/gu)].map((m) => m[1])) {
    for (const word of ['截图', '证据目录', '日志', 'stdout', 'receipt', 'profile']) {
      assert.equal(detail.includes(word), false, `detail 让人去做收信人做不到的事（出现「${word}」）：${detail}`);
    }
  }
});

test('「下一步」必须能定位到哪一个窗口：用店名，而不是「上面那个窗口」', () => {
  // 用户原话：「我不知道是哪一个店铺的浏览器需要登录」。原文案「在上面那个浏览器窗口里」
  // 里的「上面那个」在告警里根本没有指代对象 —— 四台浏览器长得一模一样，人到了机器前还得猜。
  for (const verdict of VERDICTS_NEEDING_HUMAN) {
    const withShop = resolveAction(verdict, '科塔淘宝');
    assert.equal(withShop.includes('{窗口}'), false, `${verdict} 的占位符没被替换掉`);
    assert.equal(withShop.includes('上面那个'), false, `${verdict} 还在说「上面那个窗口」`);
    assert.match(withShop, /标题写着「科塔淘宝」的那个浏览器窗口/u, `${verdict} 的下一步没有落到具体窗口上`);
    const withoutShop = resolveAction(verdict, null);
    assert.equal(withoutShop.includes('{窗口}'), false, `${verdict} 无店名时占位符没被替换`);
    assert.equal(withoutShop.includes('标题写着'), false, `${verdict} 没店名时不该承诺「标题里写着」`);
  }
});

test('告警里那句「标题写着「X」」必须与窗口标题真的对得上（两条腿绑在一起）', () => {
  // 这两件事分开看都对，合起来才成立：告警让收信人去找「标题写着 X 的窗口」，
  // 而那个窗口的标题由 runtime/shop-window-label.mjs 写。任一边单独改了，指路就落空 ——
  // 而落空的症状是「照做也找不到窗口」，不会有任何报错。
  const alert = alertForRun({
    args: { shop: '盖文淘宝', sites: ['sycm'], commit: true, notify: 'auto' },
    receipt: { verdict: 'NO_SAVED_CREDENTIAL' },
    shops: SHOP_BROWSERS,
    now: () => new Date('2026-09-18T11:02:00+08:00'),
  });
  const promised = rendered(alert).match(/标题写着「(.+?)」/u)?.[1] ?? null;
  assert.equal(promised, '盖文淘宝', '告警没把店名写进指路里');
  assert.ok(windowTitleFor(promised).startsWith(promised),
    `窗口标题必须以告警承诺的那个店名开头，否则收信人按标题找不到窗口：${windowTitleFor(promised)}`);
});

test('parseArgs：--shop 是运营叫法，拼错当场抛错并列出全部合法值', () => {
  const SHOPS = ['里可林淘宝', '网林天猫', '盖文淘宝', '科塔淘宝'];
  const opts = parseArgs(['--shop', '盖文淘宝'], { ...DEFAULTS, shops: SHOPS });
  assert.equal(opts.shop, '盖文淘宝');
  assert.equal(parseArgs([], { ...DEFAULTS, shops: SHOPS }).shop, null, '默认不带店名，保持旧用法');
  assert.throws(() => parseArgs(['--shop', '盖文天猫'], { ...DEFAULTS, shops: SHOPS }),
    /Unknown --shop 盖文天猫 \(known: 里可林淘宝 \/ 网林天猫 \/ 盖文淘宝 \/ 科塔淘宝\)/u,
    '店名拼错必须当场抛错 —— 发一条带「不存在的店名」的告警，比不发更坏');
  assert.throws(() => parseArgs(['--shop'], DEFAULTS), /--shop requires a value/u);
});
