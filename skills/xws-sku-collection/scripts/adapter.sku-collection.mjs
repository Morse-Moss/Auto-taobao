// xws.sku.collection 的运行时实现入口（实施计划「迁移顺序第 3 项：XWS SKU」）。
//
// 为什么需要这个文件：SKU 入库原本是「一条人工值守的 CLI 链」——
//   xws-sku-auth-preflight -> capture-xws-sku-payload -> collect-live-xws-sku-topology
//   -> run-xws-sku-dry-run -> apply-xws-sku-manifest
// 每一步都是独立进程，唯一的「状态」是 operator 脑子里的批次进度和 batch-index.json。
// 这条链最大的风险不是采集失败，而是**写入重复**：apply 是一次 batch_create，进程在
// 「飞书已创建、本地还没记下」的窗口里崩溃，重跑就会再写一遍。
//
// 本文件把这条链的**后半段**（复验 + 写入 + 回读）放进确定性运行时的两段式模型：
//   COLLECT（无外部写入）：读本地证据 + 已审批的 dry-run 计划 → 独立复验 → 产出可自证工件
//   PUBLISH（外部写入）  ：工件字节 → 按唯一键对账式 batch_create → 外部回读 → 发布期验证器
// 采集段（浏览器点击与剪贴板）仍由 Skill 的既有 CLI 完成，本文件不发起任何浏览器动作。
//
// 关键设计取舍（与「迁移 3 FAQ」的取舍同源，但结论不同，记录在此以便审查）：
//  1. **不复跑解析**。FAQ 适配器因为解析很简单（CSV）而在 skill 内复刻一份并做交叉验证；
//     SKU 的解析链要跨 `competitor-v2-core` 的尺寸/空间判定（约 100 行），复刻它等于制造第二份
//     真相。这里改为：把 `manifest.parser.sha256` 当作**解析器版本的绑定哈希**，并要求调用方
//     用 `parserFile` 显式证明「计划是用这个 parser 字节产出的」。任何解析逻辑变化都会让哈希
//     不一致，从而在一个可审计的点上失败，而不是悄悄换一套语义。
//  2. **写入必须自身幂等**。handler 不是无条件 batch_create：它先按 `SKU唯一键` 回读目标表，
//     只创建缺失的行。这样即使进程在崩溃后重跑（新 runId → 新 commitKey），也不会产生重复行。
//  3. **目标不硬编码**。appToken / skuTableId 由**已审批工件**携带，并要求调用方显式请求同一
//     目标；两者不一致直接拒绝。这样「换一个 base 写」在结构上需要一次新的审批，而不是改一个常量。
//
// 边界：本文件不 import runtime/ 下任何模块（实施计划风险表：「Skill 导入 runtime 新模块」= 反向依赖扩大）。
// 跨 Skill 的相对导入只允许「已登记能力」的实现：Feishu 客户端来自已登记的 `adapter.feishu`
// （skills/xws-to-feishu-base/scripts/feishu-client.mjs），并且走可注入的懒加载，
// 由测试替换（与同仓库 adapter.feishu-weekly 的做法一致）。
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const capabilityId = 'xws.sku.collection';
export const manifestVersion = '1.0.0';
export const EVIDENCE_SCHEMA_VERSION = 'xws-sku-collection-evidence-v1';

// 工件表面必须存在的键（collectContract().requiredFields 引用同一份清单，避免两处漂移）。
export const ARTIFACT_SURFACE_FIELDS = Object.freeze([
  'schemaVersion',
  'productId',
  'mainRecordId',
  'skuRowCount',
  'planToCreate',
  'payloadSha256',
  'topologySha256',
  'parserSha256',
  'manifestSha256',
  'uniqueKeyDigest',
]);

// 允许写入的「适用空间」值。与飞书字段选项一致；`大户型` 永远不允许（SKILL.md 的固定契约）。
export const APPROVED_SPACES = Object.freeze(['小户型', '常规卫生间']);

// 确定性拒绝码 -> 失败分类。默认的 failureClassOf 只按英文关键词猜，
// 中文原因（如「证据不完整」）会被猜成 BUG，因此这里逐条显式映射。
export const FAILURE_CLASS_BY_CODE = Object.freeze({
  EVIDENCE_MISSING: 'EVIDENCE_INVALID',
  EVIDENCE_INCOMPLETE: 'EVIDENCE_INVALID',
  RECEIPT_HASH_MISMATCH: 'EVIDENCE_INVALID',
  RECEIPT_IDENTITY_MISMATCH: 'EVIDENCE_INVALID',
  SOURCE_NOT_ELIGIBLE: 'EVIDENCE_INVALID',
  PLAN_NOT_WRITE_READY: 'EVIDENCE_INVALID',
  PLAN_MISMATCH: 'EVIDENCE_INVALID',
  ITEM_INVALID: 'EVIDENCE_INVALID',
  TARGET_MISMATCH: 'POLICY_DENIED',
  TARGET_REQUIRED: 'POLICY_DENIED',
  CREDENTIALS_UNAVAILABLE: 'HUMAN_REQUIRED',
  FEISHU_WRITE_REJECTED: 'POLICY_DENIED',
});

