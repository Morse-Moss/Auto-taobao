/**
 * 「这一天的源表里根本没有日期行」的**确定性标记**（2026-10-06 加）。
 *
 * 为什么必须是一个标记，而不是一句措辞：链的分类器（`run-multi-shop-day.mjs` 的
 * `shopFailureCause`）靠标记把这一档与「兜底阶段失败」分开，而两者的处置**相反** ——
 * 兜底那一档要叫人（成因不明，正是新问题该露头的地方），这一档的正确处置是「谁都不用动」
 * （平台那一天没有这一行：重试变不出来，修页面变不出来，人也没法在平台上把它变出来）。
 * 消费方 import 这个常量，不写字面量：两边各写一份，改名那天就会静默漂成「这一类又归回兜底」。
 *
 * 2026-10-05 `网林家居` 现场（同店、同实例、同一份代码，只换日期）：
 *   `10-05` 日期列＝【暂无数据】⇒ 0 个日期行；`10-04` ⇒ 1 个日期行（当日询单人数＝1）；`10-03` ⇒ 又是【暂无数据】。
 * ⇒ 日期生效、登录正常、身份对上、表没选错。**守卫判「不是一行就炸」本身是对的**，
 * 错的是它把这三种完全不同的成因压成同一句 `must contain exactly one daily date row`：
 * 措辞不可行动、自进化菜单答非所问（`STAGE_FAILED` ⇒ 派 `REAPPLY_DATES`，而它是报告者不是执行者）、
 * 分诊把一件不需要人做的事落进「要人处理」。
 *
 * ⚠️ 判据边界：**「暂无数据」≠「询单量 0」**。询单表历史上有 122 行 `询单量 = 0`，
 * 那些都是从**带日期行的源表**写出来的（0 会渲染成一行 `0`）。空态与 0 是两种状态，
 * 不许把 0 当成空态处理，也不许把空态当成 0 写进底单。
 */
export const SOURCE_NO_ROW_FOR_DATE_TOKEN = 'SOURCE_NO_ROW_FOR_DATE';

function cell(value) {
  return String(value ?? '').trim().replace(/\s+/gu, ' ');
}

function exactIndex(values, expected, label) {
  const matches = values.flatMap((value, index) => (cell(value) === expected ? [index] : []));
  if (matches.length !== 1) throw new Error(`expected one ${label} ${expected}, got ${matches.length}`);
  return matches[0];
}

function exactRow(rows, keyIndex, expected, label) {
  const matches = rows.filter(row => cell(row[keyIndex]) === expected);
  if (matches.length !== 1) throw new Error(`expected one ${label} row ${expected}, got ${matches.length}`);
  return matches[0];
}

function integer(value, label) {
  const raw = cell(value).replaceAll(',', '');
  if (!/^\d+$/u.test(raw)) throw new Error(`invalid ${label}: ${value}`);
  return Number(raw);
}

/**
 * 「日期行不是恰好一行」时的那句话。**纯函数**，因此这句话的措辞与它带出的现场值都能离线断言。
 *
 * 三件事必须同时成立（2026-10-06 修 ㉕）：
 *   ① **把现场值带出来**（日期列前若干行原值 + 日期行数 + 期望日）。原先那句只有一句英文判据，
 *      读证据的人想知道「是空态还是选到了区间」只能再跑到那台机器上复现一次 —— 而那是可避免的成本；
 *   ② **该日无行单独给标记**（`SOURCE_NO_ROW_FOR_DATE_TOKEN`），不再与「结构异常」共用一句；
 *   ③ **结构异常那一支保持原样**（`>1` 行确实是异常：日期筛选可能被选成了区间，那要人/agent 去看）。
 */
export function describeDateRowGap({ rows = [], dateIndex = -1, reportDate = null, count = 0 } = {}) {
  const observed = rows.map(row => cell(row[dateIndex])).filter(Boolean).slice(0, 12);
  const facts = `日期列原值=${JSON.stringify(observed)}｜日期行数=${count}｜期望=${reportDate}`;
  if (count === 0) {
    return `${SOURCE_NO_ROW_FOR_DATE_TOKEN} 这一天的源表里没有日期行`
      + `（生意参谋「询单到付款」对该店该日返回的是空态，不是读不到）｜${facts}`;
  }
  return `inquiry source must contain exactly one daily date row｜${facts}`;
}

