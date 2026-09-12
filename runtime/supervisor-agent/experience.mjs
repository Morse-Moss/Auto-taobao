// 监督 Agent L5 记忆层：经验库。
// 公理 5：经验必须可机读（签名正则）、可验证（置信度回写）、可过期（环境指纹）。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadExperience(file) {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // 经验库损坏 = 无经验，安全降级
  }
}

export function saveExperience(file, entries) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(entries, null, 2), 'utf8');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 签名匹配：failureClass 相同且规范化错误模式一致（容差：忽略数字差异）。 */
export function matchExperience(entries, incident, failureClass) {
  const error = String(incident?.error ?? '')
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z?/gu, '<ts>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, '<uuid>')
    .replace(/[A-Z]:\\[^"]+/gu, '<path>')
    .replace(/\d+/gu, '<n>')
    .slice(0, 160);
  return entries.find((entry) => entry.signature?.failureClass === failureClass
    && entry.signature?.errorPattern === error
    && (entry.confidence ?? 0) > 0) ?? null;
}

/** 应用结果回写：验证通过 +1，应用失败 -1，<=0 退役（防错误经验固化）。 */
export function recordOutcome(entries, id, { verified, note = '' } = {}) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return entries;
  entry.confidence = Math.max(0, Math.min(1, (entry.confidence ?? 0.5) + (verified ? 0.2 : -0.4)));
  entry.occurrences = (entry.occurrences ?? 0) + 1;
  entry.lastAppliedAt = new Date().toISOString();
  entry.history = [...(entry.history ?? []), { verified, note, at: new Date().toISOString() }].slice(-10);
  if (entry.confidence <= 0) entry.retired = true;
  return entries;
}

/** 新增经验条目（仅在处置通过验证后允许，公理 6）。 */
export function addExperience(entries, { signature, symptom, rootCause, remedy, actions, evidence, envFingerprint, confidence = 0.5 }) {
  const id = `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  entries.push({
    id,
    signature,
    symptom,
    rootCause,
    remedy,
    actions,
    evidence,
    envFingerprint,
    confidence,
    occurrences: 0,
    learnedAt: new Date().toISOString(),
    retired: false,
  });
  return { entries, id };
}

/** 环境指纹变化 → 旧经验整体降级待复核（可过期）。 */
export function degradeStaleEnvironment(entries, envFingerprint) {
  for (const entry of entries) {
    if (!entry.retired && entry.envFingerprint && entry.envFingerprint !== envFingerprint) {
      entry.confidence = Math.min(entry.confidence ?? 0.5, 0.3);
      entry.needsReview = true;
    }
  }
  return entries;
}
