// 周表「尺寸 / 适用空间」映射的纯函数测试（2026-10-26）。
//
// 这个文件的全部意义是钉住口径，不是钉住实现：
//   尺寸 只能来自 SKU尺寸，不能把 颜色分类 / SKU规格 里的话混进去；
//   适用空间 只能是 小户型 / 常规卫生间 两个值，`大户型` 永远不产出。
// 两条都是 SKILL.md 与 adapter.sku-collection.mjs 的硬契约，放松一条，
// 飞书那边多选字段会直接写不进去或写进越界值。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  APPROVED_SPACES,
  DIMENSION_ATTRS,
  parseAttrsCell,
  parseCsv,
  skuSizeOf,
  spacesOf,
  summarizeCsvFiles,
  summarizeItem,
  uniqueSizes,
} from './taobao-sku-dimension-core.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sku-dim-'));

// ---------------------------------------------------------------------------
// 尺寸
// ---------------------------------------------------------------------------

test('skuSizeOf 取长度，不碰颜色分类', () => {
  assert.equal(skuSizeOf({ 颜色分类: '哑光白', 长度: '150cm' }), '150cm');
});

test('skuSizeOf 只认维度属性，颜色/规格再花哨也返回空', () => {
  // 这三组是真实出现过的干扰项：颜色分类、颜色、以及 SKU规格 里的厚度描述。
  assert.equal(skuSizeOf({ 颜色分类: '1.7米独立式', 颜色: '奶白' }), '');
  assert.equal(skuSizeOf({ SKU规格: '18mm 加厚亚克力' }), '');
  assert.equal(skuSizeOf({}), '');
  assert.equal(skuSizeOf(null), '');
});

test('skuSizeOf 按 DIMENSION_ATTRS 顺序取第一个非空，且保留原始单位写法', () => {
  assert.equal(skuSizeOf({ 尺寸: 'M', 长度: '1700mm' }), '1700mm');
  assert.deepEqual([...DIMENSION_ATTRS].slice(0, 2), ['长度', '宽度']);
  // 纯空格算空值，不能当成有尺寸。
  assert.equal(skuSizeOf({ 长度: '   ' }), '');
});

test('uniqueSizes 去重且保留首次出现的顺序', () => {
  const rows = [
    { attrs: { 长度: '120cm' } },
    { attrs: { 长度: '150cm' } },
    { attrs: { 长度: '120cm' } },
    { attrs: { 颜色分类: '白' } },   // 无尺寸，跳过
    { attrs: { 长度: '170cm' } },
  ];
  assert.deepEqual(uniqueSizes(rows), ['120cm', '150cm', '170cm']);
  assert.deepEqual(uniqueSizes([]), []);
  assert.deepEqual(uniqueSizes(null), []);
});

// ---------------------------------------------------------------------------
// 适用空间
// ---------------------------------------------------------------------------

test('spacesOf 只从标题取词，小空间归到小户型', () => {
  assert.deepEqual(spacesOf({ title: '小户型独立式浴缸 1.2-1.7米' }), ['小户型']);
  assert.deepEqual(spacesOf({ title: '家用小空间泡澡桶' }), ['小户型']);
  assert.deepEqual(spacesOf({ title: '常规卫生间坐泡式浴缸' }), ['常规卫生间']);
});

test('大户型永远不产出 —— 闭集里没有它，标题里写了也不能返回', () => {
  assert.deepEqual(spacesOf({ title: '大户型双人浴缸 1.8米' }), []);
  assert.deepEqual(spacesOf({ title: '大户型 / 小户型 通用' }), ['小户型']);
  assert.ok(!APPROVED_SPACES.includes('大户型'));
  // 周表那层多选有 大户型/无注明/不适用，但那是 Lookup 的选项，不是我们要写的值。
  // 写进去会被 adapter 判 ITEM_INVALID，所以这几个词一个都不能出现。
  for (const word of ['大户型', '无注明', '不适用']) {
    assert.ok(!APPROVED_SPACES.includes(word), `${word} 不该出现在 SKU明细 的闭集里`);
  }
  const item = summarizeItem({ itemId: '9', title: '大户型浴缸', skus: [{ attrs: { 长度: '180cm' } }] });
  assert.deepEqual(item.spaces, []);
  assert.equal(item.space, '');
});

test('spacesOf 的返回值恒为 APPROVED_SPACES 的子集', () => {
  const titles = [
    '小户型', '常规卫生间', '小空间', '大户型', '别墅', '酒店工程', '',
    '小户型常规卫生间两用',
  ];
  for (const title of titles) {
    const spaces = spacesOf({ title });
    for (const space of spaces) assert.ok(APPROVED_SPACES.includes(space), `${title} → 越界值 ${space}`);
  }
});

test('spacesOf 两词同时命中时按 APPROVED_SPACES 顺序返回', () => {
  assert.deepEqual(spacesOf({ title: '常规卫生间 小户型 都能装' }), ['小户型', '常规卫生间']);
});