export function extractInquiryMetrics(table, reportDate, options = {}) {
  const peerBenchmarkRequired = options.peerBenchmarkRequired !== false;
  const headers = table?.headers ?? [];
  const rows = table?.rows ?? [];
  const dateIndex = exactIndex(headers, '日期', 'header');
  const inquiryIndex = exactIndex(headers, '当日询单人数', 'header');
  const datedRows = rows.filter(row => /^\d{4}-\d{2}-\d{2}$/u.test(cell(row[dateIndex])));
  if (datedRows.length !== 1) {
    throw new Error(describeDateRowGap({ rows, dateIndex, reportDate, count: datedRows.length }));
  }
  const dateRow = exactRow(rows, dateIndex, reportDate, 'date');
  const peerRows = rows.filter(row => cell(row[dateIndex]) === '同行同层均值');
  if (peerRows.length > 1) throw new Error(`expected one benchmark row 同行同层均值, got ${peerRows.length}`);
  // 实测（2026-09-16）：预设「1天」（昨日）给 7 行、含同行同层对比行；
  // 自定义日期给 3 行、同行同层优秀/均值两行都不返回。
  // 这是数据源的限制，不是解析失败 —— 但默认仍然 fail-closed，
  // 只有调用方显式传 peerBenchmarkRequired:false 才降级成「只写询单量」。
  // 顺序上先校验结构再解析数值：否则「表里没有基准行」会被数值错误掩盖。
  if (peerRows.length === 0 && peerBenchmarkRequired) {
    throw new Error('expected one benchmark row 同行同层均值, got 0');
  }
  const inquiry = integer(dateRow[inquiryIndex], '当日询单人数');
  if (peerRows.length === 0) return { inquiry, peerInquiry: null, peerBenchmark: 'PEER_UNAVAILABLE' };
  return {
    inquiry,
    peerInquiry: integer(peerRows[0][inquiryIndex], '同行同层均值/当日询单人数'),
    peerBenchmark: 'PEER_AVAILABLE',
  };
}

export function selectDailyStoreRecord(records, reportDateEpoch, shop) {
  const matches = records.filter(record => Number(record.fields?.['日期']) === reportDateEpoch
    && cell(record.fields?.['店铺']) === shop);
  if (matches.length !== 1) {
    throw new Error(`expected one Feishu row for ${shop} / ${reportDateEpoch}, got ${matches.length}`);
  }
  return matches[0];
}

/**
 * 我方那一行在不在 —— 按「日期 + 店铺」找**唯一**候选，认两种形态。
 *
 * 为什么必须有它（2026-09-29 实测，`got 0` 的真因）：
 * `店铺` 是 SingleSelect（type=3），而 OpenAPI 在这个字段上**会回两种形态** ——
 * 店名（`"盖文淘宝"`，全表 2185 行）与选项 id（`"optFFaXJeh"`，09-28 那 12 行）。
 * 原判据只认店名 ⇒ 撞上选项 id 的那一天恒不匹配、报 `got 0`，而人在页面上明明看得见那一行。
 * 这正是本项目那条老病根「把读不到当成不存在」的又一例。
 *
 * 认 id 的正当性不是「为了兼容」，而是它**在字段自己的选项表里唯一**：`optionId` 由
 * `property.options` 反查（id → name）得出，命中即等于同名。传空/缺省时行为与从前逐字相同。
 * 绝不猜近似名 —— 猜错会把另一家店的行写坏，且写坏之后从产物上看不出来。
 *
 * 候选数必须恰好 1：同日同店出现两行是数据异常，宁可炸掉也不挑一行写。
 * 找不到时**返回结果对象而不是抛错**，让调用方决定措辞（要区分 0 个与 >1 个）。
 */
export function findDailyStoreRow(records, reportDateEpoch, shop, options = {}) {
  const optionId = options?.optionId ?? null;
  const accepted = optionId ? [shop, optionId] : [shop];
  const matches = records.filter(record => Number(record.fields?.['日期']) === reportDateEpoch
    && accepted.includes(cell(record.fields?.['店铺'])));
  const only = matches.length === 1 ? matches[0] : null;
  return {
    record: only,
    // 认的是哪种形态 —— 落进产物，让读证据的人不必再猜 optXXX 是哪家店。
    matchedBy: only === null ? null : (cell(only.fields?.['店铺']) === shop ? 'shop-name' : 'field-option-id'),
    candidateCount: matches.length,
  };
}

export function classifyInquiryWrite(fields, metrics) {
  const inquiry = fields?.['询单量'] ?? null;
  const peerInquiry = fields?.['同层同行询单量'] ?? null;
  const blank = (value) => value === null || value === undefined || cell(value) === '';

  // 降级写入：同行基准不可得时，这一格必须保持空白；只有「询单量」参与判定。
  // 这样重复运行仍然返回 ALREADY_VERIFIED，而不是每次都抛错。
  if (metrics.peerInquiry === null || metrics.peerInquiry === undefined) {
    if (!blank(peerInquiry)) {
      throw new Error(`peer benchmark is PEER_UNAVAILABLE but 同层同行询单量 is not blank: ${JSON.stringify(peerInquiry)}`);
    }
    if (blank(inquiry)) return 'WRITE_REQUIRED';
    if (Number(inquiry) === metrics.inquiry) return 'ALREADY_VERIFIED';
    throw new Error(`询单量 ${JSON.stringify(inquiry)} does not match source ${metrics.inquiry}`);
  }

  if (blank(inquiry) && blank(peerInquiry)) return 'WRITE_REQUIRED';
  if (!blank(inquiry) && !blank(peerInquiry)
    && Number(inquiry) === metrics.inquiry && Number(peerInquiry) === metrics.peerInquiry) {
    return 'ALREADY_VERIFIED';
  }
  throw new Error(`inquiry fields are not jointly blank or equal to source: ${JSON.stringify({ inquiry, peerInquiry })}`);
}
