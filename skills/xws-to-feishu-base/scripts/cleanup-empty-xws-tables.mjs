#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CompetitorV2FeishuClient } from './import-competitor-v2.mjs';
import { parseBaseUrl } from './import-core.mjs';

export const ALLOWED_CLEANUP_TABLE_NAMES = new Set([
  'XWS API Stability Round 1',
  'XWS API Stability Round 2',
  'XWS API Stability Round 3',
  'XWS Round 1 Price High Top 138',
  'XWS Round 2 Price High Top 138',
  'XWS Round 3 Price High Top 138',
]);

function readEnv(path) {
  const values = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

export function parseCleanupArgs(argv) {
  const options = { tableNames: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base-url' || arg === '--env-file' || arg === '--confirm-app-token' || arg === '--table-name') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--table-name') options.tableNames.push(value);
      else options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.baseUrl) throw new Error('--base-url is required');
  if (!options.envFile) throw new Error('--env-file is required');
  if (!options.confirmAppToken) throw new Error('--confirm-app-token is required');
  if (options.tableNames.length === 0) throw new Error('--table-name is required');
  for (const name of options.tableNames) {
    if (!ALLOWED_CLEANUP_TABLE_NAMES.has(name)) throw new Error(`Table name is not allowlisted: ${name}`);
  }
  const target = parseBaseUrl(options.baseUrl);
  if (options.confirmAppToken !== target.appToken) {
    throw new Error('--confirm-app-token does not match the Base URL app token');
  }
  return { ...options, target };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCleanupArgs(argv);
  const envPath = resolve(options.envFile);
  if (!existsSync(envPath)) throw new Error(`Environment file not found: ${envPath}`);
  const env = readEnv(envPath);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    throw new Error('Environment file must define FEISHU_APP_ID and FEISHU_APP_SECRET');
  }
  const client = new CompetitorV2FeishuClient({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    appToken: options.target.appToken,
  });
  await client.authenticate();
  const tables = await client.listTables();
  const deleted = [];
  for (const name of options.tableNames) {
    const matches = tables.filter((table) => table.name === name);
    if (matches.length !== 1) throw new Error(`Expected exactly one table named ${name}; found ${matches.length}`);
    const tableId = matches[0].tableId ?? matches[0].table_id;
    const records = await client.listRecords(tableId);
    if (records.length !== 0) throw new Error(`Refusing to delete non-empty table ${name}: ${records.length} records`);
    await client.deleteTable(tableId);
    deleted.push({ name, tableId });
  }
  const result = { base: options.target.appToken, deleted };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
