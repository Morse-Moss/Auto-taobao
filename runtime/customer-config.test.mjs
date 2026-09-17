// 客户配置层的测试。重点不是「覆盖能生效」，而是**默认行为一个字节都没变** ——
// runtime/feishu-targets.mjs 被 31 个文件反向 import，默认值漂移会让生产静默变样。
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CONFIG_PATH_ENV,
  DEFAULT_CONFIG_RELATIVE_PATH,
  STORE_ID_PATTERN,
  configFilePath,
  loadCustomerConfig,
  overlayProfile,
  validateFeishuOverrides,
  validateStores,
} from './customer-config.mjs';

import {
  PROFILES,
  competitorBaseToken,
  dailyReportTargets,
  envFilePath,
  getProfile,
  resetCustomerConfigCache,
  tableId,
} from './feishu-targets.mjs';

function enoent() {
  const error = new Error('ENOENT');
  error.code = 'ENOENT';
  throw error;
}

// 一份「客户配置」的最小形状：只改换机器/换租户非改不可的那几项。
const CUSTOMER = Object.freeze({
  feishu: Object.freeze({
    kcne: Object.freeze({
      envFile: 'C:/xws-config/.env.feishu.local',
      competitorBase: 'CustomeRCompeTitorBase0000',
      tables: Object.freeze({ history: 'tblCUSTOMERhistory000' }),
    }),
  }),
});

test('没有配置文件是「不存在」，不是错误', () => {
  const result = loadCustomerConfig({ env: {}, read: enoent });
  assert.equal(result.present, false);
  assert.equal(result.config, null);
  assert.match(result.file, /config[\\/]customer\.json$/u);
});

test('配置路径：默认在仓库根 config/ 下，相对路径按仓库根解析', () => {
  const def = configFilePath({}, 'D:/repo');
  assert.equal(def, path.resolve('D:/repo', DEFAULT_CONFIG_RELATIVE_PATH));

  // 相对路径必须按仓库根解析（而不是 cwd）：脚本既有从根跑的，也有从 skills/<name>/ 跑的
  assert.equal(
    configFilePath({ [CONFIG_PATH_ENV]: 'cfg/x.json' }, 'D:/repo'),
    path.resolve('D:/repo/cfg/x.json'),
  );
  // 绝对路径原样使用
  assert.equal(
    configFilePath({ [CONFIG_PATH_ENV]: 'C:/elsewhere/x.json' }, 'D:/repo'),
    path.normalize('C:/elsewhere/x.json'),
  );
  // 空串不是「一个路径」，回落默认值（shell 里 `VAR=` 很常见）
  assert.equal(configFilePath({ [CONFIG_PATH_ENV]: '   ' }, 'D:/repo'), def);
});

test('配置内容坏了就报错，绝不退回内置值', () => {
  const load = (text) => () => loadCustomerConfig({ env: {}, read: () => text });
  assert.throws(load('{ not json'), /不是合法 JSON/u);
  assert.throws(load('[1,2]'), /顶层必须是 JSON 对象/u);
  assert.throws(load('"str"'), /顶层必须是 JSON 对象/u);
  assert.throws(load('{"feishu":{},"wrong":{}}'), /未知的顶层段 "wrong"/u);
});

test('未知 profile 名报错，已知的放过', () => {
  const known = Object.keys(PROFILES);
  assert.throws(
    () => validateFeishuOverrides({ feishu: { nope: {} } }, { knownProfiles: known }),
    /未知 profile "nope"/u,
  );
  assert.doesNotThrow(() => validateFeishuOverrides({ feishu: { kcne: {} } }, { knownProfiles: known }));
  assert.doesNotThrow(() => validateFeishuOverrides({}, { knownProfiles: known }));
});

// 「我明明配了，怎么没生效」这种现场问题的防线：拼错的字段名直接报错，
// 而不是安静地忽略掉（允许的字段从内置 profile 推导，没有第二份名单要同步）。
test('未知字段与类型不符都报错', () => {
  const builtin = PROFILES.kcne;
  assert.throws(() => overlayProfile(builtin, { env_file: 'x' }), /未知字段 "env_file"/u);
  assert.throws(() => overlayProfile(builtin, { envFile: 123 }), /envFile 必须是非空字符串/u);
  assert.throws(() => overlayProfile(builtin, { writeVerified: 'true' }), /writeVerified 必须是 true\/false/u);
  assert.throws(() => overlayProfile(builtin, { tables: { notATable: 'tblX' } }), /未知字段 "notATable"/u);
  assert.throws(() => overlayProfile(builtin, []), /必须是一个对象/u);
  assert.throws(() => overlayProfile(builtin, { tables: 'nope' }), /必须是一个对象/u);
});

