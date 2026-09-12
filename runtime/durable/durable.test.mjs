// S1 耐久闭环故障注入验收：全部使用真实 PostgreSQL（xws-adaptive-postgres），
// 崩溃用真实子进程退出注入——不用内存模拟（设计文档 8.3/10：进程内模拟不计入验收）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DurableState } from './state.mjs';
import { executeShard, recoverRun } from './controller.mjs';

const ENV_URL = readFileSync('E:/小红书/.env.local', 'utf8').match(/XWS_DATABASE_URL=(.*)/u)[1].trim();
const { Pool } = await import('pg');
const pool = new Pool({ connectionString: ENV_URL });
const state = new DurableState(pool);

const usedRuns = [];

function makeRun(targetEnd = 40) {
  const runId = randomUUID();
  usedRuns.push(runId);
  return { runId, identity: { tenant: 'test', platform: 'xws', keyword: '浴缸' }, targetEnd };
}

function okValidator() {
  return async (artifact) => ({ ok: true, reasons: [] });
}

const CHILD_SCRIPT = join(import.meta.dirname, 'crash-child.mjs');

test('S1 正常单分片：采集→验证→幂等提交→回读→CAS→租约释放 全链路', async () => {
  const { runId } = makeRun();
  await state.createRun({ runId, identity: { platform: 'xws' }, targetEnd: 40 });
  const result = await executeShard({
    state, runId, from: 1, to: 10,
    capability: async () => ({ artifactDigest: `sha256:${randomUUID()}`, rows: 607 }),
    validator: okValidator(),
    verifyCommit: async () => ({ consistent: true }),
  });
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.cursor, 10);
  assert.equal(result.leaseReleased, true);
  const run = await state.getRun(runId);
  assert.equal(run.verified_cursor, 10);
  assert.equal(run.execution_status, 'RUNNING');
});

test('S1 故障注入：真实子进程在 commit-before-cursor 崩溃 → 恢复补 CAS，无重复业务效果', async () => {
  const { runId } = makeRun();
  await state.createRun({ runId, identity: { platform: 'xws' }, targetEnd: 40 });

  // 真实子进程：租约 + COMMITTING 提交后立刻死（外部写入已发生、游标未推进）
  const { pathToFileURL } = await import('node:url');
  const stateUrl = pathToFileURL(join(import.meta.dirname, 'state.mjs')).href;
  const script = [
    `import { readFileSync } from 'node:fs';`,
    `const url = ${JSON.stringify(ENV_URL)};`,
    `const { Pool } = await import('pg');`,
    `const { DurableState } = await import(${JSON.stringify(stateUrl)});`,
    `const pool = new Pool({ connectionString: url });`,
    `const state = new DurableState(pool);`,
    `const runId = ${JSON.stringify(runId)};`,
    `await state.createRun({ runId, identity: { platform: 'xws' }, targetEnd: 40 });`,
    `await state.claimLease({ runId, attemptId: 'crash-attempt', owner: 'doomed-worker' });`,
    `await state.createCommit({ runId, attemptId: 'crash-attempt', from: 1, to: 10, artifactDigest: 'sha256:real-artifact' });`,
    `await state.markCommit('${runId}:1:10', 'COMMITTING');`,
    `await pool.end();`,
    `process.exit(1);`, // 模拟 commit-before-response 崩溃
  ].join('\n');
  writeFileSync(CHILD_SCRIPT, script, 'utf8');
  const child = spawn(process.execPath, [CHILD_SCRIPT], { cwd: process.cwd() });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 1, '子进程按注入剧本崩溃');

  // 模拟心跳陈旧：真实场景等心跳超时（默认 120s），测试压缩为 1.5 秒
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // 恢复：从 PG 权威状态读，不猜测
  const recovery = await recoverRun({ state, runId, verifyCommit: async () => ({ consistent: true }), heartbeatStaleSeconds: 1 });
  assert.equal(recovery.status, 'RESUMABLE');
  assert.ok(recovery.expiredLeases.some((l) => l.attempt_id === 'crash-attempt'), '死 worker 的租约被回收');
  assert.ok(recovery.reconciled.some((r) => r.commitKey === `${runId}:1:10` && r.outcome === 'VERIFIED'),
    'COMMITTING 残留对账后判 VERIFIED');
  assert.deepEqual(recovery.cursorRepaired, { from: 0, to: 10 }, '游标补 CAS 到已验证边界');
  assert.equal(recovery.resumeFrom, 11, '从下一个合法位置继续，不重采已验证页');

  // 同 key 重复提交 → 幂等，单次业务效果
  const dup = await state.createCommit({ runId, attemptId: 'other', from: 1, to: 10, artifactDigest: 'sha256:other' });
  assert.equal(dup.created, false);
  const commits = await state.listCommits(runId);
  assert.equal(commits.filter((c) => c.target === 'pages:1-10').length, 1);
});

