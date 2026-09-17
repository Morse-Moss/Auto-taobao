const OMIT = Symbol('omit');

export const SCENES = Object.freeze({
  keyword: Object.freeze({ id: '371', name: '关键词推广', prefix: '关键词推广' }),
  audience: Object.freeze({ id: '372', name: '人群推广', prefix: '人群推广' }),
});

const DROPPED_PROMOTION_HEADERS = Object.freeze([
  '平台补贴金额', '补贴引导成交金额', '发券补贴商品个数', '补贴引导成交人数',
]);

export function reportDateEpoch(reportDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(reportDate)) throw new Error(`invalid report date: ${reportDate}`);
  const epoch = new Date(`${reportDate}T00:00:00+08:00`).getTime();
  if (!Number.isFinite(epoch)) throw new Error(`invalid report date: ${reportDate}`);
  return epoch;
}

export function canonicalPromotionTargetName(name, prefix) {
  const withoutCopySuffix = String(name).replace(/ \(\d+\)$/u, '');
  return withoutCopySuffix.startsWith(prefix) ? withoutCopySuffix.slice(prefix.length) : withoutCopySuffix;
}

export function toFeishuValue(value, field, reportDate) {
  if (value === null || value === undefined || String(value).trim() === '') return OMIT;
  if (field.type === 5) {
    if (String(value).trim() !== reportDate) {
      throw new Error(`date mismatch for ${field.name}: expected ${reportDate}, got ${value}`);
    }
    return reportDateEpoch(reportDate);
  }
  if (field.type === 2) {
    const raw = String(value).trim();
    if (raw === '-' || raw.toUpperCase() === 'NULL') {
      throw new Error(`cannot preserve text marker ${raw} in numeric field ${field.name}`);
    }
    const number = Number(raw.replaceAll(',', ''));
    if (!Number.isFinite(number)) throw new Error(`invalid number for ${field.name}: ${value}`);
    return number;
  }
  if (field.type === 1) return String(value);
  throw new Error(`unsupported writable field type ${field.type} for ${field.name}`);
}

function assign(fields, field, value, reportDate) {
  const converted = toFeishuValue(value, field, reportDate);
  if (converted !== OMIT) fields[field.name] = converted;
}

export function buildShopFields(source, targetFields, reportDate) {
  if (source.headers.length !== 119 || source.values.length !== 119 || targetFields.length !== 119) {
    throw new Error('shop block must contain exactly 119 source and target columns');
  }
  const mismatch = source.headers.findIndex((name, index) => name !== targetFields[index].name);
  if (mismatch >= 0) {
    throw new Error(`shop header mismatch at ${mismatch + 1}: ${source.headers[mismatch]} != ${targetFields[mismatch].name}`);
  }
  const fields = {};
  targetFields.forEach((field, index) => assign(fields, field, source.values[index], reportDate));
  return fields;
}

export function buildPromotionFields(headers, row, targetFields, scene, reportDate) {
  if (headers.length !== 71 || row.length !== 71 || targetFields.length !== 69) {
    throw new Error('promotion block must contain 71 source columns and 69 target columns');
  }
  if (headers.slice(67).join('\u0000') !== DROPPED_PROMOTION_HEADERS.join('\u0000')) {
    throw new Error('unexpected promotion subsidy columns');
  }
  if (row[0] !== reportDate || row[1] !== scene.id || row[2] !== scene.name) {
    throw new Error(`unexpected ${scene.name} identity/date: ${row.slice(0, 3).join(' / ')}`);
  }
  const expectedFirst = [`${scene.prefix}日期`, '场景ID', '场景名字', '原二级场景ID', '原二级场景名字'];
  for (let index = 0; index < expectedFirst.length; index += 1) {
    const actual = canonicalPromotionTargetName(targetFields[index].name, scene.prefix);
    const expected = canonicalPromotionTargetName(expectedFirst[index], scene.prefix);
    if (actual !== expected) throw new Error(`${scene.name} target header mismatch at ${index + 1}: ${targetFields[index].name}`);
  }
  for (let sourceIndex = 3; sourceIndex <= 66; sourceIndex += 1) {
    const targetIndex = sourceIndex + 2;
    const actual = canonicalPromotionTargetName(targetFields[targetIndex].name, scene.prefix);
    if (actual !== headers[sourceIndex]) {
      throw new Error(`${scene.name} header mismatch at source ${sourceIndex + 1}: ${headers[sourceIndex]} != ${targetFields[targetIndex].name}`);
    }
  }

  const fields = {};
  assign(fields, targetFields[0], row[0], reportDate);
  assign(fields, targetFields[1], row[1], reportDate);
  assign(fields, targetFields[2], row[2], reportDate);
  for (let sourceIndex = 3; sourceIndex <= 66; sourceIndex += 1) {
    assign(fields, targetFields[sourceIndex + 2], row[sourceIndex], reportDate);
  }
  return fields;
}

