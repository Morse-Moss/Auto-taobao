import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  ANALYSIS_FIELDS,
  HISTORY_FIELDS,
  KEYWORD_LIBRARY_FIELDS,
  buildKeywordIdentityKey,
  buildKeywordNumberMap,
  countKeywordNumberMappingDifferences,
  findTableById,
  normalizeKeyword,
  assertKeywordNumberOnlyMutation,
  sameDistribution,
} from './keyword-dual-table-core.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = 'N21Abkg0HakO6AsbCaDckvcwnVd';
const SOURCE_TABLE_ID = 'tblftWXw8cCKosGV';
const BAD_TABLE_ID = 'tblKqZKGOewiUUFP';
const ENV_FILE = 'E:/小红书/.env.local';
const ANALYSIS_TABLE_NAME = '关键词分析 V1（修正版）';
const HISTORY_TABLE_NAME = '关键词历史总表 V1';
const KEYWORD_LIBRARY_TABLE_NAME = '关键词编号库 V1';
const PRIMARY_CATEGORY = '浴缸';
const RAW_FIELDS = ['排名', '搜索词', '搜索人气', '点击率', '支付转化率'];
const FORMULA_FIELDS = ['一级类目', '主关键词', '原始关键词', '来源渠道', '搜索热度', '交易热度'];

function readEnv(file) {
  const output = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    output[line.slice(0, index).trim()] = value;
  }
  return output;
}

class FeishuApi {
  #token;

  constructor(appId, appSecret, mutationGuard) {
    this.appId = appId;
    this.appSecret = appSecret;
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

  async request(method, path, body) {
    if (method !== 'GET') this.mutationGuard({ method, path, body });
    const response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      throw new Error(`Feishu API failed: ${method} ${path} ${response.status} ${payload.code ?? ''} ${payload.msg ?? ''}`.trim());
    }
    return payload.data ?? {};
  }

  async listTables() {
    const data = await this.request('GET', `/bitable/v1/apps/${APP_TOKEN}/tables?page_size=100`);
    return data.items ?? [];
  }

  async listFields(tableId) {
    const data = await this.request('GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields?page_size=100`);
    return data.items ?? [];
  }

  async listRecords(tableId) {
    const records = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ page_size: '500' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.request('GET', `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?${query}`);
      records.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return records;
  }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function plainValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map((item) => item?.text ?? item?.value ?? String(item ?? '')).join('');
  }
  return String(value);
}

function rawFacts(records) {
  return [...records]
    .sort((left, right) => Number(plainValue(left.fields?.排名)) - Number(plainValue(right.fields?.排名)))
    .map((record) => Object.fromEntries(RAW_FIELDS.map((name) => [name, plainValue(record.fields?.[name])])));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function tableSnapshot(fields, records) {
  return {
    fields: fields.map((item) => ({
      name: item.field_name,
      type: item.type,
      formula: item.property?.formula_expression ?? null,
      options: (item.property?.options ?? []).map((option) => option.name),
    })),
    rowCount: records.length,
    rawFactsHash: digest(rawFacts(records)),
  };
}

function nonKeywordDataDigest(records) {
  const canonical = records
    .map((record) => ({
      recordId: record.record_id,
      fields: Object.fromEntries(Object.entries(record.fields ?? {})
        .filter(([name]) => name !== '关键词编号')
        .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))),
    }))
    .sort((left, right) => left.recordId.localeCompare(right.recordId));
  return digest(canonical);
}

function keywordNumberStats(records) {
  const values = records.map((record) => plainValue(record.fields?.关键词编号));
  return {
    rowCount: records.length,
    populatedCount: values.filter(Boolean).length,
    validCount: values.filter((value) => /^KW\d{6}$/.test(value)).length,
    uniqueValidCount: new Set(values.filter((value) => /^KW\d{6}$/.test(value))).size,
  };
}

