import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductReportUrl, reuseCandidateTask, uniqueNewProductTask, validateProductReportState } from './product-report-core.mjs';
import { planPromotionImport, promotionKey, validatePromotionReport } from './promotion-core.mjs';

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

test('商品报表允许淘宝 76 列和天猫 78 列，拒绝营销场景 71 列', () => {
  const base = ['日期', '场景ID', '计划ID'];
  assert.equal(validatePromotionReport([...base, ...Array(73).fill('指标')], [['2026-09-25', 'onebpSearch', 'p', ...Array(73).fill('0')]]).columns, 76);
  assert.equal(validatePromotionReport([...base, ...Array(75).fill('指标')], [['2026-09-25', 'onebpSearch', 'p', ...Array(75).fill('0')]]).columns, 78);
  assert.throws(() => validatePromotionReport([...base, ...Array(68).fill('指标')], [['2026-09-25', 'onebpSearch', 'p', ...Array(68).fill('0')]]), /不支持的商品报表列数/u);
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
