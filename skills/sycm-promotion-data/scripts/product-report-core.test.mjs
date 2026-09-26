import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductReportUrl, uniqueNewProductTask, validateProductReportState } from './product-report-core.mjs';
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

test('只有商品报表、目标日期、双场景、30 天周期和商品+计划维度全匹配才放行', () => {
  const good = {
    href: buildProductReportUrl('2026-09-25'),
    text: '商品报表\n商品数据明细 数据范围为：2026-09-25至2026-09-25',
    triggers: ['关键词推广 人群推广', '末次点击归因', '30天累计数据', '昨日', '分天', '维度 商品'],
    dimensions: [{ value: 'promotion', checked: true }, { value: 'campaign', checked: true }],
  };
  assert.equal(validateProductReportState(good, '2026-09-25').ok, true);
  for (const [key, value] of [
    ['href', 'https://one.alimama.com/index.html#!/report/account?rptType=account'],
    ['triggers', ['全部营销场景', '末次点击归因', '30天累计数据', '昨日', '分日', '维度 商品']],
    ['dimensions', [{ value: 'promotion', checked: true }, { value: 'campaign', checked: false }]],
  ]) {
    assert.throws(() => validateProductReportState({ ...good, [key]: value }, '2026-09-25'));
  }
});

test('商品报表允许淘宝 76 列和天猫 78 列，拒绝营销场景 71 列', () => {
  const base = ['日期', '场景ID', '计划ID'];
  assert.equal(validatePromotionReport([...base, ...Array(73).fill('指标')], [['2026-09-25', 'onebpSearch', 'p', ...Array(73).fill('0')]]).columns, 76);
  assert.equal(validatePromotionReport([...base, ...Array(75).fill('指标')], [['2026-09-25', 'onebpSearch', 'p', ...Array(75).fill('0')]]).columns, 78);
  assert.throws(() => validatePromotionReport([...base, ...Array(68).fill('指标')], [['2026-09-25', 'onebpSearch', 'p', ...Array(68).fill('0')]]), /不支持的商品报表列数/u);
});

test('推广幂等键只包含报表行身份，不因指标变化而重复写入', () => {
  const headers = ['日期', '场景ID', '计划ID', '主体ID', '花费'];
  const first = ['2026-09-25', '371', 'plan-1', 'item-1', '12.3'];
  const changedMetrics = ['2026-09-25', '371', 'plan-1', 'item-1', '18.8'];
  assert.equal(promotionKey(first, headers), promotionKey(changedMetrics, headers));
  const existing = [{ fields: { 日期: Date.UTC(2026, 8, 25), 场景ID: 371, 计划ID: 'plan-1', 主体ID: 'item-1', 花费: 12.3 } }];
  assert.equal(planPromotionImport({ rows: [changedMetrics], existing, headers, targetNames: headers }).records.length, 0);
});

test('主体 ID 按目标文本字段保留字符串', async () => {
  const { buildPromotionFields } = await import('./promotion-core.mjs');
  const fields = buildPromotionFields(['主体ID', '展现量'], ['1067978768943', '12'], ['主体ID', '展现量']);
  assert.equal(fields['主体ID'], '1067978768943');
  assert.equal(fields['展现量'], 12);
});
