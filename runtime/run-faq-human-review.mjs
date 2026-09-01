#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { mergeFaqReviewResults } from './faq-human-review.mjs';
import { FAQ_ANALYSIS_VERSION, assertUniqueSourceTopics, normalizeFaqText, sourceTopicIdentity } from './faq-text-analysis.mjs';

function parseArgs(argv) {
  const options = { runtimeRoot: 'runtime' };
  const valueOptions = new Map([
    ['--runtime-root', 'runtimeRoot'],
    ['--period-start', 'periodStart'],
    ['--period-end', 'periodEnd'],
    ['--decisions', 'decisionsPath'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!valueOptions.has(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    options[valueOptions.get(arg)] = value;
  }
  for (const name of ['periodStart', 'periodEnd']) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(options[name] ?? ''))) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be YYYY-MM-DD`);
  }
  options.period = `${options.periodStart}_${options.periodEnd}`;
  options.analysisDir = resolve(options.runtimeRoot, 'faq-analysis', options.period);
  options.decisionsPath ??= resolve(options.analysisDir, 'ai-review', 'human-review-decisions.json');
  return options;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readJson(file) {
  if (!existsSync(file)) throw new Error(`Missing required FAQ review artifact: ${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  const text = readFileSync(file, 'utf8');
  return { text, rows: text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)) };
}

function writeJson(file, value) {
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(file, rows) {
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '', 'utf8');
}

function productIdFor(fields) {
  return String(fields?.商品ID ?? '').trim() || String(fields?.商品链接 ?? '').match(/[?&]id=(\d+)/u)?.[1] || '';
}

function sourceFingerprint(record) {
  const fields = record?.fields ?? record ?? {};
  return [productIdFor(fields), normalizeFaqText(fields.来源类型), normalizeFaqText(fields.原始内容)].join('\n');
}

function findLegacyBackup(analysisDir) {
  const candidates = readdirSync(analysisDir)
    .filter((name) => /^detail-enrichment-backup-.*\.json$/u.test(name))
    .sort()
    .map((name) => resolve(analysisDir, name));
  if (!candidates.length) throw new Error(`Missing legacy FAQ detail backup for source-topic audit: ${analysisDir}`);
  return candidates.at(-1);
}

export function buildLegacySourceTopicAudit({ analysisDir, finalRecords }) {
  assertUniqueSourceTopics(finalRecords, 'Final FAQ records');
  const backupPath = findLegacyBackup(analysisDir);
  const backupText = readFileSync(backupPath, 'utf8');
  const backup = JSON.parse(backupText);
  const legacyRecords = [...(backup.weekly ?? []), ...(backup.master ?? [])];
  const finalBySource = new Map();
  for (const record of finalRecords) {
    const key = sourceFingerprint(record);
    const list = finalBySource.get(key) ?? [];
    list.push(record);
    finalBySource.set(key, list);
  }
  const oldPainRecords = legacyRecords.filter((record) => normalizeFaqText(record?.fields?.是否痛点) === '是');
  const entries = [];
  for (const legacy of oldPainRecords) {
    const fields = legacy.fields ?? {};
    const sourceKey = sourceFingerprint(legacy);
    const candidates = finalBySource.get(sourceKey) ?? [];
    const sourceKeys = [...new Set(candidates.map((record) => normalizeFaqText(record.fields.来源记录唯一键)))];
    const label = normalizeFaqText(fields.分类标签 || fields.高频问题或关键词);
    const matching = candidates.filter((record) => normalizeFaqText(record.fields.分类标签) === label);
    let status;
    let reason;
    let finalRecord = null;
    if (sourceKeys.length !== 1) {
      status = 'UNRESOLVED';
      reason = sourceKeys.length ? 'source fingerprint maps to multiple source keys' : 'source fingerprint not found in final classification';
    } else if (matching.length !== 1) {
      status = 'EXCLUDED_UNMENTIONED';
      reason = 'legacy topic label is absent from the final source-topic set; no synthetic 否 row was created';
    } else {
      finalRecord = matching[0];
      status = normalizeFaqText(finalRecord.fields.是否痛点) === '是' ? 'RETAINED_PAIN' : 'CORRECTED_TO_NO';
      reason = status === 'RETAINED_PAIN' ? 'final source-topic evidence still supports pain' : 'final source-topic evidence or reviewed decision corrects the legacy pain judgment';
    }
    entries.push({
      legacyRecordId: legacy.recordId ?? null,
      legacySourceFingerprintSha256: hash(sourceKey),
      legacyLabel: label,
      legacyRawContentSha256: hash(normalizeFaqText(fields.原始内容)),
      sourceKey: sourceKeys[0] ?? null,
      finalSourceTopic: finalRecord ? sourceTopicIdentity(finalRecord) : null,
      finalJudgment: finalRecord?.fields?.是否痛点 ?? null,
      status,
      reason,
    });
  }
  const counts = Object.fromEntries([...new Set(entries.map((entry) => entry.status))].map((status) => [status, entries.filter((entry) => entry.status === status).length]));
  return {
    version: 'faq-source-topic-audit-v1.0.0',
    legacyBackup: { path: backupPath, sha256: hash(backupText) },
    legacyPainRecordCount: oldPainRecords.length,
    counts,
    unresolvedCount: entries.filter((entry) => entry.status === 'UNRESOLVED').length,
    entries,
  };
}

