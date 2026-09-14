export const XWS_HEADERS = [
  '序号', '商品图片', '商品标题', '商品链接', '价格', '月收货人数',
  '类目', '同款数', '平台', '占位类型', '店铺名', '店铺旺旺',
  '店铺类型', '地址', '收藏人数', '卖点',
];

const COUNT_FIELDS = new Set(['月收货人数', '付款人数']);

// ── 确定性拒绝码 → 运行时失败分类 ────────────────────────────────────────────
// 为什么这份词表在 import-core：同一类拒绝（「调用方没把参数/目标准备好」「源文件不符合
// 16 字段合同」）会在采集段与发布段分别抛出，而运行时的默认分类器
// （policy.classifyExternalFailure）只认 HTTP 状态码与**英文**关键词——本能力自有的守卫
// 消息两者都没有，于是「调用方漏了参数」会被归成 BUG（actionForFailure → STOP_AND_ALERT，
// 理由「疑似代码 bug，停线」），把运维引向排查代码而不是补参数。
// 结论：分类必须跟着 code 走，而不是跟着「这条是哪个模块抛的」走。
// 词表完整性由 tests/import-failures.test.mjs 锁住：运行时路径上的每个 throw 都必须登记。
export const FAILURE_CLASS_BY_CODE = Object.freeze({
  // 源/证据不符合合同：重跑同一份输入没有意义，要换输入。
  SOURCE_HEADERS: 'EVIDENCE_INVALID',
  SOURCE_EMPTY: 'EVIDENCE_INVALID',
  SOURCE_IMAGE_AMBIGUOUS: 'EVIDENCE_INVALID',
  SOURCE_VALUE_INVALID: 'EVIDENCE_INVALID',
  // 采集能力本身跑不动（连抽取出 Excel 的那一步都起不来）。
  EXTRACTION_FAILED: 'CAPABILITY_DEGRADED',
  // 调用方/目标没准备好：修正参数后本可以重跑，**不是**代码缺陷。
  BASE_URL_INVALID: 'POLICY_DENIED',
  INPUT_REQUIRED: 'POLICY_DENIED',
  INPUT_NOT_FOUND: 'POLICY_DENIED',
  CLIENT_REQUIRED: 'POLICY_DENIED',
  TARGET_NOT_EMPTY: 'POLICY_DENIED',
  TARGET_IMAGE_FIELD: 'POLICY_DENIED',
  TARGET_FIELDS_MISSING: 'POLICY_DENIED',
  PERIOD_REQUIRED: 'POLICY_DENIED',
  PERIOD_INVALID: 'POLICY_DENIED',
  // 写出去之后外部行为与预期不符：刻意保持 BUG（停线交人工）——
  // 既不冒充「确定未发生」去重试，也不冒充 UNKNOWN 去对账。理由见
  // docs/ops/TENANT-MIGRATION-MAP.md §6「刻意没有改的两条」。
  POST_WRITE_COUNT_MISMATCH: 'BUG',
  POST_WRITE_VERIFY_MISMATCH: 'BUG',
  // 进程内调用顺序被破坏（例如没跑 start() 就取工件）：这是真 bug，保持 BUG。
  STAGE_ORDER: 'BUG',
});

// 唯一构造入口。词表漏登记时**立刻抛**（开发期错误），
// 不让它悄悄退回默认分类器、把「调用方漏参」说成「疑似代码 bug」。
export function fatalError(code, message, details = {}) {
  const failureClass = FAILURE_CLASS_BY_CODE[code];
  if (!failureClass) throw new Error(`unregistered failure code: ${code}`);
  const error = new Error(message);
  error.code = code;
  error.failureClass = failureClass;
  if (Object.keys(details).length > 0) error.details = details;
  return error;
}

export function validateSourceHeaders(headers) {
  const supported = Array.isArray(headers) && headers.length === XWS_HEADERS.length
    && COUNT_FIELDS.has(headers[5])
    && headers.every((name, index) => index === 5 || name === XWS_HEADERS[index]);
  if (!supported) {
    throw fatalError('SOURCE_HEADERS', 'Unexpected XLSX headers; expected the 16-field Xiaowangshen contract');
  }
  return headers[5];
}

export function parseBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    // 原来是 `new URL('')` 抛出的 TypeError：既没有状态码也没有关键词，同样会被归成 BUG。
    throw fatalError('BASE_URL_INVALID', `Expected an absolute Feishu /base/ URL, got: ${JSON.stringify(value)}`);
  }
  const match = /^\/base\/([^/]+)/.exec(url.pathname);
  const tableId = url.searchParams.get('table');
  if (!match || !tableId) {
    throw fatalError('BASE_URL_INVALID', 'Expected a Feishu /base/ URL with a table query parameter');
  }
  return { appToken: match[1], tableId };
}

function numericValue(value, fieldName, { allowPlus = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().replaceAll(',', '');
  const pattern = allowPlus ? /^(\d+(?:\.\d+)?)\+?$/ : /^(\d+(?:\.\d+)?)$/;
  const match = pattern.exec(text);
  if (!match) {
    throw fatalError('SOURCE_VALUE_INVALID', `${fieldName} is not a supported numeric value: ${value}`, { fieldName, value });
  }
  return Number(match[1]);
}

export function buildRecordFields(row, imageToken, headers = XWS_HEADERS, fieldTypes = null) {
  const countField = validateSourceHeaders(headers);
  const fields = Object.fromEntries(headers
    .filter((name) => name !== '商品图片')
    .map((name) => [name, row[name] ?? '']));
  fields.序号 = String(row.序号 ?? '');
  fields.价格 = numericValue(row.价格, '价格');
  if (countField === '付款人数') {
    fields[countField] = String(row[countField] ?? '');
  } else {
    const numeric = numericValue(row[countField], countField, { allowPlus: true });
    const targetType = fieldTypes?.get(countField);
    // Text (type 1) targets reject numbers with TextFieldConvFail (1254060),
    // so stringify when the target field is a text field.
    fields[countField] = targetType === 1 ? (numeric === null ? null : String(numeric)) : numeric;
  }
  fields.商品图片 = imageToken ? [{ file_token: imageToken }] : [];
  return fields;
}

export function validateTarget({ recordCount, fields, headers = XWS_HEADERS }) {
  validateSourceHeaders(headers);
  if (recordCount !== 0) {
    throw fatalError('TARGET_NOT_EMPTY', `Target table must be empty; found ${recordCount} records`, { recordCount });
  }
  const byName = new Map(fields.map((field) => [field.fieldName, field]));
  const imageField = byName.get('商品图片');
  if (!imageField || imageField.type !== 17) {
    throw fatalError('TARGET_IMAGE_FIELD', '商品图片 must be an attachment field with type 17', { type: imageField?.type ?? null });
  }
  const missing = headers.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw fatalError('TARGET_FIELDS_MISSING', `Target table is missing fields: ${missing.join(', ')}`, { missing });
  }
}
