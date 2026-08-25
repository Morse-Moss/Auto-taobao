const TEXT = 1;
const NUMBER = 2;
const SINGLE_SELECT = 3;
const MULTI_SELECT = 4;
const ATTACHMENT = 17;
const BIDIRECTIONAL_LINK = 21;
const FORMULA = 20;

export { COMPETITOR_AI_PROMPTS } from './competitor-v2-prompts.mjs';

const field = (name, type = TEXT, optionNames = []) => ({
  name,
  type,
  ...(optionNames.length > 0
    ? { property: { options: optionNames.map((option) => ({ name: option })) } }
    : {}),
});

export const SOURCE_FIELD_NAMES = [
  '序号', '商品图片', '商品标题', '商品链接', '价格', '月收货人数',
  '类目', '同款数', '平台', '占位类型', '店铺名', '店铺旺旺',
  '店铺类型', '地址', '收藏人数', '卖点',
];

const MATERIALS = ['亚克力', '人造石', '塑料', '陶瓷', '钢瓷', '铸铁', '透明', '木', '搪瓷'];
const HUMAN_MADE_STONE_ALIASES = [
  '人造石', 'PMMA', '高分子', '绮美石', '可丽耐', '杜邦石', '亚克力人造石',
];
const SHAPES = ['椭圆', '方形', '蛋形', '异形', '正圆'];
const INSTALLATIONS = ['独立', '嵌入', '靠墙', '台上/搁置'];
const FUNCTIONS = ['普通', '按摩', '智能', '恒温'];
const STYLES = ['极简', '奶油', '日式', '轻奢'];
const COMPETITOR_CLASSES = [
  'A-高销量高GMV竞品', 'B-高价值竞品', 'C-中价位竞品', 'D-低价位竞品', '无分类', '不适用',
];
export const SKU_APPLICABLE_SPACES = ['小户型', '常规卫生间'];
export const SKU_SPACE_DECISION_STATUSES = ['已判定', '需人工核验'];
export const SKU_RELATION_FIELD_NAME = '所属竞品';
export const SKU_BACKLINK_FIELD_NAME = 'SKU采集明细';
const SKU_PENDING_ITEMS = ['SKU明细', 'SKU尺寸', '空间判定'];
const ANALYSIS_NOTES = ['无注明', '不适用'];
export const COMPETITOR_AI_ATTRIBUTE_FIELDS = [
  { name: '材质分类', type: MULTI_SELECT },
  { name: '外形', type: MULTI_SELECT },
  { name: '安装方式', type: MULTI_SELECT },
  { name: '功能', type: MULTI_SELECT },
  { name: '风格', type: MULTI_SELECT },
  { name: '尺寸', type: TEXT },
  { name: '适用空间', type: MULTI_SELECT },
];
export const COMPETITOR_AI_FIELD_NAMES = COMPETITOR_AI_ATTRIBUTE_FIELDS.map(({ name }) => name);
const SERVICE_TERMS = ['上门安装', '维修服务'];
const ACCESSORY_TERMS = ['龙头', '花洒套装', '角阀', '下水器', '排水器', '盖板', '扶手', '靠枕'];
const NON_BATHTUB_TERMS = [
  '洗脚池', '洗脚盆', '泡脚盆', '足浴', '宠物', '狗洗澡', '猫洗澡', '婴儿', '新生儿',
];
const CHILD_TERMS = ['儿童'];
const PORTABLE_BATH_TERMS = ['浴盆', '澡盆', '折叠', '充气', '便携'];
const BATHTUB_TERMS = ['浴缸', '浴桶', '浴盆', '洗澡盆'];
const BATHTUB_BODY_TERMS = ['成人', '大人', '老人', '独立式', '嵌入式', '靠墙式', '深泡', '可移动'];
const PENDING_ITEMS = [
  '月收货人数精确值', '材质分类', '外形', '安装方式', '功能', '风格',
  '尺寸', '适用空间', '是否有效竞品', 'SKU尺寸', '问大家', '评论',
];

export const COMPETITOR_MAIN_FIELDS = [
  field('序号'),
  field('商品图片', ATTACHMENT),
  field('商品标题'),
  field('商品链接'),
  field('价格', NUMBER),
  field('月收货人数'),
  field('类目'),
  field('同款数'),
  field('平台'),
  field('占位类型'),
  field('店铺名'),
  field('店铺旺旺'),
  field('店铺类型'),
  field('地址'),
  field('收藏人数'),
  field('卖点'),
  field('搜索关键词'),
  field('月收货人数计算值', NUMBER),
  field('计算口径', SINGLE_SELECT, ['精确值', '下限值', '不可计算']),
  field('月收货金额', NUMBER),
  field('客单价带分类', SINGLE_SELECT, [
    '1000以下', '1000-3000', '3000-6000', '6000-8000', '8000以上',
  ]),
  field('材质分类', MULTI_SELECT, [...MATERIALS, '无注明', '不适用']),
  field('外形', MULTI_SELECT, [...SHAPES, '无注明', '不适用']),
  field('安装方式', MULTI_SELECT, [...INSTALLATIONS, '无注明', '不适用']),
  field('功能', MULTI_SELECT, [...FUNCTIONS, '无注明', '不适用']),
  field('风格', MULTI_SELECT, [...STYLES, '无注明', '不适用']),
  field('竞品分类', SINGLE_SELECT, COMPETITOR_CLASSES),
  field('尺寸'),
  field('适用空间', MULTI_SELECT, ['小户型', '常规卫生间', '大户型', '无注明', '不适用']),
  field('数据状态', SINGLE_SELECT, ['可用', '部分待补']),
  field('待补数据项', MULTI_SELECT, PENDING_ITEMS),
  field('是否有效竞品', SINGLE_SELECT, ['是', '否', '待确认']),
  field('排除原因'),
];

export const SKU_DETAIL_FIELDS = [
  field('商品链接'),
  field('商品标题'),
  field('竞品分类', SINGLE_SELECT, COMPETITOR_CLASSES),
  field('SKU名称'),
  field('SKU规格'),
  field('SKU尺寸'),
  field('尺寸汇总'),
  field('适用空间', SINGLE_SELECT, SKU_APPLICABLE_SPACES),
  field('空间判定状态', SINGLE_SELECT, SKU_SPACE_DECISION_STATUSES),
  field('空间判定依据'),
  field('商品ID'),
  field('SKU唯一键'),
  field('采集状态', SINGLE_SELECT, ['待采集', '已采集', '需人工核验']),
  field('待补数据项', MULTI_SELECT, SKU_PENDING_ITEMS),
];

