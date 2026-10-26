// 自采 SKU → SKU明细 字段映射的测试（2026-10-26 重写）。
//
// 这个文件的全部意义是钉住口径，而且钉的是**线上那一份**：
// 空间判定必须走 competitor-v2-core.classifySkuSpace，按 SKU 尺寸区间判，
// 不是按标题词判。第一版我按标题词写，把 30 个商品全判成「小户型」，
// 而线上对 1.3–1.8m 判「常规卫生间」——所以下面第一条用例就是拿来防这个回退的。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DIMENSION_ATTRS,
  assertApprovedSpaces,
  buildItemRows,
  buildSkuFields,
  collectSkuItems,
  parseAttrsCell,
  parseCsv,
  skuNameOf,
  skuSizeOf,
  spaceFields,
  summarizeItem,
} from './taobao-sku-dimension-core.mjs';

import { classifySkuSpace } from '../skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs';

const SOURCE = {
  itemId: '597600994634',
  title: '小户型独立式浴缸',
  link: 'https://detail.tmall.com/item.htm?id=597600994634',
  competitorClass: 'B-高价值竞品',
  mainRecordId: 'recvsD4wKXbExT',
};

// ---------------------------------------------------------------------------
// 尺寸取值
// ---------------------------------------------------------------------------

test('skuSizeOf 取长度原始值，不碰颜色分类', () => {
  assert.equal(skuSizeOf({ 颜色分类: '哑光白', 长度: '1.6m' }), '1.6m');
  // 原始值不做标准化：1700mm 就是 1700mm，标准化由 classifySkuSpace 负责。
  assert.equal(skuSizeOf({ 长度: '1700mm' }), '1700mm');
  assert.equal(skuSizeOf({ 颜色分类: '1.7米独立式', 颜色: '奶白' }), '');
  assert.equal(skuSizeOf({ SKU规格: '18mm 加厚亚克力' }), '');
  assert.equal(skuSizeOf({ 长度: '   ' }), '');
  assert.equal(skuSizeOf(null), '');
});

test('skuNameOf 取规格第一段，无分隔符用全文', () => {
  assert.equal(skuNameOf('【薄边款8507】哑光白+溢水口+下水器'), '【薄边款8507】哑光白');
  assert.equal(skuNameOf('哑光白'), '哑光白');
  assert.equal(skuNameOf(''), '');
});

// ---------------------------------------------------------------------------
// 空间判定：必须与线上同一份实现
// ---------------------------------------------------------------------------

test('空间判定按 SKU 尺寸区间，不按标题词 —— 1.5m 是常规卫生间', () => {
  // 这一条是防回退的核心。标题写着「小户型」，但 1.5m 在 1.3-1.8 区间内，
  // 线上判常规卫生间。若有人改回按标题词判，这里立刻红。
  const space = classifySkuSpace({ skuSize: '1.5m', skuSpec: '', skuName: '' });
  assert.equal(space.applicableSpace, '常规卫生间');
  assert.equal(space.status, '已判定');

  const row = buildSkuFields({ source: SOURCE, skuId: '1', combo: '哑光白', attrs: { 长度: '1.5m' } });
  assert.equal(row.适用空间, '常规卫生间', '标题含「小户型」也不得覆盖尺寸区间结论');
});

test('尺寸区间两端与区间外', () => {
  assert.equal(classifySkuSpace({ skuSize: '1.0m' }).applicableSpace, '小户型');
  assert.equal(classifySkuSpace({ skuSize: '0.8m' }).applicableSpace, '小户型');
  assert.equal(classifySkuSpace({ skuSize: '1.2m' }).applicableSpace, '小户型');
  assert.equal(classifySkuSpace({ skuSize: '1.3m' }).applicableSpace, '常规卫生间');
  assert.equal(classifySkuSpace({ skuSize: '1.8m' }).applicableSpace, '常规卫生间');
  assert.equal(classifySkuSpace({ skuSize: '2.0m' }).status, '需人工核验');
  assert.equal(classifySkuSpace({ skuSize: '0.6m' }).status, '需人工核验');
});

test('大户型永远不产出 —— 闭集只有两个值', () => {
  const row = buildSkuFields({ source: { ...SOURCE, title: '大户型双人浴缸' }, skuId: '1', combo: '', attrs: { 长度: '1.7m' } });
  assert.notEqual(row.适用空间, '大户型');
  assert.equal(row.适用空间, '常规卫生间');
  for (const word of ['大户型', '无注明', '不适用']) {
    assert.ok(!['小户型', '常规卫生间'].includes(word));
  }
});

