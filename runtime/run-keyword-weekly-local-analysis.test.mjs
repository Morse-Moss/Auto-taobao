import assert from 'node:assert/strict';
import test from 'node:test';

import {
  digest,
  enrichRecordsWithLocalRules,
  buildWeeklyLocalAnalysis,
  parseOptions,
  resolveTable,
} from './run-keyword-weekly-local-analysis.mjs';

const TABLE_NAME = '关键词分析 V1（2026-09-19）';

function optionsOf(argv, defaults = { envFile: 'E:/x.env', appToken: 'appTest' }) {
  return parseOptions(argv, defaults);
}

test('入口默认 dry-run，且真写必须带两个精确确认', () => {
  const base = ['--table-name', TABLE_NAME, '--collection-date', '2026-09-19', '--batch-number', '8'];
  const dry = optionsOf(base);
  assert.equal(dry.apply, false);
  assert.equal(dry.expectedRows, 300);
  assert.equal(dry.appToken, 'appTest');
  assert.equal(dry.envFile, 'E:/x.env');

  // 只给一半确认也要拦住 —— 少一个确认就等于「确认过一半」。
  // 真写必须先点名 table id：表名每周新建、可以同名，只报名字不算「我确认写的是这一张」。
  assert.throws(() => optionsOf([...base, '--apply', '--confirm-base', 'appTest']), /--table-id/);
  assert.throws(() => optionsOf([...base, '--table-id', 'tblX', '--apply', '--confirm-base', 'appTest']), /confirm-table/);
  assert.throws(() => optionsOf([...base, '--table-id', 'tblX', '--apply', '--confirm-table', 'tblX']), /confirm-base/);
  assert.throws(() => optionsOf([...base, '--table-id', 'tblX', '--apply', '--confirm-base', 'appOther', '--confirm-table', 'tblX']), /confirm-base/);
  assert.doesNotThrow(() => optionsOf([...base, '--table-id', 'tblX', '--apply', '--confirm-base', 'appTest', '--confirm-table', 'tblX']));
});

test('入口参数 fail-closed：表、日期、批次号缺一个都不许跑', () => {
  assert.throws(() => optionsOf(['--collection-date', '2026-09-19', '--batch-number', '8']), /table-name/);
  assert.throws(() => optionsOf(['--table-id', 'tblX', '--batch-number', '8']), /collection-date/);
  assert.throws(() => optionsOf(['--table-id', 'tblX', '--collection-date', '2026/09/19', '--batch-number', '8']), /YYYY-MM-DD/);
  assert.throws(() => optionsOf(['--table-id', 'tblX', '--collection-date', '2026-09-19']), /batch-number/);
  assert.throws(() => optionsOf(['--table-name', TABLE_NAME, '--collection-date', '2026-09-19', '--batch-number', '0']), /batch-number/);
  assert.throws(() => optionsOf(['--table-name', TABLE_NAME, '--collection-date', '2026-09-19', '--batch-number', '8', '--nope', '1']), /Unknown option/);
  // 凭据文件解析不出来时不许回落成某个内置路径（历史上写死旧租户路径导致过 91403）。
  assert.throws(() => optionsOf(['--table-id', 'tblX', '--collection-date', '2026-09-19', '--batch-number', '8'], {}), /credential file/);
});

test('表解析：按名优先，名字与 id 不一致时当场抛错', () => {
  const tables = [
    { table_id: 'tblA', name: TABLE_NAME },
    { table_id: 'tblB', name: '关键词分析 V1（2026-09-12）' },
  ];
  assert.equal(resolveTable(tables, { tableName: TABLE_NAME }).table_id, 'tblA');
  assert.equal(resolveTable(tables, { tableId: 'tblB' }).name, '关键词分析 V1（2026-09-12）');
  assert.equal(resolveTable(tables, { tableName: TABLE_NAME, tableId: 'tblA' }).table_id, 'tblA');
  // id 指向另一张表、名字指这张 —— 这种「各错一半」看着像跑通了，其实写的是别人。
  assert.throws(() => resolveTable(tables, { tableName: TABLE_NAME, tableId: 'tblB' }), /identity mismatch/);
  assert.throws(() => resolveTable(tables, { tableName: '不存在的表' }), /not found/);
  assert.throws(() => resolveTable([...tables, { table_id: 'tblC', name: TABLE_NAME }], { tableName: TABLE_NAME }), /Multiple tables named/);
});

