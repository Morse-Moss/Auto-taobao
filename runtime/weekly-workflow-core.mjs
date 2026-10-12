export const WEEKLY_STAGES = Object.freeze([
  'keyword-collect', 'weekly-table-import', 'ai-settlement', 'decision-history', 'huitun-heat', 'competitor-enrichment', 'publish-readback',
]);

export function buildWeeklyStagePlan({ completed = [], aiReady = false } = {}) {
  const done = new Set(completed);
  for (const stage of completed) if (!WEEKLY_STAGES.includes(stage)) throw new Error(`unknown weekly stage: ${stage}`);
  const next = WEEKLY_STAGES.find(stage => !done.has(stage));
  if (!next) return { status: 'COMPLETED', next: null, stages: WEEKLY_STAGES.map(name => ({ name, status: 'COMPLETED' })) };
  if (next === 'ai-settlement' && !aiReady) return { status: 'PAUSED_FOR_HUMAN', next, reason: 'AI_FIELDS_NOT_SETTLED', stages: WEEKLY_STAGES.map(name => ({ name, status: done.has(name) ? 'COMPLETED' : name === next ? 'PAUSED_FOR_HUMAN' : 'BLOCKED' })) };
  return { status: 'READY', next, stages: WEEKLY_STAGES.map(name => ({ name, status: done.has(name) ? 'COMPLETED' : name === next ? 'READY' : 'BLOCKED' })) };
}
