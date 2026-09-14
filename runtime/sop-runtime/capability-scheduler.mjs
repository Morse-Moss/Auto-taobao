// 调度侧驱动器：在**发起一次运行之前**先问清楚「这条能力现在有没有活」。
//
// 为什么需要它：huitun 那条能力在空队列时确定性拒绝 `NO_CANDIDATES`，并且它的实现里已经写明
// 「由驱动器负责『空队列就不要再发起本能力』」——但在没有驱动器时，调度侧只有两种选择：
//   1. 照常发起：每次空队列都留下一条**失败的运行记录**，把「本周没有要补的词」这个正常运营
//      状态写成了故障；运营看到红灯去查，查到的是「没事」。
//   2. 人工跳过：跳过这件事没有任何可审计的载体——事后没人能回答「上周为什么没跑」。
// 两者都不对。本模块把「有没有活」做成一等公民：**探测（只读、不建运行）→ 有活才发起**。
//
// 硬约束（与 Spec 的取向一致，不允许调用方绕过）：
//  - 探测**只读**，且绝不创建运行。跳过不留运行记录（跳过这件事由收据本身承载，见 SCHEDULE_RECEIPT_FIELDS）。
//  - **探测失败一律照常发起**（UNAVAILABLE / NOT_PROBED 都走真实运行）。这是本模块唯一一处
//    刻意 fail-open 的地方，理由是失败方向不同：探测器坏掉时的两个选择是「多做一次本来会失败的
//    运行」（可见、可修）与「少做一次本来该做的活」（不可见、要等下游发现）。前者才对。
//    反过来，只有探测**给出了确定结论**（EMPTY / WAITING_HUMAN）才允许跳过。
//  - 探测**不做策略判决**。它只回答「队列里有没有活」；字段类型不符、越权写入、队列过大等等
//    一律留给真实运行按既有分类去判。否则这里会长出第二个策略引擎，两份判决早晚不一致。
//  - 五条出口（RAN / PROBED_ONLY / SKIPPED_EMPTY_QUEUE / PAUSED_FOR_HUMAN /
//    PROCEEDED_WITHOUT_PROBE）的收据字段**恒等**，且由同一个工厂函数产出——不靠人工记得补齐。
//
// 探测不消除竞态：探测通过之后队列仍可能被清空，真实运行照样会给出 NO_CANDIDATES。
// 探测只是把「稳定的空队列」从「偶发的空队列」里分出来；**真实运行始终是权威**。
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { createRuntimeContext } from './runtime-bootstrap.mjs';
import { runTwoStage, parseCliArgs } from './two-stage-runner.mjs';

export const SCHEDULER_CONTRACT_VERSION = 'capability-scheduler-v1';

// 能力侧要实现的探测契约：导出 `probeQueue({ collectInput, target, expectedRows })`。
// 与 collectContract 同属「能力自描述的入口」，因此**不需要**在 manifest 里新增字段
// （manifest 管的是副作用与权限，探测既无副作用也不扩权，改它只会白白移动 registryDigest）。
export const QUEUE_PROBE_EXPORT = 'probeQueue';

// 探测结论。前三个由能力返回；后两个由调度器派生（能力没有探测契约 / 探测没给出可用结论）。
export const QUEUE_STATES = Object.freeze(['READY', 'EMPTY', 'WAITING_HUMAN', 'UNAVAILABLE', 'NOT_PROBED']);

// **只**有这两个状态允许跳过。加状态进来之前请先读文件头的 fail-open 约束。
export const SKIPPABLE_QUEUE_STATES = Object.freeze(['EMPTY', 'WAITING_HUMAN']);