export const QUESTION_LIBRARY_FIELDS = [
  field('商品链接'),
  field('商品标题'),
  field('竞品分类', SINGLE_SELECT, COMPETITOR_CLASSES),
  field('来源类型', SINGLE_SELECT, ['问大家', '评论']),
  field('原始内容'),
  field('高频问题或关键词'),
  field('出现次数', NUMBER),
  field('采集状态', SINGLE_SELECT, ['待采集', '已采集', '需人工核验']),
];

function text(value) {
  return String(value ?? '').trim();
}

const SKU_DIMENSION_UNIT_PATTERN = '(?:毫米|mm|厘米|cm|公分|米|m)';
const SKU_DIMENSION_TOKEN_PATTERN = new RegExp(
  `(?<![\\d.])(\\d+(?:\\.\\d+)?)\\s*(${SKU_DIMENSION_UNIT_PATTERN})(?![a-z])`,
  'giu',
);
const SKU_DIMENSION_CHAIN_PATTERN = new RegExp(
  `(?<![\\d.])(?:\\d+(?:\\.\\d+)?\\s*[x×*]\\s*)+\\d+(?:\\.\\d+)?\\s*(${SKU_DIMENSION_UNIT_PATTERN})(?![a-z])`,
  'giu',
);
const SKU_DIMENSION_RANGE_PATTERN = new RegExp(
  `(?<![\\d.])\\d+(?:\\.\\d+)?\\s*(?:${SKU_DIMENSION_UNIT_PATTERN})?\\s*[-~～至到]\\s*\\d+(?:\\.\\d+)?\\s*${SKU_DIMENSION_UNIT_PATTERN}(?![a-z])`,
  'iu',
);
const SKU_NON_LINEAR_SHAPE_PATTERN = /正圆|圆形|圆桶|圆缸|正方形|方形|正方/iu;

function skuMeterValue(value, unit) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const normalizedUnit = String(unit).toLowerCase();
  if (normalizedUnit === 'mm' || normalizedUnit === '毫米') return numeric / 1000;
  if (normalizedUnit === 'cm' || normalizedUnit === '厘米' || normalizedUnit === '公分') return numeric / 100;
  if (normalizedUnit === 'm' || normalizedUnit === '米') return numeric;
  return null;
}

function skuMeterText(value) {
  return `${Number(value.toFixed(3)).toString()}m`;
}

function spansOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

function skuDimensionCandidates(value) {
  const source = text(value);
  if (!source) return { source, hasRange: false, candidates: [] };
  const chains = [];
  // Clone global patterns so a prior SKU cannot carry a regexp lastIndex into
  // the next deterministic classification.
  for (const match of source.matchAll(new RegExp(SKU_DIMENSION_CHAIN_PATTERN))) {
    const full = match[0];
    const unit = match[1];
    const values = full.match(/\d+(?:\.\d+)?/gu)
      .map((item) => skuMeterValue(item, unit))
      .filter((item) => item != null);
    if (values.length === 0) continue;
    const start = match.index ?? 0;
    chains.push({ start, end: start + full.length, meters: Math.max(...values), evidence: full });
  }

  const candidates = [...chains];
  for (const match of source.matchAll(new RegExp(SKU_DIMENSION_TOKEN_PATTERN))) {
    const full = match[0];
    const start = match.index ?? 0;
    const end = start + full.length;
    if (chains.some((chain) => spansOverlap({ start, end }, chain))) continue;
    const meters = skuMeterValue(match[1], match[2]);
    if (meters != null) candidates.push({ start, end, meters, evidence: full });
  }

  const deduplicated = [];
  for (const candidate of candidates.sort((left, right) => left.start - right.start)) {
    if (!deduplicated.some((item) => Math.abs(item.meters - candidate.meters) < 0.000001)) {
      deduplicated.push(candidate);
    }
  }
  return {
    source,
    hasRange: SKU_DIMENSION_RANGE_PATTERN.test(source),
    candidates: deduplicated,
  };
}

function skuEvidenceValue(skuSize, skuSpec) {
  const values = [
    ['SKU尺寸', text(skuSize)],
    ['SKU规格', text(skuSpec)],
  ].filter(([, value]) => value);
  return values.map(([name, value]) => `${name}=${value}`).join('；');
}

export function classifySkuSpace({ skuSize, skuSpec = '', skuName = '' } = {}) {
  const explicitSize = skuDimensionCandidates(skuSize);
  // SKU尺寸 is the product-dimension field. When it contains a usable
  // dimension, do not mix specification measurements such as 18mm/25mm
  // thickness into the space decision.
  const sources = explicitSize.candidates.length > 0
    ? [explicitSize]
    : [explicitSize, skuDimensionCandidates(skuSpec)];
  const candidates = [];
  for (const source of sources) {
    for (const candidate of source.candidates) {
      if (!candidates.some((item) => Math.abs(item.meters - candidate.meters) < 0.000001)) candidates.push(candidate);
    }
  }
  const normalized = candidates.map((candidate) => skuMeterText(candidate.meters));
  const evidence = skuEvidenceValue(skuSize, skuSpec);
  const review = (reason) => ({
    skuSize: normalized.join(' / '),
    applicableSpace: null,
    status: '需人工核验',
    evidence: `${reason}${evidence ? `；${evidence}` : ''}`,
  });

  if (SKU_NON_LINEAR_SHAPE_PATTERN.test(`${text(skuName)} ${text(skuSize)} ${text(skuSpec)}`)) {
    return review('非线性外形不能仅按 SKU 尺寸判定空间');
  }
  if (sources.some((source) => source.hasRange)) return review('SKU 尺寸为范围，不能映射单一空间');
  if (candidates.length === 0) return review('未发现带单位的明确 SKU 尺寸');
  if (candidates.length > 1) return review('SKU 尺寸存在冲突');

  const meters = candidates[0].meters;
  if (meters >= 0.8 && meters <= 1.2) {
    return {
      skuSize: skuMeterText(meters),
      applicableSpace: '小户型',
      status: '已判定',
      evidence: `SKU 尺寸标准化为${skuMeterText(meters)}；规则=0.8m-1.2m`,
    };
  }
  if (meters >= 1.3 && meters <= 1.8) {
    return {
      skuSize: skuMeterText(meters),
      applicableSpace: '常规卫生间',
      status: '已判定',
      evidence: `SKU 尺寸标准化为${skuMeterText(meters)}；规则=1.3m-1.8m`,
    };
  }
  return review(`SKU 尺寸${skuMeterText(meters)}不在已批准区间`);
}

