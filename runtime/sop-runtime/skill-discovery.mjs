// Skill Discovery：从 skills/* 目录发现机器可读 manifest（只读，不执行 Skill 业务代码）。
// 默认只读 manifest.json；manifest.mjs 属于可执行代码，需显式开启 allowModuleManifests。
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const DEFAULT_SKILLS_ROOT = fileURLToPath(new URL('../../skills/', import.meta.url));

export class SkillDiscoveryError extends Error {
  constructor(message, { code = 'SKILL_DISCOVERY_ERROR', details = {} } = {}) {
    super(`${code}: ${message}`);
    this.name = 'SkillDiscoveryError';
    this.code = code;
    this.details = details;
  }
}

export const MANIFEST_JSON_NAME = 'manifest.json';
export const MANIFEST_MODULE_NAME = 'manifest.mjs';

// 一个技能目录可以登记多个 manifest：能力本体 manifest.json，
// 以及伴随适配器 <name>.manifest.json（例如 adapter.feishu.manifest.json）。
function jsonManifestNames(entries) {
  return entries
    .filter((item) => item.isFile() && (item.name === MANIFEST_JSON_NAME || item.name.endsWith('.manifest.json')))
    .map((item) => item.name)
    .sort((a, b) => (a === MANIFEST_JSON_NAME ? -1 : b === MANIFEST_JSON_NAME ? 1 : a.localeCompare(b)));
}

// 返回 { found, errors, root }；解析失败的目录以 errors 返回，不静默跳过。
export async function discoverSkillManifests({
  skillsRoot = DEFAULT_SKILLS_ROOT,
  allowModuleManifests = false,
  dirs = null,
} = {}) {
  const root = path.resolve(skillsRoot);
  if (!existsSync(root)) {
    throw new SkillDiscoveryError(`skills root not found: ${root}`, { code: 'SKILLS_ROOT_MISSING' });
  }

  const names = dirs ?? (await readdir(root, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort();

  const found = [];
  const errors = [];

  for (const name of names) {
    const skillDir = path.join(root, name);
    let dirEntries;
    try {
      dirEntries = await readdir(skillDir, { withFileTypes: true });
    } catch (error) {
      errors.push({ code: 'SKILL_DIR_UNREADABLE', source: skillDir, detail: String(error?.message ?? error) });
      continue;
    }

    const jsonNames = jsonManifestNames(dirEntries);
    for (const fileName of jsonNames) {
      const sourcePath = path.join(skillDir, fileName);
      try {
        const manifest = JSON.parse(await readFile(sourcePath, 'utf8'));
        found.push({ manifest, skillDir, sourcePath });
      } catch (error) {
        errors.push({ code: 'MANIFEST_PARSE_FAILED', source: sourcePath, detail: String(error?.message ?? error) });
      }
    }

    if (!jsonNames.length && allowModuleManifests) {
      const modulePath = path.join(skillDir, MANIFEST_MODULE_NAME);
      if (existsSync(modulePath)) {
        try {
          const module = await import(pathToFileURL(modulePath).href);
          const manifest = module.default ?? module.manifest;
          if (!manifest) throw new Error('manifest.mjs must export default manifest object');
          found.push({ manifest, skillDir, sourcePath: modulePath });
        } catch (error) {
          errors.push({ code: 'MANIFEST_PARSE_FAILED', source: modulePath, detail: String(error?.message ?? error) });
        }
      }
    }
  }

  return { found, errors, root };
}
