import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { PROJECT_PORTS } from '../../../runtime/browser-ports.mjs';

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
  // 对着登记表断言（写死数字会把旧默认值固化成测试 —— 坑 34）。
  assert.equal(options.proxy, `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`);
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

// 2026-09-20 冷启动实测：脚本用 /new 新开 Base 页时，页面先发布 modelOperator.base，
// base.tables 晚一拍才填好。只判 Boolean(base) 会在那一拍里通过，随后报出
// 「Requested table is not available」—— 把「还没加载完」说成「表不存在」。
test('Base readiness requires a loaded table list, not just the base object', async () => {
  const { feishuBaseReady } = await modulePromise;
  assert.equal(typeof feishuBaseReady, 'function');

  assert.equal(feishuBaseReady(undefined), false);
  assert.equal(feishuBaseReady(null), false);
  assert.equal(feishuBaseReady({}), false);
  assert.equal(feishuBaseReady({ tables: {} }), false);
  assert.equal(feishuBaseReady({ tables: { tblOne: {} } }), true);
});

// 只留一个没人调用的导出函数不算修好：条件必须真的被注进浏览器探针。
// 这是**源码级**判据，所以下面两条字面量都不能出现在本文件的注释里（否则会自证成假红）。
test('the readiness probe sent to the browser is built from that predicate', async () => {
  const source = readFileSync(new URL('../scripts/copy-weekly-table.mjs', import.meta.url), 'utf8');
  assert.match(source, /\$\{FEISHU_BASE_READY_SOURCE\}\(window\.bitableStore/u);
  assert.doesNotMatch(source, /ready: Boolean\(window\.bitableStore/u);
});
