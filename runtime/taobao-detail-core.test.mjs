// 详情页内核（SKU / 评价）的单元测试。
//
// 输入形状全部来自 2026-10-26 对 detail.tmall.com 商品 597600994634 的实测响应
// （证据：evidence/xws-reverse-2026-10-26/probe/detail-597600994634.json）。
// 期望值不是猜的：pid/name/vid/propPath/字段名都照抄实测那一份。
//
// 这里最要紧的一条：评价接口返回的是 feedback / feedPicPathList，
// 小旺神从 React 读的是 reviewInfo / feedPicList。名字不同，套错就是全空。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SKU_API,
  SKU_API_VERSION,
  REVIEW_API,
  REVIEW_API_VERSION,
  APP_KEY,
  DETAIL_V,
  SKU_COLUMNS,
  REVIEW_COLUMNS,
  rateTypeLabel,
  buildSkuRequestData,
  buildReviewRequestData,
  absoluteTaobaoUrl,
  parseSkuBase,
  buildSkuRows,
  buildSkuAttributeRows,
  readItemPayload,
  parseReviewResponse,
  normalizeReview,
  buildReviewRows,
} from './taobao-detail-core.mjs';

// 实测 skuBase 的裁剪版：长度 6 值、颜色分类 10 值、60 个 skus。这里各取前几条。
const SKU_BASE_FIXTURE = Object.freeze({
  props: [
    {
      pid: '148242406',
      name: '长度',
      values: [
        { vid: '7392676', name: '1.3m' },
        { vid: '65793', name: '1.5m' },
      ],
    },
    {
      pid: '1627207',
      name: '颜色分类',
      values: [
        { vid: '44701014954', name: '【高分子人造石薄边款】8507哑光白', image: '//img.alicdn.com/a.jpg' },
        { vid: '44701014959', name: '【进口三菱PMMA高分子人造石薄边款】8507哑光白', image: '//img.alicdn.com/b.jpg' },
      ],
    },
  ],
  skus: [
    { skuId: '6285321262564', propPath: '1627207:44701014959;148242406:65793' },
    { skuId: '6285321262565', propPath: '1627207:44701014954;148242406:7392676' },
  ],
});

// 实测 skuCore.sku2info：key 是 skuId，"0" 是未选规格时的聚合项。
const SKU_CORE_FIXTURE = Object.freeze({
  skuItem: {},
  sku2info: {
    0: { price: { priceText: '6284', priceMoney: '628400', priceDesc: '起', priceTitle: '优惠前' }, quantity: '200', quantityText: '有货' },
    6285321262564: { price: { priceText: '6120', priceMoney: '612000', priceTitle: '优惠前' }, quantity: '12', quantityText: '有货' },
    6285321262565: { price: { priceMoney: '598000' }, quantity: '3', quantityText: '有货' },
  },
});

// 实测评价响应裁剪版：字段名照抄。
const RATE_FIXTURE = Object.freeze({
  total: '800',
  totalPage: '22',
  hasNext: 'true',
  rateList: [
    {
      id: '1316784909222',
      auctionNumId: '597600994634',
      auctionTitle: 'TW特拉维尔独立式人造石浴缸家用小户型酒店民宿成人PMMA椭圆浴盆',
      rateType: '1',
      feedback: '非常漂亮，质量很好，水龙头质感也是很好，总之很满意👍',
      feedbackDate: '2026年10月13日',
      createTime: '10月13日',
      skuValueStr: '1.5m；【进口三菱PMMA高分子人造石薄边款】8507哑光白+溢水口+下水器+排水管',
      feedPicPathList: [
        '//img.alicdn.com/imgextra/i4/4611686018427386467/O1CN0174Nv9tvtTaFBb3AC_!!4611686018427386467-0-rate.jpg',
        '',
      ],
      feedPicList: [{ cover: 'false', fileId: '1939508861345106331' }],
      reply: '',
      userNick: 't**g',
      reduceUserNick: 't**g',
      hasDetail: 'true',
    },
    {
      id: '1316784909223',
      auctionNumId: '597600994634',
      rateType: '1',
      feedback: '第二次回购',
      feedbackDate: '2026年9月17日',
      skuValueStr: '1.6m；【薄边款8507】哑光白+溢水口+下水器+排水管',
      feedPicPathList: [],
      reply: '感谢复购',
      userNick: 'a**b',
    },
  ],
});