export class SkuEvidenceError extends Error {
  constructor(message, code, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'SkuEvidenceError';
    this.code = code;
    this.failureClass = FAILURE_CLASS_BY_CODE[code] ?? 'EVIDENCE_INVALID';
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

const asText = (value) => (value === undefined || value === null ? '' : String(value).trim());

// 飞书字段值可能是纯文本、富文本数组或对象；回读比较必须先归一化成文本。
export function plainText(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(plainText).join('').trim();
  if (typeof value === 'object') return asText(value.text ?? value.value ?? value.name);
  return asText(value);
}

// 双向关联字段回读时可能是 record_id 字符串数组、{ record_ids: [...] } 或富文本对象。
export function relationRecordIds(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return [...new Set(value.flatMap(relationRecordIds))];
  if (typeof value === 'object') {
    if (Array.isArray(value.record_ids)) return [...new Set(value.record_ids.flatMap(relationRecordIds))];
    const direct = asText(value.record_id ?? value.id);
    return direct ? [direct] : [];
  }
  return asText(value) ? [asText(value)] : [];
}

// ── 证据读取与独立复验 ──────────────────────────────────────────────────────
// 六份输入全部显式给出（不做目录猜测）：证据集合是否完整这件事本身必须是可审计的事实，
// 而不是「按前缀找到了几个文件」的运气。
export const REQUIRED_EVIDENCE_KEYS = Object.freeze([
  'payloadFile', 'captureReceipt', 'topologyFile', 'topologyReceipt', 'manifestFile', 'parserFile',
]);

function requirePath(input, key) {
  const value = asText(input?.[key]);
  if (!value) throw new SkuEvidenceError(`${key} is required`, 'EVIDENCE_MISSING', { key });
  const absolute = resolve(value);
  if (!existsSync(absolute)) {
    throw new SkuEvidenceError(`${key} is unavailable: ${absolute}`, 'EVIDENCE_MISSING', { key, path: absolute });
  }
  return absolute;
}

async function readJson(path, name) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new SkuEvidenceError(`${name} is not valid JSON: ${path}`, 'EVIDENCE_INCOMPLETE', {
      name, path, cause: String(error?.message ?? error),
    });
  }
}

function requirePlanItem(item) {
  const uniqueKey = asText(item?.uniqueKey);
  const action = asText(item?.action);
  if (!uniqueKey) throw new SkuEvidenceError('plan item has no unique key', 'ITEM_INVALID', { item });
  if (action !== 'toCreate' && action !== 'alreadyPresent') {
    throw new SkuEvidenceError(`plan item is not writable: ${action || '<empty>'}`, 'PLAN_NOT_WRITE_READY', { uniqueKey, action });
  }
  const skuId = asText(item?.skuId);
  if (!skuId) throw new SkuEvidenceError('plan item has no SKU ID', 'ITEM_INVALID', { uniqueKey });
  const fields = action === 'toCreate' ? item?.writeFields : null;
  if (action === 'toCreate' && (!fields || typeof fields !== 'object')) {
    throw new SkuEvidenceError('toCreate plan item has no write fields', 'ITEM_INVALID', { uniqueKey });
  }
  const recordId = action === 'alreadyPresent' ? asText(item?.recordId) : '';
  if (action === 'alreadyPresent' && !recordId) {
    throw new SkuEvidenceError('already present plan item has no record ID', 'ITEM_INVALID', { uniqueKey });
  }
  return { uniqueKey, skuId, action, fields, recordId };
}

