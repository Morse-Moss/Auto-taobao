// 登记表的守卫用例。
//
// 这份测试要守住的是**四件不同的事**，别混成一件：
//   ① 形状：13 行、key 与页头店名都唯一（唯一性不是洁癖 —— 它正是「按页头店名能唯一认店」的判据，
//      页头店名一旦重复，§5.3.2 里那四个窗口就再也定不下名）；
//   ② 忠实：登记行与「照抄读回的原文」（RAW_MAPPING_ROWS）是双射，没有抄错也没有漏行
//      —— 注意两者的行数**本来就不等**：底单 12 行 + 另立来源的第 13 家 = 登记表 13 行；
//   ③ 诚实：**级别与字段必须自洽** —— 有值就有级别、有级别就有值。要分清两件事：
//      `expression` 才是「用采集表达式在真实窗口里实测过」，`human-record` 只是「人工记录」
//      （2026-09-30 换操作员后 13 家的会员名全是这一级，所以摘要里必须显示成未实测）；
//      未实测的字段整行为 null —— 不许把推测值填进判据；
//   ④ 可用：把登记表接回真实判据（assertShopIdentity / assertMemberIdentity）跑一遍 ——
//      逐店自比必须过，跨店比对必须停。第 ④ 条才算「这份表能当判据用」的证明；
//      没有它，前三件全绿也可能只是一份没人用的文档。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { assertMemberIdentity, assertShopIdentity } from './collect-core.mjs';
import {
  ACCOUNT_TABLE_SOURCE, EXTRA_SHOPS_FROM_ACCOUNT_TABLE, IDENTITY_MEMBER_MEASURED_SHOPS,
  IDENTITY_PENDING_SHOPS, IDENTITY_SHOP_HEADER_VERIFIED_SHOPS, IDENTITY_VERIFIED_LABEL,
  ISOLATED_PROFILES, MAPPING_SOURCE, RAW_MAPPING_ROWS, SHOP_IDENTITIES,
  assertEvidenceShopKey, describeIdentity, expectArgs, formatArgv, platformOf, shopIdentity,
  shopIdentityByHeader, shopKeys,
} from './shop-identities.mjs';

const SCRIPTS_DIR = import.meta.dirname;
const PLATFORMS = new Set(['taobao', 'tmall', 'leading']);

test('登记表：13 行，运营叫法与页头店名都唯一', () => {
  assert.equal(SHOP_IDENTITIES.length, 13);
  // ⚠️ MAPPING_SOURCE.recordCount 是**飞书「店铺底单」当时的行数（12）**，不是登记表行数（13）。
  // 差额＝EXTRA_SHOPS_FROM_ACCOUNT_TABLE（只在账号表里有、飞书还没有行的第 13 家）。
  // 这条断言故意写成「底单行数 + 新增家数 = 登记行数」，而不是「两者相等」：
  // 相等会把新店挡在门外；不写又会让「抄漏一行」与「新加一行」长得一模一样。
  assert.equal(MAPPING_SOURCE.recordCount + EXTRA_SHOPS_FROM_ACCOUNT_TABLE.length, SHOP_IDENTITIES.length,
    '底单行数 + 另立来源的新增家数 必须等于登记表行数（否则不是抄漏就是没记账）');
  assert.equal(MAPPING_SOURCE.readAt, '2026-09-18');
  assert.equal(ACCOUNT_TABLE_SOURCE.receivedAt, '2026-09-30',
    '操作员账号表的收到日期要如实写 —— 这 13 家的会员名都是那天起按它填的');

  const keys = shopKeys();
  assert.equal(new Set(keys).size, keys.length, `运营叫法重复：${keys.join(' / ')}`);
  const fullNames = SHOP_IDENTITIES.map((row) => row.fullName);
  assert.equal(new Set(fullNames).size, fullNames.length,
    '平台店铺全称必须唯一 —— 重复了就说明「按页头店名认店」这条路本身不成立');
  // 反向断言：任何一行都不许缺关键字段（缺了下面的比对逻辑会自动全过）。
  for (const row of SHOP_IDENTITIES) {
    assert.ok(row.key && row.fullName, `行不完整：${JSON.stringify(row)}`);
    assert.ok(row.platform && PLATFORMS.has(row.platform), `platform 非法：${row.platform}`);
  }
});

