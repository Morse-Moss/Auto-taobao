import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROMOTION_KINDS, expectedUnits, receiptFacts, shopSubjectSets, judgePromotionCompleteness,
} from './promotion-completeness-core.mjs';
import { promotionDateTimestamp } from './promotion-daily-report-core.mjs';

// 夹具纪律（2b）：形状照抄真实现——receipt.json 的结构来自 import-promotion-daily-report.mjs
// 的落盘（tables.<kind>.{plannedRows, skippedRows, recordIds, subjectIds}），飞书记录形状来自
// FeishuClient.listRecords()（[{record_id, fields}]），「日期」字段的值＝promotionDateTimestamp。
// 人群归属模型（2026-10-15 实测钉死）：主体ID 是行级维度、一店多主体（5-11 个/店、跨店不相交），
// 店级归属＝「该店主体ID 集合」对当日行求和；集合唯一真实来源＝回执捕获的 subjectIds，
// 阿里妈妈会员ID 与主体ID 是不同标识空间、不可用于归属。
const DATE = '2026-10-14';
const TS = promotionDateTimestamp(DATE);

function receiptFor(shop, { keyword = null, audience = null, date = DATE } = {}) {
  const tables = {};
  if (keyword) tables.keyword = keyword;
  if (audience) tables.audience = audience;
  return { mode: 'apply', date, shop, tables };
}

function feishuRows(kind, rows) {
  return rows.map(([recordId, fields]) => ({ record_id: recordId, fields }));
}

test('expectedUnits：分母＝每店×两种报表，顺序稳定', () => {
  assert.deepEqual(expectedUnits({ shops: ['A店', 'B店'] }), [
    { shop: 'A店', kind: 'keyword' }, { shop: 'A店', kind: 'audience' },
    { shop: 'B店', kind: 'keyword' }, { shop: 'B店', kind: 'audience' },
  ]);
  assert.deepEqual(expectedUnits({ shops: [], kinds: PROMOTION_KINDS }), []);
});

test('receiptFacts：多份回执 recordIds/subjectIds 取并集、totalSourceRows 取最大（后一份常是全 skipped 的 0/0）', () => {
  const facts = receiptFacts([
    receiptFor('A店', { keyword: { plannedRows: 2, skippedRows: 0, recordIds: ['r1', 'r2'] } }),
    receiptFor('A店', { keyword: { plannedRows: 0, skippedRows: 2, recordIds: [] } }),
    receiptFor('B店', { audience: { plannedRows: 3, skippedRows: 1, recordIds: ['r3', 'r4', 'r5'], subjectIds: ['9002', '9001'] } }),
    receiptFor('B店', { audience: { plannedRows: 0, skippedRows: 4, recordIds: [], subjectIds: ['9003', '9002'] } }),
    { mode: 'apply', date: '2026-10-13', shop: 'C店', tables: { keyword: { plannedRows: 9, skippedRows: 0, recordIds: ['r9'] }, audience: { plannedRows: 9, skippedRows: 0, recordIds: ['r8'], subjectIds: ['7777'] } } },
  ], { date: DATE });
  const a = facts.find((f) => f.shop === 'A店' && f.kind === 'keyword');
  assert.equal(a.receipts, 2);
  assert.deepEqual(a.recordIds, ['r1', 'r2']);
  assert.deepEqual(a.subjectIds, []);
  assert.equal(a.totalSourceRows, 2, '0+0 那份不把总量冲成 0');
  const b = facts.find((f) => f.shop === 'B店' && f.kind === 'audience');
  assert.equal(b.totalSourceRows, 4);
  assert.deepEqual(b.subjectIds, ['9001', '9002', '9003'], 'subjectIds 跨回执取并集');
  assert.equal(facts.some((f) => f.shop === 'C店'), false, '别的业务日的回执不进本日事实');
});

