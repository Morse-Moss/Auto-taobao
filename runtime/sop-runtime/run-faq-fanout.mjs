#!/usr/bin/env node
// FAQ 商品级 fan-out 驱动器（实施计划「迁移顺序第 2 项」+ 阶段 6「FAQ 商品级 fan-out 先做失败隔离」）。
//
// 为什么需要它：原 `run-faq-operator.mjs` 把整个周期当成一个执行单元，
// `inspectEvidence` 只保留**第一个**未解决的告警作为 blocker——
// 于是「5 个竞品里 1 个采集失败」会阻塞另外 4 个已完成的商品，整批停摆。
// 本驱动器把每个商品变成一条独立的 run，并保证：
//   - 失败隔离：一个商品失败只影响它自己，其余照常结算；
//   - 独立证据：每个商品自己的工件 + 自己的验证结论（不是「整批一个结论」）；
//   - 人工队列：失败/冲突/缺失的子项被显式列出，而不是被静默吞掉或糊成一个失败；
//   - 不重复消费：子项 businessKey 带父批次与能力，跨周重跑不会把上期当成已提交。
//
// **设计决定（重要）**：本驱动器只负责「准入 + 执行」，绝不再调 runTwoStage。
// 原因：runTwoStage 内部会自己 admitTask 一次，其 taskId 与 fan-out 的 taskId 不同，
// 因此 idempotencyKey 也不同——同一个商品会被准入两次，直接违反「重复消费无重复副作用」。
// 所以执行路径直接走 Worker（与 runTwoStage 的采集段是同一段代码路径：createCapabilityWorker + runOnce）。
//
// **不在本驱动器范围内**：周期级的飞书发布（问题主库/问题库替换）。那是一次外部写入，
// 属于 xws-faq-operator 的发布段，尚未迁移；本驱动器只产出「本批商品证据是否全部结算」的结论。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildRegistryFromDisk } from './build-skill-registry.mjs';
import { createLoader } from './skill-loader.mjs';
import { createMemoryStore } from './stores/memory-store.mjs';
import { createController } from './workflow-controller.mjs';
import { createEvidenceStore } from './evidence-store.mjs';
import { createCapabilityWorker } from './worker-adapter.mjs';
import { createTaskQueue } from './task-queue.mjs';
import { buildFanoutSpecs, dispatchFanout, collectFanout, assertNoDuplicateBusinessKeys } from './fanout.mjs';

export const FAQ_PRODUCT_CAPABILITY = 'xws.faq.product-collect';

export class FaqFanoutError extends Error {
  constructor(message, code, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'FaqFanoutError';
    this.code = code;
    this.details = details;
  }
}

// 子项为什么进了人工队列。每一项都必须能追到一个具体原因，不允许出现「未知原因」。
export const HUMAN_QUEUE_REASONS = Object.freeze([
  'DISPATCH_REJECTED',      // 准入被拒（背压/限流/熔断/重复）
  'EVIDENCE_INVALID',       // 证据不满足收据契约
  'COLLECT_FAILED',         // 采集段其他失败
  'UNSETTLED',              // 派发成功但没拿到结论（进程中断等）
  'CONFLICT',               // 同一商品两次给出不同证据
]);

// 读周期清单。清单里没有商品是**合法**状态（运营口径：高质量竞品不是每周都有），
// 但必须带 outcome 说明，否则视为清单未锁定——不锁定的清单不能拿来做 fan-out 的范围依据。
export async function readBatchManifest({ collectionDir, period }) {
  const path = resolve(collectionDir, 'top5-manifest.json');
  if (!existsSync(path)) {
    throw new FaqFanoutError(`batch manifest not found: ${path}`, 'MANIFEST_MISSING', { path });
  }
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new FaqFanoutError(`batch manifest is not valid JSON: ${path}`, 'MANIFEST_INVALID', { path, cause: String(error?.message ?? error) });
  }
  const products = Array.isArray(manifest?.products) ? manifest.products : [];
  const outcome = String(manifest?.outcome ?? '').trim();
  const locked = manifest?.period === period
    && products.length <= 5
    && products.every((product) => String(product?.productId ?? '').trim())
    && (products.length === 5 || outcome === 'NO_QUALIFIED_CANDIDATES' || outcome === 'PARTIAL_CANDIDATES');
  if (!locked) {
    throw new FaqFanoutError(
      `batch manifest is not locked for ${period}: count=${products.length} outcome=${outcome || '(none)'}`,
      'MANIFEST_NOT_LOCKED',
      { period, count: products.length, outcome },
    );
  }
  return { manifest, products, outcome };
}

