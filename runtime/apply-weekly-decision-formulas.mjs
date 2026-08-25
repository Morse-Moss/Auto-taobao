#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDecisionFormulaPlan,
  buildSearchHeatFormulaPlan,
  filterChangedFormulaPlan,
  verifyDecisionFormulaFields,
} from './keyword-decision-formulas.mjs';
import {
  assertDecisionSchemaMutation,
  buildDecisionSchemaPlan,
  verifyDecisionSchemaMigration,
} from './keyword-decision-schema.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const PRODUCT_DIRECTION_FIELD = '对应产品方向';
const PRODUCT_DIRECTION_BACKUP_FIELD = '__对应产品方向_旧AI备份';
const PRODUCT_DIRECTION_TEMP_FIELD = '__对应产品方向_新公式';

function optionKey(name) {
  return name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

export function parseOptions(argv) {
  const options = {
    apply: false,
    searchHeatOnly: false,
    envFile: 'E:/小红书/.env.local',
    backupDir: 'runtime/keyword-analysis-backups',
  };
  const values = new Set([
    'base-url', 'table-id', 'table-name', 'env-file', 'backup-dir', 'receipt-file',
    'confirm-base', 'confirm-table',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (name === 'apply' || name === 'search-heat-only') {
      options[optionKey(name)] = true;
      continue;
    }
    if (!values.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options[optionKey(name)] = value;
    index += 1;
  }
  const missing = ['baseUrl', 'tableId', 'tableName'].filter((name) => !options[name]);
  if (missing.length) throw new Error(`Missing required options: ${missing.join(', ')}`);
  const parsed = new URL(options.baseUrl);
  const match = parsed.pathname.match(/^\/base\/([^/]+)$/u);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.feishu.cn') || !match) {
    throw new Error('Base URL must be an https://*.feishu.cn/base/<app-token> URL');
  }
  options.appToken = match[1];
  if (options.apply && options.confirmBase !== options.appToken) {
    throw new Error(`--apply requires --confirm-base ${options.appToken}`);
  }
  if (options.apply && options.confirmTable !== options.tableId) {
    throw new Error(`--apply requires --confirm-table ${options.tableId}`);
  }
  return options;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export function assertFormulaMutation({ method, path: requestPath, body }, scope) {
  if (method === 'GET') return;
  const update = scope.plan.updates.find((item) =>
    method === 'PUT' &&
    requestPath === `/bitable/v1/apps/${scope.appToken}/tables/${scope.tableId}/fields/${item.fieldId}` &&
    same(body, item.body));
  if (!update) throw new Error(`Blocked unauthorized formula mutation: ${method} ${requestPath}`);
}

export function assertWeeklyDecisionMutation(request, scope) {
  if (request.method === 'GET') return;
  const replacement = scope.directionReplacement;
  const root = `/bitable/v1/apps/${scope.appToken}/tables/${scope.tableId}/fields`;
  if (replacement) {
    if (replacement.renameOld && request.method === 'PUT' && request.path === `${root}/${replacement.oldFieldId}` &&
        (same(request.body, replacement.renameOld.body) || same(request.body, replacement.rollbackOld.body))) return;
    if (request.method === 'POST' && request.path === `${root}` && same(request.body, replacement.createNew.body)) return;
    if (request.method === 'DELETE' && replacement.canDeleteOld &&
        request.path === `${root}/${replacement.oldFieldId}`) return;
    if (request.method === 'DELETE' && replacement.canDeleteNew &&
        request.path === `${root}/${replacement.newFieldId}`) return;
    if (replacement.promoteNew && replacement.canPromoteNew && request.method === 'PUT' &&
        request.path === `${root}/${replacement.newFieldId}` && same(request.body, replacement.promoteNew.body)) return;
  }
  try {
    assertFormulaMutation(request, scope);
    return;
  } catch {
    // The same guarded client also performs the explicitly planned schema delta.
  }
  try {
    assertDecisionSchemaMutation({ ...request, appToken: scope.appToken, tableId: scope.tableId, plan: scope.schemaPlan });
    return;
  } catch {
    throw new Error(`Blocked unauthorized weekly decision mutation: ${request.method} ${request.path}`);
  }
}

export function buildDirectionReplacementPlan({ field, formulaUpdate }) {
  if (!field || !formulaUpdate?.body?.property?.formula_expression) {
    throw new Error('Product direction field and formula update are required');
  }
  if (field.type === 20) return null;
  if (![1, 25].includes(field.type) || field.field_name !== PRODUCT_DIRECTION_FIELD) {
    throw new Error(`Product direction field must be text type 1 or AI type 25; received ${field.field_name}/${field.type}`);
  }
  if (field.type === 25) {
    return {
      strategy: 'temporary-formula-first',
      oldFieldId: field.field_id,
      backupName: null,
      renameOld: null,
      rollbackOld: null,
      createNew: {
        fieldName: PRODUCT_DIRECTION_TEMP_FIELD,
        body: {
          ...structuredClone(formulaUpdate.body),
          field_name: PRODUCT_DIRECTION_TEMP_FIELD,
        },
      },
      promoteNew: {
        body: structuredClone(formulaUpdate.body),
      },
      canDeleteOld: false,
      canDeleteNew: false,
      canPromoteNew: false,
      newFieldId: null,
    };
  }
  return {
    strategy: 'rename-old-first',
    oldFieldId: field.field_id,
    backupName: PRODUCT_DIRECTION_BACKUP_FIELD,
    renameOld: {
      fieldId: field.field_id,
      body: { field_name: PRODUCT_DIRECTION_BACKUP_FIELD, type: 1 },
    },
    rollbackOld: {
      fieldId: field.field_id,
      body: { field_name: PRODUCT_DIRECTION_FIELD, type: 1 },
    },
    createNew: {
      fieldName: PRODUCT_DIRECTION_FIELD,
      body: structuredClone(formulaUpdate.body),
    },
    promoteNew: null,
    canDeleteOld: false,
    canDeleteNew: false,
    canPromoteNew: false,
    newFieldId: null,
  };
}

export function prepareDecisionFormulaApplyPlan({ fields, plan }) {
  const directionUpdate = plan.updates.find((item) => item.fieldName === PRODUCT_DIRECTION_FIELD);
  if (!directionUpdate) return { plan: { updates: [...plan.updates] }, directionReplacement: null };
  const directionField = fields.find((field) => field.field_name === PRODUCT_DIRECTION_FIELD);
  const directionReplacement = buildDirectionReplacementPlan({
    field: directionField,
    formulaUpdate: directionUpdate,
  });
  if (!directionReplacement) return { plan: { updates: [...plan.updates] }, directionReplacement: null };
  return {
    plan: {
      updates: plan.updates.filter((item) => item.fieldName !== PRODUCT_DIRECTION_FIELD),
    },
    directionReplacement,
  };
}

export function prepareFormulaApplyPlan({ fields, plan, searchHeatOnly = false }) {
  return searchHeatOnly
    ? { plan, directionReplacement: null }
    : prepareDecisionFormulaApplyPlan({ fields, plan });
}

export function assertSupportedRepairPlan(plan) {
  const allowed = new Set([
    '搜索热度', '交易热度',
    '近2周重点达标次数', '近2周A级达标次数', '近2周探索达标次数',
    '是否重点词', '优先级', '对应产品方向',
  ]);
  const unsupported = (plan?.updates ?? []).filter((update) => !allowed.has(update.fieldName));
  if (unsupported.length) {
    throw new Error(`unsupported formula repair: ${unsupported.map((update) => update.fieldName).join(', ')}`);
  }
}

function canonicalRecords(records, ignoredFields) {
  return [...records].map((record) => ({
    record_id: record.record_id,
    fields: Object.fromEntries(Object.entries(record.fields ?? {})
      .filter(([name, value]) => !ignoredFields.has(name) && value != null)
      .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))),
  })).sort((left, right) => left.record_id.localeCompare(right.record_id));
}

export function verifyTargetFormulaApply({ tableId, beforeFields, afterFields, beforeRecords, afterRecords, plan }) {
  if (beforeRecords.length !== afterRecords.length) throw new Error('Formula migration changed the record count');
  const ignored = new Set(plan.updates.map((item) => item.fieldName));
  if (!same(canonicalRecords(beforeRecords, ignored), canonicalRecords(afterRecords, ignored))) {
    throw new Error('Formula migration changed business record data');
  }
  const verification = verifyDecisionFormulaFields({ tableId, before: beforeFields, after: afterFields, plan });
  return { fieldsUpdated: verification.formulaFieldsUpdated, recordsWritten: 0 };
}

export function verifySchemaStage({
  tableId,
  beforeFields,
  afterFields,
  beforeRecords,
  afterRecords,
  schemaPlan,
  searchHeatOnly = false,
}) {
  if (!searchHeatOnly) {
    return verifyDecisionSchemaMigration({
      before: { fields: beforeFields, records: beforeRecords },
      after: { fields: afterFields, records: afterRecords },
      plan: schemaPlan,
    });
  }
  verifyTargetFormulaApply({
    tableId,
    beforeFields,
    afterFields,
    beforeRecords,
    afterRecords,
    plan: { updates: [] },
  });
  return { fieldsRenamed: 0, fieldsCreated: 0, recordsWritten: 0 };
}

function plain(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(plain).join(',');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '').trim();
  return String(value).trim();
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
    if (!response.ok || payload.code !== 0) throw new Error(`Feishu authentication failed: ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
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
    if (!response.ok || payload.code !== 0) throw new Error(`Feishu API failed: ${method} ${requestPath} ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
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

  createField(tableId, create) {
    return this.request('POST', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/fields`, create.body);
  }

  deleteField(tableId, fieldId) {
    return this.request('DELETE', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/fields/${fieldId}`);
  }

  updateField(tableId, update) {
    return this.request('PUT', `/bitable/v1/apps/${this.appToken}/tables/${tableId}/fields/${update.fieldId}`, update.body);
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function writeBackup(options, fields, records) {
  const directory = path.resolve(options.backupDir);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `weekly-decision-formulas-before-${timestamp()}.json`);
  const content = `${JSON.stringify({
    createdAt: new Date().toISOString(),
    purpose: 'weekly decision formula update',
    appToken: options.appToken,
    tableId: options.tableId,
    fields,
    records,
  }, null, 2)}\n`;
  fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
  return { file, sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

function formulaDistribution(records, name) {
  const counts = new Map();
  for (const record of records) {
    const value = plain(record.fields?.[name]) || '<empty>';
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right, 'zh-CN')));
}

export function formulaInputsSettled(records, directionFieldName = PRODUCT_DIRECTION_FIELD, searchHeatOnly = false) {
  for (const record of records) {
    const fields = record.fields ?? {};
    if (!plain(fields.搜索词)) continue;
    if (searchHeatOnly) {
      const searchHeat = plain(fields.搜索热度);
      if (!searchHeat || searchHeat.startsWith('#')) return false;
      continue;
    }
    const classification = plain(fields.关键词分类);
    const labels = plain(fields.细分标签);
    const priority = plain(fields.优先级);
    const direction = plain(fields[directionFieldName]);
    if (!priority || priority.startsWith('#') || !direction || direction.startsWith('#')) return false;
    if ((!classification || (classification === '痛点词' && !labels)) && priority !== '待数据') return false;
  }
  return true;
}

async function waitForDirectionFormula(api, tableId, expectedExpression, fieldName = PRODUCT_DIRECTION_FIELD) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const [fields, records] = await Promise.all([api.listFields(tableId), api.listRecords(tableId)]);
    const direction = fields.find((field) => field.field_name === fieldName);
    if (direction?.type === 20 && direction.property?.formula_expression === expectedExpression &&
        formulaInputsSettled(records, fieldName)) {
      return { fields, records, direction };
    }
    if (attempt === 59) throw new Error('Product direction formula did not settle within 60 seconds');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Product direction formula did not settle');
}

async function applyDirectionReplacement(api, options, replacement, scope) {
  if (replacement.renameOld) {
    await api.updateField(options.tableId, replacement.renameOld);
    try {
      await api.createField(options.tableId, replacement.createNew);
    } catch (error) {
      await api.updateField(options.tableId, replacement.rollbackOld);
      throw error;
    }
  } else {
    await api.createField(options.tableId, replacement.createNew);
  }
  const settled = await waitForDirectionFormula(
    api,
    options.tableId,
    replacement.createNew.body.property.formula_expression,
    replacement.createNew.body.field_name,
  );
  replacement.newFieldId = settled.direction.field_id;
  replacement.canDeleteOld = true;
  scope.directionReplacement = replacement;
  try {
    await api.deleteField(options.tableId, replacement.oldFieldId);
  } catch (error) {
    replacement.canDeleteNew = true;
    try {
      await api.deleteField(options.tableId, replacement.newFieldId);
      if (replacement.rollbackOld) await api.updateField(options.tableId, replacement.rollbackOld);
    } catch (rollbackError) {
      throw new Error(`${error.message}; rollback failed: ${rollbackError.message}`);
    }
    throw error;
  }
  if (replacement.promoteNew) {
    replacement.canPromoteNew = true;
    await api.updateField(options.tableId, {
      fieldId: replacement.newFieldId,
      body: replacement.promoteNew.body,
    });
    await waitForDirectionFormula(
      api,
      options.tableId,
      replacement.promoteNew.body.property.formula_expression,
    );
  }
  const [fields, records] = await Promise.all([api.listFields(options.tableId), api.listRecords(options.tableId)]);
  return { fields, records };
}

export function verifyTargetDecisionApply({
  tableId,
  beforeFields,
  afterFields,
  beforeRecords,
  afterRecords,
  plan,
  directionReplacement = null,
}) {
  if (!directionReplacement) {
    return verifyTargetFormulaApply({ tableId, beforeFields, afterFields, beforeRecords, afterRecords, plan });
  }
  if (beforeRecords.length !== afterRecords.length || afterFields.length !== beforeFields.length) {
    throw new Error('Product direction replacement changed table shape unexpectedly');
  }
  const ignored = new Set(plan.updates.map((item) => item.fieldName));
  ignored.add(PRODUCT_DIRECTION_FIELD);
  if (!same(canonicalRecords(beforeRecords, ignored), canonicalRecords(afterRecords, ignored))) {
    throw new Error('Product direction replacement changed business record data');
  }
  const oldField = beforeFields.find((field) => field.field_id === directionReplacement.oldFieldId);
  const newField = afterFields.find((field) => field.field_id === directionReplacement.newFieldId);
  if (!oldField || newField?.field_name !== PRODUCT_DIRECTION_FIELD || newField.type !== 20 ||
      newField.property?.formula_expression !== directionReplacement.createNew.body.property.formula_expression) {
    throw new Error('Product direction replacement formula does not match the approved expression');
  }
  if (afterFields.some((field) => field.field_id === directionReplacement.oldFieldId)) {
    throw new Error('Product direction replacement left the old text field behind');
  }
  const beforeComparable = beforeFields.filter((field) => field.field_id !== directionReplacement.oldFieldId);
  const afterComparable = afterFields.filter((field) => field.field_id !== directionReplacement.newFieldId);
  const verification = verifyDecisionFormulaFields({
    tableId,
    before: beforeComparable,
    after: afterComparable,
    plan,
  });
  return { fieldsUpdated: verification.formulaFieldsUpdated + 1, recordsWritten: 0, fieldReplaced: true };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const env = readEnv(path.resolve(options.envFile));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const scope = { appToken: options.appToken, tableId: options.tableId, plan: { updates: [] }, schemaPlan: { updates: [], creates: [] } };
  const api = new FeishuApi({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    appToken: options.appToken,
    mutationGuard: (request) => assertWeeklyDecisionMutation(request, scope),
  });
  await api.authenticate();
  const tables = await api.listTables();
  const table = tables.find((item) => item.table_id === options.tableId);
  if (!table || table.name !== options.tableName) throw new Error(`Authorized table mismatch: ${options.tableId}`);
  const [beforeFields, beforeRecords] = await Promise.all([api.listFields(options.tableId), api.listRecords(options.tableId)]);
  const schemaPlan = options.searchHeatOnly
    ? { updates: [], creates: [] }
    : buildDecisionSchemaPlan({ fields: beforeFields, records: beforeRecords });
  scope.schemaPlan = schemaPlan;
  const schemaChanges = schemaPlan.updates.length + schemaPlan.creates.length;
  let plan = { updates: [] };
  if (schemaChanges === 0) {
    const fullPlan = options.searchHeatOnly
      ? buildSearchHeatFormulaPlan({ tableId: options.tableId, fields: beforeFields })
      : buildDecisionFormulaPlan({ tableId: options.tableId, fields: beforeFields });
    plan = filterChangedFormulaPlan({ fields: beforeFields, plan: fullPlan });
    assertSupportedRepairPlan(plan);
  }
  scope.plan = plan;
  const summary = {
    mode: options.apply ? 'APPLY_READY' : 'DRY_RUN_READY',
    appToken: options.appToken,
    tableId: options.tableId,
    tableName: options.tableName,
    recordCount: beforeRecords.length,
    schemaFieldsToRename: schemaPlan.updates.map((item) => ({ from: item.oldName, to: item.fieldName })),
    schemaFieldsToCreate: schemaPlan.creates.map((item) => item.fieldName),
    formulaFieldsToUpdate: schemaChanges === 0
      ? plan.updates.map((item) => item.fieldName)
      : options.searchHeatOnly
        ? ['搜索热度']
        : [
          '搜索热度', '交易热度',
          '近2周重点达标次数', '近2周A级达标次数', '近2周探索达标次数',
          '是否重点词', '优先级', '对应产品方向',
        ],
    searchHeatBefore: formulaDistribution(beforeRecords, '搜索热度'),
    recentTargetsBefore: formulaDistribution(beforeRecords, '近2周重点达标次数'),
    recentABefore: formulaDistribution(beforeRecords, '近2周A级达标次数'),
    recentExploreBefore: formulaDistribution(beforeRecords, '近2周探索达标次数'),
    previousTargetsBefore: formulaDistribution(beforeRecords, '上一有效周重点达标'),
    previousABefore: formulaDistribution(beforeRecords, '上一有效周A级达标'),
    previousExploreBefore: formulaDistribution(beforeRecords, '上一有效周探索达标'),
    importantBefore: formulaDistribution(beforeRecords, '是否重点词'),
    priorityBefore: formulaDistribution(beforeRecords, '优先级'),
    directionBefore: formulaDistribution(beforeRecords, PRODUCT_DIRECTION_FIELD),
  };
  if (!options.apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const backup = writeBackup(options, beforeFields, beforeRecords);
  for (const update of schemaPlan.updates) await api.updateField(options.tableId, update);
  for (const create of schemaPlan.creates) await api.createField(options.tableId, create);

  const [afterSchemaFields, afterSchemaRecords] = await Promise.all([
    api.listFields(options.tableId),
    api.listRecords(options.tableId),
  ]);
  const schemaVerification = verifySchemaStage({
    tableId: options.tableId,
    beforeFields,
    afterFields: afterSchemaFields,
    beforeRecords,
    afterRecords: afterSchemaRecords,
    schemaPlan,
    searchHeatOnly: options.searchHeatOnly,
  });
  const fullPlanAfterSchema = options.searchHeatOnly
    ? buildSearchHeatFormulaPlan({ tableId: options.tableId, fields: afterSchemaFields })
    : buildDecisionFormulaPlan({ tableId: options.tableId, fields: afterSchemaFields });
  const changedPlan = filterChangedFormulaPlan({ fields: afterSchemaFields, plan: fullPlanAfterSchema });
  assertSupportedRepairPlan(changedPlan);
  const prepared = prepareFormulaApplyPlan({
    fields: afterSchemaFields,
    plan: changedPlan,
    searchHeatOnly: options.searchHeatOnly,
  });
  plan = prepared.plan;
  scope.plan = plan;
  scope.directionReplacement = prepared.directionReplacement;
  for (const update of plan.updates) await api.updateField(options.tableId, update);
  let afterFields;
  let afterRecords;
  if (prepared.directionReplacement) {
    ({ fields: afterFields, records: afterRecords } = await applyDirectionReplacement(
      api,
      options,
      prepared.directionReplacement,
      scope,
    ));
  } else {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      [afterFields, afterRecords] = await Promise.all([api.listFields(options.tableId), api.listRecords(options.tableId)]);
      try {
        verifyTargetDecisionApply({
          tableId: options.tableId,
          beforeFields: afterSchemaFields,
          afterFields,
          beforeRecords: afterSchemaRecords,
          afterRecords,
          plan,
        });
        if (formulaInputsSettled(afterRecords, PRODUCT_DIRECTION_FIELD, options.searchHeatOnly)) break;
      } catch (error) {
        if (attempt === 59) throw error;
      }
      if (attempt === 59) throw new Error('Decision formulas did not settle within 60 seconds');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const verification = verifyTargetDecisionApply({
    tableId: options.tableId,
    beforeFields: afterSchemaFields,
    afterFields,
    beforeRecords: afterSchemaRecords,
    afterRecords,
    plan,
    directionReplacement: prepared.directionReplacement,
  });
  const remaining = filterChangedFormulaPlan({
    fields: afterFields,
    plan: options.searchHeatOnly
      ? buildSearchHeatFormulaPlan({ tableId: options.tableId, fields: afterFields })
      : buildDecisionFormulaPlan({ tableId: options.tableId, fields: afterFields }),
  });
  if (remaining.updates.length) throw new Error('Formula migration is not idempotent');
  const receipt = {
    ...summary,
    mode: 'APPLIED_AND_VERIFIED',
    backup,
    schemaVerification,
    verification,
    directionFieldReplaced: Boolean(prepared.directionReplacement),
    directionAfter: formulaDistribution(afterRecords, PRODUCT_DIRECTION_FIELD),
    priorityAfter: formulaDistribution(afterRecords, '优先级'),
  };
  if (options.receiptFile) {
    const file = path.resolve(options.receiptFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    receipt.receiptFile = file;
  }
  console.log(JSON.stringify(receipt, null, 2));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
