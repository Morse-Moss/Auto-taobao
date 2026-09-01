import assert from 'node:assert/strict';
import test from 'node:test';

import { FAQ_AI_PROMPT_VERSION, buildAiReviewArtifact, buildAiReviewTasks, parseAiResults, validateAiResult } from './faq-ai-review.mjs';

test('AI tasks preserve one candidate topic and full review context', () => {
  const [task] = buildAiReviewTasks([{
    fields: {
      来源记录唯一键: 'source-1', 商品ID: 'p1', 商品标题: '浴缸', 来源类型: '评论', 原始内容: '客服回复很快，但是物流放在门口',
      分类标签: '物流/运输问题', 是否痛点: '需人工核验', 痛点判定依据: '物流',
    }, labels: ['物流/运输问题', '好评-客服服务'],
  }]);
  assert.equal(task.label, '物流/运输问题');
  assert.equal(task.inputs.rawContent, '客服回复很快,但是物流放在门口');
  assert.deepEqual(task.inputs.otherLabels, ['好评-客服服务']);
  assert.match(task.prompt, /只复核输入任务指定的候选主题/u);
  assert.equal(task.aiPromptVersion, FAQ_AI_PROMPT_VERSION);
});

test('AI result requires exact identity and raw evidence', () => {
  const [task] = buildAiReviewTasks([{ fields: { 来源记录唯一键: 'source-1', 原始内容: '物流迅速', 分类标签: '物流/运输问题', 是否痛点: '需人工核验', 痛点判定依据: '物流' } }]);
  const result = validateAiResult(task, { taskId: task.taskId, sourceKey: 'source-1', label: '物流/运输问题', judgment: '否', confidence: '高', evidence: '物流迅速', reason: '明确正向物流体验' });
  assert.equal(result.finalJudgment, '否');
  assert.equal(result.qualityGate, 'AUTO_ACCEPTED');
  assert.equal(result.needsHumanReview, false);
  const downgraded = validateAiResult(task, { taskId: task.taskId, sourceKey: 'source-1', label: '物流/运输问题', judgment: '是', confidence: '高', evidence: '很快', reason: '负面' });
  assert.equal(downgraded.finalJudgment, '需人工核验');
  assert.equal(downgraded.qualityIssues[0], 'evidence is not a raw-content substring');
});

test('low confidence and unresolved judgment enter human queue', () => {
  const [task] = buildAiReviewTasks([{ fields: { 来源记录唯一键: 'source-1', 原始内容: '味道', 分类标签: '异味问题', 是否痛点: '需人工核验', 痛点判定依据: '味道' } }]);
  const [result] = parseAiResults([task], [{ taskId: task.taskId, sourceKey: task.sourceKey, label: task.label, judgment: '需人工核验', confidence: '低', evidence: '味道', reason: '上下文不足' }]);
  const artifact = buildAiReviewArtifact({ period: '2026-08-23_2026-08-29', classifiedSnapshot: { path: 'classified-records.jsonl', sha256: 'a'.repeat(64) }, tasks: [task], results: [result], provider: 'test' });
  assert.equal(artifact.autoAccepted, 0);
  assert.equal(artifact.needsHumanReview, 1);
  assert.equal(artifact.humanQueue[0].label, '异味问题');
});

test('invalid AI evidence is downgraded to manual review without aborting the batch', () => {
  const [task] = buildAiReviewTasks([{ fields: { 来源记录唯一键: 'source-1', 原始内容: '物流很快', 分类标签: '物流/运输问题', 是否痛点: '需人工核验', 痛点判定依据: '物流' } }]);
  const [result] = parseAiResults([task], [{ taskId: task.taskId, sourceKey: task.sourceKey, label: task.label, judgment: '否', confidence: '高', evidence: '物流很慢', reason: '模型证据错误' }]);
  assert.equal(result.finalJudgment, '需人工核验');
  assert.equal(result.qualityIssues[0], 'evidence is not a raw-content substring');
});