export const SCHEDULE_OUTCOMES = Object.freeze([
  'RAN',                     // 探测通过（或没探测出结论）→ 真实运行已发起
  'PROBED_ONLY',             // 只探测，不发起（给调度器排产用）
  'SKIPPED_EMPTY_QUEUE',     // 队列确认为空：正常运营状态，不是失败
  'PAUSED_FOR_HUMAN',        // 队列里还有等上游 AI 结算的行：等人工，不是失败
  'PROCEEDED_WITHOUT_PROBE', // 没拿到可用结论，但照样发起（fail-open）
]);

// 调度收据的字段清单。五条出口共用同一组键——包括 humanRequired 这类布尔字段必须**恒在**：
// 用 `undefined` 冒充「否」会让调用方无法区分「明确为假」与「这条路径忘了设置」。
export const SCHEDULE_RECEIPT_FIELDS = Object.freeze([
  'contractVersion',
  'capabilityId',
  'outcome',
  'scheduled',
  'ok',
  'humanRequired',
  'failureClass',
  'queueState',
  'queueCode',
  'candidateCount',
  'reasons',
  'probe',
  'run',
]);

export class SchedulerError extends Error {
  constructor(message, code, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'SchedulerError';
    this.code = code;
    this.details = details;
  }
}

const asText = (value) => (value === undefined || value === null ? '' : String(value).trim());
const messageOf = (error) => asText(error?.message ?? error) || String(error);

// 唯一的收据工厂：所有出口都从这里出，因此「字段恒等」是结构上成立的，而不是靠约定。
function receiptOf({ capabilityId, outcome, probe, overrides = {} }) {
  const base = {
    contractVersion: SCHEDULER_CONTRACT_VERSION,
    capabilityId,
    outcome,
    scheduled: false,
    ok: true,
    humanRequired: false,
    failureClass: null,
    queueState: probe?.state ?? 'NOT_PROBED',
    queueCode: probe?.code ?? null,
    candidateCount: probe?.candidateCount ?? null,
    reasons: [],
    probe: probe ?? null,
    run: null,
  };
  const merged = { ...base, ...overrides };
  // 自检：任何一条出口漏字段都是本模块的缺陷，不能悄悄发出去。
  const missing = SCHEDULE_RECEIPT_FIELDS.filter((key) => !Object.hasOwn(merged, key));
  if (missing.length) throw new SchedulerError(`schedule receipt is missing ${missing.join(', ')}`, 'RECEIPT_INCOMPLETE', { missing, outcome });
  return merged;
}

function inconclusiveProbe({ capabilityId, state, code, reason, probeError = null, detail = null }) {
  return {
    contractVersion: SCHEDULER_CONTRACT_VERSION,
    capabilityId,
    probed: false,
    state,
    code,
    reason,
    candidateCount: null,
    detail,
    probeError,
  };
}

// 收据是否已经是本模块自己产出的那一份（幂等判据）。
function isNormalizedProbe(raw) {
  return raw !== null && typeof raw === 'object'
    && raw.contractVersion === SCHEDULER_CONTRACT_VERSION
    && typeof raw.probed === 'boolean'
    && QUEUE_STATES.includes(asText(raw.state).toUpperCase());
}

