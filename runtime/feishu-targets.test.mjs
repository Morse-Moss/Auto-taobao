import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_PROFILE,
  DEPARTMENT_LABELS,
  PRODUCT_DATA_MONTH_BASES,
  PROFILES,
  PROFILE_ENV_VAR,
  SHOP_DEPARTMENTS,
  STABLE_TABLE_KEYS,
  activeProfileName,
  assertProductDataBaseCoverage,
  baseUrl,
  competitorBaseToken,
  dailyReportTargets,
  promotionDailyTargets,
  departmentOfShop,
  feishuMonthOf,
  productDataBaseKey,
  productDataTargets,
  productDataTargetsForShop,
  envFilePath,
  getProfile,
  keywordBaseToken,
  loadFeishuCredentials,
  parseEnvFile,
  profileTargets,
  resolveProfileName,
  tableId,
} from './feishu-targets.mjs';

const PROFILE_NAMES = Object.keys(PROFILES);

test('两个 profile 覆盖同一批稳定表逻辑名', () => {
  for (const name of PROFILE_NAMES) {
    assert.deepEqual(Object.keys(PROFILES[name].tables).sort(), [...STABLE_TABLE_KEYS].sort(), name);
  }
  assert.deepEqual([...STABLE_TABLE_KEYS].sort(), ['competitorMain', 'history', 'questionMaster', 'skuDetail']);
});

test('所有 table id 互不相同且形状合法', () => {
  const seen = new Map();
  for (const name of PROFILE_NAMES) {
    for (const [logical, id] of Object.entries(PROFILES[name].tables)) {
      assert.match(id, /^tbl[A-Za-z0-9]{10,}$/u, `${name}.${logical}`);
      assert.equal(seen.has(id), false, `${id} 在 ${seen.get(id)} 与 ${name}.${logical} 重复`);
      seen.set(id, `${name}.${logical}`);
    }
  }
});

test('每个 profile 的 base 与 baseUrl 自洽', () => {
  for (const name of PROFILE_NAMES) {
    const profile = PROFILES[name];
    assert.match(profile.competitorBase, /^[A-Za-z0-9]{20,}$/u, name);
    assert.equal(baseUrl(name), `https://${profile.host}/base/${profile.competitorBase}`);
    assert.equal(competitorBaseToken(name), profile.competitorBase);
  }
});

test('profile 是冻结的（运行时改不动目标）', () => {
  assert.equal(Object.isFrozen(PROFILES), true);
  assert.equal(Object.isFrozen(PROFILES.legacy), true);
  assert.equal(Object.isFrozen(PROFILES.legacy.tables), true);
  assert.throws(() => {
    PROFILES.legacy.competitorBase = 'tampered';
  }, TypeError);
});

test('别名解析，未知名字抛错', () => {
  assert.equal(resolveProfileName(undefined), DEFAULT_PROFILE);
  assert.equal(resolveProfileName('old'), 'legacy');
  assert.equal(resolveProfileName('rcndesfqro3x'), 'legacy');
  assert.equal(resolveProfileName('new'), 'kcne');
  assert.equal(resolveProfileName('kcne618basvj'), 'kcne');
  assert.throws(() => resolveProfileName('nope'), /Unknown Feishu profile/u);
});

test('环境变量切换生效，且不改变默认值', () => {
  assert.equal(activeProfileName({}), DEFAULT_PROFILE);
  assert.equal(activeProfileName({ [PROFILE_ENV_VAR]: 'kcne' }), 'kcne');
  assert.equal(activeProfileName({ [PROFILE_ENV_VAR]: 'legacy' }), 'legacy');
  assert.equal(activeProfileName({ [PROFILE_ENV_VAR]: '' }), DEFAULT_PROFILE);
  assert.throws(() => activeProfileName({ [PROFILE_ENV_VAR]: 'zzz' }), /Unknown Feishu profile/u);
});

