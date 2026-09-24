// 「逐店登录态体检」的离线用例。
//
// 测什么、为什么：这一层的输出**会决定要不要把人叫到机器前**，
// 而它错了不会报错 —— 只会「多叫一次」（通知疲劳）或「少叫一次」（人不知道要登），
// 两种都长得像正常运行。所以下面每一条都对着一个具体的错法。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  LOGIN_FAIL_TEXT, PREFLIGHT_VERDICTS, SHOP_VERDICTS, SITE_KEYS, SITE_VERDICTS, buildRoundLoginAlert,
  exitCodeForPreflight, judgePreflight, judgeShopReceipt, loginAccountFor, loginFailReason, notifyModeFor,
  parseCheckShopsArgs, platformNameHint, renderNormalizeLines, renderReport, renderRoundNotifyLines,
  shouldNotifyRound, siteVerdictOf,
} from './check-login-shops-core.mjs';
// 站点词表与探针地址的唯一来源：这里只**核对**，不另抄一份。
import { SITES, VERDICTS_NEEDING_HUMAN } from './login-merchant-core.mjs';
import { siteAdapter } from './date-picker.mjs';
// 店名与「哪个平台显示哪个名字」的唯一来源。
import { shopIdentity } from './shop-identities.mjs';
import { shopBrowserKeys } from '../../../runtime/browser-ports.mjs';
// 整轮告警文案要**走真渲染器**验（白名单会把键名写错的字段静默丢掉，只有渲染出来才看得见）。
import { renderAlertText } from '../../../runtime/notify-feishu-core.mjs';

const both = (a, b) => ({ sites: { sycm: { loggedIn: a }, alimama: { loggedIn: b } } });

// ---------------------------------------------------------------------------
// 判据
// ---------------------------------------------------------------------------

test('站点词表来自 login-merchant-core（多一份就是「体检的站点」和「探测的站点」各说各话）', () => {
  assert.deepEqual([...SITE_KEYS], Object.keys(SITES));
  assert.equal(SITE_KEYS.length, 2, '两个后台：生意参谋 + 阿里妈妈');
});

test('读不到（null）绝不算通过 —— 这是 2026-09-19 那次静默的形态', () => {
  // 现场：一个只剩 about:blank 的窗口，两个站点都读不到，脚本却报了 ALREADY_LOGGED_IN。
  // 所以这里钉死：只有 `true` 才是「在登录态」，其余一律「读不到」。
  assert.equal(siteVerdictOf(true), 'LOGGED_IN');
  assert.equal(siteVerdictOf(false), 'LOGGED_OUT');
  for (const value of [null, undefined, 'true', 1, '', {}]) {
    assert.equal(siteVerdictOf(value), 'UNREADABLE', `${JSON.stringify(value)} 不该被当成在登录态`);
  }
  // 反向：三个结论之外不许再冒出第四个词（用它做 key 查文案的地方会静默退化成兜底）
  const produced = new Set([true, false, null, undefined].map(siteVerdictOf));
  for (const word of produced) assert.ok(SITE_VERDICTS.includes(word), `未登记的结论词 ${word}`);
});

test('一家店：两个都在登录态才是 OK；掉登录与读不到各自成一类，且都不算 OK', () => {
  const ok = judgeShopReceipt({ shop: '里可林淘宝', receipt: both(true, true) });
  assert.equal(ok.verdict, 'OK');
  assert.deepEqual(ok.needsLogin, []);
  assert.deepEqual(ok.unreadable, []);

  const out = judgeShopReceipt({ shop: '盖文淘宝', receipt: both(true, false) });
  assert.equal(out.verdict, 'NEEDS_LOGIN');
  assert.deepEqual(out.needsLogin, ['alimama'], '要精确到是哪一个后台，不是「这家店有问题」');
  assert.deepEqual(out.unreadable, []);

  const unknown = judgeShopReceipt({ shop: '网林天猫', receipt: both(true, null) });
  assert.equal(unknown.verdict, 'UNKNOWN', '读不到就只能是「没结论」');
  assert.deepEqual(unknown.unreadable, ['alimama']);
  assert.deepEqual(unknown.needsLogin, []);

  // 掉登录优先于读不到：有人要做的事是确定的，就别把整店压成「没结论」。
  const mixed = judgeShopReceipt({ shop: '科塔淘宝', receipt: both(false, null) });
  assert.equal(mixed.verdict, 'NEEDS_LOGIN');
  assert.deepEqual(mixed.needsLogin, ['sycm']);
  assert.deepEqual(mixed.unreadable, ['alimama']);
});

test('回执读不出来 ⇒ 两个平台都算读不到（读不出 ≠ 不在登录态）', () => {
  for (const receipt of [null, undefined, {}, { sites: {} }, { verdict: 'ALREADY_LOGGED_IN' }]) {
    const row = judgeShopReceipt({ shop: '盖文天猫', receipt });
    assert.equal(row.verdict, 'UNKNOWN', `${JSON.stringify(receipt)} 该判成没结论`);
    assert.deepEqual(row.unreadable, [...SITE_KEYS]);
  }
});

