import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DECISION_HISTORY_COUNT_FIELDS,
  DECISION_HISTORY_HINT,
  DECISION_HISTORY_SNAPSHOT_FIELDS,
  buildDecisionHistoryArgs,
  buildWeeklyLocalAnalysis,
  digest,
  enrichRecordsWithLocalRules,
  judgeLocalAnalysisReadback,
  parseJsonOutput,
  parseOptions,
  readbackDecisionHistory,
  resolveTable,
  runDecisionHistoryStage,
} from './run-keyword-weekly-local-analysis.mjs';
import { profileTargets } from './feishu-targets.mjs';

const TABLE_NAME = '关键词分析 V1（2026-09-19）';
const PROFILE = 'kcne';
const HISTORY_TABLE = { table_id: 'tblHistory', name: '关键词历史总表 V1' };
const PREVIOUS_TABLE = { table_id: 'tblPrev', name: '关键词分析 V1（2026-09-12）' };

function optionsOf(argv, defaults = { envFile: 'E:/x.env', appToken: 'appTest' }) {
  return parseOptions(argv, defaults);
}

/**
 * 第三段的完整启用参数（不含 apply 相关）。
 *
 * `--expected-rows 1`：下面所有样本表都只有 1 行。这是刻意的 ——
 * 不这么写 `expectedRows` 就停在默认的 300，于是「基数缺口」这条判据会因为**行数对不上**而恒红，
 * 用例就永远照不到真正要照的那格（视觉列定格），变成一次假绿。
 */
const DECISION_ARGS = [
  '--table-name', TABLE_NAME, '--collection-date', '2026-09-19', '--batch-number', '8',
  '--expected-rows', '1',
  '--history-table-name', '关键词历史总表 V1',
  '--previous-table-name', '关键词分析 V1（2026-09-12）',
  '--expected-history-rows', '2367',
];

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

test('第三段默认关闭：不给 history 参数时行为与从前逐字相同', () => {
  const options = optionsOf(['--table-name', TABLE_NAME, '--collection-date', '2026-09-19', '--batch-number', '8']);
  assert.equal(options.historyTableName, undefined);
  assert.equal(options.historyTableId, undefined);
  assert.equal(options.skipDecisionHistory, false);
  assert.equal(options.expectedHistoryRows, undefined);
  // 提示语必须说清「没跑会缺什么」和「怎么补」——只写「未启用」等于让人自己去猜后果。
  assert.match(DECISION_HISTORY_HINT, /上一有效周/);
  assert.match(DECISION_HISTORY_HINT, /--history-table-name/);
  assert.match(DECISION_HISTORY_HINT, /--skip-decision-history/);
});

test('第三段 fail-closed：缺上一期表、缺历史行数、缺第三个确认、与 skip 互斥', () => {
  const base = ['--table-name', TABLE_NAME, '--collection-date', '2026-09-19', '--batch-number', '8'];
  // 上一期分析表是算基数的输入，缺了只能落 pending、写不进去 —— 参数层就拦住。
  assert.throws(
    () => optionsOf([...base, '--history-table-name', 'H', '--expected-history-rows', '10']),
    /previous-table-name/,
  );
  assert.throws(
    () => optionsOf([...base, '--history-table-name', 'H', '--previous-table-name', 'P']),
    /expected-history-rows/,
  );
  assert.throws(
    () => optionsOf([...base, '--history-table-name', 'H', '--previous-table-name', 'P', '--expected-history-rows', '0']),
    /expected-history-rows/,
  );
  // 真写时第三个确认不能少：历史表是另一张表，只确认本期表等于确认了一半。
  assert.throws(
    () => optionsOf([...DECISION_ARGS, '--table-id', 'tblX', '--apply', '--confirm-base', 'appTest', '--confirm-table', 'tblX']),
    /confirm-history-table/,
  );
  assert.doesNotThrow(() => optionsOf([
    ...DECISION_ARGS, '--table-id', 'tblX', '--apply',
    '--confirm-base', 'appTest', '--confirm-table', 'tblX', '--confirm-history-table', 'tblH',
  ]));
  // skip 与启用同时给是自相矛盾：要么跑要么不跑，不能既跑又声明没跑。
  assert.throws(
    () => optionsOf([...DECISION_ARGS, '--skip-decision-history']),
    /cannot be combined/,
  );
  assert.doesNotThrow(() => optionsOf([...base, '--skip-decision-history']));
});

