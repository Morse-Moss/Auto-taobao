import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildXwsSkuTopology } from './xws-sku-topology-core.mjs';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

function pageSnapshot(lines) {
  return {
    productId: '1053695212757',
    properties: [
      {
        propertyIndex: 0,
        propertyNameSha256: sha256('尺寸'),
        values: [0, 1].map((lineIndex, valueIndex) => ({
          valueIndex,
          nameSha256: sha256(lines[lineIndex]),
          empty: false,
        })),
      },
      {
        propertyIndex: 1,
        propertyNameSha256: sha256('规格'),
        values: [2, 3, 4].map((lineIndex, valueIndex) => ({
          valueIndex,
          nameSha256: sha256(lines[lineIndex]),
          empty: valueIndex === 2,
        })),
      },
    ],
    skuEntries: [
      { skuId: 'sku-01', propertyValueIndexes: [0, 0], hasSubPrice: true },
      { skuId: 'sku-02', propertyValueIndexes: [0, 1], hasSubPrice: true },
      { skuId: 'sku-empty', propertyValueIndexes: [0, 2], hasSubPrice: false },
      { skuId: 'sku-03', propertyValueIndexes: [1, 0], hasSubPrice: true },
      { skuId: 'sku-04', propertyValueIndexes: [1, 1], hasSubPrice: true },
      { skuId: 'sku-empty-2', propertyValueIndexes: [1, 2], hasSubPrice: false },
    ],
  };
}

test('builds valid SKU combinations from page prop paths and excludes page-marked empty variants', () => {
  const payload = [
    '1.2米',
    '1.3米',
    '独立浴缸-左排-恒温',
    '独立浴缸-右排-恒温',
    '不可售规格|占位',
  ].join('\n');
  const topology = buildXwsSkuTopology(payload, pageSnapshot(payload.split('\n')));

  assert.equal(topology.version, 'xws-tmall-sku-topology-v1');
  assert.equal(topology.payloadSha256, sha256(payload));
  assert.equal(topology.dimensionPropertyIndex, 0);
  assert.equal(topology.specificationPropertyIndex, 1);
  assert.equal(topology.specificationSegmentCount, 3);
  assert.deepEqual(topology.validCombinations, [
    { skuId: 'sku-01', propertyValueIndexes: [0, 0] },
    { skuId: 'sku-02', propertyValueIndexes: [0, 1] },
    { skuId: 'sku-03', propertyValueIndexes: [1, 0] },
    { skuId: 'sku-04', propertyValueIndexes: [1, 1] },
  ]);
  assert.deepEqual(topology.properties.map((property) => property.values.map((value) => value.payloadLineIndex)), [
    [0, 1],
    [2, 3, 4],
  ]);
});

test('rejects a nonempty page combination without a current price representation', () => {
  const payload = [
    '1.2米',
    '1.3米',
    '独立浴缸-左排-恒温',
    '独立浴缸-右排-恒温',
    '不可售规格|占位',
  ].join('\n');
  const page = pageSnapshot(payload.split('\n'));
  page.skuEntries[1].hasSubPrice = false;

  assert.throws(
    () => buildXwsSkuTopology(payload, page),
    /current price representation/u,
  );
});

test('rejects a payload line not accounted for by the page property values', () => {
  const payload = [
    '1.2米',
    '1.3米',
    '独立浴缸-左排-恒温',
    '独立浴缸-右排-恒温',
    '不可售规格|占位',
    '额外内容',
  ].join('\n');

  assert.throws(
    () => buildXwsSkuTopology(payload, pageSnapshot(payload.split('\n'))),
    /unmapped payload line/u,
  );
});

test('supports plus-separated specification options with varying segment counts', () => {
  const payload = [
    '1.2m',
    '1.3m',
    '椭圆款PMMA人造石空缸+安装服务',
    '椭圆款PMMA人造石空缸+瀑布龙头+安装服务',
    '椭圆款PMMA人造石空缸+台上龙头+安装服务',
  ].join('\n');
  const page = pageSnapshot(payload.split('\n'));
  page.properties[1].values[2].empty = true;
  page.skuEntries = page.skuEntries.map((entry) => ({
    ...entry,
    hasSubPrice: entry.propertyValueIndexes[1] !== 2,
  }));

  const topology = buildXwsSkuTopology(payload, page);

  assert.equal(topology.specificationSegmentCount, 3);
  assert.deepEqual(topology.specificationSegmentCounts, [2, 3]);
  assert.equal(topology.specificationSeparator, '+');
});

