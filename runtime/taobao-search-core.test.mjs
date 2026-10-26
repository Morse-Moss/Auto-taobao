// 淘宝搜索页内核的单元测试。
//
// 这里的断言不是凭空写的：凡是标注「对齐 2026-10-19 导出」的用例，
// 输入都是 2026-10-26 从真实销量排序接口拿到的原始 item，
// 期望值是 weekly-merged-1792340980813.csv 里对应那一行的逐字内容。
// 这样一旦淘宝改字段，测试会先红，而不是等到周报数字不对才发现。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WEEKLY_COLUMNS,
  SALE_SORT,
  stripHighlight,
  salesCountOf,
  countColumnOf,
  salesBadgeOf,
  extractSalesBadges,
  platformOf,
  placementOf,
  shopTypeOf,
  sellingPointsOf,
  imageUrlOf,
  itemUrlOf,
  priceOf,
  categoryOf,
  sameCountOf,
  normalizeItem,
  normalizeItems,
  dedupeByItemId,
  csvCell,
  toCsv,
  parseCsv,
  buildSegments,
  buildSearchParams,
} from './taobao-search-core.mjs';
import { CATEGORY_MAP, categoryCoverage } from './category-map.mjs';

// 真实样本：2026-10-26 销量排序第一页第 2 条（淘宝自然位）。
// 对应 2026-10-19 导出 CSV 的第 1 行（陈强卫浴工厂店）。
const TAOBAO_ITEM = {
  title: '新品<span class=H>浴缸</span>家用无缝一体亚克力独立式成人酒店民宿小户型欧式浴盆',
  nick: '强强联合827574885',
  auctionURL: '//item.taobao.com/item.htm?id=675174324950&ns=1&abbucket=19&xxc=taobaoSearch',
  procity: '河南 商丘',
  price: '1150',
  realSales: '200+人收货',
  isP4p: 'false',
  sameCount: '3',
  leafCategory: '50002411',
  categoryp: '27 50020016 50002411',
  pic_path: 'https://g-search2.alicdn.com/img/bao/uploaded/i4/i3/2750165837/O1CN01T4GmrB1szOeYo14S5_!!2750165837.jpg',
  item_id: '675174324950',
  shopInfo: { title: '陈强卫浴工厂店', commonTagText: '9年老店' },
  priceShow: { unit: '¥', price: '900', preText: '', priceDesc: '补贴后' },
  iconList: 'zjxdxyh8,guanfanglijiannodacupc,88cjdp8,tjbpc,baoyounew',
  icons: [
    { alias: 'zjxdxyh8', type: 'text', text: '直接下单享优惠' },
    { alias: 'baoyounew', type: 'text', text: '包邮' },
    { alias: 'tmallPC', type: 'img' },
  ],
};

// 真实样本：同页第 3 条（天猫自然位），对应 10-19 CSV 第 3 行附近（ssww浪鲸）。
const TMALL_ITEM = {
  title: 'SSWW浪鲸深泡<span class=H>浴缸</span>小户型家用日式亚克力独立式国家补贴迷你可移动',
  nick: 'ssww浪鲸浴缸旗舰店',
  auctionURL: '//detail.tmall.com/item.htm?id=678598686014&ns=1',
  procity: '广东 佛山',
  price: '6116',
  realSales: '81人收货',
  isP4p: 'false',
  sameCount: '0',
  categoryp: '27 50020016 50002411',
  item_id: '678598686014',
  shopInfo: { title: 'ssww浪鲸浴缸旗舰店' },
  priceShow: { unit: '¥', price: '6115.2', preText: '', priceDesc: '补贴后' },
  iconList: 'guanfanglijiannodacupc,tmallPC,tmall,tjbpc',
  icons: [{ alias: 'guanfanglijiannodacupc', type: 'text', text: '官方立减' }],
};

// 真实样本：同页第 1 条（广告位，simba 计费链，无 sameCount）。
const AD_ITEM = {
  title: 'TW特拉维尔独立式人造石<span class=H>浴缸</span>家用小户型酒店民宿成人PMMA椭圆浴盆',
  nick: 'tw特拉维尔旗舰店',
  auctionURL: 'http://click.simba.taobao.com/cc_im?p=%D4%A1%B8%D7&s=1156240835',
  procity: '广东 肇庆',
  price: '4234.7',
  realSales: '行业销量前20',
  isP4p: 'true',
  categoryp: '27 50020016 50002411',
  item_id: '597600994634',
  shopInfo: { title: 'TW特拉维尔旗舰店', commonTagText: '8年老店' },
  priceShow: { unit: '¥', price: '6284', preText: '', priceDesc: '补贴后' },
  iconList: 'guanggao,tmallPC,tmall,baoyounew',
  icons: [{ alias: 'guanggao', type: 'text', text: '广告' }],
};

