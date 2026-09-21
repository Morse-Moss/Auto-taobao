// 竞品周表规则列写回判据的守卫（2026-09-21 建，随 core 一起抽出来的）。
//
// 守的是什么：`fill-weekly-attribute-labels.mjs` 此前**一个测试都没有**（只有
// runtime/arch-boundary.test.mjs 把它列进了跨目录依赖白名单）。而它恰恰是尺寸链上
// 唯一没被守住的一环 —— 09-16 那次把 A/B 行的尺寸写成『无注明』之后，「只填空不覆盖」
// 让重跑静默全绿（1417 行、写入 0 行），谁都没发现。
//
// 所以这里逐条钉住：默认必须与从前逐字相同（有值就跳过），重算只对 A/B 的
// 尺寸/适用空间生效，且绝不放任新值把有值擦成『无注明』。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECOMPUTABLE_COLUMNS,
  decideWrite,
  extractProductId,
  isAbClass,
} from './fill-weekly-attribute-labels-core.mjs';

test('extractProductId：从淘系链接取出商品 id', () => {
  assert.equal(
    extractProductId('https://item.taobao.com/item.htm?spm=a21n57.1.0.0.abc&id=921092099640&ns=1'),
    '921092099640',
  );
  assert.equal(extractProductId('https://item.taobao.com/item.htm?id=1059970355633'), '1059970355633');
  assert.equal(extractProductId('https://detail.tmall.com/item.htm?spm=x&id=822695648811'), '822695648811');
  assert.equal(extractProductId(''), '');
  assert.equal(extractProductId(null), '');
  assert.equal(extractProductId(undefined), '');
  assert.equal(extractProductId('https://item.taobao.com/item.htm?spm=abc'), '');
  // 只认 ?id= 与 &id= 两种形态：路径里出现的 /id= 不算，免得把跳转参数当成商品 id
  assert.equal(extractProductId('https://example.com/id=123'), '');
});

test('isAbClass：只有 A- / B- 前缀算「该有尺寸」', () => {
  // 判据只看前缀，下面 C/D 的名称仅是示意
  assert.equal(isAbClass('A-爆款竞品'), true);
  assert.equal(isAbClass('B-高价值竞品'), true);
  assert.equal(isAbClass('C-低价竞品'), false);
  assert.equal(isAbClass('D-不相关'), false);
  assert.equal(isAbClass('无分类'), false);
  assert.equal(isAbClass('  B-高价值竞品  '), true);
  assert.equal(isAbClass(''), false);
  assert.equal(isAbClass(undefined), false);
});

test('RECOMPUTABLE_COLUMNS：只有 尺寸 与 适用空间 允许被重算', () => {
  assert.deepEqual([...RECOMPUTABLE_COLUMNS], ['尺寸', '适用空间']);
});

test('decideWrite：默认（未开重算）在任何有值格上都跳过 —— 只填空不覆盖，与从前逐字相同', () => {
  assert.equal(
    decideWrite({ name: '尺寸', existing: '无注明', next: '1.4m-1.7m', isAb: true, recomputeAb: false, joined: true }),
    'skip-existing',
  );
  // 即使开了重算，非可重算列也照样跳过
  assert.equal(
    decideWrite({ name: '材质分类', existing: '人造石', next: '亚克力', isAb: true, recomputeAb: true, joined: true }),
    'skip-existing',
  );
});

test('decideWrite：A/B 行的 尺寸/适用空间 在开重算且 SKU 真接上时允许覆盖', () => {
  assert.equal(
    decideWrite({ name: '尺寸', existing: '无注明', next: '1.4m,1.5m,1.4m-1.7m', isAb: true, recomputeAb: true, joined: true }),
    'recompute',
  );
  assert.equal(
    decideWrite({ name: '适用空间', existing: '无注明', next: '常规卫生间', isAb: true, recomputeAb: true, joined: true }),
    'recompute',
  );
});

test('decideWrite：非 A/B 行、未接上 SKU 的行，一律不得覆盖', () => {
  assert.equal(
    decideWrite({ name: '尺寸', existing: '无注明', next: '1.4m-1.7m', isAb: false, recomputeAb: true, joined: true }),
    'skip-existing',
  );
  assert.equal(
    decideWrite({ name: '尺寸', existing: '无注明', next: '1.4m-1.7m', isAb: true, recomputeAb: true, joined: false }),
    'skip-existing',
  );
});

test('decideWrite：绝不把有值擦成无值，也绝不写空', () => {
  assert.equal(
    decideWrite({ name: '尺寸', existing: '1.2m-1.7m', next: '无注明', isAb: true, recomputeAb: true, joined: true }),
    'skip-degraded',
  );
  assert.equal(
    decideWrite({ name: '适用空间', existing: '小户型', next: '不适用', isAb: true, recomputeAb: true, joined: true }),
    'skip-degraded',
  );
  assert.equal(
    decideWrite({ name: '尺寸', existing: '', next: '', isAb: true, recomputeAb: true, joined: false }),
    'skip-empty',
  );
});

test('decideWrite：新值与原值逐字相同时不写（省一次无意义更新）', () => {
  assert.equal(
    decideWrite({ name: '尺寸', existing: '1.4m-1.7m', next: '1.4m-1.7m', isAb: true, recomputeAb: true, joined: true }),
    'skip-same',
  );
});

test('decideWrite：空格一律填空，不受 A/B 与重算开关影响', () => {
  assert.equal(
    decideWrite({ name: '尺寸', existing: '', next: '1.4m-1.7m', isAb: false, recomputeAb: false, joined: true }),
    'fill',
  );
  assert.equal(
    decideWrite({ name: '搜索关键词', existing: '', next: '浴缸', isAb: false, recomputeAb: false, joined: false }),
    'fill',
  );
});
