// 内容热度（AI 段）写入的核心契约：计划、变异白名单、回读校验。
//
// 为什么单独成模块、而且只认一个字段：
// 这一列是目前整张关键词周表里**唯一没有执行者**的分析字段。它的历史口径有两处坑，
// 都在这里被显式堵住：
//   1. 老口径要求输出 `AI预测-高` 这类**带前缀**的值（见 runtime/keyword-field-contract-20260809.md:27），
//      但写回层 `legacy-feishu-writeback.mjs:5-10` 在写飞书前会把前缀剥掉，
//      所以**落库值从来不带前缀**（7 张批次表全量实测，见
//      evidence/keyword-ai-local-2026-09-20/08-content-heat-value-history.txt）。
//      ⇒ 这里把带前缀的值**当非法值直接拒掉**：混进来会让同一列出现两代口径。
//   2. 这一列与 6 个公式字段有依赖（`优先级`、`近2周X达标次数`、`是否重点词`、`对应产品方向` 等），
//      写完它们会跟着变。所以回读校验必须把 type=20 的字段整体列为「允许变化」，
//      而不是逐个去猜哪些会变。

import crypto from 'node:crypto';

export const CONTENT_HEAT_FIELD = '内容热度';

/**
 * 允许写入的值域。
 *
 * 只有这四个 —— 与 `runtime/weekly-local-analysis.mjs` 的现行提示词一致。
 * `待核验` 是现行提示词相对老口径新增的第 4 个值（历史 4 批 2101 行里一次没出现过），
 * 保留它是 2026-09-20 用户的选择：宁可留一格兜底，也不逼模型在信息不足时硬猜。
 */
export const CONTENT_HEAT_VALUES = Object.freeze(['低', '中', '高', '待核验']);

export const CONTENT_HEAT_ARTIFACT_STATUS = 'CONTENT_HEAT_ANALYSIS_READY';

/** 老口径的前缀。落库值不允许带它，带就是错代。 */
const LEGACY_PREFIX = 'AI预测-';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/**
 * 只允许对**确认过的那个 base 的那张表的 records/batch_update** 下手，且每条 fields 只含 `内容热度`。
 *
 * 这是「变异白名单」：写入器唯一被允许做的副作用。任何越界都抛错而不是跳过 ——
 * 静默跳过等于把「本来要拦住的越权」变成一条看不出异常的记录。
 */
export function assertContentHeatMutation({ method, path, body }, scope) {
  if (method === 'GET') return;
  const expected = `/bitable/v1/apps/${scope.appToken}/tables/${scope.tableId}/records/batch_update`;
  const records = body?.records;
  if (method === 'POST' && path === expected && Array.isArray(records) &&
      records.length > 0 && records.length <= 500 &&
      records.every((record) => record.record_id &&
        record.fields && Object.keys(record.fields).length === 1 &&
        Object.prototype.hasOwnProperty.call(record.fields, CONTENT_HEAT_FIELD))) {
    return;
  }
  throw new Error(`Blocked unauthorized content heat mutation: ${method} ${path}`);
}

/**
 * 字段合同：`内容热度` 必须存在、必须可写、必须能装下生成的值。
 *
 * `内容热度` 在现表里是 **type=1 纯文本**（两张批次表实测都是），不是单选；
 * 但这里仍然按「可能的单选」去校验选项，因为同一字段在不同批次表里类型可能不同，
 * 而「写了不在选项里的值」在单选上会被 API 拒（或更坏：被静默丢）。宁可多验一步。
 */