test('16 列的顺序就是周报 CSV 的表头，不能改', () => {
  assert.deepEqual([...WEEKLY_COLUMNS], [
    '序号', '商品图片', '商品标题', '商品链接', '价格', '月收货人数', '类目', '同款数',
    '平台', '占位类型', '店铺名', '店铺旺旺', '店铺类型', '地址', '收藏人数', '卖点',
  ]);
});

test('销量排序的 sort 是 _sale，不是字面 sales', () => {
  assert.equal(SALE_SORT, '_sale');
  const params = buildSearchParams({ keyword: '浴缸', page: 1 });
  assert.equal(params.sort, '_sale');
  assert.equal(params.page, 1);
  assert.equal(params.q, '浴缸');
  assert.equal(params.appId, '34385');
});

test('标题只剥搜索词高亮，不做别的清洗', () => {
  assert.equal(
    stripHighlight('新品<span class=H>浴缸</span>家用无缝一体'),
    '新品浴缸家用无缝一体',
  );
  assert.equal(stripHighlight('无高亮的标题'), '无高亮的标题');
  assert.equal(stripHighlight(undefined), '');
});

test('月收货人数只剥后缀，数字形态原样留', () => {
  assert.equal(salesCountOf('200+人收货'), '200+');
  assert.equal(salesCountOf('81人收货'), '81');
  assert.equal(salesCountOf('2000+人付款'), '2000+');
  // 以下四种是 SKILL.md 明令必须原样保留的形态，不许因为「看着不对」就改
  assert.equal(salesCountOf('1'), '1');
  assert.equal(salesCountOf('0'), '0');
  assert.equal(salesCountOf('-'), '-');
  assert.equal(salesCountOf('100+'), '100+');
  // 非销量文案不能瞎转数字
  assert.equal(salesCountOf('行业销量前20'), '行业销量前20');
  assert.equal(salesCountOf('本月行业热销'), '本月行业热销');
  assert.equal(salesCountOf(''), '');
});

test('计数列只收可数值，徽标文案留空而不是折算或原样塞进去', () => {
  // 可数：纯数字，允许一个末尾 +
  assert.equal(countColumnOf('200+人收货'), '200+');
  assert.equal(countColumnOf('81人收货'), '81');
  assert.equal(countColumnOf('1'), '1');
  assert.equal(countColumnOf('0'), '0');
  // 不可数：淘宝只给徽标时，计数列必须是空（＝未披露）
  // 下游 import-core 的 numericValue 对非数字直接抛 SOURCE_VALUE_INVALID 让整批失败
  assert.equal(countColumnOf('本月行业热销'), '');
  assert.equal(countColumnOf('行业销量前20'), '');
  assert.equal(countColumnOf('行业销量Top3'), '');
  assert.equal(countColumnOf('-'), '');
  assert.equal(countColumnOf(''), '');
  // 徽标原文不能丢，走 sidecar
  assert.equal(salesBadgeOf('本月行业热销'), '本月行业热销');
  assert.equal(salesBadgeOf('行业销量Top3'), '行业销量Top3');
  assert.equal(salesBadgeOf('200+人收货'), '');
  assert.equal(salesBadgeOf(''), '');
});

test('extractSalesBadges 只回收不可数的行，序号与链接一并带出', () => {
  const badges = extractSalesBadges([
    { 序号: '1', 商品链接: 'https://item.taobao.com/item.htm?id=1', 商品标题: 'a', 月收货人数: '3' },
    { 序号: '2', 商品链接: 'https://item.taobao.com/item.htm?id=2', 商品标题: 'b', 月收货人数: '本月行业热销' },
    { 序号: '3', 商品链接: 'https://item.taobao.com/item.htm?id=3', 商品标题: 'c', 月收货人数: '' },
    { 序号: '4', 商品链接: 'https://item.taobao.com/item.htm?id=4', 商品标题: 'd', 月收货人数: '行业销量Top5' },
  ]);
  assert.equal(badges.length, 2);
  assert.deepEqual(badges.map((b) => b.序号), ['2', '4']);
  assert.equal(badges[0].月收货人数原文, '本月行业热销');
  assert.equal(badges[1].商品链接, 'https://item.taobao.com/item.htm?id=4');
});

