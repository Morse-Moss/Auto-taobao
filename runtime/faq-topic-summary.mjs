const TEXT = 1;
const LINK = 21;
const FORMULA = 20;

export const FAQ_ANALYSIS_VERSION = 'faq-text-rule-v1.0.0';
export const FAQ_TOPIC_COUNT_FORMULA = 'COUNTA(关联分析记录)+COUNTA(关联分析记录补充)';
export const FAQ_TOPIC_PRIMARY_LINK_LIMIT = 500;

const field = (name, type = TEXT, property) => ({ name, type, ...(property ? { property } : {}) });

export function buildTopicSummaryFields(analysisTableId) {
  if (!analysisTableId) throw new Error('analysisTableId is required');
  return [
    field('高频问题或关键词'),
    field('关联分析记录', LINK, { multiple: true, table_id: analysisTableId, back_field_name: '主题汇总' }),
    field('出现次数', FORMULA, { formatter: '0', formula_expression: FAQ_TOPIC_COUNT_FORMULA }),
    field('分析版本'),
    field('统计范围'),
    field('关联分析记录补充', LINK, { multiple: true, table_id: analysisTableId, back_field_name: '主题汇总补充' }),
  ];
}

export const FAQ_TOPIC_SUMMARY_FIELDS = [
  field('高频问题或关键词'),
  field('关联分析记录', LINK, { multiple: true, table_id: '__ANALYSIS_TABLE_ID__', back_field_name: '主题汇总' }),
  field('出现次数', FORMULA, { formatter: '0', formula_expression: FAQ_TOPIC_COUNT_FORMULA }),
  field('分析版本'),
  field('统计范围'),
];

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'text')) return text(value.text);
  return String(value ?? '').trim();
}

export function buildTopicSummaryRecords(detailRecords, period = '2026-08-23_2026-08-29') {
  const grouped = new Map();
  for (const record of detailRecords ?? []) {
    const topic = text(record?.fields?.高频问题或关键词);
    const recordId = text(record?.recordId ?? record?.record_id);
    if (!topic || !recordId) throw new Error('Topic summary requires topic and detail record ID');
    if (!grouped.has(topic)) grouped.set(topic, []);
    grouped.get(topic).push(recordId);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right, 'zh-CN')).map(([topic, recordIds]) => ({
    fields: {
      高频问题或关键词: topic,
      关联分析记录: recordIds.slice(0, FAQ_TOPIC_PRIMARY_LINK_LIMIT),
      分析版本: FAQ_ANALYSIS_VERSION,
      统计范围: period,
      ...(recordIds.length > FAQ_TOPIC_PRIMARY_LINK_LIMIT
        ? { 关联分析记录补充: recordIds.slice(FAQ_TOPIC_PRIMARY_LINK_LIMIT) }
        : {}),
    },
  }));
}
