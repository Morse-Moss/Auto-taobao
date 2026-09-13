// Evidence Store：不可变工件 manifest、SHA-256 与索引。
// 数据库只存索引/摘要；本实现用受控本地目录作为工件缝（未来可换 Object Storage）。
import { createHash } from 'node:crypto';
import fsDefault from 'node:fs';
import fspDefault from 'node:fs/promises';
import path from 'node:path';

export const MANIFEST_SCHEMA_VERSION = 'evidence-manifest-v1';

export function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createEvidenceStore({
  root = 'runtime/sop-runtime/evidence',
  fs: fsImpl = fsDefault,
  fsp = fspDefault,
} = {}) {
  function manifestDir(runId) {
    return path.join(root, String(runId));
  }
  function manifestPath(runId, artifactId) {
    return path.join(manifestDir(runId), `${artifactId}.manifest.json`);
  }

  return {
    async writeManifest({ runId, attemptId = null, artifactId, artifactKind, filePath = null, range = null, rowCount = null, bytes = null, extra = {} }) {
      let sha256 = null;
      let sizeBytes = null;
      let storedPath = filePath;
      if (bytes) {
        // 工件必须落盘，否则无法回读复验摘要（只写 manifest 等于把证据留在内存里）。
        sha256 = digestOf(bytes);
        sizeBytes = bytes.length;
        if (!storedPath) {
          storedPath = path.join(manifestDir(runId), `${artifactId}.bin`);
          await fsp.mkdir(manifestDir(runId), { recursive: true });
          await fsp.writeFile(storedPath, bytes);
        }
      } else if (filePath && fsImpl.existsSync(filePath)) {
        const content = await fsp.readFile(filePath);
        sha256 = digestOf(content);
        sizeBytes = content.length;
      }
      const manifest = {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        artifactId,
        artifactKind,
        runId,
        attemptId,
        path: storedPath,
        sizeBytes,
        sha256,
        range,
        rowCount,
        createdAt: new Date().toISOString(),
        extra,
      };
      await fsp.mkdir(manifestDir(runId), { recursive: true });
      await fsp.writeFile(manifestPath(runId, artifactId), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      return manifest;
    },

    async readManifest(runId, artifactId) {
      try {
        const raw = await fsp.readFile(manifestPath(runId, artifactId), 'utf8');
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },

    async listManifests(runId) {
      try {
        const files = await fsp.readdir(manifestDir(runId));
        const out = [];
        for (const file of files.filter((f) => f.endsWith('.manifest.json'))) {
          const raw = await fsp.readFile(path.join(manifestDir(runId), file), 'utf8');
          out.push(JSON.parse(raw));
        }
        return out;
      } catch {
        return [];
      }
    },

    // 回读工件并校验摘要；文件缺失或摘要不符都返回 false（不抛异常吞掉事实）
    async verifyDigest(runId, artifactId) {
      const manifest = await this.readManifest(runId, artifactId);
      if (!manifest) return { ok: false, reason: 'manifest missing' };
      if (!manifest.path || !fsImpl.existsSync(manifest.path)) return { ok: false, reason: 'artifact file missing' };
      const content = await fsp.readFile(manifest.path);
      const sha256 = digestOf(content);
      if (sha256 !== manifest.sha256) {
        return { ok: false, reason: 'digest mismatch', expected: manifest.sha256, actual: sha256 };
      }
      if (content.length !== manifest.sizeBytes) {
        return { ok: false, reason: 'size mismatch', expected: manifest.sizeBytes, actual: content.length };
      }
      return { ok: true, sha256, sizeBytes: content.length };
    },
  };
}