test('第三段的调用参数：dry-run 不许带 --apply，真写时四个确认项一个都不能少', () => {
  const options = optionsOf(DECISION_ARGS);
  const shared = { profile: PROFILE, options, table: { table_id: 'tblX', name: TABLE_NAME }, historyTable: HISTORY_TABLE, previousTable: PREVIOUS_TABLE, backupDir: 'D:/b' };
  const dry = buildDecisionHistoryArgs(shared);
  assert.ok(!dry.includes('--apply'), 'dry-run 带 --apply 就等于把「先问缺不缺」这层保护删了');
  assert.ok(!dry.includes('--receipt-file'));
  // 1.6 要求 id/name 成对；只给一个它会当场拒，所以这里必须成对。
  assert.ok(dry.includes('--previous-table-id') && dry.includes('--previous-table-name'));
  assert.equal(dry[dry.indexOf('--base-url') + 1], `https://${profileTargets(PROFILE).host}/base/appTest`);
  assert.equal(dry[dry.indexOf('--current-batch-number') + 1], '8');
  assert.equal(dry[dry.indexOf('--expected-history-rows') + 1], '2367');
  assert.equal(dry[dry.indexOf('--history-table-id') + 1], 'tblHistory');

  const applied = buildDecisionHistoryArgs({ ...shared, options: optionsOf([...DECISION_ARGS, '--table-id', 'tblX', '--apply', '--confirm-base', 'appTest', '--confirm-table', 'tblX', '--confirm-history-table', 'tblHistory']), receiptFile: 'D:/r.json' });
  assert.ok(applied.includes('--apply'));
  assert.equal(applied[applied.indexOf('--confirm-base') + 1], 'appTest');
  assert.equal(applied[applied.indexOf('--confirm-current-table') + 1], 'tblX');
  assert.equal(applied[applied.indexOf('--confirm-history-table') + 1], 'tblHistory');
  assert.equal(applied[applied.indexOf('--receipt-file') + 1], 'D:/r.json');
  assert.ok(!applied.includes('--recalculate-existing-snapshots'));

  const recalc = buildDecisionHistoryArgs({ ...shared, options: optionsOf([...DECISION_ARGS, '--table-id', 'tblX', '--apply', '--confirm-base', 'appTest', '--confirm-table', 'tblX', '--confirm-history-table', 'tblHistory']), recalculate: true });
  assert.ok(recalc.includes('--recalculate-existing-snapshots'));
  // 没给 receiptFile 就不带这个 flag（`--receipt-file` 是可选参数，空值会变成「吃掉下一个 flag」）。
  assert.ok(!recalc.includes('--receipt-file'));
  assert.ok(buildDecisionHistoryArgs({ ...shared, options: optionsOf([...DECISION_ARGS, '--table-id', 'tblX', '--apply', '--confirm-base', 'appTest', '--confirm-table', 'tblX', '--confirm-history-table', 'tblHistory']), recalculate: true, receiptFile: 'D:/r2.json' }).includes('D:/r2.json'));

  // 回归点：入口带 `--apply` 跑时，「只读探路」那一次也必须仍然是只读。
  // 早先 `write` 直接跟随 `options.apply`，于是那一次真写也带上了 `--apply` —— 由用例照出来的。
  const writeOptions = optionsOf([...DECISION_ARGS, '--table-id', 'tblX', '--apply', '--confirm-base', 'appTest', '--confirm-table', 'tblX', '--confirm-history-table', 'tblHistory']);
  assert.ok(!buildDecisionHistoryArgs({ ...shared, options: writeOptions, write: false }).includes('--apply'));
  assert.ok(buildDecisionHistoryArgs({ ...shared, options: writeOptions }).includes('--apply'));
});

test('子进程输出解析：容忍前后杂音，但绝不在解析不出来时静默返回空计划', () => {
  assert.deepEqual(parseJsonOutput('  {"a":1}  ', 'x'), { a: 1 });
  assert.deepEqual(parseJsonOutput('log line\n{"a":{"b":2}}\ntrailing\n', 'x'), { a: { b: 2 } });
  // 解析不出来必须抛 —— 回落成 {} 会让「计划为零」被静默判成「已同步」。
  assert.throws(() => parseJsonOutput('', 'x'), /no output/);
  assert.throws(() => parseJsonOutput('no json here', 'x'), /no JSON object/);
  assert.throws(() => parseJsonOutput('{bad json}', 'x'), /unparsable/);
});

