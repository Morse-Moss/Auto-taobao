// sycm.search-rank.export 的运行时实现入口（Spec 11.1 Adapter 契约）。
//
// 为什么需要这个文件：capability 原本的 manifest.entry 指向 CLI（scripts/export-search-rank.mjs），
// 而 CLI 不是适配器契约模块，Controller 按能力 ID 调用时无法装配 Worker。
// 本文件把同一条业务路径接到 Worker 契约（checkSession/prepare/start/observe/collectArtifact/validate/release）。
//
// 这条能力是**只读采集**：sideEffects = [browser_read, local_artifact]，没有任何外部写。
// 因此它只有 COLLECT 段，**刻意不导出 createPublisher**：
//   - 导出一个「什么都不做」的 publisher 会把「读」伪装成「写」，让 publicationStatus 从
//     NOT_REQUESTED 变成别的状态，凭空制造一条需要回读的外部写入；
//   - 通用两段式运行器在缺省（非 --commit）时保持 publicationStatus=NOT_REQUESTED 且不推进游标，
//     这正是只读能力应有的收据语义。
//
// 工件 = **证据 manifest 的 JSON 字节**（evidenceSchemaVersion=sycm-search-rank-evidence-v1）。
// 为什么不直接拿 CSV 当工件：单看一个 CSV 说不出「这批数据来自哪个类目页、哪个七天窗口、
// 哪些分页、排名是否连续 1..N」。证据要能自证来源与范围，才谈得上对抗性复核。
// CSV/XLSX 作为**产物**记录在证据里（路径 + sha256 + 字节数），仍可被独立复验。
//
// 与 runtime/ 的关系：本文件不 import runtime/（反向依赖冻结，见实施计划风险表）。
// 契约判定（工件表面字段、摘要、范围）在 runtime 侧另有一份同义实现，由交叉验证测试兜住漂移。
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';

import { resolveExportArgs, runSearchRankExport } from './export-search-rank.mjs';

export const capabilityId = 'sycm.search-rank.export';
export const manifestVersion = '1.1.0';
export const EVIDENCE_SCHEMA_VERSION = 'sycm-search-rank-evidence-v1';

// 错误码 → 运行时的失败分类。必须显式映射：
// Worker 只在 error.failureClass 缺失时才用关键词猜（且只认英文），
// 「证据不合格」被猜成 BUG 会让人去改代码而不是重新采集。
const FAILURE_CLASS_BY_CODE = Object.freeze({
  EVIDENCE_MISSING: 'EVIDENCE_INVALID',
  EVIDENCE_INCOMPLETE: 'EVIDENCE_INVALID',
  PRODUCT_MISSING: 'EVIDENCE_INVALID',
  FLOW_RUNNER_INVALID: 'CAPABILITY_DEGRADED',
});

export class SearchRankEvidenceError extends Error {
  constructor(message, code, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'SearchRankEvidenceError';
    this.code = code;
    this.details = details;
    this.failureClass = FAILURE_CLASS_BY_CODE[code] ?? 'BUG';
  }
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// 稳定序列化：键排序。工件摘要必须只由内容决定，否则同一份证据每次得到不同 sha256，
// digest 校验会随机失败（这类"偶发失败"最难排查）。
export function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

// 工件的可复验字段集合。collectContract().requiredFields 与这里的列表必须一致——
// 两处漂移会让 structure 验证器检查一组键、而 validate() 检查另一组键（D11 类缺陷）。
const SURFACE_FIELDS = Object.freeze([
  'schemaVersion',
  'identity',
  'sourceUrl',
  'cateId',
  'category',
  'startDate',
  'endDate',
  'dayCount',
  'pages',
  'rowCount',
  'pageSizes',
  'contiguousRanks',
  'products',
]);

// 进程内阶段状态：Worker 一次运行只跑一遍 COLLECT，单例足够。
// 跨进程恢复不依赖它——工件字节已落盘，需要时由字节重建（见 validate）。
let state = { args: null, result: null, logs: [] };
let flowRunner = runSearchRankExport;

// 测试缝：真实浏览器流程需要 Edge + SYCM 登录态，单元测试注入一个写夹具产物的流程。
// 只允许测试改，生产路径永远用默认的 runSearchRankExport。
export function setFlowRunnerForTest(fn) {
  if (typeof fn !== 'function') throw new SearchRankEvidenceError('flow runner must be a function', 'FLOW_RUNNER_INVALID');
  flowRunner = fn;
}

export function resetStateForTest() {
  state = { args: null, result: null, logs: [] };
  flowRunner = runSearchRankExport;
}

// 采集期合同：能力自描述，运行器不需要替每条能力维护 requiredFields。
export function collectContract() {
  return {
    capabilityId,
    capabilityVersion: manifestVersion,
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    // 只用工件**表面**字段，不用字节内部嵌套结构（structure 验证器只看这一层）。
    requiredFields: [...SURFACE_FIELDS],
    // 刻意不声明的验证器与理由。声明集合与实现能力必须对齐：
    // 声明了做不到的验证器只会制造假失败，漏声明则制造假通过——两种都要写清楚。
    omittedValidators: {
      artifact_integrity: 'it fails rowCount <= 0; a legitimate 7-day window can return an empty ranking, and emptiness is decided by the flow, not by this validator',
      digest: 'the evidence manifest digest is already recomputed in validate() over the artifact bytes; declaring it would double-count the same check without adding a guarantee',
      completeness: 'expected row count is not known before the export (the page decides how many ranks exist), so a declared range would be fabricated',
    },
  };
}

// 把流程内部错误归一成运行时的失败分类。
// 为什么必须显式做：流程用的是中文人工提示（code=HUMAN_REQUIRED），
// 而运行时的默认分类器按英文关键词匹配，会把「需要人工登录」误判成 BUG。
function toFlowFailure(error) {
  if (error?.failureClass) return error;
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? error);
  if (code === 'HUMAN_REQUIRED') {
    error.failureClass = 'HUMAN_REQUIRED';
    return error;
  }
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|UND_ERR|proxy/i.test(message)) {
    // 代理浏览器不可达是**可重试**的外部故障，不是能力坏了。
    error.failureClass = 'TRANSIENT_EXTERNAL';
    return error;
  }
  return error;
}

