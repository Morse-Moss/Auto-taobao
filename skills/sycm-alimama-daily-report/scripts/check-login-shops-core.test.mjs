// 「逐店登录态体检」的离线用例。
//
// 测什么、为什么：这一层的输出**会决定要不要把人叫到机器前**，
// 而它错了不会报错 —— 只会「多叫一次」（通知疲劳）或「少叫一次」（人不知道要登），
// 两种都长得像正常运行。所以下面每一条都对着一个具体的错法。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  PREFLIGHT_VERDICTS, SHOP_VERDICTS, SITE_KEYS, SITE_VERDICTS, exitCodeForPreflight,
  judgePreflight, judgeShopReceipt, loginAccountFor, parseCheckShopsArgs, platformNameHint,
  renderReport, siteVerdictOf,
} from './check-login-shops-core.mjs';
// 站点词表与探针地址的唯一来源：这里只**核对**，不另抄一份。
import { SITES } from './login-merchant-core.mjs';
import { siteAdapter } from './date-picker.mjs';
// 店名与「哪个平台显示哪个名字」的唯一来源。
import { shopIdentity } from './shop-identities.mjs';
import { shopBrowserKeys } from '../../../runtime/browser-ports.mjs';

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
  assert.match(text, /链的第 0 步会自己补上/u, '要告诉人这是可自愈的，别把页面还没归位当成故障');
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
  // ③ 这一层不投递：同一次故障再发一条飞书只会让那条通道更不可信
  assert.match(source, /'--notify', 'off'/u, '这一层不许投递告警');
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
