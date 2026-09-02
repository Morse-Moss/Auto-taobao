const TEXT = 1;
const NUMBER = 2;
const SINGLE_SELECT = 3;

export const FAQ_ANALYSIS_VERSION = 'faq-ops-rule-v3.3.1';
export const PAIN_JUDGMENT_OPTIONS = ['是', '否', '需人工核验'];

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

const FUTURE_STATE_KEYWORDS = [
  '尚未安装', '还没安装', '未安装', '安装后再反馈', '安装后反馈',
  '尚未使用', '还没使用', '暂未使用', '暂时没用', '还没用', '使用后再反馈',
  '后续反馈', '后面再反馈', '等使用后', '等安装后', '入住后再体验', '等待后续反馈',
];

const ISSUE_RULES = [
  {
    label: '重量大/搬运困难',
    topicKeywords: ['重量', '很重', '太重', '沉', '搬', '抬'],
    painKeywords: ['很重很难搬', '太重难搬', '搬不动', '抬不动', '难抬', '难搬', '搬运困难', '费老大劲', '费了老大劲', '费很大劲', '费了很大劲', '费了九牛二虎之力', '两个人抬不了', '两个人也不好抬', '需要找5个人抬', '喊了五个人才搬', '好几个人抬上去', '三个人搬进来的', '找了三个师傅才抬进去', '请了四个搬运', '三个快递小哥费了好半天力气', '四个小伙子费了九牛二虎之力', '要几个人抬', '需要自己付搬运费', '搬运费贵'],
    positiveKeywords: ['重量不影响', '不重', '比较轻', '轻巧', '很轻', '搬运方便', '容易搬', '搬得动', '帮忙搬进家里', '帮忙搬上楼', '师傅就抬进去了', '搬运可以底下铺个毯子往前拉'],
    neutralKeywords: ['有重量', '有份量', '光是搬运就知道质量超好'],
    omitTopicOnly: true,
  },
  {
    label: '不包安装/安装费贵',
    topicKeywords: ['安装', '安装师傅', '安装服务', '安装费', '安装收费'],
    painKeywords: ['不包安装', '不含安装', '不提供安装', '没有安装服务', '安装费贵', '安装费高', '安装收费', '额外支付安装费', '另外找安装', '自己找安装', '自己找的安装师傅', '自己安装', '自行安装', '只能自己安装', '需自己安装', '需要自己安装', '另找安装', '另请安装', '安装没人管', '安装无人处理'],
    positiveKeywords: ['免费安装', '安装包含', '安装方便', '安装师傅很到位', '安装专业到位', '安装到位', '安装顺利', '安装简单', '安装专业', '师傅很负责', '师傅服务好', '安装完毕', '安装好了', '安装好', '安装后', '安装位置合适', '安装尺寸刚好合适', '安装师傅也很尽责', '安装师傅也非常认真负责', '安装师傅也很专业', '上门安装也很快', '安装说明', '详细的说明', '安装上完全合适', '安装效果很满意', '安装也比较方便', '安装快递', '安装好非常漂亮', '最终算解决了', '积极处理妥当处理'],
    futureKeywords: ['尚未安装', '还没安装', '未安装', '安装后再反馈', '安装后反馈', '等安装后'],
    omitTopicOnly: true,
  },
  {
    label: '异味问题',
    topicKeywords: ['异味', '味道', '气味', '有味', '臭'],
    painKeywords: ['有异味', '异味很大', '异味明显', '味道大', '味道很大', '味道难闻', '味道刺鼻', '味道很重', '异味很重', '有臭味', '臭味', '很臭', '塑料味', '散不掉', '散味很久', '一直有味'],
    positiveKeywords: ['没有异味', '无异味', '没异味', '没有味道', '没味道', '没有一点味道', '不臭', '没什么味道', '味道淡', '无明显气味'],
    futureKeywords: ['使用后再反馈', '还没使用', '尚未使用', '暂未使用', '暂时没用', '等使用后', '后续反馈'],
  },
  {
    label: '尺寸不符/偏大偏小',
    topicKeywords: ['尺寸', '大小', '长度', '宽度', '高度', '空间'],
    painKeywords: ['尺寸有差距', '尺寸不符', '尺寸不合适', '尺寸不对', '太大', '太小', '放不下', '放不进去', '进不去', '门宽不够', '空间小', '不够长', '不够宽'],
    positiveKeywords: ['尺寸刚好', '尺寸刚刚好', '尺寸合适', '大小合适', '大小尺寸刚刚好', '长度合适', '放得下', '严丝合缝', '尺寸正好', '大小正好', '安装上完全合适', '刚刚好能进去卫生间门', '长度也还可以', '完全够用了'],
    omitTopicOnly: true,
  },
  {
    label: '排水/漏水问题',
    topicKeywords: ['排水', '下水', '漏水', '积水'],
    painKeywords: ['漏水', '排水慢', '排得慢', '排不干净', '积水', '下水慢', '下水器漏', '管子脱落', '堵水'],
    positiveKeywords: ['排水顺畅', '给水与排水都很流畅', '下水快', '排水很顺畅', '下水没问题', '排水好用', '下水顺畅', '下水很快', '下水顺滑', '下水器很灵敏', '下水器也很漂亮', '直接插上排水'],
    omitTopicOnly: true,
  },
  {
    label: '品质瑕疵(划痕/裂纹/破损)',
    topicKeywords: ['划痕', '裂纹', '破损', '磕碰', '磨损', '生锈', '变色', '掉色', '瑕疵', '质量'],
    painKeywords: ['有划痕', '有裂纹', '有破损', '磕碰', '磨损', '生锈', '变色', '掉色', '底部不平', '质量一般', '质量问题', '存在瑕疵'],
    positiveKeywords: ['没有划痕', '没有裂纹', '没有破损', '无磕碰', '无擦碰', '没有瑕疵', '验货完全无损', '没有磕碰和瑕疵', '品质杠杠的', '质量没毛病', '质量非常好', '质量很好', '质量不错', '质量好', '品质很好', '品质不错', '品质好', '质量可以', '质量都在线', '商品品质优秀', '做工精细'],
  },
  {
    label: '物流/运输问题',
    topicKeywords: ['物流', '运输', '配送', '快递'],
    painKeywords: ['物流很差', '物流差', '物流问题', '不送上楼', '不送进门', '放在客厅', '运输问题', '配送慢', '送货慢', '搬运费', '物流破损', '运输破损'],
    omitTopicOnly: true,
    positiveKeywords: ['物流快', '物流很快', '物流很给力', '物流迅速', '发货快', '发货速度快', '送货上门', '送货很快', '快递很快', '包装结实', '包装很结实', '包装严实', '包装非常稳妥', '木盒包装非常稳妥', '木箱防护严实完好', '包装特别好', '快递小哥很靠谱', '快递小哥人很好', '快递帮忙搬运', '快递小哥帮忙拆的外包装', '及时送到', '及时解决', '物流出了一些状况也能及时解决'],
  },
  {
    label: '售后差/不处理',
    topicKeywords: ['售后', '客服', '处理', '解决', '沟通'],
    painKeywords: ['售后差', '售后问题', '不处理', '没人解决', '无人解决', '推诿', '扯皮', '催促好几次', '迟迟不处理', '闹心', '责任意识差', '太差劲', '服务是真的差', '客服态度差', '售后不管'],
    positiveKeywords: ['售后很好', '服务非常好', '客服都很好', '客服耐心', '客服热情', '客服也耐心', '客服也很耐心', '客服耐心热情', '耐心热情', '客服服务好', '客服服务很到位', '客服服务周到', '客服态度也好', '客服态度很好', '客服态度也超好', '客服态度非常好', '客服服务态度也很好', '客服人员态度很好', '客服全程态度都巨好', '客服服务也很不错', '客服人员每问必答', '客服很专业很耐心', '客服很有耐心', '回答很有耐心', '有疑问及时解答', '回复的很及时', '响应也很及时', '认真负责', '商家服务也很好', '商家态度也好', '售后也好', '沟通顺畅', '沟通都很专业很棒', '及时解决', '妥善解决', '问题总算解决了', '最终算解决了', '商家积极处理妥当处理', '售后放心', '服务很好', '服务也很好', '服务态度也是非常好', '卖家也给很好的解决'],
  },
  {
    label: '价格/保价问题',
    topicKeywords: ['价格', '价钱', '保价', '差价'],
    painKeywords: ['不保价', '价格套路', '活动套路', '退差价', '价格太高', '价格贵', '价钱贵', '买贵了', '不退差价'],
    positiveKeywords: ['物美价廉', '价格实惠', '价格公道', '价格美丽', '性价比高', '划算', '值得购买', '值了这个价', '价格合理', '价格合适', '价格适中'],
  },
  {
    label: '清洁困难',
    topicKeywords: ['清洁', '打理', '擦', '脏', '手印'],
    painKeywords: ['难清洁', '不好清洁', '难擦', '擦不干净', '难打理', '容易留手印', '容易脏', '容易花', '清洁麻烦'],
    positiveKeywords: ['好打理', '好清洁', '易清洁', '打理省心', '容易清洁', '清洁方便', '清洁不费劲', '砂纸轻轻一擦就干净如初', '再也不是简单的清洁啦'],
  },
  {
    label: '深度不够/太浅',
    topicKeywords: ['深度', '太浅', '泡不到', '高度'],
    painKeywords: ['太浅', '深度不够', '不够深', '泡不到肩', '高度不够', '泡澡不舒服'],
    positiveKeywords: ['深度合适', '深度够', '泡澡舒服', '泡得舒服'],
    omitTopicOnly: true,
  },
];

