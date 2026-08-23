import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const INDEX_VERSION = 'xws-sku-batch-index-v1';

function clean(value) {
  const text = String(value ?? '').trim();
  return text || undefined;
}
function safeSource(source = {}) {
  return Object.fromEntries([
    ['mainRecordId', source.mainRecordId],
    ['productId', source.productId],
    ['productUrl', source.productUrl],
    ['classification', source.classification],
    ['validity', source.validity],
  ].flatMap(([key, value]) => {
    const normalized = clean(value);
    return normalized ? [[key, normalized]] : [];
  }));
}

function safeArtifacts(artifacts = {}) {
  return Object.fromEntries(Object.entries(artifacts).flatMap(([key, value]) => {
    const normalized = clean(value);
    return normalized ? [[key, basename(normalized)]] : [];
  }));
}

async function readExisting(indexPath) {
  if (!existsSync(indexPath)) return {};
  let parsed;
  try {
    parsed = JSON.parse(await readFile(indexPath, 'utf8'));
  } catch {
    throw new Error('SKU batch index is not valid JSON: ' + indexPath);
  }
  if (parsed?.version && parsed.version !== INDEX_VERSION) {
    throw new Error('Unsupported SKU batch index version');
  }
  return parsed;
}

export async function updateSkuBatchIndex({ directory, source = {}, artifacts = {}, status, updatedAt } = {}) {
  const outputDirectory = resolve(clean(directory) || '.');
  await mkdir(outputDirectory, { recursive: true });
  const indexPath = join(outputDirectory, 'batch-index.json');
  const existing = await readExisting(indexPath);
  const mergedSource = { ...(existing.source ?? {}), ...safeSource(source) };
  const mergedArtifacts = { ...(existing.artifacts ?? {}), ...safeArtifacts(artifacts) };
  const index = {
    version: INDEX_VERSION,
    updatedAt: new Date(updatedAt ?? Date.now()).toISOString(),
    source: mergedSource,
    artifacts: mergedArtifacts,
    ...(clean(status) ? { status: clean(status) } : {}),
  };
  const tempPath = `${indexPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(index, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  await rename(tempPath, indexPath);
  return indexPath;
}