test('第三段独立回读：基数缺口、历史行缺口、快照定格在中间态，三种都要照出来', () => {
  const counts = DECISION_HISTORY_COUNT_FIELDS;
  const currentRecords = [
    { record_id: 'c1', fields: { 关键词编号: 'KW000001', 标准归并词: '浴缸', 是否重点词: '否', 优先级: 'B-持续观察', [counts[0]]: 0, [counts[1]]: 1, [counts[2]]: 0 } },
    { record_id: 'c2', fields: { 关键词编号: 'KW000002', 标准归并词: '浴缸家用', 是否重点词: '是', 优先级: 'A-立即跟进', [counts[0]]: 1, [counts[1]]: 0, [counts[2]]: 0 } },
    // 第三行的三个基数全空：这就是「基数没回写」的现场，三列公式在它上面整列为空。
    { record_id: 'c3', fields: { 关键词编号: 'KW000003', 标准归并词: '亚克力浴缸', 是否重点词: '否', 优先级: 'C-常规跟踪' } },
  ];
  const historyRecords = [
    { record_id: 'h7', fields: { 批次编号: 7, 关键词编号: 'KW000001', 重点达标: 0, A级达标: 0, 探索达标: 0, 标准归并词: '浴缸', 是否重点词: '否', 优先级: 'B-持续观察' } },
    { record_id: 'h8a', fields: { 批次编号: 8, 关键词编号: 'KW000001', 重点达标: 0, A级达标: 1, 探索达标: 0, 标准归并词: '浴缸', 是否重点词: '否', 优先级: 'B-持续观察' } },
    // 这一行就是 2026-09-19 期实测的那种定格：写入器报成功，快照却是「待数据」，源表已经定型成「是」。
    { record_id: 'h8b', fields: { 批次编号: 8, 关键词编号: 'KW000002', 重点达标: 1, A级达标: 0, 探索达标: 0, 标准归并词: '浴缸家用', 是否重点词: '待数据', 优先级: 'A-立即跟进' } },
    { record_id: 'h8c', fields: { 批次编号: 8, 关键词编号: 'KW000003', 重点达标: 0, A级达标: null, 探索达标: null, 标准归并词: '', 是否重点词: '否', 优先级: 'C-常规跟踪' } },
  ];
  const readback = readbackDecisionHistory({ currentRecords, historyRecords, expectedRows: 3, batchNumber: 8 });

  // ① 基数：只有第 3 行三列全空 ⇒ 三列都点名报缺口（而不是「表上大多有值」就放过）。
  assert.deepEqual(readback.countsFilled, { [counts[0]]: 2, [counts[1]]: 2, [counts[2]]: 2 });
  assert.deepEqual(readback.countsBlank, [
    { field: counts[0], filled: 2, expected: 3 },
    { field: counts[1], filled: 2, expected: 3 },
    { field: counts[2], filled: 2, expected: 3 },
  ]);
  // ② 只算本批次：批次 7 的历史行不许进统计（否则基数缺口会被上一批的有值率洗绿）。
  assert.equal(readback.currentBatchRows, 3);
  assert.equal(readback.snapshotFilled['是否重点词'], 3);
  assert.equal(readback.snapshotFilled['标准归并词'], 2);
  // 0 是**有值**、不是空 —— 数字列最容易在这里判反（h8c 的两列 null 才是真空）。
  assert.equal(readback.snapshotFilled['重点达标'], 3);
  assert.equal(readback.snapshotFilled['A级达标'], 2);
  assert.equal(readback.snapshotFilled['探索达标'], 2);
  // ③ 逐行比对只比「随公式变动」的三列，且点名到是哪一行哪一列。
  assert.equal(readback.visualMismatchCount, 2);
  assert.deepEqual(readback.visualMismatchByField, { 是否重点词: 1, 标准归并词: 1 });
  assert.deepEqual(readback.visualMismatchSamples, [
    { keywordNumber: 'KW000002', field: '是否重点词', history: '待数据', source: '是' },
    { keywordNumber: 'KW000003', field: '标准归并词', history: '', source: '亚克力浴缸' },
  ]);

  // 源表上「还没算完」的值（空 / 待数据 / # 开头）要单独数出来 ——
  // 它们是「上游没写完」，不是「快照写错了」，处置完全不同。
  const unresolved = readbackDecisionHistory({
    currentRecords: [{ record_id: 'x', fields: { 关键词编号: 'KW000009', 标准归并词: '', 是否重点词: '待数据', 优先级: '#REF!' } }],
    historyRecords: [],
    expectedRows: 1,
    batchNumber: 8,
  });
  assert.deepEqual(unresolved.unresolvedOnCurrent, { 标准归并词: 1, 是否重点词: 1, 优先级: 1 });
  // 快照列清单里必须有那三列视觉字段，否则上面这组比对会静默变成空跑。
  for (const name of ['标准归并词', '是否重点词', '优先级']) assert.ok(DECISION_HISTORY_SNAPSHOT_FIELDS.includes(name));
});

