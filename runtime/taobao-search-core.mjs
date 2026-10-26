// 淘宝搜索页 → 周报 16 列 的纯函数内核。
//
// 为什么单独抽成一份：同一套归一化要供两个壳使用——
//   内部壳 runtime/collect-taobao-search.mjs（CDP，Node 侧调度）
//   外部壳（计划中，MV3 扩展，装到合作商家浏览器里）
// 两边取数都是页面主世界调 window.lib.mtop.request，注入方式不同，
// 但字段语义必须只有一份。分开写就会出现「我们这边对、商家那边不对」的分叉，
// 而那种分叉在数据层是查不出来的（两边都"成功"）。
//
// 数据保真（沿用 skills/xws-export-market-analysis/SKILL.md 的契约）：
//   月收货人数 原样保留页面的显示值，包括 1、0、-、100+ 这类形态；
//   不推断、不平滑、不因为数值看着异常就丢弃。异常只报告，不改数。
//
// 字段来源（2026-10-26 用真实销量排序响应逐条核对，非推测）：
//   序号        ← 递增
//   商品图片    ← pic_path
//   商品标题    ← title（剥掉 <span class=H> 高亮）
//   商品链接    ← item_id 拼 item.taobao.com（淘宝会自动跳天猫）
//   价格        ← priceShow.price ?? price
//   月收货人数  ← realSales 去掉「人收货」/「人付款」后缀
//   类目        ← categoryp（淘宝类目 ID 路径，需映射表转中文）
//   同款数      ← sameCount（自然位才有；广告位无此字段）
//   平台        ← auctionURL 域名；广告位（simba 链）看 iconList 是否含 tmall
//   占位类型    ← isP4p（注意是字符串 'true'/'false'，不是布尔）
//   店铺名      ← shopInfo.title ?? nick
//   店铺旺旺    ← nick
//   店铺类型    ← 天猫看店名后缀（旗舰店/专卖店/专营店），其余「非金牌店铺」
//   地址        ← procity
//   收藏人数    ← 固定 '-'（搜索接口无此字段；小旺神同样全空，1441/1441 都是 '-'）
//   卖点        ← icons 里 type==='text' 的 text，空格连接

export const WEEKLY_COLUMNS = Object.freeze([
  '序号', '商品图片', '商品标题', '商品链接', '价格', '月收货人数', '类目', '同款数',
  '平台', '占位类型', '店铺名', '店铺旺旺', '店铺类型', '地址', '收藏人数', '卖点',
]);

// 销量排序的 sort 取值。实测：'_sale' 单调性 90%，综合排序 '_coefp' 只有 46%。
// 周报的 sort='sales' 对应这个值，不是字面 'sales'。
export const SALE_SORT = '_sale';
export const DEFAULT_SORT = '_coefp';
export const DEFAULT_PAGE_SIZE = 48;

// 淘宝搜索主接口。换接口等于换数据源，改动前先对照 evidence 里的原始响应。
export const SEARCH_API = 'mtop.relationrecommend.wirelessrecommend.recommend';
export const SEARCH_API_VERSION = '2.0';
export const SEARCH_APP_ID = '34385';
export const SEARCH_APP_KEY = '12574478';

const PLACEHOLDER_COLLECT = '-';

