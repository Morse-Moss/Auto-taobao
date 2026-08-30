#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ANALYSIS_REGISTRY, canonicalDigest } from './weekly-local-analysis.mjs';

export function buildDocumentModel({ artifact = {} } = {}) {
  const tables = artifact.publishPlan?.tables ?? {};
  const providerResults = artifact.providerResults ?? [];
  const huitunItems = artifact.huitunResults?.items ?? [];
  return {
    title: '生意参谋关键词本地分析与飞书发布说明',
    generatedAt: new Date().toISOString(),
    status: artifact.status ?? 'LOCAL_ONLY',
    registryVersion: ANALYSIS_REGISTRY.version,
    registryDigest: canonicalDigest(ANALYSIS_REGISTRY),
    artifactDigest: artifact.artifactDigest ?? '',
    planDigest: artifact.publishPlan?.planDigest ?? '',
    sourceEvidence: artifact.sourceEvidence ?? artifact.evidence?.source ?? {},
    evidenceDigests: {
      provider: artifact.evidence?.providerDigest ?? '',
      huitun: artifact.evidence?.huitunDigest ?? canonicalDigest(artifact.huitunResults ?? null),
      prompt: artifact.evidence?.promptDigest ?? canonicalDigest(ANALYSIS_REGISTRY.prompts),
      history: artifact.evidence?.historySnapshotDigest ?? '',
      library: artifact.evidence?.librarySnapshotDigest ?? '',
    },
    fields: ANALYSIS_REGISTRY.fields.map((field) => ({ ...field })),
    prompts: { ...ANALYSIS_REGISTRY.prompts },
    providerSummary: {
      total: providerResults.length,
      validated: providerResults.filter((item) => item.validation === 'VALIDATED').length,
      providers: [...new Set(providerResults.map((item) => item.provider).filter(Boolean))],
    },
    huitunSummary: {
      items: huitunItems.length,
      collectedAt: artifact.huitunResults?.source?.collected_at ?? '',
    },
    publishSummary: {
      currentUpdates: (tables.current?.updates ?? []).length,
      historyCreates: (tables.history?.creates ?? []).length,
      historyUpdates: (tables.history?.updates ?? []).length,
      libraryCreates: (tables.library?.creates ?? []).length,
    },
    evidenceBoundary: {
      sycm: 'SYCM CSV/XLSX 必须证明七天周期、日期范围和连续排名。',
      huitun: '灰豚仅提供带时效和队列指纹的外部浏览量证据，不等同于内容热度。',
      feishu: '飞书只保存本地验证后的最终值，不执行公式或 AI 中间计算。',
    },
    missingValuePolicy: '缺少 provider、外部证据或无法确认的结果保持明确待核验状态，不写入 0。',
  };
}

function runPython(script, inputFile, outputFile) {
  const python = process.platform === 'win32' ? 'py' : 'python3';
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, inputFile, outputFile], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Word generation failed (${code}): ${stderr.trim()}`)));
  });
}

export async function generateDocument({ artifact = {}, outputFile, workDir = path.dirname(outputFile) }) {
  if (!outputFile) throw new Error('outputFile is required');
  fs.mkdirSync(workDir, { recursive: true });
  const model = buildDocumentModel({ artifact });
  const inputFile = path.join(workDir, `.weekly-analysis-doc-${process.pid}.json`);
  fs.writeFileSync(inputFile, `${JSON.stringify(model, null, 2)}\n`, 'utf8');
  try {
    await runPython(path.join(path.dirname(fileURLToPath(import.meta.url)), 'generate-weekly-analysis-doc.py'), inputFile, outputFile);
  } finally {
    fs.rmSync(inputFile, { force: true });
  }
  const content = fs.readFileSync(outputFile);
  return { outputFile, sha256: crypto.createHash('sha256').update(content).digest('hex'), model };
}

async function main() {
  const [artifactFile, outputFile] = process.argv.slice(2);
  const artifact = artifactFile ? JSON.parse(fs.readFileSync(path.resolve(artifactFile), 'utf8')) : {};
  console.log(JSON.stringify(await generateDocument({ artifact, outputFile: path.resolve(outputFile || 'weekly-analysis-explanation.docx') }), null, 2));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
