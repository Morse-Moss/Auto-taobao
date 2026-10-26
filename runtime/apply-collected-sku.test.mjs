// 自采 SKU 写入器的计划与比较逻辑测试（2026-10-26）。
//
// 这里钉的是「写不写、写多少」的判定，不是网络行为：
//   buildPlan 决定哪些行进 toCreate，
//   normalizeField 决定「飞书读回来的形状」与「写入形状」能不能比。
// 后者最容易出错：关系字段读回来是 [{record_ids:[...]}]，写入是 ['recId']，
// 如果不归一化，所有已有行都会被判成「内容不同」而遭到误判。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertApprovedClass,
  buildPlan,
  chunk,
  classOf,
  fieldsEqual,
  normalizeField,
} from './apply-collected-sku.mjs';

const row = (overrides = {}) => ({
  商品ID: '597600994634',
  商品标题: '小户型浴缸',
  竞品分类: 'B-高价值竞品',
  SKU名称: '哑光白',
  SKU规格: '颜色分类=哑光白',
  SKU尺寸: '1.5m',
  尺寸汇总: '1.3m-1.8m',
  适用空间: '常规卫生间',
  空间判定状态: '已判定',
  空间判定依据: 'SKU 尺寸标准化为1.5m；规则=1.3m-1.8m',
  采集状态: '已采集',
  商品链接: 'https://detail.tmall.com/item.htm?id=597600994634',
  SKU唯一键: '597600994634|1',
  所属竞品: ['recMain'],
  ...overrides,
});

// ---------------------------------------------------------------------------
// 形状归一化
// ---------------------------------------------------------------------------

test('关系字段：读回来的对象数组与写入的字符串数组视为相同', () => {
  const read = [{ record_ids: ['recMain'], table_id: 'tbl', text: '1', type: 'text' }];
  assert.deepEqual(normalizeField('所属竞品', read), ['recMain']);
  assert.deepEqual(normalizeField('所属竞品', ['recMain']), ['recMain']);
  assert.ok(fieldsEqual('所属竞品', read, ['recMain']));
});

test('多选字段：读回来的 {text} 对象与写入的字符串视为相同', () => {
  const read = [{ text: '空间判定' }];
  assert.deepEqual(normalizeField('待补数据项', read), ['空间判定']);
  assert.ok(fieldsEqual('待补数据项', read, ['空间判定']));
  // 顺序不该影响判定
  assert.ok(fieldsEqual('待补数据项', ['a', 'b'], ['b', 'a']));
});

test('URL 字段读回来是 {link,text}，比较要认 link', () => {
  const read = { link: 'https://detail.tmall.com/item.htm?id=597600994634', text: '商品' };
  assert.ok(fieldsEqual('商品链接', read, 'https://detail.tmall.com/item.htm?id=597600994634'));
});

test('空串与缺失归一 —— 写空串进飞书会存成 null，不归一就会虚报差异', () => {
  // 2026-10-26 实测：244 行 SKU尺寸 为空的行被误判成「内容不同」，
  // 就是因为写入是 ''、读回是 null。
  assert.ok(fieldsEqual('SKU尺寸', null, ''));
  assert.ok(fieldsEqual('SKU尺寸', undefined, '   '));
  assert.ok(fieldsEqual('待补数据项', null, []));
  assert.ok(fieldsEqual('SKU尺寸', null, null));
  // 真的不同还得判不同
  assert.ok(!fieldsEqual('SKU尺寸', '1.5m', ''));
});

// ---------------------------------------------------------------------------
// 计划
// ---------------------------------------------------------------------------

test('buildPlan：目标表没有该唯一键 → toCreate', () => {
  const plan = buildPlan({
    itemRows: [{ source: { itemId: '597600994634' }, rows: [row()] }],
    existingByKey: new Map(),
  });
  assert.equal(plan.summary.toCreate, 1);
  assert.equal(plan.summary.writeReady, true);
  assert.equal(plan.toCreate[0].SKU唯一键, '597600994634|1');
});

