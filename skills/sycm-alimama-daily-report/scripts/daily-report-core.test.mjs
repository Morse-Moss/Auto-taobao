import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCENES, buildCombinedFields, buildPromotionFields, buildShopFields, canonicalPromotionTargetName,
  promotionSegmentStarts, promotionSubsidyFields,
  reportDateEpoch, summarizeSourceDates,
} from './daily-report-core.mjs';

const REPORT_DATE = '2026-09-16';

// 造一份最小但形状正确的 source（店铺 119 列、推广 71 列都不是这个函数关心的，
// 它只看日期列与取用的那一行 —— 所以这里只用真实列名，不假装有整行数据）。
function makeSource({ shopDates, matchedDate = REPORT_DATE, promotionDates, csvName = '营销场景报表.csv' }) {
  return {
    shop: {
      headers: ['统计日期', ...Array.from({ length: 118 }, (_, index) => `店铺字段${index}`)],
      values: [matchedDate, '盖文旗舰店', ...Array.from({ length: 117 }, (_, index) => String(index))],
      workbookRows: shopDates.length + 1,
      dates: shopDates,
    },
    promotion: {
      headers: ['日期', '场景ID', '场景名字'],
      rows: promotionDates.map((value, index) => [value, String(371 + index), index === 0 ? '关键词推广' : '人群推广']),
      csvName,
      dates: promotionDates,
    },
  };
}

test('自证：两侧都是目标日时通过，并留下「观察到哪几天」的证据', () => {
  const source = makeSource({
    shopDates: ['2026-09-16', '2026-09-15', '2026-09-14'],
    promotionDates: [REPORT_DATE, REPORT_DATE],
  });
  const selfCheck = summarizeSourceDates(source, REPORT_DATE);
  assert.equal(selfCheck.allMatchDate, true);
  assert.equal(selfCheck.shop.targetRowCount, 1);
  assert.equal(selfCheck.shop.matchedRowDate, REPORT_DATE);
  assert.equal(selfCheck.shop.uniqueDates, 3);
  assert.equal(selfCheck.shop.firstRowDate, '2026-09-16');
  assert.equal(selfCheck.shop.lastRowDate, '2026-09-14');
  assert.deepEqual(selfCheck.promotion.observedDates, [REPORT_DATE]);
  assert.equal(selfCheck.promotion.rowCount, 2);
  assert.equal(selfCheck.promotion.csvName, '营销场景报表.csv');
});

test('自证：推广 ZIP 是前一天的就判不通过（下载错文件的主要形态）', () => {
  const source = makeSource({
    shopDates: ['2026-09-16', '2026-09-15'],
    promotionDates: ['2026-09-15', '2026-09-15'],
  });
  const selfCheck = summarizeSourceDates(source, REPORT_DATE);
  assert.equal(selfCheck.promotion.matches, false);
  assert.equal(selfCheck.promotion.targetRowCount, 0);
  assert.deepEqual(selfCheck.promotion.observedDates, ['2026-09-15']);
  assert.equal(selfCheck.allMatchDate, false, '推广侧不对时整体必须判不通过');
  assert.equal(selfCheck.shop.matches, true, '店铺侧仍然是对的，证据要分别保留');
});

test('自证：店铺工作簿里目标日出现两次也判不通过', () => {
  const source = makeSource({
    shopDates: ['2026-09-16', '2026-09-16', '2026-09-15'],
    promotionDates: [REPORT_DATE, REPORT_DATE],
  });
  const selfCheck = summarizeSourceDates(source, REPORT_DATE);
  assert.equal(selfCheck.shop.targetRowCount, 2);
  assert.equal(selfCheck.shop.matches, false);
  assert.equal(selfCheck.allMatchDate, false);
});

test('自证：取用的那一行不是目标日时判不通过（防止「列里有一行对」就放行）', () => {
  const source = makeSource({
    shopDates: ['2026-09-16', '2026-09-15'],
    matchedDate: '2026-09-15',
    promotionDates: [REPORT_DATE, REPORT_DATE],
  });
  const selfCheck = summarizeSourceDates(source, REPORT_DATE);
  assert.equal(selfCheck.shop.targetRowCount, 1, '列里确实有一行是目标日');
  assert.equal(selfCheck.shop.matches, false, '但被取用的那一行不是它，所以不能通过');
  assert.equal(selfCheck.allMatchDate, false);
});

