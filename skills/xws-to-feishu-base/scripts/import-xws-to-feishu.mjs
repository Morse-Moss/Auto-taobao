#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FeishuClient } from './feishu-client.mjs';
import { parseBaseUrl } from './import-core.mjs';
import { runImport } from './import-runner.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));

export function parseCliArgs(argv) {
  const options = { commit: false, prepareTarget: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--commit') options.commit = true;
    else if (arg === '--prepare-target') options.prepareTarget = true;
    else if (['--xlsx', '--base-url', '--env-file', '--work-dir', '--python'].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.xlsx) throw new Error('--xlsx is required');
  if (!options.baseUrl) throw new Error('--base-url is required');
  if (options.commit && !options.envFile) throw new Error('--env-file is required with --commit');
  if (options.prepareTarget && !options.commit) throw new Error('--prepare-target requires --commit');
  return options;
}

function parseEnvFile(path) {
  const values = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function extractManifest({ xlsx, outputDir, python }) {
  const script = resolve(scriptDir, 'extract_xws_xlsx.py');
  const command = python ?? (process.platform === 'win32' ? 'py' : 'python3');
  const args = [...(python || process.platform !== 'win32' ? [] : ['-3']), script, xlsx, outputDir];
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`XLSX extraction failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return JSON.parse(result.stdout);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  const xlsx = resolve(options.xlsx);
  if (!existsSync(xlsx)) throw new Error(`XLSX file not found: ${xlsx}`);
  const target = parseBaseUrl(options.baseUrl);
  const workDir = resolve(options.workDir ?? `runtime/xws-feishu-${basename(xlsx, '.xlsx')}`);
  const imageDir = resolve(workDir, 'images');
  await mkdir(workDir, { recursive: true });
  const manifest = extractManifest({ xlsx, outputDir: imageDir, python: options.python });

  let client;
  if (options.commit) {
    const envPath = resolve(options.envFile);
    if (!existsSync(envPath)) throw new Error(`Environment file not found: ${envPath}`);
    const env = parseEnvFile(envPath);
    if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
      throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
    }
    client = new FeishuClient({
      appId: env.FEISHU_APP_ID,
      appSecret: env.FEISHU_APP_SECRET,
      ...target,
    });
  }

  const result = await runImport({
    manifest,
    client,
    commit: options.commit,
    prepareTarget: options.prepareTarget,
  });
  const report = {
    source: xlsx,
    target: options.baseUrl,
    workDir,
    ...result,
  };
  writeFileSync(resolve(workDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  return report;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