test('回执里的结论与地址只抄不猜（复核时那是唯一能核对的现场事实）', () => {
  const row = judgeShopReceipt({
    shop: '里可林淘宝',
    receipt: { verdict: 'ALREADY_LOGGED_IN', detail: 'x', sites: { sycm: { loggedIn: true, href: 'https://sycm.taobao.com/…' } } },
  });
  assert.equal(row.scriptVerdict, 'ALREADY_LOGGED_IN');
  assert.equal(row.href.sycm, 'https://sycm.taobao.com/…');
  assert.equal(row.href.alimama, null, '没有的字段给 null（是「没读到」，不是空字符串）');
  assert.equal(row.detail, 'x');
});

test('整轮的三个结论与退出码：0 只在**全部正面确认**时才给', () => {
  const allIn = [
    judgeShopReceipt({ shop: 'a', receipt: both(true, true) }),
    judgeShopReceipt({ shop: 'b', receipt: both(true, true) }),
  ];
  assert.equal(judgePreflight(allIn).verdict, 'ALL_IN');
  assert.equal(exitCodeForPreflight('ALL_IN'), 0);

  const someoneOut = [...allIn, judgeShopReceipt({ shop: 'c', receipt: both(false, true) })];
  const judged = judgePreflight(someoneOut);
  assert.equal(judged.verdict, 'NEEDS_LOGIN');
  assert.deepEqual(judged.needHuman, [{ shop: 'c', sites: ['sycm'] }]);
  assert.equal(exitCodeForPreflight('NEEDS_LOGIN'), 2);

  // 关键的一条：**一家读不到就让整轮不是 0**。若读不到也回 0，日志里那一行
  // 就与「体检真的过了」长得一模一样 —— 静默的根就在这儿。
  const someoneUnknown = [...allIn, judgeShopReceipt({ shop: 'd', receipt: both(true, null) })];
  assert.equal(judgePreflight(someoneUnknown).verdict, 'INCONCLUSIVE');
  assert.equal(exitCodeForPreflight('INCONCLUSIVE'), 3);
  assert.equal(judgePreflight([]).verdict, 'ALL_IN', '一家都没查时不产生「有未就位项」的假红');
  assert.equal(judgePreflight([]).checked, 0);

  // 三个退出码必须互不相同 —— 糊成一个「非 0」就分不出「要去登录」与「没读到」
  const codes = PREFLIGHT_VERDICTS.map(exitCodeForPreflight);
  assert.equal(new Set(codes).size, codes.length, `退出码撞了：${codes.join(',')}`);
  assert.deepEqual(codes, [0, 2, 3]);
});

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

test('parseCheckShopsArgs：默认查全部、默认不输出 JSON', () => {
  const opts = parseCheckShopsArgs([], { shops: shopBrowserKeys() });
  assert.equal(opts.shops, null, 'null＝查登记表里全部，不是空数组');
  assert.equal(opts.json, false);
  assert.equal(opts.timeoutMs, 180000);
});

test('店名拼错必须当场抛错并列出合法值（否则「连不上」看起来像故障，其实是名字打错了）', () => {
  const shops = shopBrowserKeys();
  assert.throws(() => parseCheckShopsArgs(['--shops', '盖文'], { shops }), /Unknown --shops 盖文/u);
  assert.throws(() => parseCheckShopsArgs(['--shops', '盖文'], { shops }), /盖文淘宝/u, '要把合法值列出来');
  // 逗号串：两个都要校验，不能只看第一个
  assert.throws(() => parseCheckShopsArgs(['--shops', '里可林淘宝,盖文'], { shops }), /Unknown --shops 盖文/u);
  const ok = parseCheckShopsArgs(['--shops', '里可林淘宝,科塔淘宝', '--json'], { shops });
  assert.deepEqual(ok.shops, ['里可林淘宝', '科塔淘宝']);
  assert.equal(ok.json, true);
});

test('参数拼错要报「未知」，不许伪装成「需要一个值」；空 --shops 与坏 --timeout 当场抛错', () => {
  assert.throws(() => parseCheckShopsArgs(['--nope'], {}), /Unknown argument: --nope/u);
  assert.throws(() => parseCheckShopsArgs(['--shops'], {}), /--shops requires a value/u);
  assert.throws(() => parseCheckShopsArgs(['--timeout', '--json'], {}), /--timeout requires a value/u);
  assert.throws(() => parseCheckShopsArgs(['--shops', ',,,'], {}), /是空的/u);
  assert.throws(() => parseCheckShopsArgs(['--timeout', '10'], {}), /≥1000/u);
  assert.throws(() => parseCheckShopsArgs(['--timeout', 'abc'], {}), /≥1000/u);
  // 刻意**不提供** --target：多一个「只查了一个平台」的开关，就多一种看起来是绿的现场。
  assert.throws(() => parseCheckShopsArgs(['--target', 'sycm'], {}), /Unknown argument: --target/u);
});