test('登记表与「照抄读回的原文」是双射：既没抄错，也没漏行', () => {
  assert.equal(RAW_MAPPING_ROWS.length, 12, '「店铺底单」当天就是 12 行 —— 它不该随着加店而变');
  // 底单 12 行必须**逐行**在登记表里找到同名对应（这一条挡住「抄漏一行」与「两列写反」）。
  for (const [fullName, key] of RAW_MAPPING_ROWS) {
    assert.equal(shopIdentity(key).fullName, fullName,
      `「${key}」的平台店铺全称应为「${fullName}」——两列写反是最容易发生、也最难发现的一种抄错`);
    assert.equal(shopIdentityByHeader(fullName).key, key);
  }
  // 反向：登记表比底单多出来的那几家，必须**恰好**是显式清单里那几家。
  const fromMapping = new Set(RAW_MAPPING_ROWS.map(([, key]) => key));
  const extra = SHOP_IDENTITIES.map((row) => row.key).filter((key) => !fromMapping.has(key));
  assert.deepEqual(extra.sort(), [...EXTRA_SHOPS_FROM_ACCOUNT_TABLE].sort(),
    '登记表里多出来的店必须逐家列在 EXTRA_SHOPS_FROM_ACCOUNT_TABLE —— 否则就是凭空多出一家');
  // 第 13 家（网林定制淘宝）确实不在底单里，这条断言把「原本就是 12 家」这个事实钉住。
  assert.equal(fromMapping.has('网林定制淘宝'), false);
  assert.throws(() => shopIdentityByHeader('盖文'), /没有哪家店的平台店铺全称是/u);
});

test('平台后缀与 platform 字段一致；未知后缀当场抛错', () => {
  for (const row of SHOP_IDENTITIES) {
    assert.equal(row.platform, platformOf(row.key), `${row.key} 的 platform 与后缀不一致`);
  }
  assert.throws(() => platformOf('科塔1688'), /没有已知的平台后缀/u);
  // 13 家店的平台分布（7 个淘宝 / 4 个天猫 / 2 个龙头店）：这条不是为了好看，
  // 而是把「只有淘宝和天猫」这个直觉错判钉住 —— 本来就有两家是「龙头店」。
  const count = (platform) => SHOP_IDENTITIES.filter((row) => row.platform === platform).length;
  assert.deepEqual({ taobao: count('taobao'), tmall: count('tmall'), leading: count('leading') },
    { taobao: 7, tmall: 4, leading: 2 });
});