test('覆盖不修改内置登记表，且结果仍冻结', () => {
  const builtin = PROFILES.kcne;
  const overlaid = overlayProfile(builtin, CUSTOMER.feishu.kcne, { where: 'feishu.kcne' });

  assert.equal(builtin.envFile, 'E:/小红书/.env.feishu-kcne.local');
  assert.equal(overlaid.envFile, 'C:/xws-config/.env.feishu.local');

  assert.equal(Object.isFrozen(overlaid), true);
  assert.equal(Object.isFrozen(overlaid.tables), true);
  assert.throws(() => { overlaid.envFile = 'tampered'; }, TypeError);
  assert.throws(() => { overlaid.tables.history = 'tampered'; }, TypeError);
});

// 这是本文件最重要的一条：客户配置层存在的全部意义，
// 是「换机器不用改代码」，**不是**「顺手把默认值换成更合理的值」。
test('无客户配置时 getProfile 逐字段等于内置登记表（且是同一份引用）', () => {
  for (const name of Object.keys(PROFILES)) {
    const got = getProfile(name, { config: null });
    assert.deepEqual(got, PROFILES[name], name);
    assert.equal(got, PROFILES[name], name);
  }
  assert.equal(getProfile(undefined, { config: null }), PROFILES.kcne);
});

