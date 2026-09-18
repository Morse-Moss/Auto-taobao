// 自动登录的离线用例。IO 全在 login-merchant.mjs，这里只测判据与纯函数 ——
// 理由和 collect-core.test.mjs 一样：判据错了不会报错，只会静默地「多做一件事」或「少做一件事」。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  FORM_STATE_EXPRESSION, LOGIN_TARGETS, SITES, VERDICTS,
  captchaVisible, centerOf, parseArgs, sitesNeedingLogin,
} from './login-merchant-core.mjs';

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
