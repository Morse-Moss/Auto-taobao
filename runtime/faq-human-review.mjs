import { createHash } from 'node:crypto';

import { FAQ_ANALYSIS_VERSION, PAIN_JUDGMENT_OPTIONS, assertUniqueSourceTopics } from './faq-text-analysis.mjs';

export const FAQ_HUMAN_REVIEW_VERSION = 'faq-human-review-v2.0.0';
export const FAQ_HUMAN_REVIEW_SOURCE = 'https://rcndesfqro3x.feishu.cn/wiki/Rf1rw9fWMies0jk8GAdcUF21ngh';

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(',');
  if (value && typeof value === 'object' && Object.hasOwn(value, 'text')) return text(value.text);
  return String(value ?? '').trim();
}

function fieldsOf(record) {
  return record?.fields ?? record ?? {};
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function normalizeReviewContent(value) {
  return text(value).normalize('NFKC').replace(/[\r\n\t ]+/gu, ' ').trim();
}

function reviewIdentityForRecord(record) {
  const fields = fieldsOf(record);
  const sourceKey = text(fields.来源记录唯一键);
  const label = text(fields.分类标签 || fields.高频问题或关键词);
  const rawContent = normalizeReviewContent(fields.原始内容);
  return {
    taskId: `faq-ai-${digest(`${sourceKey}\n${label}`).slice(0, 24)}`,
    sourceKey,
    label,
    inputs: { rawContent },
  };
}

function taskForRecord(record, tasksById) {
  const identity = reviewIdentityForRecord(record);
  return tasksById.get(identity.taskId) ?? identity;
}

function validateEvidence(task, evidence) {
  const value = text(evidence);
  if (!value || !task?.inputs?.rawContent?.includes(value)) throw new Error(`Human decision evidence is not a raw-content substring: ${task?.taskId ?? 'unknown'}`);
  return value;
}

export function validateHumanDecision(task, decision) {
  if (!task) throw new Error('Human decision references an unknown AI task');
  if (text(decision?.taskId) !== task.taskId) throw new Error(`Human decision taskId mismatch: ${task.taskId}`);
  if (text(decision?.sourceKey) !== task.sourceKey) throw new Error(`Human decision sourceKey mismatch: ${task.taskId}`);
  if (text(decision?.label) !== task.label) throw new Error(`Human decision label mismatch: ${task.taskId}`);
  if (normalizeReviewContent(decision?.rawContent) !== normalizeReviewContent(task.inputs.rawContent)) throw new Error(`Human decision rawContent mismatch: ${task.taskId}`);
  if (!PAIN_JUDGMENT_OPTIONS.includes(text(decision?.finalJudgment))) throw new Error(`Human decision has invalid final judgment: ${task.taskId}`);
  const finalEvidence = validateEvidence(task, decision.finalEvidence);
  const supplementalTopics = (decision?.supplementalTopics ?? []).map((topic) => {
    const topicLabel = text(topic.label);
    if (!topicLabel) throw new Error(`Human decision supplemental topic is empty: ${task.taskId}`);
    const judgment = text(topic.judgment || '需人工核验');
    if (!PAIN_JUDGMENT_OPTIONS.includes(judgment)) throw new Error(`Human decision supplemental judgment is invalid: ${task.taskId}/${topicLabel}`);
    return {
      label: topicLabel,
      judgment,
      evidence: validateEvidence(task, topic.evidence),
      reason: text(topic.reason),
      publication: text(topic.publication || 'LOCAL_ONLY'),
    };
  });
  return {
    taskId: task.taskId,
    sourceKey: task.sourceKey,
    label: task.label,
    finalJudgment: text(decision.finalJudgment),
    finalEvidence,
    finalReason: text(decision.finalReason),
    supplementalTopics,
    keepHumanReview: Boolean(decision.keepHumanReview),
    escalation: text(decision.escalation),
    reviewedBy: text(decision.reviewedBy),
    reviewedAt: text(decision.reviewedAt),
    source: text(decision.source || FAQ_HUMAN_REVIEW_SOURCE),
  };
}

function updateRecord(record, result, decision) {
  const fields = { ...fieldsOf(record) };
  const judgment = decision?.finalJudgment ?? result?.finalJudgment ?? fields.是否痛点;
  const evidence = decision?.finalEvidence ?? result?.aiEvidence ?? result?.ruleEvidence ?? fields.痛点判定依据;
  const confidence = decision ? '高' : result?.aiConfidence ?? fields.痛点判定置信度;
  delete fields.补充主题;
  fields.是否痛点 = judgment;
  fields.痛点判定依据 = evidence;
  fields.痛点判定置信度 = confidence;
  fields.分析版本 = FAQ_ANALYSIS_VERSION;
  return {
    ...record,
    fields,
    labels: [fields.分类标签],
    topicLabels: [fields.分类标签],
    painJudgment: judgment,
    painEvidence: evidence,
    painConfidence: confidence,
    painLabels: judgment === '是' ? [fields.分类标签] : [],
    isPain: judgment === '是',
    finalJudgment: judgment,
    judgmentSource: decision ? 'human' : result?.judgmentSource ?? 'rule',
    humanReviewTaskId: decision?.taskId ?? null,
    humanReviewSource: decision?.source ?? null,
    humanReviewReason: decision?.finalReason ?? null,
  };
}

function sourceTopicKey(sourceKey, label) {
  return `${sourceKey}\n${label}`;
}

function supplementalDecision(decision, topic) {
  return {
    ...decision,
    label: topic.label,
    finalJudgment: topic.judgment,
    finalEvidence: topic.evidence,
    finalReason: topic.reason,
    supplementalTopics: [],
  };
}

export function mergeFaqReviewResults({ classifiedRecords, tasks, results, decisions, period }) {
  assertUniqueSourceTopics(classifiedRecords, 'Classified FAQ records');
  const tasksById = new Map((tasks ?? []).map((task) => [task.taskId, task]));
  const resultsById = new Map((results ?? []).map((result) => [result.taskId, result]));
  const decisionsById = new Map();
  const recordsByTaskId = new Map((classifiedRecords ?? []).map((record) => {
    const identity = reviewIdentityForRecord(record);
    return [identity.taskId, identity];
  }));
  const sourceRecordsByKey = new Map((classifiedRecords ?? []).map((record) => {
    const identity = reviewIdentityForRecord(record);
    return [identity.sourceKey, identity];
  }));
  for (const rawDecision of decisions ?? []) {
    let task = tasksById.get(text(rawDecision.taskId)) ?? recordsByTaskId.get(text(rawDecision.taskId));
    if (!task) {
      const sourceRecord = sourceRecordsByKey.get(text(rawDecision.sourceKey));
      if (sourceRecord?.inputs.rawContent === normalizeReviewContent(rawDecision.rawContent)) {
        task = {
          ...sourceRecord,
          taskId: `faq-ai-${digest(`${sourceRecord.sourceKey}\n${text(rawDecision.label)}`).slice(0, 24)}`,
          label: text(rawDecision.label),
        };
      }
    }
    const decision = validateHumanDecision(task, rawDecision);
    if (decisionsById.has(decision.taskId)) throw new Error(`Duplicate human decision: ${decision.taskId}`);
    decisionsById.set(decision.taskId, decision);
  }
  const records = (classifiedRecords ?? []).map((record) => {
    const task = taskForRecord(record, tasksById);
    const result = resultsById.get(task.taskId);
    const decision = decisionsById.get(task.taskId);
    if (!result && !decision) return { ...record, fields: { ...fieldsOf(record) } };
    return updateRecord(record, result, decision);
  });
  const sourceRecords = new Map();
  for (const record of classifiedRecords ?? []) {
    const sourceKey = text(fieldsOf(record).来源记录唯一键);
    if (!sourceRecords.has(sourceKey)) sourceRecords.set(sourceKey, record);
  }
  const recordIndex = new Map(records.map((record, index) => [sourceTopicKey(text(fieldsOf(record).来源记录唯一键), text(fieldsOf(record).分类标签)), index]));
  for (const decision of decisionsById.values()) {
    const sourceRecord = sourceRecords.get(decision.sourceKey);
    if (!sourceRecord) throw new Error(`Human decision has no classified source record: ${decision.taskId}`);
    const topics = [{ label: decision.label, judgment: decision.finalJudgment, evidence: decision.finalEvidence, reason: decision.finalReason }, ...decision.supplementalTopics];
    for (const topic of topics) {
      const key = sourceTopicKey(decision.sourceKey, topic.label);
      const topicDecision = supplementalDecision(decision, topic);
      const existingIndex = recordIndex.get(key);
      if (existingIndex !== undefined) {
        const existing = records[existingIndex];
        const existingTaskId = reviewIdentityForRecord(existing).taskId;
        const explicitDecision = decisionsById.get(existingTaskId);
        if (explicitDecision && explicitDecision.taskId !== decision.taskId
          && (explicitDecision.finalJudgment !== topic.judgment || explicitDecision.finalEvidence !== topic.evidence)) {
          throw new Error(`Conflicting human decisions for source-topic: ${decision.sourceKey}/${topic.label}`);
        }
        if (!explicitDecision || explicitDecision.taskId === decision.taskId) records[existingIndex] = updateRecord(existing, null, topicDecision);
        continue;
      }
      const fields = { ...fieldsOf(sourceRecord), 分类标签: topic.label, 高频问题或关键词: topic.label };
      records.push(updateRecord({ ...sourceRecord, fields }, null, topicDecision));
      recordIndex.set(key, records.length - 1);
    }
  }
  assertUniqueSourceTopics(records, 'Final FAQ records');
  const unresolved = [];
  for (const task of tasks ?? []) {
    const result = resultsById.get(task.taskId);
    const decision = decisionsById.get(task.taskId);
    if (decision?.keepHumanReview || (!decision && (result?.needsHumanReview || result?.qualityGate !== 'AUTO_ACCEPTED'))) {
      unresolved.push({
        taskId: task.taskId,
        sourceKey: task.sourceKey,
        label: task.label,
        rawContent: task.inputs.rawContent,
        ruleEvidence: task.inputs.ruleEvidence,
        aiJudgment: result?.aiJudgment ?? null,
        aiEvidence: result?.aiEvidence ?? '',
        aiReason: result?.aiReason ?? '',
        reason: decision?.escalation || result?.qualityIssues?.join('; ') || 'human review required',
        reviewStatus: decision ? 'OPS_CONFIRMED_ESCALATION' : result?.reviewStatus ?? 'PENDING',
      });
    }
  }
  const topicCorrections = [...decisionsById.values()].flatMap((decision) => decision.supplementalTopics.map((topic) => ({
    period,
    taskId: decision.taskId,
    sourceKey: decision.sourceKey,
    sourceLabel: decision.label,
    topicLabel: topic.label,
    judgment: topic.judgment,
    evidence: topic.evidence,
    reason: topic.reason,
    publication: topic.publication,
    source: decision.source,
  })));
  for (const correction of topicCorrections.filter((item) => item.judgment === '需人工核验')) {
    unresolved.push({
      taskId: correction.taskId,
      sourceKey: correction.sourceKey,
      label: correction.topicLabel,
      rawContent: normalizeReviewContent(fieldsOf(sourceRecords.get(correction.sourceKey)).原始内容),
      ruleEvidence: '',
      aiJudgment: null,
      aiEvidence: '',
      aiReason: '',
      reason: correction.reason || 'supplemental topic requires human review',
      reviewStatus: 'SUPPLEMENTAL_TOPIC_PENDING',
    });
  }
  return {
    version: FAQ_HUMAN_REVIEW_VERSION,
    period,
    analysisVersion: FAQ_ANALYSIS_VERSION,
    records,
    decisions: [...decisionsById.values()],
    topicCorrections,
    humanQueue: unresolved,
    taskCount: (tasks ?? []).length,
    decisionCount: decisionsById.size,
    humanQueueCount: unresolved.length,
    sourceTopicCount: records.length,
    publishable: unresolved.length === 0 && topicCorrections.every((item) => ['EXISTING_LABEL_ONLY', 'DETAIL_FIELD'].includes(item.publication)),
  };
}
