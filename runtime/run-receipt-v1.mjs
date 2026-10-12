import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { isValidCodeFingerprintShape } from './code-fingerprint.mjs';

/**
 * 统一运行回执（run-receipt-v1）——见 docs/ops/SYSTEM-ARCHITECTURE-OPTIMIZATION-EXECUTION-SPEC-2026-10-10.md §6。
 *
 * 与 runtime/workflow-receipt.mjs（兼容期旧格式）并列的第二种主格式，不得互相改写。
 *
 * 设计立场（spec §1 目标第 4 条、§6.3）：
 * 1. 一个字段只表达一个轴：execution（执行）、evidence（证据）、humanGate（人工）、
 *    lease（资源）、publication（发布）各自独立，不允许一个 status 隐含多个事实。
 * 2. execution=SUCCEEDED 与 publication=NOT_REQUESTED 可以并存：dry-run 成功就是这形态，
 *    干跑不写飞书但执行本身成功，二者不矛盾。
 * 3. 失败分类是闭合集（FAILURE_CLASSES），不允许自由字符串，未知失败必须归入 BUG 并留待分类。
 * 4. release.status 闭合集（本模块定死，不再扩展语义）：
 *    RELEASED（全部释放）/ HELD（仍持有）/ PARTIAL（部分释放）/ UNKNOWN（观察不可得，需复核端口）。
 */

export const RECEIPT_SCHEMA_VERSION = 'run-receipt-v1';

