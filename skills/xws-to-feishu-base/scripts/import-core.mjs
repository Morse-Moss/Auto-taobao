export const XWS_HEADERS = [
  '序号', '商品图片', '商品标题', '商品链接', '价格', '月收货人数',
  '类目', '同款数', '平台', '占位类型', '店铺名', '店铺旺旺',
  '店铺类型', '地址', '收藏人数', '卖点',
];

const COUNT_FIELDS = new Set(['月收货人数', '付款人数']);

export function validateSourceHeaders(headers) {
  const supported = Array.isArray(headers) && headers.length === XWS_HEADERS.length
    && COUNT_FIELDS.has(headers[5])
    && headers.every((name, index) => index === 5 || name === XWS_HEADERS[index]);
  if (!supported) {
    throw new Error(`Unexpected XLSX headers; expected the 16-field Xiaowangshen contract`);
  }
  return headers[5];
}

export function parseBaseUrl(value) {
  const url = new URL(value);
  const match = /^\/base\/([^/]+)/.exec(url.pathname);
  const tableId = url.searchParams.get('table');
  if (!match || !tableId) {
    throw new Error('Expected a Feishu /base/ URL with a table query parameter');
  }
  return { appToken: match[1], tableId };
}

function numericValue(value, fieldName, { allowPlus = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().replaceAll(',', '');
  const pattern = allowPlus ? /^(\d+(?:\.\d+)?)\+?$/ : /^(\d+(?:\.\d+)?)$/;
  const match = pattern.exec(text);
  if (!match) throw new Error(`${fieldName} is not a supported numeric value: ${value}`);
  return Number(match[1]);
}

export function buildRecordFields(row, imageToken, headers = XWS_HEADERS) {
  const countField = validateSourceHeaders(headers);
  const fields = Object.fromEntries(headers
    .filter((name) => name !== '商品图片')
    .map((name) => [name, row[name] ?? '']));
  fields.序号 = String(row.序号 ?? '');
  fields.价格 = numericValue(row.价格, '价格');
  fields[countField] = countField === '付款人数'
    ? String(row[countField] ?? '')
    : numericValue(row[countField], countField, { allowPlus: true });
  fields.商品图片 = [{ file_token: imageToken }];
  return fields;
}

export function validateTarget({ recordCount, fields, headers = XWS_HEADERS }) {
  validateSourceHeaders(headers);
  if (recordCount !== 0) {
    throw new Error(`Target table must be empty; found ${recordCount} records`);
  }
  const byName = new Map(fields.map((field) => [field.fieldName, field]));
  const imageField = byName.get('商品图片');
  if (!imageField || imageField.type !== 17) {
    throw new Error('商品图片 must be an attachment field with type 17');
  }
  const missing = headers.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(`Target table is missing fields: ${missing.join(', ')}`);
  }
}