/** 造一个假的 reader：源表与历史表各返回一份记录。 */
function fakeReader(currentRecords, historyRecords) {
  return {
    listRecords: async (tableId) => (tableId === HISTORY_TABLE.table_id ? historyRecords : currentRecords),
  };
}

const counts = DECISION_HISTORY_COUNT_FIELDS;
const CLEAN_CURRENT = [{
  record_id: 'c1',
  fields: { 关键词编号: 'KW000001', 标准归并词: '浴缸', 是否重点词: '否', 优先级: 'B-持续观察', [counts[0]]: 0, [counts[1]]: 0, [counts[2]]: 0 },
}];
const CLEAN_HISTORY = [{
  record_id: 'h1',
  fields: { 批次编号: 8, 关键词编号: 'KW000001', 重点达标: 0, A级达标: 0, 探索达标: 0, 标准归并词: '浴缸', 是否重点词: '否', 优先级: 'B-持续观察' },
}];

function stageFixture({ planned = {}, pending = {}, apply = false, currentRecords = CLEAN_CURRENT, historyRecords = CLEAN_HISTORY } = {}) {
  const calls = [];
  const spawn = (_file, args) => {
    calls.push(args);
    const receiptIndex = args.indexOf('--receipt-file');
    const payload = args.includes('--apply')
      ? {
        mode: 'APPLIED_AND_VERIFIED',
        receiptFile: receiptIndex >= 0 ? args[receiptIndex + 1] : undefined,
        backup: { file: 'D:/backup.json' },
        planned,
      }
      : { mode: 'DRY_RUN_READY', planned, pending };
    return { status: 0, stdout: JSON.stringify(payload), stderr: '' };
  };
  const options = apply
    ? optionsOf([...DECISION_ARGS, '--table-id', 'tblX', '--apply', '--confirm-base', 'appTest', '--confirm-table', 'tblX', '--confirm-history-table', 'tblHistory'])
    : optionsOf(DECISION_ARGS);
  return {
    calls,
    run: () => runDecisionHistoryStage({
      profile: PROFILE,
      options,
      table: { table_id: 'tblX', name: TABLE_NAME },
      historyTable: HISTORY_TABLE,
      previousTable: PREVIOUS_TABLE,
      reader: fakeReader(currentRecords, historyRecords),
      runDir: 'D:/run',
      backupDir: 'D:/backups',
      spawn,
      delay: async () => {},
    }),
  };
}

