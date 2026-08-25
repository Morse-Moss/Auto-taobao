const TEXT = 1;
const SINGLE_SELECT = 3;
const DATE = 5;
const AUTO_NUMBER = 1005;

const field = (name, type = TEXT, property) => ({
  name,
  type,
  ...(property ? { property } : {}),
});

const productDirection = field('对应产品方向', SINGLE_SELECT, {
  options: [
    { name: '小户型深泡款' },
    { name: '人造石高端款' },
    { name: '方形独立式' },
    { name: '靠墙式小浴缸' },
  ],
});

const collectionDate = field('采集日期', DATE, { date_formatter: 'yyyy/MM/dd' });

export const KEYWORD_LIBRARY_FIELDS = [
  field('唯一匹配键'),
  field('一级类目'),
  field('原始关键词'),
  field('规范化关键词'),
  field('关键词编号', AUTO_NUMBER, {
    auto_serial: {
      type: 'custom',
      reformat_existing_records: true,
      options: [
        { type: 'fixed_text', value: 'KW' },
        { type: 'system_number', value: '6' },
      ],
    },
  }),
];

export const ANALYSIS_FIELDS = [
  field('排名'),
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
  field('来源渠道'),
  field('搜索热度'),
  field('内容热度'),
  field('交易热度'),
  field('是否重点词'),
  field('优先级'),
  productDirection,
  collectionDate,
];

export const HISTORY_FIELDS = [
  field('排名'),
  field('搜索词'),
  field('搜索人气'),
  field('点击率'),
  field('支付转化率'),
  field('关键词编号'),
  field('一级类目'),
  field('主关键词'),
  field('原始关键词'),
  field('来源渠道'),
  field('搜索热度'),
  field('交易热度'),
  field('出现状态'),
  field('排名环比'),
  field('搜索人气环比'),
  field('交易环比'),
  field('综合趋势变化'),
  collectionDate,
];

const SEARCH_HIGH = new Set([
  '1200 ~ 2500', '2500 ~ 5000', '5000 ~ 1万', '1万 ~ 2万', '2万 ~ 4万', '4万 ~ 8万',
  '8万 ~ 15万', '15万 ~ 30万',
]);
const SEARCH_MEDIUM = new Set(['600 ~ 1200']);
const SEARCH_LOW = new Set([
  '0 ~ 20',
  '20 ~ 50', '50 ~ 150', '150 ~ 300', '300 ~ 600',
]);

const TRADE_HIGH = new Set([
  '5% ~ 7.5%', '7.5% ~ 10%', '10% ~ 15%', '15% ~ 20%',
  '20% ~ 25%', '25% ~ 30%', '30% ~ 35%', '40% ~ 45%',
]);
const TRADE_MEDIUM = new Set(['1% ~ 2.5%', '2.5% ~ 5%']);
const TRADE_LOW = new Set(['0% ~ 1%']);

export function classifySearchHeat(value) {
  if (SEARCH_HIGH.has(value)) return '高';
  if (SEARCH_MEDIUM.has(value)) return '中';
  if (SEARCH_LOW.has(value)) return '低';
  return value ? '待核验' : '';
}

export function classifyTradeHeat(value) {
  if (value === '-') return '无数据';
  if (TRADE_HIGH.has(value)) return '高';
  if (TRADE_MEDIUM.has(value)) return '中';
  if (TRADE_LOW.has(value)) return '低';
  return value ? '待核验' : '';
}

const ref = (tableId, fieldId) => `bitable::$table[${tableId}].$field[${fieldId}]`;
const equalsAny = (fieldRef, values) =>
  `OR(${values.map((value) => `${fieldRef}="${value}"`).join(',')})`;

export function buildFormulaDefinitions({ tableId, fieldIds }) {
  const search = ref(tableId, fieldIds.搜索词);
  const popularity = ref(tableId, fieldIds.搜索人气);
  const trade = ref(tableId, fieldIds.支付转化率);
  return {
    一级类目: `IF(ISBLANK(${search}),"","浴缸")`,
    主关键词: `IF(ISBLANK(${search}),"","浴缸")`,
    原始关键词: search,
    来源渠道: `IF(ISBLANK(${search}),"","淘宝")`,
    搜索热度: `IF(ISBLANK(${popularity}),"",IFS(${equalsAny(popularity, [...SEARCH_HIGH])},"高",${equalsAny(popularity, [...SEARCH_MEDIUM])},"中",${equalsAny(popularity, [...SEARCH_LOW])},"低",TRUE,"待核验"))`,
    交易热度: `IF(ISBLANK(${trade}),"",IFS(${trade}="-","无数据",${equalsAny(trade, [...TRADE_HIGH])},"高",${equalsAny(trade, [...TRADE_MEDIUM])},"中",${equalsAny(trade, [...TRADE_LOW])},"低",TRUE,"待核验"))`,
  };
}

function textValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map((item) => item?.text ?? item?.value ?? String(item ?? '')).join('');
  }
  return String(value);
}

export function normalizeKeyword(value) {
  return textValue(value)
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

export function buildKeywordIdentityKey(category, keyword) {
  const normalizedCategory = normalizeKeyword(category);
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!normalizedCategory || !normalizedKeyword) {
    throw new Error('Keyword identity requires both category and keyword');
  }
  return `${normalizedCategory}\u001f${normalizedKeyword}`;
}

export function buildKeywordNumberMap(records) {
  const mapping = new Map();
  const assignedNumbers = new Set();
  for (const record of records) {
    const fields = record.fields ?? record;
    const identity = buildKeywordIdentityKey(fields.一级类目, fields.原始关键词);
    const keywordNumber = textValue(fields.关键词编号);
    if (!/^KW\d{6}$/.test(keywordNumber)) {
      throw new Error(`Invalid keyword number: ${keywordNumber || '<empty>'}`);
    }
    if (mapping.has(identity)) throw new Error(`Duplicate identity: ${identity}`);
    if (assignedNumbers.has(keywordNumber)) throw new Error(`Duplicate keyword number: ${keywordNumber}`);
    mapping.set(identity, keywordNumber);
    assignedNumbers.add(keywordNumber);
  }
  return mapping;
}

export function countKeywordNumberMappingDifferences(leftRecords, rightRecords) {
  const left = buildKeywordNumberMap(leftRecords);
  const right = buildKeywordNumberMap(rightRecords);
  const identities = new Set([...left.keys(), ...right.keys()]);
  return [...identities].filter((identity) => left.get(identity) !== right.get(identity)).length;
}

export function findTableById(tables, tableId, { required = true } = {}) {
  const table = tables.find((item) => item.table_id === tableId) ?? null;
  if (!table && required) throw new Error(`Required table not found: ${tableId}`);
  return table;
}

export function assertKeywordNumberOnlyMutation({ method, path, body }, scope) {
  if (method === 'GET') return;
  const tableRoot = `/bitable/v1/apps/${scope.appToken}/tables`;
  if (method === 'POST' && path === tableRoot && body?.table?.name === scope.libraryTableName) {
    const names = (body.table.fields ?? []).map((item) => item.field_name);
    if (JSON.stringify(names) === JSON.stringify(KEYWORD_LIBRARY_FIELDS.map((item) => item.name))) return;
  }
  const recordMutation = path.match(new RegExp(`^${tableRoot}/([^/]+)/records/(batch_create|batch_update)$`));
  if (method === 'POST' && recordMutation) {
    const [, tableId, operation] = recordMutation;
    const records = body?.records ?? [];
    if (operation === 'batch_create' && scope.libraryTableIds.has(tableId) && records.length > 0) {
      const allowed = new Set(['唯一匹配键', '一级类目', '原始关键词', '规范化关键词']);
      if (records.every((record) => {
        const names = Object.keys(record.fields ?? {});
        return names.length === allowed.size && names.every((name) => allowed.has(name));
      })) return;
    }
    if (operation === 'batch_update' && scope.businessTableIds.has(tableId) && records.length > 0) {
      if (records.every((record) => {
        const names = Object.keys(record.fields ?? {});
        return names.length === 1 && names[0] === '关键词编号' && /^KW\d{6}$/.test(record.fields.关键词编号);
      })) return;
    }
  }
  throw new Error(`Blocked non-number mutation: ${method} ${path}`);
}

export function buildSeedRecords(sourceRecords, tableKind) {
  if (!['analysis', 'history'].includes(tableKind)) {
    throw new Error(`Unsupported table kind: ${tableKind}`);
  }
  return [...sourceRecords]
    .sort((left, right) => Number(textValue(left.fields?.排名)) - Number(textValue(right.fields?.排名)))
    .map((record) => {
      const output = {
        排名: textValue(record.fields?.排名),
        搜索词: textValue(record.fields?.搜索词),
        搜索人气: textValue(record.fields?.搜索人气),
        点击率: textValue(record.fields?.点击率),
        支付转化率: textValue(record.fields?.支付转化率),
      };
      if (tableKind === 'analysis') output.分析状态 = '待审核';
      return output;
    });
}

export function sameDistribution(left, right) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
}