// ---------------------------------------------------------------------------
// 渲染：收信人看到的那几行
// ---------------------------------------------------------------------------

test('按平台分别说名字：生意参谋给页头店名、阿里妈妈给会员名（不许互相冒充）', () => {
  const row = shopIdentity('盖文淘宝');
  // 前提：这两个名字**本来就不一样**（老会员号沿用旧品牌名）——否则这条用例是空转的。
  assert.notEqual(row.sycmHeader, row.alimamaMemberName, '盖文淘宝这两个名字应当不同，否则本用例证明不了什么');
  const sycm = platformNameHint('盖文淘宝', 'sycm');
  const alimama = platformNameHint('盖文淘宝', 'alimama');
  assert.deepEqual(sycm, { kind: 'shop', value: row.sycmHeader });
  assert.deepEqual(alimama, { kind: 'member', value: row.alimamaMemberName });
  assert.equal(loginAccountFor('盖文淘宝'), row.alimamaMemberName, '去登录用的是会员名，不是店铺名');

  const text = renderReport({ rows: [judgeShopReceipt({ shop: '盖文淘宝', receipt: both(false, true) })] });
  assert.match(text, new RegExp(`生意参谋：掉登录了[\\s\\S]*${row.sycmHeader}`, 'u'));
  assert.match(text, new RegExp(`阿里妈妈：在登录态[\\s\\S]*${row.alimamaMemberName}`, 'u'));
  // 「用哪个账号登」必须出现在要人做事那一段里 —— 只写店名，收信人到了机器前还得猜账号。
  assert.match(text, new RegExp(`用「${row.alimamaMemberName}」登录`, 'u'));
  assert.match(text, /标题写着「盖文淘宝」的那个浏览器窗口/u, '要用窗口标题定位（四台窗口长得一样）');
});

test('OK 的店压成一行；要处理的店逐平台展开', () => {
  const okText = renderReport({ rows: [judgeShopReceipt({ shop: '里可林淘宝', receipt: both(true, true) })] });
  assert.match(okText, /里可林淘宝：生意参谋在登录态，阿里妈妈在登录态/u);
  assert.equal(okText.includes('要处理'), false, '没问题的店不许出现「要处理」三个字');
  assert.match(okText, /\[判据\] 1 家店、2 个平台都在登录态/u);

  const badText = renderReport({ rows: [judgeShopReceipt({ shop: '里可林淘宝', receipt: both(false, false) })] });
  assert.match(badText, /里可林淘宝（要处理）/u);
  assert.match(badText, /生意参谋：掉登录了（被平台踢回了登录页）/u);
  assert.match(badText, /阿里妈妈：掉登录了/u);
  assert.match(badText, /\[判据\] 有 1 家店要你去窗口里动一下手/u);
  assert.match(badText, /这一层只是体检：它没有打开过任何页面/u, '要如实交代这一层没动过任何东西');
});

test('「读不到」必须自解释，且整轮的判据段不许把它说成通过', () => {
  const text = renderReport({ rows: [judgeShopReceipt({ shop: '网林天猫', receipt: both(true, null) })] });
  assert.match(text, /网林天猫（没结论）/u);
  assert.match(text, /阿里妈妈：读不到（这个窗口里没有它的页面，或者连不上这个窗口）/u);
  assert.match(text, /没有结论\*\*（读不到不等于通过）/u);
  // 「这是可自愈的、不是掉登录」这句话必须说出来 —— 它是这件事与「掉登录」的分界线。
  // 2026-09-24 起措辞更新：这一层**开跑前已经归位过一次**（见 [归位] 段），
  // 所以「页面还没归位」不再是默认解释，要说的是「下一步谁还会再试一次」。
  assert.match(text, /不是掉登录/u, '要把「读不到」与「掉登录」分开说');
  assert.match(text, /本次开跑前已经归位过一次/u, '要说清这一层已经先归位过了（不然人会以为没人管页面）');
  assert.match(text, /链的第 0 步还会再补一次/u, '要告诉人这是可自愈的，别把页面还没归位当成故障');
  assert.equal(/都在登录态 —— 可以开跑/u.test(text), false, '「读不到」时绝不许出现「可以开跑」');
});

test('每家店的两个平台各说各的名字，且名字与登记表逐字一致', () => {
  // 用真登记表逐店验一遍：漏一家就是「那家店要人登录时说不清该登哪个账号」。
  for (const shop of shopBrowserKeys()) {
    const row = shopIdentity(shop);
    assert.equal(platformNameHint(shop, 'sycm')?.value, row.sycmHeader, `${shop} 的生意参谋名字`);
    assert.equal(platformNameHint(shop, 'alimama')?.value, row.alimamaMemberName, `${shop} 的阿里妈妈名字`);
  }
  // 未登记的店名不许抛出去炸掉整份报告：如实说「没登记名字」（这里直接问渲染要输出）
  const text = renderReport({ rows: [{ shop: '不存在的店', verdict: 'NEEDS_LOGIN', sites: { sycm: 'LOGGED_OUT', alimama: 'LOGGED_IN' }, needsLogin: ['sycm'], unreadable: [] }] });
  assert.match(text, /没有登记名字/u);
  assert.match(text, /用这家店自己的账号登录/u);
});

