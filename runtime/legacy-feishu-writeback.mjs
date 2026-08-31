import fs from 'node:fs';

export const WRITEBACK_FIELDS = Object.freeze(['标准归并词', '关键词分类', '细分标签', '用户意图', '内容热度']);

export function normalizeContentHeat(value) {
  const raw = text(value);
  const normalized = raw.replace(/^AI预测-/u, '');
  if (!['高', '中', '低'].includes(normalized)) throw new Error(`Invalid 内容热度: ${raw}`);
  return normalized;
}

const CATEGORY_MAP = Object.freeze({
  '核心大词': '大词', '安装方式词': '款式词', '材质词': '材质词', '形状与风格词': '款式词',
  '功能与特点词': '功能词', '尺寸词': '尺寸词', '适用人群与场景词': '场景词', '品牌词': '品牌词',
  '地域词': '场景词', '颜色词': '风格词', '通用词': '大词', '无匹配类别': '大词', '大词': '大词',
  '场景词': '场景词', '痛点词': '痛点词', '款式词': '款式词', '风格词': '风格词', '功能词': '功能词',
});
const INTENT_MAP = Object.freeze({
  '了解型': '了解型', '购买决策型': '购买型', '对比选择型': '对比型', '场景需求型': '灵感型', '问题解决型': '问题解决型',
  '购买型': '购买型', '对比型': '对比型', '灵感型': '灵感型',
});
const LABEL_ALIAS = Object.freeze({
  '家庭': '场景/家用', '家用': '场景/家用', '小空间': '场景/小户型', '小户型': '场景/小户型',
  '成人': '场景/成人', '情侣': '场景/情侣', '老人': '场景/老人', '老年人': '场景/老人', '适老化': '场景/老人',
  '酒店': '场景/酒店', '民宿': '场景/民宿', '美容院': '场景/美容院', '浴室': '场景/浴室', '卫生间': '场景/卫生间',
  '无障碍': '场景/无障碍', '日本': '地域/日本', '广东佛山': '地域/广东佛山', '高端改善': '场景/高端改善',
  '高级感': '风格/高级感', '复古': '风格/复古', '老式': '风格/老式', '日式': '风格/日式', '法式': '风格/法式',
  '欧式': '风格/欧式', '网红': '风格/网红', '透明': '外观/透明', '彩色': '颜色/彩色', '粉色': '颜色/粉色',
  '亚克力': '材质/亚克力', '人造石': '材质/人造石', 'PMMA': '材质/PMMA', '玻璃': '材质/玻璃', '树脂': '材质/树脂',
  '大理石': '材质/大理石', '不锈钢': '材质/不锈钢', '搪瓷': '材质/搪瓷', '钢瓷釉': '材质/钢板搪瓷',
  '布': '材质/布艺', '按摩': '功能/按摩', '水疗': '功能/水疗', '冲浪': '功能/冲浪', '深泡': '功能/深泡',
  '恒温': '功能/恒温', '加热': '功能/加热', '保温': '功能/保温', '智能': '功能/智能', '定制': '功能/定制',
  '免安装': '功能/免安装', '新款': '功能/新款', '可移动': '功能/可移动', '可移动式': '功能/可移动', '助浴': '功能/助浴',
  '洗澡': '功能/洗浴', '洗浴': '功能/洗浴', '淋浴一体': '功能/淋浴组合', '淋浴二合一': '功能/淋浴组合',
  '独立式': '款式/独立式', '立式': '款式/独立式', '嵌入式': '款式/嵌入式', '坐式': '款式/坐式', '靠墙式': '款式/靠墙式',
  '悬浮': '款式/悬浮式', '成品': '款式/成品', '步入式': '款式/步入式', '开门': '款式/开门式', '开门式': '款式/开门式',
  '转角': '款式/转角式', '切角': '款式/切角式', '方形': '款式/方形', '正方形': '款式/正方形', '三角形': '款式/三角形',
  '椭圆形': '款式/椭圆形', '圆形': '款式/圆形', '扇形': '款式/扇形', '异形': '款式/异形', '贵妃': '款式/贵妃式', '贵妇': '款式/贵妃式',
  '长方形': '款式/长方形', '一体式': '款式/一体式', '一体': '款式/一体式', '酒店民宿': '场景/酒店民宿',
  '单人': '尺寸/单人', '双人': '尺寸/双人', '大型': '尺寸/大型', '小尺寸': '尺寸/小型', '超小型': '尺寸/超小',
  '小型': '尺寸/小型', '迷你': '尺寸/迷你', '尺寸': '需求/尺寸咨询', '十大品牌': '需求/品牌榜单', '十大名牌': '需求/品牌榜单',
  'toto': 'toto', 'TOTO': '品牌/TOTO', 'bathtope': '品牌/Bathtope', '汉斯格雅': '品牌/汉斯格雅', 'SSWW': '品牌/浪鲸',
  '浪鲸': '品牌/浪鲸', '箭牌卫浴': '品牌/箭牌', '九牧': '品牌/九牧', '科勒': '品牌/科勒', '杜拉维特': '品牌/杜拉维特',
  '卡德维': '品牌/卡德维', '果敢': '品牌/果敢', '特拉维尔': '品牌/特拉维尔', '小米': '品牌/小米', '东鹏卫浴': '品牌/东鹏',
  '东鹏': '品牌/东鹏', '恒洁': '品牌/恒洁', '法恩莎': '品牌/法恩莎', '美标': '品牌/美标', '惠达': '品牌/惠达',
  '碧澜': '品牌/碧澜', '唯宝': '品牌/唯宝', '埃飞灵': '品牌/埃飞灵', '米希尔': '品牌/米希尔', '劳芬': '品牌/劳芬',
  '日丰': '品牌/日丰', '安华': '品牌/安华', '恩仕': '品牌/恩仕', '乐溢': '品牌/乐溢',
});