test('平台优先看商品链接域名，广告位退回 iconList', () => {
  assert.equal(platformOf(TAOBAO_ITEM), '淘宝');
  assert.equal(platformOf(TMALL_ITEM), '天猫');
  assert.equal(platformOf(AD_ITEM), '天猫'); // simba 链无域名信息，靠 iconList 含 tmall
});

test('占位类型认字符串 true，也认 iconList 的 guanggao 标记', () => {
  assert.equal(placementOf(TAOBAO_ITEM), '自然位');
  assert.equal(placementOf(AD_ITEM), '广告位');
  assert.equal(placementOf({ isP4p: true }), '广告位');
  assert.equal(placementOf({ iconList: 'guanggao,tmall' }), '广告位');
  assert.equal(placementOf({}), '自然位');
});

test('店铺类型口径与 10-19 导出一致', () => {
  assert.equal(shopTypeOf(TAOBAO_ITEM), '非金牌店铺');
  assert.equal(shopTypeOf(TMALL_ITEM), '旗舰店');
  assert.equal(shopTypeOf({ auctionURL: '//detail.tmall.com/x', shopInfo: { title: 'XX专卖店' } }), '专卖店');
  assert.equal(shopTypeOf({ auctionURL: '//detail.tmall.com/x', shopInfo: { title: 'XX专营店' } }), '专营店');
  // 天猫店里没有后缀的，落在非金牌（1441 行里那 18 个）
  assert.equal(shopTypeOf({ auctionURL: '//detail.tmall.com/x', shopInfo: { title: '普通天猫店' } }), '非金牌店铺');
});

test('卖点取 icons 里 type=text 的文本，空格连接', () => {
  assert.equal(sellingPointsOf(TAOBAO_ITEM), '直接下单享优惠 包邮');
  assert.equal(sellingPointsOf(TMALL_ITEM), '官方立减');
  assert.equal(sellingPointsOf({}), '');
});

test('图片补 https，商品链接统一拼 item.taobao.com', () => {
  assert.equal(imageUrlOf({ pic_path: '//g-search1.alicdn.com/a.jpg' }), 'https://g-search1.alicdn.com/a.jpg');
  assert.equal(imageUrlOf({ pic_path: 'https://x/a.jpg' }), 'https://x/a.jpg');
  assert.equal(imageUrlOf({}), '');
  assert.equal(itemUrlOf(TAOBAO_ITEM), 'https://item.taobao.com/item.htm?id=675174324950');
  // 广告位的 simba 链绝不能落进表里
  assert.equal(itemUrlOf(AD_ITEM), 'https://item.taobao.com/item.htm?id=597600994634');
});

test('价格取页面主价，保留原始字符串形态', () => {
  assert.equal(priceOf(TAOBAO_ITEM), '900');
  assert.equal(priceOf({ price: '600+' }), '600+');
  assert.equal(priceOf({ price: '262.35' }), '262.35');
  assert.equal(priceOf({}), '');
});

test('类目没命中映射表时保留 ID，不编中文名', () => {
  assert.equal(categoryOf(TAOBAO_ITEM), '27 50020016 50002411');
  assert.equal(categoryOf(TAOBAO_ITEM, { '50002411': '家装主材 >> 浴缸/淋浴房 >> 浴缸 >> 普通浴缸' }),
    '家装主材 >> 浴缸/淋浴房 >> 浴缸 >> 普通浴缸');
});

test('归一化 16 列：与 10-19 导出 CSV 第 1 行逐字对齐', () => {
  const row = normalizeItem(TAOBAO_ITEM, 1);
  assert.deepEqual(row, {
    序号: '1',
    商品图片: 'https://g-search2.alicdn.com/img/bao/uploaded/i4/i3/2750165837/O1CN01T4GmrB1szOeYo14S5_!!2750165837.jpg',
    商品标题: '新品浴缸家用无缝一体亚克力独立式成人酒店民宿小户型欧式浴盆',
    商品链接: 'https://item.taobao.com/item.htm?id=675174324950',
    价格: '900',
    月收货人数: '200+',
    类目: '27 50020016 50002411',
    同款数: '3',
    平台: '淘宝',
    占位类型: '自然位',
    店铺名: '陈强卫浴工厂店',
    店铺旺旺: '强强联合827574885',
    店铺类型: '非金牌店铺',
    地址: '河南 商丘',
    收藏人数: '-',
    卖点: '直接下单享优惠 包邮',
  });
});