test('maps all 119 shop columns by exact header and converts live types', () => {
  const headers = Array.from({ length: 119 }, (_, index) => `字段${index}`);
  headers[0] = '统计日期';
  const values = Array.from({ length: 119 }, (_, index) => String(index));
  values[0] = '2026-09-15';
  values[1] = '盖文旗舰店';
  const targets = headers.map((name, index) => ({ name, type: index === 0 ? 5 : index === 1 ? 1 : 2 }));
  const fields = buildShopFields({ headers, values }, targets, '2026-09-15');
  assert.equal(fields['统计日期'], reportDateEpoch('2026-09-15'));
  assert.equal(fields['字段1'], '盖文旗舰店');
  assert.equal(fields['字段118'], 118);
  assert.throws(() => buildShopFields({ headers: [...headers.slice(0, 3), '错位', ...headers.slice(4)], values }, targets,
    '2026-09-15'), /shop header mismatch/u);
});

// 2026-09-18 实亏：09-17 的四家店（里可林家居/网林家居旗舰店/盖文全卫定制/科塔全卫定制）
// 当天无成交，数据源对 `UV价值`/`无线端UV价值` 给的是**文本标记 NULL**，而飞书这两列是**数字**字段。
// 原实现直接抛错 ⇒ 四家店同时推不动。处置定为「留空 + 留痕」，这条测试就是盯住它：
// 既不许悄悄写 0（造假事实、污染同比环比），也不许退回抛错（链推不动），还不许不留痕。
test('数字字段遇到数据源的文本标记 ⇒ 留空并留痕（不写 0，也不抛错）', () => {
  const headers = Array.from({ length: 119 }, (_, index) => `字段${index}`);
  headers[0] = 'UV价值';
  headers[1] = '无线端UV价值';
  headers[2] = 'PC端UV价值';
  headers[3] = '某数字字段';
  const values = Array.from({ length: 119 }, (_, index) => String(index));
  values[0] = 'NULL';
  values[1] = 'null'; // 大小写都要拦：数据源两种写法都出现过
  values[2] = 'NULL'; // 文本字段：能原样存，这是底单里已经落库的实况
  values[3] = '-';    // 同一语义的另一种标记写法
  const targets = headers.map((name, index) => ({ name, type: index === 2 ? 1 : 2 }));

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  let fields;
  try {
    fields = buildShopFields({ headers, values }, targets, '2026-09-17');
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(Object.hasOwn(fields, 'UV价值'), false, '数字字段里存不下标记 ⇒ 该列不进 payload');
  assert.notEqual(fields['UV价值'], 0, '绝不能把「无数据」写成 0');
  assert.equal(Object.hasOwn(fields, '无线端UV价值'), false, '标记大小写不敏感');
  assert.equal(Object.hasOwn(fields, '某数字字段'), false, "'-' 与 NULL 同语义，同样留空");
  assert.equal(fields['PC端UV价值'], 'NULL', '文本字段能原样存标记（实测底单里就是字符串 NULL）');
  assert.equal(fields['字段4'], 4, '其余数字列照常转换');
  assert.equal(warnings.length, 3, '有几个格子被留空就必须有几行 warn —— 留空是静默的，不写日志事后分不出「无数据」与「漏采集」');
  assert.match(warnings[0], /UV价值/u);
});

// 2026-10-26：补贴那几列从「整段丢掉」改成「全导入」（用户拍板「73 列全导入」）。
//
// 真实来源：保拉天猫 2026-10-26 的推广 CSV 是 **73 列**（尾部多 `补贴引导成交新客数` /
// `补贴引导成交笔数`），而当天另外三份是 **71 列**。所以两种宽度都必须认 —— 钉单值必挂一头。
const SUBSIDY_ALL = ['平台补贴金额', '补贴引导成交金额', '发券补贴商品个数', '补贴引导成交人数',
  '补贴引导成交新客数', '补贴引导成交笔数'];

function promoFixture(width) {
  const headers = ['日期', '场景ID', '场景名字',
    ...Array.from({ length: 64 }, (_, index) => `指标${index}`),
    ...SUBSIDY_ALL.slice(0, width - 67)];
  const row = ['2026-09-15', '371', '关键词推广',
    ...Array.from({ length: 64 }, (_, index) => String(index)),
    ...Array.from({ length: width - 67 }, (_, index) => String(index))];
  const targetNames = ['关键词推广日期', '场景ID', '场景名字', '原二级场景ID', '原二级场景名字',
    ...headers.slice(3, 67)];
  const targets = targetNames.map((name, index) => ({ name, type: index === 0 ? 5 : index === 2 || index === 4 ? 1 : 2 }));
  return { headers, row, targets };
}

function subsidyMapFor(prefixSuffix) {
  return new Map(SUBSIDY_ALL.map((header) => [header, { name: `${header}${prefixSuffix}`, type: 2 }]));
}

test('promotion：两种真实宽度都认（71 / 73），钉死任一个都会挡掉一半店', () => {
  for (const width of [71, 73]) {
    const { headers, row, targets } = promoFixture(width);
    const fields = buildPromotionFields(headers, row, targets, SCENES.keyword, '2026-09-15',
      subsidyMapFor(''));
    assert.equal(fields['场景ID'], 371);
    assert.equal(fields['指标63'], 63);
    assert.equal(Object.hasOwn(fields, '原二级场景ID'), false, '次级场景字段照旧留空');
    assert.equal(Object.hasOwn(fields, '原二级场景名字'), false);
    // 补贴列现在**必须**进 payload（原来是全部丢掉）
    assert.equal(fields['平台补贴金额'], 0, '0.00 → 0（数字字段）');
    assert.equal(fields['补贴引导成交人数'], 3);
    if (width === 73) {
      assert.equal(fields['补贴引导成交新客数'], 4, '73 列才有的那两列也要进');
      assert.equal(fields['补贴引导成交笔数'], 5);
    } else {
      assert.equal(Object.hasOwn(fields, '补贴引导成交新客数'), false, '71 列的店没有这两列，不许凭空造');
    }
  }
  // 别的宽度仍然拒绝：这不是「宽松」，是把两种**实测存在**的形状列出来而已
  const weird = promoFixture(71);
  weird.headers.push('多出来的一列');
  weird.row.push('0');
  assert.throws(() => buildPromotionFields(weird.headers, weird.row, weird.targets, SCENES.keyword, '2026-09-15',
    subsidyMapFor('')), /promotion block must contain 71 or 73/u);
});

test('promotion：CSV 有补贴列、底单没字段 ⇒ 停下并点名缺哪个（不许静默丢列）', () => {
  const { headers, row, targets } = promoFixture(73);
  const partial = subsidyMapFor('');
  partial.delete('补贴引导成交笔数');
  assert.throws(() => buildPromotionFields(headers, row, targets, SCENES.keyword, '2026-09-15', partial),
    /补贴引导成交笔数/u);
});

test('promotion：两段的补贴字段按「有没有 (n) 后缀」分桶，不许写到对方那段', () => {
  const visible = [
    { name: '平台补贴金额', type: 2 },
    { name: '平台补贴金额 (1)', type: 2 },
    { name: '补贴引导成交笔数', type: 2 },
    { name: '补贴引导成交笔数 (1)', type: 2 },
    { name: '关键词推广花费', type: 2 },
  ];
  const split = promotionSubsidyFields(visible);
  assert.equal(split.keyword.get('平台补贴金额')?.name, '平台补贴金额');
  assert.equal(split.audience.get('平台补贴金额')?.name, '平台补贴金额 (1)');
  assert.equal(split.keyword.get('补贴引导成交笔数')?.name, '补贴引导成交笔数');
  assert.equal(split.audience.get('补贴引导成交笔数')?.name, '补贴引导成交笔数 (1)');
  assert.equal(split.keyword.size, 2, '只认补贴那 6 个名字，别的字段一概不进桶');
});

test('promotionSegmentStarts：按名字钉边界 —— 扛得住「追加字段」，钉得住「顺序被改」', () => {
  const base = (extra = 0) => [
    ...Array.from({ length: 121 }, (_, i) => ({ name: i === 2 ? '统计日期' : `店铺字段${i}`, type: 2 })),
    { name: '关键词推广日期', type: 5 }, { name: '场景ID', type: 2 }, { name: '场景名字', type: 1 },
    { name: '原二级场景ID', type: 2 }, { name: '原二级场景名字', type: 1 },
    ...Array.from({ length: 64 }, (_, i) => ({ name: `关键词指标${i}`, type: 2 })),
    { name: '人群推广日期', type: 5 }, { name: '场景ID (1)', type: 2 }, { name: '场景名字 (1)', type: 1 },
    { name: '原二级场景ID (1)', type: 2 }, { name: '原二级场景名字 (1)', type: 1 },
    ...Array.from({ length: 64 }, (_, i) => ({ name: `人群指标${i}`, type: 2 })),
    ...Array.from({ length: 6 }, (_, i) => ({ name: `尾部${i}`, type: 1 })),
    ...Array.from({ length: extra }, (_, i) => ({ name: `追加补贴${i}`, type: 2 })),
  ];
  assert.equal(promotionSegmentStarts(base(0)).ok, true, '原来的 265 列形状');
  assert.equal(promotionSegmentStarts(base(12)).ok, true, '2026-10-26 追加 12 个补贴字段后仍是同一个形状');
  // 顺序被改 ⇒ 必须红（写下去是静默串列，比报错糟得多）
  const swapped = base(0);
  [swapped[121], swapped[122]] = [swapped[122], swapped[121]];
  const verdict = promotionSegmentStarts(swapped);
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /推广段起点/u);
  // 字段太少 ⇒ 也红
  assert.equal(promotionSegmentStarts(base(0).slice(0, 200)).ok, false);
});