export function buildHumanReviewPaths(runtimeRoot, period) {
  const analysisDir = resolve(runtimeRoot, 'faq-analysis', period);
  const reviewDir = resolve(analysisDir, 'ai-review');
  return {
    analysisDir,
    reviewDir,
    classifiedPath: resolve(analysisDir, 'classified-records.jsonl'),
    classificationReceiptPath: resolve(analysisDir, 'classification-receipt.json'),
    artifactPath: resolve(reviewDir, 'ai-review-artifact.json'),
    decisionsPath: resolve(reviewDir, 'human-review-decisions.json'),
    finalClassifiedPath: resolve(analysisDir, 'final-classified-records.jsonl'),
    finalReceiptPath: resolve(analysisDir, 'final-classification-receipt.json'),
    topicCorrectionsPath: resolve(reviewDir, 'topic-corrections.jsonl'),
    humanQueuePath: resolve(reviewDir, 'human-review-queue.jsonl'),
    sourceTopicAuditPath: resolve(reviewDir, 'source-topic-audit.json'),
  };
}

export function buildFinalClassificationReceipt({ options, paths, classifiedText, finalText, merged, audit }) {
  const sourceTopicText = merged.records.map((record) => sourceTopicIdentity(record)).sort().join('\n');
  const auditText = `${JSON.stringify(audit, null, 2)}\n`;
  return {
    mode: merged.humanQueueCount === 0 && audit.unresolvedCount === 0 ? 'FINAL_CLASSIFICATION_READY' : 'FINAL_CLASSIFICATION_WITH_MANUAL_FALLBACK',
    period: options.period,
    analysisVersion: FAQ_ANALYSIS_VERSION,
    humanReviewVersion: merged.version,
    source: {
      classifiedSnapshot: { path: paths.classifiedPath, sha256: hash(classifiedText) },
      finalClassifiedSnapshot: { path: paths.finalClassifiedPath, sha256: hash(finalText) },
      aiArtifact: { path: paths.artifactPath, sha256: hash(readFileSync(paths.artifactPath, 'utf8')) },
      humanDecisions: { path: paths.decisionsPath, sha256: hash(readFileSync(paths.decisionsPath, 'utf8')) },
      sourceTopicSet: { sha256: hash(sourceTopicText), count: merged.records.length },
      legacySourceTopicAudit: { path: paths.sourceTopicAuditPath, sha256: hash(auditText) },
    },
    sourceRecords: new Set(merged.records.map((record) => record.fields.来源记录唯一键)).size,
    classifiedRecords: merged.records.length,
    sourceTopicCount: merged.records.length,
    legacyAudit: { unresolvedCount: audit.unresolvedCount, counts: audit.counts },
    aiTaskCount: merged.taskCount,
    humanDecisionCount: merged.decisionCount,
    humanQueueCount: merged.humanQueueCount,
    topicCorrectionCount: merged.topicCorrections.length,
    publishable: merged.publishable && merged.humanQueueCount === 0,
    feishuWrites: 0,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const paths = buildHumanReviewPaths(options.runtimeRoot, options.period);
  const classified = readJsonl(paths.classifiedPath);
  const classificationReceipt = readJson(paths.classificationReceiptPath);
  if (classificationReceipt.mode !== 'APPLIED_AND_VERIFIED' || classificationReceipt.period !== options.period || classificationReceipt.analysisVersion !== FAQ_ANALYSIS_VERSION || classificationReceipt.classifiedSnapshot?.sha256 !== hash(classified.text)) throw new Error('FAQ classification evidence mismatch');
  const artifact = readJson(paths.artifactPath);
  if (artifact.period !== options.period || artifact.analysisVersion !== FAQ_ANALYSIS_VERSION || artifact.taskCount !== artifact.tasks.length || artifact.resultCount !== artifact.results.length) throw new Error('FAQ AI review artifact is incomplete or mismatched');
  const decisions = readJson(paths.decisionsPath);
  if (!Array.isArray(decisions)) throw new Error('Human review decisions must be an array');
  const merged = mergeFaqReviewResults({ classifiedRecords: classified.rows, tasks: artifact.tasks, results: artifact.results, decisions, period: options.period });
  const finalText = `${merged.records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  mkdirSync(paths.analysisDir, { recursive: true });
  writeFileSync(paths.finalClassifiedPath, finalText, 'utf8');
  writeJsonl(paths.topicCorrectionsPath, merged.topicCorrections);
  writeJsonl(paths.humanQueuePath, merged.humanQueue);
  const audit = buildLegacySourceTopicAudit({ analysisDir: paths.analysisDir, finalRecords: merged.records });
  writeJson(paths.sourceTopicAuditPath, audit);
  const receipt = buildFinalClassificationReceipt({ options, paths, classifiedText: classified.text, finalText, merged, audit });
  writeJson(paths.finalReceiptPath, receipt);
  console.log(JSON.stringify({ ...receipt, paths: { finalClassifiedPath: paths.finalClassifiedPath, topicCorrectionsPath: paths.topicCorrectionsPath, humanQueuePath: paths.humanQueuePath, finalReceiptPath: paths.finalReceiptPath } }, null, 2));
  return { ...merged, receipt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
