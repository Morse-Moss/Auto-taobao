// 自动登录的离线用例。IO 全在 login-merchant.mjs，这里只测判据与纯函数 ——
// 理由和 collect-core.test.mjs 一样：判据错了不会报错，只会静默地「多做一件事」或「少做一件事」。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ATTEMPT_OUTCOMES, FILLED_VERDICTS, FORM_STATE_EXPRESSION, LOGIN_ID_VALUE_EXPRESSION,
  LOGIN_PAGE_PROMISED_VERDICTS, LOGIN_TARGETS, LOGIN_URL_CANDIDATES, NOTIFY_MODES, OUTCOME_TO_VERDICT,
  REASON_BY_VERDICT, SITES, TAOBAO_LOGIN_URL, VERDICTS, VERDICTS_NEEDING_HUMAN, absentSites, alertForRun,
  buildLoginAlert, captchaVisible, centerOf, detectLoginDetour, expectedMemberFor, finalLoginVerdict,
  isTaobaoLoginUrl, judgeFilled, judgeShopTarget, loggedOutSites, loginFormVisible, needsHuman, parseArgs,
  profileForShop, proxyPortOf, resolveAction, shopForProxy, shouldNotify, sitesNeedingLogin,
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

test('sitesNeedingLogin：只有「确认已登录」才算通过 —— 读不出来（null）一样要去处理', () => {
  // 2026-09-19 改的性质：这条用例原先断言 `{ sycm: null, alimama: true }` ⇒ []（什么都不用做），
  // 注释写的是「宁可少动，不可乱动」。现场后果是一个只剩 about:blank 的窗口
  // （刚起浏览器、两个后台的页面都还没开）被判成 ALREADY_LOGGED_IN：
  // 不叫人、不做事，连 `--commit` 都什么都不做 —— 而它的输出长得像「一切正常」。
  assert.deepEqual(sitesNeedingLogin({ sycm: { loggedIn: false }, alimama: { loggedIn: false } }), ['sycm', 'alimama']);
  assert.deepEqual(sitesNeedingLogin({ sycm: { loggedIn: true }, alimama: { loggedIn: false } }), ['alimama']);
  assert.deepEqual(sitesNeedingLogin({ sycm: { loggedIn: null }, alimama: { loggedIn: true } }), ['sycm'],
    '读不到 ≠ 已登录：要去看一眼（登录流程第一步本来就是打开页面，无害）');
  assert.deepEqual(sitesNeedingLogin({ sycm: { loggedIn: null }, alimama: { loggedIn: null } }), ['sycm', 'alimama'],
    '空窗口绝不能被判成「已登录」');
  assert.deepEqual(sitesNeedingLogin({ sycm: { loggedIn: undefined }, alimama: { loggedIn: true } }), ['sycm'],
    '缺字段同理：少一个字段不该等于「已登录」');
  assert.deepEqual(sitesNeedingLogin({ sycm: { loggedIn: true }, alimama: { loggedIn: true } }), []);
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

test('「需要人」的结论词都在 VERDICTS 里，且成功/排练的结论一个都不在里面', () => {
  for (const word of VERDICTS_NEEDING_HUMAN) {
    assert.ok(VERDICTS.includes(word), `VERDICTS_NEEDING_HUMAN 里的 ${word} 不在 VERDICTS —— 拼错就是「永远不叫人」`);
  }
  // 反向钉死：成功的、排练的结论**一个都不许**进「需要人」——
  // 多进去一个的症状是「每跑一轮都发一条飞书」，那正是通知疲劳的成因。
  // （这里断言的是**补集**，所以新增一个「要叫人」的失败结论不需要改这一行；
  //   测试名也刻意不再写死个数 —— 写死个数的话，加一个结论就要改一次名字，改着改着就没人看了。）
  const quiet = VERDICTS.filter((v) => !VERDICTS_NEEDING_HUMAN.includes(v));
  // `PAGES_ABSENT`（2026-09-24 加）属于这一侧，而且它是**刻意**在这一侧的：
  // 它说的是「这个窗口里没有它的页面」（读不到），不是「掉登录」。放进要叫人那一侧的症状
  // 已经实测过一次 —— 冷启动后的跑前预检连发 5 条飞书告警，而五家店只是页面还没归位。
  assert.deepEqual([...quiet].sort(), [
    'ALREADY_LOGGED_IN', 'LOGGED_IN', 'PAGES_ABSENT', 'READY_TO_GESTURE', 'READY_TO_SUBMIT',
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
  // `PAGES_ABSENT`（2026-09-24 加）：任何模式、任何档位都不许叫人 ——
  // 它是「窗口里没有它的页面」，下一步是等链第 0 步归位补页，不是让人去窗口里动手。
  for (const mode of NOTIFY_MODES) {
    assert.equal(shouldNotify({ verdict: 'PAGES_ABSENT', commit: true, mode }), false,
      `${mode} 不该为 PAGES_ABSENT 发：那是「读不到」，不是「掉登录」`);
  }
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

test('「读不到」与「被踢回登录页」必须能分开：前者不该被推成登录故障', () => {
  // 2026-09-24 的现场：浏览器刚起、窗口里一个后台页都没有（页面还没归位）。
  // 此前这一档会去开登录页 ⇒ 登录页被仍然有效的主站会话送走 ⇒ 报 MAIN_SESSION_ONLY
  // ⇒ 一次预检连发 5 条告警，而每一家其实只是页面不在。
  const absentBoth = { sycm: { loggedIn: null }, alimama: { loggedIn: null } };
  assert.deepEqual(absentSites(absentBoth), ['sycm', 'alimama']);
  assert.deepEqual(loggedOutSites(absentBoth), []);
  assert.deepEqual(sitesNeedingLogin(absentBoth), ['sycm', 'alimama'],
    '「要不要去登」仍然算要去看一眼（读不到不是已登录的证据）—— 这条旧语义不许被这次改动放宽');

  // 混合现场：一个实锤掉登录 + 一个读不到 ⇒ 两个判据各说各的，谁也不吞谁。
  // （主脚本靠「有没有 false」决定走不走登录流程，所以这里必须能分开。）
  const mixed = { sycm: { loggedIn: false }, alimama: { loggedIn: null } };
  assert.deepEqual(absentSites(mixed), ['alimama']);
  assert.deepEqual(loggedOutSites(mixed), ['sycm']);

  assert.deepEqual(absentSites({ sycm: { loggedIn: true }, alimama: { loggedIn: true } }), []);
  assert.deepEqual(loggedOutSites({ sycm: { loggedIn: true }, alimama: { loggedIn: false } }), ['alimama']);
  // 站点键缺失不算「读不到」：那是编程错误，不该被静默归进「页面不在」（那种归并会让闸门失灵）
  assert.deepEqual(absentSites({}), []);
  assert.deepEqual(absentSites(), []);
});

test('主脚本在进登录流程之前先判「页面不在」，且它不叫人（接线判据）', () => {
  // 为什么必须是**源码级**判据（2026-09-24）：这条闸门写在 IO 主流程里，
  // 而 IO 脚本离线跑不到 —— 只有「它确实排在登录流程之前」这件事能被读源码钉住。
  // 函数级用例全绿 ≠ 接线接上了：本仓库已经吃过一次（buildLoginAlert 支持店名，
  // 主脚本就是不传，契约齐、用例绿、告警里五家店一模一样）。
  const source = readFileSync(new URL('./login-merchant.mjs', import.meta.url), 'utf8');
  const absentAt = source.indexOf("receipt.verdict = 'PAGES_ABSENT'");
  const loginFlowAt = source.indexOf('for (const candidate of LOGIN_URL_CANDIDATES)');
  assert.ok(absentAt > 0, '主脚本里必须有 PAGES_ABSENT 这一支（否则冷启动后又会去开登录页 ⇒ 假红告警）');
  assert.ok(loginFlowAt > 0, '找不到登录流程的循环 —— 这条断言要跟着源码结构更新');
  assert.ok(loginFlowAt > absentAt, 'PAGES_ABSENT 必须判在**进登录流程之前**：判在之后就等于没挡');
  assert.match(source, /absent\.length > 0 && kickedOut\.length === 0/u,
    '判据是「有读不到 **且** 没有实锤掉登录」——少第二个条件会把真掉登录也一起挡掉');
  // 它不叫人：词表那一侧由 core 的用例钉住（PAGES_ABSENT 不在 VERDICTS_NEEDING_HUMAN），这里再钉一次。
  assert.equal(needsHuman('PAGES_ABSENT'), false);
});

test('buildLoginAlert：拿到「不需要人」的结论就抛，不生成一条不该有的告警', () => {
  assert.throws(() => buildLoginAlert({ verdict: 'LOGGED_IN' }), /不需要人处理/u);
  assert.throws(() => buildLoginAlert({ verdict: 'ALREADY_LOGGED_IN' }), /不需要人处理/u);
});

test('告警真渲染一遍：指路、机器、浏览器配置、下一步都在（键名写错会被白名单静默丢掉）', () => {
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
  // 2026-09-19：这里原先是「必须给出可点的登录入口」。那条规范被实测证伪，所以改成断言它的反面。
  assert.equal(/https?:\/\//u.test(rendered), false,
    '正文里不该再有链接：点 http 链接会跳到系统默认浏览器，到不了这个窗口');
  assert.match(rendered, /下一步：登录页已经开在标题写着「里可林家居:阿彦」的那个浏览器窗口/u,
    '入口改由脚本自己开 ⇒ 正文必须说清登录页开在哪个窗口、去那里做什么');
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
    // 2026-09-19：**文案里不许再出现链接**。
    // 这里原先断言的是「必须有 https://」——那条规范被实测证伪。用户原话：
    // 「我点了你发的链接直接跳到我的默认浏览器（QQ 浏览器）而不是目标浏览器」。
    // 点 http 链接走系统默认浏览器是 OS 行为，永远到不了目标 profile 的 Edge 实例；
    // 那条链接不但没用，还把人送进一个没有登录态的浏览器里。
    // 入口改由脚本自己开（登录页开在目标窗口并置前），正文只负责说清「去哪个窗口、做什么」。
    assert.equal(/https?:\/\//u.test(rendered), false,
      `${verdict} 的文案里又出现链接了 —— 点它会跳到默认浏览器，到不了目标窗口`);
    assert.match(rendered, /那个浏览器窗口/u,
      `${verdict} 的文案没告诉收信人去哪个窗口（用户：「你要让业务人员知道要干什么」）`);
  }
});

test('前三条结论必须承诺「登录页已经开在窗口里了」——入口由脚本开，不是让人自己找', () => {
  // 依据：这三条都是在登录流程里判出来的 ⇒ 登录页此刻一定还停在那一步（见 ensureLoginPage）。
  // 承诺错了会很糟：收信人跑过去发现没有登录页，下一次就不信这条提醒了。
  for (const verdict of ['NO_SAVED_CREDENTIAL', 'CAPTCHA_REQUIRED', 'LOGIN_NOT_CONFIRMED']) {
    assert.match(resolveAction(verdict, '盖文淘宝'), /登录页已经开在标题写着「盖文淘宝」的那个浏览器窗口/u,
      `${verdict} 没承诺「登录页已经开好」，收信人还得自己找入口`);
  }
  // 这几条不承诺：PARTIAL 是提交后已经跳走、STOP_AND_ALERT 可能停在打开页面那一步，
  // MAIN_SESSION_ONLY 恰恰是「登录页被送走了」判出来的 —— 承诺「登录页开着」会当场自相矛盾。
  for (const verdict of ['PARTIAL', 'STOP_AND_ALERT', 'MAIN_SESSION_ONLY']) {
    assert.equal(resolveAction(verdict, '盖文淘宝').includes('登录页已经开在'), false,
      `${verdict} 不该承诺登录页开着 —— 它会把人骗到一台没有登录页的窗口前`);
  }
});

test('每个「要叫人」的结论都必须有自己的原因和下一步——漏一个就会悄悄退化成兜底文案', () => {
  for (const verdict of VERDICTS_NEEDING_HUMAN) {
    const alert = buildLoginAlert({ verdict, sites: ['sycm'] });
    assert.notEqual(alert.reason, '这一步需要人来做。', `${verdict} 没有专属的「原因」文案`);
    assert.notEqual(alert.action, '人工处理后再跑这一轮。', `${verdict} 没有专属的「下一步」文案`);
  }
});

test('告警对象里不许再带 loginUrl —— 那条链接只会把人带到默认浏览器', () => {
  // 2026-09-19 改。原先这条用例断言的是 `loginUrlFor` 的取值（只缺一个站点给哪个后台、
  // 两个都缺退到淘宝登录页）。它证明了「链接拼得对」，却**证明不了链接有用** ——
  // 实测发现点它到不了目标 Edge 实例（走的是系统默认浏览器），所以函数与字段一起删了。
  // 现在改成正向的反回退判据：这个字段一旦被加回来就红。
  const alert = buildLoginAlert({
    verdict: 'CAPTCHA_REQUIRED', sites: ['sycm', 'alimama'], machine: 'M', browserProfile: 'P',
  });
  assert.equal('loginUrl' in alert.source, false, '告警 source 里又出现了 loginUrl');
  assert.equal(JSON.stringify(alert).includes('loginUrl'), false, '告警里又出现了 loginUrl');
  assert.equal(JSON.stringify(alert).includes('http'), false, '告警里又出现了 URL —— 链接在这个场景下只会帮倒忙');
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
  // 2026-09-19：`loginUrl` 已从这条契约里去掉（点链接到不了目标窗口，见上面那条用例）。
  assert.deepEqual(Object.keys(alert.source).sort(),
    ['browserProfile', 'machine', 'shopName', 'targetLabel']);
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
// 「窗口必须被置前」—— 2026-09-19 用户反馈「你要让业务人员知道要干什么」
// ---------------------------------------------------------------------------
// 告警正文承诺「登录页已经开在标题写着 X 的那个窗口里了」。这句话要成立，必须同时满足两件事：
//   ① 登录页真的开在那个窗口里（登录流程本来就会开）；
//   ② 那个窗口在**前台** —— 否则人在任务栏里翻半天，等于没告诉他。
// ② 原先被 `if (args.shots)` 挡着：多店铺驱动不传 --shots ⇒ 从来没置过前。
// 这条只能读源码（IO 部分没法离线跑），所以按「剥注释再匹配」的老规矩来。
test('主脚本必须无条件把登录窗口置前（不是只在 --shots 时才前置）', () => {
  const source = readFileSync(new URL('./login-merchant.mjs', import.meta.url), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gmu, '');
  assert.ok(code.includes('bringToFront'),
    '主脚本根本没置前 ⇒ 告警说的「去那个窗口」全靠人自己翻任务栏');
  assert.equal(/if \(args\.shots\)[^\n]*bringToFront/u.test(code), false,
    'bringToFront 又被 --shots 包起来了 ⇒ 多店铺驱动不传 --shots，失败交人时窗口还留在后台');
  // 置前必须发生在打开/复用登录页之后 —— 那时候才拿得到 targetId
  const openedAt = code.indexOf('ensureLoginPage');
  const frontAt = code.indexOf('bringToFront');
  assert.ok(openedAt > 0 && frontAt > openedAt, '置前必须在拿到登录页 target 之后');
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
  // 两种写法都收：单引号字面量**与模板串**。
  // 先前只收单引号，于是「新加的那几条 detail 正好绕开这条判据」—— 判据就成了摆设（2026-09-23 修）。
  const details = [...code.matchAll(/receipt\.detail\s*=\s*(?:'([^']*)'|`([^`]*)`)/gu)].map((m) => m[1] ?? m[2]);
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
  const details = [...code.matchAll(/receipt\.detail\s*=\s*(?:'([^']*)'|`([^`]*)`)/gu)].map((m) => m[1] ?? m[2]);
  assert.ok(details.length >= 4, `从主脚本里只抓到 ${details.length} 条 detail，这条判据会空转`);
  for (const detail of details) {
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

// ---------------------------------------------------------------------------
// 「登录页被送走」这一种（2026-09-19 加）
//
// 起因是 19033 上实测出来的一个**假事实**：淘宝主站会话还有效时，打开顶层登录页会被直接
// 送去卖家后台（落到 myseller.taobao.com/home.htm/QnworkbenchHome/），页面上没有输入框
// ⇒ 原先那句「拿不到 :autofill」把它判成 NO_SAVED_CREDENTIAL，而告警让人去点浏览器提示里的
// 「保存密码」。密码库里凭据是有的，缺的是这两个后台自己的会话 —— 收信人照着做，问题不会好。
// 报错文案是收信人唯一看到的解释，说错解释比不说更贵。
// ---------------------------------------------------------------------------

test('isTaobaoLoginUrl：对着实测的登录页与被送走后的落点各判一次', () => {
  // 实测：ensureLoginPage 用的就是这条 URL；被送走后落到千牛工作台。
  assert.equal(isTaobaoLoginUrl('https://login.taobao.com/havanaone/login/login.htm?bizName=taobao'), true);
  assert.equal(isTaobaoLoginUrl('https://login.taobao.com/member/login.jhtml?style=mini'), true);
  assert.equal(isTaobaoLoginUrl('https://myseller.taobao.com/home.htm/QnworkbenchHome/'), false,
    '落到千牛工作台就是「被送走了」 —— 这一条不成立的话，新判据永远不触发');
  assert.equal(isTaobaoLoginUrl('https://one.alimama.com/index.html'), false);
  assert.equal(isTaobaoLoginUrl(null), false, '读不到地址不能算「还在登录页上」——那会让真失败被当成正常');
  assert.equal(isTaobaoLoginUrl(undefined), false);
});

test('登录页被送走必须单独成一类：动作是「去打开那两个后台」，不是「去点保存密码」', () => {
  assert.ok(VERDICTS.includes('MAIN_SESSION_ONLY'));
  assert.equal(needsHuman('MAIN_SESSION_ONLY'), true, '这一类只能人来做，不叫人就等于停在这里没人知道');
  const action = resolveAction('MAIN_SESSION_ONLY', '盖文淘宝');
  assert.match(action, /生意参谋/u, '要说清是哪一个后台要登（只说「后台」收信人还得自己试两个）');
  assert.match(action, /阿里妈妈/u);
  assert.match(action, /标题写着「盖文淘宝」的那个浏览器窗口/u, '仍然要用店名定位窗口');
  assert.equal(action.includes('保存密码'), true, '「保存密码」这一步仍然要做（下次才能自动填）');
  const reason = REASON_BY_VERDICT.MAIN_SESSION_ONLY;
  assert.match(reason, /主站/u, '原因要交代「为什么登录页没进来」');
  assert.equal(reason.includes('没有存'), false, '原因里不许再写「没存账号密码」——那正是被证伪的旧解释');
});

test('detectLoginDetour：还在登录页 ⇒ 不绕路；被送去卖家后台 ⇒ 报这一类', () => {
  assert.equal(detectLoginDetour('https://login.taobao.com/havanaone/login/login.htm?bizName=taobao'), null,
    '还停在登录页上就不该报「被送走」—— 误报会让本来能自动填的流程停下来等人');
  const detour = detectLoginDetour('https://myseller.taobao.com/home.htm/QnworkbenchHome/');
  assert.equal(detour?.verdict, 'MAIN_SESSION_ONLY');
  assert.equal(detour?.host, 'myseller.taobao.com', '详情要能说出「落到哪儿了」，那是收信人唯一能核对的证据');
  // 反向：读不到地址**不下结论**（缺证据不是证据）—— 顺手判成「主站会话还在」就是又一个假事实。
  for (const empty of [null, undefined, '', '   ']) {
    assert.equal(detectLoginDetour(empty), null, `href=${JSON.stringify(empty)} 时不该下结论`);
  }
});

test('主脚本必须真的会用新判据，且「还在不在登录页」只有一个解释点', () => {
  const source = readFileSync(new URL('./login-merchant.mjs', import.meta.url), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gmu, '');
  assert.ok(code.includes('detectLoginDetour('),
    '判定只写在 core 里、主脚本不调它 ⇒ 这一类永远不触发（判据齐全但没人用，是最难发现的一种空转）');
  assert.ok(code.includes('isTaobaoLoginUrl('), '「提交后有没有离开登录页」也必须用 core 那份');
  // 反回退：主脚本里不许再内联一份「是不是淘宝登录页」的正则。
  assert.equal(/\/login\\\.taobao\\\.com/u.test(code), false,
    '主脚本又内联了一份登录页正则 —— 两处口径迟早各自漂移，而漂移的表现是同一现场两个结论');
});

// ---------------------------------------------------------------------------
// 候选登录地址（2026-09-23）：用户那句「做不到自动登录吗？？？」的正解
// ---------------------------------------------------------------------------
//
// 现场（`evidence/login-blocker-probe-2026-09-23/`）：盖文天猫那台**注定**填不上 ——
// Chromium 的自动填充按 **origin** 匹配，而它密码库里那条凭据的 origin 是
// `havanalogin.taobao.com`，脚本固定打开的那条是 `login.taobao.com`。
// 所以正解不是「换一条地址」（会把本来能登的机器弄坏），而是**一组候选、逐条试到能填为止**。
// 下面这组用例钉住的是「这组候选够不够用」与「逐条试的取舍有没有写错」——
// 两件事都不会报错，只会静默地少登一家店、或者把人引到错的动作上。
// ---------------------------------------------------------------------------

test('候选地址表：第一条必须是实测命中率最高的那条，且 id 唯一、每条都被认成登录页', () => {
  const list = LOGIN_URL_CANDIDATES;
  assert.ok(list.length >= 2, '只有一条候选 ⇒ 又回到「固定开一条、必然有机器填不上」的形态');
  // 2026-09-23 真机对照矩阵（复制 profile + 一次性实例 + 25ms 采样）。
  // **数字只认 `evidence/login-candidate-loop-2026-09-23/raw/` 里留档的原始输出**，
  // 逐格对应见该目录 `raw/INDEX.md`（每份输出的「导航 → …」那一行才说明它真的打开了哪条地址）：
  //   havanaone/login/login.htm?bizName=taobao   里可林 ✓ 网林 ✓ 科塔 ✓              → 3/3
  //   member/login.jhtml                         里可林 ✓ 商家 ✓ 盖文天猫 ✗          → 2/3
  // 所以第一条必须是 3/3 的那条。把它换成 `member/login.jhtml` **不会报错**，
  // 只会让盖文天猫那类机器每次都先从「实测填不上的那条」开始试，白付一次打开+点击。
  assert.equal(list[0].url, 'https://login.taobao.com/havanaone/login/login.htm?bizName=taobao',
    '第一条不再是实测命中率最高的那条地址 —— 逐条试的代价就从「偶尔」变成「每次」');
  assert.equal(list[0].url, TAOBAO_LOGIN_URL, 'TAOBAO_LOGIN_URL 必须仍等于第一条（旧调用方的语义）');
  assert.equal(list[1].url, 'https://login.taobao.com/member/login.jhtml',
    '第二条要留 `member/login.jhtml` —— 它在两个 profile 上确实成功过，是「第一条改版」时的覆盖');
  const ids = list.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, `候选 id 必须唯一：${ids.join(' / ')}`);
  for (const c of list) {
    assert.match(c.url, /^https:\/\//u, `${c.id} 必须是 https`);
    assert.equal(isTaobaoLoginUrl(c.url), true,
      `${c.id} 自己都不被认成登录页 ⇒ 这条候选永远走不到（而「走不到」不会报错）`);
  }
});

test('候选表必须落在 login.taobao.com 上，且不得把已被证伪的 havanalogin 塞回来', () => {
  // 这一条是**反向判据**，钉住的是一次实测证伪：原先的候选表里有
  // `https://havanalogin.taobao.com/mini_login.htm?...`，理由是「盖文天猫的凭据存在那个 origin 上」。
  // 真机对照推翻了它：商家浏览器里那条 `signon_realm=https://havanalogin.taobao.com/`、
  // `times_used=11` 的凭据，**开在它自己的 origin 上也不填**（`:autofill` 恒 false）。
  // 也就是说那条不是「还没试过的备选」，是死路；留着会让每台机器白付一次打开+点击，
  // 还会让失败文案继续把人引向「去那个页面保存密码」这个无效动作。
  const hosts = LOGIN_URL_CANDIDATES.map((c) => new URL(c.url).host);
  assert.ok(hosts.includes('login.taobao.com'), '候选表里没有 login.taobao.com —— 那就没有一条实测能填的地址了');
  assert.equal(hosts.includes('havanalogin.taobao.com'), false,
    'havanalogin.taobao.com 又回到候选表里了 —— 它在 2026-09-23 的对照里是「同源凭据也不填」的那一条');
});

test('isTaobaoLoginUrl：按 URL 结构判，不再靠「子串巧合」', () => {
  // 注意这条**不是**在给 `havanalogin` 那条地址背书：它已经从候选表里删掉了
  // （实测同源也不填，见上面那条反向判据）。这个函数回答的是另一个问题 ——
  // 「当前这一页是不是淘宝登录页」（可能来自平台的跳转，不是我们打开的），
  // 那个问题里它仍然是登录页，所以必须认。
  assert.equal(isTaobaoLoginUrl('https://havanalogin.taobao.com/mini_login.htm?lang=zh_cn&appName=taobao'), true,
    'havanalogin 上那一页确实是淘宝登录页 —— 认不出它会让「被送走/停在登录页」这类判据失灵');
  // 这一条是**旧判据的假命中**：`/login\.taobao\.com\/.*login/u` 会把它判成 true
  // （字符串里恰好有 `login.taobao.com/member/login`），而它其实是一台别的主机。
  // 归属按结构判、不按子串 includes —— 这是全仓的纪律，改完行为在实测地址上逐字不变。
  assert.equal(isTaobaoLoginUrl('https://xlogin.taobao.com/member/login.jhtml'), false,
    '旧判据在这里假命中；按 host 判就不会');
  // 主机对、路径不像登录页 ⇒ 不算（否则「被送走了」这条判据永远判不出来）
  assert.equal(isTaobaoLoginUrl('https://login.taobao.com/'), false);
  assert.equal(isTaobaoLoginUrl('https://havanalogin.taobao.com/'), false);
});

test('loginFormVisible：两个框都真的占了位，才算「这一页有表单」', () => {
  assert.equal(loginFormVisible({ id: { visible: true }, password: { visible: true } }), true);
  assert.equal(loginFormVisible({ id: { visible: true }, password: { visible: false } }), false,
    '只有一个框 ⇒ 页面还没准备好，点它就是「在没准备好的页面上乱点」（而这一页点错不报错）');
  assert.equal(loginFormVisible({ id: { visible: true } }), false, '缺字段不能当成可见');
  assert.equal(loginFormVisible(null), false);
  assert.equal(loginFormVisible({}), false);
});

test('每个现场都有唯一的一条结论 —— 少映射一个就是「回执里没有结论」', () => {
  assert.equal(Object.keys(OUTCOME_TO_VERDICT).length, ATTEMPT_OUTCOMES.length,
    '两边词数不一致 ⇒ 迟早漏掉一个现场，而漏掉的那个会静默落进兜底');
  for (const word of ATTEMPT_OUTCOMES) {
    assert.ok(VERDICTS.includes(OUTCOME_TO_VERDICT[word]), `${word} 映射到了未登记的结论词`);
    assert.equal(finalLoginVerdict([{ outcome: word }]).verdict, OUTCOME_TO_VERDICT[word]);
  }
});

test('finalLoginVerdict：五选一的优先级，以及「该把人送到哪一页」', () => {
  // 一条记录都没有 ⇒ 这一层**没有结论**，不许猜
  assert.deepEqual(finalLoginVerdict([]),
    { verdict: 'STOP_AND_ALERT', outcome: null, stoppedAt: null, parkOnLoginPage: false });
  assert.equal(finalLoginVerdict([{ outcome: '没这个词' }]).verdict, 'STOP_AND_ALERT');

  const only = (outcome, extra = {}) => [{ id: 'havanaone', url: 'U1', outcome, ...extra }];
  assert.equal(finalLoginVerdict(only('WRONG_ACCOUNT')).verdict, 'WRONG_ACCOUNT');
  assert.equal(finalLoginVerdict(only('DETOUR')).verdict, 'MAIN_SESSION_ONLY');
  assert.equal(finalLoginVerdict(only('NO_VALUE_LANDED')).verdict, 'NO_SAVED_CREDENTIAL');
  assert.equal(finalLoginVerdict(only('NO_AUTOFILL')).verdict, 'NO_SAVED_CREDENTIAL');
  assert.equal(finalLoginVerdict(only('NO_FORM')).verdict, 'STOP_AND_ALERT');

  // 「登成了别人」压过其余一切 —— 它是唯一一条做错了也不报错的（数字看起来都对，其实属于别家）
  const picked = finalLoginVerdict([
    { id: 'a', url: 'UA', outcome: 'NO_AUTOFILL' },
    { id: 'b', url: 'UB', outcome: 'WRONG_ACCOUNT' },
    { id: 'c', url: 'UC', outcome: 'NO_FORM' },
  ]);
  assert.equal(picked.verdict, 'WRONG_ACCOUNT');
  assert.equal(picked.stoppedAt.id, 'b',
    '要停在**产生这条结论**的那一页，而不是循环结束时碰巧停的那一页（告警承诺了登录页在那里）');

  // 「主站会话还在」压过两个 NO_*：它的下一步最省事，而且把「保存密码」也带上了
  assert.equal(finalLoginVerdict([
    { id: 'a', url: 'UA', outcome: 'NO_AUTOFILL' },
    { id: 'b', url: 'UB', outcome: 'DETOUR' },
  ]).verdict, 'MAIN_SESSION_ONLY');

  // 同一条结论出现两次 ⇒ 取**最后一次**（那是页面停得最近的一次）
  assert.equal(finalLoginVerdict([
    { id: 'a', url: 'UA', outcome: 'NO_AUTOFILL' },
    { id: 'b', url: 'UB', outcome: 'NO_AUTOFILL' },
  ]).stoppedAt.id, 'b');

  // 「交付前要不要把页导回去」只对承诺了有登录页的那两条为真
  for (const word of ATTEMPT_OUTCOMES) {
    const want = ['NO_SAVED_CREDENTIAL', 'WRONG_ACCOUNT'].includes(OUTCOME_TO_VERDICT[word]);
    assert.equal(finalLoginVerdict(only(word)).parkOnLoginPage, want, `${word} 的 parkOnLoginPage 判错了`);
  }
});

test('「承诺登录页开着」的名单必须与文案逐字对得上（两条腿绑在一起）', () => {
  // 名单漏一条的症状：那条结论产生的页面在别的候选上，而回执却说「登录页已经开在窗口里了」，
  // 收信人跑过去发现没有登录页 —— 代价是「下次不再信这条提醒」。
  //
  // 只比**逐条试可能产出的那批结论**（OUTCOME_TO_VERDICT 的值域）：CAPTCHA_REQUIRED 与
  // LOGIN_NOT_CONFIRMED 的文案也这样承诺，但它们一出现就当场返回、页签本来就在正确的页上，
  // 不经过候选收尾，所以不需要进这张名单。
  const fromLoop = new Set(Object.values(OUTCOME_TO_VERDICT));
  const promisedByText = [...fromLoop]
    .filter((verdict) => resolveAction(verdict, '某店').startsWith('登录页已经开在'))
    .sort();
  assert.deepEqual([...LOGIN_PAGE_PROMISED_VERDICTS].sort(), promisedByText,
    'core 里那张名单必须与 ACTION_BY_VERDICT 里真的这样承诺的那批逐字一致');
  assert.deepEqual([...LOGIN_PAGE_PROMISED_VERDICTS].sort(), ['NO_SAVED_CREDENTIAL', 'WRONG_ACCOUNT']);
});

test('身份守卫：填进来的账号必须与这家店登记的会员名逐字相同（四态各有明确出口）', () => {
  // 期望值的唯一来源是登记表里的**实测值**。派生成 `${店名}:阿彦` 已被实测推翻 ——
  // 盖文淘宝那家的会员名是「随心品质定制:阿彦」，与店名毫无关系。
  assert.equal(expectedMemberFor({ shop: '盖文天猫' }), '盖文旗舰店:阿彦');
  assert.equal(expectedMemberFor({ shop: '盖文淘宝' }), '随心品质定制:阿彦');
  assert.equal(expectedMemberFor({}), null, '没给店名 ⇒ 没有期望值（不是「随便」）');
  assert.equal(expectedMemberFor({ shop: null }), null);
  assert.throws(() => expectedMemberFor({ shop: '不存在的店' }), /未登记的店铺/u,
    '店名写错必须抛错，不能静默地「没有期望值」');

  assert.equal(judgeFilled({ filled: '盖文旗舰店:阿彦', expected: '盖文旗舰店:阿彦' }), 'ACCEPT');
  assert.equal(judgeFilled({ filled: '', expected: '盖文旗舰店:阿彦' }), 'EMPTY');
  assert.equal(judgeFilled({ filled: null, expected: '盖文旗舰店:阿彦' }), 'EMPTY');
  // 实测的串店现场：商家浏览器那个 profile 的 `login.taobao.com` 下两条凭据分属两家店
  assert.equal(judgeFilled({ filled: '里可林家居:阿彦', expected: '盖文旗舰店:阿彦' }), 'WRONG_ACCOUNT');
  assert.equal(judgeFilled({ filled: '盖文旗舰店:阿彦 ', expected: '盖文旗舰店:阿彦' }), 'WRONG_ACCOUNT',
    '差一个空格也算另一家 —— 「差不多」在这里就等于「登错家」');
  assert.equal(judgeFilled({ filled: '盖文旗舰店:阿彦' }), 'UNKNOWN', '没有期望值 ⇒ 不许假装过了');
  assert.deepEqual([...FILLED_VERDICTS].sort(), ['ACCEPT', 'EMPTY', 'UNKNOWN', 'WRONG_ACCOUNT']);
});

test('身份守卫读的**只有账号**：那个表达式永远不许碰密码框', () => {
  assert.match(LOGIN_ID_VALUE_EXPRESSION, /#fm-login-id/u);
  assert.equal(LOGIN_ID_VALUE_EXPRESSION.includes('password'), false,
    '身份守卫的表达式一旦扩到密码框，密码就会进回执与证据目录');
  // 表单状态那一份刻意只给长度、不给值（2026-09-18 实测：截图里画着账号，el.value 是空的）
  assert.equal(FORM_STATE_EXPRESSION.includes('value:'), false,
    '表单状态里出现了原始值 ⇒ 所有回执与证据目录都多了一条凭据外泄的口子');
});

test('WRONG_ACCOUNT 的文案不能复用「点保存密码」那套 —— 它的病恰好是这台存了多家店的账号', () => {
  const action = resolveAction('WRONG_ACCOUNT', '盖文淘宝');
  assert.match(action, /标题写着「盖文淘宝」的那个浏览器窗口/u, '仍然要用店名定位窗口');
  assert.equal(action.includes('保存密码'), false,
    '让人去「保存密码」只会把「一台混着多家店凭据」这件事坐实 —— 这正是要避免的动作');
  assert.match(REASON_BY_VERDICT.WRONG_ACCOUNT, /不止一家店/u, '原因要交代「为什么系统不替你猜」');
  assert.equal(REASON_BY_VERDICT.WRONG_ACCOUNT.includes('保存密码'), false);
  // 与 NO_SAVED_CREDENTIAL 必须是两句不同的话（照抄会把人引到错的动作上）
  assert.notEqual(action, resolveAction('NO_SAVED_CREDENTIAL', '盖文淘宝'));
  assert.notEqual(REASON_BY_VERDICT.WRONG_ACCOUNT, REASON_BY_VERDICT.NO_SAVED_CREDENTIAL);
});

test('WRONG_ACCOUNT 要叫人，且告警点名到店：静默登成别家是这条链上最贵的一种失败', () => {
  assert.equal(needsHuman('WRONG_ACCOUNT'), true);
  const alert = buildLoginAlert({
    verdict: 'WRONG_ACCOUNT',
    detail: '这家店该填的是「随心品质定制:阿彦」，浏览器填进来的却是「盖文旗舰店:阿彦」—— 系统没有提交。',
    sites: ['sycm', 'alimama'],
    shopName: '盖文淘宝',
    machine: 'DEPLOY-01',
    browserProfile: 'D:/Retire/edge-profiles/suixin-custom',
    now: () => new Date('2026-09-23T10:00:00+08:00'),
  });
  const text = renderAlertText(alert);
  assert.match(text, /【需要处理】盖文淘宝 需要你登录一次/u);
  assert.match(text, /浏览器配置：D:\/Retire\/edge-profiles\/suixin-custom/u);
  assert.equal(alert.alertId, 'sycm-login-盖文淘宝-sycm-alimama-20260923');
});

test('回执里可以出现账号名（那不是秘密），但**密码面一个都不许出现**', () => {
  // 2026-09-23 定的边界：`#fm-login-id` 的值（＝阿里妈妈页头上那个会员名）会写进 detail 与回执，
  // 因为它正是收信人判断「该用哪个账号登」的依据；密码则从头到尾不经过本脚本。
  const source = readFileSync(new URL('./login-merchant.mjs', import.meta.url), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gmu, '');
  for (const forbidden of ['fm-login-password', 'passwordValue', 'password_value', 'Login Data']) {
    assert.equal(code.includes(forbidden), false, `主脚本里出现了 ${forbidden} —— 那意味着这条链开始碰密码了`);
  }
});

test('judgeShopTarget：给了店名就必须落在它自己的代理端口上（2026-09-22 那次事故的封条）', () => {
  // 硬事实：`--proxy` 才是实例选择器，`--shop` 只写店名。两者对不上时，接下来做的每一件事
  // 都会落在**别的浏览器**上 —— 2026-09-22 就是这么把那个共用浏览器登进了某个淘宝卖家号的，
  // 而当时的输出从文字上看不出来（五份结果逐字相同）。
  const okCall = judgeShopTarget({ shop: '盖文天猫', proxy: 'http://127.0.0.1:19045', shops: SHOP_BROWSERS });
  assert.deepEqual({ ok: okCall.ok, judged: okCall.judged }, { ok: true, judged: true });

  const crossed = judgeShopTarget({ shop: '盖文天猫', proxy: 'http://127.0.0.1:19041', shops: SHOP_BROWSERS });
  assert.equal(crossed.ok, false);
  assert.equal(crossed.reason, 'other_shop');
  assert.equal(crossed.owner, '里可林淘宝', '详情要能说出「那个端口是谁的」，人才知道改什么');

  const shared = judgeShopTarget({ shop: '盖文天猫', proxy: 'http://127.0.0.1:19023', shops: SHOP_BROWSERS });
  assert.equal(shared.ok, false);
  assert.equal(shared.reason, 'not_a_shop_port', '那个共用浏览器的端口不属于任何一家店 —— 正是事故现场');

  // 没给店名 ⇒ 不判：裸调用是 `--shop` 出现之前的老用法，行为必须不变（而且仍然要能跑通）
  const bare = judgeShopTarget({ proxy: 'http://127.0.0.1:19023', shops: SHOP_BROWSERS });
  assert.equal(bare.judged, false);
  assert.equal(bare.ok, true);

  // 端口说不出是哪台 ⇒ **不下结论**：端口→店铺这张表只在**本机**成立，
  // 拿它去判一个远端地址会得到假结论，而假结论会去拦一个本来正确的调用。
  for (const remote of ['http://192.168.2.113:19045', 'not a url', '', null]) {
    const r = judgeShopTarget({ shop: '盖文天猫', proxy: remote, shops: SHOP_BROWSERS });
    assert.equal(r.judged, false, `${JSON.stringify(remote)} 不该被判成「对上了」或「对不上」`);
    assert.equal(r.ok, true, `${JSON.stringify(remote)} 时不该拦人 —— 没有依据就不下结论`);
  }
});

test('shopForProxy / proxyPortOf：端口 → 店铺的唯一来源是登记表', () => {
  for (const [shop, conf] of Object.entries(SHOP_BROWSERS)) {
    assert.equal(shopForProxy({ proxy: `http://127.0.0.1:${conf.proxyPort}`, shops: SHOP_BROWSERS }), shop,
      `${shop} 的代理端口 ${conf.proxyPort} 反查不出它自己`);
  }
  assert.equal(shopForProxy({ proxy: 'http://127.0.0.1:19023', shops: SHOP_BROWSERS }), null,
    '共用浏览器不是任何一家店');
  assert.equal(proxyPortOf('127.0.0.1:19045'), 19045, '不带 scheme 也要认（两种写法现场都用过）');
  assert.equal(proxyPortOf('http://localhost:19045/'), 19045);
  assert.equal(proxyPortOf('http://192.168.2.113:19045'), null, '非本机 ⇒ 没有结论');
  assert.equal(proxyPortOf(''), null);
  assert.equal(proxyPortOf(undefined), null);
});

test('主脚本真的接了候选循环与身份守卫（判据齐全但没人用＝最难发现的空转）', () => {
  const source = readFileSync(new URL('./login-merchant.mjs', import.meta.url), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gmu, '');
  // 注意：这里断言的是**调用点的形状**，不是「某个名字出现过」。
  // 2026-09-23 实测的教训：`code.includes('parkTabOn(')` 会被**函数定义那一行**满足，
  // 于是「候选都没成时不把页导回去」这个突变照样全绿 —— 存在性判据在源码扫描里几乎总是失效的。
  for (const needed of [
    'for (const candidate of LOGIN_URL_CANDIDATES)', // 而不是「名字出现过」（import 行也满足）
    'finalLoginVerdict(',
    'judgeFilled(',
    'expectedMemberFor(',
    'judgeShopTarget(',
    'loginFormVisible(',
  ]) {
    assert.ok(code.includes(needed), `主脚本里没有 ${needed} —— 写在 core 里的那条判据永远不会被问到`);
  }
  // 反回退：固定那一条地址不许再被主脚本当成流程（它就是「必然有机器填不上」的成因）
  assert.equal(code.includes('TAOBAO_LOGIN_URL'), false,
    '主脚本又拿单条地址当流程了 —— 「试哪几条」必须由候选表说，不由主脚本说');
  // 身份守卫必须在**点登录之前**：读账号要早于按提交按钮（迟一步就成了事后取证，拦不住串店）
  const guardAt = code.indexOf('judgeFilled(');
  const submitAt = code.indexOf("centerOf(state, 'submit')");
  assert.ok(guardAt > 0 && submitAt > guardAt, '身份守卫必须发生在点「登录」之前');
  // 而且它的**结果必须真的改道** —— 只调一下 `judgeFilled()` 然后照原样提交下去，
  // 与「不装这道守卫」逐字等价，而上面那条「有没有调它」完全看不出来。
  assert.ok(code.includes("guard === 'WRONG_ACCOUNT'"), 'guard 判出「填的是别人」，代码里却没有任何一处照它改道');
  assert.ok(code.includes("guard === 'EMPTY'"), 'guard 判出「还没填上」也没人照它改道');
  assert.ok(code.indexOf("guard === 'WRONG_ACCOUNT'") < submitAt, '「填的是别人」必须在提交之前就改道');
  // 候选没试成时**要把页签导回去**（告警承诺了登录页在那里）。三条腿缺一不可：
  //   真的调了（`await parkTabOn(`，定义那一行没有 await）；
  //   调用受 core 的判定管（`final.parkOnLoginPage`）；
  //   导的是**判定选中的那一页**（`final.stoppedAt.url`，不是循环结束时碰巧停的那一页）。
  assert.ok(code.includes('await parkTabOn('), '没有真的调用 parkTabOn ⇒ 页签会留在最后一条候选上');
  assert.ok(code.includes('final.parkOnLoginPage'), 'parkTabOn 没有受 core 的判定管 —— 那它就是在替所有结论导页面');
  assert.ok(code.includes('final.stoppedAt.url'), 'parkTabOn 没有用「判定选中的那一页」');
});
