// `weekly-round-input.mjs` 的用例：周期 → 每周入参。
//
// 这个模块的价值全在「推导对不对」上，而推导错了**不会报错**——它只会让某一期去克隆错误的
// 上一期表、或者把批次号写成同一个。所以边界（跨周/跨月/跨年、非周六结束日、空历史表）
// 每一条都要有一条用例钉住，而不是只测「正常情况好看」。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  COLLECT_INPUT_RESOLVER_ID,
  KEYWORD_HISTORY_TABLE_NAME,
  KEYWORD_LIBRARY_TABLE_NAME,
  collectInputResolverFor,
  createKeywordWeeklyCollectInputResolver,
  deriveBatchNumber,
  deriveExpectedHistoryBefore,
  keywordWeeklyTableName,
  parseKeywordWeeklyTableName,
  resolveKeywordWeeklyWindow,
  resolveTableByName,
} from './weekly-round-input.mjs';

const MODULE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'weekly-round-input.mjs');

const week = (startDate, endDate) => ({ kind: 'PREVIOUS_WEEK_SUN_SAT', startDate, endDate });

// ── 表名 ⇄ 采集日 ─────────────────────────────────────────────────────────

test('table name round-trips through its collection date', () => {
  const name = keywordWeeklyTableName('2026-09-19');
  // 全角括号是**规格的一部分**，不是排版选择：库里的表名就是全角，半角匹配不上任何一张表。
  assert.equal(name, '关键词分析 V1（2026-09-19）');
  assert.deepEqual(parseKeywordWeeklyTableName(name), { collectionDate: '2026-09-19' });
});

test('the legacy 修正版 table is not mistaken for a dated weekly table', () => {
  // 实测踩过：用 startsWith('关键词分析 V1') 做筛选会先撞上遗留的「修正版」表（301 行）。
  assert.equal(parseKeywordWeeklyTableName('关键词分析 V1（修正版）'), null);
  assert.equal(parseKeywordWeeklyTableName('关键词历史总表 V1'), null);
  assert.equal(parseKeywordWeeklyTableName('竞品周_2026-09-13_2026-09-19'), null);
  assert.equal(parseKeywordWeeklyTableName(''), null);
  assert.equal(parseKeywordWeeklyTableName(undefined), null);
});

test('a malformed collection date is rejected rather than interpolated', () => {
  for (const bad of ['2026-9-19', '20260919', '', null, undefined, '2026-13-40']) {
    assert.throws(() => keywordWeeklyTableName(bad), /collectionDate must be a valid YYYY-MM-DD/u);
  }
});

// ── 周期 → 本期 / 上一期 ───────────────────────────────────────────────────

test('the 2026-09-21 trigger resolves to the same tables production actually used', () => {
  // 这条是**回归锚**：09-19 期真实跑出来的就是这两张表（`关键词分析 V1（2026-09-19）`与
  // 它对比的 `关键词分析 V1（2026-09-12）`）。推导一旦漂移一天，这条会红。
  const window = resolveKeywordWeeklyWindow(week('2026-09-13', '2026-09-19'));
  assert.equal(window.collectionDate, '2026-09-19');
  assert.equal(window.tableName, '关键词分析 V1（2026-09-19）');
  assert.equal(window.newTableName, '关键词分析 V1（2026-09-19）');
  assert.equal(window.previousCollectionDate, '2026-09-12');
  assert.equal(window.previousTableName, '关键词分析 V1（2026-09-12）');
});

test('previous period crosses a month boundary correctly', () => {
  // 2026-10-03 是周六，减去 7 天落在 09-26 —— 靠 setDate 而不是字符串拼接，跨月才不会错。
  const window = resolveKeywordWeeklyWindow(week('2026-09-27', '2026-10-03'));
  assert.equal(window.collectionDate, '2026-10-03');
  assert.equal(window.previousCollectionDate, '2026-09-26');
});

