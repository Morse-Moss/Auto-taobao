// 阶段 3（Skill Manifest/Registry/Loader）配套单测：semver 子集
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, isValidVersion, compareVersions, satisfies, maxSatisfying, isValidRange } from './semver.mjs';

test('parseVersion 解析合法版本并拒绝非法', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: null, build: null, raw: '1.2.3' });
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion('v1.2.3'), null);
  assert.equal(parseVersion('1.2.3-rc.1').prerelease, 'rc.1');
  assert.equal(isValidVersion('0.0.1'), true);
  assert.equal(isValidVersion('1.2.3.4'), false);
});

test('compareVersions 顺序正确，含 prerelease', () => {
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-beta.1'), -1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
  assert.throws(() => compareVersions('x', '1.0.0'));
});

test('satisfies 支持 ^ ~ 精确 >= 区间并用与 ||', () => {
  assert.equal(satisfies('1.4.2', '^1.2.0'), true);
  assert.equal(satisfies('2.0.0', '^1.2.0'), false);
  assert.equal(satisfies('0.2.5', '^0.2.1'), true);
  assert.equal(satisfies('0.3.0', '^0.2.1'), false);
  assert.equal(satisfies('1.2.9', '~1.2.1'), true);
  assert.equal(satisfies('1.3.0', '~1.2.1'), false);
  assert.equal(satisfies('1.2.3', '1.2.3'), true);
  assert.equal(satisfies('1.2.4', '1.2.3'), false);
  assert.equal(satisfies('1.2.9', '1.2'), true);
  assert.equal(satisfies('1.3.0', '1.2'), false);
  assert.equal(satisfies('1.5.0', '1'), true);
  assert.equal(satisfies('2.0.0', '1'), false);
  assert.equal(satisfies('1.2.3', '>=1.2.0 <2.0.0'), true);
  assert.equal(satisfies('2.0.0', '>=1.2.0 <2.0.0'), false);
  assert.equal(satisfies('3.1.0', '^1.0.0 || ^3.0.0'), true);
  assert.equal(satisfies('1.2.3', '*'), true);
});

test('satisfies 对 prerelease 默认不放行', () => {
  assert.equal(satisfies('1.3.0-rc.1', '^1.2.0'), false);
  assert.equal(satisfies('1.3.0-rc.1', '>=1.2.0-rc.1 <2.0.0'), true);
});

test('非法 range 抛错（fail-closed）', () => {
  assert.throws(() => satisfies('1.0.0', 'not-a-range'));
  assert.equal(isValidRange('^1.0.0'), true);
  assert.equal(isValidRange('not-a-range'), false);
});

test('maxSatisfying 选最高匹配版本', () => {
  assert.equal(maxSatisfying(['1.0.0', '1.5.0', '2.0.0'], '^1.0.0'), '1.5.0');
  assert.equal(maxSatisfying(['1.0.0', '1.2.0'], '^3.0.0'), null);
});