// 归一化探测器给出的结论。**幂等**：默认实现产出的收据再走一遍也不变样。
//
// 为什么归一化要独立成一个必然步骤（而不是只在默认实现里做一次）：状态白名单是「能不能跳过」
// 的唯一闸门。任何一条探测实现（默认的、注入的、将来别人写的）都必须经过它——否则一个
// 拼错的状态字符串就会绕过白名单，而绕过白名单的方向恰好是「把真活当没活跳过」。
export function normalizeProbeResult(raw, { capabilityId = null } = {}) {
  if (raw === null || raw === undefined) {
    return inconclusiveProbe({
      capabilityId,
      state: 'UNAVAILABLE',
      code: 'PROBE_EMPTY_RESULT',
      reason: 'the queue probe returned nothing',
    });
  }
  // 幂等分支：再一次归一化不许把 detail 再套一层（detail.detail.…）——那会把能力自带的细节
  // （例如灰豚的 pendingCount / sampleKeywords）埋进越来越深的一层里，直到没人再看得见它。
  // 它**不放松**判据：state 仍须属于 QUEUE_STATES，跳过仍要求 probed === true（只有这里会写 true）。
  // 能写出这个信封的只有本模块自己的契约版本号命名空间；能力方伪造它等于伪造自己的执行结果，
  // 而能力本来就可信（它已经有权直接写飞书），这里不引入新的信任边界。
  if (isNormalizedProbe(raw)) return { ...raw };
  const state = asText(raw.state).toUpperCase();
  if (!['READY', 'EMPTY', 'WAITING_HUMAN'].includes(state)) {
    // 已经是「没结论」的收据原样通过（保持幂等）；其余一律判为「认不出来」。
    if (raw.probed === false && QUEUE_STATES.includes(state)) {
      return inconclusiveProbe({
        capabilityId,
        state,
        code: asText(raw.code) || null,
        reason: asText(raw.reason) || null,
        probeError: raw.probeError ?? null,
        detail: raw.detail ?? null,
      });
    }
    return inconclusiveProbe({
      capabilityId,
      state: 'UNAVAILABLE',
      code: 'PROBE_STATE_UNKNOWN',
      reason: `the queue probe returned an unusable state: ${JSON.stringify(raw.state ?? null)}`,
      detail: raw,
    });
  }
  // 候选数：**null 不是 0**。`Number(null) === 0` 这个陷阱会让「未结算、候选数未知」
  // 在收据里变成「0 个候选」——那正好是「假装知道」，与本模块的存在理由相反。
  const rawCount = raw.candidateCount;
  const count = rawCount === null || rawCount === undefined || rawCount === '' ? null : Number(rawCount);
  return {
    contractVersion: SCHEDULER_CONTRACT_VERSION,
    capabilityId,
    probed: true,
    state,
    code: asText(raw.code) || null,
    reason: asText(raw.reason) || null,
    candidateCount: count !== null && Number.isSafeInteger(count) && count >= 0 ? count : null,
    detail: raw,
    probeError: null,
  };
}

// 读取一条能力的队列状态。**只读、不建运行、不写任何状态轴。**
// 返回的 `probed` 表示「探测给出了可用结论」——调用方只能凭 `probed === true` 且状态可跳过时跳过。
export async function probeCapabilityQueue({
  loader,
  capabilityId,
  version = '*',
  collectInput = {},
  target = null,
  expectedRows = null,
} = {}) {
  if (!capabilityId) throw new SchedulerError('capabilityId is required to probe a queue', 'SCHEDULER_INPUT_REQUIRED');
  if (!loader || typeof loader.loadAdapter !== 'function') {
    return inconclusiveProbe({
      capabilityId,
      state: 'UNAVAILABLE',
      code: 'PROBE_NOT_AVAILABLE',
      reason: 'no loader was supplied, so the queue cannot be probed',
    });
  }

  let module = null;
  try {
    ({ module } = await loader.loadAdapter(capabilityId, { version }));
  } catch (error) {
    return inconclusiveProbe({
      capabilityId,
      state: 'UNAVAILABLE',
      code: 'PROBE_LOAD_FAILED',
      reason: `the capability module could not be loaded: ${messageOf(error)}`,
      probeError: messageOf(error),
    });
  }

  const probe = module?.[QUEUE_PROBE_EXPORT];
  if (typeof probe !== 'function') {
    return inconclusiveProbe({
      capabilityId,
      state: 'NOT_PROBED',
      code: 'NO_PROBE_CONTRACT',
      reason: `the capability does not export ${QUEUE_PROBE_EXPORT}(); the queue state is unknown and the run proceeds as before`,
    });
  }

  try {
    return normalizeProbeResult(
      await probe({ collectInput, target, expectedRows }),
      { capabilityId },
    );
  } catch (error) {
    // 探测抛异常 = 没拿到结论（**不是**「队列为空」）。原样带出原因，交给调用方照常发起。
    return inconclusiveProbe({
      capabilityId,
      state: 'UNAVAILABLE',
      code: asText(error?.code) || 'PROBE_FAILED',
      reason: `the queue probe failed: ${messageOf(error)}`,
      probeError: messageOf(error),
    });
  }
}

