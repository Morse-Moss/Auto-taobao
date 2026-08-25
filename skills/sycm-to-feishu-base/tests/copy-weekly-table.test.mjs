import assert from 'node:assert/strict';
import test from 'node:test';

const modulePromise = import('../scripts/copy-weekly-table.mjs').catch(() => ({}));

const baseArgs = [
  '--base-url', 'https://example.feishu.cn/base/appToken?table=tblSource&view=vewSource',
  '--source-table-id', 'tblSource',
  '--source-table-name', '关键词分析 V1（修正版）',
  '--new-table-name', '普通浴缸关键词周采集 2026-08-20',
];

test('same-base copy CLI requires explicit identities and defaults to read-only', async () => {
  const module = await modulePromise;
  assert.equal(typeof module.parseOptions, 'function');

  const options = module.parseOptions(baseArgs);

  assert.equal(options.appToken, 'appToken');
  assert.equal(options.sourceTableId, 'tblSource');
  assert.equal(options.sourceTableName, '关键词分析 V1（修正版）');
  assert.equal(options.newTableName, '普通浴缸关键词周采集 2026-08-20');
  assert.equal(options.proxy, 'http://127.0.0.1:3456');
  assert.equal(options.apply, false);
});

test('same-base copy requires an exact base confirmation before apply', async () => {
  const { parseOptions } = await modulePromise;
  assert.equal(typeof parseOptions, 'function');

  assert.throws(() => parseOptions([...baseArgs, '--apply']), /confirm-base/u);
  assert.throws(
    () => parseOptions([...baseArgs, '--apply', '--confirm-base', 'anotherBase']),
    /does not match/u,
  );

  const options = parseOptions([...baseArgs, '--apply', '--confirm-base', 'appToken']);
  assert.equal(options.apply, true);
  assert.equal(options.confirmBase, 'appToken');
});

function sourceSnapshot() {
  return {
    id: 'tblSource',
    name: '关键词分析 V1（修正版）',
    recordsNum: 301,
    fields: [
      { id: 'fldSearch', name: '搜索词', type: 1, property: null, exInfo: null },
      {
        id: 'fldPriority',
        name: '优先级',
        type: 20,
        property: { formula_expression: 'bitable::$table[tblSource].$field[fldSearch]' },
        exInfo: null,
      },
      {
        id: 'fldMerge',
        name: '标准归并词',
        type: 1,
        property: null,
        exInfo: {
          aiPrompt: { queries: [{ type: 'fieldRef', value: { fieldId: 'fldSearch' } }] },
          customOpenTypeData: { innerType: 'ai_custom', version: '6' },
        },
      },
    ],
    views: [{
      id: 'vewSource',
      name: '全部记录',
      type: 1,
      visibleFieldIds: ['fldSearch', 'fldPriority', 'fldMerge'],
      property: {
        fields: ['fldSearch', 'fldPriority', 'fldMerge'],
        records: ['rec1'],
        colInfos: { fldSearch: { width: 180, hidden: false } },
      },
    }],
  };
}

function copySnapshot() {
  return {
    id: 'tblCopy',
    name: '普通浴缸关键词周采集 2026-08-20',
    recordsNum: 0,
    fields: [
      { id: 'fldCopySearch', name: '搜索词', type: 1, property: null, exInfo: null },
      {
        id: 'fldCopyPriority',
        name: '优先级',
        type: 20,
        property: { formula_expression: 'bitable::$table[tblCopy].$field[fldCopySearch]' },
        exInfo: null,
      },
      {
        id: 'fldCopyMerge',
        name: '标准归并词',
        type: 1,
        property: null,
        exInfo: {
          aiPrompt: { queries: [{ type: 'fieldRef', value: { fieldId: 'fldCopySearch' } }] },
          customOpenTypeData: { innerType: 'ai_custom', version: '6' },
        },
      },
    ],
    views: [{
      id: 'vewCopy',
      name: '全部记录',
      type: 1,
      visibleFieldIds: ['fldCopySearch', 'fldCopyPriority', 'fldCopyMerge'],
      property: {
        fields: ['fldCopySearch', 'fldCopyPriority', 'fldCopyMerge'],
        records: [],
        colInfos: { fldCopySearch: { width: 180, hidden: false } },
      },
    }],
  };
}