const POSITIVE_RULES = [
  { label: '好评-外观颜值', keywords: ['好看', '漂亮', '颜值', '外观', '设计感', '高级', '大气', '精致', '美观', '时尚', '惊艳'] },
  { label: '好评-质感材质', keywords: ['质感', '材质好', '材质很好', '手感', '做工精细', '厚实', '厚重', '光滑', '细腻', '高端'] },
  { label: '好评-性价比', keywords: ['性价比', '物美价廉', '价格实惠', '划算', '值得购买', '值了这个价'] },
  { label: '好评-保温/舒适', keywords: ['舒服', '舒适', '泡澡', '保温', '放松', '体验好', '好用'] },
  { label: '好评-客服服务', keywords: ['客服耐心', '客服热情', '客服也耐心', '客服也很耐心', '客服耐心热情', '耐心热情', '客服服务', '服务非常好', '服务很好', '沟通顺畅'] },
  { label: '好评-无异味', keywords: ['没有异味', '没有味道', '无异味', '没异味', '没味道', '没有一点味道', '不臭', '没有明显味道'] },
  { label: '好评-易清洁', keywords: ['好打理', '好清洁', '易清洁', '打理省心', '容易清洁'] },
];

const FIELD_NAMES = [
  '商品ID', '主表记录ID', '竞品周记录ID', '商品链接', '商品标题', '竞品分类',
  '来源类型', '原始内容', '分类标签', '是否痛点', '出现次数', '采集状态',
  '来源记录唯一键', '采集时间', '分析版本', '痛点判定依据', '痛点判定置信度',
];