test('SKU尺寸 缺失时回退看 SKU规格（SKILL.md 允许的确定性 fallback）', () => {
  const space = classifySkuSpace({ skuSize: '', skuSpec: '颜色分类=0.9米普缸', skuName: '' });
  assert.equal(space.applicableSpace, '小户型');
  assert.equal(space.status, '已判定');
  // 但 SKU尺寸 这一列仍留空：字段语义是尺寸属性，不是从规格推出来的值。
  const row = buildSkuFields({ source: SOURCE, skuId: '1', combo: '颜色分类=0.9米普缸', attrs: { 颜色分类: '0.9米普缸' } });
  assert.equal(row.SKU尺寸, '');
  assert.equal(row.适用空间, '小户型');
});

test('非线性外形与范围尺寸一律需人工核验，不许硬判', () => {
  assert.equal(classifySkuSpace({ skuSize: '1.5m', skuName: '方形缸' }).status, '需人工核验');
  assert.equal(classifySkuSpace({ skuSize: '1.0m', skuSpec: '正圆形' }).status, '需人工核验');
  assert.equal(classifySkuSpace({ skuSize: '1.3-1.8m' }).status, '需人工核验');
});

// ---------------------------------------------------------------------------
// 需人工核验的字段表示
// ---------------------------------------------------------------------------

test('需人工核验：适用空间留空、待补数据项=空间判定、采集状态跟着走', () => {
  const fields = spaceFields({ status: '需人工核验', applicableSpace: null, evidence: '未发现带单位的明确 SKU 尺寸' });
  assert.equal(fields.适用空间, undefined, '不得写空串占位');
  assert.deepEqual(fields.待补数据项, ['空间判定']);
  assert.equal(fields.采集状态, '需人工核验');
  assert.equal(fields.空间判定状态, '需人工核验');
});

test('已判定：不产出待补数据项，采集状态=已采集', () => {
  const fields = spaceFields({ status: '已判定', applicableSpace: '小户型', evidence: '规则=0.8m-1.2m' });
  assert.equal(fields.适用空间, '小户型');
  assert.equal(fields.待补数据项, undefined);
  assert.equal(fields.采集状态, '已采集');
});

// ---------------------------------------------------------------------------
// 整行装配
// ---------------------------------------------------------------------------

test('buildSkuFields 装配出 SKU明细 需要的字段，关系字段是 recordId 数组', () => {
  const row = buildSkuFields({
    source: SOURCE, skuId: '6285321262526',
    combo: '【薄边款8507】哑光白+溢水口', attrs: { 长度: '1.6m' },
    dimensionSummary: '1.3m-1.8m',
  });
  assert.equal(row.商品ID, '597600994634');
  assert.equal(row.SKU唯一键, '597600994634|6285321262526');
  assert.equal(row.商品链接, SOURCE.link);
  assert.equal(row.商品标题, SOURCE.title);
  assert.equal(row.竞品分类, 'B-高价值竞品');
  assert.equal(row.SKU名称, '【薄边款8507】哑光白');
  assert.equal(row.SKU规格, '【薄边款8507】哑光白+溢水口');
  assert.equal(row.SKU尺寸, '1.6m');
  assert.equal(row.尺寸汇总, '1.3m-1.8m');
  assert.deepEqual(row.所属竞品, ['recvsD4wKXbExT'], 'batch_create 要求关系字段是数组');
});

test('buildSkuFields 缺主表信息直接抛，不写半截行', () => {
  const partial = { ...SOURCE, mainRecordId: '' };
  assert.throws(() => buildSkuFields({ source: partial, skuId: '1', combo: '', attrs: {} }), /recordId/u);
  assert.throws(() => buildSkuFields({ source: { ...SOURCE, competitorClass: '' }, skuId: '1', combo: '', attrs: {} }), /竞品分类/u);
  assert.throws(() => buildSkuFields({ source: { ...SOURCE, link: '' }, skuId: '1', combo: '', attrs: {} }), /商品链接/u);
  assert.throws(() => buildSkuFields({ source: SOURCE, skuId: '', combo: '', attrs: {} }), /SKU ID/u);
});

test('buildItemRows 按商品算一次尺寸汇总并回填到每行', () => {
  const rows = buildItemRows({
    source: SOURCE,
    skus: [
      { skuId: '1', combo: 'A', attrs: { 长度: '1.3m' } },
      { skuId: '2', combo: 'B', attrs: { 长度: '1.8m' } },
    ],
  });
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.尺寸汇总, '1.3m-1.8m');
  assert.deepEqual(rows.map((row) => row.SKU尺寸), ['1.3m', '1.8m']);
});

test('assertApprovedSpaces 拦下越界值', () => {
  assert.doesNotThrow(() => assertApprovedSpaces([{ 适用空间: '小户型' }, { 适用空间: '' }, {}]));
  assert.throws(() => assertApprovedSpaces([{ 适用空间: '大户型' }]), /越界/u);
});

// ---------------------------------------------------------------------------
// 三态汇总
// ---------------------------------------------------------------------------