test('shopSubjectSets：跨回执跨业务日并集（主体是店铺结构属性）；只收人群表', () => {
  const sets = shopSubjectSets([
    receiptFor('A店', { audience: { plannedRows: 1, skippedRows: 0, recordIds: ['a1'], subjectIds: ['111', '222'] } }),
    receiptFor('A店', { audience: { plannedRows: 1, skippedRows: 0, recordIds: ['a2'], subjectIds: ['333'] } }, { date: '2026-10-13' }),
    receiptFor('B店', { keyword: { plannedRows: 1, skippedRows: 0, recordIds: ['k1'], subjectIds: ['999'] } }),
    receiptFor('C店', { audience: { plannedRows: 1, skippedRows: 0, recordIds: [] } }),
  ]);
  assert.deepEqual(sets.A店, ['111', '222', '333'], '别的业务日的回执也贡献主体集合');
  assert.equal(sets.B店, undefined, '关键词表的同名列不收——归属映射只对人群表有意义');
  assert.equal(sets.C店, undefined, '没捕获 subjectIds 的回执不产映射');
});

test('judge：VERIFIED——keyword 靠 recordIds 独立回读；audience 靠「店主体集合」当日行数求和吻合（一店多主体是常态）', () => {
  const facts = receiptFacts([
    receiptFor('A店', {
      keyword: { plannedRows: 2, skippedRows: 0, recordIds: ['k1', 'k2'] },
      audience: { plannedRows: 3, skippedRows: 0, recordIds: ['a1', 'a2', 'a3'], subjectIds: ['1060913369469', '1071284033110'] },
    }),
  ]);
  const feishuRecords = {
    keyword: feishuRows('keyword', [['k1', { 日期: TS }], ['k2', { 日期: TS }]]),
    audience: feishuRows('audience', [
      ['a1', { 日期: TS, 主体ID: '1060913369469' }],
      ['a2', { 日期: TS, 主体ID: '1071284033110' }],
      ['a3', { 日期: TS, 主体ID: '1060913369469' }],
      ['x9', { 日期: TS, 主体ID: '别家主体' }],
    ]),
  };
  const verdict = judgePromotionCompleteness({
    date: DATE, units: expectedUnits({ shops: ['A店'] }), facts, feishuRecords,
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.gaps, []);
  for (const unit of verdict.units) assert.equal(unit.verdict, 'VERIFIED', `${unit.kind} 应 VERIFIED：${unit.why}`);
  const audience = verdict.units.find((u) => u.kind === 'audience');
  assert.equal(audience.verifiedRows, 3, '只数主体ID ∈ 本店集合的行，别家主体不计入');
});

test('judge：旧回执没捕获 subjectIds ⇒ 人群回退 recordIds 独立回读（同一纪律：只认独立回读）', () => {
  const facts = receiptFacts([receiptFor('A店', { audience: { plannedRows: 2, skippedRows: 0, recordIds: ['a1', 'a2'] } })]);
  const verdict = judgePromotionCompleteness({
    date: DATE, units: expectedUnits({ shops: ['A店'], kinds: ['audience'] }), facts,
    feishuRecords: { keyword: [], audience: feishuRows('audience', [['a1', { 日期: TS, 主体ID: '111' }], ['a2', { 日期: TS, 主体ID: '111' }]]) },
  });
  assert.equal(verdict.units[0].verdict, 'VERIFIED');
  assert.match(verdict.units[0].why, /recordIds 2 条在飞书独立回读全部命中/u);
});

test('judge：回执说写了但飞书回读缺行 ⇒ UNVERIFIED（收据也会假绿，只认独立回读）', () => {
  const facts = receiptFacts([receiptFor('A店', { keyword: { plannedRows: 2, skippedRows: 0, recordIds: ['k1', 'ghost'] } })]);
  const verdict = judgePromotionCompleteness({
    date: DATE, units: expectedUnits({ shops: ['A店'], kinds: ['keyword'] }), facts,
    feishuRecords: { keyword: feishuRows('keyword', [['k1', { 日期: TS }]]), audience: [] },
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.gaps[0].verdict, 'UNVERIFIED');
  assert.match(verdict.gaps[0].why, /1\/2 条在飞书不存在/u);
});

test('judge：无回执——人群有跨日主体集合可归属且当日有行 ⇒ VERIFIED；集合未知 ⇒ MISSING（如实报）', () => {
  const subjectSetsByShop = shopSubjectSets([
    receiptFor('A店', { audience: { plannedRows: 1, skippedRows: 0, recordIds: ['old1'], subjectIds: ['777'] } }, { date: '2026-10-13' }),
  ]);
  const verdict = judgePromotionCompleteness({
    date: DATE,
    units: expectedUnits({ shops: ['A店', 'B店'], kinds: ['audience'] }),
    facts: [],
    feishuRecords: { keyword: [], audience: feishuRows('audience', [['a1', { 日期: TS, 主体ID: '777' }]]) },
    subjectSetsByShop,
  });
  const byShop = Object.fromEntries(verdict.units.map((u) => [u.shop, u]));
  assert.equal(byShop.A店.verdict, 'VERIFIED');
  assert.match(byShop.A店.why, /无回执但飞书当日已有该店主体集合内的人群行/u);
  assert.equal(byShop.B店.verdict, 'MISSING');
  assert.equal(verdict.ok, false);
});

test('judge：关键词无回执 ⇒ MISSING（按店不可归属，缺回执无法区分没跑与为空——如实报）', () => {
  const verdict = judgePromotionCompleteness({
    date: DATE, units: expectedUnits({ shops: ['A店'], kinds: ['keyword'] }), facts: [],
    feishuRecords: { keyword: [], audience: [] },
  });
  assert.equal(verdict.units[0].verdict, 'MISSING');
  assert.match(verdict.units[0].why, /无法区分「没跑」与「平台为空」/u);
});

test('judge：回执实证 0 行 ⇒ ZERO_CONFIRMED——不算缺口、不算正常，交人工确认', () => {
  const facts = receiptFacts([receiptFor('A店', { keyword: { plannedRows: 0, skippedRows: 0, recordIds: [] } })]);
  const verdict = judgePromotionCompleteness({
    date: DATE, units: expectedUnits({ shops: ['A店'], kinds: ['keyword'] }), facts,
    feishuRecords: { keyword: [], audience: [] },
  });
  assert.equal(verdict.ok, true, '真实为空＝数据齐（不填 0 的纪律不变）');
  assert.equal(verdict.units[0].verdict, 'ZERO_CONFIRMED');
  assert.deepEqual(verdict.zeroRows.map((u) => `${u.shop}·${u.kind}`), ['A店·keyword']);
});

test('judge：人群「店主体集合」当日行数与回执不吻合 ⇒ MISMATCH（缺口）', () => {
  const facts = receiptFacts([receiptFor('A店', { audience: { plannedRows: 3, skippedRows: 0, recordIds: ['a1', 'a2', 'a3'], subjectIds: ['777'] } })]);
  const verdict = judgePromotionCompleteness({
    date: DATE, units: expectedUnits({ shops: ['A店'], kinds: ['audience'] }), facts,
    feishuRecords: { keyword: [], audience: feishuRows('audience', [['a1', { 日期: TS, 主体ID: '777' }]]) },
  });
  assert.equal(verdict.gaps[0].verdict, 'MISMATCH');
  assert.match(verdict.gaps[0].why, /1 ≠ 回执源行数 3/u);
});

test('judge：关键词本轮全为已存在行（无新 recordIds）⇒ 退到轮级行数对账，吻合则 VERIFIED_BY_ROUND_COUNT', () => {
  const facts = receiptFacts([
    receiptFor('A店', { keyword: { plannedRows: 0, skippedRows: 4, recordIds: [] } }),
    receiptFor('B店', { keyword: { plannedRows: 0, skippedRows: 6, recordIds: [] } }),
  ]);
  const keywordRows = feishuRows('keyword', Array.from({ length: 10 }, (_, i) => [`k${i}`, { 日期: TS }]));
  const verdict = judgePromotionCompleteness({
    date: DATE, units: expectedUnits({ shops: ['A店', 'B店'], kinds: ['keyword'] }), facts,
    feishuRecords: { keyword: keywordRows, audience: [] },
  });
  assert.equal(verdict.ok, true);
  assert.ok(verdict.units.every((u) => u.verdict === 'VERIFIED_BY_ROUND_COUNT'), '整表 10 行＝各店回执源行数总和');
  assert.equal(verdict.roundCounts.keywordDateRows, 10);
  assert.equal(verdict.roundCounts.keywordReceiptSum, 10);
});

test('judge：人群本轮全为已存在行且无 subjectIds ⇒ 同样退到轮级行数对账（两张表各自对）', () => {
  const facts = receiptFacts([
    receiptFor('A店', { audience: { plannedRows: 0, skippedRows: 4, recordIds: [] } }),
    receiptFor('B店', { audience: { plannedRows: 0, skippedRows: 6, recordIds: [] } }),
  ]);
  const audienceRows = feishuRows('audience', Array.from({ length: 10 }, (_, i) => [`a${i}`, { 日期: TS, 主体ID: `s${i}` }]));
  const verdict = judgePromotionCompleteness({
    date: DATE, units: expectedUnits({ shops: ['A店', 'B店'], kinds: ['audience'] }), facts,
    feishuRecords: { keyword: [], audience: audienceRows },
  });
  assert.equal(verdict.ok, true);
  assert.ok(verdict.units.every((u) => u.verdict === 'VERIFIED_BY_ROUND_COUNT'), '整表当日 10 行＝各店人群回执源行数总和');
  assert.equal(verdict.roundCounts.audienceDateRows, 10);
  assert.equal(verdict.roundCounts.audienceReceiptSum, 10);
});

test('judge：别的日期的行不计入当日对账（日期时间戳按 promotionDateTimestamp 对齐）', () => {
  const otherTs = promotionDateTimestamp('2026-10-13');
  const facts = receiptFacts([receiptFor('A店', { keyword: { plannedRows: 1, skippedRows: 0, recordIds: ['k1'] } })]);
  const verdict = judgePromotionCompleteness({
    date: DATE, units: expectedUnits({ shops: ['A店'], kinds: ['keyword'] }), facts,
    feishuRecords: { keyword: feishuRows('keyword', [['k1', { 日期: otherTs }]]), audience: [] },
  });
  // k1 在表里（record_id 命中）但日期是前一天 —— recordIds 维度仍算写进去了；
  // 本用例钉的是「轮级 dateKeywordRows 不把昨天的行算进今天」。
  assert.equal(verdict.roundCounts.keywordDateRows, 0);
});

// 接线守卫（源码级）：对账门人群归属的唯一真实来源＝回执里的 subjectIds，必须由导入器
// 从该店 CSV 表头实测「主体ID」列捕获（一店多主体是常态；列不存在记空数组，不猜）。
// 扫描目标＝import-promotion-daily-report.mjs 的回执落盘点。
test('导入器捕获主体ID（源码级）：回执 tables.<kind> 必须落 subjectIds', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./import-promotion-daily-report.mjs', import.meta.url), 'utf8');
  assert.match(src, /source\.headers\.indexOf\('主体ID'\)/u, '必须从 CSV 表头实测「主体ID」列，不许换猜的来源');
  assert.match(src, /skippedRows: source\.rows\.length - planned\.length, subjectIds \}/u,
    'receipt.tables[kind] 落盘必须带 subjectIds——对账门人群归属只认这个字段');
});

// 接线守卫（源码级）：对账门 CLI 禁止接阿里妈妈会员ID 做人群归属——会员ID 与主体ID 是
// 不同标识空间（2026-10-15 实跑：用会员ID 把 5 家全部判成 MISMATCH），归属只认回执 subjectIds。
test('对账门人群归属来源（源码级）：只认回执 subjectIds，禁止接会员ID', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./check-promotion-completeness.mjs', import.meta.url), 'utf8');
  assert.equal(src.includes('alimamaMemberId'), false, '会员ID 与主体ID 是不同标识空间，不可用于人群归属');
  assert.match(src, /shopSubjectSets\(allReceipts\)/u, '归属映射唯一来源＝回执捕获的 subjectIds（含跨日回执）');
});