// 默认值是「当前生产目标」。2026-09-14 从 legacy 切到 kcne（旧租户废弃）；
// 2026-09-15 又把 kcne 的竞品 base 从迁移期测试副本切到用户指定的正式 base。
// 这条断言的作用是：默认值一旦被改动而没人同步文档/记忆，它会当场失败。
test('默认 profile 是当前生产租户（kcne），且旧租户仍可显式选择', () => {
  assert.equal(DEFAULT_PROFILE, 'kcne');
  assert.equal(getProfile(undefined).envFile, 'E:/小红书/.env.feishu-kcne.local');
  assert.equal(getProfile(undefined).competitorBase, 'QcnhbEzYpacGvUskCbVcrcm3nFd');
  // 回滚路径必须一直可用：显式选 legacy 仍拿得到旧租户的目标
  assert.equal(getProfile('legacy').envFile, 'E:/小红书/.env.local');
  assert.equal(getProfile('legacy').competitorBase, 'OWebbPUcBa7B8JseYLccQCy9nkf');
});

test('tableId 命中逻辑名，未知逻辑名抛错', () => {
  assert.equal(tableId('history', 'legacy'), 'tblH0bmmOuogxDHi');
  assert.equal(tableId('history', 'kcne'), 'tbln7qqA6XopiL4Q');
  assert.notEqual(tableId('competitorMain', 'legacy'), tableId('competitorMain', 'kcne'));
  assert.throws(() => tableId('historyV2'), /Unknown Feishu table logical name/u);
  assert.throws(() => tableId('history', 'nope'), /Unknown Feishu profile/u);
});

test('凭据文件路径与 baseUrl 按 profile 分开', () => {
  assert.notEqual(envFilePath('legacy'), envFilePath('kcne'));
  const targets = profileTargets('kcne');
  assert.equal(targets.envFile, 'E:/小红书/.env.feishu-kcne.local');
  assert.match(targets.baseUrl, /^https:\/\/kcne618basvj\.feishu\.cn\/base\/QcnhbEzYp/u);
  // 2026-09-15：用户把应用加为正式 base 的可编辑协作者后，幂等写探针从 403/91403 变成
  // HTTP 200 / code 0 —— 这是「这个 base 已验证可写」的证据，所以声明值翻回 true。
  // 这条断言防的仍然是「把在别的 base 上验证过的结论，搬到现在这个 base 上」：
  // 下次换 base 时它必须跟着翻成 false，直到在新 base 上重新实测。
  assert.equal(targets.writeVerified, true);
});

// 关键词库是**另一张独立 base**（复制竞品 base 不会带上它），所以它的 token 单独维护、
// 也单独跟着租户切换——这条断言就是「两张 base 不能混搭」的守门人。
test('关键词库 base 独立于竞品 base，各自随 profile 切换', () => {
  assert.equal(keywordBaseToken('legacy'), 'N21Abkg0HakO6AsbCaDckvcwnVd');
  assert.equal(keywordBaseToken('kcne'), 'HdBhbttB5aScbasWJAMc0gGXnpe');
  assert.notEqual(keywordBaseToken('legacy'), keywordBaseToken('kcne'));
  assert.notEqual(keywordBaseToken('kcne'), competitorBaseToken('kcne'));
  assert.equal(keywordBaseToken('new'), keywordBaseToken('kcne')); // 别名同源
  assert.equal(profileTargets('kcne').keywordBase, keywordBaseToken('kcne'));
  assert.throws(() => keywordBaseToken('nope'), /Unknown Feishu profile/u);
});

test('parseEnvFile 处理注释、空行、引号与等号后的空格', () => {
  const parsed = parseEnvFile(['# comment', '', 'A=1', 'B = "two"', "C='three'", 'D=a=b'].join('\n'));
  assert.deepEqual(parsed, { A: '1', B: 'two', C: 'three', D: 'a=b' });
});

test('loadFeishuCredentials 只认 FEISHU_APP_ID / FEISHU_APP_SECRET', () => {
  const credentials = loadFeishuCredentials('kcne', {
    read: () => 'FEISHU_APP_ID=cli_x\nFEISHU_APP_SECRET=secret\n',
  });
  assert.equal(credentials.appId, 'cli_x');
  assert.equal(credentials.appSecret, 'secret');
  assert.equal(credentials.file, 'E:/小红书/.env.feishu-kcne.local');
  assert.throws(
    () => loadFeishuCredentials('kcne', { read: () => 'FEISHU_APP_ID=cli_x\n' }),
    /must define FEISHU_APP_ID and FEISHU_APP_SECRET/u,
  );
  assert.throws(
    () => loadFeishuCredentials('kcne', { read: () => { throw new Error('ENOENT'); } }),
    /ENOENT/u,
  );
});

