const TEXT = 1;
const NUMBER = 2;

export const FAQ_ANALYSIS_VERSION = 'faq-text-rule-v1.0.0';

const TOPIC_RULES = [
  ['材质与异味', /异味|气味|味道|人造石|PMMA|亚克力|材质/u],
  ['尺寸适配', /尺寸|长度|宽度|高度|大小|小户型|空间|放进去|余量|\d+(?:\.\d+)?米/u],
  ['安装方式', /安装|开箱|拆箱|上门安装|预留/u],
  ['包装物流', /包装|木箱|木架|物流|快递|破损|磕碰/u],
  ['发货时效', /发货|到货|送货|预售|交期|几天/u],
  ['排水与配件', /下水|排水|溢水|龙头|软管|下水器|配件/u],
  ['售后服务', /客服|售后|退换|保修|质保|服务|沟通/u],
  ['价格性价比', /价格|价钱|性价比|划算|便宜|贵|优惠|预算/u],
  ['外观设计', /好看|漂亮|外观|颜值|质感|设计|颜色|光亮|哑光/u],
  ['使用体验', /舒服|舒适|泡澡|水温|深度|厚重|重量|体验|好用|清洁/u],
];

const FIELD_NAMES = [
  '商品ID', '主表记录ID', '竞品周记录ID', '商品链接', '商品标题', '竞品分类',
  '来源类型', '原始内容', '高频问题或关键词', '出现次数', '采集状态',
  '来源记录唯一键', '采集时间', '分析版本',
];

const field = (name, type = TEXT, property) => ({ name, type, ...(property ? { property } : {}) });

export const FAQ_ANALYSIS_FIELDS = [
  ...FIELD_NAMES.filter((name) => name !== '出现次数').map((name) => {
    if (name === '竞品分类') return field(name, 3, { options: ['A-爆款竞品', 'B-高价值竞品', 'C-差异化竞品', 'D-价格/流量型竞品', '无分类', '不适用'].map((option) => ({ name: option })) });
    if (name === '来源类型') return field(name, 3, { options: ['问大家', '评论'].map((option) => ({ name: option })) });
    if (name === '采集状态') return field(name, 3, { options: ['待采集', '已采集', '需人工核验'].map((option) => ({ name: option })) });
    return field(name);
  }),
  field('出现次数', NUMBER, { formatter: '0' }),
].sort((left, right) => FIELD_NAMES.indexOf(left.name) - FIELD_NAMES.indexOf(right.name));

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'text')) return text(value.text);
  return String(value ?? '').trim();
}

export function classifyFaqText(value) {
  const content = text(value);
  for (const [topic, pattern] of TOPIC_RULES) if (pattern.test(content)) return topic;
  return '其他/无法判断';
}

export function buildAnalysisRecords(rawRecords) {
  return (rawRecords ?? []).map((record) => {
    const source = record?.fields ?? {};
    const fields = { ...source };
    fields.高频问题或关键词 = classifyFaqText(source.原始内容);
    fields.分析版本 = FAQ_ANALYSIS_VERSION;
    delete fields.出现次数;
    return { recordId: record.recordId ?? record.record_id, fields };
  });
}

export function expectedTopicCounts(records) {
  const counts = new Map();
  for (const record of records ?? []) {
    const topic = text(record.fields?.高频问题或关键词);
    counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right, 'zh-CN')));
}

export function assertAnalysisRecord(record) {
  const fields = record?.fields ?? {};
  if (!text(fields.来源记录唯一键)) throw new Error(`Analysis record ${record?.recordId ?? 'unknown'} has no source key`);
  if (!text(fields.原始内容)) throw new Error(`Analysis record ${record?.recordId ?? 'unknown'} has empty raw content`);
  if (!text(fields.高频问题或关键词)) throw new Error(`Analysis record ${record?.recordId ?? 'unknown'} has no topic`);
  if (text(fields.分析版本) !== FAQ_ANALYSIS_VERSION) throw new Error(`Analysis record ${record?.recordId ?? 'unknown'} has wrong analysis version`);
  return true;
}