export function batchParentId(period) {
  return `faq-fanout-${period}`;
}

// 批次执行的**顺序**刻意固定：先准入全部子项（拿到完整的「哪些进不来」），
// 再逐个执行。反过来（边准入边执行）在第一个子项卡住时就看不到后面的准入结论，
// 而「整批是否完整」正是父级要回答的唯一问题。
export async function runFaqFanout({
  runtimeRoot = 'runtime',
  periodStart,
  periodEnd,
  productIds = null,
  identity,
  registry,
  loader,
  store,
  controller,
  evidenceStore = null,
  queue = null,
  limits = {},
  laneLimits = null,
  nowIso = () => new Date().toISOString(),
} = {}) {
  if (!periodStart || !periodEnd) throw new FaqFanoutError('periodStart and periodEnd are required', 'PERIOD_REQUIRED');
  if (!identity) throw new FaqFanoutError('identity is required', 'IDENTITY_REQUIRED');
  if (!registry || !loader) throw new FaqFanoutError('registry and loader are required', 'REGISTRY_REQUIRED');
  if (!store || !controller) throw new FaqFanoutError('store and controller are required', 'STORE_REQUIRED');

  const period = `${periodStart}_${periodEnd}`;
  const collectionDir = resolve(runtimeRoot, 'question-library-collection', period);
  const { manifest, products, outcome } = await readBatchManifest({ collectionDir, period });

  // 指定子集时必须是清单里真实存在的商品：不允许凭空造子项（那等于伪造范围）。
  const selected = productIds === null || productIds === undefined
    ? products
    : products.filter((product) => productIds.map(String).includes(String(product.productId)));
  if (productIds && selected.length !== productIds.length) {
    const known = new Set(products.map((product) => String(product.productId)));
    const unknown = productIds.map(String).filter((id) => !known.has(id));
    throw new FaqFanoutError(`requested products are not in the locked batch manifest: ${unknown.join(', ')}`, 'PRODUCT_NOT_IN_BATCH', { unknown });
  }

  const parentId = batchParentId(period);
  const base = {
    parentId,
    period,
    capability: FAQ_PRODUCT_CAPABILITY,
    manifestOutcome: outcome || null,
    manifestLocked: true,
  };

  // 0 个商品：清单已锁定且运营口径允许。**不是**失败，但也不能被当成「已采集完成」，
  // 因此单独给出 empty 标记与原因，让调用方自己决定是否走周期级的空周期旁路。
  if (selected.length === 0) {
    return {
      ...base,
      empty: true,
      emptyReason: outcome || 'NO_QUALIFIED_CANDIDATES',
      total: 0,
      dispatched: 0,
      collected: 0,
      complete: false,
      requiresHuman: false,
      humanQueue: [],
      outcomes: [],
      note: '空批次不是失败，也不等于「已采集完成」；周期级完成判定由 xws-faq-operator 的空周期旁路负责。',
    };
  }

  const specs = buildFanoutSpecs({
    parent: { runId: parentId, taskId: `faq-batch-${period}`, workflow: FAQ_PRODUCT_CAPABILITY },
    items: selected,
    capability: FAQ_PRODUCT_CAPABILITY,
    identity,
    keyOf: (product) => product.productId,
    write: false,
    // targetEnd=0 ⇒ 不生成 verifiedCursor：单商品不是「范围」，没有游标语义。
    targetEnd: 0,
    sideEffects: [],
  });
  assertNoDuplicateBusinessKeys(specs);

  const activeQueue = queue ?? createTaskQueue({ store, controller, limits: { laneLimits, ...limits } });
  const dispatch = await dispatchFanout({ queue: activeQueue, specs, registeredCapabilities: registry.names() });

  // 采集段实现只装载一次：manifest 决定验证器集合，adapter 状态按商品分键，不随批次增长。
  const loaded = await loader.loadAdapter(FAQ_PRODUCT_CAPABILITY, { version: '*' });
  const declaredContract = typeof loaded.module?.collectContract === 'function'
    ? (loaded.module.collectContract({}) ?? {})
    : {};
  const capability = await createCapabilityWorker({
    registry, loader, controller, evidenceStore,
    capabilityId: FAQ_PRODUCT_CAPABILITY,
    contract: declaredContract,
  });

  const outcomes = [];
  for (const entry of dispatch.outcomes) {
    const spec = specs.find((candidate) => candidate.itemKey === entry.itemKey);
    if (!entry.dispatched) {
      outcomes.push({
        itemKey: entry.itemKey, businessKey: spec?.businessKey ?? null, runId: null,
        ok: false, value: null, error: entry.reason ?? 'dispatch rejected',
        reason: 'DISPATCH_REJECTED', failureClass: entry.failureClass ?? null, retryable: Boolean(entry.retryable),
      });
      continue;
    }
    const collect = await capability.worker.runOnce({
      runId: entry.runId,
      stage: 'COLLECT',
      input: { productId: entry.itemKey, evidenceRoot: collectionDir, evidenceDir: resolve(collectionDir, entry.itemKey), periodStart, periodEnd },
      manifestMeta: { parentId, period, itemKey: entry.itemKey },
    });
    if (!collect.ok) {
      outcomes.push({
        itemKey: entry.itemKey, businessKey: spec?.businessKey ?? null, runId: entry.runId,
        ok: false, value: null,
        error: collect.error ?? ((collect.validation?.codes ?? []).join(',') || 'collect failed'),
        reason: collect.failureClass === 'EVIDENCE_INVALID' ? 'EVIDENCE_INVALID' : 'COLLECT_FAILED',
        failureClass: collect.failureClass ?? null,
        validationCodes: collect.validation?.codes ?? [],
        retryable: false,
      });
      continue;
    }
    const validated = await controller.markEvidenceValidated(entry.runId);
    // **必须终结这条 run，否则整批会死锁**：
    // completeAttempt 只把 nextAction 置为 COMMIT，executionStatus 仍是 RUNNING；
    // 而 RUNNING 属于 LANE_EXECUTING_STATUSES，于是同一个 lane 的下一个子项在
    // beginAttempt 的 lane 闸门处被拒为 LANE_SATURATED——商品级 fan-out 直接卡死。
    // 本能力没有外部写、也没有范围游标（单商品不是一个"区间"），因此正确的终结是
    // Controller 既有的 succeed()（SUCCEEDED + TERMINAL + 释放 lease），
    // 而不是硬凑一个 advanceCursor（那会伪造出没有意义的游标）。
    const settled = await controller.succeed(entry.runId);
    outcomes.push({
      itemKey: entry.itemKey, businessKey: spec?.businessKey ?? null, runId: entry.runId,
      ok: true,
      // value 就是「这个商品的独立证据结论」——两个子项对同一商品给出不同 value 时会被判成冲突。
      value: {
        productId: entry.itemKey,
        sha256: collect.manifest?.sha256 ?? null,
        rowCount: collect.manifest?.rowCount ?? null,
        evidenceStatus: validated.evidenceStatus,
        executionStatus: settled.executionStatus,
      },
      error: null, reason: null, failureClass: null, retryable: false,
    });
  }

  const collected = collectFanout({ specs, outcomes });
  const humanQueue = buildHumanQueue({ specs, outcomes, collected });

  return {
    ...base,
    empty: false,
    total: specs.length,
    dispatched: dispatch.dispatched,
    collected: outcomes.filter((outcome) => outcome.ok).length,
    // complete 的含义刻意很窄：**每个子项都拿到了自己的结论**（无论成功还是失败）。
    // 它回答「这一批跑完了没有」，不回答「这一批成功没有」。
    complete: collected.complete,
    // publishable 才是「可以进入周期级汇总」的信号：全部子项成功且没有冲突。
    publishable: collected.complete && collected.failures.length === 0 && collected.conflicts.length === 0,
    requiresHuman: humanQueue.length > 0 || collected.requiresHuman,
    failures: collected.failures,
    conflicts: collected.conflicts,
    missingItems: collected.missingItems,
    merged: collected.merged,
    humanQueue,
    outcomes,
    dispatch: { total: dispatch.total, dispatched: dispatch.dispatched, failed: dispatch.failed, retryableFailures: dispatch.retryableFailures },
    manifestSummary: { products: products.length, selected: selected.length, outcome: outcome || null, top5GeneratedAt: manifest?.generatedAt ?? null },
  };
}