// 2026-09-18：日报链从「各店铺日报  副本」（X02Xb7fHba…）切到当时的正主「各店铺日报 」（PTfHbPt9Ea…）。
// 2026-09-30 晚：**用户又指定换成一张名字里带「副本」的 base**（RjKcb3isDaVn1GsoVJfc7Ykknyg）——
// 这一次「副本」两个字不是判错：它才是全的那一张（底单 2184 vs 1934 行、店铺底单 13 vs 12 行，
// 逐张表的行数与取证见 feishu-targets.mjs 的 dailyReport 注释）。
//
// 为什么这两条要单独钉：这几张 base 有 7 张同名表、其中 6 张逐表行数与字段签名完全相同，
// 肉眼分辨不出；配置指错时**不会有任何东西报错**——链照跑、数据照写，只是写进了一个
// 运营不看的 base 里。这正是「默认值即目标」（坑 35）的形状，所以默认值必须被断言钉住，
// 而不是靠人记得。名字与 id 一起断言，是因为只改一个的话两边会互相矛盾。
test('日报目标指向用户 2026-09-30 指定的 base「各店铺日报 副本」', () => {
  const target = dailyReportTargets('kcne');
  assert.equal(target.baseToken, 'RjKcb3isDaVn1GsoVJfc7Ykknyg');
  assert.equal(target.sourceTable, 'tblIuAX4nPc1zDOO');
  assert.equal(target.sourceView, 'vewwg0rhjo');
  assert.equal(target.inquiryTable, 'tblqF2YD2VfmKP4C');
  // 名字按「去空格」比较：接口读回的名字带尾随空格/中间空格，
  // 这种看不见的字符不能决定写的是哪一张 base（脚本里的比较用的是同一条规则）。
  const stripSpaces = value => String(value ?? '').replaceAll(' ', '');
  assert.equal(stripSpaces(target.sourceBaseName), '各店铺日报副本');
  // 上一任目标（2026-09-18…09-30 用的那张）留在测试里当反例：它的底单在 09-18…09-28
  // 只剩每天 5 家，配回去等于把 12 家的历史写回一张缺数据的表。
  assert.notEqual(target.baseToken, 'PTfHbPt9EaIzddsfL8Jcj238nrb');
  assert.notEqual(target.sourceTable, 'tblkY3W8tnPWPcnh');
  assert.notEqual(target.inquiryTable, 'tblUnwn05vl8Wik9');
  // 更早那一任副本（2026-09-18 之前指向的）：同样是反例，别「看着眼熟」配回来。
  assert.notEqual(target.baseToken, 'X02Xb7fHba7mU9sr8uIcRlExn6b');
  assert.notEqual(target.sourceTable, 'tbl84ZGwLQKyLxV3');
  assert.notEqual(target.inquiryTable, 'tblm9Hx7R9A1YoLC');
  // 五个键一个都不能少：少一个就意味着有人把名字或某个 id 从配置层挪走了。
  // 刻意不写成与 PROFILES.kcne.dailyReport 的 deepEqual —— 那份是**内置值**，
  // 而客户机上 config/customer.json 会让 dailyReportTargets 返回覆盖后的对象，
  // 那种写法会在客户机上红，属于「测试依赖了不该依赖的环境状态」。
  assert.deepEqual(Object.keys(target).sort(),
    ['baseToken', 'inquiryTable', 'sourceBaseName', 'sourceTable', 'sourceView']);
});

test('推广日报目标指向销售一部已确认 Base 与两张表', () => {
  const target = promotionDailyTargets('kcne');
  assert.equal(target.baseToken, 'Cqavb19NlaMUIIswp5IcMHWCnKb');
  assert.equal(target.baseName, '10月推广数据-销售1部');
  assert.deepEqual(target.tables, {
    keyword: 'tblbSGMO2apOKuAZ',
    audience: 'tblyjD5058Mjbmcv',
  });
  assert.deepEqual(target.sourceContracts, { keywordColumns: 75, audienceColumns: 71 });
});