test('诚实性：已实测的行字段齐全，未实测的行整行为 null', () => {
  for (const row of SHOP_IDENTITIES) {
    const shopKnown = row.sycmHeaderVerified !== null;
    const memberKnown = row.alimamaVerified !== null;
    assert.equal(shopKnown, row.sycmHeader !== null && row.sycmHeader !== '',
      `${row.key}：sycmHeaderVerified 与 sycmHeader 必须同时有值或同时为空`);
    assert.equal(memberKnown, row.alimamaMemberName !== null && row.alimamaMemberName !== '',
      `${row.key}：alimamaVerified 与「会员名是否有值」必须一致`);
    // 「会员名与 ID 成对出现」**不再是硬约束**（2026-09-30 起）：
    // 会员 ID 是主账号的属性，用户给的账号表里没有它，而 assertMemberIdentity 只拿到
    // 会员名时照样是一道有效闸门。反方向仍是硬约束 —— **不许有 ID 没名字**，那才是半截身份：
    // （原来的双向断言会把 8 家「只有名字」的店判成不合法，逼着人把名字也删掉，
    //   那等于为了整齐而丢掉一条真能用的判据。）
    assert.equal(Boolean(row.alimamaMemberId && !row.alimamaMemberName), false,
      `${row.key}：有会员 ID 却没有会员名 —— 这是半截身份`);
    if (shopKnown) assert.equal(row.sycmHeader, row.fullName,
      `${row.key}：实测到的页头店名与平台店铺全称不一致 —— 这两者不同名时，必须把实测值单列，不能拿 fullName 冒充`);
    if (memberKnown) {
      assert.match(row.alimamaMemberName, /^.{2,20}:.{1,20}$/u,
        `${row.key} 的会员名应形如「主账号:子账号」`);
      assert.notEqual(row.alimamaMemberName, row.key,
        `${row.key} 的会员名恰好等于店名 —— 多半是拿店名当会员名填了（实测已推翻这个假设）`);
      if (row.alimamaMemberId) {
        assert.match(row.alimamaMemberId, /^\d{6,}$/u, `${row.key} 的会员 ID 必须是 6 位以上数字`);
      }
    }
    assert.ok(row.evidence, `${row.key} 缺少证据字段`);
  }
  // 实测级别是**闭集**：多出一个级别时 `describeIdentity` 会退回含糊的「（未实测）」，
  // 把「人工填的」与「根本没填」显示成同一个样子。所以未知级别必须在这里就红。
  for (const row of SHOP_IDENTITIES) {
    for (const level of [row.sycmHeaderVerified, row.alimamaVerified]) {
      if (level === null) continue;
      assert.ok(level in IDENTITY_VERIFIED_LABEL,
        `${row.key} 的实测级别「${level}」不在 IDENTITY_VERIFIED_LABEL 里 —— 摘要会把它显示成「未实测」`);
    }
  }
  // 实测过的家数要如实反映现实：
  //   页头店名：2026-09-18/19 测了 5 家；第 13 家与另外 7 家是 09-29 之后才建底座，还没测。
  //   会员名：**2026-09-30 换操作员后归零** —— 13 家全部改成账号表给定的人，都只是 human-record。
  assert.equal(SHOP_IDENTITIES.filter((row) => row.sycmHeaderVerified === 'expression').length, 5);
  assert.equal(SHOP_IDENTITIES.filter((row) => row.alimamaVerified === 'expression').length, 0,
    '换操作员之后没有任何一家的会员名够得上 expression —— 明天实测完再升');
  assert.equal(SHOP_IDENTITIES.filter((row) => row.alimamaVerified === 'human-record').length, 13);
});

test('隔离 profile：键唯一、值唯一、与登记表逐键一致，三张清单互相自洽', () => {
  const entries = Object.entries(ISOLATED_PROFILES);
  // 2026-09-30：12 家 → 13 家（第 13 家网林定制淘宝也分到独立 profile）。
  assert.equal(entries.length, 13);
  assert.equal(new Set(entries.map(([, profile]) => profile)).size, entries.length,
    '两个店铺共用一个 profile 是复制粘贴事故的高发形态');
  for (const [key, profile] of entries) {
    shopIdentity(key); // 未登记会抛错
    assert.match(profile, /^[a-z0-9-]+$/u);
  }
  assert.deepEqual(Object.keys(ISOLATED_PROFILES).sort(), shopKeys().sort(),
    'ISOLATED_PROFILES 的键必须与登记表逐键一致：少一家＝这家跑不了，多一家＝有个孤儿目录');

  // 三张清单是**显式记账**，不是隐式豁免：新加一家店时它们会当场红，
  // 逼着人要么去实测、要么把它写下来当成一个能被复审的决定。
  const headerVerified = SHOP_IDENTITIES
    .filter((row) => row.sycmHeaderVerified === 'expression').map((row) => row.key);
  assert.deepEqual([...IDENTITY_SHOP_HEADER_VERIFIED_SHOPS].sort(), headerVerified.sort(),
    '页头店名清单必须与字段一致');
  const memberMeasured = SHOP_IDENTITIES
    .filter((row) => row.alimamaVerified === 'expression').map((row) => row.key);
  assert.deepEqual([...IDENTITY_MEMBER_MEASURED_SHOPS].sort(), memberMeasured.sort(),
    '会员名清单必须与字段一致（换操作员后它应当是空的）');
  assert.deepEqual([...IDENTITY_PENDING_SHOPS].sort(), shopKeys().sort(),
    '2026-09-30 换操作员后 13 家的会员名都要重测 —— 待实测名单就该是全部 13 家，不是 8 家');
  for (const key of IDENTITY_MEMBER_MEASURED_SHOPS) {
    assert.equal(IDENTITY_PENDING_SHOPS.includes(key), false, `${key} 同时在两张清单里`);
  }
});