function fieldState(fields, records) {
  return fields.map((field) => ({
    name: field.field_name,
    type: field.type,
    formula: field.property?.formula_expression ?? null,
    nonEmptyCount: records.filter((record) => Boolean(plainValue(record.fields?.[field.field_name]))).length,
  }));
}

function tableCreatePayload(name, fields) {
  return {
    table: {
      name,
      default_view_name: '全部记录',
      fields: fields.map((item) => ({
        field_name: item.name,
        type: item.type,
        ...(item.property ? { property: item.property } : {}),
      })),
    },
  };
}

async function createOrResumeTable(api, name, definitions) {
  let tables = await api.listTables();
  let matches = tables.filter((item) => item.name === name);
  if (matches.length > 1) throw new Error(`Multiple tables named ${name}`);
  if (matches.length === 0) {
    await api.request('POST', `/bitable/v1/apps/${APP_TOKEN}/tables`, tableCreatePayload(name, definitions));
    await wait(1000);
    tables = await api.listTables();
    matches = tables.filter((item) => item.name === name);
  }
  if (matches.length !== 1) throw new Error(`Unable to resolve table ${name}`);
  const tableId = matches[0].table_id;
  const fields = await api.listFields(tableId);
  const expected = definitions.map((item) => item.name);
  const actual = fields.map((item) => item.field_name);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} field order mismatch: ${JSON.stringify(actual)}`);
  }
  return { tableId, fields };
}

async function resolveExistingTable(api, tables, name, definitions) {
  const matches = tables.filter((item) => item.name === name);
  if (matches.length !== 1) throw new Error(`Expected one existing table named ${name}, received ${matches.length}`);
  const tableId = matches[0].table_id;
  const fields = await api.listFields(tableId);
  const expected = definitions.map((item) => item.name);
  const actual = fields.map((item) => item.field_name);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} field order mismatch: ${JSON.stringify(actual)}`);
  }
  return { tableId, fields };
}

function buildDesiredKeywordEntries(sourceRecords) {
  const entries = [...sourceRecords]
    .sort((left, right) => Number(plainValue(left.fields?.排名)) - Number(plainValue(right.fields?.排名)))
    .map((record) => {
      const originalKeyword = plainValue(record.fields?.搜索词);
      return {
        identity: buildKeywordIdentityKey(PRIMARY_CATEGORY, originalKeyword),
        fields: {
          唯一匹配键: buildKeywordIdentityKey(PRIMARY_CATEGORY, originalKeyword),
          一级类目: PRIMARY_CATEGORY,
          原始关键词: originalKeyword,
          规范化关键词: normalizeKeyword(originalKeyword),
        },
      };
    });
  const identities = new Set(entries.map((entry) => entry.identity));
  if (identities.size !== entries.length) {
    throw new Error(`Source contains ${entries.length - identities.size} duplicate normalized keyword identities`);
  }
  return entries;
}

function indexLibraryRecords(records, { requireNumbers = false } = {}) {
  const byIdentity = new Map();
  const numbers = new Set();
  for (const record of records) {
    const identity = buildKeywordIdentityKey(record.fields?.一级类目, record.fields?.原始关键词);
    const storedIdentity = plainValue(record.fields?.唯一匹配键);
    if (storedIdentity !== identity) throw new Error(`Keyword library identity field mismatch: ${storedIdentity}`);
    if (byIdentity.has(identity)) throw new Error(`Duplicate keyword library identity: ${identity}`);
    const keywordNumber = plainValue(record.fields?.关键词编号);
    if (requireNumbers && !/^KW\d{6}$/.test(keywordNumber)) {
      throw new Error(`Invalid keyword library number: ${keywordNumber || '<empty>'}`);
    }
    if (keywordNumber) {
      if (numbers.has(keywordNumber)) throw new Error(`Duplicate keyword library number: ${keywordNumber}`);
      numbers.add(keywordNumber);
    }
    byIdentity.set(identity, record);
  }
  return byIdentity;
}