test('商品数据三张目标表属于用户授权的商品数据 base', () => {
  const target = productDataTargets('kcne');
  assert.deepEqual(target, {
    baseToken: 'DQ2DbRinJaDx8Ss4gVFczsTXn3d',
    productTable: 'tblzyf0oLvfbvN1l',
    inquiryTable: 'tbl1hHlRX0LYMvYY',
    promotionTable: 'tblaCPQMLWAq21Gw',
  });
});

// ---------------------------------------------------------------------------
// 商品数据的「月份 × 部门」注册表（2026-09-30 加）
// ---------------------------------------------------------------------------
// 为什么这些断言不能省：
//   · 部门分错 ⇒ 数据写进另一个部门的 base，而两边表结构**逐字段相同**（已只读取证），
//     所以「跑成功、行数也对」—— 从收据上看不出任何异常，只有运营发现自己的表是空的；
//   · 月份解析错 ⇒ 月底那张新 base 上线那天，10 月 1 日的数据写进 9 月那张；
//   · 缺一本组合没登记 ⇒ 半个部门整天写不进去，另一半照常成功（最难看出来的一种红）。

test('部门划分与端口登记表**同键同序**，且每个部门都有可读名', async () => {
  const { shopBrowserKeys } = await import('./browser-ports.mjs');
  // 同序不是洁癖：`planBatches` 按 browser-ports 的顺序切批，
  // 两边顺序一致才让「一批尽量落在同一个部门的 base 上」这个说法有据可依。
  assert.deepEqual(Object.keys(SHOP_DEPARTMENTS), shopBrowserKeys(),
    'SHOP_DEPARTMENTS 的键与顺序必须与 runtime/browser-ports.mjs 的 SHOP_BROWSERS 逐项相同');
  const count = (department) => Object.values(SHOP_DEPARTMENTS).filter((value) => value === department).length;
  assert.deepEqual({ sales1: count('sales1'), sales2: count('sales2') }, { sales1: 8, sales2: 5 },
    '销售1部 8 家 / 销售2部 5 家（2026-09-30 用户给的《店铺账号信息表》口径）');
  for (const department of new Set(Object.values(SHOP_DEPARTMENTS))) {
    assert.ok(DEPARTMENT_LABELS[department], `部门 ${department} 没有可读名 —— 报错里不该印内部值`);
  }
  assert.throws(() => departmentOfShop('盖文1688'), /没有登记部门/u, '未登记的店铺不许猜一个部门');
  assert.throws(() => departmentOfShop(undefined), /没有登记部门/u);
});

test('月份只认 YYYY-MM / YYYY-MM-DD，别的形状当场抛错', () => {
  assert.equal(feishuMonthOf('2026-10-08'), '2026-10');
  assert.equal(feishuMonthOf('2026-10'), '2026-10');
  assert.equal(feishuMonthOf('2026-01-01'), '2026-01');
  for (const bad of ['', null, undefined, '2026/10/01', '20261008', '2026-1-1', '2026-13-01',
    'yesterday', 20261008, '2026-10-08T00:00:00Z']) {
    // 两类拒绝各说各话：形状不对 ⇒ 「只认 YYYY-MM」；形状对但月份越界 ⇒ 「月份超出 1-12」。
    assert.throws(() => feishuMonthOf(bad), /YYYY-MM|月份超出/u, `${JSON.stringify(bad)} 必须被拒`);
  }
  assert.equal(productDataBaseKey('盖文淘宝', '2026-10-01'), '2026-10:sales1');
  assert.equal(productDataBaseKey('保拉淘宝', '2026-10-31'), '2026-10:sales2');
});

