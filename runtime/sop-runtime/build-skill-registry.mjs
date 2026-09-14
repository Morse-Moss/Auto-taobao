#!/usr/bin/env node
// 阶段 3 验收命令：发现 skills/* 的 manifest、构建并校验 Registry、可选落盘索引。
// 用法：
//   node runtime/sop-runtime/build-skill-registry.mjs --check
//   node runtime/sop-runtime/build-skill-registry.mjs --write [--json]
// 退出码：0 通过；1 Registry 校验失败；2 manifest 解析/文件缺失。
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSkillManifests, DEFAULT_SKILLS_ROOT } from './skill-discovery.mjs';
import { createRegistry } from './skill-registry.mjs';
import { createLoader } from './skill-loader.mjs';

// 共享浏览器代理（web-access CDP）不在仓库内，作为显式外部依赖登记。
const EXTERNAL_ALLOWLIST = ['adapter.browser'];
const DEFAULT_INDEX_PATH = fileURLToPath(new URL('./skill-registry.index.json', import.meta.url));

function parseArgs(argv) {
  const args = { check: false, write: false, json: false, index: DEFAULT_INDEX_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--check') args.check = true;
    else if (token === '--write') args.write = true;
    else if (token === '--json') args.json = true;
    else if (token === '--index') args.index = argv[++i];
    else if (token === '--help' || token === '-h') args.help = true;
  }
  if (!args.check && !args.write) args.check = true;
  return args;
}

export async function buildRegistryFromDisk({ skillsRoot = DEFAULT_SKILLS_ROOT } = {}) {
  const discovery = await discoverSkillManifests({ skillsRoot });
  const registry = createRegistry({ externalAllowlist: EXTERNAL_ALLOWLIST });
  for (const item of discovery.found) {
    registry.add({ manifest: item.manifest, skillDir: item.skillDir, sourcePath: item.sourcePath });
  }
  const result = registry.finalize();

  // 入口文件存在性 + 实际实现摘要（漂移基线）。
  const loader = createLoader({ registry });
  const entryProblems = [];
  const implementationDigests = {};
  for (const entry of registry.list()) {
    const name = entry.manifest.name;
    let abs;
    try {
      abs = loader.resolvePath(entry);
    } catch (error) {
      entryProblems.push({ code: error.code ?? 'ENTRY_RESOLVE_FAILED', name, detail: String(error.message) });
      continue;
    }
    if (!existsSync(abs)) {
      entryProblems.push({ code: 'ENTRY_FILE_MISSING', name, detail: abs });
      continue;
    }
    const hash = createHash('sha256').update(await readFile(abs)).digest('hex');
    implementationDigests[name] = `sha256:${hash}`;
  }

  return { discovery, registry, result, entryProblems, implementationDigests };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('usage: build-skill-registry.mjs [--check] [--write] [--json] [--index <path>]\n');
    return 0;
  }

  const { discovery, registry, result, entryProblems, implementationDigests } = await buildRegistryFromDisk();

  if (discovery.errors.length) {
    process.stderr.write(`manifest 解析失败 ${discovery.errors.length} 项：\n`);
    for (const error of discovery.errors) process.stderr.write(`  ${error.code} ${error.source} :: ${error.detail}\n`);
  }

  process.stdout.write(`发现 manifest ${discovery.found.length} 个，注册条目 ${registry.size()} 个（能力 ${registry.list({ kind: 'capability' }).length}，适配器 ${registry.list({ kind: 'adapter' }).length}）\n`);
  for (const name of registry.names()) {
    process.stdout.write(`  ${name}@${registry.versionsOf(name).join(',')}${implementationDigests[name] ? '' : '  [无实现摘要]'}\n`);
  }

  if (result.warnings.length) {
    process.stdout.write(`告警 ${result.warnings.length} 项：\n`);
    for (const warning of result.warnings) process.stdout.write(`  ${warning.code} ${warning.source} :: ${warning.detail}\n`);
  }

  if (result.errors.length || entryProblems.length) {
    process.stderr.write(`\nRegistry 校验失败：manifest 错误 ${result.errors.length} 项，入口问题 ${entryProblems.length} 项\n`);
    for (const error of result.errors) process.stderr.write(`  ${error.code} ${error.source} :: ${error.detail}\n`);
    for (const problem of entryProblems) process.stderr.write(`  ${problem.code} ${problem.name} :: ${problem.detail}\n`);
    return discovery.errors.length || entryProblems.length ? 2 : 1;
  }

  const index = registry.index();
  index.entries = index.entries.map((entry) => ({ ...entry, implementationDigest: implementationDigests[entry.name] ?? null }));

  if (args.json) process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
  else process.stdout.write(`Registry 校验通过，registryDigest=${index.registryDigest}\n`);

  if (args.write) {
    await writeFile(args.index, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    process.stdout.write(`索引已写入 ${path.relative(process.cwd(), args.index)}\n`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exit(2);
    });
}
