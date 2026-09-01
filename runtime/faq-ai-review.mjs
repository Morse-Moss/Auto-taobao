import { createHash } from 'node:crypto';

import { FAQ_ANALYSIS_VERSION, PAIN_JUDGMENT_OPTIONS, classifyFaqText, normalizeFaqText } from './faq-text-analysis.mjs';

export const FAQ_AI_REVIEW_VERSION = 'faq-ai-review-v1.1.0';
export const FAQ_AI_PROMPT_VERSION = 'faq-ai-prompt-v1.0.0';
export const FAQ_AI_CONFIDENCE_OPTIONS = ['高', '中', '低'];

export const FAQ_AI_REVIEW_PROMPT = `你是浴缸用户评价的主题痛点复核器。你只复核输入任务指定的候选主题，不重新分类，不遗漏任务，不调用工具，不补造评论中不存在的信息。

判断标准：
1. “是”：候选主题在评论中有明确负面体验、实际障碍、额外费用、风险或未满足预期。
2. “否”：候选主题只有明确正向表达、明确否定问题，或评论只表示尚未安装/尚未使用/等待后续反馈而没有当前痛点证据。
3. “需人工核验”：上下文不足、同主题正负冲突、未来状态与实际体验冲突、隐含语义/讽刺、或无法确认实际影响。
4. 必须按候选主题独立判断。一条评论的其他主题不能改变本任务主题的结论。
5. evidence 必须是原始评论中的连续原文子串；没有可靠证据时返回空字符串并将 judgment 设为“需人工核验”。
6. judgment 为“是”时 evidence 必须直接支持负面体验；judgment 为“否”时 evidence 必须直接支持正向、否定问题或尚未发生实际体验；无法满足时返回“需人工核验”。
7. confidence 只有在证据直接、语义明确且没有冲突时才能为“高”；需要跨句理解但仍有明确结论时为“中”；不确定时为“低”。

只返回 JSON 数组。每个任务恰好返回一个对象，字段只能是 taskId、sourceKey、label、judgment、confidence、evidence、reason。不要返回 Markdown、解释文字或额外字段。`;

