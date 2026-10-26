// 淘宝详情页数据归一化（SKU / 评价）——唯一实现。
//
// 为什么单独一个 core：采集器只管「把请求发出去、把结果带回来」，
// 字段解析放这里才能被测试钉住。2026-10-26 实测过一个坑：
// 小旺神从详情页 React 树里读评论，字段是 reviewInfo/feedPicList；
// 而 mtop.taobao.rate.detaillist.get 直接返回的字段是 feedback/feedPicPathList。
// 两者不同名，拿小旺神的结构套接口会全空。这里以接口实测为准。

export const SKU_API = 'mtop.taobao.pcdetail.data.get';
export const SKU_API_VERSION = '1.0';
export const REVIEW_API = 'mtop.taobao.rate.detaillist.get';
export const REVIEW_API_VERSION = '6.0';
export const APP_KEY = '12574478';
export const DETAIL_V = '3.3.2';
export const DEFAULT_REVIEW_PAGE_SIZE = 40;

export const SKU_COLUMNS = Object.freeze([
  '商品ID', '商品标题', 'SKU ID', '属性组合', '价格', '库存', 'SKU图', '属性JSON',
]);

export const SKU_ATTR_COLUMNS = Object.freeze([
  '商品ID', '商品标题', '属性名', '属性值数', '属性值', '有图值数',
]);

export const REVIEW_COLUMNS = Object.freeze([
  '商品ID', '评价ID', '评价时间', '评价类型', '购买SKU', '评价内容',
  '图片数', '图片链接', '商家回复', '用户昵称',
]);

// 只认实测过的映射。rateType='1' 在本项目样本里全是好评；
// 2/3 按淘宝惯例映射但本轮没有样本，遇到未知值一律原样保留，不猜。
const RATE_TYPE_LABELS = new Map([
  ['1', '好评'],
  ['2', '中评'],
  ['3', '差评'],
]);

export function rateTypeLabel(value) {
  const key = String(value ?? '').trim();
  return RATE_TYPE_LABELS.get(key) ?? key;
}

// SKU 请求参数。集中在这里，采集器和测试用同一份，避免两边各写一套。
export function buildSkuRequestData(itemId) {
  const id = String(itemId ?? '').trim();
  if (!/^\d{1,30}$/u.test(id)) throw new Error(`商品 ID 不合法：${itemId}`);
  return {
    id,
    detail_v: DETAIL_V,
    exParams: JSON.stringify({
      id,
      queryParams: `id=${id}`,
      domain: 'https://item.taobao.com',
      path_name: '/item.htm',
    }),
  };
}

export function buildReviewRequestData(itemId, { page = 1, pageSize = DEFAULT_REVIEW_PAGE_SIZE } = {}) {
  const id = String(itemId ?? '').trim();
  if (!/^\d{1,30}$/u.test(id)) throw new Error(`商品 ID 不合法：${itemId}`);
  if (!Number.isInteger(page) || page < 1) throw new Error(`页码不合法：${page}`);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error(`每页条数不合法：${pageSize}`);
  // 这几个常量照抄实测能通的形态，别"优化"——参数一改就 ABORT。
  return {
    showTrueCount: false,
    auctionNumId: id,
    pageNo: page,
    pageSize,
    rateType: '',
    searchImpr: -8,
    orderType: '',
    expression: '',
    rateSrc: 'pc_rate_list',
  };
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

// //img.alicdn.com/... → https://img.alicdn.com/...
export function absoluteTaobaoUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  return raw;
}

// skuBase 的真实形状（2026-10-26 实测 detail.tmall.com 商品 597600994634）：
//   props: [{ pid, name, values: [{ vid, name, image }] }]
//   skus:  [{ skuId, propPath: 'pid:vid;pid:vid' }]   ← 只有这两个字段，没有价格和库存
// 价格/库存在 skuCore.sku2info[skuId] 里：
//   { price: { priceText: '6284', priceMoney: '628400'(分), priceDesc, priceTitle }, quantity: '200', quantityText }
// sku2info 里还有一个 key 为 "0" 的默认项（未选规格时的聚合价），不能当成某个 SKU 用。
export function parseSkuBase(skuBase, { skuCore } = {}) {
  if (!skuBase || typeof skuBase !== 'object') {
    throw new Error('skuBase 缺失：该商品可能没有 SKU，或接口未返回');
  }
  const props = Array.isArray(skuBase.props) ? skuBase.props : [];
  const skus = Array.isArray(skuBase.skus) ? skuBase.skus : [];
  const sku2info = skuCore && typeof skuCore === 'object' && skuCore.sku2info && typeof skuCore.sku2info === 'object'
    ? skuCore.sku2info
    : {};

  const index = new Map();
  const attributes = [];
  for (const prop of props) {
    const pid = text(prop?.pid);
    if (!pid) continue;
    const values = (Array.isArray(prop?.values) ? prop.values : [])
      .map((v) => ({
        vid: text(v?.vid),
        name: text(v?.name),
        image: absoluteTaobaoUrl(v?.image),
      }))
      .filter((v) => v.vid);
    index.set(pid, { name: text(prop?.name) || pid, values: new Map(values.map((v) => [v.vid, v])) });
    attributes.push({
      pid,
      name: text(prop?.name) || pid,
      values: values.map((v) => v.name),
      imageCount: values.filter((v) => v.image).length,
    });
  }

  const parsedSkus = skus.map((sku) => {
    const propPath = text(sku?.propPath);
    const skuId = text(sku?.skuId);
    const attrs = [];
    const images = [];
    // propPath 里可能出现 props 未覆盖的 pid，保留原值不丢，避免"看起来解析成功其实少一列"。
    for (const segment of propPath.split(';')) {
      const piece = segment.trim();
      if (!piece) continue;
      const sep = piece.indexOf(':');
      if (sep < 0) continue;
      const pid = piece.slice(0, sep);
      const vid = piece.slice(sep + 1);
      const prop = index.get(pid);
      const value = prop?.values.get(vid);
      attrs.push({ pid, name: prop?.name ?? pid, vid, value: value?.name ?? vid });
      if (value?.image) images.push(value.image);
    }
    const info = sku2info[skuId];
    return {
      skuId,
      propPath,
      attrs,
      attributeText: attrs.map((a) => `${a.name}=${a.value}`).join('；'),
      price: priceOfSku(info),
      store: info?.quantity == null ? '' : text(info.quantity),
      storeText: text(info?.quantityText),
      image: images[0] ?? '',
    };
  });

  return { props: attributes, skus: parsedSkus };
}

