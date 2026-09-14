// xws.faq.product-collect 的运行时实现入口（实施计划「迁移顺序第 2 项：FAQ 商品级 fan-out」）。
//
// 为什么需要这个文件：FAQ 采集原本是「一个周期一条链路」——`run-faq-operator.mjs` 用
// `determineFaqOperatorState` 判一个整体状态，而 `inspectEvidence` 只保留**第一个**未解决告警作为
// blocker（`if (!productComplete && alert && !alertResolved && !blocker)`），
// 于是「5 个商品里 1 个采集失败」会阻塞整批。用户口径要的是**单商品失败隔离**，
// 这要求每个商品先成为一个可独立验证、可独立重试的执行单元。
//
// 本文件就是这个执行单元：把一个商品已经采集好的本地证据读成一份可独立复验的工件。
//   COLLECT（无外部写入）：读证据目录 → 校验收据契约 → 生成工件 → 交给 Worker + 采集期验证器
// 它不发起任何浏览器动作，也不写飞书——采集本身仍由 xws-faq-operator Skill 的浏览器流程完成。
//
// 边界：本文件不 import runtime/ 下任何模块（实施计划风险表：「Skill 导入 runtime 新模块」= 反向依赖扩大）。
// 代价是收据契约的判定逻辑在 runtime/run-question-library-collection.mjs 的 `readEvidence` 里有一份同义实现。
// 这是刻意的取舍，并且由 tests/adapter-faq-product.test.mjs 的**交叉验证**兜住漂移：
// 同一组夹具分别喂给两边，必须给出完全一致的接受/拒绝结论。
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const capabilityId = 'xws.faq.product-collect';
export const manifestVersion = '1.0.0';
export const EVIDENCE_SCHEMA_VERSION = 'faq-product-evidence-v1';

export const PRODUCT_EVIDENCE_REJECTION = Object.freeze([
  'EVIDENCE_MISSING',
  'RECEIPT_IDENTITY_MISMATCH',
  'SOURCE_FILE_MISMATCH',
  'RECEIPT_HASH_MISMATCH',
  'ARCHIVE_INVALID',
  'REVIEW_SCOPE_MISMATCH',
  'TRIAL_ANALYSIS_CALLED',
  'UNDECLARED_EMPTY_SOURCE',
  'PRODUCT_ID_REQUIRED',
]);

export class ProductEvidenceError extends Error {
  constructor(message, code, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'ProductEvidenceError';
    this.code = code;
    this.failureClass = 'EVIDENCE_INVALID';
    this.details = details;
  }
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// 稳定序列化：键排序，保证同一份证据每次得到同一摘要（否则 digest 校验会随机失败）。
export function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

const blank = (value) => (value === undefined || value === null ? '' : String(value).trim()) === '';

// 与 runtime/run-question-library-collection.mjs 的 parseCsv **同语义**（逐条对齐，不是"差不多"）：
//  - 引号只在单元格为空时开引（`cell === ''`），与 runtime 一致；
//  - `\r`、`\n`、`\r\n` 都算行结束；
//  - 整行全空的行被丢弃；
//  - 第一行是表头，返回的是**数据行**。
// 必须自己实现而不是 import：见文件头「边界」。对齐由 tests/adapter-faq-product.test.mjs 的交叉验证兜住。
export function parseCsv(input) {
  const source = String(input ?? '').replace(/^\uFEFF/u, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell === '') quoted = true;
    else if (character === ',') { row.push(cell); cell = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell);
      cell = '';
      if (row.some((value) => !blank(value))) rows.push(row);
      row = [];
    } else cell += character;
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => !blank(value))) rows.push(row);
  }
  if (rows.length < 1) return [];
  rows.shift(); // 表头
  return rows;
}

const asText = (value) => (value === undefined || value === null ? '' : String(value).trim());

function requireProductId(input = {}) {
  const productId = asText(input.productId);
  if (!productId) throw new ProductEvidenceError('productId is required', 'PRODUCT_ID_REQUIRED', { input });
  return productId;
}

function resolveDirectory(input = {}) {
  if (input.evidenceDir) return resolve(input.evidenceDir);
  if (input.evidenceRoot) return resolve(input.evidenceRoot, String(input.productId));
  throw new ProductEvidenceError('either evidenceDir or evidenceRoot is required', 'EVIDENCE_MISSING', { input });
}

async function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new ProductEvidenceError(`receipt is not valid JSON: ${path}`, 'EVIDENCE_MISSING', { path, cause: String(error?.message ?? error) });
  }
}

