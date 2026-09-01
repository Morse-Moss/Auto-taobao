import test from 'node:test';
import assert from 'node:assert/strict';

import { FAQ_HUMAN_REVIEW_VERSION, mergeFaqReviewResults, validateHumanDecision } from './faq-human-review.mjs';
import { aiTaskId } from './faq-ai-review.mjs';

const task = {
  sourceKey: 'period|product|评论|hash|1',
  label: '清洁困难',
  inputs: { rawContent: '弯道接口处直接掉下来，房间木板一整个被泡发' },
};
task.taskId = aiTaskId({ fields: { 来源记录唯一键: task.sourceKey, 分类标签: task.label } });
const record = {
  recordId: 'rec-1',
  fields: {
    来源记录唯一键: task.sourceKey,
    分类标签: task.label,
    原始内容: task.inputs.rawContent,
    商品标题: '浴缸',
    是否痛点: '需人工核验',
    痛点判定依据: '清洁',
    痛点判定置信度: '低',
  },
  labels: [task.label],
};
const result = {
  taskId: task.taskId,
  finalJudgment: '需人工核验',
  needsHumanReview: true,
  qualityGate: 'MANUAL_REVIEW',
  aiJudgment: '需人工核验',
  aiEvidence: '',
  aiReason: '',
};

function decision(overrides = {}) {
  return {
    taskId: task.taskId,
    sourceKey: task.sourceKey,
    label: task.label,
    rawContent: task.inputs.rawContent,
    finalJudgment: '否',
    finalEvidence: '弯道接口处直接掉下来',
    finalReason: '候选主题不是清洁困难',
    ...overrides,
  };
}

test('human decisions validate identity and raw evidence', () => {
  assert.equal(validateHumanDecision(task, decision()).finalJudgment, '否');
  assert.throws(() => validateHumanDecision(task, decision({ rawContent: 'changed' })), /rawContent mismatch/u);
  assert.throws(() => validateHumanDecision(task, decision({ finalEvidence: '不是原文' })), /raw-content substring/u);
});

test('merge preserves original fields and records reviewed supplemental topics', () => {
  const merged = mergeFaqReviewResults({
    period: 'period',
    classifiedRecords: [record],
    tasks: [task],
    results: [result],
    decisions: [decision({
      finalReason: '安全事故需要业务升级',
      keepHumanReview: true,
      escalation: '安全事故和财产损失',
      supplementalTopics: [{ label: '龙头/配件故障与安全风险', judgment: '是', evidence: '弯道接口处直接掉下来', reason: '配件故障', publication: 'LOCAL_ONLY' }],
    })],
  });
  assert.equal(merged.version, FAQ_HUMAN_REVIEW_VERSION);
  assert.equal(merged.records[0].fields.商品标题, '浴缸');
  assert.equal(merged.records[0].fields.是否痛点, '否');
  assert.equal(merged.records[0].judgmentSource, 'human');
  assert.equal(merged.topicCorrections[0].topicLabel, '龙头/配件故障与安全风险');
  const supplemental = merged.records.find((item) => item.fields.分类标签 === '龙头/配件故障与安全风险');
  assert.equal(supplemental.fields.是否痛点, '是');
  assert.equal(supplemental.fields.痛点判定依据, '弯道接口处直接掉下来');
  assert.equal(merged.records.every((item) => item.fields.补充主题 === undefined), true);
  assert.equal(merged.humanQueueCount, 1);
  assert.equal(merged.publishable, false);
});

test('unresolved supplemental topics block publication as formal source-topic rows', () => {
  const merged = mergeFaqReviewResults({
    period: 'period',
    classifiedRecords: [record],
    tasks: [task],
    results: [result],
    decisions: [decision({
      supplementalTopics: [{ label: '材质/塑料感', judgment: '需人工核验', evidence: '弯道接口处直接掉下来', reason: '结论尚未收敛', publication: 'DETAIL_FIELD' }],
    })],
  });
  const supplemental = merged.records.find((item) => item.fields.分类标签 === '材质/塑料感');
  assert.equal(supplemental.fields.是否痛点, '需人工核验');
  assert.equal(merged.humanQueue.some((item) => item.label === '材质/塑料感' && item.reviewStatus === 'SUPPLEMENTAL_TOPIC_PENDING'), true);
  assert.equal(merged.publishable, false);
});

test('auto accepted result is merged without requiring a decision', () => {
  const accepted = { ...result, finalJudgment: '是', needsHumanReview: false, qualityGate: 'AUTO_ACCEPTED', judgmentSource: 'ai', aiConfidence: '中', aiEvidence: '弯道接口处直接掉下来' };
  const merged = mergeFaqReviewResults({ period: 'period', classifiedRecords: [record], tasks: [task], results: [accepted], decisions: [] });
  assert.equal(merged.records[0].fields.是否痛点, '是');
  assert.equal(merged.records[0].judgmentSource, 'ai');
  assert.equal(merged.humanQueueCount, 0);
});

test('reviewed supplemental topics survive when rules no longer expand the source label', () => {
  const source = {
    ...record,
    fields: {
      ...record.fields,
      分类标签: '好评-外观颜值',
      是否痛点: '否',
      痛点判定依据: '好看',
      痛点判定置信度: '高',
    },
    labels: ['好评-外观颜值'],
  };
  const merged = mergeFaqReviewResults({
    period: 'period',
    classifiedRecords: [source],
    tasks: [],
    results: [],
    decisions: [decision({
      taskId: aiTaskId({ fields: { 来源记录唯一键: task.sourceKey, 分类标签: task.label } }),
      supplementalTopics: [{ label: '龙头/配件故障与安全风险', judgment: '是', evidence: '弯道接口处直接掉下来', reason: '配件故障', publication: 'DETAIL_FIELD' }],
    })],
  });
  const restored = merged.records.find((item) => item.fields.分类标签 === task.label);
  const supplemental = merged.records.find((item) => item.fields.分类标签 === '龙头/配件故障与安全风险');
  assert.equal(restored.fields.是否痛点, '否');
  assert.equal(supplemental.fields.是否痛点, '是');
  assert.equal(supplemental.fields.痛点判定依据, '弯道接口处直接掉下来');
  assert.equal(merged.humanQueueCount, 0);
});