const field = (name, type = TEXT, property) => ({ name, type, ...(property ? { property } : {}) });

export const FAQ_ANALYSIS_FIELDS = [
  ...FIELD_NAMES.filter((name) => name !== '出现次数').map((name) => {
    if (name === '竞品分类') return field(name, SINGLE_SELECT, { options: ['A-爆款竞品', 'B-高价值竞品', 'C-差异化竞品', 'D-价格/流量型竞品', '无分类', '不适用'].map((option) => ({ name: option })) });
    if (name === '来源类型') return field(name, SINGLE_SELECT, { options: ['问大家', '评论'].map((option) => ({ name: option })) });
    if (name === '是否痛点') return field(name, SINGLE_SELECT, { options: PAIN_JUDGMENT_OPTIONS.map((option) => ({ name: option })) });
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

function firstMatch(content, keywords) {
  return keywords
    .map((keyword) => ({ keyword, index: content.indexOf(keyword) }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => left.index - right.index || right.keyword.length - left.keyword.length)[0] ?? null;
}

function firstIndependentMatch(content, keywords, coveredBy = []) {
  const covering = coveredBy
    .map((keyword) => firstMatch(content, [keyword]))
    .filter(Boolean)
    .map(({ keyword, index }) => ({ start: index, end: index + keyword.length }));
  return keywords
    .map((keyword) => ({ keyword, index: content.indexOf(keyword) }))
    .filter(({ index }) => index >= 0)
    .filter(({ keyword, index }) => !covering.some(({ start, end }) => index >= start && index + keyword.length <= end))
    .sort((left, right) => left.index - right.index || right.keyword.length - left.keyword.length)[0] ?? null;
}

function isNegated(content, match) {
  const prefix = content.slice(Math.max(0, match.index - 2), match.index);
  return /(?:不|没|没有|无|未)$/u.test(prefix);
}

function firstNonNegatedMatch(content, keywords) {
  return keywords
    .map((keyword) => ({ keyword, index: content.indexOf(keyword) }))
    .filter((match) => match.index >= 0 && !isNegated(content, match))
    .sort((left, right) => left.index - right.index || right.keyword.length - left.keyword.length)[0] ?? null;
}

function judgmentForIssue(content, rule) {
  const painEvidence = firstNonNegatedMatch(content, rule.painKeywords);
  const positiveEvidence = firstIndependentMatch(content, rule.positiveKeywords, rule.painKeywords);
  const topicEvidence = firstMatch(content, rule.topicKeywords);
  const neutralEvidence = firstMatch(content, rule.neutralKeywords ?? []);
  const futureEvidence = firstMatch(content, [...(rule.futureKeywords ?? []), ...FUTURE_STATE_KEYWORDS]);
  if (painEvidence && positiveEvidence) {
    return { judgment: '需人工核验', evidence: `同时出现问题表达“${painEvidence.keyword}”和正面表达“${positiveEvidence.keyword}”`, confidence: '低' };
  }
  if (painEvidence && futureEvidence) {
    return { judgment: '需人工核验', evidence: `同时出现问题表达“${painEvidence.keyword}”和未来状态“${futureEvidence.keyword}”`, confidence: '低' };
  }
  if (painEvidence) return { judgment: '是', evidence: painEvidence.keyword, confidence: '高' };
  if (positiveEvidence) return null;
  if (neutralEvidence) return { judgment: '需人工核验', evidence: neutralEvidence.keyword, confidence: '低' };
  if (futureEvidence && topicEvidence) return { judgment: '否', evidence: `当前未完成体验：“${futureEvidence.keyword}”`, confidence: '高' };
  if (topicEvidence && !rule.omitTopicOnly) return { judgment: '需人工核验', evidence: topicEvidence.keyword, confidence: '低' };
  return null;
}


function positiveEvidenceFor(content, rule) {
  return firstMatch(content, rule.keywords)?.keyword ?? '';
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
  if (!content) return { labels: [], topicLabels: [], painLabels: [], isPain: false, isValid: false, judgmentByLabel: {}, evidenceByLabel: {}, confidenceByLabel: {}, classificationVersion: FAQ_ANALYSIS_VERSION };
  if (sourceType === '问大家' || /^问题：/u.test(content) || /^回答：/u.test(content)) {
    const question = (content.split(/回答[:：]/u, 1)[0] || content).replace(/^问题[:：]/u, '').trim();
    const questionLabels = ISSUE_RULES
      .filter((rule) => firstMatch(question, rule.topicKeywords))
      .map((rule) => [rule.label, firstMatch(question, rule.topicKeywords).keyword]);
    if (questionLabels.length) {
      const judgmentByLabel = Object.fromEntries(questionLabels.map(([label]) => [label, '是']));
      const evidenceByLabel = Object.fromEntries(questionLabels.map(([label, evidence]) => [label, `提问本身表达用户疑虑：“${evidence}”`]));
      const confidenceByLabel = Object.fromEntries(questionLabels.map(([label]) => [label, '高']));
      const labels = questionLabels.map(([label]) => label);
      return { labels, topicLabels: labels, painLabels: labels, isPain: true, isValid: true, judgmentByLabel, evidenceByLabel, confidenceByLabel, classificationVersion: FAQ_ANALYSIS_VERSION };
    }
    return { labels: ['问答内容'], topicLabels: ['问答内容'], painLabels: [], isPain: false, isValid: true, judgmentByLabel: { 问答内容: '否' }, evidenceByLabel: { 问答内容: '来源为问大家但未命中业务主题' }, confidenceByLabel: { 问答内容: '低' }, classificationVersion: FAQ_ANALYSIS_VERSION };
  }
  if (isExplicitDefaultReview(content)) {
    return { labels: ['系统默认/无内容'], topicLabels: ['系统默认/无内容'], painLabels: [], isPain: false, isValid: true, judgmentByLabel: { '系统默认/无内容': '否' }, evidenceByLabel: { '系统默认/无内容': '系统默认评价' }, confidenceByLabel: { '系统默认/无内容': '高' }, classificationVersion: FAQ_ANALYSIS_VERSION };
  }

  const issueLabels = [];
  const judgmentByLabel = {};
  const evidenceByLabel = {};
  const confidenceByLabel = {};
  const painLabels = [];
  for (const rule of ISSUE_RULES) {
    const result = judgmentForIssue(content, rule);
    if (!result) continue;
    issueLabels.push(rule.label);
    judgmentByLabel[rule.label] = result.judgment;
    evidenceByLabel[rule.label] = result.evidence;
    confidenceByLabel[rule.label] = result.confidence;
    if (result.judgment === '是') painLabels.push(rule.label);
  }

  const positiveLabels = [];
  for (const rule of POSITIVE_RULES) {
    const evidence = positiveEvidenceFor(content, rule);
    if (!evidence) continue;
    positiveLabels.push(rule.label);
    judgmentByLabel[rule.label] = '否';
    evidenceByLabel[rule.label] = evidence;
    confidenceByLabel[rule.label] = '高';
  }

  const labels = [...new Set([...issueLabels, ...positiveLabels])];
  if (!labels.length) {
    labels.push('其他评价');
    judgmentByLabel['其他评价'] = '否';
    evidenceByLabel['其他评价'] = '未命中明确主题问题或正面表达';
    confidenceByLabel['其他评价'] = '低';
  }
  return {
    labels,
    topicLabels: labels,
    painLabels,
    isPain: painLabels.length > 0,
    isValid: isValidFaqRecord(content),
    judgmentByLabel,
    evidenceByLabel,
    confidenceByLabel,
    classificationVersion: FAQ_ANALYSIS_VERSION,
  };
}

export function buildAnalysisRecords(rawRecords) {
  return (rawRecords ?? []).flatMap((record) => {
    const source = record?.fields ?? record ?? {};
    const classification = classifyFaqText(source.原始内容, { sourceType: source.来源类型 });
    if (!classification.isValid) return [];
    return classification.labels.map((label) => {
      const judgment = classification.judgmentByLabel[label] ?? '否';
      const fields = { ...source };
      fields.分类标签 = label;
      fields.高频问题或关键词 = label;
      fields.是否痛点 = judgment;
      fields.分析版本 = FAQ_ANALYSIS_VERSION;
      fields.痛点判定依据 = classification.evidenceByLabel[label] ?? '';
      fields.痛点判定置信度 = classification.confidenceByLabel[label] ?? '低';
      return {
        recordId: record.recordId ?? record.record_id,
        fields,
        labels: [label],
        topicLabels: [label],
        painLabels: judgment === '是' ? [label] : [],
        painJudgment: judgment,
        painEvidence: fields.痛点判定依据,
        painConfidence: fields.痛点判定置信度,
        isPain: judgment === '是',
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

export function sourceTopicIdentity(record) {
  const fields = record?.fields ?? record ?? {};
  const sourceKey = text(fields.来源记录唯一键);
  const label = text(fields.分类标签 || fields.高频问题或关键词);
  if (!sourceKey || !label) throw new Error(`Analysis record ${record?.recordId ?? 'unknown'} has incomplete source-topic identity`);
  return `${sourceKey}\n${label}`;
}

export function assertUniqueSourceTopics(records, name = 'Analysis records') {
  const seen = new Set();
  for (const record of records ?? []) {
    const identity = sourceTopicIdentity(record);
    if (seen.has(identity)) throw new Error(`${name} has duplicate source-topic identity: ${identity.replace('\n', ' / ')}`);
    seen.add(identity);
  }
  return true;
}

export function assertAnalysisRecord(record) {
  const fields = record?.fields ?? {};
  if (!text(fields.来源记录唯一键)) throw new Error(`Analysis record ${record?.recordId ?? 'unknown'} has no source key`);
  if (!text(fields.原始内容)) throw new Error(`Analysis record ${record?.recordId ?? 'unknown'} has empty raw content`);
  const label = text(fields.分类标签 || fields.高频问题或关键词);
  if (!label) throw new Error(`Analysis record ${record?.recordId ?? 'unknown'} has no label`);
  if (text(fields.分析版本) !== FAQ_ANALYSIS_VERSION) throw new Error(`Analysis record ${record?.recordId ?? 'unknown'} has wrong analysis version`);
  if (!PAIN_JUDGMENT_OPTIONS.includes(text(fields.是否痛点))) throw new Error(`Analysis record ${record?.recordId ?? 'unknown'} has invalid pain judgment`);
  if (!text(fields.痛点判定依据) || !text(fields.痛点判定置信度)) throw new Error(`Analysis record ${record?.recordId ?? 'unknown'} has incomplete pain judgment evidence`);
  return true;
}
