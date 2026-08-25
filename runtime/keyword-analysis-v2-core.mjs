import { buildFormulaDefinitions } from './keyword-dual-table-core.mjs';

const TEXT = 1;
const NUMBER = 2;
const SINGLE_SELECT = 3;
const DATE = 5;

const field = (name, type = TEXT, property) => ({
  name,
  type,
  ...(property ? { property } : {}),
});

export const MAIN_CATEGORIES = [
  '大词', '品牌词', '材质词', '场景词', '痛点词',
  '款式词', '风格词', '尺寸词', '功能词',
];

export const BRAND_DICTIONARY = [
  { name: 'TOTO', aliases: ['toto'] },
  { name: '科勒', aliases: ['科勒', 'kohler'] },
  { name: '九牧', aliases: ['九牧', 'jomoo'] },
  { name: '箭牌', aliases: ['箭牌', 'arrow'] },
  { name: '浪鲸', aliases: ['浪鲸', 'ssww'] },
  { name: '卡德维', aliases: ['卡德维', 'kaldewei'] },
  { name: '杜拉维特', aliases: ['杜拉维特', 'duravit'] },
  { name: '埃飞灵', aliases: ['埃飞灵'] },
  { name: '汉斯格雅', aliases: ['汉斯格雅', 'hansgrohe'] },
];

export const FINE_LABEL_DICTIONARY = {
  场景: [
    '家用', '家装', '小户型', '公寓', '酒店民宿', '高端改善',
    '儿童', '老人', '无障碍', '情侣', '主卫', '次卫',
    '庭院', '阳台', '户外', '商用',
  ],
  痛点: ['空间受限', '舒适', '清洁', '安全', '保温', '漏水', '排水', '维修'],
  款式: [
    '独立式', '嵌入式', '搁置式', '台上式', '爪脚式', '无脚式',
    '靠墙式', '角落式', '转角式', '步入式', '门式', '坐式',
    '长方形', '椭圆形', '圆形', '扇形', '三角形', '蛋形',
  ],
  材质: ['亚克力', '铸铁', '钢板搪瓷', '人造石', '石英石', '实木', '柏木', '陶瓷', '铜'],
  尺寸: ['迷你', '小型', '标准型', '大型', '加长型', '单人', '双人', '多人'],
  功能: [
    '按摩', '水疗', '冲浪', '空气按摩', '深泡', '恒温', '加热',
    '保温', '带座椅', '音响', 'LED灯', '触控', '静音', '防滑', '淋浴组合',
  ],
  风格: ['现代简约', '北欧', '日式', '复古', '古典', '维多利亚式', '猫脚式', '设计款'],
};

const productDirection = field('对应产品方向', SINGLE_SELECT, {
  options: [
    { name: '小户型深泡款' },
    { name: '人造石高端款' },
    { name: '方形独立式' },
    { name: '靠墙式小浴缸' },
  ],
});

export const TEST_ANALYSIS_FIELDS = [
  field('排名', NUMBER),
  field('搜索词'),
  field('搜索人气'),
  field('点击率'),
  field('支付转化率'),
  field('关键词编号'),
  field('一级类目'),
  field('主关键词'),
  field('原始关键词'),
  field('标准归并词'),
  field('关键词分类'),
  field('细分标签'),
  field('用户意图'),
  field('分析状态'),
  field('平台来源'),
  field('搜索热度'),
  field('内容热度'),
  field('交易热度'),
  field('是否重点词'),
  field('优先级'),
  productDirection,
  field('采集日期', DATE, { date_formatter: 'yyyy/MM/dd' }),
];

export function buildV2FormulaDefinitions({ tableId, fieldIds, batchId }) {
  const base = buildFormulaDefinitions({ tableId, fieldIds });
  return {
    一级类目: base.一级类目,
    主关键词: base.主关键词,
    原始关键词: base.原始关键词,
    平台来源: base.来源渠道,
    搜索热度: base.搜索热度,
    交易热度: base.交易热度,
  };
}

function normalize(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}

export function extractBrands(keyword) {
  const normalized = normalize(keyword);
  return BRAND_DICTIONARY.flatMap((brand) => {
    const positions = brand.aliases
      .map((alias) => normalized.indexOf(normalize(alias)))
      .filter((position) => position >= 0);
    return positions.length ? [{ name: brand.name, position: Math.min(...positions) }] : [];
  })
    .sort((left, right) => left.position - right.position)
    .map((item) => item.name);
}

const NUMERIC_SIZE = /^(?:\d+(?:\.\d+)?\s*(?:米|m|厘米|cm)|\d+\s*[x×*]\s*\d+(?:\s*[x×*]\s*\d+)?\s*(?:厘米|cm|mm)?)$/iu;

