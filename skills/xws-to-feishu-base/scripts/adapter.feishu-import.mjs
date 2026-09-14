// xws.feishu.import 的运行时实现入口（Spec 11.1 Adapter 契约 + 发布段钩子）。
//
// 为什么需要这个文件：capability 原本的 manifest.entry 指向 CLI（import-xws-to-feishu.mjs），
// 而 CLI 不是适配器契约模块，Controller 按能力 ID 调用时无法装配 Worker。
// 本文件把同一条业务路径拆成架构要求的两段：
//   COLLECT（无外部写入）：解析 XLSX → 生成可复验工件 → 交给 Worker + 采集期验证器
//   PUBLISH（有外部写入）：提交到飞书 → 真实回读 → 交给 Publisher + 发布期验证器
// 平台细节（Python 抽取器、飞书 API）只出现在本文件与它引用的同目录模块；Workflow 不接触。
//
// 注意：CLI（scripts/import-xws-to-feishu.mjs）仍是人工运维入口，未被替代；
// 它保留 dry-run/--commit 语义，本文件是运行时入口。
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { FAILURE_CLASS_BY_CODE, XWS_HEADERS, fatalError, parseBaseUrl, validateSourceHeaders } from './import-core.mjs';

export const capabilityId = 'xws.feishu.import';
export const manifestVersion = '1.1.0';

const EXTRACTOR_PATH = fileURLToPath(new URL('./extract_xws_xlsx.py', import.meta.url));

// 单次流程内的阶段状态。Worker 只跑一次采集，因此进程内单例足够；
// 跨进程恢复要重新解析（工件字节已落盘，可据此重建 input），见 PUBLISH 段的说明。
const state = { manifest: null, artifact: null };

// 稳定序列化：键排序，保证同一份解析结果每次得到同一摘要（否则 digest 校验会随机失败）。
export function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

// 默认抽取器：与 CLI 使用同一个 Python 脚本，其 stdout 即 manifest（headers/rows/images）。
export function extractXwsWorkbook({ xlsxPath, outputDir, python = null }) {
  const command = python ?? (process.platform === 'win32' ? 'py' : 'python3');
  const args = [
    ...(python || process.platform !== 'win32' ? [] : ['-3']),
    EXTRACTOR_PATH, xlsxPath, outputDir,
  ];
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) {
    throw fatalError(
      'EXTRACTION_FAILED',
      `XLSX extraction failed: ${(result.stderr || result.stdout || '').trim()}`,
      { status: result.status ?? null },
    );
  }
  return JSON.parse(result.stdout);
}

// 每列非空计数：工件据此自证「16 个源字段都被解析出来」，
// 正好可以被 manifest 声明的 structure 验证器（按 requiredFields 检查键是否存在）使用。
function columnFillCounts(headers, rows) {
  const counts = {};
  for (const name of headers) {
    counts[name] = rows.reduce((total, row) => {
      const value = row?.[name];
      return total + (value === undefined || value === null || value === '' ? 0 : 1);
    }, 0);
  }
  return counts;
}

// 供测试替换抽取器；生产路径用默认实现。
let extractImpl = extractXwsWorkbook;
export function setExtractorForTest(fn) { extractImpl = fn ?? extractXwsWorkbook; }

