#!/usr/bin/env node
// 通用两段式运行器（Spec 11.1 / ADR-004）。
//
// 为什么需要它：`run-feishu-import-two-stage.mjs` 是第一条迁移的**专用**运行器——
// 采集输入、验证器合同、发布钩子全部硬编码在文件里。若每条能力都这样写一份，
// 「新能力只需新增目录/manifest/实现/测试，不改核心 Runtime」这条阶段 3 验收标准就名存实亡。
//
// 本模块把两段式固化成**能力无关**的驱动：
//   ADMIT → (HUMAN GATE) → COLLECT(Worker+采集期验证器) → VALIDATED
//         → PUBLISH(Publisher+发布期验证器) → VERIFIED → ADVANCE CURSOR
// 每条能力只需要提供：
//   1. manifest（声明副作用与验证器集合）；
//   2. 实现模块导出 `adapter`（采集段 7 方法）；
//   3. 若声明了外部写副作用，再导出 `createPublisher(...)`（发布段钩子工厂）。
//
// 硬约束（与 Spec 一致，不允许调用方绕过）：
//  - 发布段只有在 manifest 声明了外部写副作用时才执行；否则保持 NOT_REQUESTED。
//  - 高风险能力提交前必须 humanGateStatus=APPROVED，运行器只负责把审批记录进去，不代替审批。
//  - 游标只在 VERIFIED 之后推进，且推进量必须来自已验证的证据（而不是调用方口述）。
//  - 采集段与发布段之间只通过**工件字节**传递数据，不通过进程内内存——
//    这是跨进程恢复能成立的前提。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRuntimeContext } from './runtime-bootstrap.mjs';
import { admitTask } from './task-admission.mjs';
import { createCapabilityWorker } from './worker-adapter.mjs';
import { createCapabilityPublisher, EXTERNAL_WRITE_EFFECTS } from './publication.mjs';
import { summarize } from './context-schema.mjs';

// 发布段钩子工厂的约定导出名。能力模块导出 createPublisher(context) -> { handler, readBack }。
export const PUBLISH_HOOK_FACTORY = 'createPublisher';

// 准入期「入队后就没人管了」的默认阈值：只用于**没有开放 attempt** 的 QUEUED 运行
// （例如进程刚建了 run 就被打断、连 attempt 都没开）。有这个默认值，这类残骸也不必再人工清理；
// 有租约的运行不看时间，只看租约（见 run-liveness.mjs）——这是刻意的：
// 一次真实抓取可能跑很久，用「多久没动」判死活会把活着的运行误杀。
export const ADMISSION_STALE_AFTER_MS = 30 * 60 * 1000;

export class TwoStageError extends Error {
  constructor(message, code, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'TwoStageError';
    this.code = code;
    this.details = details;
  }
}

// 采集段只允许声明「非外部写」的副作用：即使调用方传了完整 manifest 副作用列表，
// 采集准入也不能因此被当成写操作放大风险等级，反之也不能被缩小。
export function collectSideEffects(manifest) {
  return (manifest?.sideEffects ?? []).filter((effect) => !EXTERNAL_WRITE_EFFECTS.includes(effect));
}

// 从 manifest 副作用里挑出用于提交登记的 effectClass（多个时取声明顺序里的第一个）。
export function primaryWriteEffect(manifest) {
  return (manifest?.sideEffects ?? []).find((effect) => EXTERNAL_WRITE_EFFECTS.includes(effect)) ?? null;
}

// 解析发布段钩子。缺工厂即 fail-closed：宁可报「没接线」，也不能让一个声明要写外部的能力
// 在提交路径上找不到实现时静默跳过发布、把 NOT_REQUESTED 当成「已完成」。
export function resolvePublishHooks({ module, artifactBytes, evidence, period = null, target = null, collectInput = {}, publishInput = {} , manifest = null }) {
  const factory = module?.[PUBLISH_HOOK_FACTORY] ?? module?.default?.[PUBLISH_HOOK_FACTORY] ?? null;
  if (typeof factory !== 'function') {
    throw new TwoStageError(
      `${manifest?.name ?? 'unknown'} writes externally but its entry module exports no ${PUBLISH_HOOK_FACTORY}()`,
      'PUBLISH_HOOK_MISSING',
      { capability: manifest?.name ?? null, declared: Object.keys(module ?? {}) },
    );
  }
  const hooks = factory({ artifactBytes, evidence, period, target, collectInput, publishInput, manifest });
  if (typeof hooks?.handler !== 'function' || typeof hooks?.readBack !== 'function') {
    throw new TwoStageError(
      `${PUBLISH_HOOK_FACTORY}() must return { handler, readBack }`,
      'PUBLISH_HOOK_INVALID',
      { capability: manifest?.name ?? null, returned: Object.keys(hooks ?? {}) },
    );
  }
  return hooks;
}

