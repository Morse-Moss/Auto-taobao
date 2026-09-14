import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PROFILE,
  PROFILES,
  PROFILE_ENV_VAR,
  STABLE_TABLE_KEYS,
  activeProfileName,
  baseUrl,
  competitorBaseToken,
  envFilePath,
  getProfile,
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

// 默认值是「当前生产租户」。新租户写入验证通过后把 DEFAULT_PROFILE 改成 kcne，
// 这一条会跟着失败——提醒同时更新 docs/ops/TENANT-MIGRATION-MAP.md 与项目记忆。
test('默认 profile 仍是旧租户（切换前）', () => {
  assert.equal(DEFAULT_PROFILE, 'legacy');
  assert.equal(getProfile(undefined).envFile, 'E:/小红书/.env.local');
});

test('tableId 命中逻辑名，未知逻辑名抛错', () => {
  assert.equal(tableId('history', 'legacy'), 'tblH0bmmOuogxDHi');
  assert.equal(tableId('history', 'kcne'), 'tblktwxWKt8sjpXL');
  assert.notEqual(tableId('competitorMain', 'legacy'), tableId('competitorMain', 'kcne'));
  assert.throws(() => tableId('historyV2'), /Unknown Feishu table logical name/u);
  assert.throws(() => tableId('history', 'nope'), /Unknown Feishu profile/u);
});

test('凭据文件路径与 baseUrl 按 profile 分开', () => {
  assert.notEqual(envFilePath('legacy'), envFilePath('kcne'));
  const targets = profileTargets('kcne');
  assert.equal(targets.envFile, 'E:/小红书/.env.feishu-kcne.local');
  assert.match(targets.baseUrl, /^https:\/\/kcne618basvj\.feishu\.cn\/base\/OUMqbkYw/u);
  assert.equal(targets.writeVerified, false);
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