test('uses the stable hyphen separator when a specification value contains an internal plus sign', () => {
  const payload = [
    '1.2m',
    '1.3m',
    '人造石浴缸-哑光白',
    '人造石浴缸-哑光白+优质落地龙头',
    '人造石浴缸-亮光白+优质瀑布龙头',
  ].join('\n');
  const page = pageSnapshot(payload.split('\n'));
  page.properties[1].values[2].empty = false;
  page.skuEntries = page.skuEntries.slice(0, 3);
  page.skuEntries[2].hasSubPrice = true;

  const topology = buildXwsSkuTopology(payload, page);

  assert.equal(topology.specificationSeparator, '-');
  assert.equal(topology.specificationSegmentCount, 2);
  assert.deepEqual(topology.specificationSegmentCounts, [2]);
});

test('prefers hyphen when both separators produce the same observed segment count', () => {
  const payload = [
    '1.4m',
    '1.5m',
    '人造石浴缸-型号126-白色+龙头+安装',
    '人造石浴缸-型号116-白色+龙头+安装',
  ].join('\n');
  const page = {
    properties: [
      { propertyIndex: 0, propertyNameSha256: sha256('尺寸'), values: [0, 1].map((lineIndex, valueIndex) => ({
        valueIndex, nameSha256: sha256(payload.split('\n')[lineIndex]), empty: false,
      })) },
      { propertyIndex: 1, propertyNameSha256: sha256('规格'), values: [2, 3].map((lineIndex, valueIndex) => ({
        valueIndex, nameSha256: sha256(payload.split('\n')[lineIndex]), empty: false,
      })) },
    ],
    skuEntries: [
      { skuId: 'sku-both-01', propertyValueIndexes: [0, 0], hasSubPrice: true },
      { skuId: 'sku-both-02', propertyValueIndexes: [1, 1], hasSubPrice: true },
    ],
  };

  const topology = buildXwsSkuTopology(payload, page);

  assert.equal(topology.specificationSeparator, '-');
  assert.equal(topology.specificationSegmentCount, 3);
});

test('accepts mixed plain and plus-separated specification values', () => {
  const payload = [
    '1.2m',
    '1.3m',
    '基础款',
    '基础款+龙头',
  ].join('\n');
  const page = {
    properties: [
      { propertyIndex: 0, propertyNameSha256: sha256('尺寸'), values: [0, 1].map((lineIndex, valueIndex) => ({
        valueIndex, nameSha256: sha256(payload.split('\n')[lineIndex]), empty: false,
      })) },
      { propertyIndex: 1, propertyNameSha256: sha256('规格'), values: [2, 3].map((lineIndex, valueIndex) => ({
        valueIndex, nameSha256: sha256(payload.split('\n')[lineIndex]), empty: false,
      })) },
    ],
    skuEntries: [
      { skuId: 'sku-mixed-01', propertyValueIndexes: [0, 0], hasSubPrice: true },
      { skuId: 'sku-mixed-02', propertyValueIndexes: [1, 1], hasSubPrice: true },
    ],
  };

  const topology = buildXwsSkuTopology(payload, page);

  assert.equal(topology.specificationSeparator, '+');
  assert.deepEqual(topology.specificationSegmentCounts, [1, 2]);
});

test('accepts a current price object when a page SKU has no subPrice field', () => {
  const payload = [
    '1.2米',
    '独立浴缸-安装服务-现货',
  ].join('\n');
  const page = {
    properties: [
      { propertyIndex: 0, propertyNameSha256: sha256('尺寸'), values: [{ valueIndex: 0, nameSha256: sha256('1.2米'), empty: false }] },
      { propertyIndex: 1, propertyNameSha256: sha256('规格'), values: [{ valueIndex: 0, nameSha256: sha256('独立浴缸-安装服务-现货'), empty: false }] },
    ],
    skuEntries: [{ skuId: 'sku-price-object', propertyValueIndexes: [0, 0], hasSubPrice: false, hasPriceRepresentation: true }],
  };

  const topology = buildXwsSkuTopology(payload, page);

  assert.deepEqual(topology.validCombinations, [{ skuId: 'sku-price-object', propertyValueIndexes: [0, 0] }]);
});