function text(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((item) => item?.text ?? item?.name ?? item ?? '').join('、');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return String(value).trim();
}

function labels(value) {
  return text(value).split(/[、,，;；\n]+/u).map((item) => item.trim()).filter(Boolean);
}

export function mapLegacyLabel(value, allowed) {
  const raw = text(value);
  if (!raw) return { value: null, mapped: true };
  if (allowed.has(raw)) return { value: raw, mapped: true };
  const alias = LABEL_ALIAS[raw] ?? LABEL_ALIAS[raw.toLowerCase()];
  if (alias && allowed.has(alias)) return { value: alias, mapped: true };
  const prefixed = [...allowed].find((option) => option.endsWith(`/${raw}`));
  if (prefixed) return { value: prefixed, mapped: true };
  return { value: null, mapped: false, raw };
}

export function mapLegacyResult(result, allowed) {
  const fields = result?.字段 ?? {};
  const mappedLabels = [];
  const unmappedLabels = [];
  for (const label of labels(fields.细分标签)) {
    const mapped = mapLegacyLabel(label, allowed);
    if (mapped.mapped && mapped.value) mappedLabels.push(mapped.value);
    else if (!mapped.mapped) unmappedLabels.push(label);
  }
  const category = CATEGORY_MAP[text(fields.关键词分类)];
  const intent = INTENT_MAP[text(fields.用户意图)];
  if (!category || !intent) throw new Error(`Unmapped legacy enum for ${result?.record_id ?? result?.keywordId}`);
  const heat = normalizeContentHeat(fields.内容热度);
  return {
    record_id: result.record_id,
    fields: {
      标准归并词: text(fields.标准归并词),
      关键词分类: category,
      细分标签: [...new Set(mappedLabels)],
      用户意图: intent,
      内容热度: heat,
    },
    unmappedLabels,
  };
}

export function buildLegacyWritebackPlan({ artifact, records, fieldDefinitions }) {
  if (artifact?.status !== 'LOCAL_LEGACY_PROMPT_ANALYSIS_READY') throw new Error('Artifact is not ready for writeback');
  if (!Array.isArray(records) || records.length !== artifact.recordCount) throw new Error('Source record count mismatch');
  const labelField = fieldDefinitions.find((field) => field.field_name === '细分标签');
  const allowedLabels = new Set((labelField?.property?.options ?? []).map((option) => option.name));
  if (!allowedLabels.size) throw new Error('Current 细分标签 options are unavailable');
  const byId = new Map(artifact.results.map((result) => [result.record_id, result]));
  if (byId.size !== artifact.recordCount) throw new Error('Artifact contains duplicate or missing record ids');
  const updates = [];
  const unmapped = {};
  let preservedExisting = 0;
  for (const record of records) {
    const result = byId.get(record.record_id);
    if (!result) throw new Error(`Artifact missing ${record.record_id}`);
    const mapped = mapLegacyResult(result, allowedLabels);
    if (mapped.unmappedLabels.length) unmapped[record.record_id] = mapped.unmappedLabels;
    const fields = {};
    for (const name of WRITEBACK_FIELDS) {
      const existing = record.fields?.[name];
      const blank = existing == null || existing === '' || (Array.isArray(existing) && existing.length === 0);
      if (blank) fields[name] = mapped.fields[name];
      else preservedExisting += 1;
    }
    if (Object.keys(fields).length) updates.push({ record_id: record.record_id, fields });
  }
  return { updates, preservedExisting, unmappedLabels: unmapped, unmappedLabelCount: Object.values(unmapped).reduce((sum, values) => sum + values.length, 0) };
}

export function readArtifact(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
