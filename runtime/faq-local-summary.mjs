import { createHash } from 'node:crypto';

import { FAQ_ANALYSIS_VERSION, FAQ_LABEL_CATALOG, classifyFaqText, normalizeFaqText } from './faq-text-analysis.mjs';
import { FAQ_OPERATOR_CONTENT_VERSION } from './faq-operator-content.mjs';

export const FAQ_DEDUP_VERSION = 'faq-dedup-v1.0.0';
export const FAQ_SUMMARY_VERSION = 'faq-summary-v3.0.0';
export const FAQ_REPRESENTATIVE_SELECTION_VERSION = 'faq-representative-v1.0.0';
export { FAQ_OPERATOR_CONTENT_VERSION };
export const FAQ_PAIN_DESCRIPTION_VERSION = 'faq-pain-description-v2.0.0';

const PAIN_DESCRIPTIONS = Object.freeze({
  '重量大/搬运困难': '用户反馈浴缸重量较大，搬运、上楼或安装过程存在困难。',
  '不包安装/安装费贵': '用户反馈商品不含安装服务，或需要额外支付安装费用。',
  '异味问题': '用户反馈商品存在异味，影响到货后的使用体验。',
  '尺寸不符/偏大偏小': '用户反馈商品尺寸与预期或使用空间不匹配，影响安装或使用。',
  '排水/漏水问题': '用户反馈排水不畅、积水或出现漏水等使用问题。',
  '品质瑕疵(划痕/裂纹/破损)': '用户反馈商品存在划痕、裂纹、破损或其他到货质量瑕疵。',
  '物流/运输问题': '用户反馈配送、运输、搬运或送货入户环节存在问题。',
  '售后差/不处理': '用户反馈售后响应不足、处理不及时或问题解决不充分。',
  '价格/保价问题': '用户反馈价格、活动或保价相关体验不符合预期。',
  '清洁困难': '用户反馈商品清洁、擦拭或日常打理较为困难。',
  '深度不够/太浅': '用户反馈浴缸深度不足，影响浸泡或使用体验。',
});

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'text')) return text(value.text);
  return String(value ?? '').trim();
}

export function stableDedupKey({ productId, sourceType, stableSourceId, buyerId, reviewTime, sku, rawContent }) {
  const id = text(stableSourceId);
  if (id) return { key: `id:${id}`, method: 'stable-source-id' };
  const stable = [productId, sourceType, buyerId, reviewTime, sku].map(text);
  if (stable.slice(2).some(Boolean)) return { key: `fields:${stable.join('|')}`, method: 'stable-field-combination' };
  const normalized = normalizeFaqText(rawContent);
  if (!text(productId) || !text(sourceType) || !normalized) throw new Error('productId, sourceType and rawContent are required for dedup key');
  return { key: `text:${createHash('sha256').update(`${productId}\n${sourceType}\n${normalized}`).digest('hex')}`, method: 'normalized-content-fallback' };
}

export function classifyAndDeduplicate(records) {
  const seen = new Map();
  const duplicates = [];
  for (const input of records ?? []) {
    const record = input.fields ? { ...input.fields, ...input } : input;
    const classification = classifyFaqText(record.原始内容 ?? record.rawContent, { sourceType: record.来源类型 ?? record.sourceType });
    if (!classification.isValid) continue;
    const dedup = stableDedupKey({
      productId: record.商品ID ?? record.productId,
      sourceType: record.来源类型 ?? record.sourceType,
      stableSourceId: record.评价ID ?? record.reviewId,
      buyerId: record.买家ID ?? record.buyerId,
      reviewTime: record.评价时间 ?? record.reviewTime,
      sku: record.SKU ?? record.sku,
      rawContent: record.原始内容 ?? record.rawContent,
    });
    for (const label of classification.labels) {
      const dedupKey = `${dedup.key}|label:${label}`;
      const classified = { ...input, labels: [label], painLabels: classification.painLabels.includes(label) ? [label] : [], isPain: classification.painLabels.includes(label), classificationVersion: FAQ_ANALYSIS_VERSION, crossWeekDedupKey: dedup.key, sourceDedupKey: dedup.key, dedupMethod: dedup.method };
      if (seen.has(dedupKey)) {
        duplicates.push({ crossWeekDedupKey: dedup.key, duplicate: classified });
        continue;
      }
      seen.set(dedupKey, classified);
    }
  }
  return { records: [...seen.values()], duplicates };
}

