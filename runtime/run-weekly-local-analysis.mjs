#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildAnalysisTasks,
  buildLocalAnalysisArtifact,
  parseProviderResults,
} from './weekly-local-analysis.mjs';
import { runProvider } from './local-provider-runner.mjs';

const PROVIDERS = new Set(['cc', 'codex', 'workbuddy']);

function defaultWriteFile(file, content) {
  fs.writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}

export async function runLocalAnalysis(input, options = {}) {
  const provider = options.provider;
  if (!PROVIDERS.has(provider)) throw new Error('Provider is required and must be cc, codex, or workbuddy');
  const writeFile = options.writeFile ?? defaultWriteFile;
  const taskFile = options.taskFile ?? 'tasks.json';
  const tasks = buildAnalysisTasks({ records: input.records, fields: input.fields });
  writeFile(taskFile, tasks);
  const rawOutput = options.providerOutput ?? await runProvider(provider, taskFile, options.providerDependencies);
  const providerResults = parseProviderResults({ provider, tasks, output: rawOutput });
  writeFile(options.providerResultsFile ?? 'provider-results.json', providerResults);
  const artifact = buildLocalAnalysisArtifact({
    appToken: input.appToken,
    currentTable: input.currentTable,
    historyTable: input.historyTable,
    libraryTable: input.libraryTable,
    fields: input.fields,
    records: input.records,
    historyRecords: input.historyRecords ?? [],
    libraryRecords: input.libraryRecords,
    collectionDate: input.collectionDate,
    batchNumber: input.batchNumber,
    providerResults,
    huitunResults: options.huitunResults,
    sourceEvidence: input.sourceEvidence,
  });
  writeFile(options.artifactFile ?? 'analysis-artifact.json', artifact);
  return artifact;
}

export function isMainModule(argvPath, modulePath) {
  return path.resolve(argvPath) === path.resolve(modulePath);
}

async function main() {
  const [inputFile, outputDir, provider] = process.argv.slice(2);
  if (!inputFile || !outputDir || !provider) throw new Error('Usage: run-weekly-local-analysis.mjs INPUT_JSON OUTPUT_DIR PROVIDER');
  const input = JSON.parse(fs.readFileSync(path.resolve(inputFile), 'utf8'));
  const directory = path.resolve(outputDir);
  fs.mkdirSync(directory, { recursive: true });
  const result = await runLocalAnalysis(input, {
    provider,
    taskFile: path.join(directory, 'tasks.json'),
    providerResultsFile: path.join(directory, 'provider-results.json'),
    artifactFile: path.join(directory, 'analysis-artifact.json'),
    huitunResults: input.huitunResults,
  });
  console.log(JSON.stringify({ status: result.status, artifactFile: path.join(directory, 'analysis-artifact.json') }, null, 2));
}

if (process.argv[1] && isMainModule(process.argv[1], fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
