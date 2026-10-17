// 写入账本（runtime/import-write-ledger.mjs）的行为用例（2026-10-17 加）。
//
// 它守的是那条在三个导入器上各犯过一次的错：**自己攒 ids、全部写完才落盘**。
// 2026-10-17 的真机形态：推广段 sales1 三家 46 行已经写进飞书，批量接口随后抛错，
// 于是 `promotion-import/sales1/` 是个空目录、主链记 exit 1、逐店重试、收据全变 plannedRows=0。
// 事后只能靠独立回读才知道真写了 46 行 —— 而收据存在的意义就是不必等干完才知道。
import test from 'node:test';
import assert from 'node:assert/strict';

import { WRITE_BATCH_SIZE, batchCreateWithLedger, writeFailureIsCertain } from './import-write-ledger.mjs';

const fakeClient = ({ rowsPerCall = 500, failAtCall = null, error = new Error('boom') } = {}) => {
  const calls = [];
  return {
    calls,
    async batchCreateRecords(slice) {
      calls.push(slice.length);
      if (failAtCall !== null && calls.length === failAtCall) throw error;
      return slice.map((_, index) => `rec-${calls.length}-${index}`);
    },
  };
};

test('逐批写入：每批成功都落盘，落盘内容逐批变长', async () => {
  const client = fakeClient();
  const receipt = {};
  const snapshots = [];
  const flush = () => snapshots.push([...receipt.recordIds]);
  const records = Array.from({ length: 1200 }, (_, i) => ({ i }));

  const result = await batchCreateWithLedger({ client, records, receipt, flush });

  assert.deepEqual(client.calls, [500, 500, 200], '分片不是 500/500/200');
  assert.equal(result.batches, 3);
  // 1 次草稿 + 3 次每批落盘
  assert.equal(snapshots.length, 4, '落盘次数不等于「草稿 + 每批各一次」');
  assert.deepEqual(snapshots[0], [], '草稿落盘时不该有已确认的行');
  assert.deepEqual(snapshots.map((s) => s.length), [0, 500, 1000, 1200],
    '落盘内容没有逐批变长 ⇒ 中途炸掉时收据里不会有「到那一刻为止写了什么」');
  assert.equal(receipt.writeBatches, 3);
  assert.equal(receipt.plannedWriteRows, 1200);
});

test('第二批炸掉：第一批已确认的行必须留在收据里（这是整件事的重点）', async () => {
  const client = fakeClient({ failAtCall: 2, error: new Error('Feishu API failed: 500 Internal') });
  const receipt = {};
  let lastSnapshot = null;
  const flush = () => { lastSnapshot = { ids: [...receipt.recordIds], error: receipt.writeError ?? null }; };
  const records = Array.from({ length: 1200 }, (_, i) => ({ i }));

  await assert.rejects(() => batchCreateWithLedger({ client, records, receipt, flush }), /500 Internal/u);

  assert.equal(receipt.recordIds.length, 500, '第一批已写入的 500 行没有留下来');
  assert.equal(receipt.writeBatches, 1);
  assert.match(receipt.writeError, /500 Internal/u);
  assert.equal(receipt.writeFailureCertain, false, '5xx 属于「可能已写入」，不许记成「确定没写成」');
  assert.equal(lastSnapshot.ids.length, 500, '抛错前没有把「已确认写入的行」刷到盘上');
});

test('确定性拒绝（403/400/429）也要把「已确认写入 0 行」写清楚，而不是不留文件', async () => {
  const client = fakeClient({ failAtCall: 1, error: new Error('Feishu API failed: 403 91403 Forbidden') });
  const receipt = {};
  const flushes = [];
  const flush = () => flushes.push(receipt.writeError ?? 'draft');
  await assert.rejects(() => batchCreateWithLedger({ client, records: [{}, {}], receipt, flush }));
  assert.equal(receipt.writeFailureCertain, true);
  assert.deepEqual(receipt.recordIds, []);
  assert.equal(flushes.length, 2, '草稿一次 + 失败一次；一次都不落盘就又会变成「没有收据」');
  assert.ok(receipt.writeStarted, '没有 writeStarted 标记 ⇒ 事后看不出「这一趟到底开没开始写」');
});

test('多组共用一个收据：后一组的落盘不许把前一组的行抹掉', async () => {
  const receipt = {};
  const flush = () => {};
  const a = { recordIds: [] };
  const b = { recordIds: [] };
  // 同一份 receipt 被两组调用，但累积到不同 target —— 各自独立
  await batchCreateWithLedger({ client: fakeClient(), records: [{}, {}], receipt, target: a, flush });
  await batchCreateWithLedger({ client: fakeClient(), records: [{}], receipt, target: b, flush });
  assert.equal(a.recordIds.length, 2);
  assert.equal(b.recordIds.length, 1);

  // 不传 target 时累积到 receipt 自己，且第二次调用是**追加**不是重置
  const shared = {};
  await batchCreateWithLedger({ client: fakeClient(), records: [{}, {}], receipt: shared, flush });
  await batchCreateWithLedger({ client: fakeClient(), records: [{}], receipt: shared, flush });
  assert.equal(shared.recordIds.length, 3, '第二次调用把共享 recordIds 重置了 ⇒ 前一组已确认的行被抹掉');
});

test('0 行也要落一次草稿：没有新数据本身就是结论', async () => {
  const receipt = {};
  let flushes = 0;
  await batchCreateWithLedger({ client: fakeClient(), records: [], receipt, flush: () => { flushes += 1; } });
  assert.equal(flushes, 1);
  assert.deepEqual(receipt.recordIds, []);
  assert.equal(receipt.plannedWriteRows, 0);
});

test('writeFailureIsCertain：4xx/权限＝确定没写成，5xx 与读不懂＝可能已写入', () => {
  for (const message of [
    'Feishu API failed: 403 91403 Forbidden',
    'Feishu API failed: 400 1254004 FieldNameNotFound',
    'Feishu API failed: 429 1254290 Too Many Requests',
    '无权限访问该多维表格',
  ]) assert.equal(writeFailureIsCertain(message), true, `${message} 应判为确定性拒绝`);

  for (const message of [
    'Feishu API failed: 500 1254290 Internal',
    'Feishu API failed: 502 Bad Gateway',
    'Feishu API failed: 503',
    'fetch failed',
    'socket hang up',
    '',
    null,
  ]) assert.equal(writeFailureIsCertain(message), false, `${JSON.stringify(message)} 不该被判成「确定没写成」`);
});

test('分片常量只有一处（别在三处各写一个 500）', () => {
  assert.equal(WRITE_BATCH_SIZE, 500);
});