test('渲染里不许出现结论代号（读了半天的 `LOGGED_OUT` 不是给收信人看的）', () => {
  const text = renderReport({
    rows: [
      judgeShopReceipt({ shop: '盖文淘宝', receipt: both(true, null) }),
      judgeShopReceipt({ shop: '科塔淘宝', receipt: { sites: {} } }),
    ],
  });
  for (const word of [...SITE_VERDICTS, ...SHOP_VERDICTS, ...PREFLIGHT_VERDICTS]) {
    assert.equal(text.includes(word), false, `报告里出现了结论代号 ${word}`);
  }
});

// ---------------------------------------------------------------------------
// 2026-09-23 加：`--login`（跑前登录守卫）那一条链
// ---------------------------------------------------------------------------
// 这一组守的是「自动登录接进来之后，本来对的那几件事有没有被弄坏」：
//   ① 默认（不带 --login）的行为必须逐字不变 —— 它是「跑前那一眼的体检」，不能变成写操作；
//   ② 带 --login 时，结论必须看**登完之后**那一眼（看错了会把成功报成失败，白叫人一趟）；
//   ③ 措辞必须说清「机器已经试过了」—— 否则收信人以为机器什么都没做。

test('parseCheckShopsArgs：--login 默认关，给了才开', () => {
  assert.equal(parseCheckShopsArgs([]).login, false, '默认必须是只读（不带 --login）');
  assert.equal(parseCheckShopsArgs(['--login']).login, true);
  assert.equal(parseCheckShopsArgs(['--login', '--json']).login, true);
  // 拼错仍然当场抛，不许被当成「没给值」而静默降级成只读。
  assert.throws(() => parseCheckShopsArgs(['--login=1']), /Unknown argument/u);
});

test('带 --login 时结论看的是「登完之后」那一眼（看错了会把成功报成掉登录）', () => {
  // 子进程的回执里：`loggedIn`＝**登录之前**那一眼，`loggedInAfter`＝登完之后那一遍。
  // 只读前者的话，机器人刚把两个后台都登进去，报告仍然写「掉登录」⇒
  // 收信人被叫去窗口里做一件刚做完的事。这是这次改动里唯一一处「错了不报错、只是白叫人」的地方。
  const receipt = {
    sites: {
      sycm: { loggedIn: false, loggedInAfter: true },
      alimama: { loggedIn: null, loggedInAfter: true },
    },
    verdict: 'LOGGED_IN',
  };
  const row = judgeShopReceipt({ shop: '科塔淘宝', receipt });
  assert.deepEqual(row.sites, { sycm: 'LOGGED_IN', alimama: 'LOGGED_IN' },
    '登完之后那一眼才是结论');
  assert.equal(row.verdict, 'OK');
  assert.equal(row.scriptVerdict, 'LOGGED_IN', '子脚本自己报的结论要原样留着');
});

test('只读回执里没有 loggedInAfter，结论与从前逐字相同（默认关是硬保证）', () => {
  const row = judgeShopReceipt({
    shop: '科塔淘宝',
    receipt: { sites: { sycm: { loggedIn: false }, alimama: { loggedIn: true } }, verdict: 'NEEDS_LOGIN' },
  });
  assert.deepEqual(row.sites, { sycm: 'LOGGED_OUT', alimama: 'LOGGED_IN' });
  assert.equal(row.verdict, 'NEEDS_LOGIN');
});

test('autoLogin 只改措辞、不改判定：既要人说得清、也不许把「没登过」说成「登过」', () => {
  const rows = [judgeShopReceipt({
    shop: '科塔淘宝',
    receipt: { sites: { sycm: { loggedIn: false }, alimama: { loggedIn: false } }, verdict: 'NO_SAVED_CREDENTIAL' },
  })];
  const readOnly = renderReport({ rows, machine: 'M' });
  const guarded = renderReport({ rows, machine: 'M', autoLogin: true });

  // ① 只读那句原样在，而且**不许**出现任何「自动登录」字样 ——
  //    只读模式下子进程的结论是 NEEDS_LOGIN，照抄会写成「自动登录没成」，
  //    而那一轮根本没有任何登录发生过。
  assert.match(readOnly, /这一层只是体检：它没有打开过任何页面、也没有点过任何东西。/u);
  assert.equal(readOnly.includes('自动登录'), false, `只读报告里不许提自动登录：\n${readOnly}`);
  assert.equal(readOnly.includes('NO_SAVED_CREDENTIAL'), false, '结论代号不许出现在报告里');

  // ② 守卫模式：说清「试过了、没成」，并把子脚本报的原因翻成人话。
  assert.match(guarded, /自动登录也试过了、没成/u);
  assert.match(guarded, /已经自己试过登录了/u);
  assert.match(guarded, /自动登录没成的原因：浏览器没把账号密码填进去/u);
  // ③ 判定本身不许因为措辞变了而动。
  assert.deepEqual(judgePreflight(rows).verdict, 'NEEDS_LOGIN');
  assert.equal(exitCodeForPreflight('NEEDS_LOGIN'), 2);
});

