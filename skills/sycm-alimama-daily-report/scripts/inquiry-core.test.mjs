import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyInquiryWrite, describeDateRowGap, describeFeishuRowGap, extractInquiryMetrics, findDailyStoreRow, INQUIRY_ROW_MISSING_TOKEN, pickShopOptionId, planInquiryRowSkeleton, selectDailyStoreRecord, shopOptionsOf, SOURCE_NO_ROW_FOR_DATE_TOKEN } from './inquiry-core.mjs';

// ---------------------------------------------------------------------------
// 「这一天的源表里没有日期行」必须与「结构异常」分开（2026-10-06 修 ㉕）
// ---------------------------------------------------------------------------
// 2026-10-05 `网林家居` 现场（同店、同实例、同一份代码，只换日期）：
//   `10-05` 日期列＝【暂无数据】⇒ 0 个日期行；`10-04` ⇒ 1 个日期行；`10-03` ⇒ 又【暂无数据】。
// 原先两种成因共用一句 'must contain exactly one daily date row'，于是
// 自进化菜单按兜底类派 `REAPPLY_DATES`（白跑一轮）、分诊把它落进「要人处理」。
test('空态（0 个日期行）单列一类，且**必须带上现场值**', () => {
  const table = {
    headers: ['日期', '当日询单人数', '当日付款人数'],
    // 真机空态的日期列长这样：不是空的，而是这些字面量。
    rows: [['暂无数据', '-', '-'], ['汇总值', '-', '-'], ['平均值', '-', '-'],
      ['全店汇总值', '-', '-'], ['同行同层均值', '-', '-']],
  };
  const error = (() => { try { extractInquiryMetrics(table, '2026-10-05'); return null; } catch (e) { return e.message; } })();
  assert.ok(error, '空态必须仍然 fail-closed（不许静默写出一个假值）');
  assert.ok(error.includes(SOURCE_NO_ROW_FOR_DATE_TOKEN),
    `空态要带机器标记，否则链会把它归回兜底类（会叫人、会驻留）：${error}`);
  // 现场值必须落在错误里：读证据的人不该再跑到那台机器上复现一次才能知道「是空态还是选到了区间」
  assert.match(error, /日期列原值=\["暂无数据"/u);
  assert.match(error, /日期行数=0/u);
  assert.match(error, /期望=2026-10-05/u);
});

test('「暂无数据」≠「询单量 0」：0 是一个正常的日期行，不许被当成空态', () => {
  const table = {
    headers: ['日期', '当日询单人数', '当日付款人数'],
    rows: [['2026-10-05', '0', '0'], ['同行同层均值', '12', '3']],
  };
  assert.deepEqual(extractInquiryMetrics(table, '2026-10-05'),
    { inquiry: 0, peerInquiry: 12, peerBenchmark: 'PEER_AVAILABLE' });
});

test('结构异常（日期行 >1）**不带**空态标记：那是要人去看的，不许被这一类吞掉', () => {
  const gap = describeDateRowGap({
    rows: [['2026-10-05'], ['2026-10-04']], dateIndex: 0, reportDate: '2026-10-05', count: 2,
  });
  assert.equal(gap.includes(SOURCE_NO_ROW_FOR_DATE_TOKEN), false, `>1 行不许带空态标记：${gap}`);
  assert.match(gap, /exactly one daily date row/u);
  assert.match(gap, /日期行数=2/u, '结构异常同样要把现场值带出来');
});

test('extracts the date row and peer average from 当日询单人数', () => {
  const table = {
    headers: ['日期', '延 询单人数', '当日询单人数', '当日付款人数'],
    rows: [
      ['2026-09-15', '延迟统计', '14', '3'],
      ['同行同层优秀', '延迟统计', '72', '23'],
      ['同行同层均值', '延迟统计', '36', '7'],
    ],
  };
  assert.deepEqual(extractInquiryMetrics(table, '2026-09-15'),
    { inquiry: 14, peerInquiry: 36, peerBenchmark: 'PEER_AVAILABLE' });
  assert.throws(() => extractInquiryMetrics({ ...table,
    rows: [...table.rows, ['2026-09-14', '延迟统计', '10', '2']] }, '2026-09-15'), /exactly one daily/u);
});

test('rejects ambiguous headers, missing rows, and nonnumeric values', () => {
  assert.throws(() => extractInquiryMetrics({ headers: ['日期', '当日询单人数', '当日询单人数'], rows: [] },
    '2026-09-15'), /expected one header/u);
  assert.throws(() => extractInquiryMetrics({ headers: ['日期', '当日询单人数'], rows: [['2026-09-15', '-']] },
    '2026-09-15'), /benchmark row/u);
  assert.throws(() => extractInquiryMetrics({ headers: ['日期', '当日询单人数'], rows: [
    ['2026-09-15', '-'], ['同行同层均值', '36'],
  ] }, '2026-09-15'), /invalid 当日询单人数/u);
});

// 实测：自定义日期模式下 SYCM 只给 3 行，同行同层对比行不返回。
test('默认对缺失的同行基准 fail-closed，显式关闭才降级为 PEER_UNAVAILABLE', () => {
  const historical = {
    headers: ['日期', '当日询单人数', '当日付款人数'],
    rows: [['2026-09-14', '10', '1'], ['汇总值', '10', '1'], ['平均值', '10', '1']],
  };
  assert.throws(() => extractInquiryMetrics(historical, '2026-09-14'), /benchmark row/u);
  assert.deepEqual(extractInquiryMetrics(historical, '2026-09-14', { peerBenchmarkRequired: false }),
    { inquiry: 10, peerInquiry: null, peerBenchmark: 'PEER_UNAVAILABLE' });
  // 基准行出现两次属于源数据异常，任何模式下都要报错
  assert.throws(() => extractInquiryMetrics({ ...historical,
    rows: [...historical.rows, ['同行同层均值', '36', '7'], ['同行同层均值', '35', '7']] },
    '2026-09-14', { peerBenchmarkRequired: false }), /got 2/u);
});

test('selects exactly one Feishu row by date and shop', () => {
  const records = [
    { record_id: 'a', fields: { 日期: 1, 店铺: '盖文天猫' } },
    { record_id: 'b', fields: { 日期: 1, 店铺: '盖文淘宝' } },
  ];
  assert.equal(selectDailyStoreRecord(records, 1, '盖文天猫').record_id, 'a');
  assert.throws(() => selectDailyStoreRecord([...records, records[0]], 1, '盖文天猫'), /got 2/u);
  assert.throws(() => selectDailyStoreRecord(records, 2, '盖文天猫'), /got 0/u);
});

// --- findDailyStoreRow：认「店名」与「SingleSelect 选项 id」两种形态 -----------
//
// 这一组是 2026-09-29 那次真实故障的回归锁。当时 `mkt_singleselect_option_id` 这一支
// 在**生产里**是断的（`selectDailyStoreRecord` 只比店名，而表里 09-28 那 12 行存的是
// `optFFaXJeh`），函数级用例却全绿——因为用例只喂了店名形态的数据。
// 教训（本项目的第三条）：「函数级全绿 ≠ 接线接上了」。所以下面这条用例
// **逐字复制生产调用的入参形状**（对象里取 `.record`、以及传入的 optionId 来自选项表），
// 而不是造一个更宽松的夹具。
test('findDailyStoreRow 认店名形态，并报出候选数', () => {
  const records = [
    { record_id: 'a', fields: { 日期: 1790524800000, 店铺: '盖文天猫' } },
    { record_id: 'b', fields: { 日期: 1790524800000, 店铺: '盖文淘宝' } },
  ];
  const hit = findDailyStoreRow(records, 1790524800000, '盖文天猫');
  assert.equal(hit.record.record_id, 'a');
  assert.equal(hit.matchedBy, 'shop-name');
  assert.equal(hit.candidateCount, 1);

  const miss = findDailyStoreRow(records, 1790524800000, '科塔淘宝');
  assert.equal(miss.record, null);
  assert.equal(miss.matchedBy, null);
  assert.equal(miss.candidateCount, 0);
});

test('findDailyStoreRow 认选项 id 形态（09-28 那 12 行的真实形态）', () => {
  // 逐字取自 2026-09-29 OpenAPI 实读：`店铺` = optFFaXJeh，其选项名 = 盖文淘宝。
  const records = [
    { record_id: 'reczz28HKFEfqcpo', fields: { 日期: 1790524800000, 店铺: 'optFFaXJeh' } },
    { record_id: 'reczz28HKFEfoVac', fields: { 日期: 1790524800000, 店铺: 'optIYzOzu2' } },
  ];
  // 不传 optionId：行为与修复前逐字相同 —— 匹配不上，如实报 0 个。
  const blind = findDailyStoreRow(records, 1790524800000, '盖文淘宝');
  assert.equal(blind.record, null);
  assert.equal(blind.candidateCount, 0);

  // 传入由字段选项表反查出的 optionId 之后，命中同一行，并写明是靠 id 认出来的。
  const hit = findDailyStoreRow(records, 1790524800000, '盖文淘宝', { optionId: 'optFFaXJeh' });
  assert.equal(hit.record.record_id, 'reczz28HKFEfqcpo');
  assert.equal(hit.matchedBy, 'field-option-id');
  assert.equal(hit.candidateCount, 1);

  // **别家的 optionId 不许当成本店的 id 用**：这里 `optIYzOzu2` 是「盖文天猫」的选项 id，
  // 拿它去匹配「盖文淘宝」时，它既不是 `盖文淘宝` 这个店名、也不在 accepted 里
  // ⇒ 候选数必须是 0（否则就是「按 id 猜店」，会把别家那一行写坏）。
  // 只用 id 形态的行来验，免得被同名行干扰。
  const idOnly = [{ record_id: 'x', fields: { 日期: 1790524800000, 店铺: 'optIYzOzu2' } }];
  const wrong = findDailyStoreRow(idOnly, 1790524800000, '盖文淘宝', { optionId: 'optFFaXJeh' });
  assert.equal(wrong.candidateCount, 0);
  assert.equal(wrong.record, null);
});

test('findDailyStoreRow 同日同店两行时报 2 个候选（不挑一行写）', () => {
  const records = [
    { record_id: 'a', fields: { 日期: 7, 店铺: '科塔淘宝' } },
    { record_id: 'b', fields: { 日期: 7, 店铺: 'optnF3h5i7' } },
  ];
  const hit = findDailyStoreRow(records, 7, '科塔淘宝', { optionId: 'optnF3h5i7' });
  assert.equal(hit.record, null, '两行都算候选 ⇒ 不唯一 ⇒ 不许写');
  assert.equal(hit.candidateCount, 2);
});

test('allows only a blank write or an exact idempotent rerun', () => {
  const metrics = { inquiry: 14, peerInquiry: 36, peerBenchmark: 'PEER_AVAILABLE' };
  assert.equal(classifyInquiryWrite({}, metrics), 'WRITE_REQUIRED');
  assert.equal(classifyInquiryWrite({ 询单量: 14, 同层同行询单量: 36 }, metrics), 'ALREADY_VERIFIED');
  assert.throws(() => classifyInquiryWrite({ 询单量: 14 }, metrics), /not jointly blank/u);
  assert.throws(() => classifyInquiryWrite({ 询单量: 15, 同层同行询单量: 36 }, metrics), /not jointly blank/u);
  assert.throws(() => classifyInquiryWrite({ 询单量: 0 }, { inquiry: 0, peerInquiry: 0 }), /not jointly blank/u);
  assert.equal(classifyInquiryWrite({ 询单量: 0, 同层同行询单量: 0 },
    { inquiry: 0, peerInquiry: 0 }), 'ALREADY_VERIFIED');
});

test('降级写入只认「询单量」，且要求同行那一格保持空白', () => {
  const metrics = { inquiry: 10, peerInquiry: null, peerBenchmark: 'PEER_UNAVAILABLE' };
  assert.equal(classifyInquiryWrite({}, metrics), 'WRITE_REQUIRED');
  assert.equal(classifyInquiryWrite({ 询单量: 10, 同层同行询单量: null }, metrics), 'ALREADY_VERIFIED');
  // 重复运行必须是幂等的，而不是每次都抛错
  assert.equal(classifyInquiryWrite({ 询单量: '10' }, metrics), 'ALREADY_VERIFIED');
  assert.throws(() => classifyInquiryWrite({ 询单量: 11 }, metrics), /does not match source/u);
  // 降级模式下同行那一格若已有值，说明状态不可解释
  assert.throws(() => classifyInquiryWrite({ 询单量: 10, 同层同行询单量: 36 }, metrics), /is not blank/u);
});

// ---------------------------------------------------------------------------
// 行骨架：飞书侧「这一天的行还没建出来」（2026-10-07 修 ㉗）
// ---------------------------------------------------------------------------
// 2026-10-06 现场：8 家店前 9 步跑完（`push` 写底单全部成功），第 10 步 `backfill` 全报
// `expected one Feishu row for X / <epoch>, got 0`。根因是这张表的日期行由**运营侧预建**
// （只铺到 10-05），仓库里没有任何脚本会建行 —— 两句措辞把两种相反成因压成了一句：
//   · 源表空态（`SOURCE_NO_ROW_FOR_DATE`）＝ 谁都不用动，变不出来；
//   · 飞书缺行（`INQUIRY_ROW_MISSING`）＝ 建一行就好，**能自动修**。
test('两个标记不是同一个字符串：一个说「平台没有数」，一个说「飞书还没建行」', () => {
  assert.notEqual(INQUIRY_ROW_MISSING_TOKEN, SOURCE_NO_ROW_FOR_DATE_TOKEN);
  assert.equal(SOURCE_NO_ROW_FOR_DATE_TOKEN.includes(INQUIRY_ROW_MISSING_TOKEN), false,
    '一个标记不许是另一个的子串：链的分类器用 includes 判，子串会让两类互相命中');
  assert.equal(INQUIRY_ROW_MISSING_TOKEN.includes(SOURCE_NO_ROW_FOR_DATE_TOKEN), false);
});

test('缺行那句话带机器标记 + 现场值 + 处置（读证据的人不必再去翻代码）', () => {
  const gap = describeFeishuRowGap({ shop: '里可林淘宝', reportDate: '2026-10-06', reportDateEpoch: 1791216000000, candidateCount: 0 });
  assert.ok(gap.includes(INQUIRY_ROW_MISSING_TOKEN), `缺行要带标记，否则链会把它归回兜底：${gap}`);
  assert.match(gap, /"里可林淘宝"/u);
  assert.match(gap, /日期=2026-10-06/u);
  assert.match(gap, /候选行数=0/u);
  assert.match(gap, /ensure-inquiry-rows/u, '处置要写在错误里：它是唯一可自动执行的那一步');
});

test('同日同店多行**不带**缺行标记：那是相反的现场，混成一类会让人去补一行', () => {
  const gap = describeFeishuRowGap({ shop: '科塔淘宝', reportDate: '2026-10-06', reportDateEpoch: 1791216000000, candidateCount: 2 });
  assert.equal(gap.includes(INQUIRY_ROW_MISSING_TOKEN), false, `>1 行不许带缺行标记：${gap}`);
  assert.match(gap, /got 2/u);
  assert.match(gap, /需人核对/u);
});

test('shopOptionsOf / pickShopOptionId：从 API 返回的原始条目里取选项表', () => {
  // 形状逐字取自 `FeishuClient.listFieldItems()`（键是 snake_case 的 `field_name`，
  // 选项在 `property.options`）—— 2026-10-07 实测踩过一次「按驼峰读、结果全是 undefined」。
  const items = [
    { field_name: '日期', type: 5 },
    { field_name: '店铺', type: 3, property: { options: [
      { id: 'optRbz0AFD', name: '网林家居' },
      { id: 'optFFaXJeh', name: '盖文淘宝' },
      { name: '没有 id 的脏条目（要被滤掉）' },
    ] } },
  ];
  const options = shopOptionsOf(items, '店铺');
  assert.deepEqual(options.map((o) => o.name), ['网林家居', '盖文淘宝']);
  assert.equal(pickShopOptionId(options, '网林家居'), 'optRbz0AFD');
  // 找不到返回 null（**不抛**）：调用方要按「可降级」还是「fail-closed」自己决定
  assert.equal(pickShopOptionId(options, '科塔淘宝'), null);
  // 重名必须抛：两个 id 里挑一个就是猜，猜错会把别家的行写坏
  assert.throws(() => pickShopOptionId([...options, { id: 'optX', name: '网林家居' }], '网林家居'), /出现 2 次/u);
  // 字段不在 / 没给 options 都不许抛（读不到就退化成「没有选项表」）
  assert.deepEqual(shopOptionsOf([{ field_name: '日期', type: 5 }], '店铺'), []);
  assert.deepEqual(shopOptionsOf(null, '店铺'), []);
});

test('planInquiryRowSkeleton 把三堆分开：已建 / 要建 / 多行（多行不是「已建」）', () => {
  const epoch = 1791216000000;
  const records = [
    { record_id: 'r1', fields: { 日期: epoch, 店铺: '里可林淘宝' } },
    // 选项 id 形态：09-28 那批真实存在过的存法，建行与回填必须**同时**认得出来
    { record_id: 'r2', fields: { 日期: epoch, 店铺: 'optFFaXJeh' } },
    // 多行：同日同店两条
    { record_id: 'r3', fields: { 日期: epoch, 店铺: '科塔淘宝' } },
    { record_id: 'r4', fields: { 日期: epoch, 店铺: '科塔淘宝' } },
    // 别的日期不许算进来
    { record_id: 'r5', fields: { 日期: epoch - 86400000, 店铺: '网林天猫' } },
  ];
  const plan = planInquiryRowSkeleton({
    records, reportDateEpoch: epoch,
    shops: ['里可林淘宝', '盖文淘宝', '科塔淘宝', '网林天猫'],
    optionIdByShop: { 盖文淘宝: 'optFFaXJeh' },
  });
  assert.deepEqual(plan.present.map((item) => [item.shop, item.matchedBy]),
    [['里可林淘宝', 'shop-name'], ['盖文淘宝', 'field-option-id']]);
  assert.deepEqual(plan.missing, ['网林天猫']);
  assert.deepEqual(plan.duplicated, [{ shop: '科塔淘宝', candidateCount: 2 }]);
});

test('建行与回填用的是**同一个**匹配判据（两处各写一份 = 一边建一边回填不上）', () => {
  const epoch = 7;
  const records = [{ record_id: 'x', fields: { 日期: epoch, 店铺: 'optnF3h5i7' } }];
  // 不传选项 id：骨架判「缺」，而回填也认不出来 ⇒ 一致（这就是 09-28 之前的行为）
  assert.deepEqual(planInquiryRowSkeleton({ records, reportDateEpoch: epoch, shops: ['科塔淘宝'] }).missing, ['科塔淘宝']);
  assert.equal(findDailyStoreRow(records, epoch, '科塔淘宝').candidateCount, 0);
  // 传了选项 id：骨架判「已在」，回填也认得出来 ⇒ 一致
  assert.deepEqual(planInquiryRowSkeleton({
    records, reportDateEpoch: epoch, shops: ['科塔淘宝'], optionIdByShop: { 科塔淘宝: 'optnF3h5i7' },
  }).missing, []);
  assert.equal(findDailyStoreRow(records, epoch, '科塔淘宝', { optionId: 'optnF3h5i7' }).candidateCount, 1);
});

test('骨架空输入不崩（拿它算「全都没有」而不是「全都没查」）', () => {
  assert.deepEqual(planInquiryRowSkeleton({ records: [], reportDateEpoch: 1, shops: [] }),
    { present: [], missing: [], duplicated: [] });
  assert.deepEqual(planInquiryRowSkeleton(),
    { present: [], missing: [], duplicated: [] });
});
