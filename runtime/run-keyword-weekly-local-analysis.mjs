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
//     --expected-rows 300 \
//     --history-table-name '关键词历史总表 V1' \
//     --previous-table-name '关键词分析 V1（2026-09-12）' --expected-history-rows 2367
//   [--output-dir runtime/keyword-weekly-runs]
//   [--apply --confirm-base <app-token> --confirm-table <table-id> --confirm-history-table <history-table-id>]
//   [--skip-decision-history]
//
// 三段，顺序是有依赖的，不是习惯：
//   ① 规则段（4 字段）→ ② 内容热度（1 字段）→ ③ **决策历史同步**（`--history-table-name` 给了才启用）
//   ③ 把本批已达标快照进历史表，并回写本期三个「上一有效周…达标」基数。
//   为什么必须并进这一条命令：那三个基数一旦空着，本期三个「近2周…达标次数」列就整列为空，
//   「是否重点词」还会在「搜索热度=高 且 交易热度∈{中,高}」的行上落「待数据」——
//   2026-09-19 期就是这么缺的（`evidence/keyword-weekly-columns-audit-2026-09-21/`）。
//
//   ③ 必须在 ①② 之后跑：它读本期的 `关键词分类`/`细分标签`/`内容热度`/`优先级`/`是否重点词`。
//   而 `是否重点词` 又读 `近2周重点达标次数` —— 那个值要等 ③ 自己把基数写进去才算得出来。
//   于是 ③ 天然是**两遍**：
//     第一遍写入基数与历史快照；写完之后 `是否重点词` 才会从「待数据」定型，
//     所以第一遍快照进历史表的 `是否重点词` 必然是「待数据」（2026-09-19 期实测：否×295 待数据×5，
//     而源表现值是 否×296 是×4）。
//     第二遍只在回读比对发现不一致时跑（`--recalculate-existing-snapshots`，只改不一致的格）——
//     已一致就一个字都不写。
//   这是 1.6 自己写入顺序的后果（它在一个计划里先写历史、后写基数），不是偶发；
//   所以修法不是「记得再跑一遍」，而是让这一步自己比对、自己补。
//
//   ③ 自带幂等：先只读 dry-run 问「到底缺不缺」，缺才写；已同步直接跳过（整段零写入）。
//   不给 `--history-table-name` 时行为与从前逐字相同（只跑 ①②），但会在尾部提示这一跳（可用
//   `--skip-decision-history` 显式关掉提示）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildContentHeatArtifact,
  buildContentHeatCsv,
} from './content-heat-judge.mjs';
import { readbackText } from './feishu-readback.mjs';
import { analyzeKeyword } from './local-keyword-analysis.mjs';
import { activeProfileName, envFilePath, keywordBaseToken, profileTargets } from './feishu-targets.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 决策历史同步（第三段）的唯一实现在能力目录里：`skills/sycm-to-feishu-base/scripts/sync-decision-history.mjs`。
 *
 * 这里**只按路径调它，不复制它的逻辑** —— 它有写前备份、写后回读、幂等断言、变异白名单，
 * 复制一份到 runtime/ 就等于把那条链的判据一分为二（本项目已经吃过「同一个事实两处实现」的亏）。
 * 调法只能是 spawn：它的 `main()` 没有导出，只有顶层 `import.meta.url === argv[1]` 那条判据才跑。
 * 顺带一个坑：中文表名过不了 shell，所以参数一律走 `spawnSync(process.execPath, [script, ...args])` 数组。
 *
 * 注意这条 runtime → skills 的引用是**按路径字符串**调的，不在 `runtime/arch-boundary.test.mjs` 的
 * import 扫描口径里（那个守卫只认三种 import 形态）。它确实加深了「整仓复制」的锁定面，
 * 所以写在这里说清楚：这是**复用**，不是把业务逻辑倒灌进机制层。
 */
export const DECISION_HISTORY_SYNC_SCRIPT = path.join(REPO_ROOT, 'skills', 'sycm-to-feishu-base', 'scripts', 'sync-decision-history.mjs');

