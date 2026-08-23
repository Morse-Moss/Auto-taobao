import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SKU_BACKLINK_FIELD_NAME,
  SKU_DETAIL_FIELDS,
  SKU_RELATION_FIELD_NAME,
} from '../skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs';

let buildSkuDryRunPlan;
try {
  ({ buildSkuDryRunPlan } = await import('./xws-sku-dry-run-core.mjs'));
} catch {
  // The first red run intentionally exercises the missing implementation.
}

const source = {
  productId: '1053695212757',
  productUrl: 'https://item.taobao.com/item.htm?id=1053695212757',
  productTitle: 'Synthetic product',
  competitorClass: 'A-高销量高GMV竞品',
  mainRecordId: 'recMain',
};

const target = {
  appToken: 'appSynthetic',
  mainTableId: 'tblMain',
  skuTableId: 'tblSku',
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function field(definition, index) {
  return {
    fieldId: `fldSku${index}`,
    fieldName: definition.name,
    type: definition.type,
    ...(definition.property ? { property: clone(definition.property) } : {}),
  };
}

function currentSkuFields() {
  return [
    ...SKU_DETAIL_FIELDS.map(field),
    {
      fieldId: 'fldSkuRelation',
      fieldName: SKU_RELATION_FIELD_NAME,
      type: 21,
      property: { multiple: false, table_id: target.mainTableId, back_field_name: SKU_BACKLINK_FIELD_NAME },
    },
  ];
}

function currentMainFields() {
  return [{
    fieldId: 'fldMainBacklink',
    fieldName: SKU_BACKLINK_FIELD_NAME,
    type: 21,
    property: { table_id: target.skuTableId },
  }];
}

function parsedRow(skuId, overrides = {}) {
  return {
    skuId,
    fields: {
      商品链接: source.productUrl,
      商品标题: source.productTitle,
      竞品分类: source.competitorClass,
      SKU名称: '独立浴缸',
      SKU规格: '独立浴缸-左排-恒温',
      SKU尺寸: '1.2米',
      尺寸汇总: '1.2m-1.3m',
      适用空间: '小户型',
      空间判定状态: '已判定',
      空间判定依据: 'SKU尺寸 1.2m 位于小户型固定区间 0.8m-1.2m',
      商品ID: source.productId,
      SKU唯一键: `${source.productId}|${skuId}`,
      采集状态: '已采集',
      所属竞品: source.mainRecordId,
      ...overrides,
    },
  };
}

function liveMainRecord() {
  return {
    recordId: source.mainRecordId,
    fields: {
      商品链接: source.productUrl,
      商品标题: source.productTitle,
      是否有效竞品: [{ text: '是' }],
      竞品分类: [{ text: source.competitorClass }],
    },
  };
}

function plan(args = {}) {
  assert.equal(typeof buildSkuDryRunPlan, 'function');
  return buildSkuDryRunPlan({
    target,
    source,
    mainRecord: liveMainRecord(),
    mainFields: currentMainFields(),
    skuFields: currentSkuFields(),
    skuRecords: [],
    parsedRows: [parsedRow('sku-1'), parsedRow('sku-2'), parsedRow('sku-3')],
    ...args,
  });
}

test('separates absent, identical, and conflicting SKU unique keys without overwriting data', () => {
  const identical = parsedRow('sku-1').fields;
  const conflicting = parsedRow('sku-3', { SKU尺寸: '1.5米' }).fields;
  const result = plan({
    skuRecords: [
      {
        recordId: 'recSkuExisting',
        fields: {
          ...identical,
          [SKU_RELATION_FIELD_NAME]: [{ record_id: source.mainRecordId, text: 'Synthetic product' }],
        },
      },
      {
        recordId: 'recSkuConflict',
        fields: {
          ...conflicting,
          [SKU_RELATION_FIELD_NAME]: [{ record_ids: [source.mainRecordId] }],
        },
      },
    ],
  });

  assert.deepEqual(result.summary, {
    parsedRows: 3,
    toCreate: 1,
    alreadyPresent: 1,
    conflict: 1,
    duplicateExistingKeys: 0,
    writeReady: false,
  });
  assert.deepEqual(result.items.map((item) => item.action), ['alreadyPresent', 'toCreate', 'conflict']);
  const create = result.items.find((item) => item.action === 'toCreate');
  assert.deepEqual(create.writeFields[SKU_RELATION_FIELD_NAME], [source.mainRecordId]);
  assert.equal(result.items.find((item) => item.action === 'conflict').recordId, 'recSkuConflict');
});

test('rejects a SKU schema that reintroduces the retired large-space option', () => {
  const skuFields = currentSkuFields();
  const space = skuFields.find((item) => item.fieldName === '适用空间');
  space.property.options.push({ name: '大户型' });

  assert.throws(() => plan({ skuFields }), /适用空间.*approved contract/u);
});

test('rejects source data when the current Feishu formula is no longer an A or B competitor', () => {
  const mainRecord = liveMainRecord();
  mainRecord.fields.竞品分类 = [{ text: 'C-中价位竞品' }];

  assert.throws(() => plan({ mainRecord }), /A or B/u);
});

test('validates the selected product when Feishu represents its link as a hyperlink object', () => {
  const mainRecord = liveMainRecord();
  mainRecord.fields.商品链接 = { text: '查看商品', link: source.productUrl };

  assert.equal(plan({ mainRecord }).summary.toCreate, 3);
});

test('does not make a write plan ready while the SKU table contains duplicate unique keys', () => {
  const result = plan({
    skuRecords: [
      { recordId: 'recDuplicateOne', fields: { SKU唯一键: 'other-product|sku-1' } },
      { recordId: 'recDuplicateTwo', fields: { SKU唯一键: 'other-product|sku-1' } },
    ],
  });

  assert.equal(result.summary.conflict, 0);
  assert.equal(result.summary.duplicateExistingKeys, 1);
  assert.equal(result.summary.writeReady, false);
});