// 读一个批次的证据并把已审批计划复验成工件数据。
// 任何一条不满足都抛出带确定性 code 的 SkuEvidenceError——这些 code 就是
// 「这批 SKU 为什么没通过」的可审计结论，而不是一句泛化失败。
export async function readSkuBatch(input = {}) {
  for (const key of REQUIRED_EVIDENCE_KEYS) requirePath(input, key);
  const paths = Object.fromEntries(REQUIRED_EVIDENCE_KEYS.map((key) => [key, requirePath(input, key)]));

  const [payloadText, parserText, topologyText, captureReceipt, topologyReceipt, manifestText] = await Promise.all([
    readFile(paths.payloadFile, 'utf8'),
    readFile(paths.parserFile, 'utf8'),
    readFile(paths.topologyFile, 'utf8'),
    readJson(paths.captureReceipt, 'capture receipt'),
    readJson(paths.topologyReceipt, 'topology receipt'),
    readFile(paths.manifestFile, 'utf8'),
  ]);
  const topology = (() => {
    try {
      return JSON.parse(topologyText);
    } catch (error) {
      throw new SkuEvidenceError('topology is not valid JSON', 'EVIDENCE_INCOMPLETE', { cause: String(error?.message ?? error) });
    }
  })();
  const manifest = (() => {
    try {
      return JSON.parse(manifestText);
    } catch (error) {
      throw new SkuEvidenceError('manifest is not valid JSON', 'EVIDENCE_INCOMPLETE', { cause: String(error?.message ?? error) });
    }
  })();

  const payloadSha256 = sha256Hex(Buffer.from(payloadText, 'utf8'));
  // 拓扑与 parser 的摘要是对**文件原始字节**的哈希——与 runtime 侧 buildSkuEvidence /
  // run-xws-sku-dry-run 的算法同源（不重序列化对象，否则摘要会随格式化方式漂移）。
  const topologySha256 = sha256Hex(Buffer.from(topologyText, 'utf8'));
  const parserSha256 = sha256Hex(Buffer.from(parserText, 'utf8'));
  const manifestSha256 = sha256Hex(Buffer.from(manifestText, 'utf8'));

  // 1) payload 哈希必须在采集收据、拓扑、拓扑收据三侧同时对得上。
  if (payloadSha256 !== asText(captureReceipt?.payloadSha256)) {
    throw new SkuEvidenceError('captured payload hash does not match the payload file', 'RECEIPT_HASH_MISMATCH', {
      side: 'capture', expected: asText(captureReceipt?.payloadSha256), actual: payloadSha256,
    });
  }
  if (payloadSha256 !== asText(topology?.payloadSha256) || payloadSha256 !== asText(topologyReceipt?.payloadSha256)) {
    throw new SkuEvidenceError('topology does not bind to the captured payload hash', 'RECEIPT_HASH_MISMATCH', {
      side: 'topology', actual: payloadSha256,
      topology: asText(topology?.payloadSha256), topologyReceipt: asText(topologyReceipt?.payloadSha256),
    });
  }
  // 2) 拓扑哈希必须与拓扑收据一致，并且与计划内嵌 evidence 块一致。
  if (topologySha256 !== asText(topologyReceipt?.topologySha256)) {
    throw new SkuEvidenceError('topology receipt hash does not match the topology file', 'RECEIPT_HASH_MISMATCH', {
      side: 'topology-receipt', expected: asText(topologyReceipt?.topologySha256), actual: topologySha256,
    });
  }
  if (payloadSha256 !== asText(manifest?.evidence?.payloadSha256) || topologySha256 !== asText(manifest?.evidence?.topologySha256)) {
    throw new SkuEvidenceError('approved plan does not bind to the supplied payload and topology files', 'RECEIPT_HASH_MISMATCH', {
      side: 'manifest-evidence', payload: asText(manifest?.evidence?.payloadSha256), topology: asText(manifest?.evidence?.topologySha256),
    });
  }

  // 3) 来源身份必须在采集收据、拓扑收据、计划三处一致。
  const metadata = captureReceipt?.metadata ?? {};
  const productId = asText(metadata.productId);
  const mainRecordId = asText(metadata.recordId);
  if (!productId || !mainRecordId) {
    throw new SkuEvidenceError('capture receipt does not identify the product and main record', 'EVIDENCE_INCOMPLETE', {
      productId, mainRecordId,
    });
  }
  if (productId !== asText(topologyReceipt?.productId)) {
    throw new SkuEvidenceError('topology receipt product identity differs from the capture', 'RECEIPT_IDENTITY_MISMATCH', {
      capture: productId, topology: asText(topologyReceipt?.productId),
    });
  }
  if (productId !== asText(manifest?.source?.productId) || mainRecordId !== asText(manifest?.source?.mainRecordId)) {
    throw new SkuEvidenceError('approved plan belongs to another product or main record', 'RECEIPT_IDENTITY_MISMATCH', {
      productId, mainRecordId, manifestProductId: asText(manifest?.source?.productId), manifestMainRecordId: asText(manifest?.source?.mainRecordId),
    });
  }

  // 4) 来源资格：只有「是否有效竞品=是」且分类为 A/B 的商品才允许写 SKU。
  if (asText(metadata.validity) !== '是') {
    throw new SkuEvidenceError('captured product was not a valid competitor', 'SOURCE_NOT_ELIGIBLE', { validity: asText(metadata.validity) });
  }
  if (!/^(?:A-|B-)/u.test(asText(metadata.classification))) {
    throw new SkuEvidenceError('captured product was not an A or B competitor', 'SOURCE_NOT_ELIGIBLE', {
      classification: asText(metadata.classification),
    });
  }

  // 5) 解析器绑定：计划声明的 parser 摘要必须等于调用方给出的 parser 字节。
  const declaredParser = asText(manifest?.parser?.sha256);
  if (!declaredParser || declaredParser !== parserSha256) {
    throw new SkuEvidenceError('plan was not produced by the supplied parser build', 'RECEIPT_HASH_MISMATCH', {
      side: 'parser', declared: declaredParser, actual: parserSha256,
    });
  }

  // 6) 计划内部一致性 + 逐行契约。
  if (asText(manifest?.version) !== 'xws-sku-dry-run-manifest-v1' || asText(manifest?.mode) !== 'DRY_RUN') {
    throw new SkuEvidenceError('unsupported SKU dry-run manifest', 'EVIDENCE_INCOMPLETE', {
      version: asText(manifest?.version), mode: asText(manifest?.mode),
    });
  }
  const plan = manifest?.plan;
  const summary = plan?.summary ?? {};
  if (!Array.isArray(plan?.items) || plan.items.length === 0) {
    throw new SkuEvidenceError('approved plan has no items', 'EVIDENCE_INCOMPLETE', {});
  }
  if (summary.writeReady !== true
    || Number(summary.conflict) !== 0
    || Number(summary.duplicateExistingKeys) !== 0) {
    throw new SkuEvidenceError('approved plan is not write-ready', 'PLAN_NOT_WRITE_READY', {
      writeReady: summary.writeReady ?? null,
      conflict: summary.conflict ?? null,
      duplicateExistingKeys: summary.duplicateExistingKeys ?? null,
    });
  }
  const items = plan.items.map(requirePlanItem);
  if (Number(summary.parsedRows) !== items.length) {
    throw new SkuEvidenceError('plan summary does not match its own items', 'PLAN_MISMATCH', {
      parsedRows: summary.parsedRows ?? null, items: items.length,
    });
  }
  if (Number(summary.toCreate) + Number(summary.alreadyPresent) !== items.length) {
    throw new SkuEvidenceError('plan action counts do not add up to the parsed rows', 'PLAN_MISMATCH', {
      toCreate: summary.toCreate ?? null, alreadyPresent: summary.alreadyPresent ?? null, items: items.length,
    });
  }
  // 拓扑侧的组合数必须与计划行数一致：它证明「页面实际可售组合」与「要写的行」是同一集合。
  if (!Array.isArray(topology?.validCombinations) || topology.validCombinations.length !== items.length) {
    throw new SkuEvidenceError('page topology combination count differs from the approved plan', 'PLAN_MISMATCH', {
      topology: Array.isArray(topology?.validCombinations) ? topology.validCombinations.length : null, items: items.length,
    });
  }
  // 拓扑收据必须为拓扑文件的两个计数背书（属性数与可售组合数）。
  if (Number(topology?.properties?.length) !== Number(topologyReceipt?.propertyCount)
    || topology.validCombinations.length !== Number(topologyReceipt?.validCombinationCount)) {
    throw new SkuEvidenceError('topology receipt counts do not match the topology file', 'RECEIPT_HASH_MISMATCH', {
      side: 'topology-receipt-counts',
      properties: topology?.properties?.length ?? null, receiptProperties: topologyReceipt?.propertyCount ?? null,
      combinations: topology.validCombinations.length, receiptCombinations: topologyReceipt?.validCombinationCount ?? null,
    });
  }

  const uniqueKeys = new Set();
  const rows = items.map((item) => {
    if (uniqueKeys.has(item.uniqueKey)) {
      throw new SkuEvidenceError(`duplicate SKU unique key in the approved plan: ${item.uniqueKey}`, 'ITEM_INVALID', { uniqueKey: item.uniqueKey });
    }
    uniqueKeys.add(item.uniqueKey);
    if (item.uniqueKey !== `${productId}|${item.skuId}`) {
      throw new SkuEvidenceError('SKU unique key does not match its product and SKU ID', 'ITEM_INVALID', {
        uniqueKey: item.uniqueKey, productId, skuId: item.skuId,
      });
    }
    if (item.action === 'alreadyPresent') {
      return { uniqueKey: item.uniqueKey, skuId: item.skuId, action: item.action, space: null, fields: null, recordId: item.recordId };
    }
    const fields = item.fields;
    if (asText(fields.商品ID) !== productId) {
      throw new SkuEvidenceError('plan item product ID differs from the captured product', 'ITEM_INVALID', {
        uniqueKey: item.uniqueKey, productId: asText(fields.商品ID),
      });
    }
    if (asText(fields.SKU唯一键) !== item.uniqueKey) {
      throw new SkuEvidenceError('plan item write fields carry another unique key', 'ITEM_INVALID', {
        uniqueKey: item.uniqueKey, writeKey: asText(fields.SKU唯一键),
      });
    }
    const relation = relationRecordIds(fields.所属竞品);
    if (relation.length !== 1 || relation[0] !== mainRecordId) {
      throw new SkuEvidenceError('plan item is not linked to the selected main record', 'ITEM_INVALID', {
        uniqueKey: item.uniqueKey, relation,
      });
    }
    const space = asText(fields.适用空间);
    if (space && !APPROVED_SPACES.includes(space)) {
      throw new SkuEvidenceError(`SKU 适用空间 is outside the approved values: ${space}`, 'ITEM_INVALID', {
        uniqueKey: item.uniqueKey, space,
      });
    }
    return { uniqueKey: item.uniqueKey, skuId: item.skuId, action: item.action, space: space || null, fields };
  }).sort((left, right) => left.uniqueKey.localeCompare(right.uniqueKey));

  const target = { appToken: asText(manifest?.target?.appToken), skuTableId: asText(manifest?.target?.skuTableId) };
  if (!target.appToken || !target.skuTableId) {
    throw new SkuEvidenceError('approved plan does not name the authorized target', 'EVIDENCE_INCOMPLETE', { target });
  }

  return {
    paths,
    productId,
    mainRecordId,
    captureId: asText(captureReceipt?.captureId),
    payloadSha256,
    topologySha256,
    parserSha256,
    manifestSha256,
    target,
    rows,
    toCreate: rows.filter((row) => row.action === 'toCreate').length,
    alreadyPresent: rows.filter((row) => row.action === 'alreadyPresent').length,
  };
}