// 读一个商品的证据。任何一条不满足都抛出带确定性 code 的 ProductEvidenceError——
// 这些 code 就是「这个商品为什么没通过」的可审计结论，而不是一句泛化的失败。
export async function readProductEvidence({ evidenceDir, productId }) {
  const directory = resolve(evidenceDir);
  const qaPath = resolve(directory, 'qa.csv');
  const reviewsPath = resolve(directory, 'reviews.csv');
  const reviewsSourcePath = resolve(directory, 'reviews-source.zip');
  const alertPath = resolve(directory, 'alert.json');

  const missing = [qaPath, reviewsPath, resolve(directory, 'qa-receipt.json'), resolve(directory, 'reviews-receipt.json'), reviewsSourcePath]
    .filter((path) => !existsSync(path));
  if (missing.length) {
    throw new ProductEvidenceError(`missing evidence files for ${productId}`, 'EVIDENCE_MISSING', { productId, missing });
  }

  const [qaBytes, reviewsBytes, reviewsSourceBytes] = await Promise.all([
    readFile(qaPath), readFile(reviewsPath), readFile(reviewsSourcePath),
  ]);
  const [qaReceipt, reviewsReceipt, alert] = await Promise.all([
    readJsonIfPresent(resolve(directory, 'qa-receipt.json')),
    readJsonIfPresent(resolve(directory, 'reviews-receipt.json')),
    readJsonIfPresent(alertPath),
  ]);

  if (asText(qaReceipt?.productId) !== String(productId) || asText(reviewsReceipt?.productId) !== String(productId)) {
    throw new ProductEvidenceError(`receipt product identity mismatch: ${productId}`, 'RECEIPT_IDENTITY_MISMATCH', {
      productId, qa: asText(qaReceipt?.productId), reviews: asText(reviewsReceipt?.productId),
    });
  }
  if (asText(qaReceipt?.sourceFile) !== 'qa.csv'
    || asText(reviewsReceipt?.sourceFile) !== 'reviews-source.zip'
    || asText(reviewsReceipt?.normalizedFile) !== 'reviews.csv') {
    throw new ProductEvidenceError(`receipt source file mismatch: ${productId}`, 'SOURCE_FILE_MISMATCH', {
      productId, qa: asText(qaReceipt?.sourceFile), reviews: asText(reviewsReceipt?.sourceFile), normalized: asText(reviewsReceipt?.normalizedFile),
    });
  }
  // 试用态不允许调用评价分析：那会消耗额度，也会让「原文快照」不再可复现。
  if (reviewsReceipt?.trial?.analysisCalls && Number(reviewsReceipt.trial.analysisCalls) !== 0) {
    throw new ProductEvidenceError(`review analysis was called for ${productId}`, 'TRIAL_ANALYSIS_CALLED', {
      productId, analysisCalls: Number(reviewsReceipt.trial.analysisCalls),
    });
  }
  const scope = reviewsReceipt?.scope;
  if (scope && (scope.content !== '全部' || scope.date !== '全部' || scope.sku !== '未指定' || scope.impression !== '未筛选' || scope.analysis !== '未调用')) {
    throw new ProductEvidenceError(`review scope mismatch: ${productId}`, 'REVIEW_SCOPE_MISMATCH', { productId, scope });
  }

  const qaHash = sha256Hex(qaBytes);
  const reviewHash = sha256Hex(reviewsBytes);
  const reviewsSourceHash = sha256Hex(reviewsSourceBytes);
  if (asText(qaReceipt?.sha256) && asText(qaReceipt.sha256) !== qaHash) {
    throw new ProductEvidenceError(`QA receipt hash mismatch: ${productId}`, 'RECEIPT_HASH_MISMATCH', { productId, kind: 'qa', expected: asText(qaReceipt.sha256), actual: qaHash });
  }
  if (reviewsSourceBytes.length < 4 || reviewsSourceBytes.subarray(0, 2).toString('ascii') !== 'PK') {
    throw new ProductEvidenceError(`invalid review archive: ${reviewsSourcePath}`, 'ARCHIVE_INVALID', { productId, path: reviewsSourcePath });
  }
  if (asText(reviewsReceipt?.sha256) && asText(reviewsReceipt.sha256) !== reviewsSourceHash) {
    throw new ProductEvidenceError(`review archive receipt hash mismatch: ${productId}`, 'RECEIPT_HASH_MISMATCH', { productId, kind: 'reviews-source', expected: asText(reviewsReceipt.sha256), actual: reviewsSourceHash });
  }
  if (asText(reviewsReceipt?.normalizedSha256) && asText(reviewsReceipt.normalizedSha256) !== reviewHash) {
    throw new ProductEvidenceError(`review normalized hash mismatch: ${productId}`, 'RECEIPT_HASH_MISMATCH', { productId, kind: 'reviews-normalized', expected: asText(reviewsReceipt.normalizedSha256), actual: reviewHash });
  }

  const qaRows = parseCsv(qaBytes.toString('utf8'));
  const reviewRows = parseCsv(reviewsBytes.toString('utf8'));

  // 0 行是**合法**状态（下架/页面不可用商品），但必须显式声明来源为空并写明原因。
  // 这一条正是通用行数验证器做不到的判断：它无法区分「空且已声明」与「空且漏采」。
  if (qaRows.length === 0 && asText(qaReceipt?.status) !== 'EMPTY_SOURCE_ROWS') {
    throw new ProductEvidenceError(`empty QA source is not explicitly verified: ${productId}`, 'UNDECLARED_EMPTY_SOURCE', { productId, kind: 'qa', status: asText(qaReceipt?.status) });
  }
  if (reviewRows.length === 0) {
    if (asText(reviewsReceipt?.status) !== 'EMPTY_SOURCE_ROWS' || !asText(reviewsReceipt?.unavailableReason)) {
      throw new ProductEvidenceError(`review source is not complete: ${productId}`, 'UNDECLARED_EMPTY_SOURCE', {
        productId, kind: 'reviews', status: asText(reviewsReceipt?.status), unavailableReason: asText(reviewsReceipt?.unavailableReason),
      });
    }
  } else if (asText(reviewsReceipt?.status) !== 'COMPLETED') {
    throw new ProductEvidenceError(`review source is not complete: ${productId}`, 'UNDECLARED_EMPTY_SOURCE', { productId, kind: 'reviews', status: asText(reviewsReceipt?.status) });
  }

  return {
    productId: String(productId),
    directory,
    qa: { sourceFile: 'qa.csv', sourceHash: qaHash, rows: qaRows, receipt: qaReceipt },
    reviews: {
      sourceFile: 'reviews-source.zip',
      sourceHash: reviewsSourceHash,
      normalizedFile: 'reviews.csv',
      normalizedHash: reviewHash,
      rows: reviewRows,
      receipt: reviewsReceipt,
    },
    alert: alert ?? null,
  };
}