test('spacesOf 无标题不报错，返回空数组', () => {
  assert.deepEqual(spacesOf(), []);
  assert.deepEqual(spacesOf({}), []);
  assert.deepEqual(spacesOf({ title: '   ' }), []);
});

// ---------------------------------------------------------------------------
// summarizeItem 的三态
// ---------------------------------------------------------------------------

test('summarizeItem：尺寸空间都有 → ready', () => {
  const item = summarizeItem({
    itemId: '597600994634',
    title: '小户型独立式浴缸',
    skus: [{ attrs: { 长度: '150cm' } }, { attrs: { 长度: '170cm' } }],
  });
  assert.equal(item.status, 'ready');
  assert.deepEqual(item.sizes, ['150cm', '170cm']);
  assert.equal(item.sizeText, '150cm、170cm');   // 对应 LISTCOMBINE().UNIQUE()
  assert.equal(item.spaceText, '小户型');
  assert.equal(item.skuCount, 2);
  assert.equal(item.missingSize, 0);
});

test('summarizeItem：一个尺寸都没采到 → needs-size，此时不因空间也缺而报 needs-space', () => {
  const item = summarizeItem({
    itemId: '1',
    title: '浴缸',
    skus: [{ attrs: { 颜色分类: '白' } }, { attrs: { 颜色分类: '黑' } }],
  });
  assert.equal(item.status, 'needs-size');
  assert.deepEqual(item.sizes, []);
  assert.equal(item.sizeText, '');
  assert.equal(item.missingSize, 2);
});

test('summarizeItem：尺寸有但标题无空间词 → needs-space', () => {
  const item = summarizeItem({
    itemId: '2',
    title: '亚克力浴缸',
    skus: [{ attrs: { 长度: '140cm' } }],
  });
  assert.equal(item.status, 'needs-space');
  assert.deepEqual(item.spaces, []);
  assert.equal(item.spaceText, '');
});

test('summarizeItem：零 SKU 记 needs-size，不冒充 ready', () => {
  const item = summarizeItem({ itemId: '3', title: '小户型浴缸', skus: [] });
  assert.equal(item.status, 'needs-size');
  assert.equal(item.skuCount, 0);
});

test('summarizeItem：部分 SKU 缺尺寸仍算 ready，但 missingSize 要如实报出来', () => {
  const item = summarizeItem({
    itemId: '4',
    title: '小户型浴缸',
    skus: [{ attrs: { 长度: '150cm' } }, { attrs: {} }],
  });
  assert.equal(item.status, 'ready');
  assert.equal(item.missingSize, 1);
});

test('summarizeItem：space 是单值，两个词都命中时取闭集第一个并标 ambiguous', () => {
  const item = summarizeItem({
    itemId: '5',
    title: '常规卫生间 小户型 都能装',
    skus: [{ attrs: { 长度: '150cm' } }],
  });
  // 写入侧 SKU明细.适用空间 只接受一个值，多值会判 ITEM_INVALID。
  assert.equal(item.space, '小户型');
  assert.equal(item.spaceAmbiguous, true);

  const single = summarizeItem({
    itemId: '6',
    title: '常规卫生间浴缸',
    skus: [{ attrs: { 长度: '150cm' } }],
  });
  assert.equal(single.space, '常规卫生间');
  assert.equal(single.spaceAmbiguous, false);
});

test('summarizeItem：尺寸缺失时给 sizeHints 取证，但绝不把颜色分类当成尺寸', () => {
  const item = summarizeItem({
    itemId: '7',
    title: '小户型浴缸',
    skus: [
      { attrs: { 颜色分类: 'A款 800x600x680mm【内深580带坐板】' } },
      { attrs: { 颜色分类: 'A款 900x600x680mm【内深580带坐板】' } },
      { attrs: { 颜色分类: 'A款 800x600x680mm【内深580带坐板】' } },
    ],
  });
  // 关键：颜色分类里明明有 800x600x680mm，仍然不能算尺寸。
  assert.deepEqual(item.sizes, []);
  assert.equal(item.sizeText, '');
  assert.equal(item.status, 'needs-size');
  // 但要把线索抄出来，否则 needs-size 是一句没法处理的话。
  assert.deepEqual(item.sizeHints, [
    'A款 800x600x680mm【内深580带坐板】',
    'A款 900x600x680mm【内深580带坐板】',
  ]);
});

test('summarizeItem：尺寸正常时不产出 sizeHints，避免噪音', () => {
  const item = summarizeItem({
    itemId: '8',
    title: '小户型浴缸',
    skus: [{ attrs: { 长度: '150cm', 颜色分类: '白' } }],
  });
  assert.deepEqual(item.sizeHints, []);
});

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

