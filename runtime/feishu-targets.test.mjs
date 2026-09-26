import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_PROFILE,
  PROFILES,
  PROFILE_ENV_VAR,
  STABLE_TABLE_KEYS,
  activeProfileName,
  baseUrl,
  competitorBaseToken,
  dailyReportTargets,
  productDataTargets,
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

// 2026-09-18：日报链从「各店铺日报  副本」（X02Xb7fHba…）切到用户指定的正主「各店铺日报 」（PTfHbPt9Ea…）。
//
// 为什么这条要单独钉：两张 base 有 7 张同名表，其中 6 张逐表行数与字段签名**完全相同**，
// 唯一肉眼可见的差别是底单行数（副本 8 行 / 正主 1873 行）和名字里多出来的「副本」两个字。
// 也就是说，配置被改回副本时**不会有任何东西报错**——链照跑、数据照写，只是写进了一个
// 运营不看的 base 里。这正是「默认值即目标」（坑 35）的形状，所以默认值必须被断言钉住，
// 而不是靠人记得。名字与 id 一起断言，是因为只改一个的话两边会互相矛盾。
test('日报目标指向正主 base「各店铺日报」，不再是同名副本', () => {
  const target = dailyReportTargets('kcne');
  assert.equal(target.baseToken, 'PTfHbPt9EaIzddsfL8Jcj238nrb');
  assert.equal(target.sourceTable, 'tblkY3W8tnPWPcnh');
  assert.equal(target.sourceView, 'vewwg0rhjo');
  assert.equal(target.inquiryTable, 'tblUnwn05vl8Wik9');
  // 名字按「去空格」比较：接口读回的正主名带一个尾随空格，副本名带中间空格，
  // 这种看不见的字符不能决定写的是哪一张 base（脚本里的比较用的是同一条规则）。
  const stripSpaces = value => String(value ?? '').replaceAll(' ', '');
  assert.equal(stripSpaces(target.sourceBaseName), '各店铺日报');
  assert.notEqual(stripSpaces(target.sourceBaseName), '各店铺日报副本');
  // 切换前的副本 id：留在测试里当反例，免得下次有人「看着眼熟」把它配回来。
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

test('商品数据三张目标表属于用户授权的商品数据 base', () => {
  const target = productDataTargets('kcne');
  assert.deepEqual(target, {
    baseToken: 'DQ2DbRinJaDx8Ss4gVFczsTXn3d',
    productTable: 'tblzyf0oLvfbvN1l',
    inquiryTable: 'tbl1hHlRX0LYMvYY',
    promotionTable: 'tblaCPQMLWAq21Gw',
  });
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
  assert.doesNotMatch(code, /X02Xb7fHba7mU9sr8uIcRlExn6b|PTfHbPt9EaIzddsfL8Jcj238nrb/u,
    '脚本里不许出现 base token 字面量');
});