// 人工队列：把「为什么需要人」摊平成一张可执行的清单。
export function buildHumanQueue({ specs = [], outcomes = [], collected = {} } = {}) {
  const byKey = new Map(specs.map((spec) => [spec.itemKey, spec]));
  const queue = [];
  for (const outcome of outcomes) {
    if (outcome.ok) continue;
    queue.push({
      reason: HUMAN_QUEUE_REASONS.includes(outcome.reason) ? outcome.reason : 'COLLECT_FAILED',
      productId: outcome.itemKey,
      runId: outcome.runId,
      businessKey: outcome.businessKey ?? byKey.get(outcome.itemKey)?.businessKey ?? null,
      failureClass: outcome.failureClass ?? null,
      detail: outcome.error ?? null,
      validationCodes: outcome.validationCodes ?? [],
      // 「稍后再试」与「这个商品坏了」是两件事：容量问题不该被当成数据问题去改数据。
      retryable: Boolean(outcome.retryable),
    });
  }
  for (const itemKey of collected.missingItems ?? []) {
    queue.push({
      reason: 'UNSETTLED', productId: itemKey, runId: null,
      businessKey: byKey.get(itemKey)?.businessKey ?? null, failureClass: null,
      detail: 'dispatched but no verdict was collected', validationCodes: [], retryable: true,
    });
  }
  for (const conflict of collected.conflicts ?? []) {
    queue.push({
      reason: 'CONFLICT', productId: conflict.key, runId: null,
      businessKey: byKey.get(conflict.key)?.businessKey ?? null, failureClass: null,
      detail: `two different evidence results for the same product: ${JSON.stringify(conflict.values)}`,
      validationCodes: [], retryable: false,
    });
  }
  return queue.sort((a, b) => String(a.productId).localeCompare(String(b.productId)) || a.reason.localeCompare(b.reason));
}