export function summarizeSkuDimensions(values) {
  const meters = [];
  for (const value of values ?? []) {
    const parsed = skuDimensionCandidates(value);
    if (parsed.hasRange) continue;
    for (const candidate of parsed.candidates) {
      if (!meters.some((item) => Math.abs(item - candidate.meters) < 0.000001)) meters.push(candidate.meters);
    }
  }
  if (meters.length === 0) return '';
  meters.sort((left, right) => left - right);
  const start = skuMeterText(meters[0]);
  const end = skuMeterText(meters.at(-1));
  return start === end ? start : `${start}-${end}`;
}

function number(value, fieldName) {
  const raw = text(value).replaceAll(',', '');
  if (!raw) throw new Error(`${fieldName} is required`);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${fieldName} is not numeric: ${value}`);
  return parsed;
}

export function parseMonthlyReceived(value) {
  const raw = text(value);
  const exact = /^\d+(?:\.\d+)?$/u.exec(raw.replaceAll(',', ''));
  if (exact) return { raw, value: Number(exact[0]), basis: '精确值' };
  const lowerBound = /^(\d+(?:\.\d+)?)\+$/u.exec(raw.replaceAll(',', ''));
  if (lowerBound) return { raw, value: Number(lowerBound[1]), basis: '下限值' };
  return { raw, value: null, basis: '不可计算' };
}

export function classifyPriceBand(value) {
  const price = number(value, '价格');
  if (price < 1000) return '1000以下';
  if (price < 3000) return '1000-3000';
  if (price < 6000) return '3000-6000';
  if (price < 8000) return '6000-8000';
  return '8000以上';
}

function matchLabels(title, labels) {
  return labels.filter((label) => title.includes(label));
}

function evidenceText(value) {
  if (Array.isArray(value)) return value.map(evidenceText).join('');
  if (value && typeof value === 'object') return text(value.text ?? value.value ?? value.name);
  return text(value);
}

function includesAny(value, terms) {
  const source = value.toLowerCase();
  return terms.some((term) => source.includes(term.toLowerCase()));
}

export function classifyCompetitorValidity(row) {
  const title = evidenceText(row.商品标题);
  // Category placement is not product evidence: this source contains
  // accessories filed under bathtub categories. Match the live Feishu formula
  // and keep title-ambiguous rows for review.
  const source = title;
  const hasBathtubBody = includesAny(title, BATHTUB_BODY_TERMS);
  if (includesAny(source, NON_BATHTUB_TERMS)) return { validity: '否', reason: '非浴缸主体' };
  if (hasBathtubBody) {
    return includesAny(source, BATHTUB_TERMS)
      ? { validity: '是', reason: '' }
      : { validity: '待确认', reason: '' };
  }
  if (includesAny(source, SERVICE_TERMS)) return { validity: '否', reason: '服务类' };
  if (includesAny(source, ACCESSORY_TERMS)) return { validity: '否', reason: '浴缸配件' };
  const childPortableBath = !hasBathtubBody
    && includesAny(source, CHILD_TERMS)
    && includesAny(source, PORTABLE_BATH_TERMS);
  if (childPortableBath) return { validity: '否', reason: '非浴缸主体' };
  if (includesAny(source, BATHTUB_TERMS)) return { validity: '是', reason: '' };
  return { validity: '待确认', reason: '' };
}

function classifyMaterials(title) {
  const normalized = title.toLowerCase();
  const hasHumanMadeStone = HUMAN_MADE_STONE_ALIASES.some((alias) => (
    normalized.includes(alias.toLowerCase())
  ));
  const materials = matchLabels(title, MATERIALS).filter((material) => (
    material !== '亚克力' && material !== '人造石'
  ));
  if (hasHumanMadeStone) materials.unshift('人造石');
  else if (title.includes('亚克力')) materials.unshift('亚克力');
  return materials;
}

function classifyShapes(title) {
  const values = matchLabels(title, SHAPES);
  if (title.includes('长方形') && !values.includes('方形')) values.push('方形');
  return values;
}

function classifyInstallations(title) {
  const values = [];
  if (/独立式?/u.test(title)) values.push('独立');
  if (/嵌入式?|内嵌式?/u.test(title)) values.push('嵌入');
  if (/靠墙式?/u.test(title)) values.push('靠墙');
  if (/台上式?|搁置式?/u.test(title)) values.push('台上/搁置');
  return values;
}

function classifyFunctions(title, sellingPoint = '') {
  const source = `${title} ${sellingPoint}`;
  const values = [];
  if (source.includes('普通浴缸')) values.push('普通');
  if (/按摩|冲浪|水疗|气泡按摩|空气按摩/u.test(source)) values.push('按摩');
  if (source.includes('智能')) values.push('智能');
  if (source.includes('恒温')) values.push('恒温');
  return values;
}

function classifyStyles(title) {
  const values = [];
  if (/极简|简约/u.test(title)) values.push('极简');
  if (/奶油(?:风|系)?/u.test(title)) values.push('奶油');
  if (/日式|日系|和风/u.test(title)) values.push('日式');
  if (/轻奢(?:风)?/u.test(title)) values.push('轻奢');
  return values;
}

const DIMENSION_CHAIN_PATTERN = /\d+(?:\.\d+)?(?:\s*(?:毫米|厘米|公分|mm|cm|米|m))?\s*[x×*＊]\s*\d+(?:\.\d+)?(?:\s*(?:毫米|厘米|公分|mm|cm|米|m))?(?:\s*[x×*＊]\s*\d+(?:\.\d+)?(?:\s*(?:毫米|厘米|公分|mm|cm|米|m))?)?/giu;
const DIMENSION_PREFIX_PATTERN = /(?:长度|宽度|高度|深度|长|宽|高|深)\s*[:：]?\s*\d+(?:\.\d+)?(?:\s*(?:毫米|厘米|公分|mm|cm|米|m))?(?:\s*[-~至]\s*\d+(?:\.\d+)?(?:\s*(?:毫米|厘米|公分|mm|cm|米|m))?)?/giu;
const DIMENSION_SUFFIX_PATTERN = /\d+(?:\.\d+)?(?:\s*(?:毫米|厘米|公分|mm|cm|米|m))?(?:\s*[-~至]\s*\d+(?:\.\d+)?(?:\s*(?:毫米|厘米|公分|mm|cm|米|m))?)?\s*(?:长度|宽度|高度|深度|长|宽|高|深)/giu;

function matches(title, pattern) {
  pattern.lastIndex = 0;
  return [...title.matchAll(pattern)].map((match) => ({
    value: match[0],
    index: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function classifyDimensions(title) {
  // A number alone can be a product code or capacity. Keep only a dimension
  // chain or a number explicitly labeled as length, width, height, or depth.
  const candidates = [
    ...matches(title, DIMENSION_CHAIN_PATTERN).map((match) => ({ ...match, priority: 0 })),
    ...matches(title, DIMENSION_PREFIX_PATTERN).map((match) => ({ ...match, priority: 1 })),
    ...matches(title, DIMENSION_SUFFIX_PATTERN).map((match) => ({ ...match, priority: 1 })),
  ].sort((left, right) => (
    left.priority - right.priority || left.index - right.index || right.value.length - left.value.length
  ));
  const accepted = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const overlaps = accepted.some((item) => candidate.index < item.end && item.index < candidate.end);
    if (!overlaps && !seen.has(candidate.value)) {
      accepted.push(candidate);
      seen.add(candidate.value);
    }
  }
  return accepted.sort((left, right) => left.index - right.index).map((item) => item.value);
}

function classifyApplicableSpaces(title) {
  const values = [];
  if (title.includes('小户型') || title.includes('小空间')) values.push('小户型');
  if (title.includes('常规卫生间')) values.push('常规卫生间');
  if (title.includes('大户型')) values.push('大户型');
  return values;
}

function migrationField(fields, name) {
  const matches = fields.filter((item) => (item.field_name ?? item.fieldName) === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one field named ${name}; received ${matches.length}`);
  return matches[0];
}

