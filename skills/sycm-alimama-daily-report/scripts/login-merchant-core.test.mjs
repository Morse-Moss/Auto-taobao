// 自动登录的离线用例。IO 全在 login-merchant.mjs，这里只测判据与纯函数 ——
// 理由和 collect-core.test.mjs 一样：判据错了不会报错，只会静默地「多做一件事」或「少做一件事」。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  FORM_STATE_EXPRESSION, LOGIN_TARGETS, NOTIFY_MODES, SITES, VERDICTS, VERDICTS_NEEDING_HUMAN,
  buildLoginAlert, captchaVisible, centerOf, needsHuman, parseArgs, shouldNotify, sitesNeedingLogin,
} from './login-merchant-core.mjs';
// 用**真的那份渲染器**去验告警文案：白名单是 notify-feishu-core 的，
// 键名写错时字段会被静默丢掉（告警照发，收信人看不到「哪台机器」）—— 那条只有真渲染才测得出来。
import { renderAlertText } from '../../../runtime/notify-feishu-core.mjs';

const DEFAULTS = { defaultProxy: 'http://127.0.0.1:19023' };

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

test('告警真渲染一遍：机器、浏览器配置、下一步都在（键名写错会被白名单静默丢掉）', () => {
  const alert = buildLoginAlert({
    verdict: 'NO_SAVED_CREDENTIAL',
    detail: '这个 profile 的密码库里没有该站点的凭据',
    sites: ['sycm', 'alimama'],
    machine: 'DEPLOY-01',
    browserProfile: 'D:/Retire/edge-daily-report-profile',
    now: () => new Date('2026-09-18T14:30:00+08:00'),
  });
  const rendered = renderAlertText(alert);
  assert.match(rendered, /【需要处理】/u, 'severity=ERROR 必须渲染成「需要处理」而不是「提示」');
  assert.match(rendered, /平台登录已失效/u, 'LOGIN_REQUIRED 的中文标题来自 notify 通道的标题表');
  assert.match(rendered, /机器：DEPLOY-01/u, '缺了「哪台机器」，收信人还得先找机器');
  assert.match(rendered, /浏览器配置：D:\/Retire\/edge-daily-report-profile/u, '缺了「哪个配置」，人不知道该动哪个浏览器');
  assert.match(rendered, /对象：生意参谋 \/ 阿里妈妈/u, '站点没渲染出来');
  assert.match(rendered, /任务：sycm\.alimama\.daily/u);
  assert.match(rendered, /下一步：.+人工登录一次/u, '「下一步」必须是一句能照着做的事');
  assert.match(rendered, /原因：这个 profile 的密码库里没有该站点的凭据/u);
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
    ['browserProfile', 'capability', 'machine', 'shopName', 'targetLabel']);
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
  assert.ok(source.includes('shouldNotify'), '主脚本没调 shouldNotify ⇒ 判定会退化成「每次都发」或「从不发」');
  assert.ok(source.includes('buildLoginAlert'), '主脚本没拼告警');
  assert.ok(source.includes('notify-feishu.mjs'), '主脚本没走既有的通知出口（不该另造投递链）');
  // 通知必须发生在打印之前，否则收据里看不到「发没发出去」
  const notifyAt = source.indexOf('await deliverAlert(args, finalReceipt)');
  const printAt = source.indexOf('console.log(JSON.stringify(finalReceipt, null, 1))');
  assert.ok(notifyAt > 0 && printAt > notifyAt, '通知必须在打印收据之前完成');
});
