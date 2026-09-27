import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireWorkflowLock, inspectWorkflowLock, isProcessAlive } from './workflow-lock.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sycm-lock-'));
}

function writeLock(directory, payload) {
  const file = path.join(directory, 'merchant-automation.json');
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

/** 拿一个「一定已经死了」的 pid：真起一个 node，等它退出。 */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

test('workflow lock rejects concurrent owners and releases cleanly', () => {
  const directory = tempDir();
  const first = acquireWorkflowLock('merchant-automation', 'daily-report', { directory });
  assert.equal(inspectWorkflowLock('merchant-automation', { directory }).locked, true);
  assert.throws(() => acquireWorkflowLock('merchant-automation', 'product-data', { directory }), (error) => error.code === 'WORKFLOW_LOCK_BUSY' && error.lock.owner === 'daily-report');
  assert.equal(first.staleReclaimed, false);
  first.release();
  assert.equal(inspectWorkflowLock('merchant-automation', { directory }).locked, false);
  assert.equal(inspectWorkflowLock('merchant-automation', { directory }).stale, false);
  fs.rmSync(directory, { recursive: true, force: true });
});

// 三态判据：活/死/判不了。**不能压成布尔** —— 只有 false 才允许回收。
test('process liveness answers alive / dead / unknown, and only "dead" unlocks reclaim', async () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(await deadPid()), false);
  assert.equal(isProcessAlive(0), null);
  assert.equal(isProcessAlive(undefined), null);
  assert.equal(isProcessAlive('123'), null);
});

test('a lock left by a dead process is reclaimed, and said so', async () => {
  const directory = tempDir();
  const pid = await deadPid();
  const file = writeLock(directory, { version: 1, name: 'merchant-automation', owner: 'daily-report', pid, acquiredAt: '2026-09-27T07:30:00.000Z' });
  assert.equal(inspectWorkflowLock('merchant-automation', { directory }).stale, true);
  const lock = acquireWorkflowLock('merchant-automation', 'product-data', { directory });
  assert.equal(lock.staleReclaimed, true, '回收必须留痕：静默自愈会让人以为本来就没锁');
  assert.equal(lock.reclaimedFrom.pid, pid);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).owner, 'product-data');
  lock.release();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a lock held by a live process is never reclaimed', () => {
  const directory = tempDir();
  writeLock(directory, { version: 1, name: 'merchant-automation', owner: 'daily-report', pid: process.pid });
  assert.equal(inspectWorkflowLock('merchant-automation', { directory }).stale, false);
  assert.throws(() => acquireWorkflowLock('merchant-automation', 'product-data', { directory }), (error) => error.code === 'WORKFLOW_LOCK_BUSY' && error.lock.owner === 'daily-report' && error.staleReclaimed === false);
  fs.rmSync(directory, { recursive: true, force: true });
});

// 判不了（pid 缺失/非法）＝当成活着：宁可多报一次冲突，也不放第二个进来。
test('an unjudgeable holder blocks the lock instead of being reclaimed', () => {
  const directory = tempDir();
  writeLock(directory, { version: 1, name: 'merchant-automation', owner: 'daily-report' });
  const seen = inspectWorkflowLock('merchant-automation', { directory });
  assert.equal(seen.locked, true);
  assert.equal(seen.stale, null);
  assert.throws(() => acquireWorkflowLock('merchant-automation', 'product-data', { directory }), (error) => error.code === 'WORKFLOW_LOCK_BUSY');
  fs.rmSync(directory, { recursive: true, force: true });
});

// 文件在、内容读不出来（open 与 write 之间被杀）：**不回收**，报 unreadable 交给人工。
test('an unreadable lock file is reported, not silently reclaimed', () => {
  const directory = tempDir();
  fs.writeFileSync(path.join(directory, 'merchant-automation.json'), '{"version":1,');
  const seen = inspectWorkflowLock('merchant-automation', { directory });
  assert.equal(seen.locked, true);
  assert.equal(seen.unreadable, true);
  assert.equal(seen.stale, null);
  assert.throws(() => acquireWorkflowLock('merchant-automation', 'product-data', { directory }), (error) => error.code === 'WORKFLOW_LOCK_BUSY');
  fs.rmSync(directory, { recursive: true, force: true });
});
