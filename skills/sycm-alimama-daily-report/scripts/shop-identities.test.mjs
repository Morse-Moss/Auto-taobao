// 登记表的守卫用例。
//
// 这份测试要守住的是**四件不同的事**，别混成一件：
//   ① 形状：12 行、key 与页头店名都唯一（唯一性不是洁癖 —— 它正是「按页头店名能唯一认店」的判据，
//      页头店名一旦重复，§5.3.2 里那四个窗口就再也定不下名）；
//   ② 忠实：登记行与「照抄读回的原文」（RAW_MAPPING_ROWS）是双射，没有抄错也没有漏行；
//   ③ 诚实：已实测的行字段必须齐全（不许出现「有会员名没会员ID」这种半截身份），
//      未实测的行必须整行为 null —— 不许把推测值填进判据；
//   ④ 可用：把登记表接回真实判据（assertShopIdentity / assertMemberIdentity）跑一遍 ——
//      逐店自比必须过，跨店比对必须停。第 ④ 条才算「这份表能当判据用」的证明；
//      没有它，前三件全绿也可能只是一份没人用的文档。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { assertMemberIdentity, assertShopIdentity } from './collect-core.mjs';
import {
  ISOLATED_PROFILES, MAPPING_SOURCE, RAW_MAPPING_ROWS, SHOP_IDENTITIES,
  assertEvidenceShopKey, describeIdentity, expectArgs, formatArgv, platformOf, shopIdentity,
  shopIdentityByHeader, shopKeys,
} from './shop-identities.mjs';

const SCRIPTS_DIR = import.meta.dirname;
const PLATFORMS = new Set(['taobao', 'tmall', 'leading']);

test('登记表：12 行，运营叫法与页头店名都唯一', () => {
  assert.equal(SHOP_IDENTITIES.length, 12);
  assert.equal(MAPPING_SOURCE.recordCount, SHOP_IDENTITIES.length,
    '出处里写的行数必须与登记行数一致（否则就是抄漏了）');
  assert.equal(MAPPING_SOURCE.readAt, '2026-09-18');

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
  assert.equal(RAW_MAPPING_ROWS.length, 12);
  assert.deepEqual(RAW_MAPPING_ROWS.map(([fullName, key]) => `${fullName}|${key}`).sort(),
    SHOP_IDENTITIES.map((row) => `${row.fullName}|${row.key}`).sort(),
    '登记表与飞书那张「店铺底单」必须逐行同名——这一条同时挡住「抄漏一行」与「两列写反」');
  // 逐行确认派生方向不是凑巧（两个集合相等的写法在上一条，这里再钉一次「同一行内」的配对）。
  for (const [fullName, key] of RAW_MAPPING_ROWS) {
    assert.equal(shopIdentity(key).fullName, fullName,
      `「${key}」的平台店铺全称应为「${fullName}」——两列写反是最容易发生、也最难发现的一种抄错`);
  }
  // 页头店名查回店铺：唯一命中才允许（shixi 里就是靠这一条把四个窗口定下名的）。
  for (const [fullName, key] of RAW_MAPPING_ROWS) {
    assert.equal(shopIdentityByHeader(fullName).key, key);
  }
  assert.throws(() => shopIdentityByHeader('盖文'), /没有哪家店的平台店铺全称是/u);
});

test('平台后缀与 platform 字段一致；未知后缀当场抛错', () => {
  for (const row of SHOP_IDENTITIES) {
    assert.equal(row.platform, platformOf(row.key), `${row.key} 的 platform 与后缀不一致`);
  }
  assert.throws(() => platformOf('科塔1688'), /没有已知的平台后缀/u);
  // 12 家店的平台分布（4 个天猫 / 6 个淘宝 / 2 个龙头店）：这条不是为了好看，
  // 而是把「只有淘宝和天猫」这个直觉错判钉住 —— 本来就有两家是「龙头店」。
  const count = (platform) => SHOP_IDENTITIES.filter((row) => row.platform === platform).length;
  assert.deepEqual({ taobao: count('taobao'), tmall: count('tmall'), leading: count('leading') },
    { taobao: 6, tmall: 4, leading: 2 });
});

