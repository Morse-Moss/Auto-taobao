// sop-runtime：确定性运行底座统一出口
export * from './context-schema.mjs';
export * from './policy.mjs';
export * from './round-notify-policy.mjs';
export * from './task-admission.mjs';
export * from './task-queue.mjs';
export * from './agent-proposal.mjs';
export * from './agent-review.mjs';
export * from './agent-planned-run.mjs';
export * from './workflow-controller.mjs';
export * from './validator.mjs';
export * from './validation-registry.mjs';
export * from './side-effect-ledger.mjs';
export * from './publication.mjs';
export * from './evidence-store.mjs';
export * from './compression-service.mjs';
export * from './memory-store.mjs';
export * from './worker-adapter.mjs';
export * from './store-port.mjs';
export * from './run-liveness.mjs';
export * from './semver.mjs';
export * from './skill-manifest.mjs';
export * from './skill-registry.mjs';
export * from './skill-discovery.mjs';
export * from './skill-loader.mjs';
export { createMemoryStore } from './stores/memory-store.mjs';
export { createPgStore, RequiresMigrationError } from './stores/pg-store.mjs';
// 运行器装配与调度器：这里用**具名导出**而不是 `export *`——两者的 CLI 都各自导出了 `main`，
// 而 barrel 里出现一个 `main` 对任何 `import * as sop` 的调用方都是个意外入口。
export { createRuntimeContext } from './runtime-bootstrap.mjs';
export {
  SCHEDULER_CONTRACT_VERSION,
  QUEUE_PROBE_EXPORT,
  QUEUE_STATES,
  SKIPPABLE_QUEUE_STATES,
  SCHEDULE_OUTCOMES,
  SCHEDULE_RECEIPT_FIELDS,
  SchedulerError,
  probeCapabilityQueue,
  runScheduled,
  parseSchedulerArgs,
  exitCodeFor,
} from './capability-scheduler.mjs';
// 一轮运行的生命周期（无人值守运行内核）：同样用具名导出，理由与上面一致。`main` 不导出。
export {
  ROUND_CONTRACT_VERSION,
  ROUND_STATE_VERSION,
  ROUND_STEPS,
  ROUND_OUTCOMES,
  ROUND_RECEIPT_FIELDS,
  DEFAULT_MAX_ATTEMPTS_PER_DAY,
  SCHEDULER_OUTCOMES_WITHIN_ROUND,
  AUTO_RETRY_REASONS,
  RoundError,
  localDayKey,
  createMemoryRoundState,
  createFileRoundState,
  escalationReasonFor,
  runRound,
  exitCodeForRound,
  parseRoundArgs,
} from './round-runner.mjs';
