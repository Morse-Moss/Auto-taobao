import assert from 'node:assert/strict';
import test from 'node:test';

let assertFreshPlanMatchesManifest;
let assertPostWritePlan;
let buildSkuBatchCreateRequest;
try {
  ({
    assertFreshPlanMatchesManifest,
    assertPostWritePlan,
    buildSkuBatchCreateRequest,
  } = await import('./apply-xws-sku-manifest-core.mjs'));
} catch {
  // The first red run intentionally exercises the missing write guard.
}

const target = {
  appToken: 'appSku',
  mainTableId: 'tblMain',
  mainTableName: '竞品主表',
  skuTableId: 'tblSku',
  skuTableName: 'SKU明细',
};

function writeFields(skuId, overrides = {}) {
  return {
    商品链接: 'https://item.taobao.com/item.htm?id=1053695212757',
    商品标题: 'Synthetic product',
    竞品分类: 'A-高销量高GMV竞品',
    SKU名称: '独立浴缸',
    SKU规格: '独立浴缸-左排-恒温',
    SKU尺寸: '1.2米',
    尺寸汇总: '1.2m-1.3m',
    适用空间: '小户型',
    空间判定状态: '已判定',
    空间判定依据: 'fixed rule',
    商品ID: '1053695212757',
    SKU唯一键: '1053695212757|' + skuId,
    采集状态: '已采集',
    所属竞品: ['recMain'],
    ...overrides,
  };
}

function toCreate(skuId) {
  return {
    skuId,
    uniqueKey: '1053695212757|' + skuId,
    action: 'toCreate',
    writeFields: writeFields(skuId),
  };
}

function manifest() {
  const items = [toCreate('sku-1'), toCreate('sku-2')];
  return {
    version: 'xws-sku-dry-run-manifest-v1',
    mode: 'DRY_RUN',
    target,
    evidence: {
      source: { mainRecordId: 'recMain', productId: '1053695212757' },
    },
    source: {
      mainRecordId: 'recMain',
      productId: '1053695212757',
      productUrl: 'https://item.taobao.com/item.htm?id=1053695212757',
      productTitle: 'Synthetic product',
      competitorClass: 'A-高销量高GMV竞品',
    },
    plan: {
      summary: {
        parsedRows: 2,
        toCreate: 2,
        alreadyPresent: 0,
        conflict: 0,
        duplicateExistingKeys: 0,
        writeReady: true,
      },
      items,
    },
  };
}

test('constructs one exact SKU batch-create request from a ready manifest', () => {
  assert.equal(typeof buildSkuBatchCreateRequest, 'function');
  const request = buildSkuBatchCreateRequest(manifest(), { target, expectedRecordCount: 2 });

  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/bitable/v1/apps/appSku/tables/tblSku/records/batch_create');
  assert.deepEqual(request.body.records.map((record) => record.fields.所属竞品), [['recMain'], ['recMain']]);
  assert.deepEqual(request.body.records.map((record) => record.fields.SKU唯一键), [
    '1053695212757|sku-1',
    '1053695212757|sku-2',
  ]);
});

test('refuses a manifest that carries the retired large-space value', () => {
  const input = manifest();
  input.plan.items[1].writeFields.适用空间 = '大户型';

  assert.throws(
    () => buildSkuBatchCreateRequest(input, { target, expectedRecordCount: 2 }),
    /适用空间/u,
  );
});

test('refuses a fresh plan whose write fields differ from the approved manifest', () => {
  assert.equal(typeof assertFreshPlanMatchesManifest, 'function');
  const input = manifest();
  const freshPlan = structuredClone(input.plan);
  freshPlan.items[1].writeFields.SKU尺寸 = '1.5米';

  assert.throws(
    () => assertFreshPlanMatchesManifest(input, freshPlan, { expectedRecordCount: 2 }),
    /differs/u,
  );
});

test('accepts post-write verification only when every SKU is read back as already present', () => {
  assert.equal(typeof assertPostWritePlan, 'function');
  const verified = {
    summary: {
      parsedRows: 2,
      toCreate: 0,
      alreadyPresent: 2,
      conflict: 0,
      duplicateExistingKeys: 0,
      writeReady: true,
    },
    items: [
      { action: 'alreadyPresent', recordId: 'recSku1' },
      { action: 'alreadyPresent', recordId: 'recSku2' },
    ],
  };

  assert.doesNotThrow(() => assertPostWritePlan(verified, { expectedRecordCount: 2 }));
  verified.items[1].action = 'conflict';
  assert.throws(() => assertPostWritePlan(verified, { expectedRecordCount: 2 }), /already present/u);
});
