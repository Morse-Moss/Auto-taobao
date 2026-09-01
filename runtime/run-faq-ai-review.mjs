#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildProviderCommand, parseProviderOutput } from './local-provider-runner.mjs';
import { FAQ_AI_PROMPT_VERSION, FAQ_AI_REVIEW_VERSION, aiTaskFingerprint, buildAiReviewArtifact, buildAiReviewTasks, buildProviderFailureResults, parseAiResults } from './faq-ai-review.mjs';
import { FAQ_ANALYSIS_VERSION } from './faq-text-analysis.mjs';

const DEFAULT_PROVIDER = 'codex';

function parseArgs(argv) {
  const options = { runtimeRoot: 'runtime', provider: DEFAULT_PROVIDER, batchSize: 20, reuseOnly: false };
  const valueOptions = new Map([['--runtime-root', 'runtimeRoot'], ['--period-start', 'periodStart'], ['--period-end', 'periodEnd'], ['--output-dir', 'outputDir'], ['--provider', 'provider'], ['--batch-size', 'batchSize']]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--reuse-only') { options.reuseOnly = true; continue; }
    if (!valueOptions.has(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    options[valueOptions.get(arg)] = value;
  }
  for (const name of ['periodStart', 'periodEnd']) if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(options[name] ?? ''))) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be YYYY-MM-DD`);
  options.period = `${options.periodStart}_${options.periodEnd}`;
  options.outputDir ??= path.resolve(options.runtimeRoot, 'faq-analysis', options.period, 'ai-review');
  options.batchSize = Number(options.batchSize);
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) throw new Error('--batch-size must be a positive integer');
  if (!['cc', 'codex', 'workbuddy'].includes(options.provider)) throw new Error('--provider must be cc, codex, or workbuddy');
  return options;
}

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function writeText(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value, 'utf8'); }

function parseAiProviderOutput(output) {
  const normalizedOutput = String(output).replace(/[​﻿]/gu, '').trim();
  const parsed = JSON.parse(normalizedOutput);
  if (Array.isArray(parsed)) return parsed;
  const result = parsed && typeof parsed === 'object' ? parsed.result : null;
  if (Array.isArray(result)) return result;
  if (typeof result === 'string') {
    const text = result.replace(/[​﻿]/gu, '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim();
    const nested = JSON.parse(text);
    if (Array.isArray(nested)) return nested;
  }
  throw new Error('Invalid AI provider output: expected a JSON array');
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function split(items, size) { const result = []; for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size)); return result; }

function quoteWindowsArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9_.-]+$/u.test(text) ? text : `"${text.replaceAll('"', '\\"')}"`;
}

function runProvider(provider, taskFile, input) {
  const definition = buildProviderCommand(provider, taskFile);
  const args = provider === 'codex' ? [definition.args[0], '--skip-git-repo-check', ...definition.args.slice(1)] : definition.args;
  return new Promise((resolve, reject) => {
    const processHandle = process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [definition.command, ...args.map(quoteWindowsArg)].join(' ')], { windowsHide: true })
      : spawn(definition.command, args, { windowsHide: true });
    Promise.resolve(processHandle).then((processHandle) => {
      let stdout = '';
      let stderr = '';
      processHandle.stdout.on('data', (chunk) => { stdout += chunk; });
      processHandle.stderr.on('data', (chunk) => { stderr += chunk; });
      processHandle.on('error', reject);
      processHandle.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Provider failed: ${stderr.trim()}`));
          return;
        }
        try { resolve(parseAiProviderOutput(stdout)); } catch (error) { reject(error); }
      });
      processHandle.stdin.end(input);
    }).catch(reject);
  });
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  const outputDir = path.resolve(options.outputDir);
  const analysisDir = path.resolve(options.runtimeRoot, 'faq-analysis', options.period);
  const classifiedPath = path.resolve(analysisDir, 'classified-records.jsonl');
  const receiptPath = path.resolve(analysisDir, 'classification-receipt.json');
  if (!fs.existsSync(classifiedPath) || !fs.existsSync(receiptPath)) throw new Error('Missing verified FAQ classification artifacts');
  const classifiedText = fs.readFileSync(classifiedPath, 'utf8');
  const receipt = readJson(receiptPath);
  if (receipt.mode !== 'APPLIED_AND_VERIFIED' || receipt.period !== options.period || receipt.analysisVersion !== FAQ_ANALYSIS_VERSION || receipt.classifiedSnapshot?.sha256 !== digest(classifiedText)) throw new Error('FAQ classification evidence mismatch');
  const classified = classifiedText.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const tasks = buildAiReviewTasks(classified);
  const taskPath = path.resolve(outputDir, 'tasks.json');
  const artifactPath = path.resolve(outputDir, 'ai-review-artifact.json');
  const snapshot = { path: classifiedPath, sha256: digest(classifiedText) };
  writeJson(taskPath, tasks);
  let migratedResults = [];
  if (fs.existsSync(artifactPath)) {
    const existing = readJson(artifactPath);
    const oldTasks = new Map((existing.tasks ?? []).map((task) => [task.taskId, task]));
    const oldResults = new Map((existing.results ?? []).map((result) => [result.taskId, result]));
    migratedResults = tasks.flatMap((task) => {
      const oldTask = oldTasks.get(task.taskId);
      const oldResult = oldResults.get(task.taskId);
      if (!oldTask || !oldResult) return [];
      const compatible = oldTask.sourceKey === task.sourceKey
        && oldTask.label === task.label
        && oldTask.inputs?.rawContent === task.inputs.rawContent
        && oldTask.inputs?.ruleEvidence === task.inputs.ruleEvidence
        && oldTask.promptHash === task.promptHash
        && oldTask.aiPromptVersion === task.aiPromptVersion
        && (!oldTask.fingerprint || oldTask.fingerprint === aiTaskFingerprint(task));
      if (!compatible) return [];
      const normalized = parseAiResults([task], [{
        taskId: oldResult.taskId,
        sourceKey: oldResult.sourceKey,
        label: oldResult.label,
        judgment: oldResult.aiJudgment,
        confidence: oldResult.aiConfidence,
        evidence: oldResult.aiEvidence,
        reason: oldResult.aiReason,
      }]);
      return normalized;
    });
    if (migratedResults.length === tasks.length && Array.isArray(existing.batchFailures) && existing.batchFailures.length === 0) {
      const artifact = buildAiReviewArtifact({ period: options.period, classifiedSnapshot: snapshot, tasks, results: migratedResults, provider: existing.provider, batchFailures: [] });
      writeJson(artifactPath, artifact);
      writeJson(path.resolve(outputDir, 'ai-review-receipt.json'), { mode: artifact.mode, period: options.period, analysisVersion: FAQ_ANALYSIS_VERSION, aiReviewVersion: FAQ_AI_REVIEW_VERSION, aiPromptVersion: FAQ_AI_PROMPT_VERSION, provider: artifact.provider, source: snapshot, taskCount: tasks.length, resultCount: artifact.resultCount, autoAccepted: artifact.autoAccepted, needsHumanReview: artifact.needsHumanReview, batchFailures: [], artifactPath, taskPath, reusedResults: migratedResults.length });
      writeText(path.resolve(outputDir, 'human-review-queue.jsonl'), artifact.humanQueue.map((item) => JSON.stringify(item)).join('\n') + (artifact.humanQueue.length ? '\n' : ''));
      console.log(JSON.stringify({ mode: artifact.mode, period: options.period, taskCount: tasks.length, resultCount: artifact.resultCount, autoAccepted: artifact.autoAccepted, needsHumanReview: artifact.needsHumanReview, reusedResults: migratedResults.length, artifactPath }, null, 2));
      return artifact;
    }
  }
  const migratedById = new Map(migratedResults.map((result) => [result.taskId, result]));
  const pendingTasks = tasks.filter((task) => !migratedById.has(task.taskId));
  if (options.reuseOnly && pendingTasks.length) {
    const missingPath = path.resolve(outputDir, 'reuse-only-missing-tasks.json');
    writeJson(missingPath, pendingTasks.map((task) => ({ taskId: task.taskId, sourceKey: task.sourceKey, label: task.label, fingerprint: task.fingerprint })));
    throw new Error(`FAQ AI reuse-only gate blocked ${pendingTasks.length} tasks; no provider was called: ${missingPath}`);
  }
  const batches = split(pendingTasks, options.batchSize);
  if (!batches.length) {
    const artifact = buildAiReviewArtifact({ period: options.period, classifiedSnapshot: snapshot, tasks, results: migratedResults, provider: null });
    writeJson(artifactPath, artifact);
    console.log(JSON.stringify({ mode: artifact.mode, period: options.period, taskCount: tasks.length, resultCount: artifact.resultCount, autoAccepted: artifact.autoAccepted, needsHumanReview: artifact.needsHumanReview, artifactPath }, null, 2));
    return artifact;
  }
  const results = [...migratedResults];
  const batchFailures = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const batchFile = path.resolve(outputDir, `batch-${String(index + 1).padStart(3, '0')}.json`);
    const resultFile = path.resolve(outputDir, `batch-${String(index + 1).padStart(3, '0')}-results.json`);
    let batchResults = null;
    if (fs.existsSync(resultFile)) {
      const stored = readJson(resultFile);
      const storedTaskIds = Array.isArray(stored) ? stored.map((item) => item.taskId) : [];
      const batchTaskIds = batch.map((task) => task.taskId);
      const storedMatches = storedTaskIds.length === batchTaskIds.length
        && storedTaskIds.every((taskId, itemIndex) => taskId === batchTaskIds[itemIndex]);
      if (storedMatches) {
        const rawResults = stored.map((item) => ({
          taskId: item.taskId,
          sourceKey: item.sourceKey,
          label: item.label,
          judgment: item.aiJudgment,
          confidence: item.aiConfidence,
          evidence: item.aiEvidence,
          reason: item.aiReason,
        }));
        batchResults = parseAiResults(batch, rawResults);
      }
    }
    if (!batchResults) {
      const input = `${batch.map((task) => task.prompt).join('\n\n')}\n\n只返回上述任务对应的 JSON 数组。`;
      writeJson(batchFile, batch);
      try {
        const output = await (dependencies.runProvider ?? runProvider)(options.provider, batchFile, input);
        batchResults = parseAiResults(batch, output);
        writeJson(resultFile, batchResults);
      } catch (error) {
        batchResults = buildProviderFailureResults(batch, error);
        writeJson(path.resolve(outputDir, `batch-${String(index + 1).padStart(3, '0')}-failure.json`), { message: String(error?.message ?? error), taskCount: batch.length });
        batchFailures.push({ batch: index + 1, taskCount: batch.length, message: String(error?.message ?? error) });
      }
    }
    results.push(...batchResults);
  }
  const artifact = buildAiReviewArtifact({ period: options.period, classifiedSnapshot: snapshot, tasks, results, provider: options.provider, batchFailures });
  writeJson(artifactPath, artifact);
  const receiptOutput = { mode: artifact.mode, period: options.period, analysisVersion: FAQ_ANALYSIS_VERSION, aiReviewVersion: FAQ_AI_REVIEW_VERSION, aiPromptVersion: FAQ_AI_PROMPT_VERSION, provider: options.provider, source: snapshot, taskCount: tasks.length, resultCount: results.length, autoAccepted: artifact.autoAccepted, needsHumanReview: artifact.needsHumanReview, batchFailures: artifact.batchFailures, artifactPath, taskPath };
  writeJson(path.resolve(outputDir, 'ai-review-receipt.json'), receiptOutput);
  console.log(JSON.stringify(receiptOutput, null, 2));
  return artifact;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
