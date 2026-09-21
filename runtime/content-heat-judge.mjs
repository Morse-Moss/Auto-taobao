// 内容热度（AI 段）的**分析侧**：把现行提示词逐句落成一个可复现的判定。
//
// 为什么要有这个模块（以及为什么它和写入器分开）：
//   `runtime/content-heat-apply.mjs` 只管「把判定写进飞书」；判定从哪来此前**没有仓库内实现**——
//   300 行的判定一直由会话里的探针脚本（`D:/Retire/probe-live/calib-06-literal-judge.mjs`）产出，
//   探针不在仓库里、不进套件、没人守，等于每周的判定口径寄存在一次对话里。
//   这里把它搬进仓库，并**把判据钉在提示词原文上**（见 PROMPT_DIGEST）。
//
// 判定的来源是提示词原文，不是我的口味：
//   原文「纯品牌、店铺、导航、过度宽泛、信息不足，或搜索与交易信号都弱且无内容切入点时输出低」
//     → 低：纯店铺导航 / 纯品牌 / 无属性可依（= 信息不足或过度宽泛）
//   原文「明确问题、对比、选购、场景或可解释属性，且搜索热度或交易热度为高时输出高」
//     → 高：有非品牌属性且（搜索=高 或 交易=高）
//   原文「有清晰属性或场景但信号一般时输出中」
//     → 中：有非品牌属性但信号不是高
//   原文「无法根据输入确认时输出待核验」
//     → 待核验：搜索热度或交易热度读不到（信号未知时不许猜高/中/低）
//
// 这个读法在 4 批 1200 行历史落库值上命中 88.9%（对照恒判「中」= 70.3%），
// 也就是「历史一直在用的那个读法」；证据见 evidence/keyword-ai-local-2026-09-20/18-*.txt。

import crypto from 'node:crypto';

import { ANALYSIS_REGISTRY } from './weekly-local-analysis.mjs';
import { readbackText } from './feishu-readback.mjs';

export const CONTENT_HEAT_FIELD = '内容热度';
export const CONTENT_HEAT_ARTIFACT_STATUS = 'CONTENT_HEAT_ANALYSIS_READY';
export const CONTENT_HEAT_JUDGE_VERSION = '2026-09-21.1';

/** 判定所依据的提示词**从这里取**，不许在别处再抄一份。 */
export const CONTENT_HEAT_PROMPT = ANALYSIS_REGISTRY.prompts.contentHeat;

/**
 * 提示词的指纹。判定规则是照着这段文字写的，文字一改判定就可能不再成立。
 *
 * 所以这里**硬编码它当时的样子**：谁改了 `weekly-local-analysis.mjs` 的 contentHeat 提示词，
 * 而没回来重新对一遍判定，`assertPromptBinding()` 就会当场炸。
 * 这是「提示词是唯一事实来源」这句话的可执行形态 —— 否则它只是一句文档。
 *
 * 重新钉的方法：跑 `node -e "import('./runtime/content-heat-judge.mjs').then(m=>console.log(m.promptDigest()))"`，
 * 用打印出来的值替换这里，并在同一提交里说明判定有没有跟着改。
 */
export const PROMPT_DIGEST = '1945f62bf7c0a655985206f6ff83431dab3024c7cf5039c71878a27fb5a624dc';

export function promptDigest(text = CONTENT_HEAT_PROMPT) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 提示词绑定校验。
 *
 * 返回 `{ ok, expected, actual }` 而不是布尔：调用方要能把「差了哪一段」写进收据，
 * 只给 true/false 的判据在自动化里等于没有诊断信息。
 */
export function assertPromptBinding(text = CONTENT_HEAT_PROMPT) {
  const actual = promptDigest(text);
  return { ok: actual === PROMPT_DIGEST, expected: PROMPT_DIGEST, actual };
}

/** 品牌词表。来源：细分标签的历史产出（`品牌/xxx`）与老提示词 C 的材质/品牌枚举。 */
export const BRAND_WORDS = Object.freeze([
  '浪鲸', '科勒', '九牧', '箭牌', 'TOTO', 'toto', '埃飞灵', '恒洁', '惠达', 'bette', 'BETTE', 'tw', 'TW',
  '美标', '东鹏', '法恩莎', '安华', '尚高', '高斯', '乐家', '杜拉维特', '汉斯格雅', '摩恩', '松下', '英皇', '欧派',
  '帝王', '澳斯曼', '阿波罗', '瑞尔特', 'diiib', '日丰', '申鹭达', '中宇', '特陶', '卡德维', 'kaldewei',
  '特拉维尔', '唯宝', '恩仕', '果敢', '米希尔', '范尔德', '观博', '碧澜', '劳芬', 'ssww', 'SSWW',
]);

/** 店铺导航词。提示词原文把这些与「纯品牌」一起归到「低」。 */
export const NAVIGATION_PATTERN = /旗舰店|专卖店|专营店|官方店/u;

/** 「可解释属性」的分类。分类本身是属性类词 ⇒ 即使标签为空也算有属性。 */
export const ATTRIBUTE_CATEGORIES = Object.freeze(['场景词', '款式词', '功能词', '尺寸词', '材质词', '风格词']);

const BRAND_PREFIX = '品牌/';

