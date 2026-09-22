// 周更排期的「每周入参」解析：把排期算出来的**周期**，翻译成一次运行真正要的**入参**。
//
// ── 为什么需要这个模块（2026-09-22）────────────────────────────────────────
// `runtime/round-schedule.json` 顶部自己写着一条约束：「周表 id 不该写进这份文件：周表每周新建，
// id 天然会过期；按名字在运行时解析」。把这句话当**约束**读，它意味着「把周更挂进排期」这件事
// 包含一个**运行时入参解析层** —— 源周表 id、批次号、克隆前历史行数每周都会变，静态配置里
// 根本写不出正确的值。缺了它，排期只有两种结局：
//   ① 填了 URL 也 fail-closed（能力在 `prepare` 阶段抛 TARGET_INCOMPLETE）；
//   ② 靠人每周去改 JSON —— 而改漏了**不报错**，只会写错周期。静默写错比跑不起来贵得多。
// 这条缺口在 `docs/ops/LESSONS-2026-09-14_15.md:255` 被记为「排期的真正缺口＝每周入参解析」，
// 但一直没被填上。
//
// ── 本模块做什么、不做什么 ─────────────────────────────────────────────────
// 做：给定一个周期（`round-schedule.mjs` 的 `resolvePeriod` 产物），算出这条链要的每个入参。
// 不做：任何写入。读飞书一律只发 GET；而且 reader 是**注入**的（离线用例注入假 reader，
//       不需要凭据、不碰网络），本模块自己不认识凭据文件在哪。
//
// ── 刻意不做的一件事（写清理由，免得下一个人以为漏了）──────────────────────
// `protectedTableName` **不由本模块推导**。它的语义是 `update-weekly-base.mjs:788-789`
// 那句断言里的 "Protected previous-week analysis table" —— 即**上一有效周**的分析表，
// 而「有效」的判据住在 `sync-decision-history.mjs` 里，本模块没有那份判据。
// **推不出来就不猜**（宁可让配置显式给出，也不生成一个看起来对的表名）：
// 一个错的「上一有效周」会让那条断言拿错的表去比对，结果是「保护了一张不该保护的表」，
// 而它不会报错 —— 这正是本项目最怕的形态。
//
// ── 与既有实现的关系（不要在这里重新实现一遍）───────────────────────────────
// `batchNumber` / `expectedHistoryBefore` 的口径来自能力自己的落地器：
//   `skills/sycm-to-feishu-base/scripts/update-weekly-base.mjs:99`  `previousBatchNumber = batchNumber - 1`
//   `…:365` `countHistoryBatches(records)` —— 历史表按 `批次编号` 分组计数
//   `…:697` `previousHistory.length !== options.expectedHistoryBefore` ⇒ 要的是「非本批次的行数」
// 本模块只是把这三条**读法的前提**提前到运行前算出来，不改变它们的语义；权威校验仍在那边。

/** 本期/历史/编号库的表名。历史与编号库是**稳定表**，所以名字可以直接当常量。 */
export const KEYWORD_WEEKLY_TABLE_PREFIX = '关键词分析 V1';
export const KEYWORD_HISTORY_TABLE_NAME = '关键词历史总表 V1';
export const KEYWORD_LIBRARY_TABLE_NAME = '关键词编号库 V1';

/** 历史表里承载「第几批」与「采集日」的列名（读法口径，不另抄一份词表）。 */
export const HISTORY_BATCH_FIELD = '批次编号';
export const HISTORY_COLLECTION_DATE_FIELD = '采集日期';

/** 本模块认识的周期口径：只有这一种。其它周期（TODAY / PREVIOUS_MONTH…）不属于周更。 */
export const SUPPORTED_PERIOD_KIND = 'PREVIOUS_WEEK_SUN_SAT';

/** 「每周入参解析器」的注册表键。排期条目用 `collectInputResolver` 引用它。 */
export const COLLECT_INPUT_RESOLVER_ID = 'keyword-weekly/v1';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
// 表名里带日期的那一版。注意 `关键词分析 V1（修正版）` **不会**被这个正则命中 —— 这是刻意的：
// 库里确实同时存在「修正版」与各期日期表，用 startsWith 匹配会先撞上修正版（探针实测踩过）。
const TABLE_NAME_PATTERN = /^关键词分析 V1（(\d{4}-\d{2}-\d{2})）$/u;

