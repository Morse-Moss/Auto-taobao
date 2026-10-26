const OMIT = Symbol('omit');

export const SCENES = Object.freeze({
  keyword: Object.freeze({ id: '371', name: '关键词推广', prefix: '关键词推广' }),
  audience: Object.freeze({ id: '372', name: '人群推广', prefix: '人群推广' }),
});

// 推广 CSV 尾部这 6 列是「补贴」指标。
//
// 2026-10-26 之前它们**整段被丢掉**（常量名就叫 DROPPED_PROMOTION_HEADERS，只有前 4 个）——
// 当时的依据是「底单里根本没有补贴字段」（实测 265 个字段里含「补贴」二字的一个都没有）。
// 用户 2026-10-26 拍板「73 列全导入」⇒ 底单补上这 6 个字段，本文件把它们**真的写进去**。
//
// ⚠️ 为什么补贴这 6 列必须**按名字**映射，而 1..67 仍然按位置：
// 飞书新建字段只能**追加到表尾**，插不进 121..258 那两段里。位置映射依赖「列在段内、位置稳定」，
// 补贴这些列不在段内（在表尾），只能按名字找。这不是风格选择，是平台约束。
export const PROMOTION_SUBSIDY_HEADERS = Object.freeze([
  '平台补贴金额', '补贴引导成交金额', '发券补贴商品个数', '补贴引导成交人数',
  '补贴引导成交新客数', '补贴引导成交笔数',
]);

// 推广 CSV 的两种**真实**宽度，**按店不同**（2026-10-26 实测：同一天 3 份 71 列、保拉天猫 73 列；
// 差别是有没有开通补贴那套指标）。所以契约不许钉成单值：
//   · 钉死 71 ⇒ 保拉天猫永远进不来（就是 2026-10-26 push 失败的那一句）；
//   · 钉死 73 ⇒ 另外 12 家全部进不来（它们当天就是 71 列）。
export const PROMOTION_SOURCE_WIDTHS = Object.freeze([71, 73]);

// 底单「两段推广」在可见字段里的起点（按**名字**钉，不按数量钉）。
// 索引是 121 / 190，见下面 promotionSegmentStarts 的说明。
const PROMOTION_SEGMENT_STARTS = Object.freeze([121, 190]);

/**
 * 把「补贴」这 6 列在底单里对应的字段找出来，并按场景分成两半。
 *
 * 返回 `{ keyword: Map<header, field>, audience: Map<header, field> }`。
 *
 * 分半判据＝**字段名带不带 ` (n)` 副本后缀**：底单里两段同名字段，飞书给后建的那段自动加 ` (1)`
 * （实测人群段的 69 个字段全部带 ` (1)`，如 `场景ID (1)`）。不能用「位置在哪一段」分 ——
 * 补贴字段是追加到表尾的，位置根本不在段里。
 *
 * 只认这 6 个名字，别的字段一概不碰：`canonicalPromotionTargetName` 会剥掉前缀与后缀，
 * 所以 `平台补贴金额` 与 `平台补贴金额 (1)` 都会归到同一个 header 下，各进各的桶。
 */
export function promotionSubsidyFields(visibleFields = []) {
  const keyword = new Map();
  const audience = new Map();
  for (const field of visibleFields) {
    const name = String(field?.name ?? '');
    const canonical = canonicalPromotionTargetName(name, '');
    if (!PROMOTION_SUBSIDY_HEADERS.includes(canonical)) continue;
    const bucket = / \(\d+\)$/u.test(name) ? audience : keyword;
    if (!bucket.has(canonical)) bucket.set(canonical, field);
  }
  return { keyword, audience };
}

/**
 * 两段推广在底单可见字段里的起点对不对（**按名字钉边界**）。
 *
 * 为什么不再钉「恰好 265 个字段」：2026-10-26 为了「73 列全导入」往底单追加了 12 个补贴字段
 * （265 → 277），按数量钉的那条判据当天会把整条链挡在门口 —— 它挡的不是错误，是**新加的字段**。
 * 而边界按名字钉能扛住「追加字段」，同时仍然钉得住「顺序被改」（顺序错＝数据写进错列，静默错数据，
 * 那才是真要拦的）。
 */