test('本地规则只补空白格，表上已有的值一个字都不动', () => {
  const records = [
    { record_id: 'rec001', fields: { 搜索词: '亚克力浴缸' } },
    { record_id: 'rec002', fields: { 搜索词: '浴缸', 关键词分类: '大词', 用户意图: '了解型' } },
  ];
  const enriched = enrichRecordsWithLocalRules(records);
  const [first, second] = enriched;

  // 空白 ⇒ 用本地算出来的那份
  assert.equal(first.__ruleSource['关键词分类'], 'local-rule');
  assert.ok(first.fields['关键词分类']);
  assert.deepEqual(first.fields['细分标签'], ['材质/亚克力']);
  // 已有值 ⇒ 原样保留，且不把它算成「本地补的」
  assert.equal(second.fields['关键词分类'], '大词');
  assert.equal(second.fields['用户意图'], '了解型');
  assert.equal(second.__ruleSource['关键词分类'], 'table');
  assert.equal(second.__ruleSource['用户意图'], 'table');
  assert.equal(second.__ruleSource['标准归并词'], 'local-rule');
  // 原对象不许被改写（就地改会让快照与判定依据不是同一份）
  assert.equal(records[0].fields['关键词分类'], undefined);
  assert.throws(() => enrichRecordsWithLocalRules([{ record_id: 'rec003', fields: {} }]), /no source keyword/);
});

test('一次本地分析产出全部 5 个字段，内容热度按本地算出的分类与标签判', () => {
  // 表上 关键词分类/细分标签 故意留空：判定必须用本地规则补出来的那份。
  // 直接用表上那份（空的）会把这两行都判成「低」——那是静默的错，不是保守。
  const records = [
    { record_id: 'rec001', fields: { 搜索词: '浴缸家用成人', 搜索人气: '1200 ~ 2500', 支付转化率: '5% ~ 7.5%' } },
    { record_id: 'rec002', fields: { 搜索词: '浴缸', 搜索人气: '0 ~ 20', 支付转化率: '0% ~ 1%' } },
    { record_id: 'rec003', fields: { 搜索词: '科勒浴缸旗舰店', 搜索人气: '0 ~ 20', 支付转化率: '0% ~ 1%' } },
  ];
  const { manifest, contentHeatArtifact, ruleValues } = buildWeeklyLocalAnalysis({
    table: { table_id: 'tblTest', name: TABLE_NAME, appToken: 'appTest' },
    fields: [{ field_name: '内容热度' }],
    records,
    collectionDate: '2026-09-19',
    batchNumber: 8,
    judgedAt: '2026-09-21T00:00:00.000Z',
  });

  assert.equal(manifest.status, 'LOCAL_ANALYSIS_READY');
  assert.equal(manifest.recordCount, 3);
  assert.deepEqual(manifest.fields, ['标准归并词', '关键词分类', '细分标签', '用户意图', '内容热度']);
  assert.equal(manifest.blankOnTable['内容热度'], 3);
  assert.equal(contentHeatArtifact.recordCount, 3);
  assert.equal(ruleValues.length, 3);
  assert.equal(ruleValues[0].规则来源['关键词分类'], 'local-rule');
  // 三行都取到了判定，且都在值域内
  assert.ok(ruleValues.every((item) => ['低', '中', '高', '待核验'].includes(item.内容热度)));
  assert.equal(contentHeatArtifact.values.length, 3);
  assert.deepEqual(
    contentHeatArtifact.values.map((item) => item.record_id),
    records.map((record) => record.record_id),
  );
});

test('digest 与对象键顺序无关（否则「同一批数据」会算出两个指纹）', () => {
  assert.equal(digest({ a: 1, b: { c: 2, d: 3 } }), digest({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
});