test('按（数据日期 × 部门）解析目标：两个部门两张 base，且缺登记一律 fail-closed', () => {
  const s1 = productDataTargetsForShop('盖文淘宝', '2026-10-08', 'kcne');
  assert.equal(s1.baseToken, 'FhCUbn7vVaEc26sRjMAccQJAn5e');
  assert.equal(s1.baseName, '10月商品监控表-销售1部');
  const s2 = productDataTargetsForShop('保拉淘宝', '2026-10-08', 'kcne');
  assert.equal(s2.baseToken, 'ZYwWbYP9fa5d3rsXX8IcKrkYnod');
  // 2 部这张接口读回的名字带「副本」两个字，照抄 —— 它与 1 部那张是两个不同的 base
  // （2026-09-30 用户给的《店铺账号信息表测试.xlsx》里给的链接就是这两个 token）。
  assert.equal(s2.baseName, '10月商品监控表-销售2部 副本');
  // 两家店同一天必须落到两张不同的 base —— 这是「绝不串数据」在这条链上的判据化。
  assert.notEqual(s1.baseToken, s2.baseToken);
  assert.notEqual(s1.productTable, s2.productTable);
  assert.notEqual(s1.inquiryTable, s2.inquiryTable);

  // 月份取的是**数据日期**：09-30 那天的数据进 9 月那张，而不是「跑的那天」所在的 10 月。
  assert.equal(productDataTargetsForShop('盖文淘宝', '2026-09-30', 'kcne').baseToken,
    'DQ2DbRinJaDx8Ss4gVFczsTXn3d');

  // 9 月没有 2 部这张 —— 补跑历史日时它必须当场停，而不是悄悄写进 1 部那张。
  assert.throws(() => productDataTargetsForShop('保拉淘宝', '2026-09-30', 'kcne'), /销售2部/u);
  // 11 月还没登记 ⇒ 不许**回落到 10 月**（那会「跑成功但写进运营已经不看的那张表」）。
  assert.throws(() => productDataTargetsForShop('盖文淘宝', '2026-11-01', 'kcne'), /2026-11/u,
    '新月份没登记时必须停 —— 回落到上个月是最贵的静默失败');
  assert.throws(() => productDataTargetsForShop('盖文淘宝', '2026-11-01', 'kcne'),
    /PRODUCT_DATA_MONTH_BASES/u, '报错要说清该怎么补：把新 base 登记进 PRODUCT_DATA_MONTH_BASES');
  assert.throws(() => productDataTargetsForShop('不存在的店', '2026-10-08', 'kcne'), /没有登记部门/u);
});