// 每个商品一份状态。fan-out 里子项是**顺序**执行的（lane=1），但用 Map 而不是单例，
// 是为了让「同一进程内交错执行两个商品」在结构上不可能串证据。
const stateByProduct = new Map();

export function resetStateForTest() {
  stateByProduct.clear();
}

// 采集期合同的显式声明。`requiredFields` 是**工件对象表面**必须存在的键——
// 这条清单与 validateStructure 直接对接；如果只把它们塞进工件字节内部，structure 验证器会静默空转。
export function collectContract() {
  return {
    capabilityId,
    capabilityVersion: manifestVersion,
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    // 只用 surface 字段，不用字节内部字段（与 sycm.feishu.weekly 的 D11 教训一致）。
    requiredFields: [
      'schemaVersion', 'productId', 'qaRows', 'reviewRows',
      'qaReceiptStatus', 'reviewsReceiptStatus', 'qaSourceHash', 'reviewsSourceHash',
    ],
    // 刻意**不**声明 completeness / row_count / artifact_integrity：
    // 三者都会把「合法的 0 行证据」（下架商品）判成不完整。
    // 0 行的合法性只能由能力自检按收据语义判定（见 readProductEvidence 的 UNDECLARED_EMPTY_SOURCE）。
    omittedValidators: {
      completeness: 'legitimate empty evidence (EMPTY_SOURCE_ROWS) would be misjudged as incomplete',
      row_count: 'a delisted product has no meaningful expected row count',
      artifact_integrity: 'it rejects rowCount <= 0, which is legitimate for EMPTY_SOURCE_ROWS',
    },
  };
}