// 端到端：真的设了 SYCM_CUSTOMER_CONFIG，所有访问器都要跟着走。
// 走真实文件而不是注入，是为了同时证明「环境变量确实被读到了」。
test('设了 SYCM_CUSTOMER_CONFIG 后所有访问器都跟着客户配置走', () => {
  const file = path.join(os.tmpdir(), `xws-customer-config-${process.pid}.json`);
  writeFileSync(file, JSON.stringify(CUSTOMER), 'utf8');

  const previous = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = file;
  resetCustomerConfigCache();
  try {
    assert.equal(envFilePath('kcne'), 'C:/xws-config/.env.feishu.local');
    assert.equal(competitorBaseToken('kcne'), 'CustomeRCompeTitorBase0000');
    assert.equal(tableId('history', 'kcne'), 'tblCUSTOMERhistory000');
    // 没被覆盖的字段保持内置值
    assert.equal(tableId('skuDetail', 'kcne'), PROFILES.kcne.tables.skuDetail);
    assert.equal(dailyReportTargets('kcne').sourceTable, PROFILES.kcne.dailyReport.sourceTable);
    // 另一个 profile 完全不受影响
    assert.equal(envFilePath('legacy'), PROFILES.legacy.envFile);
    assert.equal(competitorBaseToken('legacy'), PROFILES.legacy.competitorBase);
  } finally {
    if (previous === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previous;
    resetCustomerConfigCache();
    rmSync(file, { force: true });
  }
});

test('配置文件在、内容错 ⇒ 访问时立刻抛错（而不是等某条链跑到一半）', () => {
  const file = path.join(os.tmpdir(), `xws-customer-config-bad-${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ feishu: { typo: {} } }), 'utf8');

  const previous = process.env[CONFIG_PATH_ENV];
  process.env[CONFIG_PATH_ENV] = file;
  resetCustomerConfigCache();
  try {
    assert.throws(() => getProfile('kcne', { config: undefined }), /未知 profile "typo"/u);
  } finally {
    if (previous === undefined) delete process.env[CONFIG_PATH_ENV];
    else process.env[CONFIG_PATH_ENV] = previous;
    resetCustomerConfigCache();
    rmSync(file, { force: true });
  }
});

// ── stores 段：多店铺的跨平台店名映射（2026-09-17 加）─────────────────────────
//
// 这一段没有「能生效」可测（还没有读方），所以这里测的全部是**拒绝**：
// 每一类错误都对应一个「不报错就会静默写错数据」的场景。
// 尤其是重名——飞书店名就是查重键，两家同名会让数据撞进同一行。

const STORE = (overrides = {}) => ({
  id: 'bathtub-flagship',
  feishuName: '盖文旗舰店',
  sycmDisplay: '盖文旗舰店 主店',
  alimamaDisplay: '盖文旗舰店:阿彦',
  profileDir: 'D:/Retire/edge-profiles/bathtub-flagship',
  ...overrides,
});

test('stores 段：只写 id + feishuName 就够，可选字段可省', () => {
  assert.doesNotThrow(() => validateStores({ stores: [{ id: 'shop-a', feishuName: 'A 店' }] }));
  assert.doesNotThrow(() => validateStores({ stores: [STORE()] }));
  assert.doesNotThrow(() => validateStores({}), '整段不写＝还没配店铺，不是错误');
});

test('stores 段：形状不对就报错（不是数组 / 空数组 / 元素不是对象）', () => {
  assert.throws(() => validateStores({ stores: {} }), /stores 段必须是数组/u);
  assert.throws(() => validateStores({ stores: [] }), /空数组/u);
  assert.throws(() => validateStores({ stores: ['shop-a'] }), /stores\[0\] 必须是对象/u);
  assert.throws(() => validateStores({ stores: [null] }), /stores\[0\] 必须是对象/u);
});

test('stores 段：缺必填、字段拼错、可选项写空串，都报错', () => {
  assert.throws(() => validateStores({ stores: [{ id: 'shop-a' }] }), /缺 feishuName/u);
  assert.throws(() => validateStores({ stores: [{ feishuName: 'A 店' }] }), /缺 id/u);
  assert.throws(() => validateStores({ stores: [STORE({ feishuName: '   ' })] }), /缺 feishuName/u);
  assert.throws(() => validateStores({ stores: [STORE({ feishu_nam: 'A 店' })] }), /未知字段 "feishu_nam"/u);
  assert.throws(() => validateStores({ stores: [STORE({ sycmDisplay: '' })] }), /sycmDisplay 若写了就必须是非空字符串/u);
});

// storeId 会被拼进业务幂等键，而键的字符集是 [A-Za-z0-9._~{}/-]。
// 模板校验只看模板、不看渲染结果 ⇒ 中文或大写的 id 拦不住，所以这条必须落在声明处。
test('stores 段：id 只能用「小写字母/数字/短横线」，因为它是幂等键的一段', () => {
  assert.equal(STORE_ID_PATTERN.test('bathtub-flagship'), true);
  assert.equal(STORE_ID_PATTERN.test('shop2'), true);

  assert.throws(() => validateStores({ stores: [STORE({ id: '盖文旗舰店' })] }), /只能用小写字母\/数字\/短横线/u);
  assert.throws(() => validateStores({ stores: [STORE({ id: 'Bathtub_Flagship' })] }), /只能用小写字母\/数字\/短横线/u);
  assert.throws(() => validateStores({ stores: [STORE({ id: '-leading' })] }), /只能用小写字母\/数字\/短横线/u);
});

test('stores 段：重名必须报错 —— 飞书店名就是查重键，同名会让两家撞进同一行', () => {
  const duplicated = { stores: [STORE(), STORE({ id: 'shop-b' })] };
  assert.throws(() => validateStores(duplicated), /feishuName "盖文旗舰店" 与 stores\[0\] 重复/u);

  const sameId = { stores: [STORE(), STORE({ feishuName: '另一家店' })] };
  assert.throws(() => validateStores(sameId), /id "bathtub-flagship" 与 stores\[0\] 重复/u);
});

// 模板文件是交付物：客户是照着它改的。它自己要是一份非法配置，
// 客户第一步就撞墙（而「copy 之后报错」看起来像软件坏了，不像模板写错了）。
test('模板 config/customer.example.json 自己必须是合法配置', () => {
  const file = path.resolve(import.meta.dirname, '..', 'config', 'customer.example.json');
  const text = readFileSync(file, 'utf8');
  const result = loadCustomerConfig({ env: {}, read: () => text });
  assert.equal(result.present, true);
  assert.equal(Array.isArray(result.config.stores), true);
  assert.equal(result.config.stores.length > 0, true);
  for (const store of result.config.stores) {
    assert.match(store.id, STORE_ID_PATTERN);
  }
  assert.doesNotThrow(() => validateFeishuOverrides(result.config, { knownProfiles: Object.keys(PROFILES) }));
});