function migrationFieldId(field) {
  return field.field_id ?? field.fieldId;
}

function migrationFieldType(field) {
  return Number(field.type);
}

function assertSupportedAnalysisFieldType(field) {
  const type = migrationFieldType(field);
  if (![TEXT, MULTI_SELECT].includes(type)) {
    throw new Error(`Unsupported AI field type for ${fieldName(field)}: ${field.type}`);
  }
  return type;
}

function formulaReference(tableId, fieldId) {
  return `bitable::$table[${tableId}].$field[${fieldId}]`;
}

function formulaContainsAny(references, terms) {
  const checks = references.flatMap((reference) => terms.map((term) => `FIND("${term}",${reference})>0`));
  return checks.length === 1 ? checks[0] : `OR(${checks.join(',')})`;
}

function optionUpdate(field, names) {
  const options = (field.property?.options ?? []).map((option) => ({ ...option }));
  const existing = new Set(options.map((option) => option.name));
  for (const name of names) {
    if (!existing.has(name)) {
      options.push({ name });
      existing.add(name);
    }
  }
  const currentNames = (field.property?.options ?? []).map((option) => option.name);
  if (currentNames.join('|') === options.map((option) => option.name).join('|')) return null;
  return {
    fieldId: migrationFieldId(field),
    fieldName: fieldName(field),
    body: { field_name: fieldName(field), type: MULTI_SELECT, property: { options } },
  };
}

function fieldName(field) {
  return field.field_name ?? field.fieldName;
}

function skuField(fields, name) {
  const matches = fields.filter((field) => fieldName(field) === name);
  if (matches.length > 1) throw new Error(`Expected at most one SKU field named ${name}; received ${matches.length}`);
  return matches[0];
}

function skuOptionNames(field) {
  return (field?.property?.options ?? []).map((option) => option.name);
}

function skuOptions(field, names) {
  const current = new Map((field?.property?.options ?? []).map((option) => [option.name, option]));
  return names.map((name) => {
    const option = current.get(name);
    return option?.id ? { id: option.id, name } : { name };
  });
}

function skuFieldBody(field, definition) {
  const body = { field_name: definition.name, type: definition.type };
  if (definition.property?.options) {
    body.property = { options: skuOptions(field, definition.property.options.map((option) => option.name)) };
  }
  return body;
}

function skuFieldMatches(field, definition) {
  if (!field || migrationFieldType(field) !== definition.type) return false;
  if (!definition.property?.options) return true;
  const expected = definition.property.options.map((option) => option.name);
  return skuOptionNames(field).join('|') === expected.join('|');
}

function skuSame(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]));
    }
    return value ?? null;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/**
 * Produces only SKU-table field updates/creations. The type-21 relation is
 * deliberately created from SKU明细 so Feishu owns the reciprocal main-table
 * field; the plan never directly writes any main-table field.
 */
export function buildSkuSchemaMigrationPlan({
  appToken,
  mainTableId,
  skuTableId,
  expectedMainRows,
  mainRecordCount,
  skuRecordCount,
  mainFields,
  skuFields,
}) {
  if (!appToken || !mainTableId || !skuTableId) throw new Error('SKU schema target is incomplete');
  if (mainRecordCount !== expectedMainRows) {
    throw new Error(`Expected ${expectedMainRows} main records; received ${mainRecordCount}`);
  }
  if (skuRecordCount !== 0) throw new Error(`SKU明细 must be empty; received ${skuRecordCount} records`);

  const mainBacklink = skuField(mainFields, SKU_BACKLINK_FIELD_NAME);
  const relation = skuField(skuFields, SKU_RELATION_FIELD_NAME);
  const updates = [];
  const creates = [];

  if (relation) {
    const property = relation.property ?? {};
    if (migrationFieldType(relation) !== BIDIRECTIONAL_LINK
      || property.table_id !== mainTableId
      || property.multiple !== false
      || property.back_field_name !== SKU_BACKLINK_FIELD_NAME) {
      throw new Error(`Existing ${SKU_RELATION_FIELD_NAME} relation differs from the approved contract`);
    }
    if (!mainBacklink || migrationFieldType(mainBacklink) !== BIDIRECTIONAL_LINK
      || mainBacklink.property?.table_id !== skuTableId) {
      throw new Error(`Main-table ${SKU_BACKLINK_FIELD_NAME} backlink is missing or differs from the approved contract`);
    }
  } else {
    if (mainBacklink) {
      throw new Error(`Main table already contains ${SKU_BACKLINK_FIELD_NAME} without ${SKU_RELATION_FIELD_NAME}`);
    }
    creates.push({
      method: 'POST',
      fieldName: SKU_RELATION_FIELD_NAME,
      body: {
        field_name: SKU_RELATION_FIELD_NAME,
        type: BIDIRECTIONAL_LINK,
        property: { multiple: false, table_id: mainTableId, back_field_name: SKU_BACKLINK_FIELD_NAME },
      },
    });
  }

  for (const definition of SKU_DETAIL_FIELDS) {
    const current = skuField(skuFields, definition.name);
    const body = skuFieldBody(current, definition);
    if (!current) {
      creates.push({ method: 'POST', fieldName: definition.name, body });
      continue;
    }
    if (!skuFieldMatches(current, definition)) {
      updates.push({
        method: 'PUT',
        fieldId: migrationFieldId(current),
        fieldName: definition.name,
        body,
      });
    }
  }

  return { operations: [...updates, ...creates] };
}