function isBrandPart(part) {
  return part.startsWith(BRAND_PREFIX) || BRAND_WORDS.includes(part.replace(/^品牌\//u, ''));
}

/**
 * 多选字段的切片。
 *
 * 读回形态实测有两种：数组（每项是 `{text}` 对象）与已用「、」拼好的字符串。
 * 只认一种就会在另一种上静默产出空标签 —— 而「标签为空」在这个判定里直接等于「低」，
 * 也就是一个读回形态的差异会整批改掉结论，所以两种都得认。
 */
export function labelParts(value) {
  if (Array.isArray(value)) return value.map((item) => readbackText(item)).filter(Boolean);
  return readbackText(value).split(/[、,，;；\n]+/u).map((item) => item.trim()).filter(Boolean);
}

/** 把一条飞书记录折成判定所需的特征。纯函数，便于用固定样本做判据。 */
export function contentHeatFeatures(record) {
  const fields = record?.fields ?? {};
  const word = readbackText(fields['搜索词']) || readbackText(fields['原始关键词']);
  const category = readbackText(fields['关键词分类']);
  const searchHeat = readbackText(fields['搜索热度']);
  const tradeHeat = readbackText(fields['交易热度']);
  const parts = labelParts(fields['细分标签']);
  const brandParts = parts.filter(isBrandPart);
  const nonBrandParts = parts.filter((part) => !isBrandPart(part));
  return {
    recordId: record?.record_id ?? '',
    word,
    category,
    searchHeat,
    tradeHeat,
    labels: readbackText(fields['细分标签']),
    parts,
    brandParts,
    nonBrandParts,
    navigation: NAVIGATION_PATTERN.test(word),
    brandOnly: category === '品牌词' || (parts.length > 0 && nonBrandParts.length === 0),
    hasAttribute: nonBrandParts.length > 0 || ATTRIBUTE_CATEGORIES.includes(category),
    signalHigh: searchHeat === '高' || tradeHeat === '高',
    signalUnknown: !searchHeat || !tradeHeat || searchHeat === '待核验' || tradeHeat === '待核验',
  };
}

/**
 * 判定。顺序即优先级，逐条对应提示词原文（见文件头）。
 *
 * 「信号未知」放在低的两条捷径之后、高/中之前：导航词与纯品牌即使信号读不到也能确定是低，
 * 而高/中两句都建立在「信号为高 / 信号一般」之上 —— 信号读不到就不能假装知道。
 */
export function judgeContentHeat(features) {
  if (features.navigation) return '低';
  if (features.brandOnly) return '低';
  if (features.signalUnknown) return '待核验';
  if (features.hasAttribute && features.signalHigh) return '高';
  if (features.hasAttribute) return '中';
  return '低';
}

/** 判定的原因码。收据里给原因，读者才不用反推为什么这一行是低。 */
export function contentHeatReason(features) {
  if (features.navigation) return '纯店铺导航';
  if (features.brandOnly) return '纯品牌';
  if (features.signalUnknown) return '信号未知';
  if (features.hasAttribute && features.signalHigh) return '有属性且信号为高';
  if (features.hasAttribute) return '有属性但信号一般';
  return '无属性可依（信息不足/过度宽泛/信号双弱）';
}

function histogram(values) {
  const counts = new Map();
  for (const value of values) counts.set(value || '(空)', (counts.get(value || '(空)') ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1]));
}

/**
 * 由飞书记录产出写入器认识的产物（`CONTENT_HEAT_ARTIFACT_STATUS`）。
 *
 * 三条 fail-closed：
 *   - 判定前先验提示词指纹；指纹不对就**不出产物**，而不是照旧判完再让人去发现口径变了；
 *   - 每一行都必须有 `record_id`，缺一个就抛（写入器是按 record_id 对齐的，缺行等于错位）；
 *   - 关键词为空的行抛错（判定的输入就是关键词，没有它判出来的是空气）。
 */
export function buildContentHeatArtifact({
  tableId,
  tableName,
  appToken,
  records,
  judgedAt = new Date().toISOString(),
  prompt = CONTENT_HEAT_PROMPT,
} = {}) {
  if (!tableId || !tableName || !appToken) throw new Error('Content heat artifact requires table identity');
  if (!Array.isArray(records) || records.length === 0) throw new Error('Content heat artifact requires records');
  const binding = assertPromptBinding(prompt);
  if (!binding.ok) {
    throw new Error(`Content heat prompt changed (expected ${binding.expected}, actual ${binding.actual}); re-pin the judge before judging`);
  }
  const values = records.map((record, index) => {
    if (!record?.record_id) throw new Error(`Record ${index + 1} has no record_id`);
    const features = contentHeatFeatures(record);
    if (!features.word) throw new Error(`Record ${record.record_id} has no keyword`);
    return {
      record_id: record.record_id,
      搜索词: features.word,
      [CONTENT_HEAT_FIELD]: judgeContentHeat(features),
      reason: contentHeatReason(features),
    };
  });
  return {
    status: CONTENT_HEAT_ARTIFACT_STATUS,
    provider: 'local-rule',
    judgeVersion: CONTENT_HEAT_JUDGE_VERSION,
    promptSource: 'runtime/weekly-local-analysis.mjs ANALYSIS_REGISTRY.prompts.contentHeat',
    promptDigest: promptDigest(prompt),
    judgedAt,
    tableId,
    tableName,
    appToken,
    recordCount: values.length,
    valueDomain: ['低', '中', '高', '待核验'],
    distribution: histogram(values.map((item) => item[CONTENT_HEAT_FIELD])),
    reasonDistribution: histogram(values.map((item) => item.reason)),
    values,
  };
}

/** 人工可读的 CSV（收窄到写入器实际需要的列 + 原因，便于抽查）。 */
export function buildContentHeatCsv(values) {
  const cell = (text) => (/[,"\r\n]/u.test(text) ? `"${String(text).replaceAll('"', '""')}"` : String(text));
  const lines = ['关键词编号,搜索词,内容热度,判定原因'];
  for (const item of values) {
    lines.push([item.record_id, item.搜索词, item[CONTENT_HEAT_FIELD], item.reason].map(cell).join(','));
  }
  return `${lines.join('\n')}\n`;
}
