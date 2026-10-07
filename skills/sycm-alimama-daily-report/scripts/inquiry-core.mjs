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

/**
 * 「飞书询单表里没有这一天的行骨架」的**确定性标记**（2026-10-07 加）。
 *
 * 与上面那个标记是**两种完全不同**的成因，处置也相反，所以不许共用一句措辞：
 *   · `SOURCE_NO_ROW_FOR_DATE` —— **平台侧**那一天没有出数（生意参谋表显示「暂无数据」）；
 *   · `INQUIRY_ROW_MISSING`   —— **飞书侧**那一行还没建出来（数据采到了，没有地方写）。
 * 前者的正确处置是「谁都不用动」（变不出来），后者是「把行建出来再重跑回填」。
 *
 * 2026-10-06 的现场：8 家店跑完前 9 步（含 push 写底单**全部成功**），
 * 到第 10 步 `backfill` 全部报 `expected one Feishu row for X / <epoch>, got 0` ——
 * 因为「各店铺数据日报」这张表的日期行是**运营侧预建**的，只铺到 10-05。
 * 那句话读起来像结构异常，实际是「表里没有这一天的行」，而这是**可以自动修**的
 * （见 `ensure-inquiry-rows.mjs`）。所以它必须单列一类，不能落回 `STAGE_FAILED` 兜底：
 * 兜底那句会让人和 agent 都去浏览器里找原因，而浏览器这一轮一点问题都没有。
 *
 * 消费方 import 这个常量，不写字面量：两边各写一份，改名那天就会静默漂回兜底。
 */
export const INQUIRY_ROW_MISSING_TOKEN = 'INQUIRY_ROW_MISSING';

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

/**
 * 「飞书里找不到这一行」时的那句话。**纯函数**（措辞与现场值都能离线断言）。
 *
 * 两种候选数分开说（2026-10-07 加）：
 *   · `0` 个 —— **行骨架缺失**，带 `INQUIRY_ROW_MISSING_TOKEN` 标记，并直接把处置写进错误里
 *     （先建行、再重跑）。写处置的目的是：读证据/读告警的人不必再去翻代码才知道该做什么。
 *   · `>1` 个 —— 同日同店出现多行，是**数据异常**（日期筛选点成了区间、或有人手工加过行），
 *     要人核对。刻意**不带**行骨架标记：它与「没有行」是相反的两种现场，混成一类会让
 *     分诊把一次「多出来的行」当成「少一行」去补，反而更乱。
 */
export function describeFeishuRowGap({ shop = null, reportDate = null, reportDateEpoch = null, candidateCount = 0 } = {}) {
  const facts = `店铺=${JSON.stringify(shop)}｜日期=${reportDate ?? reportDateEpoch}｜候选行数=${candidateCount}`;
  if (Number(candidateCount) === 0) {
    return `${INQUIRY_ROW_MISSING_TOKEN} 询单表里这一天没有这一家的行（行骨架缺失，不是源表读不到）`
      + `｜${facts}｜处置：先建行（ensure-inquiry-rows.mjs --date <日> --commit），再重跑这一步`;
  }
  return `expected one Feishu row for ${shop} / ${reportDateEpoch}, got ${candidateCount}`
    + `（同日同店出现多行，需人核对）｜${facts}`;
}

// ---------------------------------------------------------------------------
// 「店铺」这个 SingleSelect 的选项表（2026-10-07 抽出来）
// ---------------------------------------------------------------------------
// 为什么抽出来：回填（`run-inquiry-backfill.mjs`）与建行骨架（`ensure-inquiry-rows.mjs`）
// 都需要它，而它的**语义**（哪一个字段、怎么算命中、重名怎么办）只能有一份实现 ——
// 两份实现漂开的那天，症状是「建行时认得出这家店、回填时认不出」，且两边都不报错。
//
// 为什么读的是 `listFieldItems()`（原始条目）而不是 `listFields()`：后者返回形状被多处
// `deepEqual` 逐字断言，多带一个 `property` 就会让那些用例变红；选项表只在 `property.options` 里。
//
// 这一段要处理「选项列表可能超过一页」——少读一页不会抛错，只会安静地少认几家店
//（分页由 `FeishuClient.listFieldItems()` 自己做）。

/** 原始字段条目 → 某个 SingleSelect 字段的选项表（只要带 id 的）。**纯函数**。 */
export function shopOptionsOf(items, fieldName = '店铺') {
  const field = (Array.isArray(items) ? items : []).find((item) => item?.field_name === fieldName);
  return (field?.property?.options ?? []).filter((option) => option?.id);
}

/**
 * 「运营店名」→「SingleSelect 选项 id」。**纯函数**。
 *
 * 找不到时**返回 null 而不是抛错**：这个函数只服务于「多认一种形态」，
 * 而旧行为（只认店名）永远是正确的一支。抛错会把一次可降级的匹配失败升级成整轮停摆。
 * 但**重名要抛**：选项表里同一个店名出现两次时，两个 id 里挑一个就是猜，
 * 而猜错会把另一家店的行写坏 —— 且从产物上看不出来。
 */
export function pickShopOptionId(options, shop) {
  const exact = (Array.isArray(options) ? options : []).filter((option) => option?.name === shop);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) {
    throw new Error(`店铺选项里 ${JSON.stringify(shop)} 出现 ${exact.length} 次，选项表本身有重名`);
  }
  return null;
}

/** 拉那份选项表（IO 只有这一行：调用方给 client）。 */
export async function listFieldOptions(client, fieldName = '店铺') {
  return shopOptionsOf(await client.listFieldItems(), fieldName);
}

/** 「运营店名」→ 选项 id（IO 版）。两个调用方共用同一份判据。 */
export async function resolveShopOptionId(client, shop) {
  return pickShopOptionId(await listFieldOptions(client, '店铺'), shop);
}

/**
 * 这一天该有哪些行、现在已经有哪些。**纯函数**（判据可离线断言，不碰任何远端）。
 *
 * 匹配口径**复用 `findDailyStoreRow`**（含选项 id 形态）：建行与回填必须用**同一个**判据
 * 认「这一行在不在」。各写一份的代价是本项目已经吃过两次的那种 ——
 * 「建行时认为缺、回填时认得出来」（或反过来），两边都不报错，只是多建一行 / 永远回填不上。
 *
 * 三堆分开返回，而不是一个布尔：
 *   · `missing` —— 要建的行（唯一会触发写入的一堆）；
 *   · `present` —— 已经有了（幂等重跑的正常结果，不是失败）；
 *   · `duplicated` —— 同日同店多行。**不是**「已经存在」，也不许当成「要建」：
 *     它是数据异常，调用方要 fail-closed（一行都不建）并如实报出来。
 *
 * `optionIdByShop` 由调用方从选项表反查后传进来（选项表是远端事实，不进纯函数）。
 */
export function planInquiryRowSkeleton({ records = [], reportDateEpoch, shops = [], optionIdByShop = {} } = {}) {
  const present = [];
  const missing = [];
  const duplicated = [];
  for (const shop of shops) {
    const optionId = optionIdByShop?.[shop] ?? null;
    const picked = findDailyStoreRow(records, reportDateEpoch, shop, { optionId });
    if (picked.candidateCount === 0) missing.push(shop);
    else if (picked.candidateCount === 1) {
      present.push({ shop, recordId: picked.record.record_id, matchedBy: picked.matchedBy });
    } else duplicated.push({ shop, candidateCount: picked.candidateCount });
  }
  return { present, missing, duplicated };
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