test('normalizes Feishu copy suffixes and scene prefixes for schema comparison', () => {
  assert.equal(canonicalPromotionTargetName('关键词推广花费 (1)', '关键词推广'), '花费');
  assert.equal(canonicalPromotionTargetName('会员成交金额 (2)', '人群推广'), '会员成交金额');
});

// 造一份**形状完整**的 265 列目标表 + 源数据，供 buildCombinedFields 用。
// 飞书侧对重名会加 ` (1)` 后缀，所以人群推广那一段的字段名带它（`场景ID (1)` 等）——
// 这不是随手编的：run-daily-report 的 plan.checks 读的就是 `场景ID` 与 `场景ID (1)`。
function makeCombined(promotionRows) {
  const shopHeaders = ['统计日期', ...Array.from({ length: 118 }, (_, index) => `店铺字段${index}`)];
  const promoHeaders = ['日期', '场景ID', '场景名字',
    ...Array.from({ length: 64 }, (_, index) => `指标${index}`),
    '平台补贴金额', '补贴引导成交金额', '发券补贴商品个数', '补贴引导成交人数'];
  const sceneFields = (prefix, suffix) => [`${prefix}日期`, '场景ID', '场景名字', '原二级场景ID', '原二级场景名字',
    ...Array.from({ length: 64 }, (_, index) => `指标${index}`)]
    .map((name, index) => ({ name: index === 0 ? name : `${name}${suffix}`,
      type: index === 0 ? 5 : index === 2 || index === 4 ? 1 : 2 }));
  const visibleFields = [
    { name: '无关1', type: 1 }, { name: '无关2', type: 1 },
    ...shopHeaders.map((name, index) => ({ name, type: index === 0 ? 5 : index === 1 ? 1 : 2 })),
    ...sceneFields('关键词推广', ''),
    ...sceneFields('人群推广', ' (1)'),
    ...Array.from({ length: 6 }, (_, index) => ({ name: `尾部${index}`, type: 1 })),
    // 2026-10-26：「73 列全导入」给底单追加的两段补贴字段。**位置在表尾**（飞书新字段只能追加），
    // 所以它们既不在 121..258 那两段里，也不能靠位置认 —— 只能按名字找（promotionSubsidyFields）。
    ...SUBSIDY_ALL.map((header) => ({ name: header, type: 2 })),
    ...SUBSIDY_ALL.map((header) => ({ name: `${header} (1)`, type: 2 })),
  ];
  const source = {
    shop: { headers: shopHeaders, values: [REPORT_DATE, '盖文旗舰店', ...Array.from({ length: 117 }, (_, i) => String(i))] },
    promotion: {
      headers: promoHeaders,
      rows: promotionRows.map(([id, name]) => [REPORT_DATE, id, name,
        ...Array.from({ length: 64 }, (_, index) => String(index)), '1', '2', '3', '4']),
    },
  };
  return { visibleFields, source };
}