export const EXECUTION_STATUSES = Object.freeze(['QUEUED', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED']);
export const EVIDENCE_STATUSES = Object.freeze(['NONE', 'CANDIDATE', 'VALIDATED', 'REJECTED']);
export const HUMAN_GATE_STATUSES = Object.freeze(['NONE', 'WAITING_HUMAN', 'APPROVED', 'DENIED', 'EXPIRED']);
export const LEASE_STATUSES = Object.freeze(['WAITING', 'HELD', 'EXPIRED', 'RELEASED']);
export const PUBLICATION_STATUSES = Object.freeze(['NOT_REQUESTED', 'READY', 'COMMITTED', 'VERIFIED', 'UNKNOWN']);
export const RELEASE_STATUSES = Object.freeze(['RELEASED', 'HELD', 'PARTIAL', 'UNKNOWN']);
export const FAILURE_CLASSES = Object.freeze([
  'TRANSIENT_EXTERNAL',
  'RESOURCE_BUSY',
  'HUMAN_REQUIRED',
  'CAPABILITY_DEGRADED',
  'EVIDENCE_INVALID',
  'POLICY_DENIED',
  'USAGE_LIMIT_REACHED',
  'COMMIT_UNKNOWN',
  'BUG'
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function assertIn(values, value, label) {
  if (!values.includes(value)) {
    throw new Error(`invalid ${label}: ${JSON.stringify(value)} (allowed: ${values.join('/')})`);
  }
}

/** 构造 spec §6.2 最小结构回执骨架，execution 初始 RUNNING，finishedAt 留待 finalize。 */
export function createRunReceipt({ workflow, workflowVersion, targetDate, mode, batchSize, runId, codeFingerprint = null }) {
  if (!workflow || typeof workflow !== 'string') throw new Error(`invalid workflow.id: ${JSON.stringify(workflow)}`);
  if (!workflowVersion || !SEMVER_RE.test(workflowVersion)) throw new Error(`invalid workflow.version: ${JSON.stringify(workflowVersion)}`);
  if (!ISO_DATE_RE.test(String(targetDate ?? ''))) throw new Error(`invalid targetDate: ${JSON.stringify(targetDate)}`);
  if (mode !== 'dry-run' && mode !== 'apply') throw new Error(`invalid mode: ${JSON.stringify(mode)}`);
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error(`invalid batchSize: ${JSON.stringify(batchSize)}`);
  if (codeFingerprint !== null && !isValidCodeFingerprintShape(codeFingerprint)) {
    throw new Error(`invalid codeFingerprint: must be { gitHead, dirtyCount, dirtySha256 } (each nullable), got ${JSON.stringify(codeFingerprint)}`);
  }
  const finalRunId = runId || `${workflow}-${targetDate}-${crypto.randomUUID()}`;
  if (typeof finalRunId !== 'string' || !finalRunId) throw new Error(`invalid runId: ${JSON.stringify(runId)}`);
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    runId: finalRunId,
    workflow: { id: workflow, version: workflowVersion },
    targetDate,
    mode,
    batchSize,
    // 2026-10-12 加（HEAD-VS-WORKTREE 事故止血第 3 件）：起跑那一刻的代码版本指纹。
    // 缺省 null（采集失败或调用方没接），校验层允许 null 也允许合法形状，不许别的。
    codeFingerprint,
    execution: 'RUNNING',
    batches: [],
    shops: [],
    artifacts: [],
    failureClass: null,
    startedAt: new Date().toISOString()
  };
}

/** 追加一个批次（原地更新并返回回执；shops 缺省为空数组，execution 必须在轴内）。 */
export function appendBatch(receipt, { index, shops = [], execution = 'RUNNING', release = null } = {}) {
  if (!Number.isInteger(index) || index < 0) throw new Error(`invalid batch index: ${JSON.stringify(index)}`);
  assertIn(EXECUTION_STATUSES, execution, 'batch execution');
  if (!Array.isArray(shops) || shops.some((s) => typeof s !== 'string')) throw new Error('batch shops must be string[]');
  if (receipt.batches.some((b) => b.index === index)) throw new Error(`duplicate batch index: ${index}`);
  if (release != null) validateReleaseShape(release);
  receipt.batches.push({ index, shops: [...shops], execution, steps: [], ...(release ? { release } : {}) });
  return receipt;
}

/** 向第 batchIndex 个批次追加一步；evidence 缺省 []，publication 缺省 'NOT_REQUESTED'。 */
export function appendStep(receipt, batchIndex, { name, execution = 'SUCCEEDED', evidence = [], publication = 'NOT_REQUESTED' } = {}) {
  const batch = receipt.batches.find((b) => b.index === batchIndex);
  if (!batch) throw new Error(`batchIndex out of range: ${JSON.stringify(batchIndex)}`);
  if (!name || typeof name !== 'string') throw new Error(`invalid step name: ${JSON.stringify(name)}`);
  assertIn(EXECUTION_STATUSES, execution, 'step execution');
  if (!Array.isArray(evidence) || evidence.some((e) => typeof e !== 'string')) throw new Error('step evidence must be string[]');
  assertIn(PUBLICATION_STATUSES, publication, 'step publication');
  batch.steps.push({ name, execution, evidence, publication });
  return receipt;
}

/** 登记参与本轮的店铺（进 shops 汇总轴，与批次内名单独立）。 */
export function appendShop(receipt, shop) {
  if (typeof shop !== 'string' || !shop) throw new Error(`invalid shop: ${JSON.stringify(shop)}`);
  receipt.shops.push(shop);
  return receipt;
}

/**
 * 登记证据工件（结构化：`{ path, size, sha256 }`，spec §7.3「文件大小、哈希」）。
 *
 * size 与 sha256 由调用方对**落盘字节**算好传进来（本模块零 I/O，不读文件、不猜）；
 * path 是相对或绝对路径字符串，存在性不在本模块校验。
 * 2026-10-10 对抗审查整改（B 项）前签名为裸字符串 —— 本模块是本轮新文件，直接改签名，
 * 不保留字符串兼容形态（旧形态等于丢掉 size/哈希两条证据轴）。
 */
export function appendArtifact(receipt, artifact) {
  assertArtifactShape(artifact);
  receipt.artifacts.push({ ...artifact });
  return receipt;
}

/** artifacts 元素的形状判据（append 与 validate 共用同一份，两处各写就会漂）。 */
function assertArtifactShape(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error(`invalid artifact: must be { path, size, sha256 }, got ${JSON.stringify(artifact)}`);
  }
  if (typeof artifact.path !== 'string' || !artifact.path) {
    throw new Error(`invalid artifact.path: ${JSON.stringify(artifact.path)}`);
  }
  if (!Number.isInteger(artifact.size) || artifact.size < 0) {
    throw new Error(`invalid artifact.size: ${JSON.stringify(artifact.size)} (non-negative integer)`);
  }
  if (typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
    throw new Error(`invalid artifact.sha256: ${JSON.stringify(artifact.sha256)} (64 hex chars)`);
  }
}

/** 收尾：定格 execution、失败分类与 finishedAt。failureClass 必须来自闭合集或 null。 */
export function finalizeRunReceipt(receipt, { execution, failureClass = null, finishedAt = new Date().toISOString() } = {}) {
  assertIn(EXECUTION_STATUSES, execution, 'execution');
  if (failureClass !== null && !FAILURE_CLASSES.includes(failureClass)) {
    throw new Error(`invalid failureClass: ${JSON.stringify(failureClass)} (allowed: ${FAILURE_CLASSES.join('/')} or null)`);
  }
  if (!ISO_DATETIME_RE.test(finishedAt)) throw new Error(`invalid finishedAt: ${JSON.stringify(finishedAt)}`);
  receipt.execution = execution;
  receipt.failureClass = failureClass;
  receipt.finishedAt = finishedAt;
  return receipt;
}

function validateReleaseShape(release) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) throw new Error('release must be object { requested, observed, status }');
  if (typeof release.requested !== 'boolean' || typeof release.observed !== 'boolean') {
    throw new Error('release.requested/observed must be boolean');
  }
  assertIn(RELEASE_STATUSES, release.status, 'release.status');
}