async function fileDescriptor(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size < 1) {
    throw new SearchRankEvidenceError(`export product is missing or empty: ${file}`, 'PRODUCT_MISSING', { file });
  }
  const bytes = await readFile(file);
  return { path: file, sha256: sha256Hex(bytes), sizeBytes: bytes.length };
}

export const adapter = {
  async checkSession() {
    // 会话校验需要具体 target（哪个标签页、哪个类目页），而 checkSession 早于 prepare(input) 拿不到输入。
    // 在这里假装探活只会得到一个与真实 target 无关的结论，因此真实守卫放在 start()：
    // 流程内部 guardSession/guardPage 会把「未登录 / 页面不对」升级为 HUMAN_REQUIRED。
    return { ok: true, note: 'session guard runs in start(); it needs the resolved target from prepare(input)' };
  },

  async prepare(input = {}) {
    const args = resolveExportArgs(input);
    await mkdir(args.outputDir, { recursive: true });
    state.args = args;
    state.result = null;
    state.logs = [];
    return { proxy: args.proxy, cateId: args.cateId, category: args.category, outputDir: args.outputDir };
  },

  async start(input = {}) {
    const args = state.args ?? resolveExportArgs(input);
    const log = (message) => {
      state.logs.push(String(message));
    };
    let result;
    try {
      result = await flowRunner(args, { log });
    } catch (error) {
      throw toFlowFailure(error);
    }
    const meta = result?.metadata ?? {};
    if (!result?.csvFile || !result?.xlsxFile) {
      throw new SearchRankEvidenceError('flow returned no CSV/XLSX pair', 'PRODUCT_MISSING', { result });
    }
    state.result = result;
    return {
      started: true,
      exportedAt: meta.exportedAt ?? null,
      sourceUrl: meta.sourceUrl ?? null,
      cateId: meta.cateId ?? null,
      category: meta.category ?? null,
      pages: meta.pages ?? null,
      rowCount: meta.rowCount ?? null,
      csv: result.csvFile,
      xlsx: result.xlsxFile,
    };
  },

  async observe({ context, started } = {}) {
    const result = state.result;
    if (!result) {
      throw new SearchRankEvidenceError('no export result; start() must run first', 'EVIDENCE_MISSING', { started });
    }
    const meta = result.metadata ?? {};
    return {
      identity: context?.identity ?? null,
      sourceUrl: meta.sourceUrl ?? null,
      source: meta.source ?? null,
      cateId: meta.cateId ?? null,
      category: meta.category ?? null,
      period: meta.period ?? null,
      startDate: meta.startDate ?? null,
      endDate: meta.endDate ?? null,
      dayCount: meta.dayCount ?? null,
      dateRange: meta.dateRange ?? null,
      exportedAt: meta.exportedAt ?? null,
      pages: meta.pages ?? null,
      pageSizes: meta.pageSizes ?? null,
      rowCount: meta.rowCount ?? null,
      rankRange: meta.rankRange ?? null,
      uniqueRanks: meta.uniqueRanks ?? null,
      contiguousRanks: meta.contiguousRanks ?? null,
      uniqueTerms: meta.uniqueTerms ?? null,
      nonEmptyMetrics: meta.nonEmptyMetrics ?? null,
    };
  },

  async collectArtifact({ context, observation } = {}) {
    const result = state.result;
    if (!result) {
      throw new SearchRankEvidenceError('no export result; start() must run first', 'EVIDENCE_MISSING');
    }
    const csv = await fileDescriptor(result.csvFile);
    const xlsx = await fileDescriptor(result.xlsxFile);
    const rowCount = Number(observation?.rowCount ?? result.metadata?.rowCount ?? 0);
    if (!Number.isInteger(rowCount) || rowCount < 1) {
      throw new SearchRankEvidenceError(`export produced no rows (rowCount=${rowCount})`, 'EVIDENCE_MISSING', { rowCount });
    }
    const payload = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      identity: context?.identity ?? null,
      source: result.metadata?.source ?? null,
      sourceUrl: result.metadata?.sourceUrl ?? null,
      cateId: result.metadata?.cateId ?? null,
      category: result.metadata?.category ?? null,
      period: result.metadata?.period ?? null,
      startDate: result.metadata?.startDate ?? null,
      endDate: result.metadata?.endDate ?? null,
      dayCount: result.metadata?.dayCount ?? null,
      dateRange: result.metadata?.dateRange ?? null,
      exportedAt: result.metadata?.exportedAt ?? null,
      pages: result.metadata?.pages ?? null,
      pageSizes: result.metadata?.pageSizes ?? null,
      rowCount,
      rankRange: result.metadata?.rankRange ?? null,
      uniqueRanks: result.metadata?.uniqueRanks ?? null,
      contiguousRanks: result.metadata?.contiguousRanks ?? null,
      uniqueTerms: result.metadata?.uniqueTerms ?? null,
      nonEmptyMetrics: result.metadata?.nonEmptyMetrics ?? null,
      proof: result.proof ?? null,
      products: { csv, xlsx },
    };
    // 工件表面必须带齐 collectContract().requiredFields 的每一个键——这里直接断言，
    // 而不是等 structure 验证器在运行时才发现（那个失败离根因太远，很难定位）。
    const missing = SURFACE_FIELDS.filter((field) => payload[field] === undefined || payload[field] === null);
    if (missing.length) {
      throw new SearchRankEvidenceError(`evidence payload is missing required fields: ${missing.join(', ')}`, 'EVIDENCE_INCOMPLETE', { missing });
    }
    const bytes = Buffer.from(stableJson(payload), 'utf8');
    return {
      ...payload,
      artifactId: `sycm-search-rank-${context?.runId ?? 'unknown'}`,
      artifactKind: 'json',
      bytes,
      sha256: sha256Hex(bytes),
      rowCount,
      // 搜索排行天然从第 1 名开始且连续（流程内 validateRows 已保证 1..N 连续无重）。
      // 因此 1..rowCount 是对已发生事实的陈述，不是对未来的期望。
      range: { start: 1, end: rowCount },
    };
  },

  // 能力自检。走到这里说明流程已经通过（排名连续、无重、分页合规、CSV/XLSX 配对校验）。
  // 因此这里只兜三件事：摘要可复算、表面字段与字节内容一致、产物文件仍然存在且摘要未变。
  async validate(artifact) {
    if (!artifact) return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'no artifact' } };
    if (!artifact.bytes) return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'missing bytes' } };
    if (!/^[0-9a-f]{64}$/u.test(String(artifact.sha256 ?? ''))) {
      return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'missing sha256 digest' } };
    }
    const recomputed = sha256Hex(artifact.bytes);
    if (recomputed !== artifact.sha256) {
      return { ok: false, code: 'DIGEST_MISMATCH', details: { expected: artifact.sha256, actual: recomputed } };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(artifact.bytes.toString('utf8'));
    } catch (error) {
      return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: `artifact bytes are not JSON: ${String(error?.message ?? error)}` } };
    }
    // 表面字段必须与字节内容逐字一致：否则「证据说 3 行、字节里其实是 300 行」这种改一半的篡改会静默通过。
    const mismatched = SURFACE_FIELDS.filter((key) => stableJson(parsed?.[key] ?? null) !== stableJson(artifact?.[key] ?? null));
    if (mismatched.length) {
      return { ok: false, code: 'STRUCTURE_INVALID', details: { reason: 'artifact surface disagrees with its own bytes', fields: mismatched } };
    }
    // 产物复验：证据里的 CSV/XLSX 必须在场且摘要不变。文件被删/被改都算证据无效，不降级成警告。
    for (const [kind, product] of Object.entries(parsed?.products ?? {})) {
      const file = product?.path;
      if (!file || !existsSync(file)) {
        return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: `${kind} product is missing`, file } };
      }
      const bytes = await readFile(file);
      const actual = sha256Hex(bytes);
      if (actual !== product?.sha256 || bytes.length !== Number(product?.sizeBytes)) {
        return {
          ok: false,
          code: 'DIGEST_MISMATCH',
          details: { reason: `${kind} product changed after collection`, file, expected: product?.sha256, actual },
        };
      }
    }
    return { ok: true, code: null, details: {} };
  },

  async release() {
    // 本能力不创建也不关闭标签页：target 由代理浏览器持有，流程只在必要时新建 home 标签。
    // 关闭"未知资源"不是 Worker 的职责（Spec：Worker 不扫描或关闭未知资源）。
  },
};

export default adapter;