async function seedKeywordLibrary(api, tableId, sourceRecords) {
  const desired = buildDesiredKeywordEntries(sourceRecords);
  const existing = await api.listRecords(tableId);
  const existingByIdentity = indexLibraryRecords(existing);
  const missing = desired.filter((entry) => !existingByIdentity.has(entry.identity));
  if (missing.length > 0) {
    await api.request('POST', `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/batch_create`, {
      records: missing.map((entry) => ({ fields: entry.fields })),
    });
  }
  return { desired, createdCount: missing.length };
}

async function awaitKeywordNumbers(api, tableId, desiredEntries) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const records = await api.listRecords(tableId);
    const byIdentity = indexLibraryRecords(records);
    const ready = desiredEntries.every((entry) => {
      const value = plainValue(byIdentity.get(entry.identity)?.fields?.关键词编号);
      return /^KW\d{6}$/.test(value);
    });
    if (ready) {
      buildKeywordNumberMap(records);
      return records;
    }
    await wait(1000);
  }
  throw new Error(`Keyword numbers did not settle for ${tableId}`);
}

async function backfillKeywordNumbers(api, tableId, libraryMapping) {
  const records = await awaitFormulaSettlement(api, tableId);
  const updates = records.flatMap((record) => {
    const identity = buildKeywordIdentityKey(record.fields?.一级类目, record.fields?.原始关键词);
    const expected = libraryMapping.get(identity);
    if (!expected) throw new Error(`No keyword number for ${identity}`);
    return plainValue(record.fields?.关键词编号) === expected
      ? []
      : [{ record_id: record.record_id, fields: { 关键词编号: expected } }];
  });
  if (updates.length > 0) {
    await api.request('POST', `/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/batch_update`, {
      records: updates,
    });
  }
  return updates.length;
}

function distribution(records, fieldName) {
  return Object.fromEntries([...records.reduce((map, record) => {
    const value = plainValue(record.fields?.[fieldName]) || '<空>';
    map.set(value, (map.get(value) ?? 0) + 1);
    return map;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right, 'zh-CN')));
}

async function awaitFormulaSettlement(api, tableId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const records = await api.listRecords(tableId);
    const unsettled = records.some((record) => FORMULA_FIELDS.some((name) => {
      const value = plainValue(record.fields?.[name]);
      return !value || value.startsWith('#');
    }));
    if (!unsettled) return records;
    await wait(1500);
  }
  throw new Error(`Formula fields did not settle for ${tableId}`);
}

async function verifyTarget(api, tableId, definitions, sourceRecords, tableKind) {
  const fields = await api.listFields(tableId);
  const records = await awaitFormulaSettlement(api, tableId);
  const expectedNames = definitions.map((item) => item.name);
  const names = fields.map((item) => item.field_name);
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new Error(`${tableId} field order changed`);
  if (records.length !== 300) throw new Error(`${tableId} expected 300 records, received ${records.length}`);
  if (digest(rawFacts(records)) !== digest(rawFacts(sourceRecords))) throw new Error(`${tableId} raw facts differ from source`);
  const keywordMismatch = records.filter((record) =>
    plainValue(record.fields?.搜索词) !== plainValue(record.fields?.原始关键词)).length;
  if (keywordMismatch !== 0) throw new Error(`${tableId} search/original keyword mismatch count ${keywordMismatch}`);
  const keywordNumbers = records.map((record) => plainValue(record.fields?.关键词编号));
  const invalidKeywordNumberCount = keywordNumbers.filter((value) => !/^KW\d{6}$/.test(value)).length;
  const duplicateKeywordNumberCount = keywordNumbers.length - new Set(keywordNumbers).size;
  if (invalidKeywordNumberCount !== 0) throw new Error(`${tableId} invalid keyword number count ${invalidKeywordNumberCount}`);
  if (duplicateKeywordNumberCount !== 0) throw new Error(`${tableId} duplicate keyword number count ${duplicateKeywordNumberCount}`);
  const result = {
    tableId,
    tableKind,
    rowCount: records.length,
    fieldCount: fields.length,
    fieldOrder: names,
    keywordMismatch,
    keywordNumbers: {
      count: keywordNumbers.length,
      uniqueCount: new Set(keywordNumbers).size,
      first: keywordNumbers.toSorted()[0],
      last: keywordNumbers.toSorted().at(-1),
      invalidCount: invalidKeywordNumberCount,
    },
    constants: {
      一级类目: distribution(records, '一级类目'),
      主关键词: distribution(records, '主关键词'),
      来源渠道: distribution(records, '来源渠道'),
    },
    heat: {
      搜索热度: distribution(records, '搜索热度'),
      交易热度: distribution(records, '交易热度'),
    },
    blankDateCount: records.filter((record) => !plainValue(record.fields?.采集日期)).length,
    formulaErrorCount: records.reduce((count, record) => count + FORMULA_FIELDS.filter((name) =>
      plainValue(record.fields?.[name]).startsWith('#')).length, 0),
  };
  if (tableKind === 'analysis') {
    result.analysisStatus = distribution(records, '分析状态');
    result.frozenBlankCounts = Object.fromEntries([
      '内容热度', '是否重点词', '优先级', '对应产品方向',
    ].map((name) => [name, records.filter((record) => !plainValue(record.fields?.[name])).length]));
  } else {
    result.trendBlankCounts = Object.fromEntries([
      '出现状态', '排名环比', '搜索人气环比', '交易环比', '综合趋势变化',
    ].map((name) => [name, records.filter((record) => !plainValue(record.fields?.[name])).length]));
  }
  return result;
}