function asText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function requireDate(value, label) {
  const text = asText(value);
  if (!DATE_PATTERN.test(text) || !Number.isFinite(Date.parse(`${text}T00:00:00+08:00`))) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date, got: ${JSON.stringify(value ?? null)}`);
  }
  return text;
}

/** 本机日期减法（与 `round-schedule.mjs` 同口径：一律本地时区）。 */
function shiftDate(dateText, days) {
  const at = new Date(`${dateText}T00:00:00`);
  at.setDate(at.getDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** 周口径是「周日~周六」，所以周期结束日必然落在周六。 */
function isSaturday(dateText) {
  return new Date(`${dateText}T00:00:00`).getDay() === 6;
}

/**
 * 表名 ⇄ 采集日。为什么不复用 `runtime/weekly-table-target.mjs`：
 * 那个模块管的是**竞品链**的周表命名（`竞品周_起_止`），与关键词链的
 * `关键词分析 V1（采集日）` 不是一个格式，`WEEKLY_NAME_PATTERN` 也不覆盖后者
 *（这一条在 `LESSONS-2026-09-14_15.md:255` 里已被点名为已知偏差）。两套格式各自成对，
 * 合并成一个正则只会让两边都变脆。
 */
export function keywordWeeklyTableName(collectionDate) {
  return `${KEYWORD_WEEKLY_TABLE_PREFIX}（${requireDate(collectionDate, 'collectionDate')}）`;
}

/** 解析表名里的采集日；不是「带日期的关键词分析表」就返回 null（不抛：调用方用它做筛选）。 */
export function parseKeywordWeeklyTableName(name) {
  const match = TABLE_NAME_PATTERN.exec(asText(name));
  return match ? { collectionDate: match[1] } : null;
}

/**
 * 周期 → 这一期与上一期的关键日期/表名。**纯函数，不碰网络。**
 *
 * 为什么 `collectionDate` 取 `period.endDate`：关键词表的命名日期是**采集日**，而采集就发生在
 * 周期最后一天（周日~周六的周六）——实测吻合：2026-09-21（周一）触发的上一周是 09-13~09-19，
 * 当期表正是 `关键词分析 V1（2026-09-19）`，上一期是 `关键词分析 V1（2026-09-12）`。
 * 但这是**推导**，不是惯例，所以下面把「结束日必须是周六」写成显式校验：周期口径一旦被改成
 * 非周日~周六（例如改成 ISO 周），这里要**当场停**，而不是悄悄把表名算错一天。
 */
export function resolveKeywordWeeklyWindow(period) {
  const kind = asText(period?.kind).toUpperCase();
  if (kind !== SUPPORTED_PERIOD_KIND) {
    throw new Error(`weekly keyword input requires period.kind=${SUPPORTED_PERIOD_KIND}, got: ${kind || '<missing>'}`);
  }
  const collectionDate = requireDate(period?.endDate, 'period.endDate');
  if (!isSaturday(collectionDate)) {
    throw new Error(`period.endDate must fall on Saturday for the Sunday~Saturday week, got: ${collectionDate}`);
  }
  const previousCollectionDate = shiftDate(collectionDate, -7);
  return {
    collectionDate,
    tableName: keywordWeeklyTableName(collectionDate),
    previousCollectionDate,
    previousTableName: keywordWeeklyTableName(previousCollectionDate),
    newTableName: keywordWeeklyTableName(collectionDate),
  };
}

function fieldOf(record, name) {
  return asText(record?.fields?.[name]);
}

/**
 * 批次号 = 历史表现有最大批次 + 1。**纯函数**（吃记录，不自己读）。
 *
 * 为什么从历史表推而不是写进配置：批次号是「第几批」的单调计数，写进配置就等于又多一份
 * 需要人每周改的真相源；而它本来就能从历史表的 `批次编号` 列读出来。
 * 空历史表**不是**「批次 1」：那说明读错了表或读空了，必须停（`deriveBatchNumber` 抛），
 * 因为按「空表 + 批次 1」继续跑会把整批历史当成不存在。
 */
export function deriveBatchNumber(historyRecords) {
  const records = Array.isArray(historyRecords) ? historyRecords : [];
  if (records.length === 0) {
    throw new Error('history table is empty — refusing to derive a batch number (read the wrong table?)');
  }
  let max = 0;
  for (const record of records) {
    const raw = fieldOf(record, HISTORY_BATCH_FIELD);
    const batch = Number(raw);
    if (!raw || !Number.isInteger(batch) || batch < 1) {
      throw new Error(`history contains an invalid ${HISTORY_BATCH_FIELD}: ${raw || '<blank>'}`);
    }
    if (batch > max) max = batch;
  }
  return max + 1;
}

/**
 * 克隆前历史行数 = 历史表里**不属于本批次**的行数（与 `update-weekly-base.mjs:697` 同口径）。
 * 首次跑时本批次还不存在，于是它等于整表行数；重跑同一批时自动扣掉本批次那几百行。
 *
 * `batchNumber` 用 `Number()` 归一后再判，**不是**要求必须是 number 类型：
 * 命令行参数永远是字符串，而 `update-weekly-base.mjs:93` 自己也是先 `Number(...)` 再校验。
 * 把 `'3'` 判成非法会让一个从 CLI 传进来的合法值被拒（假红）。
 */
export function deriveExpectedHistoryBefore(historyRecords, batchNumber) {
  const records = Array.isArray(historyRecords) ? historyRecords : [];
  const target = Number(batchNumber);
  if (!Number.isInteger(target) || target < 1) {
    throw new Error(`batchNumber must be a positive integer, got: ${JSON.stringify(batchNumber ?? null)}`);
  }
  return records.filter((record) => Number(fieldOf(record, HISTORY_BATCH_FIELD)) !== target).length;
}

/** 表按名解析，**必须唯一命中**。多张同名表 = 我们不知道该写哪张，停。 */
export function resolveTableByName(tables, name) {
  const wanted = asText(name);
  const matches = (Array.isArray(tables) ? tables : []).filter((table) => asText(table?.name) === wanted);
  if (matches.length > 1) throw new Error(`Multiple tables named ${wanted} in the keyword base`);
  if (matches.length === 0) throw new Error(`Table not found in the keyword base: ${wanted}`);
  return matches[0];
}

/**
 * 组装真正的解析器。`reader` 只需两个只读方法：`listTables()` 与 `listRecords(tableId)`。
 * （形状与 `run-keyword-weekly-local-analysis.mjs` 的 `FeishuReader` 一致，直接复用它，
 *   不在这里再写一个飞书客户端 —— 「同一个事实两处实现」是本项目吃过亏的老坑。）
 *
 * `stable` 是**显式给出**的那几项：它们是稳定值或本模块推不出来的值（见文件头关于
 * `protectedTableName` 的说明）。缺一个就抛，不回落默认值 —— 回落会让「配置少填了」
 * 表现成「跑的是另一个目标」。
 */
export function createKeywordWeeklyCollectInputResolver({ reader, stable = {} } = {}) {
  if (!reader || typeof reader.listTables !== 'function' || typeof reader.listRecords !== 'function') {
    throw new Error('createKeywordWeeklyCollectInputResolver requires a reader with listTables() and listRecords(tableId)');
  }
  return async function resolveKeywordWeeklyCollectInput({ period } = {}) {
    const window = resolveKeywordWeeklyWindow(period);

    const missing = ['baseUrl', 'appToken', 'cateId', 'category', 'protectedTableName']
      .filter((key) => !asText(stable[key]));
    if (missing.length > 0) {
      throw new Error(`keyword weekly resolver is missing stable config: ${missing.join(', ')}`);
    }

    const tables = await reader.listTables();
    // 源表 = **上一期**那张（克隆它的字段与公式结构，不带记录）。
    const sourceTable = resolveTableByName(tables, window.previousTableName);
    const historyTable = resolveTableByName(tables, KEYWORD_HISTORY_TABLE_NAME);
    const libraryTable = resolveTableByName(tables, KEYWORD_LIBRARY_TABLE_NAME);
    // 受保护表也**按名解析**：`update-weekly-base.mjs` 会拿 id 与名字两边各断言一次
    //（`assertTable(tables, id, name)`），让 id 从名字推出来才不会有「id 是 A、名字是 B」
    // 这种两边各对一半的错。名字本身仍由配置给 —— 见文件头关于「上一有效周」的说明。
    const protectedTable = resolveTableByName(tables, stable.protectedTableName);

    const historyRecords = await reader.listRecords(historyTable.table_id);
    const batchNumber = deriveBatchNumber(historyRecords);

    return {
      collectionDate: window.collectionDate,
      batchNumber,
      expectedHistoryBefore: deriveExpectedHistoryBefore(historyRecords, batchNumber),
      cateId: stable.cateId,
      category: stable.category,
      target: {
        baseUrl: stable.baseUrl,
        sourceTableId: sourceTable.table_id,
        sourceTableName: sourceTable.name,
        newTableName: window.newTableName,
        historyTableId: historyTable.table_id,
        libraryTableId: libraryTable.table_id,
        protectedTableId: protectedTable.table_id,
        protectedTableName: protectedTable.name,
      },
    };
  };
}

/**
 * 只校验 id、不构造任何东西。**在校验通过之前不许碰凭据文件、不许发网络请求** ——
 * 一个写错的 id 应当表现为「配置写错了」，而不是「一次莫名其妙的凭据读取失败」。
 */
export function assertKnownCollectInputResolverId(id) {
  const wanted = asText(id);
  if (!wanted) return null;
  if (wanted !== COLLECT_INPUT_RESOLVER_ID) {
    throw new Error(`Unknown collectInputResolver: ${wanted} (known: ${COLLECT_INPUT_RESOLVER_ID})`);
  }
  return wanted;
}

/**
 * 排期条目 → 解析器实例。**不认识这个 id 就抛**，不静默返回空对象 ——
 * 静默返回空的后果是「排期照跑，但 collectInput 是空的」，也就是又回到了 fail-closed，
 * 而人看到的是「我明明声明了解析器」。
 */
export function collectInputResolverFor(id, options = {}) {
  if (!assertKnownCollectInputResolverId(id)) return null;
  return createKeywordWeeklyCollectInputResolver(options);
}
