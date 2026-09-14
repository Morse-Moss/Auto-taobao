// sycm.feishu.weekly 的运行时实现入口（Spec 11.1 Adapter 契约 + 发布段钩子）。
//
// 为什么需要这个文件：manifest.entry 原本指向 CLI（run-weekly-pre-ai.mjs），
// 而 CLI 不满足适配器契约，Controller 按能力 ID 调用时装不出 Worker。
// 本文件把同一条业务路径拆成架构要求的两段：
//   COLLECT（无外部写入）：SYCM 导出 → 源文件对校验 → 解析源行 → 可复验工件
//   PUBLISH（有外部写入）：克隆上周周表 → 导入本周行 → 回读新表与历史表验收
//
// 一条重要的架构边界（必须写明，否则会被误读为「迁移没做完」）：
// 周更 SOP 里「克隆 + 导入」之后还要等飞书 AI 结算，再跑 sync-decision-history。
// 那是**第二个发布单元**，依赖一个非确定性的外部结算过程；不能塞进同一次 publish
// （一次 publish 只能覆盖一个确定性的外部写入 + 一次回读）。本文件只覆盖第一个。
//
// CLI（run-weekly-pre-ai.mjs / update-weekly-base.mjs / copy-weekly-table.mjs /
// sync-decision-history.mjs）仍是人工运维入口，未被替代。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSourceCsv } from './update-weekly-base.mjs';

export const capabilityId = 'sycm.feishu.weekly';
export const manifestVersion = '1.1.0';

export const ARTIFACT_SCHEMA_VERSION = 'sycm-weekly-source-v1';

// 源行字段合同来自能力自己的解析器，这里不另抄一份清单。
export const SOURCE_FIELDS = Object.freeze(['排名', '搜索词', '搜索人气', '点击率', '支付转化率']);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const EXPORT_SCRIPT = path.join(PROJECT_ROOT, 'skills', 'sycm-export-search-rank', 'scripts', 'export-search-rank.mjs');
const COPY_SCRIPT = path.join(SCRIPT_DIR, 'copy-weekly-table.mjs');
const UPDATE_SCRIPT = path.join(SCRIPT_DIR, 'update-weekly-base.mjs');

// 稳定序列化：键排序，保证同一份解析结果每次得到同一摘要（否则 digest 校验会随机失败）。
export function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

// ── 依赖注入（测试用）─────────────────────────────────────────────────────
// 采集段会真的启动浏览器导出，测试必须能替换掉；生产路径用默认实现。
function defaultRunProcess(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: PROJECT_ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim();
    throw Object.assign(new Error(`Stage failed (${path.basename(script)}, exit ${result.status}): ${message}`), {
      failureClass: 'CAPABILITY_DEGRADED',
    });
  }
  return JSON.parse(result.stdout.trim());
}

let deps = {
  runProcess: defaultRunProcess,
  parseSourceCsv,
  verifyPair: null,   // 默认实现延迟加载 sycm-export-search-rank 的 verifyExportPair
  readRecords: null,  // 默认实现延迟加载 FeishuApi
};

export function setDependenciesForTest(overrides = {}) {
  deps = { ...deps, ...overrides };
}

export function resetDependenciesForTest() {
  deps = { runProcess: defaultRunProcess, parseSourceCsv, verifyPair: null, readRecords: null };
}

async function verifyPair(payload) {
  if (deps.verifyPair) return deps.verifyPair(payload);
  const module = await import('../../sycm-export-search-rank/scripts/source-period-proof.mjs');
  return module.verifyExportPair(payload);
}

// ── 采集段 ────────────────────────────────────────────────────────────────
// 单次流程内的阶段状态。Worker 只跑一次采集，进程内单例足够；
// 发布段不读这里，只读落盘工件的字节（跨进程恢复的前提）。
const state = { artifact: null, rows: null, source: null, target: null, expected: null };

export function resetStateForTest() {
  state.artifact = null;
  state.rows = null;
  state.source = null;
  state.target = null;
  state.expected = null;
}

function parseBaseUrl(baseUrl) {
  const parsed = new URL(String(baseUrl ?? ''));
  const match = parsed.pathname.match(/^\/base\/([^/]+)$/u);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.feishu.cn') || !match) {
    throw new Error('baseUrl must be an https://*.feishu.cn/base/<app-token> URL');
  }
  return { appToken: match[1], tableId: parsed.searchParams.get('table') ?? null };
}

function requirePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function requireDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? '')) || !Number.isFinite(Date.parse(`${value}T00:00:00+08:00`))) {
    throw new Error(`${name} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function parseTarget(target) {
  const { appToken } = parseBaseUrl(target.baseUrl);
  const required = ['sourceTableId', 'sourceTableName', 'historyTableId', 'libraryTableId', 'protectedTableId', 'protectedTableName'];
  for (const key of required) {
    if (!target[key]) throw new Error(`target.${key} is required`);
  }
  return {
    baseUrl: target.baseUrl,
    appToken,
    sourceTableId: target.sourceTableId,
    sourceTableName: target.sourceTableName,
    newTableName: target.newTableName ?? `关键词分析 V1（${target.collectionDate ?? ''}）`,
    historyTableId: target.historyTableId,
    libraryTableId: target.libraryTableId,
    protectedTableId: target.protectedTableId,
    protectedTableName: target.protectedTableName,
  };
}

// 每字段非空计数：工件据此自证「源字段都被解析出来」，
// 正好可被 manifest 声明的 structure 验证器（按 requiredFields 查键存在）使用。
function columnFillCounts(rows) {
  const counts = {};
  for (const name of SOURCE_FIELDS) {
    counts[name] = rows.reduce((total, row) => {
      const value = row?.[name];
      return total + (value === undefined || value === null || String(value) === '' ? 0 : 1);
    }, 0);
  }
  return counts;
}

export const adapter = {
  async checkSession() {
    // 采集段只做本地读取与派生；平台会话前置由导出子进程自己负责（失败会带 CAPABILITY_DEGRADED）。
    return { ok: true };
  },

  async prepare(input = {}) {
    if (!input.outputDir) throw new Error('outputDir is required for the SYCM export stage');
    const hasPair = Boolean(input.sourceCsv) && Boolean(input.sourceXlsx);
    if (Boolean(input.sourceCsv) !== Boolean(input.sourceXlsx)) {
      throw new Error('explicit reuse requires both sourceCsv and sourceXlsx');
    }
    requireDate(input.collectionDate, 'collectionDate');
    if (!hasPair && !input.cateId) throw new Error('cateId is required when no sourceCsv/sourceXlsx pair is supplied');
    for (const key of ['sourceCsv', 'sourceXlsx']) {
      if (input[key] && !existsSync(input[key])) throw new Error(`${key} not found: ${input[key]}`);
    }
    // 目标地址在采集期只做格式校验，不发起任何网络请求。
    parseTarget({ ...(input.target ?? {}), collectionDate: input.collectionDate });
    requirePositiveInteger(input.batchNumber, 'batchNumber');
    requirePositiveInteger(input.expectedHistoryBefore, 'expectedHistoryBefore');
    return undefined;
  },

  async start(input = {}) {
    const target = parseTarget({ ...(input.target ?? {}), collectionDate: input.collectionDate });
    let sourceCsv = input.sourceCsv ?? null;
    let sourceXlsx = input.sourceXlsx ?? null;
    let exportReceipt = null;

    if (!sourceCsv) {
      exportReceipt = deps.runProcess(EXPORT_SCRIPT, [
        '--from-home', '--period', '7d', '--date', input.collectionDate,
        '--cate-id', input.cateId, '--category', input.sycmCategory ?? '普通浴缸',
        '--proxy', input.proxy ?? 'http://127.0.0.1:3456', '--output-dir', input.outputDir,
        '--prefix', input.prefix ?? `ordinary-bathtub-week-${input.collectionDate.replaceAll('-', '')}`,
      ]);
      if (!exportReceipt?.ok || !exportReceipt.csv || !exportReceipt.xlsx) {
        throw Object.assign(new Error('SYCM export did not return validated CSV and XLSX paths'), { failureClass: 'EVIDENCE_INVALID' });
      }
      const reporting = exportReceipt.metadata;
      if (reporting?.period !== '7天' || reporting?.dayCount !== 7 || reporting?.endDate !== input.collectionDate) {
        throw Object.assign(new Error('SYCM export did not prove a verified 7-day reporting window ending on the collection date'), {
          failureClass: 'EVIDENCE_INVALID',
        });
      }
      sourceCsv = exportReceipt.csv;
      sourceXlsx = exportReceipt.xlsx;
    }

    const proof = await verifyPair({ csv: sourceCsv, xlsx: sourceXlsx, expectedEndDate: input.collectionDate });
    const rows = deps.parseSourceCsv(readFileSync(sourceCsv, 'utf8'));
    if (Number(proof.rowCount) !== rows.length) {
      throw Object.assign(new Error(`source proof expected ${proof.rowCount} rows; CSV contains ${rows.length}`), {
        failureClass: 'EVIDENCE_INVALID',
      });
    }

    state.rows = rows;
    state.source = {
      mode: input.sourceCsv ? 'EXPLICIT_EXPORT_PAIR' : 'FRESH_SYCM_EXPORT',
      csv: sourceCsv, xlsx: sourceXlsx, rows: rows.length, proof, exportReceipt,
    };
    state.target = target;
    state.expected = {
      sourceRows: rows.length,
      historyBefore: requirePositiveInteger(input.expectedHistoryBefore, 'expectedHistoryBefore'),
      batchNumber: requirePositiveInteger(input.batchNumber, 'batchNumber'),
      collectionDate: input.collectionDate,
      category: input.category ?? '浴缸',
    };
    state.artifact = null;
    return { rows: rows.length, collectionDate: input.collectionDate, proof };
  },

  async observe({ context, started } = {}) {
    if (!state.rows) throw new Error('no source rows; start() must run first');
    return {
      identity: context.identity,
      rows: state.rows.length,
      collectionDate: started?.collectionDate ?? state.expected?.collectionDate ?? null,
      proofEndDate: started?.proof?.endDate ?? null,
      rowCountProof: started?.proof?.rowCount ?? null,
      targetTableId: state.target?.sourceTableId ?? null,
      keywords: state.rows.map((row) => row['搜索词']),
    };
  },

  async collectArtifact() {
    if (!state.rows) throw new Error('no source rows; start() must run first');
    const payload = {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      capability: capabilityId,
      capabilityVersion: manifestVersion,
      expected: state.expected,
      source: state.source,
      target: state.target,
      fields: [...SOURCE_FIELDS],
      rows: state.rows,
    };
    const bytes = Buffer.from(`${stableJson(payload)}\n`, 'utf8');
    const rowCount = state.rows.length;
    state.artifact = {
      artifactId: 'sycm-weekly-source',
      artifactKind: 'json',
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      rowCount,
      range: { start: 1, end: rowCount },
      // 把工件的身份键抬到工件对象表面：structure 验证器只看工件对象的键，
      // 字节内部的语义（expected/source/target/rows）由 adapter.validate 负责。
      // 两边各管一层，避免「契约声明的键根本不在被校验对象上」这种空转校验。
      schemaVersion: payload.schemaVersion,
      capability: payload.capability,
      capabilityVersion: payload.capabilityVersion,
      fields: payload.fields,
      ...columnFillCounts(state.rows),
    };
    return state.artifact;
  },

  // 能力自检：字段合同、排名连续性与关键词唯一性都由能力自己判定
  // （manifest 的 structure/contiguous_prefix 验证器只看工件结构，不看业务语义）。
  async validate(artifact, context) {
    if (!artifact?.bytes) return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'no artifact' } };
    let payload;
    try {
      payload = JSON.parse(artifact.bytes.toString('utf8'));
    } catch (error) {
      return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: String(error?.message ?? error) } };
    }
    if (payload.schemaVersion !== ARTIFACT_SCHEMA_VERSION) {
      return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: `schemaVersion must be ${ARTIFACT_SCHEMA_VERSION}` } };
    }
    const rows = payload.rows ?? [];
    if (rows.length === 0) return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'no rows' } };
    if (Number(payload.expected?.sourceRows) !== rows.length) {
      return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'expected.sourceRows does not match rows length' } };
    }
    if (Number(payload.source?.proof?.rowCount) !== rows.length) {
      return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'source proof rowCount does not match rows length' } };
    }
    if (payload.source?.proof?.endDate !== payload.expected?.collectionDate) {
      return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'source proof endDate does not match collectionDate' } };
    }
    // 与 parseSourceCsv 同源的语义约束，在工件上重验一次——
    // 工件可能被跨进程读回，不能假设它一定出自刚跑过的解析器。
    const ranks = rows.map((row) => Number(row['排名']));
    if (ranks.some((rank, index) => rank !== index + 1)) {
      return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'ranks must be contiguous from 1' } };
    }
    if (rows.some((row) => SOURCE_FIELDS.some((name) => String(row[name] ?? '') === ''))) {
      return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'source fields must not be empty' } };
    }
    const keywords = rows.map((row) => row['搜索词']);
    if (new Set(keywords).size !== keywords.length) {
      return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'search terms must be unique' } };
    }
    // target 必须与准入身份一致：防止「按 A 账号准入、却写 B 目标」。
    if (payload.target?.appToken && context?.target) {
      const expected = parseBaseUrl(context.target).appToken;
      if (expected !== payload.target.appToken) {
        return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'artifact target does not match the admitted target' } };
      }
    }
    return { ok: true };
  },

  async release() {},
};

export function artifactOf() {
  return state.artifact;
}

// 采集期合同：能力自描述，运行器不需要替本能力维护 requiredFields 清单。
// structure 验证器按 requiredFields 检查**工件对象**上的键存在——这里列的正是工件对象表面的键：
// 工件的身份键 + 5 个源字段的非空计数（非空计数就是「字段真的被解析出来了」的证据）。
// 字节内部的 expected/source/target/rows 由 adapter.validate 校验，不在这里重复声明。
export function collectContract() {
  return {
    requiredFields: ['schemaVersion', 'capability', 'capabilityVersion', 'fields', ...SOURCE_FIELDS],
  };
}

// ── 发布段钩子 ────────────────────────────────────────────────────────────
// artifactBytes 是采集段落盘的工件字节，发布段据此重建输入，
// 因此发布段不依赖采集段的内存状态（跨进程恢复时从证据库读回即可）。
export function createPublisher({ artifactBytes, evidence = null, period = null, target = null, publishInput = {}, env = null } = {}) {
  const payload = artifactBytes ? JSON.parse(artifactBytes.toString('utf8')) : null;
  if (!payload) throw new Error('artifactBytes is required for the publish stage');
  const weekly = payload.target;
  const expected = payload.expected;
  const envFile = publishInput.envFile ?? env?.envFile ?? null;
  const proxy = publishInput.proxy ?? 'http://127.0.0.1:3456';
  const dryRun = publishInput.dryRun !== false;

  return {
    async handler() {
      const written = [];
      // 1) 克隆上周周表（保留字段与公式结构，不带记录）
      const copy = deps.runProcess(COPY_SCRIPT, [
        '--base-url', weekly.baseUrl,
        '--source-table-id', weekly.sourceTableId,
        '--source-table-name', weekly.sourceTableName,
        '--new-table-name', weekly.newTableName,
        '--proxy', proxy,
        ...(dryRun ? [] : ['--apply', '--confirm-base', weekly.appToken]),
      ]);
      written.push({ stage: 'copy-weekly-table', receipt: copy });
      const newTableId = copy?.newTableId ?? copy?.tableId ?? null;
      if (!dryRun && !newTableId) throw new Error('copy-weekly-table did not return the new table id');

      // 2) 把本周源行写入新周表（CLI 会自行重验源文件对与字段合同）
      const update = deps.runProcess(UPDATE_SCRIPT, [
        '--base-url', weekly.baseUrl,
        '--source-csv', payload.source.csv,
        '--source-xlsx', payload.source.xlsx,
        '--weekly-table-id', newTableId ?? weekly.sourceTableId,
        '--weekly-table-name', weekly.newTableName,
        '--history-table-id', weekly.historyTableId,
        '--library-table-id', weekly.libraryTableId,
        '--protected-table-id', weekly.protectedTableId,
        '--protected-table-name', weekly.protectedTableName,
        '--collection-date', expected.collectionDate,
        '--batch-number', String(expected.batchNumber),
        '--expected-source-rows', String(expected.sourceRows),
        '--expected-history-before', String(expected.historyBefore),
        '--category', expected.category,
        '--env-file', envFile ?? 'E:/小红书/.env.local',
        ...(dryRun ? [] : ['--apply', '--confirm-base', weekly.appToken, '--confirm-weekly-table', newTableId]),
      ]);
      written.push({ stage: 'update-weekly-base', receipt: update, weeklyTableId: newTableId });
      return { newTableId, weeklyTableId: newTableId, stages: written, sourceRows: payload.rows.length };
    },

    async readBack() {
      const weeklyTableId = publishInput.weeklyTableId ?? null;
      if (!weeklyTableId) throw new Error('readBack requires publishInput.weeklyTableId (the table created by copy-weekly-table)');
      const readRecords = deps.readRecords ?? await defaultReadRecords(env);
      const weeklyRecords = await readRecords({ tableId: weeklyTableId });
      const historyRecords = await readRecords({ tableId: weekly.historyTableId });
      const digest = createHash('sha256')
        .update(stableJson(weeklyRecords.map((record) => record?.fields ?? {})))
        .digest('hex');
      return {
        verifiedAt: new Date().toISOString(),
        rows: weeklyRecords.length,
        historyRows: historyRecords.length,
        digest,
        weeklyTableId,
      };
    },
  };
}

async function defaultReadRecords(env) {
  const appId = env?.FEISHU_APP_ID;
  const appSecret = env?.FEISHU_APP_SECRET;
  if (!appId || !appSecret) throw new Error('readBack requires FEISHU_APP_ID and FEISHU_APP_SECRET');
  const { FeishuApi, assertDecisionHistoryMutation } = await import('./sync-decision-history.mjs');
  const appToken = env.appToken;
  if (!appToken) throw new Error('readBack requires the base app token');
  const api = new FeishuApi({
    appId, appSecret, appToken,
    mutationGuard: (mutation) => assertDecisionHistoryMutation(mutation, { appToken }),
  });
  await api.authenticate();
  return ({ tableId }) => api.listRecords(tableId);
}