const captureWarn = (fn) => {
  const original = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  try { return { value: fn(), warnings }; } finally { console.warn = original; }
};

// 2026-10-05：一家店**没开某个推广场景**时怎么办。
// 实测网林家居没开关键词推广 ⇒ 报表里只有 372 一条，而原实现写死「恰好两条、且必须 371+372」
// ⇒ 整条链停在 push（`expected exactly two unique promotion rows, got 1`），
// 可那份数据本身是**完整的**：它只是没有这个场景的投放（业务方已确认这是常态）。
// 现在的口径：有几个场景写几个，缺的那几个场景**整段留空**（并打一行 warn 留痕 ——
// 留空与「没采到」在飞书页面上长得一样，这行日志是唯一的区分依据）；
// 而「一个场景都没有」仍然 fail-closed：那是没采到数据，不是「这家店没开推广」。
test('buildCombinedFields：单场景放行（有几个场景写几个），一个都没有仍 fail-closed', () => {
  const both = makeCombined([['371', '关键词推广'], ['372', '人群推广']]);
  // 265 → 277：2026-10-26 追加 12 个补贴字段（6 个指标 × 两段）。
  // 这个数字变过一次，正说明它不该被当成契约 —— 真正的判据是 promotionSegmentStarts 按名字钉的边界。
  assert.equal(both.visibleFields.length, 277, '这份夹具要长成底单现在的真实形状，否则后面全在测别的东西');
  const full = buildCombinedFields(both.source, both.visibleFields, REPORT_DATE);
  assert.equal(full['场景ID'], 371);
  assert.equal(full['场景ID (1)'], 372);
  assert.equal(full['店铺字段0'], '盖文旗舰店', '店铺段照常映射（第 1 列＝店铺名，文本字段）');
  assert.equal(full['店铺字段1'], 0, '店铺段照常映射（第 2 列起是数字字段）');
  // 补贴列现在两段各写各的，不许串到对方那段去
  assert.equal(full['平台补贴金额'], 1, '关键词段的补贴列');
  assert.equal(full['平台补贴金额 (1)'], 1, '人群段的同名列（(1) 后缀）');

  // 只有人群推广（网林家居那一家的形态）
  const onlyAudience = makeCombined([['372', '人群推广']]);
  const { value: partial, warnings } = captureWarn(() => buildCombinedFields(onlyAudience.source, onlyAudience.visibleFields, REPORT_DATE));
  assert.equal(partial['场景ID (1)'], 372, '有的那个场景照常写');
  assert.equal(Object.hasOwn(partial, '场景ID'), false, '缺的场景整段不写 —— 既不写 0，也不抛错');
  assert.equal(Object.hasOwn(partial, '指标0'), false, '缺的那一段整段不写');
  assert.equal(partial['店铺字段1'], 0, '店铺段不受影响');
  assert.equal(warnings.length, 1, '缺场景必须留痕：不写日志，事后分不出「没开推广」与「没采到」');
  assert.match(warnings[0], /371\/关键词推广/u);

  // 只有关键词推广（对称的另一半，防「只修了 371 那一侧」）
  const onlyKeyword = makeCombined([['371', '关键词推广']]);
  const { value: flipped, warnings: warn2 } = captureWarn(() => buildCombinedFields(onlyKeyword.source, onlyKeyword.visibleFields, REPORT_DATE));
  assert.equal(flipped['场景ID'], 371);
  assert.equal(Object.hasOwn(flipped, '场景ID (1)'), false);
  assert.equal(warn2.length, 1);
  assert.match(warn2[0], /372\/人群推广/u);

  // 一个场景都没有 ⇒ 仍然 fail-closed
  const none = makeCombined([]);
  assert.throws(() => buildCombinedFields(none.source, none.visibleFields, REPORT_DATE),
    /一个推广场景都没有/u, '零场景是「没采到」，不是「这家店没开推广」，必须停');
  // 不认识的场景 id ⇒ 停下（平台加了新场景时别硬塞进这两段里）
  const extra = makeCombined([['371', '关键词推广'], ['373', '新场景']]);
  assert.throws(() => buildCombinedFields(extra.source, extra.visibleFields, REPORT_DATE), /unknown scene id/u);
  // 同一个 id 两条 ⇒ 分不清该用哪条
  const dup = makeCombined([['372', '人群推广'], ['372', '人群推广']]);
  assert.throws(() => buildCombinedFields(dup.source, dup.visibleFields, REPORT_DATE), /duplicate scene id/u);
});