test('接口常量与实测一致，改一处就必须改测试', () => {
  assert.equal(SKU_API, 'mtop.taobao.pcdetail.data.get');
  assert.equal(SKU_API_VERSION, '1.0');
  assert.equal(REVIEW_API, 'mtop.taobao.rate.detaillist.get');
  assert.equal(REVIEW_API_VERSION, '6.0');
  assert.equal(APP_KEY, '12574478');
  assert.equal(DETAIL_V, '3.3.2');
});

test('列契约固定', () => {
  assert.deepEqual([...SKU_COLUMNS], ['商品ID', '商品标题', 'SKU ID', '属性组合', '价格', '库存', 'SKU图', '属性JSON']);
  assert.deepEqual([...REVIEW_COLUMNS], ['商品ID', '评价ID', '评价时间', '评价类型', '购买SKU', '评价内容', '图片数', '图片链接', '商家回复', '用户昵称']);
});

test('SKU 请求参数照抄实测形态', () => {
  const data = buildSkuRequestData('597600994634');
  assert.equal(data.id, '597600994634');
  assert.equal(data.detail_v, '3.3.2');
  const ex = JSON.parse(data.exParams);
  assert.equal(ex.id, '597600994634');
  assert.equal(ex.queryParams, 'id=597600994634');
  assert.equal(ex.path_name, '/item.htm');
  assert.match(ex.domain, /^https:\/\//u);
});

test('SKU 请求参数拒绝非法 ID', () => {
  for (const bad of ['', 'abc', '12 34', '../x']) {
    assert.throws(() => buildSkuRequestData(bad), /商品 ID 不合法/u);
  }
});

test('评价请求参数照抄实测形态：rateSrc 与 searchImpr 不能改', () => {
  const data = buildReviewRequestData('597600994634');
  assert.deepEqual(data, {
    showTrueCount: false,
    auctionNumId: '597600994634',
    pageNo: 1,
    pageSize: 40,
    rateType: '',
    searchImpr: -8,
    orderType: '',
    expression: '',
    rateSrc: 'pc_rate_list',
  });
});

test('评价请求参数拒绝非法页码与页大小', () => {
  assert.throws(() => buildReviewRequestData('1', { page: 0 }), /页码不合法/u);
  assert.throws(() => buildReviewRequestData('1', { page: 1.5 }), /页码不合法/u);
  assert.throws(() => buildReviewRequestData('1', { pageSize: 0 }), /每页条数不合法/u);
  assert.throws(() => buildReviewRequestData('1', { pageSize: 101 }), /每页条数不合法/u);
});

test('parseSkuBase 按 propPath 还原属性，顺序跟 propPath 一致', () => {
  const parsed = parseSkuBase(SKU_BASE_FIXTURE);
  assert.equal(parsed.skus.length, 2);
  const first = parsed.skus[0];
  assert.equal(first.skuId, '6285321262564');
  assert.equal(first.attributeText, '颜色分类=【进口三菱PMMA高分子人造石薄边款】8507哑光白；长度=1.5m');
  assert.deepEqual(first.attrs.map((a) => a.name), ['颜色分类', '长度']);
});

test('价格库存来自 skuCore.sku2info，不是 skus 自身', () => {
  const parsed = parseSkuBase(SKU_BASE_FIXTURE, { skuCore: SKU_CORE_FIXTURE });
  assert.equal(parsed.skus[0].price, '6120');
  assert.equal(parsed.skus[0].store, '12');
  assert.equal(parsed.skus[0].storeText, '有货');
});

test('sku2info 的 "0" 键是未选规格聚合项，绝不能被当成某个 SKU 的价格', () => {
  const parsed = parseSkuBase(SKU_BASE_FIXTURE, { skuCore: SKU_CORE_FIXTURE });
  assert.ok(parsed.skus.every((s) => s.price !== '6284'), 'SKU 拿到了聚合价');
  assert.equal(parsed.skus[0].price, '6120');
});

test('只有 priceMoney 时按分转元，保留两位', () => {
  const parsed = parseSkuBase(SKU_BASE_FIXTURE, { skuCore: SKU_CORE_FIXTURE });
  assert.equal(parsed.skus[1].price, '5980.00');
});

test('没有 skuCore 时价格库存留空，不臆造成 0', () => {
  const parsed = parseSkuBase(SKU_BASE_FIXTURE);
  assert.equal(parsed.skus[0].price, '');
  assert.equal(parsed.skus[0].store, '');
});

test('skuCore 给了但某 SKU 没命中时，该行留空', () => {
  const parsed = parseSkuBase(
    { props: [], skus: [{ skuId: 'X', propPath: '' }] },
    { skuCore: SKU_CORE_FIXTURE },
  );
  assert.equal(parsed.skus[0].price, '');
  assert.equal(parsed.skus[0].store, '');
});

test('SKU 图取属性值上的 image，并补全协议', () => {
  const parsed = parseSkuBase(SKU_BASE_FIXTURE);
  assert.equal(parsed.skus[0].image, 'https://img.alicdn.com/b.jpg');
  assert.equal(parsed.skus[1].image, 'https://img.alicdn.com/a.jpg');
});

test('propPath 里 props 没覆盖的 pid 保留原值，不丢列', () => {
  const parsed = parseSkuBase({
    props: [{ pid: '148242406', name: '长度', values: [{ vid: '65793', name: '1.5m' }] }],
    skus: [{ skuId: 'X', propPath: '999:888;148242406:65793' }],
  });
  assert.equal(parsed.skus[0].attrs[0].pid, '999');
  assert.equal(parsed.skus[0].attrs[0].value, '888');
  assert.equal(parsed.skus[0].attributeText, '999=888；长度=1.5m');
});

test('没有 vid 的属性值被丢弃，不会输出空名', () => {
  const parsed = parseSkuBase({
    props: [{ pid: '1', name: '颜色', values: [{ name: '无 vid 的值' }, { vid: '2', name: '有 vid' }] }],
    skus: [],
  });
  assert.equal(parsed.props[0].values.length, 1);
  assert.equal(parsed.props[0].values[0], '有 vid');
});

test('skuBase 缺失时明确抛错，不静默返回空表', () => {
  assert.throws(() => parseSkuBase(null), /skuBase 缺失/u);
  assert.throws(() => parseSkuBase(undefined), /skuBase 缺失/u);
});

test('buildSkuRows 每行都能反解出属性 JSON', () => {
  const parsed = parseSkuBase(SKU_BASE_FIXTURE);
  const rows = buildSkuRows(parsed, { itemId: '597600994634', title: '浴缸' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['商品ID'], '597600994634');
  assert.equal(rows[0]['商品标题'], '浴缸');
  assert.deepEqual(JSON.parse(rows[0]['属性JSON']), {
    颜色分类: '【进口三菱PMMA高分子人造石薄边款】8507哑光白',
    长度: '1.5m',
  });
  for (const col of SKU_COLUMNS) assert.ok(col in rows[0], `缺列 ${col}`);
});

test('buildSkuAttributeRows 给出属性维度与值数', () => {
  const parsed = parseSkuBase(SKU_BASE_FIXTURE);
  const rows = buildSkuAttributeRows(parsed, { itemId: '597600994634', title: '浴缸' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['属性名'], '长度');
  assert.equal(rows[0]['属性值数'], '2');
  assert.equal(rows[0]['属性值'], '1.3m / 1.5m');
  assert.equal(rows[0]['有图值数'], '0');
  assert.equal(rows[1]['属性名'], '颜色分类');
  assert.equal(rows[1]['有图值数'], '2');
});

test('readItemPayload 带出卖家并校验商品一致', () => {
  const payload = readItemPayload({
    data: {
      item: { itemId: '597600994634', title: ' TW特拉维尔 ' },
      seller: { sellerId: '2200001', shopId: '88', shopName: '特拉维尔旗舰店', sellerNick: 'tw旗舰店', pcShopUrl: '//shop1.taobao.com' },
      skuBase: SKU_BASE_FIXTURE,
      skuCore: SKU_CORE_FIXTURE,
    },
  }, '597600994634');
  assert.equal(payload.itemId, '597600994634');
  assert.equal(payload.title, 'TW特拉维尔');
  assert.equal(payload.seller.shopName, '特拉维尔旗舰店');
  assert.equal(payload.seller.pcShopUrl, 'https://shop1.taobao.com');
  assert.equal(payload.skuCore.sku2info['6285321262564'].quantity, '12', 'skuCore 必须带出来，否则价格库存全空');
});

test('readItemPayload 商品串了就抛错，不能把 A 的数据记到 B 头上', () => {
  assert.throws(
    () => readItemPayload({ data: { item: { itemId: '111' } } }, '222'),
    /商品不一致：期望 222，返回 111/u,
  );
});

test('normalizeReview 用接口字段名 feedback / feedPicPathList', () => {
  const review = normalizeReview(RATE_FIXTURE.rateList[0], '597600994634');
  assert.equal(review.itemId, '597600994634');
  assert.equal(review.reviewId, '1316784909222');
  assert.equal(review.date, '2026年10月13日');
  assert.equal(review.rateType, '好评');
  assert.equal(review.content, '非常漂亮，质量很好，水龙头质感也是很好，总之很满意👍');
  assert.equal(review.sku, '1.5m；【进口三菱PMMA高分子人造石薄边款】8507哑光白+溢水口+下水器+排水管');
  assert.equal(review.userNick, 't**g');
  assert.equal(review.pics.length, 1, '空字符串图片必须被过滤');
  assert.match(review.pics[0], /^https:\/\/img\.alicdn\.com\//u);
});

test('normalizeReview 不认小旺神的 reviewInfo 形状（防回归）', () => {
  const legacy = { id: '1', reviewInfo: { content: '旧结构' }, feedback: '新结构' };
  assert.equal(normalizeReview(legacy, '9').content, '新结构');
});

test('normalizeReview 缺 feedbackDate 时回落到 createTime', () => {
  assert.equal(normalizeReview({ createTime: '10月13日' }, '9').date, '10月13日');
});

test('rateType 只映射实测过的取值，未知值原样保留', () => {
  assert.equal(rateTypeLabel('1'), '好评');
  assert.equal(rateTypeLabel('9'), '9');
  assert.equal(rateTypeLabel(''), '');
  assert.equal(rateTypeLabel(null), '');
});

test('parseReviewResponse 解析分页元信息与列表', () => {
  const parsed = parseReviewResponse({ data: RATE_FIXTURE }, '597600994634');
  assert.equal(parsed.total, '800');
  assert.equal(parsed.totalPage, '22');
  assert.equal(parsed.hasNext, true);
  assert.equal(parsed.reviews.length, 2);
  assert.equal(parsed.reviews[1].content, '第二次回购');
  assert.equal(parsed.reviews[1].reply, '感谢复购');
});

test('parseReviewResponse 空列表不抛错，且字符串 "false" 必须被认成 false', () => {
  const parsed = parseReviewResponse({ data: { total: '0', rateList: [], hasNext: 'false' } }, '1');
  assert.equal(parsed.reviews.length, 0);
  assert.equal(parsed.hasNext, false);
  // 真正的坑：'false' 在 JS 里是真值，写成 if (data.hasNext) 会一直翻页翻到死。
  assert.equal(parseReviewResponse({ data: { hasNext: 'false' } }, '1').hasNext, false);
  assert.equal(parseReviewResponse({ data: { hasNext: 'true' } }, '1').hasNext, true);
  assert.equal(parseReviewResponse({ data: {} }, '1').hasNext, false);
});

test('buildReviewRows 每列都在，图片用 | 连接', () => {
  const parsed = parseReviewResponse({ data: RATE_FIXTURE }, '597600994634');
  const rows = buildReviewRows(parsed.reviews);
  for (const col of REVIEW_COLUMNS) assert.ok(col in rows[0], `缺列 ${col}`);
  assert.equal(rows[0]['图片数'], '1');
  assert.match(rows[0]['图片链接'], /^https:\/\/img\.alicdn\.com\//u);
  assert.equal(rows[1]['图片数'], '0');
  assert.equal(rows[1]['图片链接'], '');
});

test('absoluteTaobaoUrl 只补协议，不改路径', () => {
  assert.equal(absoluteTaobaoUrl('//img.alicdn.com/a_b.jpg'), 'https://img.alicdn.com/a_b.jpg');
  assert.equal(absoluteTaobaoUrl('https://img.alicdn.com/a.jpg'), 'https://img.alicdn.com/a.jpg');
  assert.equal(absoluteTaobaoUrl(''), '');
  assert.equal(absoluteTaobaoUrl(null), '');
});
