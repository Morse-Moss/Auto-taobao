const SEARCH_RANGES = [
  '20 ~ 50', '50 ~ 150', '150 ~ 300', '300 ~ 600', '600 ~ 1200',
  '1200 ~ 2500', '2500 ~ 5000', '5000 ~ 1万', '1万 ~ 2万',
  '2万 ~ 4万', '4万 ~ 8万', '8万 ~ 15万', '15万 ~ 30万',
];

const TRADE_RANGES = [
  '0% ~ 1%', '1% ~ 2.5%', '2.5% ~ 5%', '5% ~ 7.5%', '7.5% ~ 10%',
  '10% ~ 15%', '15% ~ 20%', '20% ~ 25%', '25% ~ 30%', '30% ~ 35%',
];

const DAY = 24 * 60 * 60 * 1000;

function text(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map((item) => item?.text ?? item?.name ?? item?.value ?? String(item ?? '')).join('');
  }
  return String(value).trim();
}

function dateMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function mondayKey(value) {
  const timestamp = dateMs(value);
  if (timestamp == null) return null;
  const date = new Date(timestamp + 8 * 60 * 60 * 1000);
  const day = date.getUTCDay() || 7;
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - day + 1);
  return monday.toISOString().slice(0, 10);
}

function scopeKey(fields) {
  return [fields.一级类目, fields.主关键词, fields.来源渠道 ?? fields.平台来源]
    .map(text)
    .join('||');
}

function validKeyword(fields) {
  return Boolean(text(fields.关键词编号) && text(fields.原始关键词 ?? fields.搜索词));
}

export function comparePlatformRange(current, previous, orderedRanges) {
  const currentIndex = orderedRanges.indexOf(text(current));
  const previousIndex = orderedRanges.indexOf(text(previous));
  if (currentIndex < 0 || previousIndex < 0) return '不可比';
  if (currentIndex > previousIndex) return '上升';
  if (currentIndex < previousIndex) return '下降';
  return '稳定';
}

function compareRank(current, previous) {
  const currentRank = Number(text(current));
  const previousRank = Number(text(previous));
  if (!Number.isInteger(currentRank) || currentRank < 1 ||
      !Number.isInteger(previousRank) || previousRank < 1) return '不可比';
  if (currentRank < previousRank) return '上升';
  if (currentRank > previousRank) return '下降';
  return '稳定';
}

function latestScopeWeek(history, scope) {
  const weeks = [...new Set(history
    .filter((record) => scopeKey(record.fields ?? {}) === scope)
    .map((record) => mondayKey(record.fields?.采集日期))
    .filter(Boolean))].sort();
  return weeks.at(-1) ?? null;
}

function keywordHistory(history, fields) {
  const id = text(fields.关键词编号);
  const scope = scopeKey(fields);
  return history
    .filter((record) => text(record.fields?.关键词编号) === id && scopeKey(record.fields ?? {}) === scope)
    .filter((record) => mondayKey(record.fields?.采集日期))
    .sort((left, right) => dateMs(left.fields.采集日期) - dateMs(right.fields.采集日期));
}

function keyWordStatus(history, fields) {
  const scope = scopeKey(fields);
  const validWeeks = [...new Set(history
    .filter((record) => scopeKey(record.fields ?? {}) === scope)
    .map((record) => mondayKey(record.fields?.采集日期))
    .filter(Boolean))].sort().slice(-8);
  if (validWeeks.length < 8) return '观察中';
  const selected = new Set(validWeeks);
  const appearances = new Set(keywordHistory(history, fields)
    .map((record) => mondayKey(record.fields.采集日期))
    .filter((week) => selected.has(week))).size;
  return appearances >= 6 ? '是' : '否';
}

function isHighValue(fields) {
  return text(fields.搜索热度) === '高' && ['中', '高'].includes(text(fields.交易热度));
}

function priority(history, fields) {
  const scope = scopeKey(fields);
  const latestWeek = latestScopeWeek(history, scope);
  if (!latestWeek) return isHighValue(fields) ? 'B-持续观察' : '观察中';

  const historyForKeyword = keywordHistory(history, fields);
  const previous = [...historyForKeyword]
    .reverse()
    .find((record) => mondayKey(record.fields.采集日期) === latestWeek);
  if (!previous) {
    const rank = Number(text(fields.排名));
    if (Number.isInteger(rank) && rank <= 100 && ['中', '高'].includes(text(fields.交易热度))) {
      return 'A-立即跟进';
    }
    return isHighValue(fields) ? 'B-持续观察' : '观察中';
  }

  const changes = [
    compareRank(fields.排名, previous.fields.排名),
    comparePlatformRange(fields.搜索人气, previous.fields.搜索人气, SEARCH_RANGES),
    comparePlatformRange(fields.支付转化率, previous.fields.支付转化率, TRADE_RANGES),
  ];
  const [rank, search, trade] = changes;
  const comparable = changes.filter((item) => item !== '不可比');
  const rises = comparable.filter((item) => item === '上升').length;
  const declines = comparable.filter((item) => item === '下降').length;

  if (trade === '上升' && [rank, search].includes('上升') && declines === 0) return 'A-立即跟进';
  if (rank === '上升' && search === '上升' && trade !== '不可比' && trade !== '下降') return 'A-立即跟进';
  if (rank === '上升' && search === '上升' && trade === '不可比') return 'B-持续观察';
  if (rises > 0 || (rises > 0 && declines > 0)) return 'B-持续观察';
  if (comparable.length >= 2) return 'C-常规跟踪';
  if (comparable.length === 1 && comparable[0] === '上升') return 'B-持续观察';
  if (comparable.length === 1) return '观察中';
  if (isHighValue(fields)) return 'B-持续观察';
  return '观察中';
}