/**
 * 校验回执，返回错误字符串数组（空数组=合法）。不做任何修复，也不抛错。
 * step.publication 缺省视为 'NOT_REQUESTED'；batch.release 缺省视为无释放记录（合法）。
 */
export function validateRunReceipt(receipt) {
  const errors = [];
  const fail = (msg) => errors.push(msg);
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return ['receipt must be an object'];
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) fail(`schemaVersion must be exactly "${RECEIPT_SCHEMA_VERSION}", got ${JSON.stringify(receipt.schemaVersion)}`);
  if (typeof receipt.runId !== 'string' || !receipt.runId) fail('runId must be a non-empty string');
  const wf = receipt.workflow;
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) {
    fail('workflow must be an object');
  } else {
    if (typeof wf.id !== 'string' || !wf.id) fail('workflow.id must be a non-empty string');
    if (typeof wf.version !== 'string' || !SEMVER_RE.test(wf.version)) fail(`workflow.version must be semver (x.y.z), got ${JSON.stringify(wf.version)}`);
  }
  if (typeof receipt.targetDate !== 'string' || !ISO_DATE_RE.test(receipt.targetDate)) fail(`targetDate must be YYYY-MM-DD, got ${JSON.stringify(receipt.targetDate)}`);
  if (receipt.mode !== 'dry-run' && receipt.mode !== 'apply') fail(`mode must be dry-run or apply, got ${JSON.stringify(receipt.mode)}`);
  if (!Number.isInteger(receipt.batchSize) || receipt.batchSize <= 0) fail(`batchSize must be a positive integer, got ${JSON.stringify(receipt.batchSize)}`);
  if (!EXECUTION_STATUSES.includes(receipt.execution)) fail(`top-level execution invalid: ${JSON.stringify(receipt.execution)}`);
  if (receipt.failureClass !== null && !FAILURE_CLASSES.includes(receipt.failureClass)) {
    fail(`failureClass must be null or one of ${FAILURE_CLASSES.join('/')}, got ${JSON.stringify(receipt.failureClass)}`);
  }
  if (typeof receipt.startedAt !== 'string' || !ISO_DATETIME_RE.test(receipt.startedAt)) fail(`startedAt must be an ISO string, got ${JSON.stringify(receipt.startedAt)}`);
  if (receipt.finishedAt !== undefined && (typeof receipt.finishedAt !== 'string' || !ISO_DATETIME_RE.test(receipt.finishedAt))) {
    fail(`finishedAt must be an ISO string, got ${JSON.stringify(receipt.finishedAt)}`);
  }
  if (!Array.isArray(receipt.batches)) fail('batches must be an array');
  if (!Array.isArray(receipt.shops)) fail('shops must be an array');
  if (!Array.isArray(receipt.artifacts)) fail('artifacts must be an array');
  // 代码版本指纹（2026-10-12 加）：缺省 null 合法（老回执/采集失败），但给了就必须是合法形状
  // —— 半截指纹（比如只有 dirtyCount 没有 gitHead）比没有更误导，当场点名拒绝。
  if (receipt.codeFingerprint !== null && receipt.codeFingerprint !== undefined
    && !isValidCodeFingerprintShape(receipt.codeFingerprint)) {
    fail(`codeFingerprint must be null or { gitHead, dirtyCount, dirtySha256 } (each nullable), got ${JSON.stringify(receipt.codeFingerprint)}`);
  }
  // shops 元素类型（2026-10-10 对抗审查 A3 加）：全字符串 —— 混进对象/数字要在点名处被拒，
  // 否则「失败店清单」里一个非字符串元素会静默穿透到收信人那端。
  receipt.shops?.forEach?.((shop, si) => {
    if (typeof shop !== 'string' || !shop) fail(`shops[${si}] must be a non-empty string, got ${JSON.stringify(shop)}`);
  });
  // artifacts 元素类型（同上）：全为 { path, size, sha256 } 形对象（spec §7.3）。
  receipt.artifacts?.forEach?.((artifact, ai) => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      fail(`artifacts[${ai}] must be { path, size, sha256 }, got ${JSON.stringify(artifact)}`);
      return;
    }
    if (typeof artifact.path !== 'string' || !artifact.path) {
      fail(`artifacts[${ai}].path must be a non-empty string, got ${JSON.stringify(artifact.path)}`);
    }
    if (!Number.isInteger(artifact.size) || artifact.size < 0) {
      fail(`artifacts[${ai}].size must be a non-negative integer, got ${JSON.stringify(artifact.size)}`);
    }
    if (typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
      fail(`artifacts[${ai}].sha256 must be 64 hex chars, got ${JSON.stringify(artifact.sha256)}`);
    }
  });
  // 跨轴校验（2026-10-10 对抗审查 A3 加）：SUCCEEDED 与「失败店清单/失败分类」互斥 ——
  // 顶层 execution 已成功却挂着失败店或 failureClass，是「回执自相矛盾」的形态，
  // 必须点名拒绝（写前校验 writeRunReceipt 会因此拒落盘）。
  if (receipt.execution === 'SUCCEEDED') {
    if (receipt.shops?.length) fail(`execution SUCCEEDED requires shops to be empty, got ${JSON.stringify(receipt.shops)}`);
    if (receipt.failureClass !== null) fail(`execution SUCCEEDED requires failureClass to be null, got ${JSON.stringify(receipt.failureClass)}`);
  }
  receipt.batches?.forEach?.((batch, bi) => {
    if (!batch || typeof batch !== 'object') {
      fail(`batches[${bi}] must be an object`);
      return;
    }
    if (!Number.isInteger(batch.index) || batch.index < 0) fail(`batches[${bi}].index must be a non-negative integer`);
    if (!Array.isArray(batch.shops) || batch.shops.some((s) => typeof s !== 'string')) fail(`batches[${bi}].shops must be string[]`);
    if (!EXECUTION_STATUSES.includes(batch.execution)) fail(`batches[${bi}].execution invalid: ${JSON.stringify(batch.execution)}`);
    if (!Array.isArray(batch.steps)) fail(`batches[${bi}].steps must be an array`);
    if (batch.release !== undefined && batch.release !== null) {
      if (typeof batch.release !== 'object' || Array.isArray(batch.release) || typeof batch.release.requested !== 'boolean' || typeof batch.release.observed !== 'boolean') {
        fail(`batches[${bi}].release must be { requested, observed, status }`);
      } else if (!RELEASE_STATUSES.includes(batch.release.status)) {
        fail(`batches[${bi}].release.status must be one of ${RELEASE_STATUSES.join('/')}, got ${JSON.stringify(batch.release.status)}`);
      }
    }
    batch.steps?.forEach?.((step, si) => {
      const at = `batches[${bi}].steps[${si}]`;
      if (!step || typeof step !== 'object') {
        fail(`${at} must be an object`);
        return;
      }
      if (typeof step.name !== 'string' || !step.name) fail(`${at}.name must be a non-empty string`);
      if (!EXECUTION_STATUSES.includes(step.execution)) fail(`${at}.execution invalid: ${JSON.stringify(step.execution)}`);
      if (step.evidence !== undefined && (!Array.isArray(step.evidence) || step.evidence.some((e) => typeof e !== 'string'))) {
        fail(`${at}.evidence must be string[]`);
      }
      const publication = step.publication ?? 'NOT_REQUESTED';
      if (!PUBLICATION_STATUSES.includes(publication)) fail(`${at}.publication invalid: ${JSON.stringify(step.publication)}`);
    });
  });
  return errors;
}

/**
 * 写前先 validate，非法直接抛错、绝不落盘。
 *
 * 纪律（spec §11 回滚）：统一回执生成失败时不得把旧收据标成成功——
 * 本函数抛错后调用方必须让整轮以失败收尾或中止，不得回退旧格式并记为成功。
 */
export function writeRunReceipt(file, receipt) {
  const errors = validateRunReceipt(receipt);
  if (errors.length > 0) throw new Error(`refusing to write invalid run receipt:\n- ${errors.join('\n- ')}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return file;
}