export const adapter = {
  async checkSession() {
    // 读本地证据没有平台会话；网页采集的会话前置由 xws-faq-operator 的浏览器流程承担。
    return { ok: true };
  },

  async prepare(input = {}) {
    requireProductId(input);
    // prepare 只做「路径与文件存在性」的快速失败，不读内容：
    // 内容级判定统一放在 start/validate，避免同一件事有两处结论。
  },

  async start(input = {}, context = {}) {
    const productId = requireProductId(input);
    const evidenceDir = resolveDirectory(input);
    const evidence = await readProductEvidence({ evidenceDir, productId });
    stateByProduct.set(productId, { evidence, productId, identity: context.identity ?? null });
    return {
      productId,
      qaRows: evidence.qa.rows.length,
      reviewRows: evidence.reviews.rows.length,
      directory: evidence.directory,
    };
  },

  async observe({ context, started } = {}) {
    const productId = asText(started?.productId) || asText(context?.scope);
    const entry = stateByProduct.get(productId);
    if (!entry) throw new ProductEvidenceError('no product evidence; start() must run first', 'EVIDENCE_MISSING', { productId });
    return {
      identity: context?.identity ?? entry.identity ?? null,
      productId: entry.productId,
      qaRows: entry.evidence.qa.rows.length,
      reviewRows: entry.evidence.reviews.rows.length,
      qaReceiptStatus: asText(entry.evidence.qa.receipt?.status),
      reviewsReceiptStatus: asText(entry.evidence.reviews.receipt?.status),
    };
  },

  async collectArtifact({ context, observation } = {}) {
    const productId = asText(observation?.productId) || asText(context?.scope);
    const entry = stateByProduct.get(productId);
    if (!entry) throw new ProductEvidenceError('no product evidence; start() must run first', 'EVIDENCE_MISSING', { productId });

    const { evidence } = entry;
    const qaRows = evidence.qa.rows.length;
    const reviewRows = evidence.reviews.rows.length;
    // 工件对象表面必须带齐 collectContract().requiredFields 声明的键（structure 验证器直接看这一层）。
    const payload = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      productId: evidence.productId,
      qaRows,
      reviewRows,
      qaReceiptStatus: asText(evidence.qa.receipt?.status),
      reviewsReceiptStatus: asText(evidence.reviews.receipt?.status),
      qaSourceHash: evidence.qa.sourceHash,
      reviewsSourceHash: evidence.reviews.sourceHash,
      reviewsNormalizedHash: evidence.reviews.normalizedHash,
      productUrl: asText(entry.evidence.qa.receipt?.productUrl ?? entry.evidence.reviews.receipt?.productUrl),
      unavailableReason: asText(evidence.reviews.receipt?.unavailableReason),
      alert: evidence.alert ? { code: asText(evidence.alert.code ?? evidence.alert.status), resolved: Boolean(evidence.alert.resolvedAt || evidence.alert.resolution) } : null,
      files: {
        qa: { path: resolve(evidence.directory, 'qa.csv'), sha256: evidence.qa.sourceHash, rows: qaRows },
        reviews: { path: resolve(evidence.directory, 'reviews.csv'), sha256: evidence.reviews.normalizedHash, rows: reviewRows },
        reviewsSource: { path: resolve(evidence.directory, 'reviews-source.zip'), sha256: evidence.reviews.sourceHash },
      },
    };
    const bytes = Buffer.from(stableJson(payload), 'utf8');
    return {
      ...payload,
      artifactId: `faq-product-${evidence.productId}`,
      artifactKind: 'json',
      bytes,
      sha256: sha256Hex(bytes),
      rowCount: qaRows + reviewRows,
      range: { start: 1, end: qaRows + reviewRows },
    };
  },

  // 能力自检。走到这里说明 readProductEvidence 已经通过，因此这里只兜两道：
  // 工件必须能被独立复验（摘要 + 字节），且表面字段必须与字节内容一致（防止有人改了 surface 却没改内容）。
  async validate(artifact) {
    if (!artifact) return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'no artifact' } };
    if (!/^[0-9a-f]{64}$/.test(String(artifact.sha256 ?? ''))) {
      return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'missing sha256 digest' } };
    }
    if (!artifact.bytes) return { ok: false, code: 'ARTIFACT_INCOMPLETE', details: { reason: 'missing bytes' } };
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
    const mismatched = ['productId', 'qaRows', 'reviewRows', 'qaReceiptStatus', 'reviewsReceiptStatus', 'qaSourceHash', 'reviewsSourceHash']
      .filter((key) => String(parsed?.[key] ?? '') !== String(artifact?.[key] ?? ''));
    if (mismatched.length) {
      return { ok: false, code: 'STRUCTURE_INVALID', details: { reason: 'artifact surface disagrees with its own bytes', mismatched } };
    }
    return { ok: true };
  },

  async release() {},
};

export function productEvidenceOf(productId) {
  return stateByProduct.get(String(productId))?.evidence ?? null;
}