export function buildDecisionPlan({ currentRecords, historyRecords }) {
  const decisions = [];
  const conflicts = [];
  const updates = [];
  let ignoredBlankCount = 0;

  for (const record of currentRecords) {
    const fields = record.fields ?? {};
    if (!validKeyword(fields)) {
      ignoredBlankCount += 1;
      continue;
    }
    const desired = {
      是否重点词: keyWordStatus(historyRecords, fields),
      优先级: priority(historyRecords, fields),
    };
    const writable = {};
    for (const [name, value] of Object.entries(desired)) {
      const existing = text(fields[name]);
      if (existing && existing !== value) {
        conflicts.push({ recordId: record.record_id, keywordId: text(fields.关键词编号), field: name, existing, desired: value });
      } else if (!existing) {
        writable[name] = value;
      }
    }
    decisions.push({ recordId: record.record_id, keywordId: text(fields.关键词编号), desired });
    if (Object.keys(writable).length > 0) updates.push({ record_id: record.record_id, fields: writable });
  }

  return { decisions, updates, conflicts, ignoredBlankCount };
}

export function assertAuthorizedMutation({ method, path, body }, scope) {
  if (method === 'GET') return;
  const tableRoot = `/bitable/v1/apps/${scope.appToken}/tables/${scope.currentTableId}`;
  if (method === 'POST' && path === `${tableRoot}/records/batch_update`) {
    const records = body?.records;
    if (Array.isArray(records) && records.length > 0 && records.every((record) => {
      const names = Object.keys(record.fields ?? {});
      return record.record_id && names.length > 0 &&
        names.every((name) => ['是否重点词', '优先级'].includes(name));
    })) return;
  }
  if (method === 'PUT' && path === `${tableRoot}/fields/${scope.productDirectionFieldId}` &&
      body?.field_name === '对应产品方向' && body?.type === 1) return;
  throw new Error(`Blocked unauthorized mutation: ${method} ${path}`);
}

export const PRODUCT_DIRECTION_PROMPT = `你是浴缸产品方向分析助手。
原始关键词：{{原始关键词}}
标准归并词：{{标准归并词}}
关键词分类：{{关键词分类}}
细分标签：{{细分标签}}

目标：给运营一个可参考的产品方向名称。只输出方向名称，不解释；没有明确方向时留空。

判断依据：
1. 原始关键词是最终事实依据；标准归并词用于识别运营需求桶；关键词分类用于识别主属性；细分标签用于补齐原词中已经识别出的其他属性。
2. 字段冲突时以原始关键词为准。禁止补充原始关键词没有明确表达的属性，禁止根据常识推断。
3. 保留所有会改变产品方案的明确属性；同属性组合统一命名，不同属性不得合并。
4. 方向名称按“定位 + 人群/场景 + 尺寸 + 材质 + 风格 + 形状/款式 + 安装方式 + 功能/需求 + 浴缸”的顺序组合，只保留有证据的部分。
5. 品牌、店铺、交易导航、地域和颜色不进入产品方向。
6. 明确痛点可以直接转写为产品需求，例如“浴缸太滑”输出“防滑浴缸”。清洁、维修、漏水处理等服务问题不形成产品方向，留空。
7. 老人、户外、小户型等场景不得擅自补充防滑、耐候、深泡等属性；高端和普通、深泡浴缸和通用浴缸是不同方向。
8. 只有通用品类“浴缸”且没有其他产品属性时留空。

示例：
家用浴缸 -> 家用浴缸
高端人造石浴缸 -> 高端人造石浴缸
日式深泡小浴缸 -> 小型日式深泡浴缸
科勒浴缸官方旗舰店 -> 留空
浴缸漏水维修 -> 留空

只输出一个方向名称或留空。`;

export const INTERNALS = { DAY, SEARCH_RANGES, TRADE_RANGES, mondayKey };