test('previous period crosses a year boundary correctly', () => {
  const window = resolveKeywordWeeklyWindow(week('2026-12-27', '2027-01-02'));
  assert.equal(window.collectionDate, '2027-01-02');
  assert.equal(window.previousCollectionDate, '2026-12-26');
});

test('a period that does not end on Saturday stops instead of guessing a date', () => {
  // 周日~周六的口径下 endDate 必然是周六。若不是，说明周期口径被改了（例如换成 ISO 周），
  // 这时必须当场停 —— 悄悄把采集日算错一天，事后没人能从表名上看出来。
  assert.throws(
    () => resolveKeywordWeeklyWindow(week('2026-09-14', '2026-09-20')),
    /period\.endDate must fall on Saturday/u,
  );
});

test('only PREVIOUS_WEEK_SUN_SAT is accepted', () => {
  for (const kind of ['TODAY', 'YESTERDAY', 'CURRENT_WEEK_SUN_SAT', 'PREVIOUS_MONTH', '', undefined]) {
    assert.throws(() => resolveKeywordWeeklyWindow({ kind, endDate: '2026-09-19' }), /period\.kind=PREVIOUS_WEEK_SUN_SAT/u);
  }
});

test('a malformed period end date is rejected', () => {
  assert.throws(() => resolveKeywordWeeklyWindow(week('2026-09-13', '2026/09/19')), /period\.endDate must be a valid/u);
  assert.throws(() => resolveKeywordWeeklyWindow({ kind: 'PREVIOUS_WEEK_SUN_SAT' }), /period\.endDate must be a valid/u);
});

// ── 批次号 / 克隆前历史行数 ────────────────────────────────────────────────

const history = (batches) => batches.map((batch) => ({ fields: { 批次编号: batch } }));

test('batch number is the next unused one, not the row count', () => {
  assert.equal(deriveBatchNumber(history([1, 2, 2, 7, 7, 7])), 8);
  assert.equal(deriveBatchNumber(history([3])), 4);
});

test('an empty history table stops instead of silently becoming batch 1', () => {
  // 「空表 ⇒ 批次 1」会把整批历史当成不存在，然后照常写进去 —— 这是静默的数据事故。
  for (const empty of [[], undefined, null]) {
    assert.throws(() => deriveBatchNumber(empty), /history table is empty/u);
  }
});

test('a history row without a valid batch number stops the derivation', () => {
  assert.throws(() => deriveBatchNumber([{ fields: { 批次编号: 1 } }, { fields: {} }]), /invalid 批次编号/u);
  assert.throws(() => deriveBatchNumber([{ fields: { 批次编号: '第三批' } }]), /invalid 批次编号/u);
  assert.throws(() => deriveBatchNumber([{ fields: { 批次编号: 0 } }]), /invalid 批次编号/u);
});

test('expected history before is every row that is not part of this batch', () => {
  // 与 `update-weekly-base.mjs:697`（previousHistory.length）同口径：
  // 首次跑 = 整表行数；重跑同一批 = 自动扣掉本批次，于是同一条命令可以安全重跑。
  const records = history([1, 1, 2, 2, 2]);
  assert.equal(deriveExpectedHistoryBefore(records, 3), 5);
  assert.equal(deriveExpectedHistoryBefore(records, 2), 2);
  assert.equal(deriveExpectedHistoryBefore([], 1), 0);
});

test('an invalid batch number is rejected before it can filter anything', () => {
  for (const bad of [0, -1, 1.5, null, undefined, '三', NaN]) {
    assert.throws(() => deriveExpectedHistoryBefore(history([1]), bad), /batchNumber must be a positive integer/u);
  }
});

test('a numeric string batch number is accepted, because that is what a CLI hands over', () => {
  // 不用「必须是 number 类型」做判据：`update-weekly-base.mjs:93` 自己也是先 `Number(...)` 再校验，
  // 而命令行参数永远是字符串。把 '3' 判成非法会让「从 CLI 传进来的合法值」被拒 —— 那是假红。
  assert.equal(deriveExpectedHistoryBefore(history([1, 1, 2]), '3'), 3);
});