function representativeFor(records, label) {
  const candidates = records.filter((record) => {
    const labels = record.labels ?? classifyFaqText(record.fields?.原始内容 ?? record.rawContent, { sourceType: record.fields?.来源类型 ?? record.sourceType }).labels;
    return labels.includes(label);
  }).map((record) => {
    const fields = record.fields ?? record;
    const raw = fields.原始内容 ?? record.rawContent;
    const normalized = normalizeFaqText(raw);
    return {
      raw: text(raw),
      normalized,
      sourceKey: text(fields.来源记录唯一键 ?? record.sourceRecordKey ?? record.sourceDedupKey),
    };
  }).filter((candidate) => candidate.raw && candidate.normalized);
  const frequency = new Map();
  for (const candidate of candidates) frequency.set(candidate.normalized, (frequency.get(candidate.normalized) ?? 0) + 1);
  candidates.sort((left, right) => (frequency.get(right.normalized) - frequency.get(left.normalized))
    || (right.normalized.length - left.normalized.length)
    || left.sourceKey.localeCompare(right.sourceKey, 'zh-CN')
    || left.normalized.localeCompare(right.normalized, 'zh-CN'));
  const selected = candidates[0];
  return selected ? {
    raw: selected.raw,
    sourceKey: selected.sourceKey,
    rawHash: createHash('sha256').update(selected.raw).digest('hex'),
    candidateCount: candidates.length,
  } : null;
}

function summaryRows(records, { denominator, includeShare, operatorContent }) {
  const counts = new Map(FAQ_LABEL_CATALOG.map(({ label, isPainPoint }) => [label, { label, isPainPoint, count: 0 }]));
  for (const record of records) {
    const labels = record.labels ?? classifyFaqText(record.fields?.原始内容 ?? record.rawContent, { sourceType: record.fields?.来源类型 ?? record.sourceType }).labels;
    for (const label of new Set(labels)) {
      const row = counts.get(label);
      if (row) row.count += 1;
    }
  }
  return [...counts.values()].map(({ label, isPainPoint, count }) => {
    const representative = count ? representativeFor(records, label) : null;
    const content = operatorContent?.content?.[label] ?? {};
    return {
      分类标签: label,
      是否痛点: isPainPoint ? '是' : '否',
      出现次数: count,
      ...(includeShare ? { 占比: denominator ? count / denominator : 0 } : {}),
      痛点描述: operatorContent ? String(content.痛点描述 ?? '').trim() : (isPainPoint && count ? PAIN_DESCRIPTIONS[label] : ''),
      典型问题: operatorContent ? String(content.典型问题 ?? '').trim() : '',
      典型用户原话: operatorContent ? String(content.典型用户原话 ?? '').trim() : (representative?.raw ?? ''),
      ...(representative ? { representativeEvidence: { sourceKey: representative.sourceKey, rawHash: representative.rawHash, candidateCount: representative.candidateCount } } : {}),
    };
  });
}

export function buildSummary(records, { period = '', includeShare = false, scope = 'weekly', operatorContent } = {}) {
  const validRecords = (records ?? []).filter((record) => record.isValid !== false);
  const denominator = validRecords.length;
  return {
    scope,
    period,
    analysisVersion: FAQ_ANALYSIS_VERSION,
    dedupVersion: FAQ_DEDUP_VERSION,
    summaryVersion: FAQ_SUMMARY_VERSION,
    representativeSelectionVersion: FAQ_REPRESENTATIVE_SELECTION_VERSION,
    painDescriptionVersion: FAQ_PAIN_DESCRIPTION_VERSION,
    operatorContentVersion: operatorContent?.version ?? null,
    operatorContentSource: operatorContent?.source ?? null,
    denominator,
    sourceRecordCount: (records ?? []).length,
    deduplicatedRecordCount: validRecords.length,
    rows: summaryRows(validRecords, { denominator, includeShare, operatorContent }),
  };
}

export function buildCumulativeSummary(periods, { operatorContent } = {}) {
  const all = [];
  for (const period of periods ?? []) {
    const result = classifyAndDeduplicate(period.records ?? []);
    all.push(...result.records);
  }
  const deduped = classifyAndDeduplicate(all).records;
  return buildSummary(deduped, { scope: 'all-valid-weeks', includeShare: true, operatorContent });
}