test('成功那一轮要说清「哪几家是这次自己登进去的」（否则运维会以为一直在白跑）', () => {
  const rows = [
    judgeShopReceipt({ shop: '科塔淘宝', receipt: { sites: { sycm: { loggedIn: false, loggedInAfter: true }, alimama: { loggedIn: false, loggedInAfter: true } }, verdict: 'LOGGED_IN' } }),
    judgeShopReceipt({ shop: '盖文淘宝', receipt: { sites: { sycm: { loggedIn: true }, alimama: { loggedIn: true } }, verdict: 'ALREADY_LOGGED_IN' } }),
  ];
  const text = renderReport({ rows, machine: 'M', autoLogin: true });
  assert.match(text, /2 家店、4 个平台都在登录态/u);
  assert.match(text, /其中 1 家是\*\*这一次自己登进去的\*\*/u, `没点名这次登进去的那几家：\n${text}`);
  assert.match(text, /科塔淘宝/u);
  // 只读模式不许出现这句（那时没有登录发生）。
  assert.equal(renderReport({ rows, machine: 'M' }).includes('自己登进去的'), false);
});

// ---------------------------------------------------------------------------
// 两条「接线」判据（函数对 ≠ 接上了）
// ---------------------------------------------------------------------------

test('体检探针的落点仍在链的期望页面清单之内（否则体检会把页面带偏，链也跟着红）', () => {
  // 体检唯一的写动作是「把该站点那一页导航到探针地址去读最终 URL」。
  // 探针地址一旦落在期望页面片段之外，链的第 0 步就会把那页判成漂移页 ——
  // 一次体检顺手制造一次假故障。两个站点的探针地址都由这条钉住。
  for (const key of SITE_KEYS) {
    const adapter = siteAdapter(key);
    assert.ok(SITES[key].probeUrl.includes(adapter.urlFragment),
      `${key} 的探针地址 ${SITES[key].probeUrl} 不含期望片段 ${adapter.urlFragment}`);
  }
});

