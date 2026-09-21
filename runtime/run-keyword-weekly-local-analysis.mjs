#!/usr/bin/env node
// 关键词周更「本地分析」的唯一入口：**先把该算的全在本机算完，再决定要不要传到飞书**。
//
// 为什么要有这个入口：
//   此前这条链的分析分两半、各有一个写入器，而且 AI 段的判定根本没进仓库 ——
//   规则段（4 个字段）由 `apply-local-keyword-analysis.mjs` 现场算；内容热度由会话里的探针脚本判。
//   结果就是「本地分析完了吗」这个问题没有单一答案，只能靠人记着哪一半跑过。
//   这里把两半合成一次分析、一份产物、一份清单，写入仍然各走各的写入器（白名单不合并）。
//
// 顺序是**有依赖的，不是习惯**：
//   规则段先算（`标准归并词`/`关键词分类`/`细分标签`/`用户意图`），
//   内容热度的判定读 `关键词分类` 与 `细分标签` —— 所以判定时用的是**本地算出来的那份**，
//   而不是表上可能还空着的那份（表上空着时直接判会整批落到「低」，那是静默的错，不是保守）。
//
// 默认 dry-run：只落产物与清单，不碰飞书。真写要 `--apply` + 两个精确确认。
//
// 用法：
//   node runtime/run-keyword-weekly-local-analysis.mjs \
//     --table-name '关键词分析 V1（2026-09-19）' --collection-date 2026-09-19 --batch-number 8 \
//     --expected-rows 300
//   [--output-dir runtime/keyword-weekly-runs]
//   [--apply --confirm-base <app-token> --confirm-table <table-id>]

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildContentHeatArtifact,
  buildContentHeatCsv,
} from './content-heat-judge.mjs';
import { readbackText } from './feishu-readback.mjs';
import { analyzeKeyword } from './local-keyword-analysis.mjs';
import { activeProfileName, envFilePath, keywordBaseToken } from './feishu-targets.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';

/** 本地要产出的全部分析字段。规则 4 个 + AI 1 个。 */
export const LOCAL_ANALYSIS_FIELDS = Object.freeze(['标准归并词', '关键词分类', '细分标签', '用户意图', '内容热度']);
export const RULE_FIELDS = Object.freeze(['标准归并词', '关键词分类', '细分标签', '用户意图']);