test('诚实性：已实测的行字段齐全，未实测的行整行为 null', () => {
  for (const row of SHOP_IDENTITIES) {
    const shopKnown = row.sycmHeaderVerified !== null;
    const memberKnown = row.alimamaVerified !== null;
    assert.equal(shopKnown, row.sycmHeader !== null && row.sycmHeader !== '',
      `${row.key}：sycmHeaderVerified 与 sycmHeader 必须同时有值或同时为空`);
    // 「半截身份」要分两步判：只判「两个都有值 == verified 非空」是**不够**的 ——
    // 实测漏网一例：把会员名填上、会员ID 留空时，两边都算 false，断言会相等地通过。
    // 所以先要求「有没有值」与「算不算已实测」一致，再单独要求「两个字段成对出现」。
    assert.equal(memberKnown, Boolean(row.alimamaMemberName && row.alimamaMemberId),
      `${row.key}：alimamaVerified 与「会员名/ID 是否有值」必须一致`);
    assert.equal(Boolean(row.alimamaMemberName || row.alimamaMemberId),
      Boolean(row.alimamaMemberName && row.alimamaMemberId),
      `${row.key}：会员名与会员ID 必须成对出现，不许半截身份（有一个另一个没一个）`);
    if (shopKnown) assert.equal(row.sycmHeader, row.fullName,
      `${row.key}：实测到的页头店名与平台店铺全称不一致 —— 这两者不同名时，必须把实测值单列，不能拿 fullName 冒充`);
    if (memberKnown) {
      assert.match(row.alimamaMemberId, /^\d{6,}$/u, `${row.key} 的会员 ID 必须是 6 位以上数字`);
      assert.match(row.alimamaMemberName, /^.{2,20}:.{1,20}$/u,
        `${row.key} 的会员名应形如「主账号:子账号」`);
      assert.notEqual(row.alimamaMemberName, row.key,
        `${row.key} 的会员名恰好等于店名 —— 多半是拿店名当会员名填了（实测已推翻这个假设）`);
    }
    assert.ok(row.evidence, `${row.key} 缺少证据字段`);
  }
  // 实测过的家数要如实反映现实：2026-09-18 只有 5 家（四个隔离窗口 + 生产那家）。
  assert.equal(SHOP_IDENTITIES.filter((row) => row.sycmHeaderVerified !== null).length, 5);
  assert.equal(SHOP_IDENTITIES.filter((row) => row.alimamaVerified === 'expression').length, 4);
});

test('隔离 profile：键唯一、值唯一、必须是已登记店铺、且该店两侧身份都已实测', () => {
  const entries = Object.entries(ISOLATED_PROFILES);
  // 2026-09-19：四家 → 五家（加盖文天猫）。用户当日口径：盖文旗舰店与盖文全卫定制是两家店，
  // 全卫＝盖文淘宝、旗舰店＝盖文天猫，「没有专用浏览器就新增一个」。
  assert.equal(entries.length, 5);
  assert.equal(new Set(entries.map(([, profile]) => profile)).size, entries.length,
    '两个店铺共用一个 profile 是复制粘贴事故的高发形态');
  for (const [key, profile] of entries) {
    const row = shopIdentity(key); // 未登记会抛错
    assert.ok(row.sycmHeaderVerified && row.alimamaVerified,
      `${key} 被标成有专用 profile，但身份没实测齐 —— 这条记录会误导下一个人`);
    assert.match(profile, /^[a-z0-9-]+$/u);
  }

  // 「验到表达式级」这张清单是**显式的**，不是隐式豁免：新加一家时它会当场红，逼着人要么去实测、
  // 要么把它写在这里当成一条记账（写下来就是一个能被复审的决定，而不是一个静默的洞）。
  // 2026-09-19 的历史状态：盖文天猫当天刚分配窗口、账号还没登录过，两侧身份是 2026-09-17
  // 从生产窗口读到/人工抄下来的（`text` / `human-record`）；那台窗口登录后应升到 `expression` 并清空这里。
  const notExpressionVerified = entries
    .filter(([key]) => {
      const row = shopIdentity(key);
      return row.sycmHeaderVerified !== 'expression' || row.alimamaVerified !== 'expression';
    })
    .map(([key]) => key);
  assert.deepEqual(notExpressionVerified, ['盖文天猫'],
    '有专用窗口的店应在登录后把身份验到表达式级；这张清单只该有「刚建窗口、还没登录」的那一家');
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
    '--expect-member', '里可林家居:阿彦',
    '--expect-member-id', '2350600069',
  ]);
  assert.deepEqual(full.missing, []);

  // 未实测的店：不带 require 时「知道多少给多少」，但必须如实说缺什么。
  const partial = expectArgs('安比淘宝');
  assert.deepEqual(partial.args, []);
  assert.deepEqual(partial.missing.sort(), ['member', 'shop']);

  // require 了就必须有 —— 这条堵的是「以为开着守卫、其实少给了一个参数」。
  assert.throws(() => expectArgs('安比淘宝', { require: ['shop'] }), /还没有实测值/u);
  assert.throws(() => expectArgs('安比淘宝', { require: ['member'] }), /还没有实测值/u);
  assert.throws(() => expectArgs('安比淘宝', { require: ['member'] }), /未实测：没有该店的隔离窗口/u,
    '报错要带上证据字段，否则下一个人只能靠猜「为什么没有」');
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
  // 12 家店两两组合，任何一对都不许被放过 —— 这是「绝不串数据」这条要求的判据化。
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
  assert.equal(pairs, 132, '12 家店的跨店组合应为 12×11');

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