export function buildCombinedFields(source, visibleFields, reportDate) {
  if (visibleFields.length !== 265) throw new Error(`expected 265 visible Feishu fields, got ${visibleFields.length}`);
  const rowsById = new Map(source.promotion.rows.map(row => [row[1], row]));
  if (rowsById.size !== 2 || source.promotion.rows.length !== 2) {
    throw new Error(`expected exactly two unique promotion rows, got ${source.promotion.rows.length}`);
  }
  const keyword = rowsById.get(SCENES.keyword.id);
  const audience = rowsById.get(SCENES.audience.id);
  if (!keyword || !audience) throw new Error('promotion rows must contain scene ids 371 and 372');

  const fields = {
    ...buildShopFields(source.shop, visibleFields.slice(2, 121), reportDate),
    ...buildPromotionFields(source.promotion.headers, keyword, visibleFields.slice(121, 190), SCENES.keyword, reportDate),
    ...buildPromotionFields(source.promotion.headers, audience, visibleFields.slice(190, 259), SCENES.audience, reportDate),
  };
  const forbidden = ['空列不用管', '店铺', '字段 1', '字段 2', '父记录', '字段 3', '字段 4', '字段 5'];
  for (const name of forbidden) {
    if (Object.hasOwn(fields, name)) throw new Error(`forbidden field entered payload: ${name}`);
  }
  return fields;
}

export function valuesEqual(expected, actual, field) {
  if (field.type === 2 || field.type === 5) return Number(expected) === Number(actual);
  return String(expected) === String(actual);
}

// 「这份数据是不是目标日那一天」的自证。
//
// 为什么要有它（2026-09-17 复盘发现的缺口）：日期本来就被校验两次 —— Python 侧要求店铺表
// 目标日**恰好 1 行**，daily-report-core 的字段映射又会对日期字段做等值断言。缺的不是校验，
// 是**证据**：收据里只有一个文件哈希（`shopSha256` / `promotionSha256`），而哈希只能证明
// 「是这个文件」，证明不了「这个文件是这一天的」；文件名里的哈希更是随报表定义走、不随内容变
// （09-16 与 09-17 两次下载同名同哈希），拿它判新旧会误判。
//
// 所以这里从**已解析的原始值**独立算一遍（不依赖字段映射那条路径），把结论写进收据：
// 观察到哪几天、目标日出现几次、是否全部一致。调用方据此 fail-closed。
export function summarizeSourceDates(source, reportDate) {
  const shop = source?.shop ?? {};
  const promotion = source?.promotion ?? {};
  const normalize = (value) => String(value ?? '').trim();

  // 计数必须用**没去重**的那一列：去重之后「目标日出现两次」（该报错的数据）会变成一次，
  // 于是这道自证会放过它 —— 去重只用于「观察到哪几天」这份列表。
  const shopDateList = (shop.dates ?? []).map(normalize).filter(Boolean);
  const shopDates = [...new Set(shopDateList)];
  const promotionRowDates = (promotion.rows ?? []).map((row) => normalize(row[0]));
  const promotionDates = [...new Set(promotionRowDates.filter(Boolean))];
  const matchedShopRow = shop.values ? normalize(shop.values[0]) : null;

  const selfCheck = {
    expectedDate: reportDate,
    shop: {
      column: shop.headers?.[0] ?? null,
      matchedRowDate: matchedShopRow,
      workbookRows: shop.workbookRows ?? null,
      uniqueDates: shopDates.length,
      firstRowDate: shopDates[0] ?? null,
      lastRowDate: shopDates[shopDates.length - 1] ?? null,
      targetRowCount: shopDateList.filter((value) => value === reportDate).length,
    },
    promotion: {
      column: promotion.headers?.[0] ?? null,
      csvName: promotion.csvName ?? null,
      observedDates: promotionDates,
      rowCount: promotionRowDates.length,
      targetRowCount: promotionRowDates.filter((value) => value === reportDate).length,
    },
  };
  // 店铺侧：目标日必须恰好一行，且被取用的那一行就是它。
  selfCheck.shop.matches = selfCheck.shop.targetRowCount === 1 && matchedShopRow === reportDate;
  // 推广侧：ZIP 里只有一天的数据，且就是目标日（多天说明筛选没生效）。
  selfCheck.promotion.matches = promotionDates.length === 1 && promotionDates[0] === reportDate;
  selfCheck.allMatchDate = selfCheck.shop.matches && selfCheck.promotion.matches;
  return selfCheck;
}