export const adapter = {
  async checkSession() {
    // 本地解析没有平台会话；真正的会话前置由发布段（飞书访问）承担。
    return { ok: true };
  },

  async prepare(input = {}) {
    if (!input.xlsxPath) throw fatalError('INPUT_REQUIRED', 'xlsxPath is required');
    if (!existsSync(input.xlsxPath)) throw fatalError('INPUT_NOT_FOUND', `XLSX file not found: ${input.xlsxPath}`, { path: input.xlsxPath });
    if (!input.outputDir) throw fatalError('INPUT_REQUIRED', 'outputDir is required for embedded image extraction');
    // 目标地址在采集期只做格式校验，不发起任何网络请求。
    if (!input.baseUrl) throw fatalError('INPUT_REQUIRED', 'baseUrl is required to bind the artifact to its target');
    parseBaseUrl(input.baseUrl);
  },

  async start(input = {}) {
    const manifest = extractImpl({ xlsxPath: input.xlsxPath, outputDir: input.outputDir, python: input.python ?? null });
    const countField = validateSourceHeaders(manifest.headers);
    if (!Array.isArray(manifest.rows) || manifest.rows.length === 0) {
      throw fatalError('SOURCE_EMPTY', 'XLSX contains no data rows');
    }
    state.manifest = manifest;
    state.artifact = null;
    return { rows: manifest.rows.length, images: (manifest.images ?? []).length, countField };
  },

  async observe({ context, started } = {}) {
    if (!state.manifest) throw fatalError('STAGE_ORDER', 'no extraction result; start() must run first');
    return {
      identity: context.identity,
      rows: state.manifest.rows.length,
      images: (state.manifest.images ?? []).length,
      headers: state.manifest.headers,
      countField: started?.countField ?? null,
    };
  },

  async collectArtifact() {
    if (!state.manifest) throw fatalError('STAGE_ORDER', 'no extraction result; start() must run first');
    const bytes = Buffer.from(stableJson(state.manifest), 'utf8');
    const rowCount = state.manifest.rows.length;
    state.artifact = {
      artifactId: 'xws-import-parse',
      artifactKind: 'json',
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      rowCount,
      range: { start: 1, end: rowCount },
      ...columnFillCounts(state.manifest.headers, state.manifest.rows),
    };
    return state.artifact;
  },

  // 能力自检：16 字段合同由 import-core 判定（manifest 的 structure 只检查工件结构）。
  async validate(artifact) {
    if (!artifact) return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'no artifact' } };
    const raw = artifact.bytes ? JSON.parse(artifact.bytes.toString('utf8')) : null;
    validateSourceHeaders(raw?.headers);
    if (!Array.isArray(raw?.rows) || raw.rows.length === 0) {
      return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'no rows' } };
    }
    return { ok: true };
  },

  async release() {},
};

// 供运行器/测试取出本次解析结果（发布段的 handler 输入）。
export function parsedManifest() {
  return state.manifest;
}

export function resetStateForTest() {
  state.manifest = null;
  state.artifact = null;
}

// 发布段钩子。artifactBytes 是采集段落盘的工件字节，发布段据此重建输入，
// 因此发布段不依赖采集段的内存状态（跨进程恢复时从证据库读回即可）。
export function createFeishuImportPublisher({ client, artifactBytes, period = null, prepareTarget = false }) {
  const manifest = artifactBytes ? JSON.parse(artifactBytes.toString('utf8')) : null;
  if (!manifest) throw fatalError('INPUT_REQUIRED', 'artifactBytes is required for the publish stage');

  return {
    async handler() {
      const { runImport } = await import('./import-runner.mjs');
      return runImport({ manifest, client, commit: true, prepareTarget, period });
    },
    async readBack() {
      const saved = await client.listRecords();
      const attachments = saved.reduce((total, record) => {
        const value = record?.fields?.商品图片;
        return total + (Array.isArray(value) ? value.length : 0);
      }, 0);
      const digest = createHash('sha256').update(stableJson(saved.map((record) => record.fields ?? {}))).digest('hex');
      return { verifiedAt: new Date().toISOString(), rows: saved.length, attachments, digest };
    },
  };
}

// 能力的失败码词表从适配器这里也可见：另三个适配器（sku-collection / search-rank /
// huitun-keyword-heat）都把 FAILURE_CLASS_BY_CODE 放在适配器模块上，运维排查时先看适配器。
// 词表本身定义在 import-core（采集段与发布段共用同一份），这里只做 re-export，不复制。
export { FAILURE_CLASS_BY_CODE, XWS_HEADERS };