test('主脚本真的按「一店一实例 + 纯读」调用 login-merchant（三类静默各有一条判据）', () => {
  const source = readFileSync(new URL('./check-login-shops.mjs', import.meta.url), 'utf8');
  // ① 纯读那一支：没有 --check-only 的话，掉登录的现场会被顺手开一个登录页
  assert.match(source, /'--check-only'/u, '必须带 --check-only，否则体检在掉登录现场不是只读的');
  // ② 切实例靠 --proxy（端口来自登记表），不是靠 --shop
  assert.match(source, /'--proxy', `http:\/\/127\.0\.0\.1:\$\{conf\.proxyPort\}`/u,
    '必须用登记表里的 proxyPort 指定那家店自己的实例');
  // ③ 子进程的告警取值必须**恒 off**（2026-09-24 改）：投递权整轮收在本层（`deliverRoundAlert`），
  //    子进程各自发正是那次「一次预检 5 条告警、且全是假红」的形态。
  //    判据两处：取值由 `notifyModeFor()` 算（不许写死常量）；取值本身恒 off（见下面那条用例）。
  assert.match(source, /'--notify', notifyModeFor\(\)/u,
    '子进程的 --notify 取值必须由 notifyModeFor() 决定（写死常量＝「哪一档该不该发」只活在 IO 里，离线测不到）');
  assert.doesNotMatch(source, /'--notify',\s*'(?:auto|dry|send)'/u,
    'IO 里不许出现「会真的发」的取值：子进程发告警＝绕过整轮判定与去重（2026-09-24 那 5 条就是这么来的）');
  // ④ 告警的**投递入口只有一处**，且必须先过整轮判定（shouldNotifyRound）—— 接线判据：
  //    「判定在一处、投递在一处」这句话如果只写在注释里，下一次改动就会各自漂开。
  assert.match(source, /if \(shouldNotifyRound\(\{ login: opts\.login, judged \}\)\)/u,
    '投递必须先过 shouldNotifyRound（写死一个 if 别的条件＝判定与投递又分居两处）');
  assert.match(source, /await deliverRoundAlert\(\{ alert: buildRoundLoginAlert\(\{ rows, judged \}\), log \}\)/u,
    '整轮告警必须由 buildRoundLoginAlert 构造、由 deliverRoundAlert 投递');
  // ⑤ 归位必须排在**探针之前**（2026-09-24 加）：顺序反了就等于「先读一遍页面不在、
  //    再去补页面、然后再也不读」—— 报告里那句「读不到」会是真的读不到，
  //    而它本来是可以避免的（那正是这次要治的假红）。
  const normalizeAt = source.indexOf('await normalizeShopPages(shops, log)');
  const probeAt = source.indexOf('await probeShop(shop');
  assert.ok(normalizeAt > 0, '主脚本里必须有归位那一步');
  assert.ok(probeAt > normalizeAt, '归位必须排在探针之前（顺序反了＝白读一次「页面不在」）');
  // ⑥ 归位**只在 `--login` 档**跑：只读档「一个页面都不碰」是那一档存在的全部意义。
  assert.match(source, /if \(opts\.login\) \{[\s\S]{0,200}normalizeShopPages/u,
    '归位必须挂在 --login 档下（只读档碰页面＝把只读承诺作废）');
  // ④ 用 process.execPath 起真 node，**不**经过任何 .cmd/.bat 包装
  //    （Node ≥18.20.2 起 spawn('<x>.cmd', shell:false) 同步抛 EINVAL，包一层是死的）
  assert.match(source, /spawn\(process\.execPath, \[/u);
  // ⑤ 「查」与「查 + 登」**只在这一处分叉**，两种模式共用其余参数。
  //    写成两份调用的话，漂移的症状是「自动登录打到了另一个实例上」，日志里看不出来。
  assert.match(source, /login \? '--commit' : '--check-only'/u,
    '两种模式必须在同一处按同一个开关分叉');
  // ⑥ 带 `--login` 时**串行 + 固定间隔**：五家店同时提交登录＝同一出口 IP 上短时间内五次登录，
  //    那是风控最敏感的形态，最坏结果不是「跑失败」而是一批账号被保护性锁定。
  assert.match(source, /LOGIN_GAP_MS/u, '登录模式必须有两店之间的静默期');
  assert.match(source, /if \(!opts\.login\) \{[\s\S]*?Promise\.all[\s\S]*?\} else \{[\s\S]*?for \(const shop of shops\)/u,
    '只读才并行；带 --login 必须串行（并行登录是风控加速器）');
});

// ---------------------------------------------------------------------------
// 告警出口：只允许在「真的去登过」之后叫人（2026-09-23 用户拍板）
// ---------------------------------------------------------------------------
// 用户原话：「如果自动登录失败就飞书告警，但是前提是你要先自动登录」。
// 这句话拆成两条判据：① 没去登 ⇒ 闭嘴；② 去登了、且仍需要人 ⇒ 才发。
// 第 ② 条不由本层判（在 login-merchant-core 的应通知判据里），本层守住第 ① 条。

test('notifyModeFor：子进程一律闭嘴 —— 告警整轮只由本层发一条（2026-09-24 改）', () => {
  // 2026-09-23 的取值是「带 --login ⇒ auto」，于是**每店一个子进程各发一条**：
  // 实测一次预检并发 5 条同一天的告警（其中一批全是假红）。现在投递权整轮收在 IO 层
  // （`deliverRoundAlert`），子进程恒 off —— 它与 `shouldNotifyRound` 是一对：
  // **判定在一处（core）、投递在一处（IO 的 deliverRoundAlert）**。
  assert.equal(notifyModeFor(), 'off');
  assert.equal(notifyModeFor({ login: true }), 'off', '带 --login 也一样：那一次的结论由整轮那条告警说');
  assert.equal(notifyModeFor({ login: false }), 'off', '只读档更不许发');
});

test('告警收据要透传到行里 —— 否则「叫没叫到人」只能靠猜', () => {
  const receipt = {
    verdict: 'NO_SAVED_CREDENTIAL',
    sites: { sycm: { loggedIn: false, href: 'x', loggedInAfter: false } },
    notify: { mode: 'auto', alertId: 'sycm-login-盖文天猫-sycm-20260923', status: 'SENT' },
  };
  const row = judgeShopReceipt({ shop: '盖文天猫', receipt });
  assert.equal(row.notify?.status, 'SENT');
  assert.equal(row.notify?.alertId, 'sycm-login-盖文天猫-sycm-20260923');
  // 只读档下子进程不产生这个键 ⇒ 必须是 null，而不是凭空造一个对象
  assert.equal(judgeShopReceipt({ shop: '盖文天猫', receipt: { sites: {} } }).notify, null);
});

test('renderRoundNotifyLines：已发 / 被去重 / 发失败 / 根本没发，四种要说得出区别', () => {
  const sent = renderRoundNotifyLines({ status: 'SENT', alertId: 'sycm-login-round-20260924' }).join('\n');
  assert.match(sent, /已发 1 条飞书（编号 sycm-login-round-20260924）/u);
  assert.match(renderRoundNotifyLines({ status: 'DEDUPED', alertId: 'x', reason: '同一条告警 10 分钟前刚发过（窗口 6 小时），不重复发' }).join('\n'),
    /不重复发/u);
  const failed = renderRoundNotifyLines({ status: 'FAILED', alertId: 'x', error: 'HTTP 500' }).join('\n');
  assert.match(failed, /发送失败/u);
  assert.match(failed, /HTTP 500/u);
  assert.match(renderRoundNotifyLines({ status: 'SKIPPED', reason: '这一轮是只读体检，没有去登' }).join('\n'),
    /没发 —— 这一轮是只读体检，没有去登/u);
  // 「没发出去」与「已叫人」**必须**长得不一样：混起来会让收信人以为已经通知过了，
  // 而其实一条都没到（这正是本仓库反复在治的那类静默）。
  assert.notEqual(sent, renderRoundNotifyLines({ status: 'NOT_CONFIGURED' }).join('\n'));
  // 认不出来的状态不许被当成「发过了」
  assert.match(renderRoundNotifyLines({ status: 'WHATEVER' }).join('\n'), /认不出来/u);
  // 没有收据（只读档、以及「不需要人」那两档都不产生收据）⇒ 这一段整段不出现
  assert.deepEqual(renderRoundNotifyLines(null), []);
  assert.deepEqual(renderRoundNotifyLines(), []);
});

test('只读档的报告里没有「已叫人」那一段，并且明说这一档不会发告警', () => {
  const rows = [judgeShopReceipt({ shop: '网林天猫', receipt: both(false, false) })];
  const report = renderReport({ rows, autoLogin: false });
  // 没有告警段落、没有「已经叫人」这种话 —— 那一轮没有任何登录发生过
  assert.doesNotMatch(report, /^\[告警\]/mu);
  assert.doesNotMatch(report, /已经叫人/u);
  // 但要把「为什么群里没动静」写在明面上：否则读报告的人会以为告警坏了
  // （2026-09-23 用户原话就是「如果登录不了，为什么没有飞书提醒」）。
  assert.match(report, /不发任何告警/u);
});

test('带 --login 的报告里，告警那一段说的是**整轮那一条**（不是逐店）', () => {
  const rows = [judgeShopReceipt({ shop: '盖文天猫', receipt: both(false, false) })];
  const report = renderReport({
    rows, autoLogin: true, roundNotify: { status: 'SENT', alertId: 'sycm-login-round-20260924' },
  });
  assert.match(report, /^\[告警\] 已发 1 条飞书（编号 sycm-login-round-20260924）$/mu);
  // 没有收据（不需要人 / 只读档）⇒ 整段不出现：这两档**一个字都没发**，
  // 报告里若留一句「告警」会让人以为查过投递结果。
  assert.doesNotMatch(renderReport({ rows, autoLogin: true }), /^\[告警\]/mu);
});

test('每一条「要叫人」的结论都有自己的人话文案（漏一条＝运营看到一句内部代号）', () => {
  // 2026-09-23 加。漏一条的现场：`loginFailReason` 回落到
  // 「自动登录没成（内部结论：WRONG_ACCOUNT）」—— 收信人看到的是一个内部代号，
  // 而这件事**不会报任何错**（这就是它必须由判据来守、而不是靠「写的人记得加」的原因）。
  for (const verdict of VERDICTS_NEEDING_HUMAN) {
    assert.ok(LOGIN_FAIL_TEXT[verdict], `${verdict} 没有翻成人话 ⇒ 报告里会印出内部代号`);
    assert.equal(loginFailReason(verdict).includes('内部结论'), false, `${verdict} 落到了兜底文案`);
    assert.equal(loginFailReason(verdict).includes(verdict), false, `${verdict} 的文案里出现了自己的代号`);
  }
  // 反向：词表里不许有 VERDICTS 之外（或已删掉）的词残留 —— 那是一句永远印不出来的话
  const extra = Object.keys(LOGIN_FAIL_TEXT).filter((word) => !VERDICTS_NEEDING_HUMAN.includes(word));
  assert.deepEqual(extra, [], `LOGIN_FAIL_TEXT 里有印不出来的词：${extra.join(' / ')}`);
  // 认不出来时如实说认不出来，而不是编一句
  assert.equal(loginFailReason('没这个词'), '自动登录没成（内部结论：没这个词）');
  assert.equal(loginFailReason(null), null);
});

test('WRONG_ACCOUNT 的人话不能与「没凭据」共用一句 —— 两者的下一步不同', () => {
  const wrong = loginFailReason('WRONG_ACCOUNT');
  assert.notEqual(wrong, loginFailReason('NO_SAVED_CREDENTIAL'));
  assert.match(wrong, /另一家店/u, '要说清「填进来的是别人」，否则人会以为只是没填上');
  assert.equal(wrong.includes('保存密码'), false, '这一条不该让人去「保存密码」（那会把混着多家凭据这件事坐实）');
});

// ---------------------------------------------------------------------------
// 整轮一条告警（2026-09-24 加）：判定、构造、归位那一段的报告
// ---------------------------------------------------------------------------

test('shouldNotifyRound：只有「真的去登过」+「确定有店要人」才叫一条', () => {
  const needLogin = judgePreflight([judgeShopReceipt({ shop: '盖文天猫', receipt: both(false, false) })]);
  const unknown = judgePreflight([judgeShopReceipt({ shop: '盖文天猫', receipt: both(null, null) })]);
  const allIn = judgePreflight([judgeShopReceipt({ shop: '盖文天猫', receipt: both(true, true) })]);
  assert.equal(needLogin.verdict, 'NEEDS_LOGIN');
  assert.equal(unknown.verdict, 'INCONCLUSIVE');
  assert.equal(allIn.verdict, 'ALL_IN');

  assert.equal(shouldNotifyRound({ login: true, judged: needLogin }), true);
  assert.equal(shouldNotifyRound({ login: false, judged: needLogin }), false,
    '没去登就不许叫人（2026-09-23 用户拍板那句「前提是你要先自动登录」）');
  // 这一条是本次修复的核心：`INCONCLUSIVE` 是「读不到」，不是「要人」。
  // 2026-09-24 那 5 条假红就是这个形态（页面还没归位被报成「主站会话还在」）。
  assert.equal(shouldNotifyRound({ login: true, judged: unknown }), false,
    '「读不到」不是「要人」：读了 5 条假红才会去改它');
  assert.equal(shouldNotifyRound({ login: true, judged: allIn }), false);
  // 没有结论时一律不许发（宁可少叫一次，也不要为一件没确认的事叫人）
  assert.equal(shouldNotifyRound({ login: true }), false);
  assert.equal(shouldNotifyRound(), false);
});

test('buildRoundLoginAlert：一条说清哪几家、哪个后台、去哪几个窗口做什么', () => {
  const rows = [
    judgeShopReceipt({ shop: '里可林淘宝', receipt: both(true, false) }),
    judgeShopReceipt({ shop: '盖文天猫', receipt: both(false, false) }),
  ];
  const judged = judgePreflight(rows);
  assert.equal(judged.verdict, 'NEEDS_LOGIN');
  const alert = buildRoundLoginAlert({ rows, judged, now: () => new Date('2026-09-24T09:20:00+08:00') });

  // 编号同一天只有一条（去重能不能生效的前提），且与逐店那条**刻意不同**。
  assert.equal(alert.alertId, 'sycm-login-round-20260924');
  assert.equal(alert.type, 'LOGIN_REQUIRED');
  assert.match(alert.title, /2 家店需要你登录一次/u, '标题要带家数：收信人一眼看出今天要动几台机器');

  const text = renderAlertText(alert);
  assert.match(text, /【需要处理】2 家店需要你登录一次/u);
  assert.match(text, /· 里可林淘宝（阿里妈妈）/u, '要逐店点名**哪个后台**，不能只说「有一家掉了」');
  assert.match(text, /· 盖文天猫（生意参谋、阿里妈妈）/u);
  assert.match(text, /告警编号：sycm-login-round-20260924/u, '事后对账只有编号与时间能引用');
  // 这一条是给业务收信人看的：机器名/浏览器配置**不许**出现（source 只放白名单里的键）。
  assert.doesNotMatch(text, /机器：|浏览器配置：/u);
  assert.doesNotMatch(text, /D:\\Retire/u, '本机路径不该出现在业务消息里');

  // 指纹只跟「哪几家、哪几个后台」：同一批店同一天再跑一次要能被去重，换了一批店则是新信息。
  assert.match(alert.fingerprint, /盖文天猫:alimama,sycm/u);
  assert.match(alert.fingerprint, /里可林淘宝:alimama/u);
  const smaller = buildRoundLoginAlert({ rows: [rows[1]], judged: judgePreflight([rows[1]]), now: () => new Date('2026-09-24T09:20:00+08:00') });
  assert.notEqual(smaller.fingerprint, alert.fingerprint, '要人的那几家变了 ⇒ 指纹必须变（否则新信息会被当成重复挡掉）');
  assert.equal(smaller.title, '盖文天猫 需要你登录一次', '只有一家时标题直接写店名');

  // 不需要人时**当场抛**：不该叫人的时候发一条，就是在教收信人忽略这个通道。
  assert.throws(() => buildRoundLoginAlert({ rows, judged: judgePreflight([judgeShopReceipt({ shop: '盖文天猫', receipt: both(true, true) })]) }),
    /不该生成登录告警/u);
});

test('renderNormalizeLines：归位那段要说清「哪家、动没动、齐没齐」；只读档整段不出现', () => {
  // 只读档（`asked: false`）**不许**印出一段像「已经归位过」的话 —— 那一档一个页面都没碰。
  assert.deepEqual(renderNormalizeLines(null), []);
  assert.deepEqual(renderNormalizeLines({ asked: false }), []);
  const text = renderNormalizeLines({ asked: true, shops: [
    { shop: '里可林淘宝', ok: true, detail: '已归位（生意参谋工作页=0 → 1）' },
    { shop: '网林天猫', ok: false, detail: '归位后仍不齐（阿里妈妈报表页=2）' },
    { shop: '科塔淘宝', ok: false, error: '连不上代理 127.0.0.1:19044' },
  ] }).join('\n');
  assert.match(text, /^\[归位\]/u);
  assert.match(text, /里可林淘宝：已就位（已归位/u);
  assert.match(text, /网林天猫：⚠️ 仍不齐（归位后仍不齐/u);
  assert.match(text, /科塔淘宝：没做成 —— 连不上代理/u);
});
