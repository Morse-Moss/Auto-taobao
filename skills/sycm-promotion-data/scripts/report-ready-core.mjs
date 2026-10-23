// 「导航到阿里妈妈商品报表后，等报表页真正就绪」—— 纯函数 + 有界轮询（2026-10-22 抽出）。
//
// 为什么有这个文件：`produceTask()` 里原来是
//     await request(navigate(url)); await sleep(6500);
//     await setPlanDimension(...)          // 找不到 `.mx-trigger` 就**立刻** throw
// 也就是「等待」与「判据」都是**一次性、无重试**的。真机代价（2026-10-22 网林天猫，
// `evidence/product-data-job-2026-10-21/2026-10-21-20261022021253864-e1dbdbf9/网林天猫/promotion-collect/98-failure-state.json`）：
//   · URL 的日期参数完全正确（startTime=endTime=2026-10-21）；
//   · 但整页只剩 257 个 DIV、1 个 TR、0 个「维度」字样、0 个 INPUT、无弹窗；
//   · 同一份现场里报表表格 `rows=0`、`.mx-trigger` 一个都没有。
// 而 2026-10-21 里可林天猫的同类现场是「DIV=822、TR=58、INPUT=6」——页面渲染完整，
// 只是**下载入口**不可见（那是另一个判据的问题，已由 download-entry-core 修）。
// 两次形态不同 ⇒ 10-22 这次是**报表骨架还没渲出来就被判死**，不是选择器失效。
//
// 判据只读**页面骨架上稳定的东西**，不读会变的文案：
//   ready    `.mx-trigger` 里已经能看到「维度」那个触发器（也就是下一步要点的那个元素本身）
//            —— 这比「等 6.5 秒」诚实：它测的就是「我要点的东西在了没」；
//   table    `.mx-trigger` 还没有，但报表表格已经有行（骨架在长，继续等）；
//   empty    两者都没有（页面还没开始画 / 被踢走 / 空白）。
//
// 为什么不在 `ready` 里要求表格有行：某些店当日确实 0 投放（2026-10-22 网林家居推广
// 源 0 行），要求有行会把「确实没数据」判成「没就绪」。维度触发器与表格行是两个独立信号，
// 前者在、后者空 ⇒ 是「页面就绪但今天没数据」，必须放行。

/** 从一次页面读数判当前处在哪一档。`triggers` / `rows` 缺失按最保守处理。 */
export function planReportReadyStep({ triggers, rows } = {}) {
  const list = Array.isArray(triggers) ? triggers : [];
  if (list.some((text) => String(text ?? '').includes('维度'))) return 'ready';
  const rowCount = Number(rows);
  if (Number.isFinite(rowCount) && rowCount > 0) return 'table';
  return 'empty';
}

/**
 * 有界轮询等报表页就绪。超时**不抛**：把最后一次读数与读次数交回，由调用方用同一句文案报错
 * （保留原来的可见症状），同时能把「读了 N 次都没出骨架」和「压根没读」分开。
 *
 * `read` / `delay` / `now` 都可注入 ⇒ 用例用假时钟，不必真等。
 */
export async function pollReportReady({
  read, timeoutMs = 25000, intervalMs = 1500, delay, now = Date.now,
} = {}) {
  if (typeof read !== 'function') throw new Error('pollReportReady 需要 read()（读一次页面骨架）');
  if (!(timeoutMs >= 0)) throw new Error(`pollReportReady 的 timeoutMs 必须是非负数，收到 ${JSON.stringify(timeoutMs)}`);
  const wait = delay ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const deadline = now() + timeoutMs;
  let reads = 0; let last = {}; let step = 'empty';
  for (;;) {
    last = (await read()) ?? {};
    reads += 1;
    step = planReportReadyStep(last);
    if (step === 'ready') return { state: last, reads, step, timedOut: false };
    if (now() >= deadline) return { state: last, reads, step, timedOut: true };
    await wait(intervalMs);
  }
}

/** 就绪失败时的一句人话：说清「看到了什么」，而不是只说「找不到选择器」。 */
export function describeReportReadyFailure({ state, reads } = {}) {
  const triggers = Array.isArray(state?.triggers) ? state.triggers : [];
  const rows = state?.rows;
  return `商品报表页在 ${reads ?? 0} 次读取内没有渲染出可用的报表骨架`
    + `（维度触发器 ${triggers.length} 个、表格 ${rows ?? '未读到'} 行、网址 ${state?.href ? '已到报表页' : '未到报表页'}）`;
}