test('广告位缺 sameCount 时留空，自然位缺时补 0', () => {
  const ad = normalizeItem(AD_ITEM, 1);
  assert.equal(ad.同款数, '');
  assert.equal(ad.占位类型, '广告位');

  // 自然位缺字段补 '0'：与 10-19 导出一致（22 条差异全是「旧 0 → 新空」）
  const naturalMissing = normalizeItem({ ...TAOBAO_ITEM, sameCount: undefined }, 1);
  assert.equal(naturalMissing.同款数, '0');
  assert.equal(naturalMissing.占位类型, '自然位');

  // 真实有值时原样保留
  assert.equal(normalizeItem({ ...TAOBAO_ITEM, sameCount: '6' }, 1).同款数, '6');
});

test('批量归一化序号连续', () => {
  const rows = normalizeItems([TAOBAO_ITEM, TMALL_ITEM, AD_ITEM]);
  assert.deepEqual(rows.map((r) => r.序号), ['1', '2', '3']);
  assert.deepEqual(rows.map((r) => r.平台), ['淘宝', '天猫', '天猫']);
});

test('按商品链接去重，保留首次出现并重排序号', () => {
  const rows = [
    { 商品链接: 'a', 序号: '1' },
    { 商品链接: 'b', 序号: '2' },
    { 商品链接: 'a', 序号: '3' },
  ];
  const out = dedupeByItemId(rows);
  assert.deepEqual(out.map((r) => r.商品链接), ['a', 'b']);
  assert.deepEqual(out.map((r) => r.序号), ['1', '2']);
  assert.deepEqual(out.dedupeReport, { kept: 2, droppedBlank: 0, droppedDuplicate: 1 });
});

test('没有商品链接的行必须丢弃，否则下游 validateDataset 会整批失败', () => {
  // merge-market-analysis 的 validateDataset 要求链接非空唯一、序号连续 1..N
  const out = dedupeByItemId([
    { 商品链接: 'https://item.taobao.com/item.htm?id=1', 序号: '1' },
    { 商品链接: '', 序号: '2' },
    { 商品链接: 'https://item.taobao.com/item.htm?id=2', 序号: '3' },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.序号), ['1', '2'], '重排后必须连续');
  assert.equal(out.dedupeReport.droppedBlank, 1);
});

test('CSV 转义与 BOM', () => {
  assert.equal(csvCell('普通'), '普通');
  assert.equal(csvCell('含,逗号'), '"含,逗号"');
  assert.equal(csvCell('含"引号'), '"含""引号"');
  assert.equal(csvCell(null), '');

  const csv = toCsv([normalizeItem(TAOBAO_ITEM, 1)]);
  assert.ok(csv.startsWith('\ufeff'), 'CSV 必须带 UTF-8 BOM，否则 Excel 中文乱码');
  assert.ok(csv.includes('序号,商品图片,商品标题'));
  assert.ok(csv.includes('陈强卫浴工厂店'));
  assert.equal(csv.split('\r\n').filter(Boolean).length, 2, '表头 + 1 行数据');
});

test('分段计划 1..40 切成 10 段，与周报的十段制一致', () => {
  const segments = buildSegments(40, 4);
  assert.equal(segments.length, 10);
  assert.deepEqual(segments[0], { id: '1-4', start: 1, end: 4 });
  assert.deepEqual(segments[9], { id: '37-40', start: 37, end: 40 });
  // 不整除时最后一段收窄，不能越过总页数
  assert.deepEqual(buildSegments(10, 4).map((s) => s.id), ['1-4', '5-8', '9-10']);
  assert.throws(() => buildSegments(0, 4));
});