test('S1 故障注入：验证失败 → EVIDENCE_INVALID，cursor 不推进、不提交', async () => {
  const { runId } = makeRun();
  await state.createRun({ runId, identity: { platform: 'xws' }, targetEnd: 40 });
  const result = await executeShard({
    state, runId, from: 1, to: 10,
    capability: async () => ({ artifactDigest: 'sha256:bad', rows: 3 }),
    validator: async () => ({ ok: false, reasons: ['行数 3 少于合同下限'] }),
    verifyCommit: async () => ({ consistent: true }),
  });
  assert.equal(result.status, 'EVIDENCE_INVALID');
  const run = await state.getRun(runId);
  assert.equal(run.verified_cursor, 0, '未验证数据不得推进游标');
  assert.equal((await state.listCommits(runId)).length, 0, '坏证据不得产生提交记录');
});

test('S1 故障注入：回读不一致 → COMMIT_UNKNOWN，不推进游标不写经验', async () => {
  const { runId } = makeRun();
  await state.createRun({ runId, identity: { platform: 'xws' }, targetEnd: 40 });
  const result = await executeShard({
    state, runId, from: 1, to: 10,
    capability: async () => ({ artifactDigest: 'sha256:x', rows: 100 }),
    validator: okValidator(),
    verifyCommit: async () => ({ consistent: false }),
  });
  assert.equal(result.status, 'COMMIT_UNKNOWN');
  const run = await state.getRun(runId);
  assert.equal(run.verified_cursor, 0);
  const commit = await state.getCommit(result.commitKey);
  assert.equal(commit.status, 'UNKNOWN');
});

test('S1 故障注入：租约互斥 → 第二个 worker RESOURCE_BUSY；过期后可回收再认领', async () => {
  const { runId } = makeRun();
  await state.createRun({ runId, identity: { platform: 'xws' }, targetEnd: 40 });
  const first = await state.claimLease({ runId, attemptId: 'a1', owner: 'w1', ttlSeconds: 600 });
  assert.equal(first.claimed, true);
  const second = await state.claimLease({ runId, attemptId: 'a2', owner: 'w2' });
  assert.equal(second.claimed, false, '未过期租约期间不得认领');

  // 模拟持有者死亡+租约到点：真实路径是 worker 崩溃后租约自然过期
  await pool.query(
    `UPDATE durable_attempts SET lease_expires_at = now() - interval '1 second' WHERE run_id=$1 AND attempt_id='a1'`,
    [runId],
  );
  const expired = await state.expireStaleLeases(runId);
  assert.equal(expired.length, 1);
  const third = await state.claimLease({ runId, attemptId: 'a3', owner: 'w3' });
  assert.equal(third.claimed, true, '过期租约回收后可重新认领');
});

test('S1 CAS：并发推进被拒（旧 expected 不得覆盖新游标）', async () => {
  const { runId } = makeRun();
  await state.createRun({ runId, identity: { platform: 'xws' }, targetEnd: 40 });
  assert.ok(await state.casCursor(runId, 0, 10));
  assert.equal(await state.casCursor(runId, 0, 5), null, '旧 expected CAS 必须失败');
  const run = await state.getRun(runId);
  assert.equal(run.verified_cursor, 10);
});

test.after(async () => {
  // 清理测试数据（真实库不留测试残留）
  for (const runId of usedRuns) {
    await pool.query('DELETE FROM supervisor_commit_records WHERE run_id=$1', [runId]);
    await pool.query('DELETE FROM durable_attempts WHERE run_id=$1', [runId]);
    await pool.query('DELETE FROM durable_runs WHERE run_id=$1', [runId]);
  }
  await pool.end();
});
