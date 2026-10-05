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

// ---------------------------------------------------------------------------
// 2026-10-05 事故族：**删除权限**不该是这条锁的判据。
//
// 现场形态：宿主安全删除代理按「本 turn 删除数超阈值」把 `unlinkSync` 整批拒掉
// （`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）⇒ 释放删不掉、锁留盘上；下一轮的回收**也是 unlink**、
// 同样被拒，还被 `try/catch` 吞成一句 `workflow lock busy`（把「回收失败」说成「别人在跑」）
// ⇒ 无人值守单点故障，实测连拦三次。
//
// 三条判据把修法钉住：① 释放删不掉也**不抛**、且写下「已释放」；② 回收删不掉也**能拿锁**；
// ③ **活人的锁，删除被拒也绝不被覆盖写抢走**（覆盖写是安全敏感的，只许在判据点头后用）。
// ---------------------------------------------------------------------------

/** 把 unlink 换成「一律 EPERM」，模拟宿主安全删除代理拦截。 */
function denyUnlink() {
  const real = fs.unlinkSync;
  fs.unlinkSync = () => {
    const error = new Error('EPERM: SAFE_DELETE_BULK_CONFIRM_REQUIRED');
    error.code = 'EPERM';
    throw error;
  };
  return () => { fs.unlinkSync = real; };
}

test('释放删不掉（权限被拒）⇒ 不抛，写成「已释放」；下一轮不依赖删除权限也能拿到锁', () => {
  const directory = tempDir();
  const file = path.join(directory, 'merchant-automation.json');
  const restore = denyUnlink();
  try {
    const lock = acquireWorkflowLock('merchant-automation', 'daily-report', { directory, onWarn: () => {} });
    assert.doesNotThrow(() => lock.release(), '它挂在 process.once(exit) 上，抛错会盖掉真实退出码');
    restore();
    // 文件还在盘上（删不掉），但它已经不是锁了。
    assert.equal(fs.existsSync(file), true);
    assert.equal(inspectWorkflowLock('merchant-automation', { directory }).locked, false);
    assert.equal(inspectWorkflowLock('merchant-automation', { directory }).released, true);
    // 关键：下一轮照样能拿到，一步都不依赖「删掉文件」这个动作。
    const next = acquireWorkflowLock('merchant-automation', 'product-data', { directory });
    assert.equal(next.owner, 'product-data');
    assert.equal(next.staleReclaimed, true, '接手一条已释放的锁要留痕');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).owner, 'product-data');
    next.release();
  } finally {
    restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('回收也删不掉时仍然能拿锁，且如实记下「没删掉」（不许假装删了）', async () => {
  const directory = tempDir();
  const pid = await deadPid();
  writeLock(directory, { version: 1, name: 'merchant-automation', owner: 'daily-report', pid });
  const restore = denyUnlink();
  try {
    const lock = acquireWorkflowLock('merchant-automation', 'product-data', { directory });
    assert.equal(lock.staleReclaimed, true);
    assert.equal(lock.reclaimedFrom.pid, pid);
    assert.equal(lock.reclaimedFrom.deleted, false, '删不掉要如实记，别报成删了');
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'merchant-automation.json'), 'utf8')).owner, 'product-data');
  } finally {
    restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('活人的锁：即使 unlink 被拒也绝不被覆盖写抢走', () => {
  const directory = tempDir();
  const file = path.join(directory, 'merchant-automation.json');
  writeLock(directory, { version: 1, name: 'merchant-automation', owner: 'daily-report', pid: process.pid });
  let unlinkCalls = 0;
  const real = fs.unlinkSync;
  fs.unlinkSync = (...args) => { unlinkCalls += 1; return real(...args); };
  try {
    assert.throws(() => acquireWorkflowLock('merchant-automation', 'product-data', { directory }),
      (error) => error.code === 'WORKFLOW_LOCK_BUSY' && error.lock.owner === 'daily-report');
  } finally {
    fs.unlinkSync = real;
  }
  assert.equal(unlinkCalls, 0, '判据没点头就不该去删 —— 更不该覆盖写');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).owner, 'daily-report', '活人的锁必须原样留着');
  fs.rmSync(directory, { recursive: true, force: true });
});