/** 本地要产出的全部分析字段。规则 4 个 + AI 1 个。 */
export const LOCAL_ANALYSIS_FIELDS = Object.freeze(['标准归并词', '关键词分类', '细分标签', '用户意图', '内容热度']);
export const RULE_FIELDS = Object.freeze(['标准归并词', '关键词分类', '细分标签', '用户意图']);
/** 决策历史同步回写到**本期表**的三列基数。空着 ⇒ 本期三个「近2周…达标次数」整列为空。 */
export const DECISION_HISTORY_COUNT_FIELDS = Object.freeze(['上一有效周重点达标', '上一有效周探索达标', '上一有效周A级达标']);
/** 历史表侧本批次要落的快照列 —— 用来判断「同步到底落没落地」，不看写入器自报。 */
export const DECISION_HISTORY_SNAPSHOT_FIELDS = Object.freeze([
  '重点达标', 'A级达标', '探索达标', '标准归并词', '是否重点词', '优先级',
]);
/**
 * 这里面**只有「随公式变动」的那三列**能做「历史 vs 源表」的逐行比对：
 * 它们是公式字段，值会随基数写入而变化，所以第一遍快照可能定格在一个还没算完的中间态。
 * `重点达标`/`A级达标`/`探索达标` 不算 —— 它们是从源表**算出来的派生值**，历史表里存的就是它，
 * 拿它去和源表比等于拿结论和结论比（源表根本没有同名列）。
 */
export const DECISION_HISTORY_VISUAL_FIELDS = Object.freeze(['标准归并词', '是否重点词', '优先级']);

/** 没给 `--history-table-name` 时打在尾部的一句话：说清「没跑会缺什么」和「怎么补」。 */
export const DECISION_HISTORY_HINT = [
  '决策历史同步（第三段）未启用：本期三个「上一有效周…达标」基数不会回写，',
  '三个「近2周…达标次数」列会整列为空，「是否重点词」会在高搜索×中/高交易的行上落「待数据」。',
  '要一并跑，加 --history-table-name「关键词历史总表 V1」--previous-table-name「上一期分析表名」--expected-history-rows <行数>；',
  '真写再加 --confirm-history-table <history-table-id>。显式不跑用 --skip-decision-history。',
].join('');


