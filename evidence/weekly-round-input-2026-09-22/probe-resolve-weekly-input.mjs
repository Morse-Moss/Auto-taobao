// 只读探针（原件在 tmp/，被 .gitignore 忽略 ⇒ 这里留一份可复核的副本，路径已按本目录深度改写）：
// 用**真** reader 跑一次完整解析。
//
// 目的有两件，都是「只读」能回答的：
//   ① 证明 `weekly-round-input.mjs` 的按名解析在本机真能跑通（表名对得上、历史表读得到）；
//   ② 回答「下周一它会给排期算什么入参」—— 这个值人看不到，只能靠跑一次。
//
// 副作用边界：只发 GET（listTables / listRecords），不启浏览器、不写飞书、不跑任何 CLI。
// `protectedTableId` / `cateId` 是排期配置要显式给出的项，本探针不猜它们，只把「解析到哪一步」摆出来。
import { createKeywordWeeklyReader } from '../../runtime/weekly-round-input-reader.mjs';
import {
  COLLECT_INPUT_RESOLVER_ID,
  KEYWORD_HISTORY_TABLE_NAME,
  KEYWORD_LIBRARY_TABLE_NAME,
  deriveBatchNumber,
  deriveExpectedHistoryBefore,
  resolveKeywordWeeklyWindow,
  resolveTableByName,
} from '../../runtime/weekly-round-input.mjs';

const PERIOD = { kind: 'PREVIOUS_WEEK_SUN_SAT', startDate: '2026-09-13', endDate: '2026-09-19' };

const out = { resolverId: COLLECT_INPUT_RESOLVER_ID, period: PERIOD };

const { profile, appToken, baseUrl, reader } = createKeywordWeeklyReader();
out.profile = profile;
out.appToken = appToken;
out.baseUrl = baseUrl;

const window = resolveKeywordWeeklyWindow(PERIOD);
out.window = window;

const tables = await reader.listTables();
out.tableCount = tables.length;
out.tableNames = tables.map((t) => t.name);

// 源表：上一期那张（下周一跑的时候，它会去克隆这一张）
try {
  const source = resolveTableByName(tables, window.previousTableName);
  out.resolved = { ...(out.resolved ?? {}), sourceTableId: source.table_id, sourceTableName: source.name };
} catch (error) {
  out.resolved = { ...(out.resolved ?? {}), sourceTableError: error.message };
}

try {
  const current = resolveTableByName(tables, window.tableName);
  out.resolved = { ...(out.resolved ?? {}), currentTableId: current.table_id };
  out.currentTableExists = true;
} catch (error) {
  out.resolved = { ...(out.resolved ?? {}), currentTableError: error.message };
  out.currentTableExists = false;
}

for (const [key, name] of [['history', KEYWORD_HISTORY_TABLE_NAME], ['library', KEYWORD_LIBRARY_TABLE_NAME]]) {
  try {
    const table = resolveTableByName(tables, name);
    out.resolved = { ...(out.resolved ?? {}), [`${key}TableId`]: table.table_id };
  } catch (error) {
    out.resolved = { ...(out.resolved ?? {}), [`${key}TableError`]: error.message };
  }
}

// 历史表 → 批次号与克隆前历史行数
try {
  const historyTable = resolveTableByName(tables, KEYWORD_HISTORY_TABLE_NAME);
  const records = await reader.listRecords(historyTable.table_id);
  const batchNumber = deriveBatchNumber(records);
  out.history = {
    rows: records.length,
    batchNumber,
    expectedHistoryBefore: deriveExpectedHistoryBefore(records, batchNumber),
  };
  const batches = {};
  for (const record of records) {
    const value = String(record?.fields?.['批次编号'] ?? '').trim();
    batches[value] = (batches[value] ?? 0) + 1;
  }
  out.history.batchHistogram = Object.fromEntries(Object.entries(batches).sort((a, b) => Number(a[0]) - Number(b[0])));
} catch (error) {
  out.historyError = error.message;
}

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