export function assertSkuSchemaMutation({ method, path, body }, scope) {
  const fieldRoot = `/bitable/v1/apps/${scope.appToken}/tables/${scope.skuTableId}/fields`;
  const approved = (scope.operations ?? []).some((operation) => {
    if (operation.method !== method || !skuSame(operation.body, body)) return false;
    if (method === 'POST') return path === fieldRoot;
    return method === 'PUT' && path === `${fieldRoot}/${operation.fieldId}`;
  });
  if (approved) return;
  throw new Error(`Blocked SKU schema mutation: ${method} ${path}`);
}

export function buildCompetitorFieldMigrationPlan({ tableId, fields }) {
  const title = formulaReference(tableId, migrationFieldId(migrationField(fields, '商品标题')));
  const validityField = migrationField(fields, '是否有效竞品');
  const validity = formulaReference(tableId, migrationFieldId(validityField));
  const exclusionReason = migrationField(fields, '排除原因');
  // Keep the formula below the Feishu expression-size limit. Product titles carry
  // the decisive exclusions; category is still used by the local verifier.
  const sourceReferences = [title];
  const serviceMatch = formulaContainsAny(sourceReferences, SERVICE_TERMS);
  const accessoryMatch = formulaContainsAny(sourceReferences, ACCESSORY_TERMS);
  const nonBathtubMatch = formulaContainsAny(sourceReferences, NON_BATHTUB_TERMS);
  const bathtubBodyMatch = formulaContainsAny([title], BATHTUB_BODY_TERMS);
  const bathtubMatch = formulaContainsAny(sourceReferences, BATHTUB_TERMS);
  const childPortableBathMatch = `AND(NOT(${bathtubMatch}),${formulaContainsAny(sourceReferences, CHILD_TERMS)},${formulaContainsAny(sourceReferences, PORTABLE_BATH_TERMS)})`;
  const validityExpression = `IF(${nonBathtubMatch},"否",IF(${bathtubBodyMatch},IF(${bathtubMatch},"是","待确认"),IF(${serviceMatch},"否",IF(${accessoryMatch},"否",IF(${childPortableBathMatch},"否",IF(${bathtubMatch},"是","待确认"))))))`;
  const exclusionReasonExpression = `IF(${nonBathtubMatch},"非浴缸主体",IF(${bathtubBodyMatch},"",IF(${serviceMatch},"服务类",IF(${accessoryMatch},"浴缸配件",IF(${childPortableBathMatch},"非浴缸主体","")))))`;
  // Do not reference the formula field itself from downstream formulas. On the
  // live Feishu table that creates an unsettled dependency chain. Reuse the
  // raw-title evidence as a boolean gate instead.
  const validGate = `AND(${bathtubMatch},NOT(${nonBathtubMatch}),OR(${bathtubBodyMatch},AND(NOT(${bathtubBodyMatch}),NOT(${serviceMatch}),NOT(${accessoryMatch}),NOT(${childPortableBathMatch}))))`;
  const invalidGate = `NOT(${validGate})`;
  const price = formulaReference(tableId, migrationFieldId(migrationField(fields, '价格')));
  const rawMonthly = formulaReference(tableId, migrationFieldId(migrationField(fields, '月收货人数')));
  const monthly = formulaReference(tableId, migrationFieldId(migrationField(fields, '月收货人数计算值')));
  const amount = migrationField(fields, '月收货金额');
  const amountReference = formulaReference(tableId, migrationFieldId(amount));
  const band = migrationField(fields, '客单价带分类');
  const classField = migrationField(fields, '竞品分类');
  const analysisFields = new Map(COMPETITOR_AI_ATTRIBUTE_FIELDS.map(({ name }) => {
    const target = migrationField(fields, name);
    assertSupportedAnalysisFieldType(target);
    return [name, target];
  }));
  const materialField = analysisFields.get('材质分类');
  const material = formulaReference(tableId, migrationFieldId(materialField));
  const materialMatch = migrationFieldType(materialField) === MULTI_SELECT
    ? `CONTAIN(${material},"人造石")`
    : `FIND("人造石",${material})>0`;
  const shape = formulaReference(tableId, migrationFieldId(analysisFields.get('外形')));
  const installation = formulaReference(tableId, migrationFieldId(analysisFields.get('安装方式')));
  const productFunction = formulaReference(tableId, migrationFieldId(analysisFields.get('功能')));
  const style = formulaReference(tableId, migrationFieldId(analysisFields.get('风格')));
  const size = formulaReference(tableId, migrationFieldId(analysisFields.get('尺寸')));
  const space = formulaReference(tableId, migrationFieldId(analysisFields.get('适用空间')));
  const dataStatus = migrationField(fields, '数据状态');
  const pending = migrationField(fields, '待补数据项');
  const pendingReference = formulaReference(tableId, migrationFieldId(pending));
  const missingParts = [
    [monthly, '月收货人数精确值', false],
    [material, '材质分类', migrationFieldType(materialField) === MULTI_SELECT],
    [shape, '外形', migrationFieldType(analysisFields.get('外形')) === MULTI_SELECT],
    [installation, '安装方式', migrationFieldType(analysisFields.get('安装方式')) === MULTI_SELECT],
    [productFunction, '功能', migrationFieldType(analysisFields.get('功能')) === MULTI_SELECT],
    [style, '风格', migrationFieldType(analysisFields.get('风格')) === MULTI_SELECT],
    [size, '尺寸', migrationFieldType(analysisFields.get('尺寸')) === MULTI_SELECT],
    [space, '适用空间', migrationFieldType(analysisFields.get('适用空间')) === MULTI_SELECT],
  ];
  const missingText = `CONCATENATE(${missingParts.map(([reference, label, multiSelect]) => {
    const missing = multiSelect
      ? `OR(ISBLANK(${reference}),CONTAIN(${reference},"无注明"),CONTAIN(${reference},"不适用"))`
      : `OR(ISBLANK(${reference}),${reference}="无注明",${reference}="不适用")`;
    return `IF(${missing},"${label}、","")`;
  }).join(',')})`;
  const pendingExpression = `IF(${invalidGate},"",IF(${missingText}="","",LEFT(${missingText},LEN(${missingText})-1)))`;
  const optionUpdates = COMPETITOR_AI_ATTRIBUTE_FIELDS.flatMap(({ name }) => {
    const target = analysisFields.get(name);
    if (migrationFieldType(target) !== MULTI_SELECT) return [];
    const additions = name === '安装方式'
      ? ['台上/搁置', ...ANALYSIS_NOTES]
      : ANALYSIS_NOTES;
    const update = optionUpdate(migrationField(fields, name), additions);
    return update ? [update] : [];
  });
  return {
    creates: [],
    optionUpdates,
    formulas: [
      {
        fieldId: migrationFieldId(validityField),
        fieldName: '是否有效竞品',
        body: {
          field_name: '是否有效竞品',
          type: FORMULA,
          property: { formula_expression: validityExpression },
        },
      },
      {
        fieldId: migrationFieldId(exclusionReason),
        fieldName: '排除原因',
        body: {
          field_name: '排除原因',
          type: FORMULA,
          property: { formula_expression: exclusionReasonExpression },
        },
      },
      {
        fieldId: migrationFieldId(migrationField(fields, '月收货人数计算值')),
        fieldName: '月收货人数计算值',
        body: {
          field_name: '月收货人数计算值',
          type: FORMULA,
          property: {
            formula_expression: `IF(${invalidGate},"",IFERROR(VALUE(SUBSTITUTE(${rawMonthly},"+","")),""))`,
          },
        },
      },
      {
        fieldId: migrationFieldId(migrationField(fields, '计算口径')),
        fieldName: '计算口径',
        body: {
          field_name: '计算口径',
          type: FORMULA,
          property: {
            formula_expression: `IF(${invalidGate},"",IF(RIGHT(${rawMonthly},1)="+","下限值",IFERROR(IF(VALUE(${rawMonthly})>=0,"精确值","不可计算"),"不可计算")))`,
          },
        },
      },
      {
        fieldId: migrationFieldId(amount),
        fieldName: '月收货金额',
        body: {
          field_name: '月收货金额',
          type: FORMULA,
          property: { formula_expression: `IF(OR(${invalidGate},ISBLANK(${price}),${monthly}=""),"",${price}*${monthly})` },
        },
      },
      {
        fieldId: migrationFieldId(band),
        fieldName: '客单价带分类',
        body: {
          field_name: '客单价带分类',
          type: FORMULA,
          property: {
            formula_expression: `IF(OR(${invalidGate},ISBLANK(${price})),"",IF(${price}<1000,"1000以下",IF(${price}<3000,"1000-3000",IF(${price}<6000,"3000-6000",IF(${price}<8000,"6000-8000","8000以上")))))`,
          },
        },
      },
      {
        fieldId: migrationFieldId(classField),
        fieldName: '竞品分类',
        body: {
          field_name: '竞品分类',
          type: FORMULA,
          property: {
            formula_expression: `IF(OR(${invalidGate},ISBLANK(${price})),"不适用",IF(AND(${monthly}>=80,${amountReference}>=200000),"A-高销量高GMV竞品",IF(AND(${materialMatch},${monthly}>=10),"B-高价值竞品",IF(${price}>=8000,"C-中价位竞品",IF(${price}<1000,"D-低价位竞品","无分类")))))`,
          },
        },
      },
      {
        fieldId: migrationFieldId(pending),
        fieldName: '待补数据项',
        body: {
          field_name: '待补数据项',
          type: FORMULA,
          property: { formula_expression: pendingExpression },
        },
      },
      {
        fieldId: migrationFieldId(dataStatus),
        fieldName: '数据状态',
        body: {
          field_name: '数据状态',
          type: FORMULA,
          property: {
            formula_expression: `IF(${invalidGate},"",IF(${pendingReference}="","可用","部分待补"))`,
          },
        },
      },
    ],
  };
}

