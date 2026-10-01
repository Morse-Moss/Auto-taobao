import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function buildDownloadManifest({ filePath, reportType, date, shop, member = null, observedAt = new Date() } = {}) {
  if (!filePath) throw new Error('manifest requires filePath');
  if (!reportType) throw new Error('manifest requires reportType');
  const absolutePath = path.resolve(filePath);
  const stat = statSync(absolutePath, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`manifest file does not exist: ${absolutePath}`);
  const sha256 = createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
  return { schemaVersion: 1, reportType, date: date ?? null, shop: shop ?? null, member: member ?? null,
    fileName: path.basename(absolutePath), filePath: absolutePath, bytes: stat.size, mtimeMs: stat.mtimeMs,
    sha256, observedAt: observedAt instanceof Date ? observedAt.toISOString() : String(observedAt) };
}

export function writeDownloadManifest({ outputPath, ...input } = {}) {
  if (!outputPath) throw new Error('manifest requires outputPath');
  const manifest = buildDownloadManifest(input);
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}