test('未登记的店铺一律抛错（fail-closed），不回落成「不核对」', () => {
  assert.throws(() => shopIdentity('盖文1688'), /未登记的店铺「盖文1688」/u);
  assert.throws(() => shopIdentity('盖文天猫 '), /未登记的店铺/u,
    '带空格的叫法不该被静默当成同一家店 —— 幂等键的一半就是这个名字');
  assert.throws(() => shopIdentity(undefined), /未登记的店铺/u);
});

test('expectArgs：能给的给，给不了的如实列进 missing；require 时缺字段直接抛错', () => {
  const full = expectArgs('里可林淘宝');
  assert.deepEqual(full.args, [
    '--expect-shop', '里可林家居',
    '--expect-member', '里可林家居:小宁',
    '--expect-member-id', '2350600069',
  ]);
  assert.deepEqual(full.missing, []);

  // 只有会员名、没有会员 ID 的店（第 13 家与另外 7 家）：member 算「已知」——
  // 只给 name 时 assertMemberIdentity 照样是有效闸门，所以不许因为缺 ID 就判它缺失。
  const nameOnly = expectArgs('网林定制淘宝');
  assert.deepEqual(nameOnly.args, ['--expect-member', '网林定制家居:嘉嘉']);
  assert.deepEqual(nameOnly.missing, ['shop'],
    '页头店名还没实测 ⇒ 只有 shop 缺失；member 不该被算进去');

  // require 了就必须有 —— 这条堵的是「以为开着守卫、其实少给了一个参数」。
  assert.throws(() => expectArgs('网林定制淘宝', { require: ['shop'] }), /还没有实测值/u);
  assert.throws(() => expectArgs('网林定制淘宝', { require: ['shop'] }), /生意参谋页头店名/u,
    '报错要带上证据字段与出处，否则下一个人只能靠猜「为什么没有」');
  assert.throws(() => expectArgs('网林定制淘宝', { require: ['shop'] }), /待人工登录后实测/u);
  // require member **不该**抛：13 家的会员名都有了（来自账号表），闸门开得起来。
  assert.doesNotThrow(() => expectArgs('网林定制淘宝', { require: ['member'] }),
    '只有会员名的店也必须能开 member 闸门 —— 不给就等于把这道判据白关掉');
  assert.deepEqual(expectArgs('里可林淘宝', { require: ['shop', 'member'] }).args.length, 6);
});

test('把登记表接回真实判据：逐店自比必须过', () => {
  // 这一条是「这份表能当判据用」的证明：拿登记表里的期望值，去比对同样从登记表里取的观测值，
  // 等价于「窗口真的是这家店时，判据不会误拦」。
  for (const row of SHOP_IDENTITIES) {
    if (row.sycmHeader) {
      const result = assertShopIdentity({ expected: row.sycmHeader, observed: row.sycmHeader, label: '生意参谋店铺' });
      assert.deepEqual(result, { checked: true, expected: row.sycmHeader, observed: row.sycmHeader });
    }
    if (row.alimamaMemberName) {
      const result = assertMemberIdentity({
        expectedName: row.alimamaMemberName,
        expectedId: row.alimamaMemberId,
        observed: { memberName: row.alimamaMemberName, memberId: row.alimamaMemberId },
      });
      assert.equal(result.checked, true);
    }
  }
});

