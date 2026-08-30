const TEXT = 1;
const NUMBER = 2;
const SINGLE_SELECT = 3;

export const FAQ_ANALYSIS_VERSION = 'faq-ops-rule-v2.1.0';

export const FAQ_LABEL_CATALOG = [
  ['重量大/搬运困难', true],
  ['不包安装/安装费贵', true],
  ['异味问题', true],
  ['尺寸不符/偏大偏小', true],
  ['排水/漏水问题', true],
  ['品质瑕疵(划痕/裂纹/破损)', true],
  ['物流/运输问题', true],
  ['售后差/不处理', true],
  ['价格/保价问题', true],
  ['清洁困难', true],
  ['深度不够/太浅', true],
  ['系统默认/无内容', false],
  ['问答内容', false],
  ['好评-外观颜值', false],
  ['好评-质感材质', false],
  ['好评-性价比', false],
  ['好评-保温/舒适', false],
  ['好评-客服服务', false],
  ['好评-无异味', false],
  ['好评-易清洁', false],
  ['其他评价', false],
].map(([label, isPainPoint]) => ({ label, isPainPoint }));

const PAIN_RULES = [
  { label: '重量大/搬运困难', keywords: ['很重', '超级重', '非常重', '太重', '重重', '搬不动', '抬不动', '难抬', '难搬', '搬运困难', '几个人搬', '多人搬', '搬家公司'], excludes: ['不重', '不算重', '比较轻', '轻巧', '很轻'] },
  { label: '不包安装/安装费贵', keywords: ['不包安装', '不含安装', '安装费', '安装收费', '另外找安装', '自己安装', '安装师傅', '安装服务'], excludes: ['免费安装', '安装包含', '安装方便', '自己安装即可'] },
  { label: '异味问题', keywords: ['异味', '有味道', '有味', '味道难闻', '味道很大', '塑料味', '臭味', '散味'], excludes: ['没有味道', '无异味', '没异味', '没味道', '没有一点味道', '不臭', '没什么味道'] },
  { label: '尺寸不符/偏大偏小', keywords: ['尺寸有差距', '尺寸不符', '尺寸不合适', '尺寸不对', '太大', '太小', '放不下', '放不进去', '进不去', '门宽不够', '空间小', '尺寸不合适'], excludes: ['尺寸刚好', '刚刚好', '大小合适', '大小尺寸刚刚好', '尺寸合适'] },
  { label: '排水/漏水问题', keywords: ['漏水', '排水慢', '排得慢', '排不干净', '积水', '下水慢', '下水器漏', '管子脱落'], excludes: ['排水顺畅', '下水快', '排水很顺畅', '下水没问题', '排水好用'] },
  { label: '品质瑕疵(划痕/裂纹/破损)', keywords: ['划痕', '裂纹', '破损', '磕碰', '磨损', '生锈', '变色', '掉色', '底部不平', '塑料感', '质量一般', '瑕疵'], excludes: ['没有塑料感', '不会有塑料感', '质量非常好', '质量很好'] },
  { label: '物流/运输问题', keywords: ['物流很差', '物流差', '物流问题', '不送上楼', '不送进门', '放在客厅', '运输问题', '配送慢', '送货慢', '搬运费'], excludes: ['物流快', '物流很快', '物流很给力', '发货快', '发货速度快'] },
  { label: '售后差/不处理', keywords: ['售后差', '售后问题', '不处理', '没人解决', '无人解决', '推诿', '扯皮', '催促好几次', '迟迟', '闹心', '责任意识', '太差劲'], excludes: ['售后很好', '服务非常好', '客服耐心', '客服热情'] },
  { label: '价格/保价问题', keywords: ['不保价', '降价', '价格套路', '活动套路', '退差价', '贵', '价格高'], excludes: ['物美价廉', '价格实惠', '价格公道', '价格美丽', '性价比高', '划算'] },
  { label: '清洁困难', keywords: ['难清洁', '不好清洁', '难擦', '擦不干净', '难打理', '容易留手印', '容易脏', '容易花'], excludes: ['好打理', '好清洁', '易清洁', '打理省心'] },
  { label: '深度不够/太浅', keywords: ['太浅', '深度不够', '不够深', '只有43厘米', '泡不到肩', '高度不够'], excludes: [] },
];

const POSITIVE_RULES = [
  { label: '好评-外观颜值', keywords: ['好看', '漂亮', '颜值', '外观', '设计感', '高级', '大气', '精致', '美观', '时尚', '惊艳'] },
  { label: '好评-质感材质', keywords: ['质感', '材质好', '材质很好', '手感', '做工精细', '厚实', '厚重', '光滑', '细腻', '高端'] },
  { label: '好评-性价比', keywords: ['性价比', '物美价廉', '价格实惠', '划算', '值得购买', '值了这个价'] },
  { label: '好评-保温/舒适', keywords: ['舒服', '舒适', '泡澡', '保温', '放松', '体验好', '好用'] },
  { label: '好评-客服服务', keywords: ['客服耐心', '客服热情', '客服服务', '服务非常好', '服务很好', '沟通顺畅'] },
  { label: '好评-无异味', keywords: ['没有味道', '无异味', '没异味', '没味道', '没有一点味道', '不臭'] },
  { label: '好评-易清洁', keywords: ['好打理', '好清洁', '易清洁', '打理省心', '容易清洁'] },
];