function plain(value) {
  if (Array.isArray(value)) return value.map(plain).filter(Boolean).join('、');
  if (value && typeof value === 'object') return plain(value.text ?? value.name ?? value.value);
  return String(value ?? '').trim();
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function fieldsOf(record) {
  return record?.fields ?? record ?? {};
}

export function aiTaskId(record) {
  const fields = fieldsOf(record);
  const sourceKey = plain(fields.来源记录唯一键);
  const label = plain(fields.分类标签 || fields.高频问题或关键词);
  if (!sourceKey || !label) throw new Error('AI task requires source key and label');
  return `faq-ai-${digest(`${sourceKey}\n${label}`).slice(0, 24)}`;
}

export function aiTaskFingerprint(task) {
  return digest(JSON.stringify({
    taskId: task.taskId,
    sourceKey: task.sourceKey,
    label: task.label,
    inputs: task.inputs,
    promptHash: task.promptHash,
    aiPromptVersion: task.aiPromptVersion,
  }));
}

export function buildAiReviewTasks(records) {
  const recordsBySource = new Map();
  for (const record of records ?? []) {
    const sourceKey = plain(fieldsOf(record).来源记录唯一键);
    if (sourceKey) recordsBySource.set(sourceKey, [...(recordsBySource.get(sourceKey) ?? []), record]);
  }
  return (records ?? []).filter((record) => plain(fieldsOf(record).是否痛点) === '需人工核验').map((record) => {
    const fields = fieldsOf(record);
    const sourceKey = plain(fields.来源记录唯一键);
    const label = plain(fields.分类标签 || fields.高频问题或关键词);
    const rawContent = normalizeFaqText(fields.原始内容);
    const taskId = aiTaskId(record);
    if (!rawContent) throw new Error(`AI task ${taskId} has empty raw content`);
    const sourceRecords = recordsBySource.get(sourceKey) ?? [];
    const otherLabels = [...new Set(sourceRecords.flatMap((item) => {
      const itemFields = fieldsOf(item);
      return [plain(itemFields.分类标签 || itemFields.高频问题或关键词), ...(Array.isArray(item.labels) ? item.labels : [])];
    }).filter((item) => item && item !== label))];
    const inputs = {
      sourceKey,
      productId: plain(fields.商品ID),
      productTitle: plain(fields.商品标题),
      sourceType: plain(fields.来源类型),
      candidateLabel: label,
      ruleJudgment: plain(fields.是否痛点),
      ruleEvidence: plain(fields.痛点判定依据),
      otherLabels,
      rawContent,
    };
    const task = {
      providerTaskId: taskId,
      taskId,
      sourceKey,
      label,
      fields: ['judgment', 'confidence', 'evidence', 'reason'],
      inputs,
      prompt: `${FAQ_AI_REVIEW_PROMPT}\n\nTASK:\n${JSON.stringify({ taskId, sourceKey, label, inputs })}`,
      promptHash: digest(FAQ_AI_REVIEW_PROMPT),
      analysisVersion: FAQ_ANALYSIS_VERSION,
      aiPromptVersion: FAQ_AI_PROMPT_VERSION,
    };
    return { ...task, fingerprint: aiTaskFingerprint(task) };
  });
}

function resultText(value) {
  return plain(value);
}

export function validateAiResult(task, item) {
  if (!item || resultText(item.taskId) !== task.taskId) throw new Error(`Invalid AI result taskId for ${task.taskId}`);
  if (resultText(item.sourceKey) !== task.sourceKey) throw new Error(`Invalid AI result sourceKey for ${task.taskId}`);
  if (resultText(item.label) !== task.label) throw new Error(`Invalid AI result label for ${task.taskId}`);
  const rawJudgment = resultText(item.judgment);
  const rawConfidence = resultText(item.confidence);
  const rawEvidence = resultText(item.evidence);
  const reason = resultText(item.reason);
  const judgment = PAIN_JUDGMENT_OPTIONS.includes(rawJudgment) ? rawJudgment : '需人工核验';
  const confidence = FAQ_AI_CONFIDENCE_OPTIONS.includes(rawConfidence) ? rawConfidence : '低';
  const evidenceIsValid = !rawEvidence || task.inputs.rawContent.includes(rawEvidence);
  const evidence = evidenceIsValid ? rawEvidence : '';
  const qualityIssues = [];
  if (!PAIN_JUDGMENT_OPTIONS.includes(rawJudgment)) qualityIssues.push('invalid judgment enum');
  if (!FAQ_AI_CONFIDENCE_OPTIONS.includes(rawConfidence)) qualityIssues.push('invalid confidence enum');
  if (!evidenceIsValid) qualityIssues.push('evidence is not a raw-content substring');
  const ruleClassification = classifyFaqText(task.inputs.rawContent, { sourceType: task.inputs.sourceType });
  const ruleJudgment = ruleClassification.judgmentByLabel?.[task.label] ?? task.inputs.ruleJudgment;
  const ruleEvidence = ruleClassification.evidenceByLabel?.[task.label] ?? '';
  const conflictsWithCertainRule = ['是', '否'].includes(ruleJudgment) && ruleJudgment !== judgment && ruleClassification.confidenceByLabel?.[task.label] === '高';
  const evidenceSupportsJudgment = judgment === '需人工核验'
    || (judgment === '是' && ruleJudgment !== '否')
    || (judgment === '否' && ruleJudgment !== '是');
  if (!evidence || !reason || confidence === '低' || judgment === '需人工核验' || conflictsWithCertainRule || !evidenceSupportsJudgment || qualityIssues.length) {
    return { taskId: task.taskId, sourceKey: task.sourceKey, label: task.label, aiJudgment: judgment, aiConfidence: confidence, aiEvidence: evidence, aiReason: reason, qualityIssues, ruleJudgment, ruleEvidence, finalJudgment: '需人工核验', judgmentSource: 'pending', needsHumanReview: true, qualityGate: 'MANUAL_REVIEW' };
  }
  return { taskId: task.taskId, sourceKey: task.sourceKey, label: task.label, aiJudgment: judgment, aiConfidence: confidence, aiEvidence: evidence, aiReason: reason, ruleJudgment, ruleEvidence, finalJudgment: judgment, judgmentSource: 'ai', needsHumanReview: false, qualityGate: 'AUTO_ACCEPTED' };
}

export function parseAiResults(tasks, output) {
  if (!Array.isArray(output) || output.length !== tasks.length) throw new Error('AI result count does not match tasks');
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const seen = new Set();
  const results = output.map((item) => {
    const task = byId.get(resultText(item?.taskId));
    if (!task || seen.has(task.taskId)) throw new Error(`Duplicate or unknown AI result: ${resultText(item?.taskId)}`);
    seen.add(task.taskId);
    return validateAiResult(task, item);
  });
  if (seen.size !== tasks.length) throw new Error('AI results are incomplete');
  return tasks.map((task) => results.find((result) => result.taskId === task.taskId));
}

export function buildProviderFailureResults(tasks, error) {
  const message = String(error?.message ?? error).trim() || 'AI provider failure';
  return tasks.map((task) => ({
    taskId: task.taskId,
    sourceKey: task.sourceKey,
    label: task.label,
    aiJudgment: null,
    aiConfidence: null,
    aiEvidence: '',
    aiReason: '',
    qualityIssues: [`provider failure: ${message}`],
    ruleJudgment: task.inputs.ruleJudgment,
    ruleEvidence: task.inputs.ruleEvidence,
    finalJudgment: '需人工核验',
    judgmentSource: 'pending',
    needsHumanReview: true,
    qualityGate: 'MANUAL_REVIEW',
    reviewStatus: 'AI_PROVIDER_FAILED',
  }));
}

export function buildAiReviewArtifact({ period, classifiedSnapshot, tasks, results = [], provider = null, batchFailures = [] }) {
  const accepted = results.filter((result) => result.qualityGate === 'AUTO_ACCEPTED');
  const manual = results.filter((result) => result.qualityGate === 'MANUAL_REVIEW');
  return {
    mode: results.length === tasks.length ? (batchFailures.length ? 'AI_REVIEWED_WITH_MANUAL_FALLBACK' : 'AI_REVIEWED') : 'AI_TASKS_READY',
    period,
    analysisVersion: FAQ_ANALYSIS_VERSION,
    aiReviewVersion: FAQ_AI_REVIEW_VERSION,
    aiPromptVersion: FAQ_AI_PROMPT_VERSION,
    provider,
    source: classifiedSnapshot,
    taskCount: tasks.length,
    resultCount: results.length,
    autoAccepted: accepted.length,
    needsHumanReview: manual.length,
    batchFailures,
    tasks,
    results,
    humanQueue: manual.map((result) => ({ taskId: result.taskId, sourceKey: result.sourceKey, label: result.label, rawContent: tasks.find((task) => task.taskId === result.taskId)?.inputs.rawContent ?? '', ruleEvidence: tasks.find((task) => task.taskId === result.taskId)?.inputs.ruleEvidence ?? '', aiJudgment: result.aiJudgment, aiEvidence: result.aiEvidence, aiReason: result.aiReason, reason: result.qualityGate })),
  };
}
