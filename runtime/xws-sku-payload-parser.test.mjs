import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { parseXwsSkuPayload } from './xws-sku-payload-parser.mjs';

const source = {
  productId: '1053695212757',
  productUrl: 'https://item.taobao.com/item.htm?id=1053695212757',
  productTitle: 'Synthetic product',
  competitorClass: 'A-高销量高GMV竞品',
  mainRecordId: 'recSynthetic',
};

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

function topologyFor(payload) {
  const lines = payload.split('\n');
  return {
    version: 'xws-tmall-sku-topology-v1',
    payloadSha256: sha256(payload),
    dimensionPropertyIndex: 0,
    specificationPropertyIndex: 1,
    specificationSegmentCount: 3,
    properties: [
      {
        values: [0, 1].map((payloadLineIndex) => ({
          payloadLineIndex,
          payloadLineSha256: sha256(lines[payloadLineIndex]),
          empty: false,
        })),
      },
      {
        values: [2, 3, 4].map((payloadLineIndex, valueIndex) => ({
          payloadLineIndex,
          payloadLineSha256: sha256(lines[payloadLineIndex]),
          empty: valueIndex === 2,
        })),
      },
    ],
    validCombinations: [
      { skuId: 'sku-01', propertyValueIndexes: [0, 0] },
      { skuId: 'sku-02', propertyValueIndexes: [0, 1] },
      { skuId: 'sku-03', propertyValueIndexes: [1, 0] },
      { skuId: 'sku-04', propertyValueIndexes: [1, 1] },
    ],
  };
}

test('expands verified valid combinations instead of pairing payload lines by position', () => {
  const payload = [
    '1.2米',
    '1.3米',
    '独立浴缸-左排-恒温',
    '独立浴缸-右排-恒温',
    '不可售规格',
  ].join('\n');

  const plan = parseXwsSkuPayload(payload, source, topologyFor(payload));

  assert.equal(plan.sourceSchema.version, 'xws-tmall-sku-topology-v1');
  assert.equal(plan.sourceSchema.propertyCount, 2);
  assert.equal(plan.rows.length, 4);
  assert.deepEqual(plan.rows.map((row) => row.fields.SKU尺寸), ['1.2米', '1.2米', '1.3米', '1.3米']);
  assert.deepEqual(plan.rows.map((row) => row.fields.SKU规格), [
    '独立浴缸-左排-恒温',
    '独立浴缸-右排-恒温',
    '独立浴缸-左排-恒温',
    '独立浴缸-右排-恒温',
  ]);
  assert.deepEqual(plan.rows.map((row) => row.fields.适用空间), [
    '小户型', '小户型', '常规卫生间', '常规卫生间',
  ]);
  assert.deepEqual(plan.rows.map((row) => row.fields.采集状态), ['已采集', '已采集', '已采集', '已采集']);
  assert.deepEqual(plan.rows.map((row) => row.fields.SKU唯一键), [
    '1053695212757|sku-01',
    '1053695212757|sku-02',
    '1053695212757|sku-03',
    '1053695212757|sku-04',
  ]);
  assert.equal(plan.rows[0].fields.SKU名称, '独立浴缸');
  assert.equal(plan.rows[0].fields.尺寸汇总, '1.2m-1.3m');
  assert.equal(plan.rows[0].fields.所属竞品, source.mainRecordId);
});

test('rejects a topology that includes a page-marked empty option in a valid SKU', () => {
  const payload = [
    '1.2米',
    '1.3米',
    '独立浴缸-左排-恒温',
    '独立浴缸-右排-恒温',
    '不可售规格',
  ].join('\n');
  const topology = topologyFor(payload);
  topology.validCombinations.push({ skuId: 'sku-empty', propertyValueIndexes: [0, 2] });

  assert.throws(
    () => parseXwsSkuPayload(payload, source, topology),
    /page-marked empty option/u,
  );
});

test('rejects a payload that no longer matches the captured topology hash', () => {
  const payload = [
    '1.2米',
    '1.3米',
    '独立浴缸-左排-恒温',
    '独立浴缸-右排-恒温',
    '不可售规格',
  ].join('\n');

  assert.throws(
    () => parseXwsSkuPayload(payload.replace('1.2米', '1.1米'), source, topologyFor(payload)),
    /payload hash mismatch/u,
  );
});

test('parses plus-separated specification options without losing the SKU name', () => {
  const payload = [
    '1.2米',
    '1.3米',
    '椭圆款PMMA人造石空缸+安装服务',
    '椭圆款PMMA人造石空缸+瀑布龙头+安装服务',
    '不可售规格',
  ].join('\n');
  const topology = topologyFor(payload);
  topology.specificationSegmentCount = 3;
  topology.specificationSegmentCounts = [2, 3];
  topology.specificationSeparator = '+';
  topology.validCombinations = [{ skuId: 'sku-plus', propertyValueIndexes: [0, 0] }];

  const plan = parseXwsSkuPayload(payload, source, topology);

  assert.equal(plan.rows[0].fields.SKU名称, '椭圆款PMMA人造石空缸');
  assert.equal(plan.rows[0].fields.SKU规格, '椭圆款PMMA人造石空缸+安装服务');
});

test('preserves the SKU name for each combination when a product has multiple names', () => {
  const payload = [
    '1.2米',
    '1.3米',
    '椭圆款-安装服务-现货',
    '嵌缸款-安装服务-现货',
    '不可售规格',
  ].join('\n');
  const topology = topologyFor(payload);
  topology.validCombinations = [
    { skuId: 'sku-round', propertyValueIndexes: [0, 0] },
    { skuId: 'sku-inset', propertyValueIndexes: [0, 1] },
  ];

  const plan = parseXwsSkuPayload(payload, source, topology);

  assert.deepEqual(plan.rows.map((row) => row.fields.SKU名称), ['椭圆款', '嵌缸款']);
});