// 标题里的搜索词高亮：<span class=H>浴缸</span> → 浴缸。
// 只删高亮标签，不删其他内容——标题本身就是原文，不要顺手做「清洗美化」。
export function stripHighlight(html) {
  return String(html ?? '').replace(/<span\s+class=["']?H["']?\s*>/giu, '').replace(/<\/span>/giu, '').trim();
}

// 月收货人数：只剥后缀，剩下的原样留。
// '200+人收货' → '200+'；'81人收货' → '81'；'-' → '-'；'行业销量前20' → 原样（不是销量数字，不能瞎转）
export function salesCountOf(realSales) {
  const raw = String(realSales ?? '').trim();
  if (!raw) return '';
  const stripped = raw.replace(/人收货$/u, '').replace(/人付款$/u, '').replace(/人已买$/u, '').trim();
  return stripped || raw;
}

// 可数：纯数字，允许末尾一个 +（'200+' 是淘宝的「200 以上」写法）。
const COUNT_PATTERN = /^\d+(?:\.\d+)?\+?$/u;

export function isCountLike(value) {
  return COUNT_PATTERN.test(String(value ?? '').trim());
}

// 计数列（16 列契约里的「月收货人数」）该写什么。
//
// 为什么要单独一层：下游 import-core 的 numericValue 对这个列是**强校验**，
// 非数字直接抛 SOURCE_VALUE_INVALID 让整批导入失败（2026-10-26 实测 23 行）。
// 淘宝对部分商品不公布数字，只给「本月行业热销」「行业销量Top3」这类徽标——
// 那是「有没有进榜」，不是「卖了多少」。所以计数列留空（＝未披露），
// 徽标原文另走 salesBadgeOf / extractSalesBadges 留证。
// 折算成数字（前20→20）属于编造，不干。
export function countColumnOf(realSales) {
  const text = salesCountOf(realSales);
  return isCountLike(text) ? text : '';
}

export function salesBadgeOf(realSales) {
  const text = salesCountOf(realSales);
  return text && !isCountLike(text) ? text : '';
}

// 从**已归一化**的行里回收徽标原文，供侧车文件留证与对账。
// 已经过 countColumnOf 的行这里是空的，所以它只对「原文还在」的数据有意义。
export function extractSalesBadges(rows) {
  const badges = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = String(row?.月收货人数 ?? '').trim();
    if (!value || isCountLike(value)) continue;
    badges.push({
      序号: String(row?.序号 ?? ''),
      商品链接: String(row?.商品链接 ?? ''),
      商品标题: String(row?.商品标题 ?? ''),
      月收货人数原文: value,
    });
  }
  return badges;
}

// 平台：先看商品链接域名（最可靠），广告位的 simba 链没有域名信息，退回看 iconList。
export function platformOf(item) {
  const url = String(item?.auctionURL ?? '');
  if (/detail\.tmall\.com/iu.test(url)) return '天猫';
  if (/item\.taobao\.com/iu.test(url)) return '淘宝';
  const iconList = String(item?.iconList ?? '');
  if (iconList.split(',').includes('tmall')) return '天猫';
  return '淘宝';
}

// 占位类型：isP4p 是字符串 'true'/'false'，也有缺字段的情况。
// 缺字段时退回 iconList 里的 'guanggao' 标记——广告位的 isP4p 有时不写。
export function placementOf(item) {
  const flag = item?.isP4p;
  if (flag === true || String(flag) === 'true') return '广告位';
  if (String(item?.iconList ?? '').split(',').includes('guanggao')) return '广告位';
  return '自然位';
}

// 店铺类型：口径与小旺神导出一致（可用 2026-10-19 的 1441 行反推验证）。
// 天猫店按店名后缀分旗舰/专卖/专营；淘宝店与其余天猫店一律「非金牌店铺」。
// 1441 行实测：非金牌 974 + 旗舰店 444 + 专卖店 21 + 专营店 2 = 1441，
// 而平台天猫 485 = 旗舰 444 + 专卖 21 + 专营 2 + 18 个没有后缀的天猫店 ⇒ 那 18 个落在「非金牌」。
export function shopTypeOf(item) {
  if (platformOf(item) !== '天猫') return '非金牌店铺';
  const name = String(item?.shopInfo?.title ?? item?.nick ?? '');
  if (/旗舰店/u.test(name)) return '旗舰店';
  if (/专卖店/u.test(name)) return '专卖店';
  if (/专营店/u.test(name)) return '专营店';
  return '非金牌店铺';
}

// 卖点：icons 里 type==='text' 的 text 按原顺序空格连接。
// 实测 '直接下单享优惠' + '包邮' → '直接下单享优惠 包邮'，与导出 CSV 逐字一致。
export function sellingPointsOf(item) {
  const icons = Array.isArray(item?.icons) ? item.icons : [];
  return icons
    .filter((icon) => icon && icon.type === 'text' && typeof icon.text === 'string' && icon.text.trim())
    .map((icon) => icon.text.trim())
    .join(' ');
}

// 图片地址：接口会给 // 开头的协议相对地址，补成 https。
export function imageUrlOf(item) {
  const raw = String(item?.pic_path ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  return raw;
}

// 商品链接：统一用 item.taobao.com/item.htm?id=，淘宝会对天猫商品自动跳转。
// 不用 auctionURL——广告位那条是 click.simba 的计费链，不能落到表里。
export function itemUrlOf(item) {
  const id = String(item?.item_id ?? '').trim();
  if (!id) return '';
  return `https://item.taobao.com/item.htm?id=${id}`;
}

// 价格：页面主价是 priceShow.price（可能带 priceDesc='补贴后'），没有才退回 price。
// 保留原始字符串形态（'600+'、'382'、'262.35' 都可能出现），不转数字——
// 转了就把「下限值」这个信息丢了，而下游「计算口径」正好要靠它区分精确值/下限值。
export function priceOf(item) {
  const shown = item?.priceShow?.price;
  const raw = shown !== undefined && shown !== null && String(shown).trim() !== ''
    ? String(shown).trim()
    : String(item?.price ?? '').trim();
  return raw;
}

// 类目：categoryp 是空格分隔的类目 ID 路径（'27 50020016 50002411'）。
// 先按完整路径查表，再退回叶子 ID——完整路径更精确，叶子可能跨父类重名。
// 都没命中时保留 ID 原值，不要编一个中文名出来（编了没人会回头核对）。
export function categoryOf(item, categoryMap = null) {
  const raw = String(item?.categoryp ?? '').trim();
  if (!raw) return '';
  const leaf = String(item?.leafCategory ?? '').trim();
  if (categoryMap && categoryMap[raw]) return categoryMap[raw];
  if (categoryMap && leaf && categoryMap[leaf]) return categoryMap[leaf];
  return raw;
}

// 同款数：sameCount 是字符串。
// 自然位缺字段时填 '0'——与 10-19 导出对齐（那 22 条差异全是「旧 0 → 新空」）；
// 广告位缺字段时留空，因为广告位本来就不返回这个字段，填 0 属于编造。
export function sameCountOf(item) {
  const value = item?.sameCount;
  if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  return placementOf(item) === '自然位' ? '0' : '';
}

// 单条归一化。index 从 1 开始（序号列是给人看的）。
export function normalizeItem(item, index, options = {}) {
  const { categoryMap = null } = options;
  return {
    序号: String(index),
    商品图片: imageUrlOf(item),
    商品标题: stripHighlight(item?.title),
    商品链接: itemUrlOf(item),
    价格: priceOf(item),
    月收货人数: countColumnOf(item?.realSales),
    类目: categoryOf(item, categoryMap),
    同款数: sameCountOf(item),
    平台: platformOf(item),
    占位类型: placementOf(item),
    店铺名: String(item?.shopInfo?.title ?? item?.nick ?? '').trim(),
    店铺旺旺: String(item?.nick ?? '').trim(),
    店铺类型: shopTypeOf(item),
    地址: String(item?.procity ?? '').trim(),
    收藏人数: PLACEHOLDER_COLLECT,
    卖点: sellingPointsOf(item),
  };
}

export function normalizeItems(items, options = {}) {
  const { startIndex = 1, categoryMap = null } = options;
  const list = Array.isArray(items) ? items : [];
  return list.map((item, offset) => normalizeItem(item, startIndex + offset, { categoryMap }));
}

// 去重：同一个商品可能因为广告位/推荐位重复出现。
// 保留首次出现（即排名更靠前的那条），后面的丢掉。序号在去重后重排。
//
// 同时丢掉没有商品链接的行：下游 merge-market-analysis 的 validateDataset
// 明确要求「链接非空且唯一、序号连续 1..N」，空链接行会让整批校验失败。
// 与其让下游报错，不如在这里丢并计数——但要计数，不能静默丢（见 dedupeReport）。
export function dedupeByItemId(rows) {
  const seen = new Set();
  const out = [];
  let droppedBlank = 0;
  let droppedDuplicate = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.商品链接 ?? '').trim();
    if (!id) { droppedBlank += 1; continue; }
    if (seen.has(id)) { droppedDuplicate += 1; continue; }
    seen.add(id);
    out.push(row);
  }
  const renumbered = out.map((row, index) => ({ ...row, 序号: String(index + 1) }));
  // 把丢弃明细挂在数组上而不是塞进行里——行是要写 CSV 的，不能多一列。
  Object.defineProperty(renumbered, 'dedupeReport', {
    value: { kept: renumbered.length, droppedBlank, droppedDuplicate },
    enumerable: false,
  });
  return renumbered;
}

