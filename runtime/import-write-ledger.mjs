// 批量写入的「流水记录」：每批成功就把**已确认写入的行 id**落到收据里，而不是等全部写完再记。
//
// 为什么要有它（2026-10-17 真机事故）：
// 商品链补跑 10-16 那轮，推广段 sales1 三家 46 行**已经写进飞书了**，但批量接口在第二趟
// 抛了 `Feishu API failed: ...`。原来的三个导入器都是这个写法：
//
//     const ids = [];
//     for (...) ids.push(...await client.batchCreateRecords(...));   // ← 中途抛错，ids 全丢
//     receipt.recordIds = ids;
//     flush();                                                       // ← 根本没跑到
//
// 结果是收据**一个文件都没生成**（`promotion-import/sales1/` 是空目录），主链只好记成
// 「批量导入失败、exit 1」，再逐店重试（幂等 0 行），于是逐店收据全是 `plannedRows=0`。
// 事后要靠**独立回读**才知道真写了 46 行 —— 而收据存在的意义就是不必等干完才知道。
//
// 三条口径（都从事故里换来的）：
//   ① **逐批落盘**：写之前先落一份「准备写 N 行」的草稿，每批成功后再落一次。
//      任何时刻炸掉，收据里都有「到那一刻为止确认写进去的行」。
//   ② **写入阶段的失败也分两类**：4xx（参数/权限/限流）是确定性拒绝 ⇒ 真的没写成；
//      5xx/超时/网络/解析不出状态码 ⇒ **可能已经写入** ⇒ 不许说「没写成」（那是 UNKNOWN_WRITE 的形态，
//      与写后回读失败同一个处置：先回读再决定要不要重试）。
//   ③ 调用方**别自己攒 ids**。攒一份就等于把「已写」的证据押在「后面不再出错」上。
import { isFeishuAuthError } from './feishu-target-preflight.mjs';

/** 飞书批量接口的分片大小（三个导入器原先各写一遍 500，这里收成一处）。 */
export const WRITE_BATCH_SIZE = 500;

/**
 * 写入失败是否**确定没写成**。
 *
 * 只认「服务端明确拒绝这一类」：HTTP 4xx（含 429 限流、403 权限）。5xx 与网络类一律返回 false
 * —— 那种情况下服务端可能已经把数据落了，说「没写成」会让调用方去重试，而重试如果不幂等
 * 就是重复写入；即使幂等，也会把「写了 46 行」这件事从证据里抹成「一行没写」。
 *
 * 解析不出状态码时同样返回 false：**不知道就去回读，不要猜**。
 */
export function writeFailureIsCertain(message) {
  const text = String(message ?? '');
  if (isFeishuAuthError(text)) return true;
  const status = Number((/Feishu API failed:\s*(\d{3})/u.exec(text) ?? [])[1]);
  if (!Number.isFinite(status)) return false;
  return status >= 400 && status < 500;
}

/**
 * 逐批写入，并把「已确认写入的 id」立刻交给 `flush` 落盘。
 *
 * `receipt.recordIds` 会被**原地**累积（调用方传同一个对象进去，它负责把对象写出去）。
 * 收据里「按表分块」的写法（推广日报的 `receipt.tables[kind]`）用 `target` 指定累积到哪一块 ——
 * 不给 `target` 就是累积到 `receipt` 自己。
 *
 * 出错时把 `writeError` 记进**被累积的那个对象**、落盘、再原样抛出 —— 退出码由调用方按
 * `writeFailureIsCertain()` 决定，这里不替它拍板。
 *
 * 返回 `{ ids, batches, failed }`（正常路径 `failed` 为 false）。
 */
export async function batchCreateWithLedger({ client, records = [], receipt = null, flush, target = null, batchSize = WRITE_BATCH_SIZE }) {
  if (!client || typeof client.batchCreateRecords !== 'function') {
    throw new Error('batchCreateWithLedger 需要一个有 batchCreateRecords 的 client');
  }
  const bag = target ?? receipt;
  if (!bag || typeof bag !== 'object') throw new Error('batchCreateWithLedger 需要收据对象（原地累积 recordIds）');
  if (typeof flush !== 'function') throw new Error('batchCreateWithLedger 需要 flush()');

  // 多个 base 分组共用一份收据时，`recordIds` 必须是**同一个数组**被逐批往后追加 ——
  // 所以已存在就复用，绝不重置（重置会让第二组的落盘把第一组已确认的行抹掉）。
  if (!Array.isArray(bag.recordIds)) bag.recordIds = [];
  const ids = bag.recordIds;
  bag.writeStarted = true;
  bag.plannedWriteRows = (Number(bag.plannedWriteRows) || 0) + records.length;
  // ① 草稿先落地：即使第一批就炸，也有文件说明「这一趟打算写多少行」。
  flush();

  let batches = 0;
  try {
    for (let i = 0; i < records.length; i += batchSize) {
      const slice = records.slice(i, i + batchSize);
      const created = await client.batchCreateRecords(slice);
      ids.push(...created);
      batches += 1;
      // ② 每批成功立刻落盘（不是「全部写完再落」）。
      bag.writeBatches = batches;
      flush();
    }
  } catch (error) {
    bag.writeError = String(error?.message ?? error);
    bag.writeBatches = batches;
    bag.writeFailureCertain = writeFailureIsCertain(bag.writeError);
    flush();
    throw error;
  }
  return { ids, batches, failed: false };
}
