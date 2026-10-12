// 「分批驱动 rounds → run-receipt-v1 统一回执」的映射（**纯函数**，2026-10-10 对抗审查整改 A 项抽出）。
//
// 为什么单独一层：这段映射里每一条判错的代价都不是「回执难看」，而是**状态失真** ——
// 把已经终止的驻留写成 PAUSED、把整批成功店伪标成失败店、把真实写入写成 NOT_REQUESTED，
// 三种都会让「拿着回执回答这一轮发生了什么」的人得出错误结论。它必须能被离线用例与
// 突变验证点名覆盖，而不是埋在 `scripts/run-batches.mjs` 那个会起子进程的 CLI 里。
// 分工与 daily-job-plan/run-daily-job、batch-plan/run-batches 完全一致：**映射是纯的，落盘是薄的**。
//
// 依赖方向：只 import runtime 侧模块（run-receipt-v1 的构造器、daily-job-plan 的 HOLD_EXIT），
// 不碰 `skills/`（arch-boundary 守卫）、不做任何 I/O —— 逐店名单（unfixable）与 batches.json 的
// size/sha256 都由调用方（run-batches）算好以 plain data 传进来。
//
// ── 三条映射纪律（2026-10-10 三位审查员点名，写死在这里）───────────────────
//
// ① execution（含驻留终态）：
//   · recovered（holdStatus === HOLD_EXIT.RESUMED_OK，驻留后自动续跑成功）⇒ SUCCEEDED；
//   · 未被挡 && 全部批链退出码为 0 && 无 stop 没停干净（hardFail===0）⇒ SUCCEEDED；
//   · 其余一律 FAILED —— **包括驻留的四种终态**（TIMED_OUT / RESUME_FAILED / NO_VERDICT / NO_HOLD）：
//     这些轮次已经终止且缺数据（或需要技术同学），写成 PAUSED 是失真。
//   · **PAUSED 在本映射里不可达**：run-batches 的驻留是同步子进程（spawnSync 等它退出才回来），
//     走到本函数时驻留必然已经终止 —— 「驻留仍在进行、这一轮还挂着」在 finalize 时刻没有对应形态
//     （已核对 scripts/run-batches.mjs 的 runBatchHold 与 runtime/hold-and-resume-plan.mjs 的
//     HOLD_EXIT 闭合集：0/1/2/3/4 全是终态）。PAUSED 留在 EXECUTION_STATUSES 闭合集里供
//     未来真正的「挂起中回执」形态使用，本映射不产它。
//
// ② 失败店清单（顶层 shops[]）：
//   · 只有拿到**逐店**名单（该批 summary 的 unfixable）时才进顶层 shops[]；
//     拿不到（summary 缺/读不成/没有修不动的店）⇒ 该批对 shops[] 贡献为零，批次级失败留在
//     batches[].execution 里表达 —— **不把整批成功店伪标成失败店**（链退出码是批级的，
//     本层没有更细的事实，不猜）。
//   · recovered=true ⇒ shops=[] 且 failureClass=null —— 恢复后不再挂着失败清单
//     （缺口已补上，当时失败的批次在 batches[].execution 里仍是 FAILED，那是发生过的事实）。
//
// ③ publication（chain 步）：
//   · mode='apply' ⇒ 'UNKNOWN' —— 链真实写入了飞书，但本层没做独立回读，
//     不许假装 NOT_REQUESTED、也不许声称 VERIFIED；
//   · mode='dry-run' ⇒ 'NOT_REQUESTED' —— 没请求写入，链也不带 --commit。
//   · 其余步骤（start / login-preflight / label:* / stop）不写飞书 ⇒ 一律 NOT_REQUESTED。
//
// release 轴纪律（2026-10-10 接线时立下，本轮不许动坏）：observed 恒 false ——
// 释放只认独立两次端口回读，回执生成这一步没做回读就不许假装观察到；
// requested=true 配 status:'UNKNOWN'（未观察到≠观察到未释放），requested=false 配 'HELD'。

import { HOLD_EXIT } from './daily-job-plan.mjs';
import {
  appendArtifact, appendBatch, appendShop, appendStep, createRunReceipt, finalizeRunReceipt,
} from './run-receipt-v1.mjs';