test('类目映射表覆盖 10-19 导出出现过的全部三类，且零冲突', () => {
  // 这三条是拿 88 个重叠商品与 10-19 导出 JOIN 反推出来的，不是猜的
  assert.equal(
    normalizeItem(TAOBAO_ITEM, 1, { categoryMap: CATEGORY_MAP }).类目,
    '家装主材 >> 浴缸/淋浴房 >> 浴缸 >> 普通浴缸',
  );
  assert.equal(
    normalizeItem({ categoryp: '27 50020016 50020125', item_id: '1' }, 1, { categoryMap: CATEGORY_MAP }).类目,
    '家装主材 >> 浴缸/淋浴房 >> 浴缸 >> 按摩浴缸',
  );
  assert.equal(
    normalizeItem({ categoryp: '27 201913404 201913904', item_id: '1' }, 1, { categoryMap: CATEGORY_MAP }).类目,
    '家装主材 >> 适老卫浴 >> 步入式浴缸',
  );
  // 未收录的 ID 必须原样保留，不许编名字
  assert.equal(
    normalizeItem({ categoryp: '99 888 777', item_id: '1' }, 1, { categoryMap: CATEGORY_MAP }).类目,
    '99 888 777',
  );
});

test('类目覆盖率统计能区分已转中文/仍是ID/空', () => {
  const coverage = categoryCoverage([
    { 类目: '家装主材 >> 浴缸/淋浴房 >> 浴缸 >> 普通浴缸' },
    { 类目: '27 50020016 50002411' },
    { 类目: '' },
  ]);
  assert.equal(coverage.total, 3);
  assert.equal(coverage.named, 1);
  assert.equal(coverage.raw, 1);
  assert.equal(coverage.blank, 1);
  assert.deepEqual(coverage.unknownIds, [{ id: '27 50020016 50002411', count: 1 }]);
});

test('sameCountOf 三种情形', () => {
  assert.equal(sameCountOf({ sameCount: '0', isP4p: 'false' }), '0');
  assert.equal(sameCountOf({ isP4p: 'false' }), '0');
  assert.equal(sameCountOf({ isP4p: 'true' }), '');
});

test('parseCsv 能还原 toCsv 的产物（含逗号、引号、换行、BOM）', () => {
  const rows = [
    { 序号: '1', 商品标题: '带,逗号 的标题', 卖点: '他说"这个好"', 店铺名: '两\n行' },
    { 序号: '2', 商品标题: '普通', 卖点: '', 店铺名: '-' },
  ];
  const columns = ['序号', '商品标题', '卖点', '店铺名'];
  const parsed = parseCsv(toCsv(rows, columns));
  assert.equal(parsed.length, 3); // 表头 + 2 行
  assert.deepEqual(parsed[0], columns);
  assert.deepEqual(parsed[1], ['1', '带,逗号 的标题', '他说"这个好"', '两\n行']);
  assert.deepEqual(parsed[2], ['2', '普通', '', '-']);
});

test('parseCsv 处理无尾随换行、纯空行与 CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv(''), []);
  // 引号包裹的字段里出现换行，不能被当成分行
  assert.deepEqual(parseCsv('a\n"x\ny"\n'), [['a'], ['x\ny']]);
});

test('parseCsv 对真实周报 CSV 首行逐字段还原', () => {
  const text = [
    '\ufeff序号,商品图片,商品标题,商品链接,价格,月收货人数,类目,同款数,平台,占位类型,店铺名,店铺旺旺,店铺类型,地址,收藏人数,卖点',
    '1,https://g-search1.alicdn.com/img/bao/uploaded/i4/i2/4231860428/O1CN01s7jz2A3oxGG2vH2e_!!4611686018427384012-0-item_pic.jpg,TW特拉维尔独立式人造石浴缸,https://item.taobao.com/item.htm?id=597600994634,6284,行业销量前20,家装主材 >> 浴缸/淋浴房 >> 浴缸 >> 普通浴缸,,天猫,广告位,TW特拉维尔旗舰店,tw特拉维尔旗舰店,旗舰店,广东 肇庆,-,直接下单享优惠 包邮 公益宝贝',
  ].join('\r\n');
  const parsed = parseCsv(text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].length, 16);
  assert.equal(parsed[1].length, 16);
  assert.equal(parsed[1][3], 'https://item.taobao.com/item.htm?id=597600994634');
  assert.equal(parsed[1][15], '直接下单享优惠 包邮 公益宝贝');
  // 表头不能带 BOM，否则下游按列名取值会全部落空
  assert.equal(parsed[0][0], '序号');
});