export async function runTwoStage({
  registry,
  loader,
  store,
  controller,
  ledger,
  evidenceStore,
  capabilityId,
  version = '*',
  workflow = null,
  identity,
  target = null,
  expectedRows = null,
  businessKey,
  commit = false,
  operator = null,
  collectInput = {},
  collectStepId = null,
  contract = {},
  period = null,
  publishInput = {},
  effectClass = null,
  taskId = null,
  workDir = null,
  // 准入前尝试回收同幂等键上的崩溃遗留运行（缺口 B）。默认开启：这是「重跑一次」这条路
  // 从「必须先人工 recover+cancel」变成「直接能跑」的关键一步。
  reclaimStale = true,
  staleAfterMs = ADMISSION_STALE_AFTER_MS,
} = {}) {
  if (!businessKey) throw new TwoStageError('businessKey is required for idempotent publish', 'BUSINESS_KEY_REQUIRED');

  const entry = registry.require(capabilityId, { version });
  const manifest = entry.manifest;
  const writesExternally = (manifest.sideEffects ?? []).some((effect) => EXTERNAL_WRITE_EFFECTS.includes(effect));

  // A. 准入。采集段与发布段用不同的副作用集合准入：
  //    默认模式（只跑采集）绝不声明外部写入，因此不会触达人工闸门；
  //    --commit 模式按 manifest 声明的完整副作用准入，高风险 → 开闸 → 必须有 --operator。
  // 回收回调把「动运行状态」这件事留在 Controller 手里：准入只提出请求，判定与落库都在 Controller，
  // 回收被拒（RUN_NOT_STALE / PUBLICATION_UNRESOLVED）会原样带回来，而不是被悄悄吞掉。
  const admission = await admitTask({
    store,
    spec: {
      taskId: taskId ?? `${capabilityId}-${manifest.version}`,
      workflow: workflow ?? capabilityId,
      capability: capabilityId,
      identity,
      target,
      targetEnd: expectedRows ?? 0,
      sideEffects: commit ? [...(manifest.sideEffects ?? [])] : collectSideEffects(manifest),
      write: commit,
      verifiedCursor: expectedRows === null ? null : { start: 1, end: 0, version: 0 },
    },
    registeredCapabilities: registry.names(),
    reclaimStale,
    abandonedAfterMs: staleAfterMs,
    reclaim: reclaimStale ? (runId) => controller.reclaimStale(runId, {
      operator: operator ?? 'two-stage-runner',
      note: 'auto reclaim on admission (stale run, external write provably not handed off)',
      abandonedAfterMs: staleAfterMs,
    }) : null,
  });
  if (!admission.admitted) {
    return {
      ok: false, admitted: false, capabilityId,
      reasons: admission.rejectionReasons,
      failureClass: admission.failureClass,
      // 把「为什么被挡 / 下一步做什么」原样交给调用方：这两个字段让运维不必再去猜运行状态。
      duplicateOf: admission.duplicateOf ?? null,
      duplicateStatus: admission.duplicateStatus ?? null,
      reclaimAttempt: admission.reclaimAttempt ?? null,
      reclaimable: admission.reclaimable ?? null,
      hint: admission.hint ?? null,
    };
  }
  const runId = admission.runId;

  let gate = {
    status: admission.context.humanGateStatus,
    decision: admission.policy.decision,
    riskClass: admission.policy.riskClass,
    lane: admission.policy.lane,
  };
  if (gate.status === 'WAITING_HUMAN') {
    if (!operator) {
      // 不开闸也不假装放行：直接返回，等人工审批后重跑。
      return { ok: false, admitted: true, runId, capabilityId, gate, failureClass: 'HUMAN_REQUIRED', reasons: ['human gate open; rerun with operator approval recorded'] };
    }
    await controller.approve(runId, { operator, note: 'two-stage runner' });
    gate = { ...gate, status: 'APPROVED', operator };
  }

  // B. 采集段：Worker 只跑一次，产出可复验工件。
  // 先装载实现模块，再向它要「自己的采集期合同」——能力自描述，
  // 调用方不需要在运行器里替每条能力维护一份 requiredFields 清单。
  const loaded = await loader.loadAdapter(capabilityId, { version });
  const declaredContract = typeof loaded.module?.collectContract === 'function'
    ? (loaded.module.collectContract({ target, expectedRows, collectInput }) ?? {})
    : {};
  const capability = await createCapabilityWorker({
    registry, loader, controller, evidenceStore, capabilityId,
    contract: { ...declaredContract, ...contract, ...(expectedRows === null ? {} : { expectedRows }) },
  });

  const collect = await capability.worker.runOnce({
    runId,
    stage: 'COLLECT',
    stepId: collectStepId,
    input: collectInput,
    manifestMeta: { workDir },
  });
  if (!collect.ok) {
    return {
      ok: false, admitted: true, runId, capabilityId, gate,
      stage: 'COLLECT',
      failureClass: collect.failureClass,
      validation: collect.validation ?? null,
      error: collect.error ?? null,
      context: summarize(await controller.getContext(runId)),
    };
  }

  const afterCollect = await controller.markEvidenceValidated(runId);
  const evidence = collect.manifest;

  // C. 发布段。
  let publish = null;
  let cursor = null;
  let settled = null;
  const shouldPublish = commit && writesExternally;
  if (!shouldPublish) {
    publish = {
      verdict: 'NOT_ATTEMPTED',
      reason: commit
        ? 'capability declares no external write effect; nothing to publish'
        : '采集段完成；发布段需要 --commit（真实外部写入）与人工授权，本次未执行。',
      note: 'publicationStatus 保持 NOT_REQUESTED，游标不推进——收据只证明采集段，不冒充发布已验收。',
    };
    // **终结本次运行**。这不是可有可无的收尾：
    // completeAttempt 只把 nextAction 置为 COMMIT，executionStatus 仍是 RUNNING，
    // 这条 run 会一直算「活跃」（占用队列深度、旧口径下还占着 lane），而且永远没有终态。
    // 本次调用该做的都做完了（产出已验证工件 + 明确未发布），因此正确的终态是 Controller 既有的
    // succeed()（SUCCEEDED + TERMINAL + 释放 lease）。它不推进游标，所以不会把"采集成功"
    // 冒充成"发布已验收"；后续 --commit 是一次新的运行，不会与这条 run 抢资源。
    settled = await controller.succeed(runId);
  } else {
    if (!evidence?.path || !existsSync(evidence.path)) {
      throw new TwoStageError(`evidence artifact file missing at publish time: ${evidence?.path ?? 'null'}`, 'EVIDENCE_FILE_MISSING', { evidence });
    }
    const artifactBytes = readFileSync(evidence.path);
    const hooks = resolvePublishHooks({
      module: loaded.module, artifactBytes, evidence, period, target, collectInput, publishInput, manifest,
    });
    const publisher = createCapabilityPublisher({
      registry, controller, ledger, capabilityId,
      contract: {
        publication: expectedRows === null ? {} : { rows: expectedRows },
        readback: expectedRows === null ? {} : { rows: expectedRows },
        ...contract,
      },
    });
    publish = await publisher.publish({
      runId,
      target,
      businessKey,
      effectClass: effectClass ?? primaryWriteEffect(manifest),
      handler: hooks.handler,
      readBack: hooks.readBack,
      expected: expectedRows === null ? {} : { rows: expectedRows },
    });
    if (publish.verdict === 'VERIFIED') {
      cursor = await controller.advanceCursor(runId, {
        end: expectedRows ?? evidence.rowCount,
        commitRefs: [{ commitKey: publish.commitKey, capability: capabilityId }],
      });
      settled = await controller.succeed(runId);
    }
    // 发布未被验证时**不终结**：要么等对账（UNKNOWN），要么等人工（REJECTED 后的重试/终止判断），
    // 把一条尚未结算外部写入的 run 标成 SUCCEEDED 才是真正的谎报。
  }

  const finalContext = await controller.getContext(runId);
  const receipt = {
    ok: collect.ok && (!shouldPublish || publish?.verdict === 'VERIFIED'),
    runId,
    capability: `${manifest.name}@${manifest.version}`,
    entry: manifest.entry,
    mode: commit ? 'commit' : 'dry-run',
    gate,
    collect: {
      stage: 'COLLECT',
      attemptId: collect.attemptId,
      artifactPath: evidence?.path ?? null,
      sha256: evidence?.sha256 ?? null,
      rowCount: evidence?.rowCount ?? null,
      artifactId: evidence?.artifactId ?? null,
      validators: (collect.validation?.results ?? []).map((row) => `${row.name}:${row.ok === true ? 'ok' : row.code}`),
      validationSource: collect.validation?.source ?? null,
      contextAfterCollect: summarize(afterCollect),
    },
    publish,
    publicationStatus: finalContext.publicationStatus,
    // 运行终态：succeed() 之后是 SUCCEEDED。发布未验证时保持 RUNNING（等对账/人工），
    // 此时 executionStatus=null 表示"本次调用没有把它结算掉"。
    executionStatus: settled?.executionStatus ?? null,
    nextAction: settled?.nextAction ?? finalContext.nextAction,
    cursorAdvanced: Boolean(cursor),
    verifiedCursor: cursor?.verifiedCursor ?? finalContext.verifiedCursor ?? null,
  };
  if (workDir) {
    writeFileSync(resolve(workDir, 'two-stage-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  }
  return receipt;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// 用法：
//   node runtime/sop-runtime/two-stage-runner.mjs \
//     --capability <id> --identity <json> [--target <url>] --business-key <key> \
//     [--collect-input <json>] [--period-start D --period-end D] [--expected-rows N] \
//     [--work-dir <path>] [--database-url <pg-url>] \
//     [--commit --operator <name>]
//
// profile='probe' 供「只探测、不发起」的调用方复用同一份词法解析：它只保留 --capability 这条必填，
// 不再要求 --identity/--business-key/--commit 三件套——那些是**发起一次运行**的前提，
// 探测不建运行，强求它们只会逼调用方传假值。语法解析只有一份，语义校验按 profile 分档。
export function parseCliArgs(argv, { profile = 'run' } = {}) {
  const args = { commit: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--commit') { args.commit = true; continue; }
    if (token === '--json') { args.json = true; continue; }
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (!token.startsWith('--')) throw new Error(`Unknown argument: ${token}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    args[token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    i += 1;
  }
  if (args.help) return args;
  if (!args.capability) throw new Error('--capability is required');
  if (profile === 'probe') return args;
  if (!args.identity) throw new Error('--identity is required (JSON with tenantId/storeId/platform/accountId/browserProfileId/contractVersion)');
  if (!args.businessKey) throw new Error('--business-key is required');
  if (args.commit && !args.operator) throw new Error('--operator is required with --commit (records who approved the human gate)');
  if (args.commit && !args.envFile) throw new Error('--env-file is required with --commit');
  if (Boolean(args.periodStart) !== Boolean(args.periodEnd)) throw new Error('--period-start and --period-end must be given together');
  return args;
}

export function parseEnvFile(file) {
  const values = {};
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    let value = line.slice(separator + 1).trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    values[line.slice(0, separator).trim()] = value;
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (args.help) {
    process.stdout.write('usage: two-stage-runner.mjs --capability <id> --identity <json> --business-key <key> [--target <url>] [--collect-input <json>] [--period-start D --period-end D] [--expected-rows N] [--work-dir <p>] [--database-url <pg>] [--commit --env-file <p> --operator <name>] [--json]\n');
    return 0;
  }

  // 装配收敛在 runtime-bootstrap.mjs：两段式运行器与调度器必须跑在**同一套** store / Controller
  // 上——「dry-run 用内存、真实运行用权威 PG」这个默认值一旦在两处漂移，恢复语义
  // （游标 / 租约 / 提交账本 / UNKNOWN 对账）会静默失效，而且看起来还是绿的。
  const { registry, loader, store, controller, ledger, evidenceStore, workDir } = await createRuntimeContext({
    databaseUrl: args.databaseUrl ?? null,
    workDir: args.workDir ?? null,
    workDirPrefix: 'two-stage',
  });

  const collectInput = args.collectInput ? JSON.parse(args.collectInput) : {};
  if (args.envFile) collectInput.envFile = resolve(args.envFile);

  try {
    const receipt = await runTwoStage({
      registry, loader, store, controller, ledger, evidenceStore,
      capabilityId: args.capability,
      identity: JSON.parse(args.identity),
      target: args.target ?? null,
      expectedRows: args.expectedRows === undefined ? null : Number(args.expectedRows),
      businessKey: args.businessKey,
      commit: args.commit,
      operator: args.operator ?? null,
      collectInput,
      collectStepId: args.collectStepId ?? null,
      period: args.periodStart ? { startDate: args.periodStart, endDate: args.periodEnd } : null,
      publishInput: args.publishInput ? JSON.parse(args.publishInput) : {},
      workDir,
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return receipt.ok ? 0 : 2;
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