// priceText 已是元；只有 priceMoney 时按分转元。两者都没有就留空，不补 0。
export function priceOfSku(info) {
  const priceText = text(info?.price?.priceText);
  if (priceText) return priceText;
  const money = text(info?.price?.priceMoney);
  if (!money) return '';
  const cents = Number(money);
  if (!Number.isFinite(cents)) return '';
  return (cents / 100).toFixed(2);
}

export function buildSkuRows(parsed, { itemId, title } = {}) {
  const id = text(itemId);
  const name = text(title);
  return parsed.skus.map((sku) => ({
    商品ID: id,
    商品标题: name,
    'SKU ID': sku.skuId,
    属性组合: sku.attributeText,
    价格: sku.price,
    库存: sku.store,
    SKU图: sku.image,
    属性JSON: JSON.stringify(Object.fromEntries(sku.attrs.map((a) => [a.name, a.value]))),
  }));
}

// 属性字典：只回答"这个商品有哪些属性维度、每个维度几个值"，
// 用来判断「尺寸/适用空间」这类列能不能从 SKU 里取到。
export function buildSkuAttributeRows(parsed, { itemId, title } = {}) {
  return parsed.props.map((prop) => ({
    商品ID: text(itemId),
    商品标题: text(title),
    属性名: prop.name,
    属性值数: String(prop.values.length),
    属性值: prop.values.join(' / '),
    有图值数: String(prop.imageCount),
  }));
}

// 从 pcdetail 响应里挑出我们用的部分，顺带校验商品没串。
export function readItemPayload(response, expectedItemId) {
  const data = response?.data;
  if (!data || typeof data !== 'object') throw new Error('pcdetail 未返回 data');
  const actual = text(data.item?.itemId);
  const expected = text(expectedItemId);
  if (expected && actual !== expected) {
    throw new Error(`商品不一致：期望 ${expected}，返回 ${actual || '(空)'}`);
  }
  return {
    itemId: actual,
    title: text(data.item?.title),
    seller: {
      sellerId: text(data.seller?.sellerId),
      shopId: text(data.seller?.shopId),
      shopName: text(data.seller?.shopName),
      sellerNick: text(data.seller?.sellerNick),
      pcShopUrl: absoluteTaobaoUrl(data.seller?.pcShopUrl),
    },
    skuBase: data.skuBase ?? null,
    skuCore: data.skuCore ?? null,
  };
}

export function parseReviewResponse(response, expectedItemId) {
  const data = response?.data;
  if (!data || typeof data !== 'object') throw new Error('评价接口未返回 data');
  const list = Array.isArray(data.rateList) ? data.rateList : [];
  return {
    total: text(data.total),
    totalPage: text(data.totalPage),
    hasNext: text(data.hasNext) === 'true',
    reviews: list.map((raw) => normalizeReview(raw, expectedItemId)),
  };
}

export function normalizeReview(raw, itemId) {
  const pics = (Array.isArray(raw?.feedPicPathList) ? raw.feedPicPathList : [])
    .map(absoluteTaobaoUrl)
    .filter(Boolean);
  return {
    itemId: text(itemId) || text(raw?.auctionNumId),
    reviewId: text(raw?.id),
    date: text(raw?.feedbackDate) || text(raw?.createTime),
    rateType: rateTypeLabel(raw?.rateType),
    sku: text(raw?.skuValueStr),
    content: text(raw?.feedback),
    pics,
    reply: text(raw?.reply),
    userNick: text(raw?.userNick) || text(raw?.reduceUserNick),
  };
}

export function buildReviewRows(reviews) {
  return reviews.map((r) => ({
    商品ID: r.itemId,
    评价ID: r.reviewId,
    评价时间: r.date,
    评价类型: r.rateType,
    购买SKU: r.sku,
    评价内容: r.content,
    图片数: String(r.pics.length),
    图片链接: r.pics.join(' | '),
    商家回复: r.reply,
    用户昵称: r.userNick,
  }));
}