// 探测 → （有活才）发起。收据见 SCHEDULE_RECEIPT_FIELDS。
export async function runScheduled(options = {}) {
  const {
    registry,
    loader,
    capabilityId,
    version = '*',
    collectInput = {},
    target = null,
    expectedRows = null,
    forceRun = false,
    probeOnly = false,
    probe = probeCapabilityQueue,
    // 发起段可注入（与 probe 同理）：用例要能断言「到底有没有发起」以及「转发给运行器的选项长什么样」，
    // 而不是靠一条真实的 run 记录去反推。
    runner = runTwoStage,
  } = options;

  if (!registry || typeof registry.require !== 'function') {
    throw new SchedulerError('registry is required (it names the registered capabilities)', 'SCHEDULER_INPUT_REQUIRED');
  }
  if (!capabilityId) throw new SchedulerError('capabilityId is required', 'SCHEDULER_INPUT_REQUIRED');

  // 转发给运行器的必须是原样的两段式选项：调度器自己的开关不能漏进运行器
  // （否则运行器一旦新增同名参数，这里就成了一个静默的旁路入口）。
  const runnerOptions = { ...options };
  delete runnerOptions.forceRun;
  delete runnerOptions.probeOnly;
  delete runnerOptions.probe;
  delete runnerOptions.runner;

  // 探测这一步**永不**把异常带进调度判决：探测器只有一种异常语义——「这次没探出来」。
  // 并且无论探测器是谁写的，结论都要过同一道归一化（状态白名单），因为那才是「能不能跳过」的闸门。
  let probed;
  if (forceRun) {
    probed = inconclusiveProbe({
      capabilityId,
      state: 'NOT_PROBED',
      code: 'PROBE_SUPPRESSED',
      reason: 'the queue probe was suppressed by forceRun; the capability is launched unconditionally',
    });
  } else {
    try {
      probed = normalizeProbeResult(
        await probe({ loader, capabilityId, version, collectInput, target, expectedRows }),
        { capabilityId },
      );
    } catch (error) {
      probed = inconclusiveProbe({
        capabilityId,
        state: 'UNAVAILABLE',
        code: asText(error?.code) || 'PROBE_FAILED',
        reason: `the queue probe failed: ${messageOf(error)}`,
        probeError: messageOf(error),
      });
    }
  }

  if (probeOnly) {
    const waiting = probed.state === 'WAITING_HUMAN';
    return receiptOf({
      capabilityId,
      outcome: 'PROBED_ONLY',
      probe: probed,
      overrides: {
        ok: !waiting,
        humanRequired: waiting,
        failureClass: waiting ? 'HUMAN_REQUIRED' : null,
        reasons: probed.reason ? [probed.reason] : [],
      },
    });
  }

  if (probed.probed === true && SKIPPABLE_QUEUE_STATES.includes(probed.state)) {
    const empty = probed.state === 'EMPTY';
    return receiptOf({
      capabilityId,
      outcome: empty ? 'SKIPPED_EMPTY_QUEUE' : 'PAUSED_FOR_HUMAN',
      probe: probed,
      overrides: {
        // 空队列 = 「现在没有要做的活」，不是失败：不建运行、不进失败统计。
        ok: empty,
        humanRequired: !empty,
        failureClass: empty ? null : 'HUMAN_REQUIRED',
        reasons: [
          probed.reason ?? (empty
            ? 'the candidate queue is empty; nothing to collect'
            : 'the queue still holds rows awaiting upstream settlement'),
        ],
      },
    });
  }

  const run = await runner(runnerOptions);
  return receiptOf({
    capabilityId,
    outcome: probed.state === 'READY' ? 'RAN' : 'PROCEEDED_WITHOUT_PROBE',
    probe: probed,
    overrides: {
      scheduled: true,
      ok: run.ok === true,
      humanRequired: run.failureClass === 'HUMAN_REQUIRED',
      failureClass: run.failureClass ?? null,
      reasons: Array.isArray(run.reasons) ? run.reasons : [],
      run,
    },
  });
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// 用法（在两段式运行器的参数之上多了三个开关）：
//   node runtime/sop-runtime/capability-scheduler.mjs \
//     --capability <id> --identity <json> --business-key <key> \
//     --collect-input <json> [--work-dir <path>] [--database-url <pg>] \
//     [--commit --env-file <p> --operator <name>] \
//     [--force-run] [--probe-only]
// 退出码：0 完成/无可做之事；2 运行未通过；3 需要人工（含等上游 AI 结算）；4 调用方缺陷。
export function exitCodeFor(receipt) {
  if (receipt.outcome === 'SKIPPED_EMPTY_QUEUE') return 0;
  if (receipt.outcome === 'PAUSED_FOR_HUMAN') return 3;
  if (receipt.outcome === 'PROBED_ONLY') return receipt.humanRequired ? 3 : 0;
  return receipt.ok ? 0 : 2;
}

// 调度器自己的两个开关是**布尔**开关，不吃值。这一点必须在这里剥掉再交给两段式解析器：
// 后者对任何 `--x` 都要求跟一个值（`--commit`/`--json` 是它自己白名单里的例外），
// 于是 `--probe-only` 会被读成「缺值」而报错——布尔开关漏给下游解析器，就是这样炸的。
export function parseSchedulerArgs(argv = []) {
  const flags = { probeOnly: false, forceRun: false };
  const rest = [];
  for (const token of argv) {
    if (token === '--probe-only') { flags.probeOnly = true; continue; }
    if (token === '--force-run') { flags.forceRun = true; continue; }
    rest.push(token);
  }
  const args = parseCliArgs(rest, { profile: flags.probeOnly ? 'probe' : 'run' });
  return { ...args, ...flags };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseSchedulerArgs(argv);
  if (args.help) {
    process.stdout.write('usage: capability-scheduler.mjs --capability <id> [--identity <json> --business-key <key> | --probe-only] [--collect-input <json>] [--target <url>] [--expected-rows N] [--period-start D --period-end D] [--work-dir <p>] [--database-url <pg>] [--commit --env-file <p> --operator <name>] [--force-run] [--json]\n');
    return 0;
  }

  const context = await createRuntimeContext({
    databaseUrl: args.databaseUrl ?? null,
    workDir: args.workDir ?? null,
    workDirPrefix: 'scheduled',
  });
  const { registry, loader, store, controller, ledger, evidenceStore, workDir } = context;

  const collectInput = args.collectInput ? JSON.parse(args.collectInput) : {};
  if (args.envFile) collectInput.envFile = resolve(args.envFile);

  try {
    const receipt = await runScheduled({
      registry, loader, store, controller, ledger, evidenceStore,
      capabilityId: args.capability,
      identity: args.identity ? JSON.parse(args.identity) : null,
      target: args.target ?? null,
      expectedRows: args.expectedRows === undefined ? null : Number(args.expectedRows),
      businessKey: args.businessKey ?? null,
      commit: args.commit,
      operator: args.operator ?? null,
      collectInput,
      collectStepId: args.collectStepId ?? null,
      period: args.periodStart ? { startDate: args.periodStart, endDate: args.periodEnd } : null,
      publishInput: args.publishInput ? JSON.parse(args.publishInput) : {},
      workDir,
      probeOnly: args.probeOnly,
      forceRun: args.forceRun,
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return exitCodeFor(receipt);
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