test('summarizeItem 三态：全判定有尺寸=ready / 部分=partial / 全无=unusable', () => {
  const item = { itemId: '1', title: '浴缸' };
  const ready = summarizeItem({
    item,
    rows: [
      { 空间判定状态: '已判定', 适用空间: '小户型', SKU尺寸: '1.0m', 尺寸汇总: '1.0m' },
      { 空间判定状态: '已判定', 适用空间: '小户型', SKU尺寸: '1.1m', 尺寸汇总: '1.0m' },
    ],
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.judged, 2);
  assert.deepEqual(ready.spaces, { 小户型: 2 });

  const partial = summarizeItem({
    item,
    rows: [
      { 空间判定状态: '已判定', 适用空间: '小户型', SKU尺寸: '1.0m' },
      { 空间判定状态: '需人工核验', SKU尺寸: '' },
    ],
  });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.review, 1);
  assert.equal(partial.withoutSize, 1);

  const unusable = summarizeItem({
    item,
    rows: [{ 空间判定状态: '需人工核验', SKU尺寸: '' }],
  });
  assert.equal(unusable.status, 'unusable');
});

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

test('parseAttrsCell 三态：空给 {}、坏 JSON 给 null、合法非对象也给 null', () => {
  assert.deepEqual(parseAttrsCell(''), {});
  assert.deepEqual(parseAttrsCell(undefined), {});
  assert.equal(parseAttrsCell('{不是 JSON'), null);
  assert.equal(parseAttrsCell('"就是一句话"'), null);
  assert.equal(parseAttrsCell('null'), null);
  assert.equal(parseAttrsCell('[1,2]'), null);
  assert.deepEqual(parseAttrsCell('{"长度":"150cm"}'), { 长度: '150cm' });
});

test('parseCsv 处理 BOM、CRLF 与引号内的逗号换行', () => {
  const rows = parseCsv('\ufeff商品ID,商品标题\r\n1,"浴缸, 独立式"\r\n2,"两行\r\n标题"\r\n');
  assert.deepEqual(rows[0], ['商品ID', '商品标题']);
  assert.deepEqual(rows[1], ['1', '浴缸, 独立式']);
  assert.deepEqual(rows[2], ['2', '两行\r\n标题']);
  assert.deepEqual(parseCsv('a,b\r\n"说 ""引号""",2\r\n,\r\n')[1], ['说 "引号"', '2']);
});

// ---------------------------------------------------------------------------
// 跨文件收集
// ---------------------------------------------------------------------------

const writeCsv = (dir, name, rows) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, rows.join('\r\n'), 'utf8');
  return file;
};

test('collectSkuItems 跨文件按商品聚合，同 SKU ID 去重', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-dim-'));
  const header = '商品ID,商品标题,SKU ID,属性组合,属性JSON';
  const a = writeCsv(dir, 'a.csv', [header, '1,小户型浴缸,S1,长度=1.5m,"{""长度"":""1.5m""}"']);
  const b = writeCsv(dir, 'b.csv', [
    header,
    '1,小户型浴缸,S1,长度=1.5m,"{""长度"":""1.5m""}"',   // 重跑同一轮，必须去重
    '1,小户型浴缸,S2,长度=1.0m,"{""长度"":""1.0m""}"',
    '2,常规卫生间浴缸,S3,长度=1.7m,"{""长度"":""1.7m""}"',
  ]);
  const { items, dirtyAttrs } = collectSkuItems([a, b]);
  assert.equal(items.length, 2);
  assert.equal(dirtyAttrs, 0);
  const first = items.find((item) => item.itemId === '1');
  assert.deepEqual(first.skus.map((sku) => sku.skuId), ['S1', 'S2']);
});

test('collectSkuItems 把坏 属性JSON 计成脏行但继续跑', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-dim-'));
  const file = writeCsv(dir, 'dirty.csv', [
    '商品ID,商品标题,SKU ID,属性组合,属性JSON',
    '1,小户型浴缸,S1,长度=1.5m,"{坏掉"',
    '1,小户型浴缸,S2,长度=1.0m,"{""长度"":""1.0m""}"',
  ]);
  const { items, dirtyAttrs } = collectSkuItems([file]);
  assert.equal(dirtyAttrs, 1);
  assert.equal(items[0].skus.length, 2);
});

test('collectSkuItems 跳过不存在的文件，缺列则报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-dim-'));
  assert.deepEqual(collectSkuItems([path.join(dir, '没这个.csv')]), { items: [], dirtyAttrs: 0 });
  const bad = writeCsv(dir, 'bad.csv', ['商品ID,商品标题', '1,浴缸']);
  assert.throws(() => collectSkuItems([bad]), /缺少/u);
});

test('DIMENSION_ATTRS 只认维度属性，长度排第一', () => {
  assert.equal(DIMENSION_ATTRS[0], '长度');
  assert.ok(!DIMENSION_ATTRS.includes('颜色分类'));
  assert.ok(!DIMENSION_ATTRS.includes('SKU规格'));
});