test('把登记表接回真实判据：跨店比对必须停，而且要点名期望/实际两侧', () => {
  // 13 家店两两组合，任何一对都不许被放过 —— 这是「绝不串数据」这条要求的判据化。
  let pairs = 0;
  for (const a of SHOP_IDENTITIES) {
    for (const b of SHOP_IDENTITIES) {
      if (a === b) continue;
      pairs += 1;
      assert.throws(() => assertShopIdentity({ expected: a.fullName, observed: b.fullName, label: '生意参谋店铺' }),
        new RegExp(`期望「${a.fullName}」`, 'u'),
        `「${a.key}」的期望值放行到了「${b.key}」的页面`);
    }
  }
  assert.equal(pairs, 156, '13 家店的跨店组合应为 13×12');

  // 同一家的淘宝店与龙头店是最容易混的一对（科塔出现两次：科塔全卫定制 / 科塔建材卫浴）。
  assert.throws(() => assertShopIdentity({
    expected: shopIdentity('科塔淘宝').fullName,
    observed: shopIdentity('科塔龙头店').fullName,
    label: '生意参谋店铺',
  }), /期望「科塔全卫定制」，页面实际「科塔建材卫浴」/u);

  // 会员侧同理：名字对不上或 ID 对不上都要停，且提示里要说明为什么两个都要对。
  assert.throws(() => assertMemberIdentity({
    expectedName: shopIdentity('盖文淘宝').alimamaMemberName,
    expectedId: shopIdentity('盖文淘宝').alimamaMemberId,
    observed: { memberName: shopIdentity('盖文淘宝').alimamaMemberName, memberId: '412070158' },
  }), /会员 ID 对不上/u);
  assert.throws(() => assertMemberIdentity({
    expectedName: shopIdentity('盖文淘宝').alimamaMemberName,
    expectedId: shopIdentity('盖文淘宝').alimamaMemberId,
    observed: { memberName: '随心品质定制', memberId: shopIdentity('盖文淘宝').alimamaMemberId },
  }), /阿里妈妈会员名身份对不上/u);
});

test('describeIdentity 给出人读摘要，未实测/非实测的部分要显式标出来', () => {
  // 科塔淘宝现在是**混合**的：页头店名 2026-09-18 用采集表达式实测过（expression ⇒ 不带标记），
  // 会员名 2026-09-30 刚换成账号表上的操作员（human-record ⇒ 必须带标记）。
  // 这一条正是原实现栽的地方：`'human-record'` 是 truthy，会被当成「已实测」而不打标记。
  const mixed = describeIdentity('科塔淘宝');
  assert.match(mixed, /科塔全卫定制/u);
  assert.match(mixed, /j873522735:嘉慧/u);
  assert.doesNotMatch(mixed, /科塔全卫定制（/u, '实测过（expression）的页头店名不该带任何标记');
  assert.match(mixed, /嘉慧（人工记录，未实测）/u,
    'human-record 的会员名不许显示成已实测 —— 「人工填的」与「实测的」不能长得一样');
  // 完全没测过的店（第 13 家）：页头店名与会员 ID 两处都要标出来。
  const pending = describeIdentity('网林定制淘宝');
  assert.match(pending, /页头店名 （未实测）/u);
  assert.match(pending, /嘉嘉（人工记录，未实测）/u,
    '未实测的行在摘要里必须看得见 —— 「什么都没有」和「已核对过」不能长得一样');
});