export function buildCompetitorRecordMigrationPlan({ records, fields = [], searchKeyword }) {
  void searchKeyword;
  const actualTypes = new Map(COMPETITOR_AI_ATTRIBUTE_FIELDS.map(({ name, type }) => {
    const target = fields.find((field) => fieldName(field) === name);
    return [name, target ? assertSupportedAnalysisFieldType(target) : type];
  }));
  return records.flatMap((record) => {
    const recordFields = record.fields ?? {};
    const validity = text(plainFeishuFormulaValue(recordFields.是否有效竞品))
      || classifyCompetitorValidity(recordFields).validity;
    const fieldsToUpdate = Object.fromEntries(COMPETITOR_AI_ATTRIBUTE_FIELDS.flatMap(({ name }) => {
      const current = recordFields[name];
      const type = actualTypes.get(name);
      const sentinel = validity === '是' ? '无注明' : '不适用';
      if (validity !== '是') {
        return [[name, type === MULTI_SELECT ? [sentinel] : sentinel]];
      }
      if (analysisValueIsBlank(current)) {
        return [[name, type === MULTI_SELECT ? [sentinel] : sentinel]];
      }
      return [];
    }));
    return Object.keys(fieldsToUpdate).length
      ? [{ recordId: record.record_id ?? record.recordId, fields: fieldsToUpdate }]
      : [];
  });
}

/**
 * Build the only record-level updates allowed during the analysis migration.
 * Validity is deliberately read from the settled Feishu formula result; a
 * local title classifier is never used as a write source.
 */