test('structure verification ignores regenerated ids but preserves formulas, AI prompts, and views', async () => {
  const { verifyStructureCopy } = await modulePromise;
  assert.equal(typeof verifyStructureCopy, 'function');

  assert.deepEqual(verifyStructureCopy(sourceSnapshot(), copySnapshot()), {
    fieldCount: 3,
    formulaFieldCount: 1,
    aiFieldCount: 1,
    viewCount: 1,
    copiedRecordCount: 0,
  });
});

test('structure verification rejects records or changed AI prompts', async () => {
  const { verifyStructureCopy } = await modulePromise;
  assert.equal(typeof verifyStructureCopy, 'function');

  const withRecord = copySnapshot();
  withRecord.recordsNum = 1;
  assert.throws(() => verifyStructureCopy(sourceSnapshot(), withRecord), /must be empty/u);

  const changedPrompt = copySnapshot();
  changedPrompt.fields[2].exInfo.aiPrompt.queries[0].value.fieldId = 'fldUnexpected';
  assert.throws(() => verifyStructureCopy(sourceSnapshot(), changedPrompt), /structure differs/u);
});

test('copy completion waits for a cloud Base revision instead of the optimistic client model', async () => {
  const { isCopyCloudSettled } = await modulePromise;
  assert.equal(typeof isCopyCloudSettled, 'function');
  assert.equal(isCopyCloudSettled(13, { baseRev: 13, saving: false, tableExists: true }), false);
  assert.equal(isCopyCloudSettled(13, { baseRev: 14, saving: true, tableExists: true }), false);
  assert.equal(isCopyCloudSettled(13, { baseRev: 14, saving: false, tableExists: true }), true);
});

test('target discovery opens the authorized Base only when no matching tab exists', async () => {
  const { resolveFeishuTarget } = await modulePromise;
  assert.equal(typeof resolveFeishuTarget, 'function');
  const matching = { type: 'page', targetId: 'target-1', url: 'https://example.feishu.cn/base/appToken?table=tblOne' };
  const unrelatedTable = { type: 'page', targetId: 'target-3', url: 'https://example.feishu.cn/base/appToken?table=tblTwo' };
  assert.equal((await resolveFeishuTarget({
    targets: [matching, unrelatedTable],
    appToken: 'appToken',
    tableId: 'tblOne',
    createBaseTab: async () => { throw new Error('must not create'); },
    listTargets: async () => [],
  })).targetId, 'target-1');

  let opened = 0;
  assert.equal((await resolveFeishuTarget({
    targets: [],
    appToken: 'appToken',
    tableId: 'tblOne',
    createBaseTab: async () => { opened += 1; },
    listTargets: async () => [matching],
  })).targetId, 'target-1');
  assert.equal(opened, 1);

  await assert.rejects(() => resolveFeishuTarget({
    targets: [matching, { ...matching, targetId: 'target-2' }],
    appToken: 'appToken',
    tableId: 'tblOne',
    createBaseTab: async () => {},
    listTargets: async () => [],
  }), /table tblOne; received 2/iu);
});

test('newly opened Base waits for the frontend model and stops on visible security controls', async () => {
  const { waitForFeishuModel } = await modulePromise;
  assert.equal(typeof waitForFeishuModel, 'function');
  let reads = 0;
  const ready = await waitForFeishuModel({
    inspect: async () => ({ targetId: 'target-1', ready: ++reads === 2, visibleTexts: [] }),
    sleep: async () => {},
    timeoutMs: 100,
  });
  assert.equal(ready, 'target-1');
  await assert.rejects(() => waitForFeishuModel({
    inspect: async () => ({ targetId: 'target-1', ready: false, visibleTexts: ['请扫码登录'] }),
    sleep: async () => {},
    timeoutMs: 100,
  }), (error) => error.code === 'HUMAN_REQUIRED');
});
