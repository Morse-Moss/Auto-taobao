#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FAQ_ANALYSIS_VERSION, FAQ_LABEL_CATALOG } from './faq-text-analysis.mjs';
import { FAQ_DEDUP_VERSION, FAQ_OPERATOR_CONTENT_VERSION, FAQ_PAIN_DESCRIPTION_VERSION, FAQ_REPRESENTATIVE_SELECTION_VERSION, FAQ_SUMMARY_VERSION, buildCumulativeSummary, buildSummary, classifyAndDeduplicate } from './faq-local-summary.mjs';
import { readOperatorContent } from './faq-operator-content.mjs';

function parseArgs(argv) {
  const options = { runtimeRoot: 'runtime' };
  const valueOptions = new Map([['--runtime-root', 'runtimeRoot'], ['--period-start', 'periodStart'], ['--period-end', 'periodEnd'], ['--output-dir', 'outputDir'], ['--operator-xlsx', 'operatorXlsx'], ['--python', 'python']]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!valueOptions.has(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    options[valueOptions.get(arg)] = value;
  }
  for (const name of ['periodStart', 'periodEnd']) if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(options[name] ?? ''))) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be YYYY-MM-DD`);
  options.period = `${options.periodStart}_${options.periodEnd}`;
  options.outputDir ??= resolve(options.runtimeRoot, 'faq-analysis', options.period);
  return options;
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

async function verifiedPeriods(runtimeRoot) {
  const root = resolve(runtimeRoot, 'faq-analysis');
  if (!existsSync(root)) return [];
  const periods = [];
  for (const period of await readdir(root)) {
    const receiptPath = resolve(root, period, 'final-classification-receipt.json');
    const classifiedPath = resolve(root, period, 'final-classified-records.jsonl');
    if (!existsSync(receiptPath) || !existsSync(classifiedPath)) continue;
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    const classifiedText = await readFile(classifiedPath, 'utf8');
    if (receipt.mode !== 'FINAL_CLASSIFICATION_READY' || receipt.period !== period || receipt.analysisVersion !== FAQ_ANALYSIS_VERSION || receipt.publishable !== true || receipt.humanQueueCount !== 0 || receipt.classifiedRecords !== classifiedText.split(/\r?\n/u).filter(Boolean).length) continue;
    periods.push({ period, records: classifiedText.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)) });
  }
  return periods.sort((left, right) => left.period.localeCompare(right.period));
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.operatorXlsx) throw new Error('--operator-xlsx is required');
  const operatorContent = readOperatorContent(options.operatorXlsx, { python: options.python });
  const finalClassifiedPath = resolve(options.outputDir, 'final-classified-records.jsonl');
  const finalReceiptPath = resolve(options.outputDir, 'final-classification-receipt.json');
  const rawPath = resolve(options.runtimeRoot, 'question-library-collection', options.period, 'raw-records.jsonl');
  if (!existsSync(finalClassifiedPath) || !existsSync(finalReceiptPath) || !existsSync(rawPath)) throw new Error('Missing final verified FAQ classification artifacts');
  const classifiedText = await readFile(finalClassifiedPath, 'utf8');
  const rawText = await readFile(rawPath, 'utf8');
  const finalReceipt = JSON.parse(await readFile(finalReceiptPath, 'utf8'));
  if (finalReceipt.mode !== 'FINAL_CLASSIFICATION_READY' || finalReceipt.period !== options.period || finalReceipt.analysisVersion !== FAQ_ANALYSIS_VERSION || finalReceipt.publishable !== true || finalReceipt.humanQueueCount !== 0 || finalReceipt.classifiedRecords !== classifiedText.split(/\r?\n/u).filter(Boolean).length) throw new Error('FAQ final classification is not ready for summary');
  const classified = classifiedText.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const weeklyDedup = classifyAndDeduplicate(classified);
  const weekly = buildSummary(weeklyDedup.records, { period: options.period, scope: 'weekly', includeShare: false, operatorContent });
  const periods = await verifiedPeriods(options.runtimeRoot);
  if (!periods.some((entry) => entry.period === options.period)) throw new Error(`Current period final classification is not ready: ${options.period}`);
  const cumulative = buildCumulativeSummary(periods, { operatorContent });
  const expectedLabels = new Set(FAQ_LABEL_CATALOG.map(({ label }) => label));
  const assertSummary = (summary, name) => {
    if (summary.rows.length !== expectedLabels.size || new Set(summary.rows.map((row) => row.分类标签)).size !== expectedLabels.size || summary.rows.some((row) => !expectedLabels.has(row.分类标签))) {
      throw new Error(`${name} must contain exactly ${expectedLabels.size} unique FAQ labels`);
    }
    if (summary.operatorContentVersion !== FAQ_OPERATOR_CONTENT_VERSION || !summary.operatorContentSource?.sha256) throw new Error(`${name} is missing verified operator content`);
    if (summary.rows.some((row) => {
      const evidence = row.representativeEvidence;
      if (row.出现次数 > 0 && (!evidence || !evidence.sourceKey || !/^[a-f0-9]{64}$/u.test(evidence.rawHash) || !Number.isInteger(evidence.candidateCount) || evidence.candidateCount < 1)) return true;
      return evidence && (!evidence.sourceKey || !/^[a-f0-9]{64}$/u.test(evidence.rawHash) || !Number.isInteger(evidence.candidateCount) || evidence.candidateCount < 1);
    })) {
      throw new Error(`${name} contains invalid representative evidence`);
    }
  };
  assertSummary(weekly, 'weekly summary');
  assertSummary(cumulative, 'cumulative summary');
  await mkdir(resolve(options.outputDir), { recursive: true });
  const weeklyText = `${JSON.stringify(weekly, null, 2)}\n`;
  const cumulativeText = `${JSON.stringify(cumulative, null, 2)}\n`;
  const weeklyPath = resolve(options.outputDir, 'weekly-summary.json');
  const cumulativePath = resolve(options.outputDir, 'cumulative-summary.json');
  await writeFile(weeklyPath, weeklyText, 'utf8');
  await writeFile(cumulativePath, cumulativeText, 'utf8');
  const receipt = { mode: 'APPLIED_AND_VERIFIED', period: options.period, analysisVersion: FAQ_ANALYSIS_VERSION, dedupVersion: FAQ_DEDUP_VERSION, summaryVersion: FAQ_SUMMARY_VERSION, representativeSelectionVersion: FAQ_REPRESENTATIVE_SELECTION_VERSION, painDescriptionVersion: FAQ_PAIN_DESCRIPTION_VERSION, operatorContentVersion: operatorContent.version, source: { rawSnapshot: { path: rawPath, sha256: hash(rawText) }, finalClassifiedSnapshot: { path: finalClassifiedPath, sha256: hash(classifiedText) }, finalClassificationReceipt: { path: finalReceiptPath, sha256: hash(await readFile(finalReceiptPath, 'utf8')) }, operatorXlsx: operatorContent.source }, periods: periods.map((entry) => entry.period), weekly: { path: weeklyPath, sha256: hash(weeklyText), denominator: weekly.denominator, rows: weekly.rows.length, labels: weekly.rows.map((row) => row.分类标签) }, cumulative: { path: cumulativePath, sha256: hash(cumulativeText), denominator: cumulative.denominator, rows: cumulative.rows.length, labels: cumulative.rows.map((row) => row.分类标签) }, weeklyDuplicates: weeklyDedup.duplicates.length, feishuWrites: 0 };
  await writeFile(resolve(options.outputDir, 'aggregate-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