test('整体状态判据：本地五列绿 + 决策历史绿 才叫绿；「本来就该空」不算缺口', () => {
  const rules = (labelCount, heatCount) => Array.from({ length: 300 }, (_, index) => ({
    标准归并词: '浴缸', 关键词分类: '大词',
    细分标签: index < labelCount ? ['材质/亚克力'] : [],
    用户意图: '了解型',
    内容热度: index < heatCount ? '中' : '',
  }));
  const GREEN = { status: 'APPLIED_AND_VERIFIED' };
  const SYNCED = { status: 'ALREADY_SYNCED' };

  // 基准：本地判出 290 行有标签、300 行有热度；表上与之一致 ⇒ 绿。
  const base = {
    afterFilled: { 标准归并词: 300, 关键词分类: 300, 细分标签: 290, 用户意图: 300, 内容热度: 300 },
    afterRows: 300,
    ruleValues: rules(290, 300),
    decisionHistory: GREEN,
  };
  assert.equal(judgeLocalAnalysisReadback(base).status, 'APPLIED_AND_READBACK_VERIFIED');
  // `细分标签` 只剩 290/300 是**正确**状态（MultiSelect，本地对那些词判不出标签）。
  // 老判据（「空格数必须为 0」）会把它永久报黄 —— 假黄会让人学会忽略这个字段。
  assert.deepEqual(judgeLocalAnalysisReadback(base).stillBlank, [['细分标签', 290]]);
  assert.deepEqual(judgeLocalAnalysisReadback(base).unexplainedBlank, []);

  // 决策历史那一段没落地 ⇒ 整体不许绿（基数没回写 = 三个「近2周…达标次数」整列为空）。
  assert.equal(judgeLocalAnalysisReadback({ ...base, decisionHistory: { status: 'APPLIED_WITH_GAPS' } }).status, 'APPLIED_WITH_GAPS');
  assert.equal(judgeLocalAnalysisReadback({ ...base, decisionHistory: { status: 'DRY_RUN_HAS_WORK' } }).status, 'APPLIED_WITH_GAPS');
  assert.equal(judgeLocalAnalysisReadback({ ...base, decisionHistory: { status: 'ALREADY_SYNCED_WITH_PENDING' } }).status, 'APPLIED_WITH_GAPS');
  // 完全没启用第三段时，本条不做否决（与从前逐字相同）。
  assert.equal(judgeLocalAnalysisReadback({ ...base, decisionHistory: undefined }).status, 'APPLIED_AND_READBACK_VERIFIED');
  assert.equal(judgeLocalAnalysisReadback({ ...base, decisionHistory: SYNCED }).status, 'APPLIED_AND_READBACK_VERIFIED');

  // 真缺口：本地判得出标签、表上却没值 ⇒ 点名到字段，并给出「至少该有多少」。
  const gap = judgeLocalAnalysisReadback({ ...base, afterFilled: { ...base.afterFilled, 细分标签: 250 } });
  assert.equal(gap.status, 'APPLIED_WITH_GAPS');
  assert.deepEqual(gap.unexplainedBlank, [{ field: '细分标签', filled: 250, expectedAtLeast: 290, localBlank: 10 }]);

  // 内容热度整列没落地 —— 那是纯漏写，`expectedBlank` 为 0，一格都不许少。
  const heat = judgeLocalAnalysisReadback({ ...base, afterFilled: { ...base.afterFilled, 内容热度: 299 } });
  assert.equal(heat.status, 'APPLIED_WITH_GAPS');
  assert.deepEqual(heat.unexplainedBlank, [{ field: '内容热度', filled: 299, expectedAtLeast: 300, localBlank: 0 }]);
  // 本地对某列全判空（本地判不出）时不许因此报绿以外的错：expectedAtLeast 会落到 0。
  const allBlankLocally = judgeLocalAnalysisReadback({
    ...base,
    ruleValues: rules(0, 300),
    afterFilled: { ...base.afterFilled, 细分标签: 0 },
  });
  assert.equal(allBlankLocally.status, 'APPLIED_AND_READBACK_VERIFIED');
  assert.equal(allBlankLocally.expectedBlank['细分标签'], 300);
});

test('第三段幂等：计划全零时一个写入子进程都不起（重跑安全的根据）', async () => {
  const fixture = stageFixture({ planned: { historySnapshotsToWrite: 0, currentCountsToWrite: 0, historyFieldsToCreate: 0, historyFieldsToUpdate: 0, historyValidityToWrite: 0 }, apply: true });
  const stage = await fixture.run();
  assert.equal(stage.status, 'ALREADY_SYNCED');
  assert.equal(stage.wrote, false);
  assert.equal(stage.mode, 'skipped');
  // 只起了那一次只读 dry-run —— 这是「已同步 ⇒ 零写入」的直接证据。
  assert.equal(fixture.calls.length, 1);
  assert.ok(!fixture.calls[0].includes('--apply'));
  // 连源表/历史表都不用读：没有工作就没有要回读的东西。
  assert.equal(stage.readback, undefined);
});

