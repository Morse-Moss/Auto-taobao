import { createHash } from 'node:crypto';

const TEXT = 1;
const NUMBER = 2;
const SINGLE_SELECT = 3;

const field = (name, type = TEXT, options = []) => ({
  name,
  type,
  ...(options.length ? { property: { options: options.map((option) => ({ name: option })) } } : {}),
});

export const QUESTION_WEEKLY_FIELDS = [
  field('商品ID'),
  field('主表记录ID'),
  field('竞品周记录ID'),
  field('商品链接'),
  field('商品标题'),
  field('竞品分类', SINGLE_SELECT, ['A-爆款竞品', 'B-高价值竞品', 'C-差异化竞品', 'D-价格/流量型竞品', '无分类', '不适用']),
  field('来源类型', SINGLE_SELECT, ['问大家', '评论']),
  field('原始内容'),
  field('高频问题或关键词'),
  field('出现次数', NUMBER),
  field('采集状态', SINGLE_SELECT, ['待采集', '已采集', '需人工核验']),
  field('来源记录唯一键'),
  field('采集时间'),
];

const QUESTION_FIELDS = ['问题', '提问', '问题内容', '问法'];
const ANSWER_FIELDS = ['回答', '答复', '回答内容', '商家回答'];
const REVIEW_FIELDS = ['评论内容', '评论', '评价内容', '评价', '买家评论', '内容'];

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'text')) return text(value.text);
  return String(value ?? '').trim();
}

function recordFields(record) {
  return record?.fields ?? record ?? {};
}

function firstValue(row, candidates) {
  for (const name of candidates) {
    if (Object.prototype.hasOwnProperty.call(row, name) && text(row[name])) return text(row[name]);
  }
  return '';
}

function fallbackContent(row) {
  return Object.values(row)
    .map(text)
    .filter(Boolean)
    .join('\n');
}

export function selectTopABCompetitors(records, { limit = 5 } = {}) {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');
  return (records ?? [])
    .filter((record) => {
      const fields = recordFields(record);
      return text(fields.是否有效竞品) === '是'
        && ['A-爆款竞品', 'B-高价值竞品'].includes(text(fields.竞品分类))
        && Number.isFinite(Number(text(fields.月收货人数计算值)))
        && text(fields.商品链接);
    })
    .sort((left, right) => {
      const leftFields = recordFields(left);
      const rightFields = recordFields(right);
      const monthlyDelta = Number(text(rightFields.月收货人数计算值)) - Number(text(leftFields.月收货人数计算值));
      if (monthlyDelta !== 0) return monthlyDelta;
      return Number(text(leftFields.序号)) - Number(text(rightFields.序号));
    })
    .slice(0, limit);
}

export const selectTopACompetitors = selectTopABCompetitors;

export function normalizeExportRows(sourceType, rows) {
  if (!['问大家', '评论'].includes(sourceType)) throw new Error(`Unsupported source type: ${sourceType}`);
  return (rows ?? [])
    .map((row, index) => {
      const question = firstValue(row, QUESTION_FIELDS);
      const answer = firstValue(row, ANSWER_FIELDS);
      const rawContent = sourceType === '问大家'
        ? [question && `问题：${question}`, answer && `回答：${answer}`].filter(Boolean).join('\n')
        : firstValue(row, REVIEW_FIELDS) || fallbackContent(row);
      return { sourceRowNumber: index + 2, rawContent: text(rawContent) };
    })
    .filter((row) => row.rawContent.length > 0);
}

export function sourceRecordKey({ period, productId, sourceType, sourceHash, sourceRowNumber }) {
  const values = { period, productId, sourceType, sourceHash, sourceRowNumber };
  for (const [name, value] of Object.entries(values)) {
    if (!text(value)) throw new Error(`${name} is required for source record key`);
  }
  return [period, productId, sourceType, sourceHash, sourceRowNumber].map(text).join('|');
}

export function normalizeFaqSourceText(value) {
  return text(value).normalize('NFKC').replace(/[\r\n\t ]+/gu, ' ').trim();
}

export function crossWeekRecordIdentity({ productId, sourceType, rawContent, stableSourceId, buyerId, reviewTime, sku }) {
  if (text(stableSourceId)) return { key: `id:${text(stableSourceId)}`, method: 'stable-source-id' };
  const stable = [productId, sourceType, buyerId, reviewTime, sku].map(text);
  if (stable.slice(2).some(Boolean)) return { key: `fields:${stable.join('|')}`, method: 'stable-field-combination' };
  const normalized = normalizeFaqSourceText(rawContent);
  if (!text(productId) || !text(sourceType) || !normalized) throw new Error('productId, sourceType and rawContent are required for cross-week identity');
  return {
    key: `text:${createHash('sha256').update(`${text(productId)}\n${text(sourceType)}\n${normalized}`).digest('hex')}`,
    method: 'normalized-content-fallback',
  };
}

export function buildQuestionRecord({
  period,
  competitor,
  sourceType,
  rawContent,
  sourceHash,
  sourceRowNumber,
  collectedAt,
}) {
  if (!['问大家', '评论'].includes(sourceType)) throw new Error(`Unsupported source type: ${sourceType}`);
  const fields = recordFields(competitor);
  const productId = text(fields.商品ID);
  if (!productId || !text(fields.商品链接) || !text(rawContent)) throw new Error('product identity and raw content are required');
  return {
    商品ID: productId,
    主表记录ID: text(fields.主表记录ID),
    竞品周记录ID: text(fields.竞品周记录ID),
    商品链接: fields.商品链接,
    商品标题: text(fields.商品标题),
    竞品分类: text(fields.竞品分类),
    来源类型: sourceType,
    原始内容: text(rawContent),
    高频问题或关键词: '',
    出现次数: '',
    采集状态: '已采集',
    来源记录唯一键: sourceRecordKey({ period, productId, sourceType, sourceHash, sourceRowNumber }),
    采集时间: text(collectedAt) || new Date().toISOString(),
    crossWeekDedupKey: crossWeekRecordIdentity({ productId, sourceType, rawContent }).key,
    dedupMethod: crossWeekRecordIdentity({ productId, sourceType, rawContent }).method,
  };
}