// 2026-10-20：业务口径「平台上确实没有推广数据，就按实际留空，不要填 0」。
// 实测来源：网林家居 2026-10-19 的推广 CSV 只有表头、0 条数据行（两次独立生成的任务
// 导出同一份空 CSV），平台报表页本身显示「暂无数据 共 0 项数据」、账户总花费 0.00。
// 这里要钉三件事：默认仍拦、显式放行后**只留空不写 0**、以及空与「日期不对」必须是两种态。
test('0 行推广：默认仍 fail-closed，显式 allowEmptyPromotion 才留空（且不写 0）', () => {
  const empty = makeCombined([]);

  // ① 默认（不传 options）照旧拦 —— 这条是防「为了让今天跑通，把闸门默认放开」的退路。
  assert.throws(() => buildCombinedFields(empty.source, empty.visibleFields, REPORT_DATE),
    /一个推广场景都没有/u);

  // ② 显式放行：推广两段整段不写（既不是 0，也不是空字符串），店铺段照常写。
  const { value: fields, warnings } = captureWarn(() =>
    buildCombinedFields(empty.source, empty.visibleFields, REPORT_DATE, { allowEmptyPromotion: true }));
  assert.equal(fields['店铺字段1'], 0, '店铺段不受影响');
  for (const name of ['场景ID', '场景ID (1)', '指标0', '关键词推广花费', '人群推广花费']) {
    assert.equal(Object.hasOwn(fields, name), false, `${name} 必须整段不写（留空 ≠ 写 0）`);
  }
  assert.equal(JSON.stringify(fields).includes('"0"'), false, '不能把「没有」写成 0 值');
  assert.equal(warnings.length, 1, '留空必须留痕：这是「平台没有」与「采集漏了」唯一的区分依据');
  assert.match(warnings[0], /0 行/u);
  assert.match(warnings[0], /不是采集漏/u);

  // ③ 空 ≠ 日期不对：有数据行但日期不是目标日，即使显式放行也必须拦（那是下错文件/筛选失效）。
  const wrongDate = makeCombined([]);
  wrongDate.source.promotion.rows = [['2026-09-15', '371', '关键词推广',
    ...Array.from({ length: 64 }, (_, index) => String(index)), '1', '2', '3', '4']];
  const dateCheck = summarizeSourceDates(wrongDate.source, REPORT_DATE);
  assert.equal(dateCheck.promotion.empty, false, '有行就不是空');
  assert.equal(dateCheck.promotion.state, 'mismatched');
  assert.throws(() => buildCombinedFields(wrongDate.source, wrongDate.visibleFields, REPORT_DATE,
    { allowEmptyPromotion: true }), /unexpected 关键词推广 identity\/date/u,
  '开关只对「空」生效，不能顺手放行日期错的报表');
});