// 每个批次一份状态。两段式里 COLLECT 与 PUBLISH 之间只通过工件字节传递数据，
// 这里存的是「同一次 COLLECT 内各方法要复用的解析结果」。
const stateByBatch = new Map();

export function resetStateForTest() {
  stateByBatch.clear();
  resetDependenciesForTest();
}

function batchKeyOf(input, context, started, observation) {
  return asText(input?.manifestFile)
    || asText(started?.batchKey)
    || asText(observation?.batchKey)
    || asText(context?.scope);
}

// ── 采集期合同 ──────────────────────────────────────────────────────────────
export function collectContract() {
  return {
    capabilityId,
    capabilityVersion: manifestVersion,
    evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION,
    // 只用 surface 字段，不用字节内部字段（与 sycm.feishu.weekly 的 D11 教训一致）。
    requiredFields: [...ARTIFACT_SURFACE_FIELDS],
    // 刻意**不**声明 digest / artifact_integrity：
    //  - digest 比较的是 evidenceStore 自己写出的摘要，恒等，属于空转；
    //  - artifact_integrity 的 rowCount>0 判定与 row_count 语义重叠，
    //    这里已经有更强的「逐行唯一键 + 拓扑组合数」自检。
    omittedValidators: {
      digest: 'compares the artifact against the manifest the store just derived from it; always equal',
      artifact_integrity: 'row_count already asserts the row count, and the capability re-derives every row identity',
    },
  };
}