// ── 表按名解析 ─────────────────────────────────────────────────────────────

test('tables resolve by exact name and must be unique', () => {
  const tables = [
    { table_id: 'tblA', name: '关键词分析 V1（2026-09-12）' },
    { table_id: 'tblB', name: KEYWORD_HISTORY_TABLE_NAME },
  ];
  assert.equal(resolveTableByName(tables, '关键词分析 V1（2026-09-12）').table_id, 'tblA');
  assert.throws(() => resolveTableByName(tables, '关键词分析 V1（2026-09-19）'), /Table not found/u);
  assert.throws(
    () => resolveTableByName([...tables, { table_id: 'tblC', name: '关键词分析 V1（2026-09-12）' }], '关键词分析 V1（2026-09-12）'),
    /Multiple tables named/u,
  );
});

// ── 组装：假 reader 走完整条解析 ───────────────────────────────────────────

function fakeReader({ tables, historyRecords }) {
  const calls = { listTables: 0, listRecords: [] };
  return {
    calls,
    async listTables() {
      calls.listTables += 1;
      return tables;
    },
    async listRecords(tableId) {
      calls.listRecords.push(tableId);
      return historyRecords;
    },
  };
}

const STABLE = Object.freeze({
  baseUrl: 'https://example.feishu.cn/base/HdBhbttB5aScbasWJAMc0gGXnpe',
  appToken: 'HdBhbttB5aScbasWJAMc0gGXnpe',
  cateId: '50012345',
  category: '普通浴缸',
  // 只给**名字**：id 由解析器按名查出来（id 与名字两边各写一份 = 两边各对一半的错）。
  protectedTableName: '关键词分析 V1（2026-09-05）',
});

test('the resolver produces exactly the collectInput shape the weekly adapter requires', () => {
  const reader = fakeReader({
    tables: [
      { table_id: 'tblPrev', name: '关键词分析 V1（2026-09-12）' },
      { table_id: 'tblCurrent', name: '关键词分析 V1（2026-09-19）' },
      { table_id: 'tblHistory', name: KEYWORD_HISTORY_TABLE_NAME },
      { table_id: 'tblLibrary', name: KEYWORD_LIBRARY_TABLE_NAME },
      { table_id: 'tblProtected', name: '关键词分析 V1（2026-09-05）' },
    ],
    historyRecords: history([1, 2, 2, 2]),
  });
  const resolve = createKeywordWeeklyCollectInputResolver({ reader, stable: STABLE });
  return resolve({ period: week('2026-09-13', '2026-09-19') }).then((input) => {
    assert.deepEqual(input, {
      collectionDate: '2026-09-19',
      batchNumber: 3,
      expectedHistoryBefore: 4,
      cateId: '50012345',
      category: '普通浴缸',
      target: {
        baseUrl: STABLE.baseUrl,
        sourceTableId: 'tblPrev',
        sourceTableName: '关键词分析 V1（2026-09-12）',
        newTableName: '关键词分析 V1（2026-09-19）',
        historyTableId: 'tblHistory',
        libraryTableId: 'tblLibrary',
        protectedTableId: 'tblProtected',
        protectedTableName: '关键词分析 V1（2026-09-05）',
      },
    });
    // 源表必须是**上一期**，不是本期：抓到这条就没人会把克隆源写成当期表。
    assert.notEqual(input.target.sourceTableId, 'tblCurrent');
    assert.deepEqual(reader.calls.listRecords, ['tblHistory'], '只读历史表一次，且不碰别的表');
    assert.equal(reader.calls.listTables, 1);
  });
});