async function verifyKeywordLibrary(api, tableId, desiredEntries) {
  const fields = await api.listFields(tableId);
  const records = await awaitKeywordNumbers(api, tableId, desiredEntries);
  const expectedNames = KEYWORD_LIBRARY_FIELDS.map((item) => item.name);
  const names = fields.map((item) => item.field_name);
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new Error(`${tableId} field order changed`);
  const numberField = fields.find((field) => field.field_name === '关键词编号');
  if (numberField?.type !== 1005) throw new Error(`${tableId} keyword number field is not auto-number`);
  const mapping = buildKeywordNumberMap(records);
  const missingDesiredCount = desiredEntries.filter((entry) => !mapping.has(entry.identity)).length;
  if (missingDesiredCount !== 0) throw new Error(`${tableId} missing desired keyword count ${missingDesiredCount}`);
  const desiredNumbers = desiredEntries.map((entry) => mapping.get(entry.identity)).toSorted();
  return {
    tableId,
    rowCount: records.length,
    fieldCount: fields.length,
    desiredIdentityCount: desiredEntries.length,
    missingDesiredCount,
    uniqueNumberCount: new Set([...mapping.values()]).size,
    firstDesiredNumber: desiredNumbers[0],
    lastDesiredNumber: desiredNumbers.at(-1),
    mapping,
  };
}