export function validateContentHeatContract(fields, generated) {
  const matches = fields.filter((field) => field.field_name === CONTENT_HEAT_FIELD);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${CONTENT_HEAT_FIELD} field; received ${matches.length}`);
  }
  const field = matches[0];
  if (![1, 3].includes(field.type)) {
    throw new Error(`${CONTENT_HEAT_FIELD} expected type 1 (text) or 3 (single select); received ${field.type}`);
  }
  const accepted = new Set(CONTENT_HEAT_VALUES);
  const offenders = generated.filter((value) => !accepted.has(value));
  if (offenders.length) {
    const legacy = offenders.filter((value) => String(value).startsWith(LEGACY_PREFIX));
    const detail = legacy.length
      ? `其中 ${legacy.length} 个带老口径前缀 ${LEGACY_PREFIX}（该前缀是链路中间态，落库值不带它；混入会让同一列出现两代口径）`
      : '';
    throw new Error(`${CONTENT_HEAT_FIELD} has illegal values: ${[...new Set(offenders)].join('、')}${detail ? ` —— ${detail}` : ''}`);
  }
  if (field.type === 3) {
    const available = new Set((field.property?.options ?? []).map((option) => option.name));
    const missing = [...new Set(generated)].filter((value) => !available.has(value));
    if (missing.length) throw new Error(`${CONTENT_HEAT_FIELD} missing option: ${missing.join('、')}`);
  }
}

/**
 * 由「飞书记录 + 分析产物」构造写入计划。
 *
 * 默认**只填空白格**（`preservedExisting` 记录被跳过的行数）；`replaceFields` 里显式给出
 * `内容热度` 才允许覆盖已有值。这是与规则段一致的安全默认。
 *
 * 产物与表的对应关系是 fail-closed 的：
 *   - 产物声明的 tableId 必须与目标表一致（防止把上一周的分析写进这一周的表）；
 *   - 产物里不允许有重复 record_id（重复即无法判断哪条为准）；
 *   - 产物里不允许出现表里不存在的 record_id；
 *   - 默认要求**每一行都有判定**；缺行直接抛错并列出行数。只有显式
 *     `allowPartial` 才接受子集（用于先写一小批试口径），且调用方必须在收据里看得到这是子集。
 */
export function buildContentHeatPlan(records, artifact, options = {}) {
  const replaceFields = options.replaceFields ?? [];
  const allowPartial = options.allowPartial === true;
  const values = artifact?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Content heat artifact has no values');
  }
  const byId = new Map();
  for (const item of values) {
    const recordId = item?.record_id;
    if (!recordId) throw new Error('Content heat artifact has an entry without record_id');
    if (byId.has(recordId)) throw new Error(`Content heat artifact contains duplicate record_id: ${recordId}`);
    byId.set(recordId, item);
  }
  const known = new Set(records.map((record) => record.record_id));
  const unknown = [...byId.keys()].filter((recordId) => !known.has(recordId));
  if (unknown.length) {
    throw new Error(`Content heat artifact references ${unknown.length} record(s) absent from the table: ${unknown.slice(0, 5).join('、')}`);
  }

  const updates = [];
  let preservedExisting = 0;
  for (const record of records) {
    const item = byId.get(record.record_id);
    const existing = record.fields?.[CONTENT_HEAT_FIELD];
    const blank = existing == null || existing === '' || (Array.isArray(existing) && existing.length === 0);
    if (!item) {
      if (!blank) { preservedExisting += 1; continue; }
      if (allowPartial) continue;
      throw new Error(`Content heat artifact is missing a judgement for ${records.length - byId.size} record(s) (first gap: ${record.record_id})`);
    }
    if (!blank && !replaceFields.includes(CONTENT_HEAT_FIELD)) { preservedExisting += 1; continue; }
    const value = item[CONTENT_HEAT_FIELD];
    if (value == null || value === '') throw new Error(`Content heat artifact has an empty judgement for ${record.record_id}`);
    updates.push({ record_id: record.record_id, fields: { [CONTENT_HEAT_FIELD]: value } });
  }
  return {
    updates,
    preservedExisting,
    judgedRecords: values.length,
    coveredAllRecords: updates.length + preservedExisting === records.length,
  };
}

/**
 * 写后回读校验：证「该写的写了」，并同时证「不该动的没动」。
 *
 * `derivedFields` 必须是**全部公式字段**：`内容热度` 是 `优先级` / `近2周X达标次数` /
 * `是否重点词` / `对应产品方向` 等公式的输入，写完它们本来就该变。
 * 把它们一起列进「允许变化」，换来的是**其余每一个普通字段都被逐字节比对**。
 */
export function verifyContentHeatApply({ before, after, updates, derivedFields = [] }) {
  if (before.length !== after.length) throw new Error('Content heat apply changed the table record count');
  const afterById = new Map(after.map((record) => [record.record_id, record]));
  const updatesById = new Map(updates.map((record) => [record.record_id, record.fields]));
  const ignored = new Set([CONTENT_HEAT_FIELD, ...derivedFields]);
  let fieldsWritten = 0;
  for (const prior of before) {
    const next = afterById.get(prior.record_id);
    if (!next) throw new Error(`Content heat apply lost record ${prior.record_id}`);
    const expected = updatesById.get(prior.record_id);
    if (expected) {
      const actual = next.fields?.[CONTENT_HEAT_FIELD];
      if (!same(actual, expected[CONTENT_HEAT_FIELD])) {
        throw new Error(`Content heat apply did not persist ${prior.record_id}: expected ${JSON.stringify(expected[CONTENT_HEAT_FIELD])}, read back ${JSON.stringify(actual)}`);
      }
      fieldsWritten += 1;
    }
    const priorOther = Object.fromEntries(Object.entries(prior.fields ?? {}).filter(([key]) => !ignored.has(key)));
    const nextOther = Object.fromEntries(Object.entries(next.fields ?? {}).filter(([key]) => !ignored.has(key)));
    if (!same(priorOther, nextOther)) {
      const changed = [...new Set([...Object.keys(priorOther), ...Object.keys(nextOther)])]
        .filter((key) => !same(priorOther[key], nextOther[key]));
      throw new Error(`Content heat apply modified unrelated field(s) on ${prior.record_id}: ${changed.join('、')}`);
    }
  }
  return {
    recordsVerified: before.length,
    fieldsWritten,
    unjudgedRecords: before.length - updatesById.size,
  };
}

/**
 * 直方图。**按「出现次数」计数，不是按「出现过几种值」计数。**
 *
 * 为什么单独成函数并留判据：2026-09-20 第一次 dry-run 时，收据里的 `planned` 分布
 * 写成了 `{"低":1,"中":1,"高":1}` —— 因为调用方先去重再统计，数出来的是「有几种值」。
 * 30 条的判定实际是 低4/中23/高3，收据却长得像每档各一条。
 * **这与 `[object Object]` 是同一类错误：收据里有数、但那个数在说假话。**
 */
export function histogram(values, normalize) {
  const counts = new Map();
  for (const value of values) {
    const key = normalize(value) || '(空)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1]));
}

/** 表里 `内容热度` 的现状分布。空值记成 `(空)` 而不是把那一行丢掉。 */
export function contentHeatDistribution(records, readbackText) {
  return histogram(records.map((record) => record.fields?.[CONTENT_HEAT_FIELD]), readbackText);
}

/**
 * 产物里 `内容热度` 的分布。
 *
 * 注意调用方**必须传原始数组**，不能传去重后的集合 —— 去重会让这个数变成「值域大小」，
 * 而收据的读者会把它读成「各档多少条」。
 */
export function contentHeatPlannedDistribution(artifact, readbackText) {
  return histogram((artifact?.values ?? []).map((item) => item?.[CONTENT_HEAT_FIELD]), readbackText);
}

export function contentHeatDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