test('describeIdentity 给出人读摘要，未实测要显式标出来', () => {
  const verified = describeIdentity('科塔淘宝');
  assert.match(verified, /科塔全卫定制/u);
  assert.match(verified, /j873522735:阿彦/u);
  assert.doesNotMatch(verified, /未实测/u);
  const pending = describeIdentity('安比淘宝');
  assert.match(pending, /（未实测）/u,
    '未实测的行在摘要里必须看得见 —— 「什么都没有」和「已核对过」不能长得一样');
});

test('打印器：可粘贴内容只走 stdout，提示走 stderr；require 不满足即非零退出', () => {
  const script = path.join(SCRIPTS_DIR, 'show-shop-identity.mjs');
  // 用 process.execPath 而不是写死 node 路径：换机器/换 runtime 时这条测试不该跟着坏。
  const run = (args) => {
    try {
      const stdout = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  };

  const list = run([]);
  assert.equal(list.code, 0);
  assert.equal(SHOP_IDENTITIES.filter((row) => list.stdout.includes(row.key)).length, 12,
    '一览必须把 12 家都列出来（少一家就会有人以为这家不用跑）');

  const one = run(['里可林淘宝']);
  assert.equal(one.code, 0);
  assert.equal(one.stdout, '--expect-shop 里可林家居 --expect-member 里可林家居:阿彦 --expect-member-id 2350600069\n',
    'stdout 必须干净到可以直接粘 —— 多一行提示就会把命令行粘坏');
  assert.equal(one.stderr, '');

  // 未实测的店：不许印出「看起来能用」的参数，也不许假装成功。
  const pending = run(['安比淘宝']);
  assert.equal(pending.code, 0);
  assert.match(pending.stdout, /^#/u);
  assert.doesNotMatch(pending.stdout, /--expect-/u, '没有任何实测值时不该印出任何 --expect-* 参数');

  // 带空格的店名（保拉淘宝的全称是 `Paola Lenti保拉伦蒂`）—— 引号规则单独测，
  // 因为当前没有一家「带空格且已实测」的店，只有这一条能守住它。
  assert.equal(formatArgv(['--expect-shop', 'Paola Lenti保拉伦蒂', '--expect-member', 'j873522735:阿彦']),
    '--expect-shop "Paola Lenti保拉伦蒂" --expect-member j873522735:阿彦',
    '带空格的参数必须加引号；带冒号的会员名不该被加引号');

  const blocked = run(['安比淘宝', '--require', 'member']);
  assert.equal(blocked.code, 2, 'require 不满足必须非零退出，否则它当不了闸门');
  assert.match(blocked.stderr, /还没有实测值/u);
  assert.match(blocked.stderr, /未实测：没有该店的隔离窗口/u);

  assert.equal(run(['安比淘宝', '--require', 'platform']).code, 2, '--require 只认 shop / member');
  assert.equal(run(['盖文1688']).code, 2, '未登记的店铺要非零退出并点名');
  assert.match(run(['盖文1688']).stderr, /未登记的店铺/u);
});

test('登记表与文档里的四处名字对不上的坑：会员名与店名不同名是**正常**的', () => {
  // 这一条把「实测已推翻的那个假设」钉死：不能靠 `\${店名}:阿彦` 派生会员名。
  const weixin = shopIdentity('盖文淘宝');
  assert.notEqual(weixin.alimamaMemberName, `${weixin.key}:阿彦`);
  assert.notEqual(weixin.alimamaMemberName, `${weixin.fullName}:阿彦`);
  // 但确有同名的（里可林），所以判据也不许反过来假设「一定不同名」。
  assert.equal(shopIdentity('里可林淘宝').alimamaMemberName, '里可林家居:阿彦');
  // 整个文件里不许出现「用店名拼会员名」的派生代码。
  //
  // 要先去注释：这份文件顶上的说明里**正好在讲**「不要派生成 `${key}:阿彦`」，
  // 连着注释一起匹配就会把说明本身当成违规（一次假红，而且是最无聊的那种）。
  // 去注释后必须再自证「剥掉的确实是注释」——否则一个把整份文件剥空的实现
  // 会让这条守卫永远为绿（坑 33：空结果不能被读成「没问题」）。
  const source = readFileSync(path.join(SCRIPTS_DIR, 'shop-identities.mjs'), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
  assert.ok(code.includes('export const SHOP_IDENTITIES'), '去注释后代码主体不见了 —— 剥离实现有问题');
  assert.ok(!code.includes('分开存而不是派生成'), '去注释没生效：说明文字还在，这条守卫会假红');
  assert.doesNotMatch(code, /`\$\{[^}]*key[^}]*\}:阿彦`/u);
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