function assertApprovedDistributions(receipt) {
  const expectedSearch = { 中: 15, 低: 276, 高: 9 };
  const expectedTrade = { 中: 159, 低: 61, 无数据: 55, 高: 25 };
  if (!sameDistribution(receipt.heat.搜索热度, expectedSearch)) {
    throw new Error(`Search heat distribution mismatch: ${JSON.stringify(receipt.heat.搜索热度)}`);
  }
  if (!sameDistribution(receipt.heat.交易热度, expectedTrade)) {
    throw new Error(`Trade heat distribution mismatch: ${JSON.stringify(receipt.heat.交易热度)}`);
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const numbersOnly = process.argv.includes('--numbers-only');
  const env = readEnv(ENV_FILE);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('Feishu app credentials unavailable');
  const mutationScope = {
    appToken: APP_TOKEN,
    libraryTableName: KEYWORD_LIBRARY_TABLE_NAME,
    libraryTableIds: new Set(),
    businessTableIds: new Set(),
  };
  const api = new FeishuApi(
    env.FEISHU_APP_ID,
    env.FEISHU_APP_SECRET,
    (request) => assertKeywordNumberOnlyMutation(request, mutationScope),
  );
  await api.authenticate();

  const tables = await api.listTables();
  findTableById(tables, SOURCE_TABLE_ID, { required: true });
  const badTable = findTableById(tables, BAD_TABLE_ID, { required: false });
  const [sourceFields, sourceRecords, badFields, badRecords] = await Promise.all([
    api.listFields(SOURCE_TABLE_ID),
    api.listRecords(SOURCE_TABLE_ID),
    badTable ? api.listFields(BAD_TABLE_ID) : Promise.resolve([]),
    badTable ? api.listRecords(BAD_TABLE_ID) : Promise.resolve([]),
  ]);
  if (sourceRecords.length !== 300) throw new Error(`Source expected 300 records, received ${sourceRecords.length}`);
  const sourceBefore = tableSnapshot(sourceFields, sourceRecords);
  const badBefore = badTable ? tableSnapshot(badFields, badRecords) : null;

  if (!apply) {
    const keywordLibrary = tables.find((item) => item.name === KEYWORD_LIBRARY_TABLE_NAME);
    const analysisTable = tables.find((item) => item.name === ANALYSIS_TABLE_NAME);
    const historyTable = tables.find((item) => item.name === HISTORY_TABLE_NAME);
    const [libraryRecords, analysisRecords, historyRecords, analysisFields, historyFields] = await Promise.all([
      keywordLibrary ? api.listRecords(keywordLibrary.table_id) : Promise.resolve([]),
      analysisTable ? api.listRecords(analysisTable.table_id) : Promise.resolve([]),
      historyTable ? api.listRecords(historyTable.table_id) : Promise.resolve([]),
      analysisTable ? api.listFields(analysisTable.table_id) : Promise.resolve([]),
      historyTable ? api.listFields(historyTable.table_id) : Promise.resolve([]),
    ]);
    console.log(JSON.stringify({
      mode: 'DRY_RUN',
      source: { tableId: SOURCE_TABLE_ID, ...sourceBefore },
      sourceFieldState: fieldState(sourceFields, sourceRecords),
      existingTableNames: tables.map((item) => item.name),
      numberState: {
        keywordLibrary: keywordNumberStats(libraryRecords),
        analysis: keywordNumberStats(analysisRecords),
        history: keywordNumberStats(historyRecords),
      },
      currentBusinessFieldState: {
        analysis: fieldState(analysisFields, analysisRecords),
        history: fieldState(historyFields, historyRecords),
      },
      targets: [
        { name: KEYWORD_LIBRARY_TABLE_NAME, fields: KEYWORD_LIBRARY_FIELDS.map((item) => item.name), rows: 300, exists: Boolean(keywordLibrary) },
        { name: ANALYSIS_TABLE_NAME, fields: ANALYSIS_FIELDS.map((item) => item.name), rows: 300 },
        { name: HISTORY_TABLE_NAME, fields: HISTORY_FIELDS.map((item) => item.name), rows: 300 },
      ],
    }, null, 2));
    return;
  }

  if (!numbersOnly) {
    throw new Error('Write mode requires --numbers-only; other field updates are disabled');
  }

  const analysis = await resolveExistingTable(api, tables, ANALYSIS_TABLE_NAME, ANALYSIS_FIELDS);
  const history = await resolveExistingTable(api, tables, HISTORY_TABLE_NAME, HISTORY_FIELDS);
  mutationScope.businessTableIds.add(analysis.tableId);
  mutationScope.businessTableIds.add(history.tableId);

  const keywordLibrary = await createOrResumeTable(api, KEYWORD_LIBRARY_TABLE_NAME, KEYWORD_LIBRARY_FIELDS);
  mutationScope.libraryTableIds.add(keywordLibrary.tableId);
  const librarySeed = await seedKeywordLibrary(api, keywordLibrary.tableId, sourceRecords);
  const libraryRecords = await awaitKeywordNumbers(api, keywordLibrary.tableId, librarySeed.desired);
  const libraryMapping = buildKeywordNumberMap(libraryRecords);

  const analysisBeforeRecords = await api.listRecords(analysis.tableId);
  if (analysisBeforeRecords.length !== sourceRecords.length || digest(rawFacts(analysisBeforeRecords)) !== digest(rawFacts(sourceRecords))) {
    throw new Error('Analysis table raw facts differ from source; refusing number-only update');
  }
  const analysisNonKeywordBefore = nonKeywordDataDigest(analysisBeforeRecords);
  const analysisUpdatedCount = await backfillKeywordNumbers(api, analysis.tableId, libraryMapping);

  const historyBeforeRecords = await api.listRecords(history.tableId);
  if (historyBeforeRecords.length !== sourceRecords.length || digest(rawFacts(historyBeforeRecords)) !== digest(rawFacts(sourceRecords))) {
    throw new Error('History table raw facts differ from source; refusing number-only update');
  }
  const historyNonKeywordBefore = nonKeywordDataDigest(historyBeforeRecords);
  const historyUpdatedCount = await backfillKeywordNumbers(api, history.tableId, libraryMapping);

  const [libraryReceipt, analysisReceipt, historyReceipt, sourceFieldsAfter, sourceRecordsAfter, badFieldsAfter, badRecordsAfter] = await Promise.all([
    verifyKeywordLibrary(api, keywordLibrary.tableId, librarySeed.desired),
    verifyTarget(api, analysis.tableId, ANALYSIS_FIELDS, sourceRecords, 'analysis'),
    verifyTarget(api, history.tableId, HISTORY_FIELDS, sourceRecords, 'history'),
    api.listFields(SOURCE_TABLE_ID),
    api.listRecords(SOURCE_TABLE_ID),
    badTable ? api.listFields(BAD_TABLE_ID) : Promise.resolve([]),
    badTable ? api.listRecords(BAD_TABLE_ID) : Promise.resolve([]),
  ]);
  assertApprovedDistributions(analysisReceipt);
  assertApprovedDistributions(historyReceipt);
  const keywordMappingDifferenceCount = countKeywordNumberMappingDifferences(
    await api.listRecords(analysis.tableId),
    await api.listRecords(history.tableId),
  );
  if (keywordMappingDifferenceCount !== 0) {
    throw new Error(`Business table keyword mapping difference count ${keywordMappingDifferenceCount}`);
  }
  const [analysisAfterRecords, historyAfterRecords] = await Promise.all([
    api.listRecords(analysis.tableId),
    api.listRecords(history.tableId),
  ]);
  if (nonKeywordDataDigest(analysisAfterRecords) !== analysisNonKeywordBefore) {
    throw new Error('Analysis table non-keyword data changed during number-only update');
  }
  if (nonKeywordDataDigest(historyAfterRecords) !== historyNonKeywordBefore) {
    throw new Error('History table non-keyword data changed during number-only update');
  }

  const sourceAfter = tableSnapshot(sourceFieldsAfter, sourceRecordsAfter);
  const badAfter = badTable ? tableSnapshot(badFieldsAfter, badRecordsAfter) : null;
  if (digest(sourceAfter) !== digest(sourceBefore)) throw new Error('Source table changed during the operation');
  if (digest(badAfter) !== digest(badBefore)) throw new Error('Previously incorrect table changed during the operation');

  console.log(JSON.stringify({
    mode: 'APPLIED_AND_VERIFIED',
    scope: 'KEYWORD_NUMBERS_ONLY',
    keywordLibrary: {
      ...libraryReceipt,
      mapping: undefined,
      createdCount: librarySeed.createdCount,
    },
    analysis: analysisReceipt,
    history: historyReceipt,
    backfill: {
      analysisUpdatedCount,
      historyUpdatedCount,
      keywordMappingDifferenceCount,
    },
    protectedTablesUnchanged: {
      source: true,
      previousIncorrectTable: badTable ? true : 'absent before operation',
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
