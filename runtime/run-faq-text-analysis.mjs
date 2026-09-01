#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FAQ_ANALYSIS_VERSION, assertAnalysisRecord, assertUniqueSourceTopics, buildAnalysisRecords } from './faq-text-analysis.mjs';

function parseArgs(argv) {
  const options = { runtimeRoot: 'runtime' };
  const valueOptions = new Map([['--runtime-root', 'runtimeRoot'], ['--period-start', 'periodStart'], ['--period-end', 'periodEnd'], ['--output-dir', 'outputDir']]);
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

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const outputDir = resolve(options.outputDir);
  const rawPath = resolve(options.runtimeRoot, 'question-library-collection', options.period, 'raw-records.jsonl');
  if (!existsSync(rawPath)) throw new Error(`Missing local raw snapshot: ${rawPath}`);
  const rawText = await readFile(rawPath, 'utf8');
  const rawRecords = rawText.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  if (!rawRecords.length) throw new Error('Local raw snapshot is empty');
  const records = buildAnalysisRecords(rawRecords);
  records.forEach(assertAnalysisRecord);
  assertUniqueSourceTopics(records);
  await mkdir(outputDir, { recursive: true });
  const classifiedText = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const classifiedPath = resolve(outputDir, 'classified-records.jsonl');
  if (existsSync(classifiedPath)) {
    const existingReceiptPath = resolve(outputDir, 'classification-receipt.json');
    const existingReceipt = existsSync(existingReceiptPath) ? JSON.parse(await readFile(existingReceiptPath, 'utf8')) : null;
    if (existingReceipt?.analysisVersion === FAQ_ANALYSIS_VERSION && hash(await readFile(classifiedPath, 'utf8')) !== hash(classifiedText)) throw new Error('Existing classified snapshot differs from current rules');
    if (existingReceipt?.analysisVersion !== FAQ_ANALYSIS_VERSION) await writeFile(classifiedPath, classifiedText, 'utf8');
  } else await writeFile(classifiedPath, classifiedText, 'utf8');
  const receipt = { mode: 'APPLIED_AND_VERIFIED', period: options.period, rawSnapshot: { path: rawPath, sha256: hash(rawText) }, classifiedSnapshot: { path: classifiedPath, sha256: hash(classifiedText) }, sourceRecords: rawRecords.length, classifiedRecords: records.length, analysisVersion: FAQ_ANALYSIS_VERSION, feishuWrites: 0 };
  await writeFile(resolve(outputDir, 'classification-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