const FIELD_NAMES = [
  '商品ID', '主表记录ID', '竞品周记录ID', '商品链接', '商品标题', '竞品分类',
  '来源类型', '原始内容', '分类标签', '是否痛点', '出现次数', '采集状态',
  '来源记录唯一键', '采集时间', '分析版本',
];

const field = (name, type = TEXT, property) => ({ name, type, ...(property ? { property } : {}) });

export const FAQ_ANALYSIS_FIELDS = [
  ...FIELD_NAMES.filter((name) => name !== '出现次数').map((name) => {
    if (name === '竞品分类') return field(name, SINGLE_SELECT, { options: ['A-爆款竞品', 'B-高价值竞品', 'C-差异化竞品', 'D-价格/流量型竞品', '无分类', '不适用'].map((option) => ({ name: option })) });
    if (name === '来源类型') return field(name, SINGLE_SELECT, { options: ['问大家', '评论'].map((option) => ({ name: option })) });
    if (name === '是否痛点') return field(name, SINGLE_SELECT, { options: ['是', '否'].map((option) => ({ name: option })) });
    if (name === '采集状态') return field(name, SINGLE_SELECT, { options: ['待采集', '已采集', '需人工核验'].map((option) => ({ name: option })) });
    return field(name);
  }),
  field('出现次数', NUMBER, { formatter: '0' }),
].sort((left, right) => FIELD_NAMES.indexOf(left.name) - FIELD_NAMES.indexOf(right.name));

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'text')) return text(value.text);
  return String(value ?? '').trim();
}

export function normalizeFaqText(value) {
  return text(value).normalize('NFKC').replace(/[\r\n\t ]+/gu, ' ').trim();
}

function matchesRule(content, rule) {
  return rule.keywords.some((keyword) => content.includes(keyword))
    && !(rule.excludes ?? []).some((keyword) => content.includes(keyword));
}

export function isExplicitDefaultReview(value) {
  const content = normalizeFaqText(value);
  return /^(?:该用户觉得商品非常好[,，]给出好评[。.]?|默认好评|好评)$/u.test(content);
}

export function isValidFaqRecord(value) {
  const content = normalizeFaqText(value);
  return Boolean(content) && !/^[\p{P}\p{S}\s]+$/u.test(content);
}

export function classifyFaqText(value, { sourceType = '' } = {}) {
  const content = normalizeFaqText(value);
  if (!content) return { labels: [], painLabels: [], isPain: false, isValid: false, classificationVersion: FAQ_ANALYSIS_VERSION };
  if (sourceType === '问大家' || /^问题：/u.test(content) || /^回答：/u.test(content)) {
    return { labels: ['问答内容'], painLabels: [], isPain: false, isValid: true, classificationVersion: FAQ_ANALYSIS_VERSION };
  }
  if (isExplicitDefaultReview(content)) {
    return { labels: ['系统默认/无内容'], painLabels: [], isPain: false, isValid: true, classificationVersion: FAQ_ANALYSIS_VERSION };
  }
  const painLabels = PAIN_RULES.filter((rule) => matchesRule(content, rule)).map((rule) => rule.label);
  if (painLabels.length) return { labels: painLabels, painLabels, isPain: true, isValid: true, classificationVersion: FAQ_ANALYSIS_VERSION };
  const positiveLabels = POSITIVE_RULES.filter((rule) => matchesRule(content, rule)).map((rule) => rule.label);
  return { labels: positiveLabels.length ? positiveLabels : ['其他评价'], painLabels: [], isPain: false, isValid: isValidFaqRecord(content), classificationVersion: FAQ_ANALYSIS_VERSION };
}

export function buildAnalysisRecords(rawRecords) {
  return (rawRecords ?? []).flatMap((record) => {
    const source = record?.fields ?? record ?? {};
    const classification = classifyFaqText(source.原始内容, { sourceType: source.来源类型 });
    if (!classification.isValid) return [];
    return classification.labels.map((label) => {
      const fields = { ...source };
      fields.分类标签 = label;
      fields.高频问题或关键词 = label;
      fields.是否痛点 = classification.painLabels.includes(label) ? '是' : '否';
      fields.分析版本 = FAQ_ANALYSIS_VERSION;
      return {
        recordId: record.recordId ?? record.record_id,
        fields,
        labels: [label],
        painLabels: classification.painLabels.includes(label) ? [label] : [],
        isPain: classification.painLabels.includes(label),
        classificationVersion: FAQ_ANALYSIS_VERSION,
        crossWeekDedupKey: record.crossWeekDedupKey,
        dedupMethod: record.dedupMethod,
      };
    });
  });
}

export function expectedTopicCounts(records) {
  const counts = new Map();
  for (const record of records ?? []) {
    const labels = record.labels ?? text(record.fields?.分类标签 || record.fields?.高频问题或关键词).split(' | ').filter(Boolean);
    for (const label of new Set(labels)) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right, 'zh-CN')));
}

export function assertAnalysisRecord(record) {
  const fields = record?.fields ?? {};
  if (!text(fields.来源记录唯一键)) throw new Error(`Analysis record ${record?.recordId ?? 'unknown'} has no source key`);
  if (!text(fields.原始内容)) throw new Error(`Analysis record ${record?.recordId ?? 'unknown'} has empty raw content`);
  if (!text(fields.分类标签 || fields.高频问题或关键词)) throw new Error(`Analysis record ${record?.recordId ?? 'unknown'} has no label`);
  if (text(fields.分析版本) !== FAQ_ANALYSIS_VERSION) throw new Error(`Analysis record ${record?.recordId ?? 'unknown'} has wrong analysis version`);
  return true;
}