test('buildPlan：已存在且完全一致 → alreadyPresent，不重复建', () => {
  const existing = new Map([['597600994634|1', { recordId: 'recOld', fields: row({ 所属竞品: [{ record_ids: ['recMain'] }] }) }]]);
  const plan = buildPlan({
    itemRows: [{ source: { itemId: '597600994634' }, rows: [row()] }],
    existingByKey: existing,
  });
  assert.equal(plan.summary.alreadyPresent, 1);
  assert.equal(plan.summary.toCreate, 0);
  // 没有要建的行时不算就绪，避免空跑一次写请求。
  assert.equal(plan.summary.writeReady, false);
});

test('buildPlan：已存在但内容不同 → 跳过并记录差异字段，绝不覆盖', () => {
  const existing = new Map([['597600994634|1', { recordId: 'recOld', fields: row({ SKU尺寸: '1.6m' }) }]]);
  const plan = buildPlan({
    itemRows: [{ source: { itemId: '597600994634' }, rows: [row()] }],
    existingByKey: existing,
  });
  assert.equal(plan.summary.existingKeptDiffers, 1);
  assert.equal(plan.summary.toCreate, 0, '已存在的行不进 toCreate，所以不会被覆盖');
  const detail = plan.items[0];
  assert.equal(detail.action, 'existingKeptDiffers');
  assert.deepEqual(detail.differs, ['SKU尺寸']);
  assert.equal(detail.recordId, 'recOld');
});

test('buildPlan：同一唯一键出现两次 → 未就绪（去重应在更上游完成）', () => {
  const dup = row();
  const plan = buildPlan({
    itemRows: [{ source: { itemId: '597600994634' }, rows: [dup, { ...dup }] }],
    existingByKey: new Map(),
  });
  assert.equal(plan.summary.toCreate, 2);
  assert.equal(plan.summary.writeReady, false);
});

// ---------------------------------------------------------------------------
// 分批
// ---------------------------------------------------------------------------

test('chunk 按 400 切批，最后一批取余数', () => {
  const rows = Array.from({ length: 1618 }, (_, i) => ({ i }));
  const batches = chunk(rows);
  assert.equal(batches.length, 5);
  assert.deepEqual(batches.map((b) => b.length), [400, 400, 400, 400, 18]);
});

test('chunk 不修改原数组', () => {
  const rows = [{ i: 1 }, { i: 2 }];
  chunk(rows, 1);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows, [{ i: 1 }, { i: 2 }]);
});

// ---------------------------------------------------------------------------
// 竞品分类取值：公式字段返回数组，直接 String() 会把 1618 行写成 "[object Object]"
// ---------------------------------------------------------------------------

test('classOf 展开公式字段返回的数组', () => {
  // 这就是线上真实形状：主表.竞品分类 是公式，返回 [{text,type}]
  assert.equal(classOf([{ text: '无分类', type: 'text' }]), '无分类');
  assert.equal(classOf([{ text: 'A-爆款竞品', type: 'text' }]), 'A-爆款竞品');
  assert.equal(classOf('B-高价值竞品'), 'B-高价值竞品');
  assert.equal(classOf({ text: 'C-差异化竞品' }), 'C-差异化竞品');
  assert.equal(classOf(null), '');
  // 绝不能出现 JS 的默认对象字符串
  assert.notEqual(classOf([{ text: '无分类' }]), '[object Object]');
});

test('assertApprovedClass 拦下未展开的对象值和非闭集值', () => {
  assert.equal(assertApprovedClass('无分类', '1'), '无分类');
  assert.throws(() => assertApprovedClass('[object Object]', '1'), /对象没展开/u);
  assert.throws(() => assertApprovedClass('', '1'), /为空/u);
  assert.throws(() => assertApprovedClass('S-随便造的分类', '1'), /越界/u);
});