test('the resolver refuses to run without the stable values it cannot derive', async () => {
  const reader = fakeReader({ tables: [], historyRecords: [] });
  for (const missing of ['baseUrl', 'appToken', 'cateId', 'category', 'protectedTableName']) {
    const stable = { ...STABLE };
    delete stable[missing];
    const resolve = createKeywordWeeklyCollectInputResolver({ reader, stable });
    // 解析器是 async 的 ⇒ 同步 throw 表现为 rejected promise，要用 rejects 而不是 throws。
    await assert.rejects(
      resolve({ period: week('2026-09-13', '2026-09-19') }),
      new RegExp(`missing stable config: .*${missing}`, 'u'),
      `${missing} 缺了必须抛`,
    );
  }
});

test('the protected table is resolved by name too, and a missing one stops the run', async () => {
  // 受保护表的 id 不该由人另写一份：`update-weekly-base.mjs` 会拿 id 与名字各断言一次，
  // 两边各对一半的错（id 是 A、名字是 B）在那种写法下是能通过的。
  const tables = [
    { table_id: 'tblPrev', name: '关键词分析 V1（2026-09-12）' },
    { table_id: 'tblHistory', name: KEYWORD_HISTORY_TABLE_NAME },
    { table_id: 'tblLibrary', name: KEYWORD_LIBRARY_TABLE_NAME },
  ];
  const resolve = createKeywordWeeklyCollectInputResolver({
    reader: fakeReader({ tables, historyRecords: history([1]) }),
    stable: STABLE,
  });
  await assert.rejects(
    resolve({ period: week('2026-09-13', '2026-09-19') }),
    /Table not found in the keyword base: 关键词分析 V1（2026-09-05）/u,
  );
});

test('a resolver without a usable reader is rejected at construction, not at run time', () => {
  assert.throws(() => createKeywordWeeklyCollectInputResolver(), /requires a reader/u);
  assert.throws(() => createKeywordWeeklyCollectInputResolver({ reader: {} }), /requires a reader/u);
  assert.throws(() => createKeywordWeeklyCollectInputResolver({ reader: { listTables() {} } }), /requires a reader/u);
});

test('the resolver id is looked up strictly: unknown ids stop, absent ids mean "no resolver"', () => {
  assert.equal(collectInputResolverFor(null), null);
  assert.equal(collectInputResolverFor('  '), null);
  assert.equal(typeof collectInputResolverFor(COLLECT_INPUT_RESOLVER_ID, { reader: fakeReader({ tables: [], historyRecords: [] }), stable: STABLE }), 'function');
  // 静默返回 null 的后果是「排期照跑、collectInput 是空的」，而人以为自己声明了解析器。
  assert.throws(() => collectInputResolverFor('keyword-weekly/v2'), /Unknown collectInputResolver/u);
});

// ── 源码级守卫 ─────────────────────────────────────────────────────────────

test('the module reads only: it never spawns a process or writes to Feishu itself', () => {
  // 本模块的契约是「只算入参，不碰任何写入」。它自己不发请求（reader 是注入的），
  // 一旦有人图方便在这里 spawn 一个写入脚本、或内联一个 fetch，这条守卫要红。
  // 弱于行为检查（一次合法重构就要跟着改），只钉「本模块没有 I/O 出口」这一个事实。
  const source = readFileSync(MODULE_PATH, 'utf8');
  for (const forbidden of ['node:child_process', 'spawnSync', 'execSync', "method: 'POST'", 'method: "POST"']) {
    assert.equal(source.includes(forbidden), false, `weekly-round-input.mjs must not contain ${forbidden}`);
  }
});

test('the table-name format is pinned verbatim, full-width parentheses included', () => {
  // 半角括号构成的 `关键词分析 V1(2026-09-19)` 在库里**不存在**，而它看起来完全正常。
  // 行为用例（round-trip）已经能抓到改坏，这条守卫再把「源码里不许出现半角形态」钉死一次，
  // 好在 diff 里一眼看见是谁改的。弱于行为检查，只钉字面量这一件事。
  const source = readFileSync(MODULE_PATH, 'utf8');
  assert.equal(source.includes('关键词分析 V1('), false, '表名模板必须用全角括号');
  assert.equal(keywordWeeklyTableName('2026-09-19'), '关键词分析 V1（2026-09-19）');
});