test('自证：推广 0 行是 empty 态而不是 mismatched 态（两种成因必须分得开）', () => {
  const emptySource = makeSource({ shopDates: ['2026-09-16'], promotionDates: [] });
  const emptyCheck = summarizeSourceDates(emptySource, REPORT_DATE);
  assert.equal(emptyCheck.promotion.empty, true);
  assert.equal(emptyCheck.promotion.state, 'empty');
  assert.equal(emptyCheck.promotion.rowCount, 0);
  assert.deepEqual(emptyCheck.promotion.observedDates, []);
  assert.equal(emptyCheck.promotion.matches, false, '空不等于匹配 —— 是否需要放行由调用方显式决定');
  assert.equal(emptyCheck.shop.matches, true);
  assert.equal(emptyCheck.allMatchDate, false);

  const wrongSource = makeSource({ shopDates: ['2026-09-16'], promotionDates: ['2026-09-15'] });
  const wrongCheck = summarizeSourceDates(wrongSource, REPORT_DATE);
  assert.equal(wrongCheck.promotion.empty, false);
  assert.equal(wrongCheck.promotion.state, 'mismatched');

  const okSource = makeSource({ shopDates: ['2026-09-16'], promotionDates: [REPORT_DATE] });
  assert.equal(summarizeSourceDates(okSource, REPORT_DATE).promotion.state, 'matched');
});