export const adapter = {
  async checkSession() {
    // 读本地证据与飞书回读都不依赖浏览器会话；浏览器采集由 Skill 的既有 CLI 承担。
    return { ok: true };
  },

  async prepare(input = {}) {
    // prepare 只做「六份证据与输出目录是否齐备」的快速失败，不读内容：
    // 内容级判定统一放在 start，避免同一件事有两处结论。
    for (const key of REQUIRED_EVIDENCE_KEYS) requirePath(input, key);
  },

  async start(input = {}, context = {}) {
    const batch = await readSkuBatch(input);
    const key = batchKeyOf(input, context, null, null);
    stateByBatch.set(key, { batch, key, identity: context.identity ?? null });
    return {
      batchKey: key,
      productId: batch.productId,
      mainRecordId: batch.mainRecordId,
      skuRowCount: batch.rows.length,
      rowsToCreate: batch.toCreate,
    };
  },

  async observe({ context, started } = {}) {
    const key = batchKeyOf(null, context, started, null);
    const entry = stateByBatch.get(key);
    if (!entry) throw new SkuEvidenceError('no SKU batch evidence; start() must run first', 'EVIDENCE_MISSING', { batchKey: key });
    return {
      identity: context?.identity ?? entry.identity ?? null,
      batchKey: entry.key,
      productId: entry.batch.productId,
      mainRecordId: entry.batch.mainRecordId,
      skuRowCount: entry.batch.rows.length,
      rowsToCreate: entry.batch.toCreate,
    };
  },

  async collectArtifact({ context, observation } = {}) {
    const key = batchKeyOf(null, context, null, observation);
    const entry = stateByBatch.get(key);
    if (!entry) throw new SkuEvidenceError('no SKU batch evidence; start() must run first', 'EVIDENCE_MISSING', { batchKey: key });
    const { batch } = entry;
    const uniqueKeyDigest = sha256Hex(Buffer.from(stableJson(batch.rows.map((row) => row.uniqueKey)), 'utf8'));
    const payload = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      productId: batch.productId,
      mainRecordId: batch.mainRecordId,
      captureId: batch.captureId,
      skuRowCount: batch.rows.length,
      planToCreate: batch.toCreate,
      planAlreadyPresent: batch.alreadyPresent,
      payloadSha256: batch.payloadSha256,
      topologySha256: batch.topologySha256,
      parserSha256: batch.parserSha256,
      manifestSha256: batch.manifestSha256,
      uniqueKeyDigest,
      target: batch.target,
      // 工件自带写入所需的完整字段：发布段只读工件字节，不读进程内状态（跨进程恢复的前提）。
      rows: batch.rows.map((row) => ({
        uniqueKey: row.uniqueKey,
        skuId: row.skuId,
        action: row.action,
        space: row.space,
        recordId: row.recordId ?? null,
        writeFields: row.action === 'toCreate' ? row.fields : null,
      })),
      files: {
        payload: batch.paths.payloadFile,
        captureReceipt: batch.paths.captureReceipt,
        topology: batch.paths.topologyFile,
        topologyReceipt: batch.paths.topologyReceipt,
        manifest: batch.paths.manifestFile,
        parser: batch.paths.parserFile,
      },
    };
    const bytes = Buffer.from(stableJson(payload), 'utf8');
    return {
      ...payload,
      artifactId: `xws-sku-${batch.productId}`,
      artifactKind: 'json',
      bytes,
      sha256: sha256Hex(bytes),
      rowCount: batch.rows.length,
      range: { start: 1, end: batch.rows.length },
    };
  },

  // 能力自检。走到这里说明 readSkuBatch 已经通过，因此这里只兜两道：
  // 工件必须能被独立复验（摘要 + 字节），且表面字段必须与字节内容一致。
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
    const mismatched = ARTIFACT_SURFACE_FIELDS
      .filter((key) => String(parsed?.[key] ?? '') !== String(artifact?.[key] ?? ''));
    if (mismatched.length) {
      return { ok: false, code: 'STRUCTURE_INVALID', details: { reason: 'artifact surface disagrees with its own bytes', mismatched } };
    }
    const rows = parsed?.rows;
    if (!Array.isArray(rows) || rows.length !== Number(parsed?.skuRowCount)) {
      return { ok: false, code: 'STRUCTURE_INVALID', details: { reason: 'artifact rows disagree with its own declared row count' } };
    }
    // rowCount 是框架侧派生的表面字段（字节里只有 skuRowCount）：只在调用方给出时才校验，
    // 这样用字节单独重建的工件也能自检通过。
    if (artifact?.rowCount !== undefined && artifact?.rowCount !== null && rows.length !== Number(artifact.rowCount)) {
      return { ok: false, code: 'STRUCTURE_INVALID', details: { reason: 'artifact rows disagree with the declared rowCount', rows: rows.length, rowCount: artifact.rowCount } };
    }
    return { ok: true };
  },

  async release() {},
};