function optionKey(name) {
  return name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

export function parseOptions(argv, defaults = {}) {
  const options = { apply: false, skipDecisionHistory: false, expectedRows: 300, outputDir: 'runtime/keyword-weekly-runs', envFile: defaults.envFile, appToken: defaults.appToken };
  const values = new Set([
    'table-id', 'table-name', 'collection-date', 'batch-number', 'expected-rows', 'output-dir',
    'env-file', 'app-token', 'confirm-base', 'confirm-table',
    'history-table-id', 'history-table-name', 'previous-table-id', 'previous-table-name',
    'expected-history-rows', 'confirm-history-table',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (name === 'apply') { options.apply = true; continue; }
    if (name === 'skip-decision-history') { options.skipDecisionHistory = true; continue; }
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
  // 第三段（决策历史同步）：`--history-table-name`/`-id` 给了才启用。
  // 不给也不加 `--skip-decision-history` ⇒ 与从前逐字相同（只跑分析与 AI 段），运行尾部会提示这一跳。
  if (options.skipDecisionHistory && (options.historyTableName || options.historyTableId)) {
    throw new Error('--skip-decision-history cannot be combined with --history-table-name/--history-table-id');
  }
  if (options.historyTableName || options.historyTableId) {
    // 上一张分析表是算「上一有效周」基数的输入，缺了只能落 pending、写不进去 —— 所以在参数层就拦住。
    if (!options.previousTableName && !options.previousTableId) {
      throw new Error('Decision-history sync requires --previous-table-name (last period\'s analysis table)');
    }
    if (!options.expectedHistoryRows) throw new Error('Decision-history sync requires --expected-history-rows');
    options.expectedHistoryRows = Number(options.expectedHistoryRows);
    if (!Number.isInteger(options.expectedHistoryRows) || options.expectedHistoryRows < 1) {
      throw new Error('--expected-history-rows must be a positive integer');
    }
    if (options.apply && !options.confirmHistoryTable) throw new Error('Write mode requires --confirm-history-table <history-table-id>');
  }
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
 * 判定「这一轮本地分析落库了吗」——纯函数，只吃回读结果，便于单独钉住。
 *
 * 两处容易判错的地方，都是实测踩出来的：
 *  ① 「表上还有空格」≠「该写的没写」。`细分标签` 是 MultiSelect，本地规则对很多词本来就判不出标签
 *     （2026-09-19 期 290/300 有值，剩下 10 行本地也判不出）。拿「空格数必须为 0」当绿灯会永远黄灯，
 *     人就学会忽略这个状态 —— 那这条判据等于没有。基线取**本地分析自己的结果**。
 *  ② 「本地分析绿了」≠「这一轮整体绿了」。三个「近2周…达标次数」列的值来自决策历史同步，
 *     本地五列全绿而基数没回写时，报表照样整列为空。所以两段都要绿才算绿。
 */
export function judgeLocalAnalysisReadback({ afterFilled, afterRows, ruleValues, decisionHistory }) {
  const stillBlank = Object.entries(afterFilled).filter(([, count]) => count !== afterRows);
  const expectedBlank = Object.fromEntries(LOCAL_ANALYSIS_FIELDS.map((name) => [
    name, (ruleValues ?? []).filter((item) => isBlank(item[name])).length,
  ]));
  const unexplainedBlank = Object.entries(afterFilled)
    .filter(([field, filled]) => filled < afterRows - expectedBlank[field])
    .map(([field, filled]) => ({
      field, filled, expectedAtLeast: afterRows - expectedBlank[field], localBlank: expectedBlank[field],
    }));
  const decisionOk = !decisionHistory || ['ALREADY_SYNCED', 'APPLIED_AND_VERIFIED'].includes(decisionHistory.status);
  return {
    status: unexplainedBlank.length === 0 && decisionOk ? 'APPLIED_AND_READBACK_VERIFIED' : 'APPLIED_WITH_GAPS',
    stillBlank,
    expectedBlank,
    unexplainedBlank,
    decisionOk,
  };
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

/**
 * 关键词库 base 的只读客户端。
 *
 * **导出**（2026-09-22）：周更排期的「每周入参解析」要按名找出源周表/历史表/编号库，
 * 而它需要的就是这同一个只读客户端。复制一份到 `runtime/weekly-round-input-reader.mjs`
 * 等于把「怎么读这个 base」变成两处实现 —— 本项目已经吃过「同一个事实两处实现」的亏，
 * 所以这里导出、那边 import。
 */
export class FeishuReader {
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

/**
 * 把子进程的 stdout 解析成对象。
 *
 * 为什么要容忍前后有杂音：1.6 只 `console.log` 一处 JSON，但它是别人维护的脚本，
 * 哪天多打一行日志，这里就会从「解析失败」变成「拿到一个字段全 undefined 的计划」——
 * 后者会静默地判成「无需写入」。所以取第一个 `{` 到最后一个 `}`，并且解析不出来就抛。
 */
export function parseJsonOutput(text, label) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error(`${label} produced no output`);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`${label} produced no JSON object: ${trimmed.slice(0, 400)}`);
  let parsed;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch (error) {
    throw new Error(`${label} produced unparsable JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`${label} produced a non-object payload`);
  return parsed;
}

/** 1.6 的完整调用参数。纯函数：便于在测试里断言「真写时确认项一个字都不能少」。 */
export function buildDecisionHistoryArgs({
  profile, options, table, historyTable, previousTable, receiptFile, backupDir,
  // `write` 默认跟随入口的 `--apply`，但**必须能单独覆盖**：
  // 第三段是「先只读问缺不缺」，那一次 dry-run 即使入口带着 `--apply` 也不许写。
  // 早先这里直接读 `options.apply`，于是带 `--apply` 跑时「只读探路」那一次也变成了真写 —— 由用例照出来的。
  write = options.apply,
  recalculate = false,
}) {
  const info = profileTargets(profile);
  const args = [
    DECISION_HISTORY_SYNC_SCRIPT,
    '--base-url', `https://${info.host}/base/${options.appToken}`,
    '--current-table-id', table.table_id, '--current-table-name', table.name,
    '--history-table-id', historyTable.table_id, '--history-table-name', historyTable.name,
    '--current-batch-number', String(options.batchNumber),
    '--expected-current-rows', String(options.expectedRows),
    '--expected-history-rows', String(options.expectedHistoryRows),
    '--env-file', options.envFile,
    '--backup-dir', backupDir,
  ];
  // 1.6 要求 id 与 name 成对出现（只给一个它会当场拒），所以这里两个都给。
  if (previousTable) args.push('--previous-table-id', previousTable.table_id, '--previous-table-name', previousTable.name);
  if (write) {
    args.push(
      '--apply',
      '--confirm-base', options.appToken,
      '--confirm-current-table', table.table_id,
      '--confirm-history-table', historyTable.table_id,
    );
    // `--recalculate-existing-snapshots` 只在真写时有意义：dry-run 下它不改「要写几格」的判断。
    if (recalculate) args.push('--recalculate-existing-snapshots');
    if (receiptFile) args.push('--receipt-file', receiptFile);
  }
  return args;
}

function spawnDecisionHistory({ args, label, spawn = spawnSync }) {
  const result = spawn(process.execPath, args, { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.status !== 0) {
    // 1.6 的失败路径是 `console.error(message)` + exitCode=1（stdout 为空），所以两边都要看。
    const detail = (stderr || stdout).trim().split(/\r?\n/u).filter(Boolean).slice(-6).join(' | ');
    throw new Error(`${label} failed (exit ${result.status}): ${detail}`);
  }
  return { payload: parseJsonOutput(stdout, label), exitCode: result.status, stderr };
}

/**
 * 独立回读决策历史这一段是否真落地 —— **不采信写入器的自报**。
 *
 * 三组判据，各有各要照的静默失败：
 *   ① 本期三个基数是否 300/300（照「基数没回写」）；
 *   ② 历史表本批次的六列快照有值率（照「历史行没落」）；
 *   ③ 历史表本批次的**视觉三列**逐行 vs 源表现值（照「快照定格在中间态」）。
 * ③ 是 2026-09-19 期实际踩到的那一格：写入器自己报 APPLIED_AND_VERIFIED，历史表的
 * `是否重点词` 却是 `否×295 待数据×5`，而源表已经是 `否×296 是×4`。
 */
export function readbackDecisionHistory({ currentRecords, historyRecords, expectedRows, batchNumber }) {
  const countsFilled = Object.fromEntries(DECISION_HISTORY_COUNT_FIELDS.map((name) => [
    name, currentRecords.filter((record) => !isBlank(record.fields?.[name])).length,
  ]));
  const countsBlank = Object.entries(countsFilled)
    .filter(([, count]) => count !== expectedRows)
    .map(([field, filled]) => ({ field, filled, expected: expectedRows }));

  const currentByNumber = new Map();
  const unresolvedOnCurrent = {};
  for (const record of currentRecords) {
    const number = readbackText(record.fields?.['关键词编号']);
    if (number) currentByNumber.set(number, record);
    for (const name of DECISION_HISTORY_VISUAL_FIELDS) {
      const value = readbackText(record.fields?.[name]);
      if (!value || value === '待数据' || value.startsWith('#')) {
        unresolvedOnCurrent[name] = (unresolvedOnCurrent[name] ?? 0) + 1;
      }
    }
  }

  const batchRows = historyRecords.filter((record) => Number(readbackText(record.fields?.['批次编号'])) === Number(batchNumber));
  const snapshotFilled = Object.fromEntries(DECISION_HISTORY_SNAPSHOT_FIELDS.map((name) => [
    name, batchRows.filter((record) => !isBlank(record.fields?.[name])).length,
  ]));
  const mismatches = [];
  const unresolvedOnSnapshot = {};
  for (const record of batchRows) {
    const number = readbackText(record.fields?.['关键词编号']);
    const source = currentByNumber.get(number);
    if (!source) continue;
    for (const name of DECISION_HISTORY_VISUAL_FIELDS) {
      const snapshot = readbackText(record.fields?.[name]);
      const live = readbackText(source.fields?.[name]);
      if (!snapshot || snapshot === '待数据' || snapshot.startsWith('#')) {
        unresolvedOnSnapshot[name] = (unresolvedOnSnapshot[name] ?? 0) + 1;
      }
      if (snapshot !== live) mismatches.push({ keywordNumber: number, field: name, history: snapshot, source: live });
    }
  }

  return {
    currentRows: currentRecords.length,
    historyRows: historyRecords.length,
    countsFilled,
    countsBlank,
    currentBatchRows: batchRows.length,
    snapshotFilled,
    visualMismatchCount: mismatches.length,
    visualMismatchByField: histogram(mismatches.map((item) => item.field)),
    visualMismatchSamples: mismatches.slice(0, 10),
    unresolvedOnCurrent,
    unresolvedOnSnapshot,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 读一次源表 + 历史表并比对；基数还没落地时重读几次（公式是服务端算的，可能有延迟）。 */
async function readDecisionHistoryReadback(reader, options, table, historyTable, { attempts = 3, delay = sleep } = {}) {
  let readback;
  for (let attempt = 1; ; attempt += 1) {
    const [currentRecords, historyRecords] = await Promise.all([
      reader.listRecords(table.table_id),
      reader.listRecords(historyTable.table_id),
    ]);
    readback = readbackDecisionHistory({
      currentRecords, historyRecords, expectedRows: options.expectedRows, batchNumber: options.batchNumber,
    });
    if (readback.countsBlank.length === 0 || attempt >= attempts) return readback;
    await delay(2000);
  }
}

/**
 * 第三段：决策历史同步。**先只读问「缺不缺」，缺才写；写完自己比对，不一致自己再补一遍。**
 *
 * 为什么不让调用方直接 apply：1.6 的备份/回读/幂等断言只在「它被叫起来」时生效。
 * 把「要不要写」交给一次 dry-run，才能让「已同步」这个最常见的重跑情形变成整段零写入 ——
 * 幂等不能只靠写入器内部兜底。
 *
 * `spawn` 与 `delay` 可注入：用例要断言「计划为零时一个子进程都不起」和「比对不一致时会起第二遍」，
 * 又不能在测试里真去写飞书。
 */
export async function runDecisionHistoryStage({
  profile, options, table, historyTable, previousTable, reader, runDir, backupDir,
  spawn = spawnSync, delay = sleep,
}) {
  const scriptLabel = path.relative(REPO_ROOT, DECISION_HISTORY_SYNC_SCRIPT).replaceAll('\\', '/');
  // 只读探路：`write: false` 是**显式**的，不跟随入口的 `--apply`。
  const dryArgs = buildDecisionHistoryArgs({ profile, options, table, historyTable, previousTable, backupDir, write: false });
  const dry = spawnDecisionHistory({ args: dryArgs, label: 'Decision-history dry-run (零写入)', spawn });
  const planned = dry.payload.planned ?? {};
  const pending = dry.payload.pending ?? {};
  const writeUnits = (planned.historySnapshotsToWrite ?? 0) + (planned.currentCountsToWrite ?? 0)
    + (planned.historyFieldsToCreate ?? 0) + (planned.historyFieldsToUpdate ?? 0) + (planned.historyValidityToWrite ?? 0);
  const pendingTotal = (pending.historySnapshots ?? 0) + (pending.currentCounts ?? 0);
  const summary = {
    script: scriptLabel,
    profile: profileTargets(profile).name,
    batchNumber: options.batchNumber,
    currentTable: { id: table.table_id, name: table.name },
    historyTable: { id: historyTable.table_id, name: historyTable.name },
    previousTable: previousTable ? { id: previousTable.table_id, name: previousTable.name } : null,
    planned,
    pending,
    writeUnits,
    pendingTotal,
  };

  // 计划全零 ⇒ 已同步（或无可写）。**一次写入都不发起**，这是重跑安全的根据。
  if (writeUnits === 0) {
    return {
      ...summary,
      status: pendingTotal === 0 ? 'ALREADY_SYNCED' : 'ALREADY_SYNCED_WITH_PENDING',
      mode: 'skipped',
      wrote: false,
    };
  }
  if (!options.apply) return { ...summary, status: 'DRY_RUN_HAS_WORK', mode: 'dry-run', wrote: false };

  const receiptFile = path.join(runDir, `decision-history-receipt-${stamp()}.json`);
  const first = spawnDecisionHistory({
    args: buildDecisionHistoryArgs({ profile, options, table, historyTable, previousTable, receiptFile, backupDir }),
    label: 'Decision-history apply',
    spawn,
  });
  let readback = await readDecisionHistoryReadback(reader, options, table, historyTable, { delay });

  // 第二遍：只在「历史表的公式列定格在中间态」时才跑。已一致 ⇒ 这一段仍然零写入。
  let secondPass;
  if (readback.visualMismatchCount > 0) {
    await delay(1500);
    const recalcReceiptFile = path.join(runDir, `decision-history-recalc-receipt-${stamp()}.json`);
    const recalc = spawnDecisionHistory({
      args: buildDecisionHistoryArgs({
        profile, options, table, historyTable, previousTable, receiptFile: recalcReceiptFile, backupDir, recalculate: true,
      }),
      label: 'Decision-history snapshot recalculate (第二遍)',
      spawn,
    });
    secondPass = {
      reason: '历史表本批次的公式列与源表现值不一致（第一遍快照定格在基数写入之前的中间态）',
      mismatchBefore: readback.visualMismatchCount,
      mismatchByFieldBefore: readback.visualMismatchByField,
      status: recalc.payload.mode,
      historyRecordsWritten: recalc.payload.planned?.historySnapshotsToWrite ?? null,
      receiptFile: recalc.payload.receiptFile ?? recalcReceiptFile,
    };
    readback = await readDecisionHistoryReadback(reader, options, table, historyTable, { delay });
  }

  const ok = readback.countsBlank.length === 0 && readback.visualMismatchCount === 0;
  return {
    ...summary,
    status: ok ? 'APPLIED_AND_VERIFIED' : 'APPLIED_WITH_GAPS',
    mode: 'apply',
    wrote: true,
    receiptFile: first.payload.receiptFile ?? receiptFile,
    backupFile: first.payload.backup?.file ?? null,
    secondPass,
    readback,
  };
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

  // 第三段的表解析：给 `--history-table-name`/`-id` 才启用。复用同一套 resolveTable ——
  // 「名字与 id 各错一半」在这一步后果最重：历史表 2300+ 行，快照写错一张表是不可逆的。
  // 上一张分析表同样在这里解析（1.6 要求 id 与 name 成对，所以两个都得给出真实存在的值）。
  const decisionEnabled = Boolean(options.historyTableName || options.historyTableId);
  const historyTable = decisionEnabled
    ? resolveTable(tables, { tableName: options.historyTableName, tableId: options.historyTableId })
    : undefined;
  const previousTable = decisionEnabled
    ? resolveTable(tables, { tableName: options.previousTableName, tableId: options.previousTableId })
    : undefined;

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
    // 第三段在 dry-run 里也跑一遍：不带 `--apply` 时它只回答「现在缺不缺」，一次写入都不发起。
    // 这样「本地分析好了，飞书那边还缺哪一跳」在同一次调用里就有答案，不用等人记得另跑一条命令。
    const decisionHistory = decisionEnabled
      ? await runDecisionHistoryStage({ profile, options, table, historyTable, previousTable, reader, runDir })
      : undefined;
    const payload = { ...analysis, decisionHistory };
    if (!decisionEnabled && !options.skipDecisionHistory) payload.decisionHistoryHint = DECISION_HISTORY_HINT;
    console.log(JSON.stringify(payload, null, 2));
    return payload;
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

  // 第三段：决策历史同步。**必须在 ①② 之后** —— 它读本期的
  // `关键词分类`/`细分标签`/`内容热度`/`优先级`/`是否重点词` 来算达标与快照，
  // 前面少写一个字段，这里就会照着一个半成品算出一批错的达标值（那是静默的错，不是保守）。
  const decisionHistory = decisionEnabled
    ? await runDecisionHistoryStage({ profile, options, table, historyTable, previousTable, reader, runDir })
    : undefined;

  // 独立回读：不采信写入器的自报，重新读一遍表，逐字段数「有几格有值」，再交给判据。
  const afterRecords = await reader.listRecords(table.table_id);
  const afterFilled = Object.fromEntries(LOCAL_ANALYSIS_FIELDS.map((name) => [
    name, afterRecords.filter((record) => !isBlank(record.fields?.[name])).length,
  ]));
  const judgement = judgeLocalAnalysisReadback({
    afterFilled, afterRows: afterRecords.length, ruleValues, decisionHistory,
  });
  const { stillBlank, expectedBlank, unexplainedBlank } = judgement;
  const receipt = {
    // 单字状态只在这两种里选：本地五列没有**解释不了**的空缺，且决策历史那一段也落地了。
    // 历史上这里只看「表上有没有空格」，于是「细分标签本来就该空」会永久报黄、
    // 而「基数没回写」会报绿 —— 一个假黄一个假绿，两种都会让人不再看这个字段。
    status: judgement.status,
    collectionDate: options.collectionDate,
    batchNumber: options.batchNumber,
    table,
    expectedRows: options.expectedRows,
    readbackRows: afterRecords.length,
    filledAfterApply: afterFilled,
    stillBlank,
    expectedBlank,
    unexplainedBlank,
    rule: { status: ruleResult.status, fieldsWritten: ruleResult.fieldsWritten, receiptFile: ruleResult.receiptFile },
    contentHeat: { status: heatResult.status, fieldsWritten: heatResult.fieldsWritten, receiptFile: heatResult.receiptFile },
    decisionHistory,
    analysisManifest: files.manifest,
  };
  if (!decisionEnabled && !options.skipDecisionHistory) receipt.decisionHistoryHint = DECISION_HISTORY_HINT;
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