/**
 * 把分批驱动的一轮（rounds + blocked + 驻留结论）映射成一份**已 finalize** 的 run-receipt-v1 回执。
 *
 * 入参全是 plain data（无 I/O、无时钟以外的隐藏输入）：
 * @param {object} o
 * @param {{id:string, version:string}} o.entry          工作流登记项（只用 id/version）
 * @param {string} o.targetDate                           目标日（YYYY-MM-DD）
 * @param {'dry-run'|'apply'} o.mode                      模式（决定 chain 步的 publication）
 * @param {number} o.batchSize                            每批家数
 * @param {string} [o.runId]                              回执 id（缺省由 run-receipt-v1 生成）
 * @param {Array<{index:number, shops:string[], chainStatus:number|null,
 *   steps:Object.<string, number|'skipped'>,
 *   decision?:{release:boolean}, unfixable?:string[]}>} o.rounds
 *   逐轮事实：`unfixable` 由调用方从该批 summary 读出（读不到给 []）；
 *   `decision` 缺省＝那一轮没走到释放判决（release 轴不记）。
 * @param {{batch:number, summaryPath:string, cause:string}|null} o.blocked
 *   整轮被挡的事实（第几批停手、成因）；null＝没被挡。
 * @param {boolean} o.holdEnabled                         调用方是否开了驻留（--hold）
 * @param {number|null} o.holdStatus                      驻留子进程退出码（HOLD_EXIT；没跑过＝null）
 * @param {number} o.hardFail                             stop 没停干净等硬失败计数
 * @param {{path:string, size:number, sha256:string}|null} [o.batchesArtifact]
 *   batches.json 的证据工件描述（size/sha256 由调用方对**落盘字节**算好；spec §7.3）
 * @returns {object} 已 finalize 的 run-receipt-v1 回执（未落盘 —— 落盘与 run-root 逻辑留在调用方）
 */
export function buildRunReceiptFromRounds({
  entry, targetDate, mode, batchSize, runId = null,
  rounds = [], blocked = null, holdEnabled = false, holdStatus = null, hardFail = 0,
  batchesArtifact = null, codeFingerprint = null,
} = {}) {
  const receipt = createRunReceipt({
    workflow: entry.id, workflowVersion: entry.version, targetDate, mode, batchSize,
    ...(runId ? { runId } : {}),
    ...(codeFingerprint ? { codeFingerprint } : {}),
  });

  const recovered = holdStatus === HOLD_EXIT.RESUMED_OK;

  for (const round of rounds) {
    appendBatch(receipt, {
      index: round.index,
      shops: round.shops,
      execution: round.chainStatus === 0 ? 'SUCCEEDED' : 'FAILED',
      ...(round.decision ? {
        release: {
          requested: round.decision.release,
          observed: false,
          status: round.decision.release ? 'UNKNOWN' : 'HELD',
        },
      } : {}),
    });
    // steps 只收**有退出码**的步骤；'skipped'（stop 被跳过）没有退出码，
    // 它的事实由 release 轴（HELD）表达，硬塞进 execution 轴反而要撒谎。
    for (const [stepName, stepStatus] of Object.entries(round.steps ?? {})) {
      if (typeof stepStatus !== 'number') continue;
      appendStep(receipt, round.index, {
        name: stepName,
        execution: stepStatus === 0 ? 'SUCCEEDED' : 'FAILED',
        // chain 是唯一会写飞书的步骤：apply 下真实写入但未独立回读 ⇒ UNKNOWN（不假装
        // NOT_REQUESTED、不声称 VERIFIED）；dry-run ⇒ 没请求写入 ⇒ NOT_REQUESTED。
        publication: stepName === 'chain' && mode === 'apply' ? 'UNKNOWN' : 'NOT_REQUESTED',
      });
    }
  }

  // 失败店清单：见文件头纪律② —— 只收**逐店**名单（unfixable）；拿不到就不点名，
  // 批次级失败留在 batches[].execution。recovered ⇒ 一家都不挂（缺口已补上）。
  if (!recovered) {
    for (const round of rounds) {
      if (round.chainStatus === 0) continue;
      for (const shop of (Array.isArray(round.unfixable) ? round.unfixable : [])) {
        appendShop(receipt, shop);
      }
    }
  }

  if (batchesArtifact) appendArtifact(receipt, batchesArtifact);

  // execution 终判（见文件头纪律①）：recovered 或（未被挡 && 全批链 0 && 无硬失败）⇒ SUCCEEDED；
  // 其余（含驻留四种终态、被挡不驻留、链失败、stop 没停干净）⇒ FAILED。PAUSED 不可达（见文件头）。
  const allChainsOk = rounds.length > 0 && rounds.every((r) => r.chainStatus === 0);
  const execution = (recovered || (!blocked && allChainsOk && hardFail === 0))
    ? 'SUCCEEDED'
    : 'FAILED';
  // failureClass 尽力映射（闭合集，归不了就 null —— 不猜）：
  // 掉登录/修不动的店 ⇒ 只有人能解除；ROUND_BLOCKED（页面缺失）成因不定 ⇒ null。
  const failureClass = execution === 'SUCCEEDED' ? null
    : (blocked && (blocked.cause === 'ROUND_LOGIN_WALL' || blocked.cause === 'UNFIXABLE_SHOPS')
      ? 'HUMAN_REQUIRED' : null);

  finalizeRunReceipt(receipt, { execution, failureClass });
  return receipt;
}
