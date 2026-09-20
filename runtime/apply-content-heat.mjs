#!/usr/bin/env node
// 内容热度写入器（AI 段）。只写 `内容热度` 一个字段，默认 dry-run。
//
// 与规则段写入器（apply-local-keyword-analysis.mjs）同一套安全约定：
//   - 变异白名单：只允许对确认过的 base/表的 records/batch_update 下手，且每条只含一个字段；
//   - 字段合同在 dry-run 之前就校验：类型可写、值域合法（含显式拒绝老口径 `AI预测-` 前缀）、
//     单选字段的选项必须已经存在；
//   - 真写时 canary 单条先写 → 回读 → 再写其余 → 全量回读；
//   - 字段定义（字段清单）在写入前后必须逐字节一致；
//   - 收据里的每一个值都经 readbackText 归一，**不允许出现 `[object Object]`**。
//
// 用法：
//   node runtime/apply-content-heat.mjs --artifact <analysis.json> \
//     --table-id <tbl...> --table-name '<表名>' [--apply --confirm-base <app> --confirm-table <tbl>]
//   不传 --apply 就是 dry-run，只落 before/plan 两个文件，不碰飞书。
//   `--env-file` / `--app-token` 默认取自 runtime/feishu-targets.mjs 的当前 profile：
//   **不许把租户凭据路径或 base id 写死在脚本里**（历史上写死旧租户导致过 91403 Forbidden）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTENT_HEAT_ARTIFACT_STATUS,
  CONTENT_HEAT_FIELD,
  assertContentHeatMutation,
  buildContentHeatPlan,
  contentHeatDigest,
  contentHeatDistribution,
  contentHeatPlannedDistribution,
  validateContentHeatContract,
  verifyContentHeatApply,
} from './content-heat-apply.mjs';
import { readbackText } from './feishu-readback.mjs';
import { activeProfileName, envFilePath, keywordBaseToken } from './feishu-targets.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';