export function buildCompetitorAISentinelPlan({ records, fields }) {
  const validityField = migrationField(fields ?? [], '是否有效竞品');
  if (migrationFieldType(validityField) !== FORMULA) {
    throw new Error('validity formula is unsettled');
  }
  const actualTypes = new Map(COMPETITOR_AI_ATTRIBUTE_FIELDS.map(({ name }) => {
    const target = migrationField(fields ?? [], name);
    return [name, assertSupportedAnalysisFieldType(target)];
  }));
  return (records ?? []).flatMap((record) => {
    const recordIdValue = record.record_id ?? record.recordId;
    if (!recordIdValue) throw new Error('AI sentinel record id is required');
    const recordFields = record.fields ?? {};
    const validity = text(plainFeishuFormulaValue(recordFields.是否有效竞品));
    if (!['是', '否', '待确认'].includes(validity)) {
      throw new Error(`Record ${recordIdValue} validity formula is unsettled`);
    }
    const sentinel = validity === '是' ? '无注明' : '不适用';
    const fieldsToUpdate = Object.fromEntries(COMPETITOR_AI_ATTRIBUTE_FIELDS.flatMap(({ name }) => {
      if (!analysisValueIsBlank(recordFields[name])) return [];
      const type = actualTypes.get(name);
      return [[name, type === MULTI_SELECT ? [sentinel] : sentinel]];
    }));
    return Object.keys(fieldsToUpdate).length > 0
      ? [{ recordId: recordIdValue, fields: fieldsToUpdate }]
      : [];
  });
}

/** Build reproducible AI-field analysis updates from settled Feishu validity. */
export function buildCompetitorAIAnalysisPlan({ records, fields, searchKeyword = '浴缸' }) {
  const validityField = migrationField(fields ?? [], '是否有效竞品');
  if (migrationFieldType(validityField) !== FORMULA) throw new Error('validity formula is unsettled');
  const actualTypes = new Map(COMPETITOR_AI_ATTRIBUTE_FIELDS.map(({ name }) => {
    const target = migrationField(fields ?? [], name);
    return [name, assertSupportedAnalysisFieldType(target)];
  }));
  return (records ?? []).flatMap((record) => {
    const recordIdValue = record.record_id ?? record.recordId;
    const source = record.fields ?? {};
    const validity = text(plainFeishuFormulaValue(source.是否有效竞品));
    if (!['是', '否', '待确认'].includes(validity)) {
      throw new Error(`Record ${recordIdValue} validity formula is unsettled`);
    }
    const analyzed = buildCompetitorRecord({ ...source, 是否有效竞品: validity }, { searchKeyword });
    const fieldsToUpdate = Object.fromEntries(COMPETITOR_AI_ATTRIBUTE_FIELDS.flatMap(({ name }) => {
      if (!analysisValueIsBlank(source[name])) return [];
      const type = actualTypes.get(name);
      const value = analyzed[name] ?? (validity === '是' ? '无注明' : '不适用');
      return [[name, type === MULTI_SELECT
        ? (Array.isArray(value) ? value : [value])
        : (Array.isArray(value) ? value.join('、') : String(value))]];
    }));
    return Object.keys(fieldsToUpdate).length > 0
      ? [{ recordId: recordIdValue, fields: fieldsToUpdate }]
      : [];
  });
}

export function parseCompetitorMigrationArgs(argv) {
  const options = { apply: false, expectedRows: undefined, tableName: '竞品主表' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if ([
      '--base-url', '--env-file', '--expected-rows', '--table-name',
      '--confirm-app-token', '--confirm-table-id', '--backup-dir', '--receipt-file',
    ].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      const key = arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      options[key] = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.baseUrl) throw new Error('--base-url is required');
  if (options.expectedRows == null) throw new Error('--expected-rows is required');
  if (!/^\d+$/u.test(String(options.expectedRows)) || Number(options.expectedRows) < 1) {
    throw new Error('--expected-rows must be a positive integer');
  }
  options.expectedRows = Number(options.expectedRows);
  const url = new URL(options.baseUrl);
  const match = /^\/base\/([^/]+)$/u.exec(url.pathname);
  const tableId = url.searchParams.get('table');
  if (!match || !tableId) throw new Error('--base-url must identify a Feishu Base table');
  options.appToken = match[1];
  options.tableId = tableId;
  if (options.apply) {
    if (!options.envFile) throw new Error('--env-file is required with --apply');
    if (!options.confirmAppToken) throw new Error('--confirm-app-token is required with --apply');
    if (!options.confirmTableId) throw new Error('--confirm-table-id is required with --apply');
    if (options.confirmAppToken !== options.appToken) throw new Error('--confirm-app-token mismatch');
    if (options.confirmTableId !== options.tableId) throw new Error('--confirm-table-id mismatch');
  }
  return options;
}

export function assertCompetitorMigrationMutation({ method, path, body }, scope) {
  const fieldRoot = `/bitable/v1/apps/${scope.appToken}/tables/${scope.tableId}/fields`;
  const recordPath = `/bitable/v1/apps/${scope.appToken}/tables/${scope.tableId}/records/batch_update`;
  // This migration never creates fields. The target schema is a protected
  // contract and must be inspected before any formula update.
  if (method === 'PUT' && path.startsWith(`${fieldRoot}/`)) {
    const fieldId = path.slice(fieldRoot.length + 1);
    if (scope.allowedFieldIds.has(fieldId)
      && [
        '材质分类', '外形', '安装方式', '功能', '风格', '适用空间',
        '待补数据项', '月收货人数计算值', '计算口径', '月收货金额',
        '客单价带分类', '竞品分类', '数据状态', '是否有效竞品', '排除原因',
      ].includes(body?.field_name)) return;
  }
  if (method === 'POST' && path === recordPath) {
    const allowed = new Set(scope.allowedAiFieldNames ?? COMPETITOR_AI_FIELD_NAMES);
    const records = body?.records;
    if (Array.isArray(records) && records.length <= 500 && records.every((record) => (
      record.record_id && Object.keys(record.fields ?? {}).every((name) => allowed.has(name))
    ))) return;
  }
  throw new Error(`Blocked competitor migration mutation: ${method} ${path}`);
}

function canonicalMigrationValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalMigrationValue).sort((left, right) => (
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    ));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalMigrationValue(child)]));
  }
  return value ?? null;
}

export function filterChangedCompetitorRecordUpdates({ records, updates }) {
  const current = new Map(records.map((record) => [record.record_id ?? record.recordId, record.fields ?? {}]));
  return updates.flatMap((update) => {
    const existing = current.get(update.recordId);
    if (!existing) throw new Error(`Record not found during migration: ${update.recordId}`);
    const changed = Object.fromEntries(Object.entries(update.fields).filter(([name, value]) => (
      !equivalentFeishuFieldValue(existing[name], value)
    )));
    return Object.keys(changed).length ? [{ recordId: update.recordId, fields: changed }] : [];
  });
}

