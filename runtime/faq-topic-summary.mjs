import { FAQ_LABEL_CATALOG } from './faq-text-analysis.mjs';

const TEXT = 1;
const NUMBER = 2;
const SINGLE_SELECT = 3;
const MULTI_SELECT = 4;

const field = (name, type = TEXT, property) => ({ name, type, ...(property ? { property } : {}) });
const options = (names) => ({ options: names.map((name) => ({ name })) });

const COMPETITOR_OPTIONS = ['A-爆款竞品', 'B-高价值竞品', 'C-差异化竞品', 'D-价格流量型竞品'];
const WEEKLY_COMPETITOR_OPTIONS = [...COMPETITOR_OPTIONS, '无分类', '不适用'];
const SOURCE_OPTIONS = ['问大家', '评论'];
const COLLECTION_OPTIONS = ['待采集', '已采集', '需人工核验'];
const PAIN_OPTIONS = ['是', '否'];

export const FAQ_MASTER_TABLE_NAME = '问题主库';
export const FAQ_SCHEMA_VERSION = 'faq-feishu-summary-v2.0.0';

export const FAQ_MASTER_FIELDS = [
  field('分类标签'),
  field('是否痛点', SINGLE_SELECT, options(PAIN_OPTIONS)),
  field('出现次数', NUMBER, { formatter: '0' }),
  field('占比', NUMBER, { formatter: '0.00%' }),
  field('痛点描述'),
  field('典型问题'),
  field('典型用户原话'),
];

export const FAQ_WEEKLY_FIELDS = [
  field('分类标签'),
  field('是否痛点', SINGLE_SELECT, options(PAIN_OPTIONS)),
  field('出现次数', NUMBER, { formatter: '0' }),
  field('痛点描述'),
  field('典型问题'),
  field('典型用户原话'),
];

export function faqWeeklyTableName(period) {
  if (!/^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/u.test(String(period ?? ''))) throw new Error('period must be YYYY-MM-DD_YYYY-MM-DD');
  return `问题库_${period}`;
}

export function rowsForFeishu(summary, includeShare) {
  const rows = summary?.rows ?? [];
  const expected = new Set(FAQ_LABEL_CATALOG.map(({ label }) => label));
  if (rows.length !== expected.size) throw new Error(`FAQ summary must contain exactly ${expected.size} rows`);
  const seen = new Set();
  return rows.map((row) => {
    const label = String(row.分类标签 ?? '').trim();
    if (!expected.has(label) || seen.has(label)) throw new Error(`FAQ summary contains invalid or duplicate label: ${label}`);
    seen.add(label);
    const count = Number(row.出现次数);
    if (!Number.isInteger(count) || count < 0) throw new Error(`FAQ summary has invalid count for ${label}`);
    const pain = String(row.是否痛点 ?? '').trim();
    if (!PAIN_OPTIONS.includes(pain)) throw new Error(`FAQ summary has invalid pain flag for ${label}`);
    if (!String(row.典型问题 ?? '').trim()) throw new Error(`FAQ summary has empty typical question for ${label}`);
    const result = {
      分类标签: label,
      是否痛点: pain,
      出现次数: count,
      ...(includeShare ? { 占比: Number(row.占比) } : {}),
      痛点描述: String(row.痛点描述 ?? '').trim(),
      典型问题: String(row.典型问题 ?? '').trim(),
      典型用户原话: String(row.典型用户原话 ?? '').trim(),
    };
    if (includeShare && !Number.isFinite(result.占比)) throw new Error(`FAQ summary has invalid share for ${label}`);
    return result;
  });
}