function optionKey(name) {
  return name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

export function parseOptions(argv, defaults = {}) {
  const options = {
    apply: false,
    replaceContentHeat: false,
    allowPartial: false,
    expectedRows: 300,
    outputDir: 'runtime/content-heat-runs',
    envFile: defaults.envFile,
    appToken: defaults.appToken,
  };
  const flags = new Set(['apply', 'replace-content-heat', 'allow-partial']);
  const values = new Set([
    'artifact', 'app-token', 'table-id', 'table-name', 'env-file',
    'expected-rows', 'output-dir', 'confirm-base', 'confirm-table',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (flags.has(name)) {
      options[optionKey(name)] = true;
      continue;
    }
    if (!values.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options[optionKey(name)] = value;
    index += 1;
  }
  const missing = ['artifact', 'tableId', 'tableName'].filter((name) => !options[name]);
  if (missing.length) throw new Error(`Missing required options: ${missing.join(', ')}`);
  if (!options.envFile) throw new Error('No Feishu credential file resolved: pass --env-file or check runtime/feishu-targets.mjs');
  options.expectedRows = Number(options.expectedRows);
  if (!Number.isInteger(options.expectedRows) || options.expectedRows < 1) {
    throw new Error('--expected-rows must be a positive integer');
  }
  if (options.apply && options.confirmBase !== options.appToken) {
    throw new Error('Write mode requires matching --confirm-base <app-token>');
  }
  if (options.apply && options.confirmTable !== options.tableId) {
    throw new Error('Write mode requires matching --confirm-table <table-id>');
  }
  return options;
}

function readEnv(file) {
  const values = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

export function readArtifact(file) {
  const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (artifact?.status !== CONTENT_HEAT_ARTIFACT_STATUS) {
    throw new Error(`Artifact status is ${artifact?.status ?? '(none)'}; expected ${CONTENT_HEAT_ARTIFACT_STATUS}`);
  }
  return artifact;
}

class FeishuApi {
  #token;

  constructor({ appId, appSecret, appToken, mutationGuard }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.appToken = appToken;
    this.mutationGuard = mutationGuard;
  }

  async authenticate() {
    const response = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      throw new Error(`Feishu authentication failed: ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    }
    this.#token = payload.tenant_access_token ?? payload.data?.tenant_access_token;
    if (!this.#token) throw new Error('Feishu authentication returned no token');
  }

  async request(method, requestPath, body) {
    if (method !== 'GET') this.mutationGuard({ method, path: requestPath, body });
    const response = await fetch(`${API_ROOT}${requestPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      throw new Error(`Feishu API failed: ${method} ${requestPath} ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    }
    return payload.data ?? {};
  }

  async listTables() {
    return (await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables?page_size=100`)).items ?? [];
  }

  async listFields(tableId) {
    return (await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/fields?page_size=100`)).items ?? [];
  }

  async listRecords(tableId) {
    const records = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ page_size: '500' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.request('GET', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/records?${query}`);
      records.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return records;
  }

  async batchUpdate(tableId, records) {
    for (let index = 0; index < records.length; index += 500) {
      await this.request('POST', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/records/batch_update`, {
        records: records.slice(index, index + 500),
      });
    }
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

export async function main(argv = process.argv.slice(2)) {
  // 默认租户作用域**只从登记表访问器取**，两个字面量都不许出现在这个文件里。
  // 与 skills 侧 4 个入口脚本同一约定：写死字面量在 base 搬家后会变成 91403 Forbidden，
  // 而那看着像「应用没被加为协作者」的权限问题（2026-09-20 实测过这个假故障）。
  const options = parseOptions(argv, {
    envFile: envFilePath(activeProfileName()),
    appToken: keywordBaseToken(activeProfileName()),
  });
  const artifact = readArtifact(options.artifact);

  // 产物必须声明它是为**哪张表**判的。防止把上一周的分析写进这一周的表。
  if (artifact.tableId && artifact.tableId !== options.tableId) {
    throw new Error(`Artifact was judged for ${artifact.tableId} but target is ${options.tableId}`);
  }

  const env = readEnv(options.envFile);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const scope = { appToken: options.appToken, tableId: options.tableId };
  const api = new FeishuApi({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    appToken: options.appToken,
    mutationGuard: (request) => assertContentHeatMutation(request, scope),
  });
  await api.authenticate();
  const [tables, fields, records] = await Promise.all([
    api.listTables(), api.listFields(options.tableId), api.listRecords(options.tableId),
  ]);
  const table = tables.find((item) => item.table_id === options.tableId);
  if (!table || table.name !== options.tableName) throw new Error(`Confirmed table identity mismatch: ${options.tableId}`);
  if (records.length !== options.expectedRows) {
    throw new Error(`Expected ${options.expectedRows} records; received ${records.length}`);
  }

  const generated = [...new Set(artifact.values.map((item) => item[CONTENT_HEAT_FIELD]))];
  validateContentHeatContract(fields, generated);
  const plan = buildContentHeatPlan(records, artifact, {
    replaceFields: options.replaceContentHeat ? [CONTENT_HEAT_FIELD] : [],
    allowPartial: options.allowPartial,
  });
  const fieldDigestBefore = contentHeatDigest(fields);
  const summary = {
    recordCount: records.length,
    judgedRecords: plan.judgedRecords,
    recordsPlanned: plan.updates.length,
    preservedExisting: plan.preservedExisting,
    coveredAllRecords: plan.coveredAllRecords,
    distributions: {
      [CONTENT_HEAT_FIELD]: contentHeatDistribution(records, readbackText),
      // 这里必须传**产物原始数组**（走 contentHeatPlannedDistribution），
      // 不能传上面那个去重过的 `generated` —— 那会把「各档多少条」变成「有几种值」。
      planned: contentHeatPlannedDistribution(artifact, readbackText),
    },
  };

  const runDir = path.resolve(options.outputDir, `${stamp()}-${options.tableId}`);
  fs.mkdirSync(runDir, { recursive: true });
  const beforeFile = path.join(runDir, 'before.json');
  const planFile = path.join(runDir, 'plan.json');
  fs.writeFileSync(beforeFile, `${JSON.stringify({ table, fields, records }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(planFile, `${JSON.stringify({ summary, updates: plan.updates }, null, 2)}\n`, 'utf8');

  if (!options.apply) {
    console.log(JSON.stringify({ status: 'DRY_RUN', ...summary, beforeFile, planFile }, null, 2));
    return;
  }

  const derivedFields = fields.filter((field) => field.type === 20).map((field) => field.field_name);

  const canary = plan.updates.slice(0, 1);
  if (canary.length) {
    await api.batchUpdate(options.tableId, canary);
    const canaryRecords = await api.listRecords(options.tableId);
    const canaryFields = await api.listFields(options.tableId);
    if (contentHeatDigest(fields) !== contentHeatDigest(canaryFields)) {
      throw new Error('Content heat canary changed field definitions');
    }
    verifyContentHeatApply({ before: records, after: canaryRecords, updates: canary, derivedFields });
  }

  await api.batchUpdate(options.tableId, plan.updates.slice(canary.length));
  const afterRecords = await api.listRecords(options.tableId);
  const afterFields = await api.listFields(options.tableId);
  if (contentHeatDigest(fields) !== contentHeatDigest(afterFields)) {
    throw new Error('Content heat apply changed field definitions');
  }
  const verification = verifyContentHeatApply({
    before: records, after: afterRecords, updates: plan.updates, derivedFields,
  });

  const afterFile = path.join(runDir, 'after.json');
  const receiptFile = path.join(runDir, 'receipt.json');
  fs.writeFileSync(afterFile, `${JSON.stringify({ table, fields: afterFields, records: afterRecords }, null, 2)}\n`, 'utf8');
  const receipt = {
    status: plan.coveredAllRecords ? 'APPLIED_AND_VERIFIED' : 'APPLIED_PARTIAL_CONTENT_HEAT',
    appToken: options.appToken,
    tableId: options.tableId,
    tableName: options.tableName,
    artifact: path.resolve(options.artifact),
    artifactDigest: contentHeatDigest(artifact),
    fieldDigestBefore,
    ...summary,
    ...verification,
    derivedFieldsAllowedToChange: derivedFields,
    distributionAfter: contentHeatDistribution(afterRecords, readbackText),
    beforeFile,
    planFile,
    afterFile,
  };
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ...receipt, receiptFile }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