// ── 发布段 ──────────────────────────────────────────────────────────────────
// 依赖注入（与同仓库 adapter.feishu-weekly 一致）：默认实现懒加载已登记的 adapter.feishu，
// 测试用 setDependenciesForTest 替换，不需要网络或凭据。
let deps = {
  createClient: null,   // 默认实现懒加载 adapter.feishu 的 FeishuClient
  readEnvFile: null,    // 默认实现读 env 文件并抽取 FEISHU_APP_ID / FEISHU_APP_SECRET
};

export function setDependenciesForTest(overrides = {}) {
  deps = { ...deps, ...overrides };
}

export function resetDependenciesForTest() {
  deps = { createClient: null, readEnvFile: null };
}

async function defaultCreateClient({ appId, appSecret, appToken, tableId }) {
  // adapter.feishu 是已登记的能力（skills/xws-to-feishu-base/scripts/feishu-client.mjs）。
  // 懒加载 + 同一个目标基座，避免 Skill 之间在模块初始化期就互相绑定。
  const module = await import('../../xws-to-feishu-base/scripts/feishu-client.mjs');
  return new module.FeishuClient({ appId, appSecret, appToken, tableId });
}

function parseEnvText(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

// credentials 只从显式给出的 env 文件读取，绝不落进工件：
// 图件里只有「读到过凭据」这个事实（credentialSource），没有凭据值本身。
function readCredentials(envFile) {
  const absolute = resolve(envFile);
  if (!existsSync(absolute)) {
    throw new SkuEvidenceError('Feishu environment file is unavailable', 'CREDENTIALS_UNAVAILABLE', { envFile: absolute });
  }
  return readFile(absolute, 'utf8').then((text) => {
    const env = parseEnvText(text);
    if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
      throw new SkuEvidenceError('Feishu app credentials are unavailable', 'CREDENTIALS_UNAVAILABLE', { envFile: absolute });
    }
    return { appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET };
  });
}