export function validateFineLabels(value) {
  const labels = String(value ?? '')
    .split(/[、,，;；\n]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = labels.filter((label) => {
    const separator = label.indexOf('/');
    if (separator <= 0) return true;
    const dimension = label.slice(0, separator);
    const option = label.slice(separator + 1);
    if (!FINE_LABEL_DICTIONARY[dimension] || !option) return true;
    if (dimension === '尺寸' && NUMERIC_SIZE.test(option)) return false;
    return !FINE_LABEL_DICTIONARY[dimension].includes(option);
  });
  return { valid: invalid.length === 0, invalid };
}

function extractDemandSignals(value) {
  const normalized = normalize(value);
  const signals = [];
  for (const brand of extractBrands(value)) signals.push(`品牌/${brand}`);
  for (const [dimension, options] of Object.entries(FINE_LABEL_DICTIONARY)) {
    for (const option of options) {
      if (normalized.includes(normalize(option))) signals.push(`${dimension}/${option}`);
    }
  }
  for (const match of normalized.matchAll(/\d+(?:\.\d+)?\s*(?:米|m|厘米|cm)/giu)) {
    signals.push(`尺寸/${match[0].replaceAll(' ', '')}`);
  }
  return new Set(signals);
}

export function validateStandardMerge(sourceKeyword, mergedKeyword) {
  const source = String(sourceKeyword ?? '').trim();
  const merged = String(mergedKeyword ?? '').trim();
  if (!merged) return { valid: false, reason: '无法确认时必须回退原始关键词' };
  if (normalize(source) !== '浴缸' && normalize(merged) === '浴缸') {
    return { valid: false, reason: '禁止向上归类' };
  }
  const sourceSignals = extractDemandSignals(source);
  const mergedSignals = extractDemandSignals(merged);
  if ([...sourceSignals].some((signal) => !mergedSignals.has(signal))) {
    return { valid: false, reason: '归并词删除了明确需求信息' };
  }
  return { valid: true, reason: '' };
}

const INTENT_RULES = [
  {
    intent: '问题解决型',
    signals: ['怎么办', '怎么处理', '怎么修', '漏水', '堵塞', '下水慢', '异味', '发霉', '清洁', '清洗', '维修', '修理', '坏了', '故障', '除垢', '水垢', '裂缝', '开裂'],
  },
  {
    intent: '对比型',
    signals: ['哪个好', '哪种好', '哪个品牌好', '怎么选', '如何选', '对比', '比较', '区别', '差别', '评测', '测评', '推荐'],
  },
  {
    intent: '购买型',
    signals: ['官方旗舰店', '旗舰店', '正品', '哪里买', '在哪买', '怎么买', '购买', '多少钱', '价格', '价位', '报价', '优惠', '促销'],
  },
  {
    intent: '灵感型',
    signals: ['效果图', '装修', '案例', '搭配', '图片', '样板间', '实景', '设计'],
  },
];

export function classifyIntentBySignal(keyword) {
  const normalized = normalize(keyword);
  for (const rule of INTENT_RULES) {
    const signal = rule.signals.find((item) => normalized.includes(normalize(item)));
    if (signal) return { intent: rule.intent, basis: `规则命中：${signal}` };
  }
  return null;
}

const labelDictionaryText = Object.entries(FINE_LABEL_DICTIONARY)
  .map(([dimension, values]) => `${dimension}：${values.join('、')}`)
  .join('\n');

export const PROMPTS = {
  关键词分类: `你是浴缸关键词主分类助手。\n{{原始关键词}}\n以上引用字段是原始关键词。\n只能从以下九类中输出一个：${MAIN_CATEGORIES.join('、')}。\n\n规则：\n1. 明确问题、故障或处理诉求优先归痛点词。\n2. 品牌加通用品类、店铺或正品导航词归品牌词。\n3. 品牌与明确材质、场景、款式、风格、尺寸或功能同时出现时，主分类取明确产品属性；只有品牌与通用品类组合时归品牌词。\n4. 纯通用品类词归大词。\n5. 复合词只选最主要的需求属性，其余属性交给细分标签。\n6. 只输出一个分类名称，不解释。\n\n示例：\n科勒浴缸 -> 品牌词\n科勒铸铁浴缸 -> 材质词\n科勒浴缸官方旗舰店 -> 品牌词\n小户型浴缸 -> 场景词`,

  细分标签: `你是浴缸细分标签提取助手。\n{{原始关键词}}\n以上引用字段是原始关键词。只提取其中明确出现的信息，不补充、不推断。\n输出格式必须是“维度/标签”，多个标签用中文顿号分隔。\n\n受控字典：\n${labelDictionaryText}\n尺寸还允许原词明确出现的数字加单位，例如“尺寸/1.5米”。\n\n规则：\n1. 禁止输出浴缸、普通、其他、无标签等类目词或占位词。\n2. 禁止输出没有“维度/标签”前缀的自由分词。\n3. 步入式浴缸只能输出款式/步入式，不推断靠墙式。\n4. 小户型只输出场景/小户型，不推断尺寸/小型。\n5. 老人只输出场景/老人，不推断痛点/安全。\n6. 品牌不进入细分标签，由关键词分类中的品牌词承接。\n7. 没有合法标签时输出空，只输出标签结果。`,

  标准归并词: `你是电商搜索关键词标准化助手。\n{{原始关键词}}\n以上引用字段是原始关键词。只根据原始关键词本身，输出一个稳定、简短、可用于跨批次聚合统计的标准归并词。\n\n任务定义：\n标准归并不是向上分类，也不是提取品类词。它只把语义完全相同、需求条件完全一致的不同写法统一为同一输出。已经是清晰规范表达的关键词可以保持原样。\n\n处理顺序：\n1. 统一英文字母大小写、全角半角、无意义空格，以及数字和单位的书写格式。\n2. 仅在词义和成分边界明确时调整语序，统一按“品牌 + 系列/型号 + 场景 + 人群 + 尺寸 + 材质 + 风格/形状/安装方式 + 功能 + 核心对象 + 店铺/交易限定”排列；原词没有的成分不得新增。\n3. 统一可以确定为严格同义的表达，例如：家庭、家庭用、家用式统一为家用；内嵌、内嵌式统一为嵌入式；独立统一为独立式；一米统一为1米。\n4. 删除纯语气词或不改变需求的冗余字；其余信息全部保留。\n5. 完成后复核：标准归并词必须与原词指向同一需求，且再次执行本规则时结果不再变化。\n\n禁止事项：\n1. 只使用原始关键词中实际出现的信息。不得根据其他字段、所在表格、当前品类或常识补全缺失对象。原始关键词只有“浪鲸”时输出“浪鲸”，不得补成“浪鲸浴缸”。\n2. 禁止向上归类或只保留上位品类。原词包含品牌、系列/型号、材质、场景、人群、痛点、安装方式、款式、形状、风格、尺寸、功能、用途、年份、店铺或交易限定时，输出必须保留这些信息。\n3. 不得把相关但需求不同的词合并。任一需求属性不同，标准归并词就应不同。\n4. 不确定两个说法是否严格同义时，不要擅自替换；无法确认时原样输出原始关键词，不得留空。\n5. 不为了制造差异而改写。标准归并词与原始关键词相同是允许且正常的。\n\n特别边界：\n- 小浴缸与小户型浴缸含义不同，不得归并；小户型不得改写为小型。\n- 浴盆、浴池与浴缸不得自动视为同义词。\n- 日式与日本、陶瓷与搪瓷、按摩与冲浪或水疗不得自动视为同义词。\n- 方形与正方形、移动与免安装不得自动视为同义词。\n\n示例：\n浴缸家用 -> 家用浴缸\n家庭浴缸 -> 家用浴缸\n家用浴缸 -> 家用浴缸\n浴缸家用小户型 -> 家用小户型浴缸\n浴缸小户型家用 -> 家用小户型浴缸\ntoto浴缸 -> TOTO浴缸\n浴缸toto -> TOTO浴缸\n浴缸亚克力 -> 亚克力浴缸\n深泡缸 -> 深泡浴缸\n内嵌式浴缸 -> 嵌入式浴缸\n独立浴缸 -> 独立式浴缸\n一米小浴缸 -> 1米小浴缸\n惠达浴缸 -> 惠达浴缸\n科勒深泡浴缸 -> 科勒深泡浴缸\n小户型浴缸 -> 小户型浴缸\n小浴缸 -> 小浴缸\n浪鲸 -> 浪鲸\n\n只输出一个标准归并词，不输出解释、标签、标点或其他内容。`,

  用户意图: `你是浴缸关键词意图分类助手。\n{{原始关键词}}\n以上引用字段是原始关键词。\n只能输出：了解型、对比型、购买型、灵感型、问题解决型。\n\n同一关键词命中多类时，严格按以下优先级取最高项：\n问题解决型 > 对比型 > 购买型 > 灵感型 > 了解型。\n\n信号规则：\n1. 问题解决型：怎么办、怎么处理、怎么修、漏水、堵塞、下水慢、异味、发霉、清洁、清洗、维修、修理、坏了、故障、除垢、水垢、裂缝、开裂。\n2. 对比型：哪个好、哪种好、哪个品牌好、怎么选、如何选、对比、比较、区别、差别、评测、测评、推荐。\n3. 购买型：官方旗舰店、旗舰店、正品、哪里买、在哪买、怎么买、购买、多少钱、价格、价位、报价、优惠、促销。\n4. 灵感型：效果图、装修、案例、搭配、图片、样板间、实景、设计。\n5. 了解型：没有命中以上明确信号。\n\n边界：\n- 仅出现品牌，不自动判购买型。\n- 仅出现小户型、老人、酒店等场景，不自动判购买型。\n- 只输出一个意图名称，不解释。`,
};
