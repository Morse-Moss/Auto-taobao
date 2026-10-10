import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 运行目录治理（spec §7 / §11，P3：运行产物隔离）。
 *
 * 本模块只做三件事：解析运行根目录、拼出一次运行的目录布局、落 manifest。
 * 不搬数据、不删历史证据、不理解任何业务字段。
 *
 * 三条纪律（写死在这里，任何调用方不得绕过）：
 *   1. 不得把凭据、Cookie、认证头写入任何子目录。
 *   2. 不在同一变更中移动或删除历史证据（清理只能依据明确保留策略并走单独变更）。
 *   3. 每次运行回执必须记录实际证据根路径与保留级别。
 *
 * 回滚（spec §11）：新目录解析失败时，调用方应回到旧 evidence 路径读取
 * （见 legacyEvidenceRoot）；本模块只提供旧路径，不搬数据。
 */

// 源码仓库根：本文件位于 <repo>/runtime/，向上一级。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 机器级外部运行根目录（默认值）：与源码仓库同级、位于仓库之外。
// 即 D:\Retire\sycm-automation -> D:\Retire\sycm-automation-runs。
const DEFAULT_EXTERNAL_RUN_ROOT = path.resolve(path.dirname(REPO_ROOT), 'sycm-automation-runs');

// spec §13 推荐值：成功 30 天、失败 180 天；未批准前不自动删除。
const DEFAULT_RETENTION = Object.freeze({
  successDays: 30,
  failureDays: 180,
  autoDelete: false
});

/** 传入值为 null/undefined/空串/纯空白时视为未提供。 */
function isProvided(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 解析运行根目录。优先级（spec §7.2）：
 *   --evidence-root 实参  >  SYCM_RUN_ROOT 环境变量  >  机器级外部默认目录
 *
 * 返回绝对路径（path.resolve）。本函数只算字符串，不创建目录——
 * 默认目录是否真实存在由 ensureRunLayout / 调用方决定。
 */
function resolveRunRoot({ cliRoot, envRoot } = {}) {
  if (isProvided(cliRoot)) return path.resolve(cliRoot.trim());
  if (isProvided(envRoot)) return path.resolve(envRoot.trim());
  if (isProvided(process.env.SYCM_RUN_ROOT)) return path.resolve(process.env.SYCM_RUN_ROOT.trim());
  return DEFAULT_EXTERNAL_RUN_ROOT;
}

/**
 * 段消毒：只允许 [A-Za-z0-9._-]。
 * 出现路径分隔符（/ 或 \）或 `..` 段直接抛错——防路径穿越。
 */
function safeSegment(kind, value) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`run-root: ${kind} 不能为空`);
  }
  if (value === '..' || value.includes('/') || value.includes('\\')) {
    throw new Error(`run-root: 非法 ${kind}（路径穿越）: ${JSON.stringify(value)}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`run-root: 非法 ${kind}（只允许 [A-Za-z0-9._-]）: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 纯函数：拼一次运行的目录布局（spec §7.2）。
 *
 *   <run-root>/<workflow>/<target-date>/<run-id>/
 *     run-receipt.json
 *     manifest.json
 *     logs/
 *     artifacts/
 *     screenshots/
 *     downloads/
 *
 * 只拼路径，不碰文件系统。
 */
function buildRunLayout(runRoot, workflowId, targetDate, runId) {
  if (!isProvided(runRoot)) throw new Error('run-root: runRoot 不能为空');
  const workflow = safeSegment('workflowId', workflowId);
  const date = safeSegment('targetDate', targetDate);
  const run = safeSegment('runId', runId);
  const root = path.resolve(runRoot, workflow, date, run);
  return {
    root,
    receiptFile: path.join(root, 'run-receipt.json'),
    manifestFile: path.join(root, 'manifest.json'),
    logsDir: path.join(root, 'logs'),
    artifactsDir: path.join(root, 'artifacts'),
    screenshotsDir: path.join(root, 'screenshots'),
    downloadsDir: path.join(root, 'downloads')
  };
}

/**
 * mkdir -p 全部子目录（recursive，幂等——已存在不抛错）。
 * 回执/清单是文件，保证其父目录（root）存在即可。
 * 返回原 layout。
 */
function ensureRunLayout(layout) {
  fs.mkdirSync(layout.root, { recursive: true });
  fs.mkdirSync(layout.logsDir, { recursive: true });
  fs.mkdirSync(layout.artifactsDir, { recursive: true });
  fs.mkdirSync(layout.screenshotsDir, { recursive: true });
  fs.mkdirSync(layout.downloadsDir, { recursive: true });
  return layout;
}

/**
 * 写运行 manifest（JSON）。retention 缺省值对齐 spec §13：
 * 成功 30 天、失败 180 天、未批准前不自动删除（autoDelete: false）。
 *
 * 纪律 3：manifest 里的 retention 与 evidencePolicy 就是回执要引用的保留级别记录，
 * 调用方生成 run-receipt 时必须回填实际证据根路径与这份保留级别。
 */
function writeManifest(file, { workflow, workflowVersion, targetDate, runId, mode, evidencePolicy, retention, notes } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const manifest = {
    schemaVersion: 'run-manifest-v1',
    workflow,
    workflowVersion,
    targetDate,
    runId,
    mode,
    evidencePolicy: evidencePolicy ?? 'run-root-v1',
    retention: { ...DEFAULT_RETENTION, ...(retention ?? {}) },
    notes: notes ?? null
  };
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

/**
 * 兼容期旧证据路径（spec §11 回滚）：`<repo>/evidence/batches-<date>`。
 * 仅供新目录解析失败时回到旧路径**读取**；本模块不搬数据、不删除。
 */
function legacyEvidenceRoot(dateInput) {
  return path.join(REPO_ROOT, 'evidence', 'batches-' + String(dateInput));
}

export {
  REPO_ROOT,
  DEFAULT_EXTERNAL_RUN_ROOT,
  DEFAULT_RETENTION,
  resolveRunRoot,
  buildRunLayout,
  ensureRunLayout,
  writeManifest,
  legacyEvidenceRoot
};