function requestTarget(publishInput = {}, target = null) {
  const raw = publishInput.target ?? target ?? null;
  const appToken = asText(raw?.appToken);
  const skuTableId = asText(raw?.skuTableId);
  if (!appToken || !skuTableId) {
    throw new SkuEvidenceError('publish target must name appToken and skuTableId', 'TARGET_REQUIRED', { target: raw });
  }
  return { appToken, skuTableId };
}

// 写入是否「结果未知」：只有可能已经落库的失败才允许进 UNKNOWN。
// 4xx（参数/权限/字段错误）是确定性拒绝，不能靠重试蒙过去。
export function isUnknownWriteFailure(error) {
  const status = [error?.status, error?.statusCode, error?.response?.status]
    .map((value) => Number(value))
    .find((value) => Number.isInteger(value) && value >= 100 && value <= 599);
  if (status !== undefined) return status >= 500 || status === 408 || status === 429;
  const code = asText(error?.code).toUpperCase();
  if (['ECONNABORTED', 'ECONNRESET', 'EAI_AGAIN', 'ENETDOWN', 'ENETRESET', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return true;
  if (error?.name === 'AbortError') return true;
  return /\b(?:connection reset|fetch failed|network|socket hang up|timed?\s*out|timeout)\b/iu.test(String(error?.message ?? ''));
}

export function indexRecordsByUniqueKey(records = []) {
  const index = new Map();
  for (const record of records) {
    const key = plainText(record?.fields?.SKU唯一键);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(record);
  }
  return index;
}

export function verifyRowsAgainstRecords(rows = [], records = [], mainRecordId = '') {
  const index = indexRecordsByUniqueKey(records);
  const missing = [];
  const duplicated = [];
  const mismatched = [];
  const verified = [];
  for (const row of rows) {
    const matches = index.get(row.uniqueKey) ?? [];
    if (matches.length === 0) {
      missing.push(row.uniqueKey);
      continue;
    }
    if (matches.length > 1) {
      duplicated.push(row.uniqueKey);
      continue;
    }
    const record = matches[0];
    const problems = [];
    const relation = relationRecordIds(record?.fields?.所属竞品);
    if (mainRecordId && (relation.length !== 1 || relation[0] !== mainRecordId)) {
      problems.push(`relation=${relation.join(',') || '<empty>'}`);
    }
    if (row.space && plainText(record?.fields?.适用空间) !== row.space) {
      problems.push(`空间=${plainText(record?.fields?.适用空间) || '<empty>'}`);
    }
    if (problems.length) {
      mismatched.push({ uniqueKey: row.uniqueKey, problems });
      continue;
    }
    verified.push({ uniqueKey: row.uniqueKey, recordId: asText(record?.record_id) });
  }
  return { verified, missing, duplicated, mismatched };
}

function artifactRows(artifactBytes) {
  let parsed = null;
  try {
    parsed = JSON.parse(Buffer.from(artifactBytes).toString('utf8'));
  } catch (error) {
    throw new SkuEvidenceError('artifact bytes are not JSON', 'EVIDENCE_INCOMPLETE', { cause: String(error?.message ?? error) });
  }
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  if (rows.length === 0) throw new SkuEvidenceError('artifact carries no SKU rows', 'EVIDENCE_INCOMPLETE', {});
  return { artifact: parsed, rows };
}

// 发布钩子工厂。约定导出名由两段式运行器固定（PUBLISH_HOOK_FACTORY = 'createPublisher'）。
export function createPublisher({ artifactBytes, collectInput = {}, publishInput = {} } = {}) {
  if (!artifactBytes) throw new SkuEvidenceError('artifactBytes is required for the publish stage', 'EVIDENCE_MISSING', {});
  const { artifact, rows } = artifactRows(artifactBytes);
  // 「没有目标」是调用方缺陷：工厂期就拒绝，连凭据都不去读。
  const expectedTarget = requestTarget(publishInput, null);
  // 「目标与已审批工件不一致」是策略拒绝，不是调用方笔误：它必须留下可审计的 REJECTED 收据，
  // 而不是在最外层抛异常、把运行留在 RUNNING。因此这里只记录结论，在 handler 里抛出。
  const targetMismatch = asText(artifact?.target?.appToken) !== expectedTarget.appToken
    || asText(artifact?.target?.skuTableId) !== expectedTarget.skuTableId;
  const mainRecordId = asText(artifact?.mainRecordId);
  const envFile = asText(publishInput.envFile) || asText(collectInput.envFile);
  const batchSize = Number.isInteger(publishInput.batchSize) ? publishInput.batchSize : 500;

  async function client() {
    if (!envFile) throw new SkuEvidenceError('an env file is required to reach Feishu', 'CREDENTIALS_UNAVAILABLE', {});
    const credentials = deps.readEnvFile ? await deps.readEnvFile(envFile) : await readCredentials(envFile);
    const create = deps.createClient ?? defaultCreateClient;
    return create({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      appToken: expectedTarget.appToken,
      tableId: expectedTarget.skuTableId,
    });
  }

  return {
    expectedTarget,
    rows,

    // 幂等写入：先按唯一键回读目标表，只创建缺失的行。
    // 这样「进程在提交后崩溃 → 新 runId 重跑」不会产生重复行，而 UNKNOWN 对账也不需要盲重试。
    async handler() {
      if (targetMismatch) {
        throw new SkuEvidenceError('requested target differs from the approved artifact target', 'TARGET_MISMATCH', {
          approved: artifact?.target ?? null, requested: expectedTarget,
        });
      }
      const api = await client();
      const existing = indexRecordsByUniqueKey(await api.listRecords());
      const toCreate = rows.filter((row) => row.action === 'toCreate' && !existing.has(row.uniqueKey));
      for (let offset = 0; offset < toCreate.length; offset += batchSize) {
        const slice = toCreate.slice(offset, offset + batchSize);
        try {
          await api.batchCreateRecords(slice.map((row) => row.writeFields));
        } catch (error) {
          if (isUnknownWriteFailure(error)) {
            // 结果未知：不允许当成失败重试，交给 UNKNOWN 对账路径。
            throw Object.assign(new Error(`Feishu write outcome unknown: ${String(error?.message ?? error)}`), {
              unknown: true, failureClass: 'TRANSIENT_EXTERNAL',
            });
          }
          throw new SkuEvidenceError(`Feishu rejected the SKU batch write: ${String(error?.message ?? error)}`, 'FEISHU_WRITE_REJECTED', {
            createdBeforeFailure: offset,
          });
        }
      }
      return {
        createdUniqueKeys: toCreate.map((row) => row.uniqueKey),
        alreadyPresentUniqueKeys: rows.filter((row) => row.action === 'toCreate' && existing.has(row.uniqueKey)).map((row) => row.uniqueKey),
        skippedUniqueKeys: rows.filter((row) => row.action === 'alreadyPresent').map((row) => row.uniqueKey),
      };
    },

    // 回读验收：必须由飞书真实回读，不能凭本地 batch_create 返回推断。
    // 不抛异常而是返回收据：收据里带上缺失/重复/不一致的行，便于人工对账。
    async readBack() {
      const api = await client();
      const records = await api.listRecords();
      const verification = verifyRowsAgainstRecords(rows, records, mainRecordId);
      const digest = sha256Hex(Buffer.from(stableJson(verification.verified.map((row) => [row.uniqueKey, row.recordId])), 'utf8'));
      return {
        verifiedAt: new Date().toISOString(),
        rows: verification.verified.length,
        expectedRows: rows.length,
        digest,
        skuTableId: expectedTarget.skuTableId,
        mainRecordId,
        missing: verification.missing,
        duplicated: verification.duplicated,
        mismatched: verification.mismatched,
      };
    },
  };
}