test('注册表自洽体检：缺部门、坏键、重复 base 都要当场红', () => {
  const report = assertProductDataBaseCoverage();
  assert.equal(report.latest, '2026-10');
  assert.deepEqual(report.months, ['2026-09', '2026-10']);
  assert.deepEqual(report.departments, ['sales1', 'sales2']);

  const entry = PRODUCT_DATA_MONTH_BASES['2026-10:sales1'];
  // ① 最新月份缺一个部门（上月加了 2 部、这月忘了加）：那 5 家会整天写不进去，且必须点名是谁。
  assert.throws(() => assertProductDataBaseCoverage({ registry: { '2026-10:sales1': entry } }),
    /最新月份「2026-10」缺部门「销售2部」[\s\S]*保拉淘宝/u);
  // ② 键里写了一个没有店铺归属的部门（多半是拼错）。用一个**不同**的 baseToken，
  //    否则会同时触发「同一个 base 登记在两处」，把这条用例变成在验另一件事。
  assert.throws(() => assertProductDataBaseCoverage({
    registry: { ...PRODUCT_DATA_MONTH_BASES, '2026-10:sales3': { ...entry, baseToken: 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1' } },
  }), /没有任何店铺归属/u);
  // ③ 同一个 base 登记在两个键下 —— 两份里必有一处是抄错的。
  assert.throws(() => assertProductDataBaseCoverage({
    registry: { '2026-10:sales1': entry, '2026-10:sales2': entry },
  }), /同时登记在/u);
  // ④ 键形状不对（月份写成英文）。
  assert.throws(() => assertProductDataBaseCoverage({ registry: { 'October:sales1': entry } }),
    /不是「YYYY-MM:部门」形状/u);
  // ⑤ 表 id / token 形状不对：抄漏一位最常见的表现是长度不够。
  assert.throws(() => assertProductDataBaseCoverage({
    registry: { '2026-10:sales1': { ...entry, productTable: 'tblXXX' } },
  }), /productTable/u);
  assert.throws(() => assertProductDataBaseCoverage({
    registry: { '2026-10:sales1': { ...entry, baseName: '' } },
  }), /缺 baseName/u);
});

test('profile 上那份单对象与注册表的 2026-09:sales1 同源（不许各自漂移）', () => {
  const legacy = productDataTargets('kcne');
  const registered = PRODUCT_DATA_MONTH_BASES['2026-09:sales1'];
  for (const field of ['baseToken', 'productTable', 'inquiryTable', 'promotionTable']) {
    assert.equal(legacy[field], registered[field],
      `${field} 在两处不一致 —— 一份是 PROFILES.kcne.productData，一份是注册表的 2026-09:sales1`);
  }
});

// 这条守卫的形态与 `FOREIGN_PROXY_ALLOWED_FILES` 同一族：**把「故意没改」写下来**，
// 而不是让「忘了改」与「决定不改」在代码里长得一模一样。
test('底单/询单导入按（店铺, 日期）解析 base；推广是记录在案的例外', () => {
  const read = (relative) => readFileSync(path.join(import.meta.dirname, '..', relative), 'utf8');
  for (const relative of [
    'skills/sycm-product-data/scripts/import-product-data.mjs',
    'skills/sycm-inquiry-data/scripts/import-inquiry-data.mjs',
  ]) {
    const source = read(relative);
    assert.ok(source.includes('productDataTargetsForShop'),
      `${relative} 没有按（店铺, 数据日期）解析 base —— 换月起它会写进上个月的 base`);
    assert.doesNotMatch(source, /\bproductDataTargets\b/u,
      `${relative} 还在用不认月份的旧入口（它永远指向 9 月那张）`);
  }
  // 推广链：用户 2026-09-30 原话「推广数据这个流程我还没开发，你先放着不管」⇒ **故意**没改。
  // 等推广链改造完（10 月推广已换成另一套 base 与两张不同形状的表），它必须一起改，届时这里会红。
  const promotion = read('skills/sycm-promotion-data/scripts/import-promotion-data.mjs');
  assert.match(promotion, /\bproductDataTargets\b/u,
    '推广导入已经不用旧入口了 ⇒ 请把它从这条「故意例外」里移出去');
});

// 配套的静态守卫：脚本自己**不许**再写死任何一张 base 的名字。
// 写死过的代价就在眼前 —— run-daily-report.mjs 里那句 `!== '各店铺日报副本'` 是「当时那条结论的
// 快照」，它不随配置一起改，于是切 base 时它是第一个炸的地方，而且是在浏览器里炸。
// 这条守卫横着读另一个 skill 的文件，是因为它守的正是本文件导出值的唯一性：
// 「活跃脚本不应各自硬编码目标」这句写在 feishu-targets.mjs 的文件头，这里就是它的执行者。
test('日报脚本不许写死 base 名，期望值只能从配置层取', () => {
  const scriptPath = path.join(import.meta.dirname,
    '..', 'skills', 'sycm-alimama-daily-report', 'scripts', 'run-daily-report.mjs');
  const source = readFileSync(scriptPath, 'utf8');
  // 先去注释再判：脚本里**正好在讲**这个坑的注释中会提到那两个名字，
  // 连着注释一起匹配就会把说明本身当成违规（一次假红）。
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
  // 去注释必须自证「剥掉的确实只是注释」，否则一个把整份文件剥空的实现会让这条守卫永远为绿。
  assert.ok(code.includes('function inspectTarget'), '去注释后代码主体不见了 —— 剥离实现有问题');
  assert.match(code, /expectedBaseName: TARGET\.sourceBaseName/u, '期望 base 名必须来自配置层');
  assert.doesNotMatch(code, /各店铺日报/u, '脚本里不许出现任何 base 名字面量（含正主名）');
  assert.doesNotMatch(code, /X02Xb7fHba7mU9sr8uIcRlExn6b|PTfHbPt9EaIzddsfL8Jcj238nrb|RjKcb3isDaVn1GsoVJfc7Ykknyg/u,
    '脚本里不许出现 base token 字面量（含当前在用的那个）');
});