// CSV 单元格转义：逗号、双引号、换行都要包引号。
export function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  if (/[",\r\n]/u.test(text)) return `"${text.replace(/"/gu, '""')}"`;
  return text;
}

// 生成周报格式的 CSV。带 UTF-8 BOM，否则 Excel 打开中文会乱码。
export function toCsv(rows, columns = WEEKLY_COLUMNS) {
  const header = columns.map(csvCell).join(',');
  const body = (Array.isArray(rows) ? rows : []).map((row) => columns.map((col) => csvCell(row?.[col])).join(','));
  return `\ufeff${[header, ...body].join('\r\n')}\r\n`;
}

// 解析 CSV 文本，返回行数组（含表头作为第 0 行）。toCsv 的逆运算。
// 处理点：BOM、CRLF/CR/LF 三种行尾、引号内的逗号与换行、"" 转义的引号。
// 不处理：字段类型推断（一律返回字符串）、超长字段截断（不截）。
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^\ufeff/u, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (quoted) {
      if (ch === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 2; continue; }
        quoted = false; index += 1; continue;
      }
      field += ch; index += 1; continue;
    }
    if (ch === '"') { quoted = true; index += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; index += 1; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      index += ch === '\r' && source[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch; index += 1;
  }
  // 结束时若还有未落盘的内容（无尾随换行），补最后一行
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// 分页计划：把 1..N 页切成若干段，供驱动按段执行与续跑。
export function buildSegments(totalPages, segmentSize = 4) {
  const total = Number(totalPages);
  const size = Number(segmentSize);
  if (!Number.isInteger(total) || total < 1) throw new Error(`totalPages 非法：${totalPages}`);
  if (!Number.isInteger(size) || size < 1) throw new Error(`segmentSize 非法：${segmentSize}`);
  const segments = [];
  for (let start = 1; start <= total; start += size) {
    const end = Math.min(start + size - 1, total);
    segments.push({ id: `${start}-${end}`, start, end });
  }
  return segments;
}

// 请求参数。字段名沿用页面首次请求的原始拼写（大小写敏感，改一个就 SUCCESS 但返回空）。
export function buildSearchParams({ keyword, page, pageSize = DEFAULT_PAGE_SIZE, sort = SALE_SORT, priceMin = null, priceMax = null }) {
  if (!keyword) throw new Error('keyword 必填');
  const q = String(keyword).trim();
  if (!q) throw new Error('keyword 不能为空');
  return {
    device: 'HMA-AL00', isBeta: 'false', grayHair: 'false', from: 'nt_history', brand: 'HUAWEI',
    info: 'wifi', index: '4', rainbow: '', schemaType: 'auction', elderHome: 'false',
    isEnterSrpSearch: 'true', newSearch: 'false', network: 'wifi', subtype: '', hasPreposeFilter: 'false',
    prepositionVersion: 'v2', client_os: 'Android', gpsEnabled: 'false', searchDoorFrom: 'srp',
    debug_rerankNewCardOpen: 'false', homePageVersion: 'v7', searchElderHomeOpen: 'false',
    search_action: 'initiative', sugg: '_4_1', sversion: '13.6', style: 'list',
    ttid: '600000@taobao_pc_10.7.0', needTabs: 'true', areaCode: 'CN', vm: 'nw', countryNum: '156',
    m: 'pc', page: Number(page), n: Number(pageSize), q, qSource: 'url', pageSource: '', channelSrp: '',
    tab: 'all', pageSize: Number(pageSize), totalPage: 100, totalResults: 4800, sourceS: '0', sort,
    bcoffset: '', ntoffset: '', filterTag: '', service: '', prop: '', loc: '',
    start_price: priceMin, end_price: priceMax, startPrice: priceMin, endPrice: priceMax,
    itemIds: null, p4pIds: null, p4pS: null, categoryp: '', ha3Kvpairs: null, appId: SEARCH_APP_ID,
  };
}
