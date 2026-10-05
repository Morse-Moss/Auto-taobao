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
    // 数据源用**文本标记**表示「无此项数据」。2026-09-18 实测：09-17 的里可林家居 / 网林家居旗舰店 /
    // 盖文全卫定制 / 科塔全卫定制 四家，`UV价值` 与 `无线端UV价值` 两列都是 "NULL"（当天无成交⇒算不出）。
    //
    // 数字字段存不下这个标记，两个替代都不保真：
    //   · 写 0 —— 把「当天无成交」变成「价值为 0」这种**假事实**，还会污染同比/环比；
    //   · 写空 —— 丢掉「这是数据源的显式标记」这层信息。
    // 这里选**留空**。理由不是「留空更保真」，而是飞书这两列**本来就是数字类型**
    // ——「保真」在这个目标上根本做不到（原实现直接抛错，后果是整条链推不动，
    // 2026-09-18 四家店同时撞上）。而 0 是会骗人的那个选项。
    //
    // 留空的代价是「无数据」与「漏采集」在页面上分不出来，所以**必须留痕**：
    // 打一行 warn（run-daily-report 的调用方会把 stdout 落进台账），并让测试盯住这条路的形态。
    //
    // 同一张表的 `PC端UV价值` / `全站推广花费` 是**文本**字段，那两个能把 "NULL" 原样存进去
    // （实测底单里就是字符串 "NULL"）——「同一个数据源标记、在两列里落地形态不同」是既成事实，
    // 所以不要试图把这条判据统一到两种字段上。
    if (raw === '-' || raw.toUpperCase() === 'NULL') {
      console.warn(`[留空] ${field.name}：数据源给的是文本标记 ${raw}，数字字段存不下 ⇒ 该格留空（不是 0）`);
      return OMIT;
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

// 推广两段（关键词 / 人群）在飞书可见字段里的切段位置。**顺序与 SCENES 的声明顺序一致**，
// 改顺序必须同时改这里，否则两段会写到对方的列上（写错列不会报错，只会静默错数据）。
const PROMOTION_SCENE_BLOCKS = Object.freeze([
  Object.freeze({ scene: SCENES.keyword, from: 121, to: 190 }),
  Object.freeze({ scene: SCENES.audience, from: 190, to: 259 }),
]);

/**
 * 把店铺段 + 推广各场景段拼成一条飞书写入 payload。
 *
 * ⚠️ 2026-10-05 改：**不再要求「恰好两条推广行」**。
 *
 * 原来这里写死「恰好 2 条、且必须同时有 371 与 372」，于是**一家店本身没开某个场景**时
 * （实测网林家居没开关键词推广 ⇒ 报表里只有 372 一条）整条链停在 push，
 * 报 `expected exactly two unique promotion rows, got 1` —— 而那份数据本身是**完整的**：
 * 它只是没有这个场景的投放，不是没采到。业务方已确认「这家店铺没有开这个推广」是常态。
 *
 * 现在的口径：**有几个场景写几个，缺的那几个场景的列全部留空**。
 *
 * 为什么「留空」在下游是自洽的：`buildPasteTsv` 对**不在 payload 里**的字段填空串，
 * `verifyRecordFields` 只核 payload 里**有**的字段 ⇒ 缺场景=那一整段不写、也不会被读回核对。
 * 代价是「这家店没开推广」与「采集漏了这段」在飞书页面上长得一模一样，
 * 所以缺场景时必须打一行 warn 留痕（`[留空]`）。
 *
 * 仍然 fail-closed 的三种：
 *   ① 一个场景行都没有 ⇒ 这是采集链路整段失效，不是「这家店没开推广」；
 *   ② 出现了不认识的场景 id ⇒ 报表定义变了（可能平台加了新场景），别硬塞进这两段里；
 *   ③ 同一个 id 出现两条 ⇒ 分不清该用哪一条。
 */
export function buildCombinedFields(source, visibleFields, reportDate) {
  if (visibleFields.length !== 265) throw new Error(`expected 265 visible Feishu fields, got ${visibleFields.length}`);
  const known = new Map(Object.values(SCENES).map((scene) => [scene.id, scene]));
  const rowsById = new Map();
  for (const row of source.promotion.rows) {
    const id = String(row?.[1] ?? '');
    if (!known.has(id)) {
      throw new Error(`promotion row has unknown scene id ${JSON.stringify(id)}`
        + `（只认 ${[...known.keys()].join(' / ')}）—— 多出来的 id 说明平台侧的报表定义变了，别硬塞`);
    }
    if (rowsById.has(id)) throw new Error(`promotion rows contain duplicate scene id ${id}`);
    rowsById.set(id, row);
  }
  if (rowsById.size === 0) {
    throw new Error('promotion rows are empty —— 一个推广场景都没有，这是没采到数据（不是「这家店没开推广」）');
  }

  const fields = { ...buildShopFields(source.shop, visibleFields.slice(2, 121), reportDate) };
  const missing = [];
  for (const { scene, from, to } of PROMOTION_SCENE_BLOCKS) {
    const row = rowsById.get(scene.id);
    if (!row) { missing.push(`${scene.id}/${scene.name}`); continue; }
    Object.assign(fields, buildPromotionFields(source.promotion.headers, row,
      visibleFields.slice(from, to), scene, reportDate));
  }
  if (missing.length) {
    // 必须留痕：留空与「没采到」在飞书页面上长得一样，这一行是两者唯一的区分依据。
    console.warn(`[留空] 这份推广报表里没有 ${missing.join('、')} 这一行 ⇒ 对应的 ${missing.length} 段字段整段留空`
      + '（是数据源没给这个场景，不是采集漏了）');
  }
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