export function promotionSegmentStarts(visibleFields = []) {
  const nameAt = (index) => String(visibleFields[index]?.name ?? '');
  const canonicalAt = (index) => canonicalPromotionTargetName(nameAt(index), '');
  const MIN = PROMOTION_SEGMENT_STARTS[1] + 69; // 2 + 119 + 69 + 69
  if (visibleFields.length < MIN) {
    return { ok: false, message: `底单可见字段只有 ${visibleFields.length} 个，至少要 ${MIN} 个（2 + 119 + 69 + 69）` };
  }
  for (const start of PROMOTION_SEGMENT_STARTS) {
    // 段首那个日期字段**带场景前缀**（`关键词推广日期` / `人群推广日期`），所以不能拿
    // canonicalPromotionTargetName(name, '') 去比 —— 那个函数剥的是「副本后缀」，
    // 传空前缀时它一个字符都不剥（2026-10-26 第一版就是这么红的）。
    // 真正稳的判据是「名字以『日期』结尾」＋「字段类型是日期（5）」——这两条一起几乎不可能碰巧成立。
    const dateField = visibleFields[start];
    const dateOk = nameAt(start).endsWith('日期') && dateField?.type === 5;
    const sceneIdOk = canonicalAt(start + 1) === '场景ID';
    const sceneNameOk = canonicalAt(start + 2) === '场景名字';
    if (!dateOk || !sceneIdOk || !sceneNameOk) {
      return {
        ok: false,
        message: `推广段起点（索引 ${start}）不对：读到 ${[nameAt(start), nameAt(start + 1), nameAt(start + 2)]
          .map((name) => name || '（空）').join(' / ')}（type=${dateField?.type ?? '空'}），`
          + '期望「…日期（日期类型） / 场景ID / 场景名字」—— 底单字段顺序被改过，写下去会串列',
      };
    }
    const second = [canonicalAt(start + 3), canonicalAt(start + 4)].join('\u0000');
    if (visibleFields[start + 3] && visibleFields[start + 4]
      && second !== ['原二级场景ID', '原二级场景名字'].join('\u0000')) {
      return { ok: false, message: `推广段（索引 ${start}）的第 4/5 个字段不是「原二级场景ID / 原二级场景名字」` };
    }
  }
  return { ok: true };
}

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

/**
 * 把一行推广 CSV 映射成 payload。
 *
 * @param subsidyFields 该场景那半边的「补贴」字段表（`promotionSubsidyFields().keyword/audience`）。
 *   给了就写补贴列；没给而 CSV 里又确实有补贴列 ⇒ **抛错**（不许静默丢列）。
 */