export function plainFeishuFormulaValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(plainFeishuFormulaValue).join('');
  if (typeof value === 'object') return String(value.text ?? value.value ?? value.name ?? '');
  return String(value);
}

export function analysisValueIsBlank(value) {
  const normalized = text(plainFeishuFormulaValue(value));
  return normalized === '';
}

export function pendingCompetitorAnalysisItems(fields, validity = text(plainFeishuFormulaValue(fields.是否有效竞品))) {
  if (validity !== '是') return [];
  const pending = [];
  if (analysisValueIsBlank(fields.月收货人数计算值)) pending.push('月收货人数精确值');
  for (const { name } of COMPETITOR_AI_ATTRIBUTE_FIELDS) {
    const value = text(plainFeishuFormulaValue(fields[name]));
    if (!value || value.includes('无注明') || value.includes('不适用')) pending.push(name);
  }
  return pending;
}

export function priceIsMissing(value) {
  return value == null || text(value) === '';
}

export function equivalentFeishuFieldValue(left, right) {
  const empty = (value) => value == null || value === '' || (Array.isArray(value) && value.length === 0);
  if (empty(left) && empty(right)) return true;
  return JSON.stringify(canonicalMigrationValue(left)) === JSON.stringify(canonicalMigrationValue(right));
}

export function equivalentFeishuMoney(left, right) {
  const normalize = (value) => {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 100) / 100 : NaN;
  };
  return Object.is(normalize(left), normalize(right));
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function buildCompetitorRecord(row, { searchKeyword }) {
  const title = text(row.商品标题);
  const price = number(row.价格, '价格');
  const validity = text(row.是否有效竞品) || '待确认';
  const isValid = validity === '是';
  const monthlyReceived = parseMonthlyReceived(row.月收货人数);
  const monthlyValue = isValid ? monthlyReceived.value : null;
  const monthlyAmount = monthlyValue == null
    ? null
    : roundMoney(price * monthlyValue);
  const materialEvidence = classifyMaterials(title);
  const shapeEvidence = classifyShapes(title);
  const installationEvidence = classifyInstallations(title);
  const functionEvidence = classifyFunctions(title, text(row.卖点));
  const styleEvidence = classifyStyles(title);
  const dimensionEvidence = classifyDimensions(title);
  const applicableSpaceEvidence = classifyApplicableSpaces(title);
  const materials = isValid ? (materialEvidence.length ? materialEvidence : ['无注明']) : ['不适用'];
  const shapes = isValid ? (shapeEvidence.length ? shapeEvidence : ['无注明']) : ['不适用'];
  const installations = isValid ? (installationEvidence.length ? installationEvidence : ['无注明']) : ['不适用'];
  const functions = isValid ? (functionEvidence.length ? functionEvidence : ['无注明']) : ['不适用'];
  const styles = isValid ? (styleEvidence.length ? styleEvidence : ['无注明']) : ['不适用'];
  const dimensions = isValid ? (dimensionEvidence.length ? dimensionEvidence.join('、') : '无注明') : '不适用';
  const applicableSpaces = isValid
    ? (applicableSpaceEvidence.length ? applicableSpaceEvidence : ['无注明'])
    : ['不适用'];
  let competitorClass = '不适用';

  if (isValid && monthlyValue != null && monthlyValue >= 80 && monthlyAmount >= 200000) {
    competitorClass = 'A-高销量高GMV竞品';
  }
  if (competitorClass === '不适用' && isValid && materials.includes('人造石') && monthlyValue != null && monthlyValue >= 10) {
    competitorClass = 'B-高价值竞品';
  }
  if (competitorClass === '不适用' && isValid && price >= 8000) competitorClass = 'C-中价位竞品';
  if (competitorClass === '不适用' && isValid && price < 1000) competitorClass = 'D-低价位竞品';
  if (competitorClass === '不适用' && isValid) competitorClass = '无分类';

  const pending = [];
  const pendingSet = new Set();
  const addPending = (...items) => {
    for (const item of items) {
      if (!pendingSet.has(item)) {
        pendingSet.add(item);
        pending.push(item);
      }
    }
  };
  if (isValid && monthlyValue == null) addPending('月收货人数精确值');
  if (isValid && materials.includes('无注明')) addPending('材质分类');
  if (isValid && shapes.includes('无注明')) addPending('外形');
  if (isValid && installations.includes('无注明')) addPending('安装方式');
  if (isValid && functions.includes('无注明')) addPending('功能');
  if (isValid && styles.includes('无注明')) addPending('风格');
  if (isValid && dimensions === '无注明') addPending('尺寸');
  if (isValid && applicableSpaces.includes('无注明')) addPending('适用空间');
  if (isValid && ['A-高销量高GMV竞品', 'B-高价值竞品'].includes(competitorClass)) {
    addPending('SKU尺寸', '适用空间', '问大家', '评论');
  }

  const original = Object.fromEntries(SOURCE_FIELD_NAMES.map((name) => [name, row[name] ?? '']));
  return {
    ...original,
    序号: text(row.序号),
    价格: price,
    月收货人数: monthlyReceived.raw,
    搜索关键词: text(searchKeyword),
    月收货人数计算值: monthlyValue,
    计算口径: isValid ? monthlyReceived.basis : '',
    月收货金额: monthlyAmount,
    客单价带分类: isValid ? classifyPriceBand(price) : '',
    材质分类: materials,
    外形: shapes,
    安装方式: installations,
    功能: functions,
    风格: styles,
    竞品分类: competitorClass,
    尺寸: dimensions,
    适用空间: applicableSpaces,
    是否有效竞品: validity,
    排除原因: '',
    数据状态: isValid ? (pending.length === 0 ? '可用' : '部分待补') : '',
    待补数据项: pending,
  };
}

export function buildFeishuCompetitorRecord(row, imageToken, options) {
  if (!text(imageToken)) throw new Error('imageToken is required');
  const record = buildCompetitorRecord(row, options);
  record.商品图片 = [{ file_token: imageToken }];
  return Object.fromEntries(Object.entries(record).filter(([, value]) => (
    value !== null
    && value !== ''
    && (!Array.isArray(value) || value.length > 0)
  )));
}