export async function writeBatchReceipt({ runtimeRoot = 'runtime', period, receipt }) {
  const directory = resolve(runtimeRoot, 'faq-analysis', period);
  await mkdir(directory, { recursive: true });
  const receiptPath = resolve(directory, 'faq-fanout-receipt.json');
  const queuePath = resolve(directory, 'faq-fanout-human-queue.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  writeFileSync(queuePath, `${JSON.stringify({ period, generatedAt: new Date().toISOString(), items: receipt.humanQueue }, null, 2)}\n`, 'utf8');
  return { receiptPath, queuePath };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// 用法：
//   node runtime/sop-runtime/run-faq-fanout.mjs --period-start D --period-end D --identity <json> \
//     [--runtime-root runtime] [--products id1,id2] [--lane-limits <json>] [--database-url <pg>] [--no-write]
//
// 说明：本驱动器的全部动作都是**只读本地证据 + 写本地回执**，没有外部写入，
// 因此没有 dry-run/commit 之分；--no-write 只用来跳过回执落盘（便于试跑）。
export function parseCliArgs(argv) {
  const args = { runtimeRoot: 'runtime', writeReceipts: true };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--no-write') { args.writeReceipts = false; continue; }
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (!token.startsWith('--')) throw new Error(`Unknown argument: ${token}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    args[token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    i += 1;
  }
  if (args.help) return args;
  if (!args.periodStart || !args.periodEnd) throw new Error('--period-start and --period-end are required together');
  if (!args.identity) throw new Error('--identity is required (JSON with tenantId/storeId/platform/accountId/browserProfileId/contractVersion)');
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (args.help) {
    process.stdout.write('usage: run-faq-fanout.mjs --period-start D --period-end D --identity <json> [--runtime-root <p>] [--products id1,id2] [--lane-limits <json>] [--database-url <pg>] [--no-write]\n');
    return 0;
  }

  const { registry, result } = await buildRegistryFromDisk();
  if (!result.ok) throw new FaqFanoutError(`registry invalid: ${JSON.stringify(result.errors)}`, 'REGISTRY_INVALID');

  const store = args.databaseUrl
    ? await (await import('./stores/pg-store.mjs')).createPgStore(args.databaseUrl)
    : createMemoryStore();
  const controller = createController({ store });
  const period = `${args.periodStart}_${args.periodEnd}`;
  const evidenceStore = createEvidenceStore({ root: resolve(args.runtimeRoot, 'faq-analysis', period, 'evidence') });

  try {
    const receipt = await runFaqFanout({
      runtimeRoot: args.runtimeRoot,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      productIds: args.products ? String(args.products).split(',').map((id) => id.trim()).filter(Boolean) : null,
      identity: JSON.parse(args.identity),
      registry,
      loader: createLoader({ registry }),
      store, controller, evidenceStore,
      laneLimits: args.laneLimits ? JSON.parse(args.laneLimits) : null,
    });
    if (args.writeReceipts) {
      const paths = await writeBatchReceipt({ runtimeRoot: args.runtimeRoot, period, receipt });
      receipt.receiptPath = paths.receiptPath;
      receipt.humanQueuePath = paths.queuePath;
    }
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return receipt.publishable || receipt.empty ? 0 : 2;
  } finally {
    if (store?.close) await store.close();
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exit(error?.code ? 4 : 1);
    });
}