export function buildPromotionFields(headers, row, targetFields, scene, reportDate, subsidyFields = null) {
  const width = headers.length;
  if (width !== row.length || !PROMOTION_SOURCE_WIDTHS.includes(width) || targetFields.length !== 69) {
    throw new Error('promotion block must contain 71 or 73 source columns and 69 target columns'
      + `（读到 headers=${headers.length} row=${row.length} targets=${targetFields.length}）`);
  }
  // 前 67 列是固定明细（1..3 身份 + 4..67 指标），尾部才是补贴。
  // 宽度决定尾部有几列：71 ⇒ 4 列，73 ⇒ 6 列。名字必须与真实表头**逐字**相同，
  // 顺序也不能换 —— 换了就是「列的含义变了」，那必须人工确认，不能靠猜。
  const subsidyCount = width - 67;
  if (headers.slice(67).join('\u0000') !== PROMOTION_SUBSIDY_HEADERS.slice(0, subsidyCount).join('\u0000')) {
    throw new Error(`unexpected promotion subsidy columns: ${headers.slice(67).join(' / ')}`
      + `（期望前 ${subsidyCount} 个是 ${PROMOTION_SUBSIDY_HEADERS.slice(0, subsidyCount).join(' / ')}）`);
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
  // 补贴列：**按名字**找字段（见 PROMOTION_SUBSIDY_HEADERS 的说明：飞书新字段只能追加到表尾）。
  for (let index = 0; index < subsidyCount; index += 1) {
    const header = PROMOTION_SUBSIDY_HEADERS[index];
    const field = subsidyFields?.get?.(header) ?? null;
    if (!field) {
      throw new Error(`推广 CSV 有「${header}」这一列，但底单里没有对应字段（${scene.name} 段缺一个）`
        + ' —— 要么先给底单加这个字段，要么明确决定丢掉这一列；不许静默丢');
    }
    assign(fields, field, row[67 + index], reportDate);
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
 *   ① 一个场景行都没有 ⇒ 默认仍拦（这是采集链路整段失效的常态形态）；
 *   ② 出现了不认识的场景 id ⇒ 报表定义变了（可能平台加了新场景），别硬塞进这两段里；
 *   ③ 同一个 id 出现两条 ⇒ 分不清该用哪一条。
 *
 * ⚠️ 2026-10-20 给 ① 开了一个**显式**的窄口（业务口径，用户拍板）：
 * 「平台上确实没有推广数据，就按实际留空，不要填 0」。
 * 触发条件必须同时满足两条，缺一不可：
 *   · 调用方显式传 `allowEmptyPromotion: true`（CLI 上是 `--allow-empty-promotion`）；
 *   · 本次推广 CSV 是 0 行（`source.promotion.rows.length === 0`）。
 * 为什么不设成默认：0 行有两种成因 ——「这家店当天真的没投」与「平台数据还没出/还没静止」，
 * 在 CSV 层面同形。默认放开就等于把「不知道」写成「当天没有」，而且同日早跑写进去的低值
 * **当天无法重推**（只能先删那一天）。所以要人手先确认平台侧（报表页花费汇总是否全 0.00），
 * 再显式放行这一次。
 */
export function buildCombinedFields(source, visibleFields, reportDate, options = {}) {
  const boundary = promotionSegmentStarts(visibleFields);
  if (!boundary.ok) throw new Error(boundary.message);
  const subsidyFields = promotionSubsidyFields(visibleFields);
  const allowEmptyPromotion = options.allowEmptyPromotion === true;
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
    if (!allowEmptyPromotion) {
      throw new Error('promotion rows are empty —— 一个推广场景都没有，这是没采到数据（不是「这家店没开推广」）'
        + '；若平台侧确认当日确实无推广数据，加 --allow-empty-promotion 显式放行（推广两段留空，不写 0）');
    }
    // 留痕是硬要求：留空与「漏采集」在飞书页面上长得一模一样，这一行是唯一区分依据。
    console.warn('[留空] 这份推广报表 0 行（平台当日无推广数据）⇒ 关键词推广/人群推广两段字段整段留空'
      + '（人手显式放行：--allow-empty-promotion；不是采集漏，也没有写 0）');
  }

  const fields = { ...buildShopFields(source.shop, visibleFields.slice(2, 121), reportDate) };
  const missing = [];
  for (const { scene, from, to } of PROMOTION_SCENE_BLOCKS) {
    const row = rowsById.get(scene.id);
    if (!row) { missing.push(`${scene.id}/${scene.name}`); continue; }
    Object.assign(fields, buildPromotionFields(source.promotion.headers, row,
      visibleFields.slice(from, to), scene, reportDate,
      scene.id === SCENES.keyword.id ? subsidyFields.keyword : subsidyFields.audience));
  }
  if (missing.length && rowsById.size > 0) {
    // 必须留痕：留空与「没采到」在飞书页面上长得一样，这一行是两者唯一的区分依据。
    // 0 行（刚刚那条 warn 已经说过「两段都空」）不再重复喊「缺 371 和 372」——
    // 同一件事两条日志会让「这份报表是空的」和「这份报表少了两个场景」看起来像两回事。
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
  // 推广侧多一个「空」态（2026-10-20 加，业务口径：平台上确实没有就不写值）。
  //
  // 三种状态必须分开，不能都叫不匹配：
  //   empty      —— CSV 只有表头、0 条数据行。平台当日没有推广数据（实测网林家居 2026-10-19：
  //                 报表页「暂无数据 共 0 项数据」、账户总花费 0.00，两次独立生成的任务导出同一份空 CSV）。
  //   mismatched —— 有数据行，但日期不等于目标日（或跨了多天）⇒ 筛选没生效/下错了文件，必须继续拦。
  // 少了这个区分，`rowCount:0` 与 `筛选失效` 在证据里长得一样，只能靠人肉回翻。
  selfCheck.promotion.empty = promotionRowDates.length === 0;
  selfCheck.promotion.state = selfCheck.promotion.empty ? 'empty'
    : (promotionDates.length === 1 && promotionDates[0] === reportDate ? 'matched' : 'mismatched');
  // 店铺侧：目标日必须恰好一行，且被取用的那一行就是它。
  selfCheck.shop.matches = selfCheck.shop.targetRowCount === 1 && matchedShopRow === reportDate;
  // 推广侧：ZIP 里只有一天的数据，且就是目标日（多天说明筛选没生效）。
  selfCheck.promotion.matches = selfCheck.promotion.state === 'matched';
  selfCheck.allMatchDate = selfCheck.shop.matches && selfCheck.promotion.matches;
  return selfCheck;
}