function optionKey(name) {
  return name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

export function parseOptions(argv, defaults = {}) {
  const options = { apply: false, expectedRows: 300, outputDir: 'runtime/keyword-weekly-runs', envFile: defaults.envFile, appToken: defaults.appToken };
  const values = new Set([
    'table-id', 'table-name', 'collection-date', 'batch-number', 'expected-rows', 'output-dir',
    'env-file', 'app-token', 'confirm-base', 'confirm-table',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (name === 'apply') { options.apply = true; continue; }
    if (!values.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options[optionKey(name)] = value;
    index += 1;
  }
  if (!options.tableName && !options.tableId) throw new Error('Provide --table-name (preferred) or --table-id');
  if (!options.collectionDate || !/^\d{4}-\d{2}-\d{2}$/u.test(options.collectionDate)) throw new Error('--collection-date must be YYYY-MM-DD');
  options.expectedRows = Number(options.expectedRows);
  options.batchNumber = Number(options.batchNumber ?? 0);
  if (!Number.isInteger(options.expectedRows) || options.expectedRows < 1) throw new Error('--expected-rows must be a positive integer');
  if (!Number.isInteger(options.batchNumber) || options.batchNumber < 1) throw new Error('--batch-number must be a positive integer');
  if (!options.envFile) throw new Error('No Feishu credential file resolved: pass --env-file or check runtime/feishu-targets.mjs');
  // 真写必须**点名那一串 table id**。只给表名不算确认：表名是每周新建的、可以同名，
  // 而 --confirm-table 的语义是「我确认写的是这一张」。分析（dry-run）不限，按名解析就够。
  if (options.apply && !options.tableId) throw new Error('Write mode requires --table-id (the exact table being written)');
  if (options.apply && options.confirmBase !== options.appToken) throw new Error('Write mode requires matching --confirm-base <app-token>');
  if (options.apply && options.confirmTable !== options.tableId) throw new Error('Write mode requires matching --confirm-table <table-id>');
  return options;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function histogram(values) {
  const counts = new Map();
  for (const value of values) {
    const key = Array.isArray(value) ? (value.length ? value.join('、') : '(空)') : (readbackText(value) || '(空)');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1]));
}

function isBlank(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

/**
 * 把本地规则段的产出合进记录：**只补空白的那些字段**，已有值原样保留。
 *
 * 为什么不无脑覆盖：规则段的写入约定就是「默认只填空白格」，
 * 分析侧如果用了「覆盖版」的值去判内容热度，就会和实际落库的那份对不上 ——
 * 判定依据与落库值必须是同一份。
 */
export function enrichRecordsWithLocalRules(records) {
  return records.map((record) => {
    const keyword = readbackText(record.fields?.['原始关键词']) || readbackText(record.fields?.['搜索词']);
    if (!keyword) throw new Error(`Record ${record.record_id} has no source keyword`);
    const analysis = analyzeKeyword(keyword);
    const fields = { ...(record.fields ?? {}) };
    const filledFrom = {};
    for (const name of RULE_FIELDS) {
      if (isBlank(fields[name])) { fields[name] = analysis[name]; filledFrom[name] = 'local-rule'; }
      else filledFrom[name] = 'table';
    }
    return { ...record, fields, __ruleSource: filledFrom };
  });
}

/** 本地分析（纯计算，无 IO）。返回产物与清单，便于在测试里用固定样本断言。 */
export function buildWeeklyLocalAnalysis({ table, fields, records, collectionDate, batchNumber, judgedAt }) {
  const enriched = enrichRecordsWithLocalRules(records);
  const contentHeatArtifact = buildContentHeatArtifact({
    tableId: table.table_id,
    tableName: table.name,
    appToken: table.appToken,
    records: enriched,
    judgedAt,
  });
  const byId = new Map(contentHeatArtifact.values.map((item) => [item.record_id, item]));
  const ruleValues = enriched.map((record) => ({
    record_id: record.record_id,
    搜索词: readbackText(record.fields['搜索词']) || readbackText(record.fields['原始关键词']),
    标准归并词: readbackText(record.fields['标准归并词']),
    关键词分类: readbackText(record.fields['关键词分类']),
    细分标签: record.fields['细分标签'],
    用户意图: readbackText(record.fields['用户意图']),
    内容热度: byId.get(record.record_id)?.['内容热度'] ?? '',
    规则来源: record.__ruleSource,
  }));
  const blankOnTable = Object.fromEntries(LOCAL_ANALYSIS_FIELDS.map((name) => [
    name,
    records.filter((record) => isBlank(record.fields?.[name])).length,
  ]));
  const manifest = {
    status: 'LOCAL_ANALYSIS_READY',
    collectionDate,
    batchNumber,
    table: { id: table.table_id, name: table.name, fields: fields.length },
    appToken: table.appToken,
    recordCount: records.length,
    fields: [...LOCAL_ANALYSIS_FIELDS],
    // 「表上还有几格是空的」——这是判断「这次本地分析有没有新东西可写」的直接依据，
    // 不去看写入器的自报数。
    blankOnTable,
    distributions: {
      关键词分类: histogram(ruleValues.map((item) => item.关键词分类)),
      用户意图: histogram(ruleValues.map((item) => item.用户意图)),
      细分标签: histogram(ruleValues.map((item) => item.细分标签)),
      内容热度: contentHeatArtifact.distribution,
      内容热度判定原因: contentHeatArtifact.reasonDistribution,
    },
    contentHeat: {
      status: contentHeatArtifact.status,
      judgeVersion: contentHeatArtifact.judgeVersion,
      promptDigest: contentHeatArtifact.promptDigest,
      recordCount: contentHeatArtifact.recordCount,
    },
    digests: {
      source: digest({ table: { id: table.table_id, name: table.name }, records }),
      ruleValues: digest(ruleValues),
      contentHeatArtifact: digest(contentHeatArtifact),
    },
    analyzedAt: judgedAt ?? new Date().toISOString(),
  };
  return { manifest, contentHeatArtifact, ruleValues, enriched };
}

function readEnv(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

class FeishuReader {
  #token;

  constructor({ appId, appSecret, appToken }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.appToken = appToken;
  }

  async authenticate() {
    const response = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error(`Feishu authentication failed: ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    this.#token = payload.tenant_access_token ?? payload.data?.tenant_access_token;
    if (!this.#token) throw new Error('Feishu authentication returned no token');
  }

  async request(requestPath) {
    const response = await fetch(`${API_ROOT}${requestPath}`, { headers: { Authorization: `Bearer ${this.#token}` } });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error(`Feishu read failed: ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    return payload.data ?? {};
  }

  async listTables() {
    const tables = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ page_size: '100' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.request(`/bitable/v1/apps/${this.appToken}/tables?${query}`);
      tables.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return tables;
  }

  async listFields(tableId) {
    return (await this.request(`/bitable/v1/apps/${this.appToken}/tables/${tableId}/fields?page_size=200`)).items ?? [];
  }

  async listRecords(tableId) {
    const records = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ page_size: '500' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.request(`/bitable/v1/apps/${this.appToken}/tables/${tableId}/records?${query}`);
      records.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return records;
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * 表解析：按名（首选）或按 id。两边都给时必须一致 ——
 * 名字与 id 各错一半是最难查的一类错（看着跑通了，其实写的是另一张表）。
 */
export function resolveTable(tables, { tableName, tableId }) {
  const byId = tableId ? tables.find((table) => table.table_id === tableId) : undefined;
  const byName = tableName ? tables.filter((table) => table.name === tableName) : [];
  if (tableName && byName.length > 1) throw new Error(`Multiple tables named ${tableName}`);
  const table = byId ?? byName[0];
  if (!table) throw new Error(`Table not found: ${tableName ?? tableId}`);
  if (tableName && table.name !== tableName) throw new Error(`Table identity mismatch: ${tableId} is ${table.name}, expected ${tableName}`);
  return table;
}

export async function main(argv = process.argv.slice(2)) {
  const profile = activeProfileName();
  const options = parseOptions(argv, { envFile: envFilePath(profile), appToken: keywordBaseToken(profile) });
  const env = readEnv(options.envFile);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');

  const reader = new FeishuReader({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, appToken: options.appToken });
  await reader.authenticate();
  const tables = await reader.listTables();
  // 表名带全角括号，`--table-name` 是中文参数；优先按名解析是为了让「写错表」在参数层就暴露，
  // 而不是靠人记得上周的 id。
  const resolved = resolveTable(tables, { tableName: options.tableName, tableId: options.tableId });
  const table = { table_id: resolved.table_id, name: resolved.name, appToken: options.appToken };
  const [fields, records] = await Promise.all([reader.listFields(table.table_id), reader.listRecords(table.table_id)]);
  if (records.length !== options.expectedRows) throw new Error(`Expected ${options.expectedRows} records; received ${records.length}`);

  const { manifest, contentHeatArtifact, ruleValues } = buildWeeklyLocalAnalysis({
    table, fields, records, collectionDate: options.collectionDate, batchNumber: options.batchNumber,
  });

  const runDir = path.resolve(options.outputDir, `${options.collectionDate}-batch-${options.batchNumber}-${table.table_id}`);
  fs.mkdirSync(runDir, { recursive: true });
  const files = {
    snapshot: path.join(runDir, 'source-snapshot.json'),
    contentHeatArtifact: path.join(runDir, 'content-heat-artifact.json'),
    contentHeatCsv: path.join(runDir, 'content-heat-analysis.csv'),
    ruleValues: path.join(runDir, 'rule-values.json'),
    manifest: path.join(runDir, 'manifest.json'),
  };
  writeJson(files.snapshot, { table, fields, records });
  writeJson(files.contentHeatArtifact, contentHeatArtifact);
  fs.writeFileSync(files.contentHeatCsv, buildContentHeatCsv(contentHeatArtifact.values), 'utf8');
  writeJson(files.ruleValues, ruleValues);
  writeJson(files.manifest, { ...manifest, files });

  const analysis = { status: manifest.status, runDir, files, ...manifest };

  if (!options.apply) {
    console.log(JSON.stringify(analysis, null, 2));
    return analysis;
  }

  // 真写：两个写入器各带自己的变异白名单，**不合并**。合并等于把两条白名单并成一条更宽的，
  // 而它们各自能写的字段本来就不一样（规则段 4 个，内容热度 1 个）。
  const { main: applyRuleMain } = await import('./apply-local-keyword-analysis.mjs');
  const { main: applyContentHeatMain } = await import('./apply-content-heat.mjs');
  const ruleResult = await applyRuleMain([
    '--app-token', options.appToken,
    '--table-id', table.table_id,
    '--table-name', table.name,
    '--env-file', options.envFile,
    '--expected-rows', String(options.expectedRows),
    '--apply', '--confirm-base', options.appToken, '--confirm-table', table.table_id,
  ]);
  const heatResult = await applyContentHeatMain([
    '--artifact', files.contentHeatArtifact,
    '--table-id', table.table_id,
    '--table-name', table.name,
    '--expected-rows', String(options.expectedRows),
    '--apply', '--confirm-base', options.appToken, '--confirm-table', table.table_id,
  ]);

  // 独立回读：不采信写入器的自报，重新读一遍表，逐字段数「有几格有值」。
  const afterRecords = await reader.listRecords(table.table_id);
  const afterFilled = Object.fromEntries(LOCAL_ANALYSIS_FIELDS.map((name) => [
    name, afterRecords.filter((record) => !isBlank(record.fields?.[name])).length,
  ]));
  const stillBlank = Object.entries(afterFilled).filter(([, count]) => count !== afterRecords.length);
  const receipt = {
    status: stillBlank.length === 0 ? 'APPLIED_AND_READBACK_VERIFIED' : 'APPLIED_WITH_BLANKS',
    collectionDate: options.collectionDate,
    batchNumber: options.batchNumber,
    table,
    expectedRows: options.expectedRows,
    readbackRows: afterRecords.length,
    filledAfterApply: afterFilled,
    stillBlank,
    rule: { status: ruleResult.status, fieldsWritten: ruleResult.fieldsWritten, receiptFile: ruleResult.receiptFile },
    contentHeat: { status: heatResult.status, fieldsWritten: heatResult.fieldsWritten, receiptFile: heatResult.receiptFile },
    analysisManifest: files.manifest,
  };
  writeJson(path.join(runDir, 'publish-receipt.json'), receipt);
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
