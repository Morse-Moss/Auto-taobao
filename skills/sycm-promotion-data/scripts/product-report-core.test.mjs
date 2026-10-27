import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductReportUrl, pickFetchCandidates, pollNewProductTask, reuseCandidateTask, taskDateRangeOf, uniqueNewProductTask, validateProductReportState } from './product-report-core.mjs';
import { planPromotionImport, promotionKey, validatePromotionReport } from './promotion-core.mjs';

/** 依次吐出给定列表；允许多读（读完最后一个就一直重复它），并数出被读了几次。 */
function mkSequenceReader(pages) {
  let i = 0;
  const read = async () => pages[Math.min(i++, pages.length - 1)];
  read.calls = () => i;
  return read;
}

test('商品报表 URL 固定到目标日、30 天累计和两个推广场景', () => {
  const url = new URL(buildProductReportUrl('2026-09-25'));
  const params = new URLSearchParams(url.hash.split('?')[1]);
  assert.match(url.hash, /^#!\/report\/item_promotion/u);
  assert.equal(params.get('rptType'), 'item_promotion');
  assert.equal(params.get('startTime'), '2026-09-25');
  assert.equal(params.get('endTime'), '2026-09-25');
  assert.equal(params.get('effectEqual'), '30');
  assert.deepEqual(JSON.parse(params.get('bizCodeIn')), ['onebpSearch', 'onebpDisplay']);
  assert.equal(params.get('granularity'), 'day');
});

test('商品报表任务只接受下载前后列表差集里的唯一新任务', () => {
  assert.equal(uniqueNewProductTask(['商品报表_20260926_164524'], ['商品报表_20260926_175814', '商品报表_20260926_164524']), '商品报表_20260926_175814');
  assert.throws(() => uniqueNewProductTask([], ['商品报表_20260926_164524', '商品报表_20260926_165316']), /无法唯一确认/u);
});

// 同业务日重跑：平台对**相同参数**重复提交不再生成新任务 ⇒ added=[] ⇒ uniqueNewProductTask 抛错。
// 这不是采集失败（平台早就把这份报表交过了），2026-10-17 真机发作过一次
// （里可林淘宝/推广：10:13 交过「10-16」、11:09 再交，任务列表逐项相同）。
test('同日重跑复用平台已在册的当日任务，取最晚一个', () => {
  const tasks = ['商品报表_20261017_101352', '商品报表_20261017_090000', '商品报表_20261016_150756'];
  // 名字里的日期是**提交当天**，不是数据日 ⇒ 只按「今天」前缀筛，绝不能跨天兜底
  assert.equal(reuseCandidateTask({ after: tasks, submittedOn: '2026-10-17' }), '商品报表_20261017_101352');
  assert.equal(reuseCandidateTask({ after: tasks, submittedOn: '2026-10-16' }), '商品报表_20261016_150756');
  // 今天一份都没有 ⇒ null（调用方要抛原来那条「无法唯一确认」，不许拿昨天的顶）
  assert.equal(reuseCandidateTask({ after: tasks, submittedOn: '2026-10-18' }), null);
  // 非商品报表名字/形状不合规的一律不算候选
  assert.equal(reuseCandidateTask({ after: ['商品报表_20261017_1013', '其它报表_20261017_101352', '商品报表_20261017101352'], submittedOn: '2026-10-17' }), null);
  // 日期形状不对 ⇒ 抛错，不许静默当成「没有候选」（YYYYMMDD 这种已经收窄过的形状是允许的）
  assert.throws(() => reuseCandidateTask({ after: tasks, submittedOn: '2026/10/17' }), /需要提交当天日期/u);
  assert.throws(() => reuseCandidateTask({ after: tasks, submittedOn: '2026-1-7' }), /需要提交当天日期/u);
  assert.throws(() => reuseCandidateTask({ after: tasks }), /需要提交当天日期/u);
});

test('只有商品报表、目标日期、双场景、30 天周期和商品+计划维度全匹配才放行', () => {
  const good = {
    href: buildProductReportUrl('2026-09-25'),
    text: '商品报表\n商品数据明细 数据范围为：2026-09-25至2026-09-25',
    triggers: ['关键词推广 人群推广', '末次点击归因', '30天累计数据', '昨日', '分天', '维度 商品'],
    dimensions: [{ value: 'promotion', checked: true }, { value: 'campaign', checked: true }],
  };
  assert.equal(validateProductReportState(good, '2026-09-25').ok, true);
  // 回填历史日：目标日不是「昨日」，数据汇总周期触发器回显具体日期而不是「昨日」
  // （SOP §回填历史日；2026-10-16 盖文天猫真机 locate-only 实测：startTime=2026-10-14 时触发器就是 2026-10-14）
  const backfill = {
    ...good,
    href: buildProductReportUrl('2026-10-08'),
    text: '商品报表\n商品数据明细 数据范围为：2026-10-08至2026-10-08',
    triggers: ['关键词推广 人群推广', '末次点击归因', '30天累计数据', '2026-10-08', '分天', '维度 商品'],
  };
  assert.equal(validateProductReportState(backfill, '2026-10-08').ok, true);
  for (const [key, value] of [
    ['href', 'https://one.alimama.com/index.html#!/report/account?rptType=account'],
    ['triggers', ['全部营销场景', '末次点击归因', '30天累计数据', '昨日', '分日', '维度 商品']],
    ['dimensions', [{ value: 'promotion', checked: true }, { value: 'campaign', checked: false }]],
  ]) {
    assert.throws(() => validateProductReportState({ ...good, [key]: value }, '2026-09-25'));
  }
  // 日期既不是「昨日」也不是目标日 ⇒ 未落定，仍要 fail-closed
  assert.throws(() => validateProductReportState(
    { ...backfill, triggers: ['关键词推广 人群推广', '末次点击归因', '30天累计数据', '2026-10-07', '分天', '维度 商品'] },
    '2026-10-08',
  ), /日期未落定/u);
});

test('商品报表允许 76/78 列基线宽度，拒绝营销场景 71 列（80/81 见下一条）', () => {
  const base = ['日期', '场景ID', '计划ID'];
  assert.equal(validatePromotionReport([...base, ...Array(73).fill('指标')], [['2026-09-25', 'onebpSearch', 'p', ...Array(73).fill('0')]]).columns, 76);
  assert.equal(validatePromotionReport([...base, ...Array(75).fill('指标')], [['2026-09-25', 'onebpSearch', 'p', ...Array(75).fill('0')]]).columns, 78);
  assert.throws(() => validatePromotionReport([...base, ...Array(68).fill('指标')], [['2026-09-25', 'onebpSearch', 'p', ...Array(68).fill('0')]]), /不支持的商品报表列数/u);
});

// 80/81 列（2026-10-27 加）：销售2部换号重登后平台多给了新指标列，旧白名单把整批打掉。
// 现场 zip：商品报表_20261027_103858.zip(80)、商品报表_20261027_104205.zip(81)。
// 真表头结构：80 = 78 ＋ 尾部「补贴引导成交新客数/补贴引导成交笔数」；
//            81 = 78 ＋ 中部「平台助推总成交/平台助推直接成交/平台助推点击」。
test('商品报表 80/81 列带签名列时放行，长度对但签名列缺失一律拒绝', () => {
  const head80 = ['日期', '场景ID', '原二级场景ID', '计划ID', ...Array(74).fill('指标'), '补贴引导成交新客数', '补贴引导成交笔数'];
  const row80 = (date) => [date, 'onebpSearch', '371', 'plan-1', ...Array(74).fill('0'), '2', '3'];
  assert.equal(head80.length, 80);
  assert.equal(validatePromotionReport(head80, [row80('2026-10-26')], { date: '2026-10-26' }).columns, 80);

  const head81 = ['日期', '场景ID', '原二级场景ID', '计划ID', ...Array(74).fill('指标'), '平台助推总成交', '平台助推直接成交', '平台助推点击'];
  const row81 = (date) => [date, 'onebpSearch', '371', 'plan-1', ...Array(74).fill('0'), '1', '2', '3'];
  assert.equal(head81.length, 81);
  assert.equal(validatePromotionReport(head81, [row81('2026-10-26')], { date: '2026-10-26' }).columns, 81);

  // 长度恰好 80，但签名列被换成普通指标 ⇒ 不能放行（否则按名映射会静默漏写补贴字段）
  const fake80 = ['日期', '场景ID', '原二级场景ID', '计划ID', ...Array(76).fill('指标')];
  assert.equal(fake80.length, 80);
  assert.throws(
    () => validatePromotionReport(fake80, [['2026-10-26', 'onebpSearch', '371', 'plan-1', ...Array(76).fill('0')]], { date: '2026-10-26' }),
    /缺少该宽度的签名列: 补贴引导成交新客数、补贴引导成交笔数/u,
  );

  // 81 列的签名列只缺一个也要拦（三列平台助推是一个整体，缺一即说明表结构变了）
  const almost81 = [...head81.slice(0, 80), '指标'];
  assert.equal(almost81.length, 81);
  assert.throws(
    () => validatePromotionReport(almost81, [row81('2026-10-26')], { date: '2026-10-26' }),
    /缺少该宽度的签名列: 平台助推点击/u,
  );

  // 相邻但未登记的宽度仍然拒绝（fail-closed 不放宽）
  for (const width of [77, 79, 82]) {
    const headers = ['日期', '场景ID', '计划ID', ...Array(width - 3).fill('指标')];
    const row = ['2026-10-26', 'onebpSearch', 'plan-1', ...Array(width - 3).fill('0')];
    assert.throws(() => validatePromotionReport(headers, [row], { date: '2026-10-26' }), /不支持的商品报表列数/u, `${width} 列不该被放行`);
  }
});

// 逐行日期钉死（2026-10-17 加）：复用平台任务时任务名看不出参数，CSV 里却可能是**别的日期**；
// 而幂等键含日期 ⇒ 错日期的行会被当成「新数据」整批写进去，收据上看不出任何异常。
test('商品报表逐行校验数据日期等于目标日，错日期一律拒绝', () => {
  const headers = ['日期', '场景ID', '计划ID', ...Array(73).fill('指标')];
  const row = (date) => [date, '371', 'plan-1', ...Array(73).fill('0')];
  assert.equal(validatePromotionReport(headers, [row('2026-10-16'), row('2026-10-16')], { date: '2026-10-16' }).rows, 2);
  assert.throws(() => validatePromotionReport(headers, [row('2026-10-16'), row('2026-10-15')], { date: '2026-10-16' }), /数据日期不是目标日 2026-10-16/u);
  // 一行都不许漏：只有一行且是错的也要拦
  assert.throws(() => validatePromotionReport(headers, [row('2026-10-15')], { date: '2026-10-16' }), /第1行是 "2026-10-15"/u);
  // 空日期也算不匹配（不能用「空就是没限制」放过去）
  assert.throws(() => validatePromotionReport(headers, [row('')], { date: '2026-10-16' }), /数据日期不是目标日/u);
  // 不传 date ⇒ 保持原有列数/行长校验语义（其它调用方不吃这条新约束）
  assert.equal(validatePromotionReport(headers, [row('2026-10-15')]).rows, 1);
});

test('推广幂等键只包含报表行身份，不因指标变化而重复写入', () => {
  const headers = ['日期', '场景ID', '计划ID', '主体ID', '花费'];
  const first = ['2026-09-25', '371', 'plan-1', 'item-1', '12.3'];
  const changedMetrics = ['2026-09-25', '371', 'plan-1', 'item-1', '18.8'];
  assert.equal(promotionKey(first, headers), promotionKey(changedMetrics, headers));
  const existing = [{ fields: { 日期: Date.UTC(2026, 8, 25) - 8 * 3600 * 1000, 场景ID: 371, 计划ID: 'plan-1', 主体ID: 'item-1', 花费: 12.3 } }]; // 日期＝北京时间零点，与 buildPromotionFields 的写法一致
  assert.equal(planPromotionImport({ rows: [changedMetrics], existing, headers, targetNames: headers }).records.length, 0);
});

test('主体 ID 按目标文本字段保留字符串', async () => {
  const { buildPromotionFields } = await import('./promotion-core.mjs');
  const fields = buildPromotionFields(['主体ID', '展现量'], ['1067978768943', '12'], ['主体ID', '展现量']);
  assert.equal(fields['主体ID'], '1067978768943');
  assert.equal(fields['展现量'], 12);
});

// ---- 取件候选集（2026-10-18）：补提交搬过来之后的判据 ----
// 这一组钉的是「换通道」的地基：候选**只认日期范围等于目标日**，读不到日期范围才退回「提交当天」。
// 判据错了的后果不是报错，而是**静默拿别天的数据**（任务名里没有业务日），所以每一条都要能红。

test('日期范围：从任务行原文里读得出起止日，读不到就返回 null（不猜）', () => {
  assert.deepEqual(taskDateRangeOf('商品报表_20261018_101216 2026-10-17至2026-10-17 生成成功'),
    { start: '2026-10-17', end: '2026-10-17' });
  assert.deepEqual(taskDateRangeOf('营销场景报表 2026-10-04 ~ 2026-10-05'), { start: '2026-10-04', end: '2026-10-05' });
  assert.equal(taskDateRangeOf('商品报表_20261018_101216 生成成功'), null);
  assert.equal(taskDateRangeOf(''), null);
  // 单个日期不算日期范围：只看到一个日期就认，会把「开始日」当范围
  assert.equal(taskDateRangeOf('2026-10-17 生成成功'), null);
});

test('候选集：日期范围等于目标日的行才进候选，别天的一条都不许混进来', () => {
  const rows = [
    { name: '商品报表_20261018_101216', text: '商品报表_20261018_101216 2026-10-17至2026-10-17 生成成功' },
    { name: '商品报表_20261018_101300', text: '商品报表_20261018_101300 2026-10-17至2026-10-17 生成成功' },
    { name: '商品报表_20261017_101352', text: '商品报表_20261017_101352 2026-10-16至2026-10-16 生成成功' },
  ];
  const picked = pickFetchCandidates({ rows, date: '2026-10-17', submittedOn: '2026-10-18' });
  assert.equal(picked.basis, 'date-range');
  // 新的在前：补提交出来的那条比老的更可能正常渲染
  assert.deepEqual(picked.candidates, ['商品报表_20261018_101300', '商品报表_20261018_101216']);
  assert.equal(picked.ignoredCount, 1);
});

test('候选集：本次提交当场确认过的任务名无论日期范围都排第一（它最可信）', () => {
  const rows = [
    { name: '商品报表_20261018_101300', text: '商品报表_20261018_101300 2026-10-17至2026-10-17 生成成功' },
    { name: '商品报表_20261018_101216', text: '商品报表_20261018_101216 2026-10-17至2026-10-17 生成成功' },
  ];
  const picked = pickFetchCandidates({ rows, date: '2026-10-17', submittedOn: '2026-10-18', submittedTask: '商品报表_20261018_101200' });
  assert.equal(picked.candidates[0], '商品报表_20261018_101200');
  assert.equal(picked.candidates.length, 3);
});

test('候选集：读不到日期范围时退回「提交当天」，且只认提交当天（不是业务日）', () => {
  const rows = [
    { name: '商品报表_20261018_101216', text: '商品报表_20261018_101216 生成成功' },
    { name: '商品报表_20261017_101352', text: '商品报表_20261017_101352 生成成功' },
  ];
  const picked = pickFetchCandidates({ rows, date: '2026-10-17', submittedOn: '2026-10-18' });
  assert.equal(picked.basis, 'submitted-day');
  assert.deepEqual(picked.candidates, ['商品报表_20261018_101216']);
  assert.equal(picked.ignoredCount, 1);
  // 反面：拿业务日当提交日筛 ⇒ 永远只筛到「昨天交的」那条，今天补提交出来的反而不在候选里
  const wrong = pickFetchCandidates({ rows, date: '2026-10-17', submittedOn: '2026-10-17' });
  assert.deepEqual(wrong.candidates, ['商品报表_20261017_101352']);
});

test('候选集：提交当天日期缺失就抛（不静默退化成空候选）', () => {
  const rows = [{ name: '商品报表_20261018_101216', text: '商品报表_20261018_101216 生成成功' }];
  assert.throws(() => pickFetchCandidates({ rows, date: '2026-10-17', submittedOn: undefined }), /提交当天日期/u);
  assert.throws(() => pickFetchCandidates({ rows, date: '2026-10-17', submittedOn: '2026/10/18' }), /提交当天日期/u);
});

test('候选集：一条都不合格时返回空数组（由调用方决定补提交），不抛也不凑数', () => {
  const rows = [{ name: '商品报表_20261017_101352', text: '商品报表_20261017_101352 2026-10-16至2026-10-16 生成成功' }];
  const picked = pickFetchCandidates({ rows, date: '2026-10-17', submittedOn: '2026-10-18' });
  assert.equal(picked.basis, 'date-range');
  assert.deepEqual(picked.candidates, []);
});

// ---------------------------------------------------------------- 提交后轮询（2026-10-19）
//
// 真事：2026-10-19 网林家居/推广「提交后 before 与 after 逐项相同、added=[]」。
// 当时的实现是「跳下载列表 → 睡死 5 秒 → 只读一次」，于是「读得太早」和
// 「平台真没受理」在证据上长得一模一样（现场取证又恰好失败）。
// 这一族判据钉住轮询的三条性质：出现即返回、超时不抛、差集口径与 uniqueNewProductTask 一致。

test('提交后轮询：新任务一出现立刻返回，不为等满超时而空转', async () => {
  let t = 1000;
  const read = mkSequenceReader([
    ['商品报表_20261018_103036'],
    ['商品报表_20261018_103036'],
    ['商品报表_20261019_102512', '商品报表_20261018_103036'],
    ['不该再读第四次'],
  ]);
  const got = await pollNewProductTask({
    before: ['商品报表_20261018_103036'], read,
    timeoutMs: 30000, intervalMs: 2000,
    delay: async (ms) => { t += ms; }, now: () => t,
  });
  assert.equal(got.timedOut, false);
  assert.deepEqual(got.added, ['商品报表_20261019_102512']);
  assert.equal(got.reads, 3, `出现后必须停读，实际读了 ${got.reads} 次`);
});

test('提交后轮询：超时不抛，把最后一次读到的列表交回去（由调用方按既有语义判）', async () => {
  let t = 0;
  const read = mkSequenceReader([['商品报表_20261018_103036']]);
  const got = await pollNewProductTask({
    before: ['商品报表_20261018_103036'], read,
    timeoutMs: 5000, intervalMs: 2000,
    delay: async (ms) => { t += ms; }, now: () => t,
  });
  assert.equal(got.timedOut, true);
  assert.deepEqual(got.added, []);
  assert.deepEqual(got.after, ['商品报表_20261018_103036']);
  assert.ok(got.reads >= 2, `轮询次数 ${got.reads} 太少，等同没轮询`);
});

test('提交后轮询：before 里已有的名字永远不算新任务（差集口径与 uniqueNewProductTask 一致）', async () => {
  let t = 0;
  const read = mkSequenceReader([
    ['商品报表_20261018_103036', '商品报表_20261018_103036'],
    ['商品报表_20261018_103036'],
  ]);
  const got = await pollNewProductTask({
    before: ['商品报表_20261018_103036'], read,
    timeoutMs: 2000, intervalMs: 1000,
    delay: async (ms) => { t += ms; }, now: () => t,
  });
  assert.equal(got.timedOut, true);
  assert.deepEqual(got.added, []);
});

test('提交后轮询：没给 read 就抛（不许静默当成「平台没生成」）', async () => {
  await assert.rejects(() => pollNewProductTask({ before: [] }), /需要 read\(\)/u);
  await assert.rejects(() => pollNewProductTask({ before: [], read: async () => [], timeoutMs: -1 }), /必须是负数|必须是非负数/u);
});
