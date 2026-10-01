import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForDownloadEntry } from './collect-promotion-report.mjs';

test('promotion-fetch：操作行延迟显形时等待后继续', async () => {
  const reads = [
    { ok: false, reason: 'action-row-hidden' },
    { ok: false, reason: 'action-row-hidden' },
    { ok: true, rect: [10, 20, 40, 20] },
  ];
  let now = 0;
  let sleeps = 0;
  const located = await waitForDownloadEntry({ downloadEntryWaitMs: 5000 }, 'target', '任务A', {
    read: async () => reads.shift(),
    sleep: async (ms) => { sleeps += 1; now += ms; },
    now: () => now,
  });
  assert.equal(located.ok, true);
  assert.equal(located.attempts, 3);
  assert.equal(sleeps, 2);
});

test('promotion-fetch：操作行持续隐藏超过预算时 fail-closed', async () => {
  let now = 0;
  await assert.rejects(
    waitForDownloadEntry({ downloadEntryWaitMs: 800 }, 'target', '任务B', {
      read: async () => ({ ok: false, reason: 'action-row-hidden' }),
      sleep: async (ms) => { now += ms; },
      now: () => now,
    }),
    /仍找不到 任务B 的下载入口/u,
  );
});