test('打印器：可粘贴内容只走 stdout，提示走 stderr；require 不满足即非零退出', () => {
  const script = path.join(SCRIPTS_DIR, 'show-shop-identity.mjs');
  // 用 process.execPath 而不是写死 node 路径：换机器/换 runtime 时这条测试不该跟着坏。
  //
  // 必须用 spawnSync、不能用 execFileSync（2026-09-30 修）：execFileSync **只在失败时**
  // 才把 stderr 交出来，成功路径上的 stderr 直接丢掉。而「缺 shop 时要印一行 stderr 提示」
  // 这条判据正好长在**成功路径**上（退出码 0，只是少给了一个参数）——
  // 用 execFileSync 会让这条断言永远读到一个空串，于是它守的东西全靠运气。
  // `stdio` 的第一项必须是 `ignore`：宿主沙箱下带 stdin 管道会 EBUSY。
  const run = (args) => {
    const result = spawnSync(process.execPath, [script, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };

  const list = run([]);
  assert.equal(list.code, 0);
  assert.equal(SHOP_IDENTITIES.filter((row) => list.stdout.includes(row.key)).length, 13,
    '一览必须把 13 家都列出来（少一家就会有人以为这家不用跑）');

  const one = run(['里可林淘宝']);
  assert.equal(one.code, 0);
  assert.equal(one.stdout, '--expect-shop 里可林家居 --expect-member 里可林家居:小宁 --expect-member-id 2350600069\n',
    'stdout 必须干净到可以直接粘 —— 多一行提示就会把命令行粘坏');
  assert.equal(one.stderr, '');

  // 「只有会员名、页头店名还没实测」的店（第 13 家与另外 7 家）：
  // 印出能给的那一项，缺的那一项**走 stderr 点名** —— 但 stdout 仍必须干净可粘。
  //
  // 注意（2026-09-30 起）：换操作员之后 13 家的会员名都有了 ⇒ 原来那个
  // 「一个 --expect-* 都印不出、只印一行 # 注释」的分支已经没有店对应得上，
  // 所以这里守的是「缺 shop 时 stdout 只带 member」。那个分支本身还在实现里
  // （`args.length === 0`），但**没有店能走到** —— 这是如实记账，不是漏测。
  const nameOnly = run(['网林定制淘宝']);
  assert.equal(nameOnly.code, 0);
  assert.equal(nameOnly.stdout, '--expect-member 网林定制家居:嘉嘉\n');
  assert.match(nameOnly.stderr, /shop 还没有实测值/u,
    '缺页头店名要在 stderr 点名，不能一声不响地少给一个参数（调用方会以为守卫开着）');

  // 带空格的店名（保拉淘宝的全称是 `Paola Lenti保拉伦蒂`）—— 引号规则单独测，
  // 因为当前没有一家「带空格且已实测」的店，只有这一条能守住它。
  assert.equal(formatArgv(['--expect-shop', 'Paola Lenti保拉伦蒂', '--expect-member', 'j873522735:嘉慧']),
    '--expect-shop "Paola Lenti保拉伦蒂" --expect-member j873522735:嘉慧',
    '带空格的参数必须加引号；带冒号的会员名不该被加引号');

  const blocked = run(['安比淘宝', '--require', 'shop']);
  assert.equal(blocked.code, 2, 'require 不满足必须非零退出，否则它当不了闸门');
  assert.match(blocked.stderr, /还没有实测值/u);
  assert.match(blocked.stderr, /生意参谋页头店名/u);
  assert.match(blocked.stderr, /待人工登录后实测/u, '报错要带证据出处，下一个人不用靠猜「为什么没有」');
  // require member **不该**被拒：13 家的会员名都有（来自账号表），这道闸门开得起来。
  assert.equal(run(['安比淘宝', '--require', 'member']).code, 0,
    '只有会员名的店也必须能开 member 闸门 —— 不给就等于把这道判据白关掉');

  assert.equal(run(['安比淘宝', '--require', 'platform']).code, 2, '--require 只认 shop / member');
  assert.equal(run(['盖文1688']).code, 2, '未登记的店铺要非零退出并点名');
  assert.match(run(['盖文1688']).stderr, /未登记的店铺/u);
});

test('登记表与文档里的四处名字对不上的坑：会员名与店名不同名是**正常**的', () => {
  // 这一条把「实测已推翻的那个假设」钉死：不能靠「店名 + `:` + 子账号」派生会员名。
  const weixin = shopIdentity('盖文淘宝');
  assert.notEqual(weixin.alimamaMemberName, `${weixin.key}:小瓜`);
  assert.notEqual(weixin.alimamaMemberName, `${weixin.fullName}:小瓜`);
  // 但确有同名的（里可林：店名就是会员名的前缀），所以判据也不许反过来假设「一定不同名」。
  assert.equal(shopIdentity('里可林淘宝').alimamaMemberName, '里可林家居:小宁');
  // 整个文件里不许出现「用店名拼会员名」的派生代码。
  //
  // 要先去注释：这份文件顶上的说明里**正好在讲**「不要派生」，
  // 连着注释一起匹配就会把说明本身当成违规（一次假红，而且是最无聊的那种）。
  // 去注释后必须再自证「剥掉的确实是注释」——否则一个把整份文件剥空的实现
  // 会让这条守卫永远为绿（坑 33：空结果不能被读成「没问题」）。
  const source = readFileSync(path.join(SCRIPTS_DIR, 'shop-identities.mjs'), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
  assert.ok(code.includes('export const SHOP_IDENTITIES'), '去注释后代码主体不见了 —— 剥离实现有问题');
  assert.ok(!code.includes('分开存而不是派生成'), '去注释没生效：说明文字还在，这条守卫会假红');
  // 判据不写死任何具体子账号（写死 `:阿彦` 时，换操作员后这条守卫会变成**永远为绿**的空检查——
  // 源码里早就没有 `:阿彦` 了）：禁的是「拿 key 插值后面跟冒号」这个**形状**本身。
  assert.doesNotMatch(code, /`\$\{[^}]*\bkey\b[^}]*\}:/u,
    '出现「`${…key…}:`」这种形状 ⇒ 有人又把会员名派生了');
});

// 证据目录的店铺键（2026-09-18 一轮多店铺实测）。
// 加这一维是为了让四家店不再互相覆盖，但这样一来目录名本身成了一个**断言**：
// 一个叫 `…-网林天猫` 的目录里如果是里可林的数据，下一个复盘的人会得出完全错误的结论。
// 所以键必须与能观察到的源产物名字对齐，对不上就停手（错标签比不贴标签更糟）。
test('证据目录的店铺键：与源产物店名一致才放行，一致就返回登记行', () => {
  const row = assertEvidenceShopKey('科塔淘宝', { fullName: '科塔全卫定制' });
  assert.equal(row.key, '科塔淘宝');
  assert.equal(row.fullName, '科塔全卫定制');
  // 回填方只能观察到 `--shop`（飞书选项名），那就只核这一面 —— 而它的值应等于运营叫法。
  assert.equal(assertEvidenceShopKey('盖文天猫', { shopKey: '盖文天猫' }).key, '盖文天猫');
  // 什么都不给 ⇒ 只做「必须是已登记的键」这一件事，不假装核过。
  assert.equal(assertEvidenceShopKey('里可林淘宝').key, '里可林淘宝');
});

test('证据目录的店铺键：错标签一律抛错并点名两边（原样比，不做相似度猜）', () => {
  // ① 源产物店名对不上：把科塔的目录键配上网林的源产物。
  assert.throws(() => assertEvidenceShopKey('科塔淘宝', { fullName: '网林家居旗舰店' }),
    /源产物里的店名 "网林家居旗舰店" ≠ 登记的平台店铺全称 "科塔全卫定制"/u);
  // ② 同一命令里两处叫法不一致：`--shop-key 科塔淘宝` 配 `--shop 盖文天猫`。
  assert.throws(() => assertEvidenceShopKey('科塔淘宝', { shopKey: '盖文天猫' }),
    /另一处给的店铺叫法 "盖文天猫" ≠ "科塔淘宝"/u);
  // ③ 未登记的键：不回落成「不核对」，直接停（否则随便一个字符串都能当目录后缀）。
  assert.throws(() => assertEvidenceShopKey('盖文旗舰店', { fullName: '盖文旗舰店' }), /未登记的店铺/u);
  assert.throws(() => assertEvidenceShopKey('', {}), /未登记的店铺/u);
  // ④ 「差一点就对」的形态也一律拒：短名、带空格、大小写都算另一家店。
  assert.throws(() => assertEvidenceShopKey('科塔淘宝', { fullName: '科塔' }), /对不上/u);
  assert.throws(() => assertEvidenceShopKey('保拉淘宝', { fullName: 'Paola Lenti保拉伦蒂 ' }), /对不上/u);
  // 反向自证：正确的组合不许被误伤（否则上面全是「一律抛错」也能全绿）。
  assert.doesNotThrow(() => assertEvidenceShopKey('保拉淘宝', { fullName: 'Paola Lenti保拉伦蒂' }));
});