test('第三段：dry-run 只报「缺什么」，不起写入；计划非零且带 pending 时状态要能区分', async () => {
  const dry = stageFixture({ planned: { historySnapshotsToWrite: 5, currentCountsToWrite: 300 } });
  const dryStage = await dry.run();
  assert.equal(dryStage.status, 'DRY_RUN_HAS_WORK');
  assert.equal(dryStage.writeUnits, 305);
  assert.equal(dryStage.wrote, false);
  assert.equal(dry.calls.length, 1);

  // 已同步但仍有算不出来的格（pending）—— 不许报成干净的 ALREADY_SYNCED。
  const pending = stageFixture({ planned: {}, pending: { historySnapshots: 7, currentCounts: 0 } });
  const pendingStage = await pending.run();
  assert.equal(pendingStage.status, 'ALREADY_SYNCED_WITH_PENDING');
  assert.equal(pendingStage.pendingTotal, 7);
  assert.equal(pendingStage.wrote, false);
});

test('第三段自愈：第一遍快照定格在中间态时自动跑第二遍，两遍之后仍不一致就不许报绿', async () => {
  // 历史表的 `是否重点词` 还是「待数据」（第一遍快照定格），源表已经定型 ⇒ 必须补第二遍。
  const staleHistory = [{ record_id: 'h1', fields: { 批次编号: 8, 关键词编号: 'KW000001', 重点达标: 0, A级达标: 0, 探索达标: 0, 标准归并词: '浴缸', 是否重点词: '待数据', 优先级: 'B-持续观察' } }];
  const stale = stageFixture({
    planned: { historySnapshotsToWrite: 1, currentCountsToWrite: 1 },
    apply: true,
    historyRecords: staleHistory,
    currentRecords: CLEAN_CURRENT,
  });
  const staleStage = await stale.run();
  // 三次子进程：只读 dry-run、第一遍 apply、第二遍 recalculate。
  assert.equal(stale.calls.length, 3);
  assert.equal(fixturePlannedCalls(stale), 2);
  assert.ok(!stale.calls[0].includes('--apply'));
  assert.ok(stale.calls[1].includes('--apply') && stale.calls[1].includes('--receipt-file'));
  assert.ok(stale.calls[1].includes('--recalculate-existing-snapshots') === false);
  assert.ok(stale.calls[2].includes('--recalculate-existing-snapshots'));
  // 两遍的收据必须各用一个文件名：那个文件用 flag:'wx' 建，同名会直接抛。
  const firstReceipt = stale.calls[1][stale.calls[1].indexOf('--receipt-file') + 1];
  const recalcReceipt = stale.calls[2][stale.calls[2].indexOf('--receipt-file') + 1];
  assert.match(firstReceipt, /decision-history-receipt-/u);
  assert.match(recalcReceipt, /decision-history-recalc-receipt-/u);
  assert.notEqual(recalcReceipt, firstReceipt);
  assert.equal(staleStage.secondPass.mismatchBefore, 1);
  assert.deepEqual(staleStage.secondPass.mismatchByFieldBefore, { 是否重点词: 1 });
  // fakeReader 两遍返回的是同一份定格数据 ⇒ 不一致还在 ⇒ 状态必须**不是**绿的。
  assert.equal(staleStage.readback.visualMismatchCount, 1);
  assert.equal(staleStage.status, 'APPLIED_WITH_GAPS');

  // 对照：源表与历史表一致时**只跑一遍**，且报绿。
  const healthy = stageFixture({ planned: { historySnapshotsToWrite: 1, currentCountsToWrite: 1 }, apply: true });
  const healthyStage = await healthy.run();
  assert.equal(healthy.calls.length, 2);
  assert.equal(fixturePlannedCalls(healthy), 1);
  assert.equal(healthyStage.status, 'APPLIED_AND_VERIFIED');
  assert.equal(healthyStage.wrote, true);
  assert.equal(healthyStage.secondPass, undefined);
  assert.equal(healthyStage.readback.countsBlank.length, 0);
  assert.equal(healthyStage.backupFile, 'D:/backup.json');
  assert.match(healthyStage.receiptFile, /^D:\\run\\decision-history-receipt-\d{8}T\d{6}Z\.json$/u);
});

/** 数一下真正发起的写入有几遍（只读 dry-run 不算）。 */
function fixturePlannedCalls(fixture) {
  return fixture.calls.filter((args) => args.includes('--apply')).length;
}