test('parseAttrsCell 坏 JSON 返回 null 而不是抛错', () => {
  assert.equal(parseAttrsCell('{不是 JSON'), null);
  assert.equal(parseAttrsCell('"字符串也是坏值"'), null);
  assert.equal(parseAttrsCell('null'), null);
});

test('parseAttrsCell 空单元格返回空对象，不是 null', () => {
  // 空和坏必须区分：空是「没这个属性」，坏是「数据脏了」，后者要能被统计出来。
  assert.deepEqual(parseAttrsCell(''), {});
  assert.deepEqual(parseAttrsCell(undefined), {});
  assert.deepEqual(parseAttrsCell('{"长度":"150cm"}'), { 长度: '150cm' });
});

test('parseCsv 处理 BOM、CRLF 与引号内的逗号和换行', () => {
  const csv = '\ufeff商品ID,商品标题\r\n1,"浴缸, 独立式"\r\n2,"两行\r\n标题"\r\n';
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], ['商品ID', '商品标题']);
  assert.deepEqual(rows[1], ['1', '浴缸, 独立式']);
  assert.deepEqual(rows[2], ['2', '两行\r\n标题']);
});

test('parseCsv 处理双引号转义，并丢掉全空行', () => {
  const rows = parseCsv('a,b\r\n"说 ""引号""",2\r\n,\r\n');
  assert.deepEqual(rows[1], ['说 "引号"', '2']);
  assert.equal(rows.length, 2);
});

// ---------------------------------------------------------------------------
// 跨文件汇总
// ---------------------------------------------------------------------------

const writeCsv = (dir, name, rows) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, rows.join('\r\n'), 'utf8');
  return file;
};

test('summarizeCsvFiles 跨文件按商品ID 合并，标题取先出现者', () => {
  const dir = tmpDir();
  const a = writeCsv(dir, 'a.csv', [
    '商品ID,商品标题,属性JSON',
    '1,小户型浴缸,"{""长度"":""150cm""}"',
  ]);
  const b = writeCsv(dir, 'b.csv', [
    '商品ID,商品标题,属性JSON',
    '1,小户型浴缸（改名了）,"{""长度"":""170cm""}"',
    '2,常规卫生间浴缸,"{""长度"":""140cm""}"',
  ]);
  const items = summarizeCsvFiles([a, b]);
  assert.equal(items.length, 2);
  const first = items.find((item) => item.itemId === '1');
  assert.equal(first.title, '小户型浴缸');
  assert.deepEqual(first.sizes, ['150cm', '170cm']);
  assert.equal(first.status, 'ready');
});

test('summarizeCsvFiles 遇到坏 属性JSON 不中断整批', () => {
  const dir = tmpDir();
  const file = writeCsv(dir, 'bad.csv', [
    '商品ID,商品标题,属性JSON',
    '1,小户型浴缸,"{坏掉的"',
    '2,小户型浴缸,"{""长度"":""160cm""}"',
  ]);
  const items = summarizeCsvFiles([file]);
  assert.equal(items.length, 2);
  const broken = items.find((item) => item.itemId === '1');
  assert.equal(broken.status, 'needs-size');
  // 脏行必须单独计数：否则它会被当成「这个 SKU 没属性」，静默洗成正常缺失。
  assert.equal(broken.dirtyAttrs, 1);
  assert.equal(items.find((item) => item.itemId === '2').dirtyAttrs, 0);
});

test('summarizeCsvFiles 合法但非对象的 属性JSON 也算脏', () => {
  const dir = tmpDir();
  const file = writeCsv(dir, 'scalar.csv', [
    '商品ID,商品标题,属性JSON',
    '1,小户型浴缸,"""就是一句话"""',
    '2,小户型浴缸,"[1,2]"',
    '3,小户型浴缸,""',            // 空单元格是「没属性」，不是脏
  ]);
  const items = summarizeCsvFiles([file]);
  assert.equal(items.find((item) => item.itemId === '1').dirtyAttrs, 1);
  assert.equal(items.find((item) => item.itemId === '2').dirtyAttrs, 1);
  assert.equal(items.find((item) => item.itemId === '3').dirtyAttrs, 0);
});

test('summarizeCsvFiles 跳过不存在的文件，缺列则报错', () => {
  const dir = tmpDir();
  assert.deepEqual(summarizeCsvFiles([path.join(dir, '没这个文件.csv')]), []);
  const noTitle = writeCsv(dir, 'no-title.csv', ['商品ID,属性JSON', '1,{}']);
  assert.throws(() => summarizeCsvFiles([noTitle]), /缺少 商品ID \/ 商品标题 列/u);
});

test('summarizeCsvFiles 没有 属性JSON 列时不抛错，全部记 needs-size', () => {
  const dir = tmpDir();
  const file = writeCsv(dir, 'no-attrs.csv', ['商品ID,商品标题', '1,小户型浴缸']);
  const items = summarizeCsvFiles([file]);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'needs-size');
  assert.equal(items[0].skuCount, 1);
});
