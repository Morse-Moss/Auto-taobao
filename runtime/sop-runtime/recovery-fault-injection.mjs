#!/usr/bin/env node
// 阶段 1 验收：跨进程恢复的故障注入（Spec 第 11 节 / 实施计划阶段 1）
//
// 真正要证明的四件事：
//   1) checkpoint 不依赖进程内 Set / 本地 JSON / 模型记忆——重启后从 PostgreSQL 权威状态恢复；
//   2) 独立杀掉持锁 worker 后，能从最后 verified cursor 继续，范围不重复也不跳号；
//   3) 恢复不重复已经确认的 CommitRecord（幂等键复用，不产生第二行业务效果）；
//   4) 被杀的 attempt 被明确记为 FAILED + lease EXPIRED，而不是留在 RUNNING 里污染对账。
//
// 默认在临时库（sop_fault_<stamp>）里跑，跑完即删；业务库 xws_automation 全程不写入。
// 用法：
//   node runtime/sop-runtime/recovery-fault-injection.mjs [--db <name>] [--keep] [--json]
// 子进程模式（由主进程拉起，不要手工调用）：
//   --child hold    --db <name> --run <runId>
//   --child recover --db <name> --run <runId>
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import pg from 'pg';

import { createPgStore } from './stores/pg-store.mjs';
import { createController } from './workflow-controller.mjs';
import { createContext } from './context-schema.mjs';
import { createSideEffectLedger } from './side-effect-ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const MIG_DIR = path.join(REPO, 'db', 'migrations');
const FORBIDDEN_DB = 'xws_automation';
const SELF = fileURLToPath(import.meta.url);

const COMMIT_KEY = 'ck-fault-shard-2';
const COMMIT_KEY_1 = 'ck-fault-shard-1';
const RUN_ID = '9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f';
const LEASE_TTL_MS = 2_000;
const IDENTITY = Object.freeze({
  tenantId: 't-fault', storeId: 's-fault', platform: 'xws',
  accountId: 'a-fault', browserProfileId: 'edge-isolated', contractVersion: '1.0.0',
});
// 临时库要跑到与业务库同一套结构：漏掉一个迁移，故障注入就会在一个「业务库不会有的旧约束」上出结论。
// 006 必须在这里：它把 supervisor_commit_records.status 的词表补齐到含 FAILED，
// 而故障注入会走 ledger.commit 的失败路径（写 FAILED），缺 006 就会在临时库里复现一个已修掉的缺陷。
const MIGRATIONS = [
  '001-supervisor-tables.sql', '002-durable-run-tables.sql', '003-durable-attempt-heartbeat.sql',
  '004-architecture-catalog.sql', '005-sop-runtime-context.sql',
  '006-commit-record-status-vocabulary.sql',
];

function parseArgs(argv) {
  const args = { db: null, keep: false, json: false, child: null, run: null };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--db') args.db = argv[++i];
    else if (t === '--keep') args.keep = true;
    else if (t === '--json') args.json = true;
    else if (t === '--child') args.child = argv[++i];
    else if (t === '--run') args.run = argv[++i];
  }
  return args;
}

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function withDatabase(url, db) {
  const parsed = new URL(url);
  parsed.pathname = `/${db}`;
  return parsed.toString();
}

function resolveBaseUrl() {
  const env = { ...loadEnv(process.env.PG_ENV_FILE || 'E:/小红书/.env.local'), ...process.env };
  const url = process.env.PG_URL || env.XWS_DATABASE_URL || env.DATABASE_URL;
  if (!url) throw new Error('未找到数据库连接串（XWS_DATABASE_URL / PG_URL / DATABASE_URL）');
  return url;
}

const STEPS = [];
function record(name, ok, detail) {
  STEPS.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function spawnChild(mode, db, runId) {
  const proc = spawn(process.execPath, [SELF, '--child', mode, '--db', db, '--run', runId], { stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child: proc, mode, stdout: '', stderr: '', receipt: null, exit: null };
  proc.stdout.on('data', (d) => {
    state.stdout += d.toString();
    const line = state.stdout.split(/\r?\n/).find((l) => l.startsWith('{'));
    if (line && !state.receipt) { try { state.receipt = JSON.parse(line); } catch { /* 等下一块数据 */ } }
  });
  proc.stderr.on('data', (d) => { state.stderr += d.toString(); });
  state.exited = new Promise((resolve) => proc.on('exit', (code, signal) => { state.exit = { code, signal }; resolve(state.exit); }));
  return state;
}

async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待超时: ${label}`);
}

// ── 子进程：持锁 worker（会被主进程 SIGKILL）─────────────────────────────
async function childHold({ db, run }) {
  const store = await createPgStore(withDatabase(resolveBaseUrl(), db));
  const controller = createController({ store, leaseTtlMs: LEASE_TTL_MS, workerId: `worker-hold-${process.pid}` });
  const context = await controller.beginAttempt(run, { stage: 'COLLECT', stepId: 'shard-2' });
  console.log(JSON.stringify({ role: 'hold', attemptId: context.attemptId, stage: context.stage, pid: process.pid, leaseStatus: context.leaseStatus }));
  // 模拟长任务执行中：只有心跳，进度只落在 PostgreSQL，不用任何进程内 Set。
  setInterval(() => { controller.heartbeat(context.attemptId).catch(() => {}); }, 300);
}

// ── 子进程：恢复者（全新进程，只依赖 PG）────────────────────────────────
async function childRecover({ db, run }) {
  const pid = process.pid;
  const store = await createPgStore(withDatabase(resolveBaseUrl(), db));
  const controller = createController({ store, leaseTtlMs: 30_000, workerId: `worker-recover-${pid}` });

  const recovery = await controller.recover(run, { leaseGraceMs: 0 });
  const resumed = await controller.beginAttempt(run, { stage: 'COLLECT', stepId: 'shard-2' });
  const committed = await store.upsertCommit({
    commitKey: COMMIT_KEY, runId: run, attemptId: resumed.attemptId,
    target: 'feishu:base/table', status: 'COMMITTED', artifactDigest: 'd'.repeat(64), businessKey: 'shard-2',
  });
  await controller.completeAttempt(run, {
    attemptId: resumed.attemptId,
    evidenceRefs: [{ uri: 'evidence/shard-2.bin', sha256: 'e'.repeat(64) }],
    nextAction: 'PREPARE_COMMIT',
  });
  await controller.markEvidenceValidated(run, { evidenceRefs: [] });
  const advanced = await controller.advanceCursor(run, { end: 20, commitRefs: [{ commitKey: COMMIT_KEY }] });
  const done = await controller.succeed(run);

  console.log(JSON.stringify({
    role: 'recover',
    pid,
    reclaimed: recovery.reclaimedAttempts,
    openBefore: recovery.openAttempts,
    cursorBefore: recovery.verifiedCursor,
    resumedAttemptId: resumed.attemptId,
    reusedCommitRecordId: committed.id ?? null,
    cursorAfter: advanced.verifiedCursor,
    executionStatus: done.executionStatus,
    evidenceStatus: done.evidenceStatus,
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.child === 'hold') return childHold(args);
  if (args.child === 'recover') return childRecover(args);

  const baseUrl = resolveBaseUrl();
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const tempDb = args.db ?? `sop_fault_${stamp}`;
  if (tempDb === FORBIDDEN_DB) throw new Error('拒绝把业务库当作故障注入目标');

  const admin = new pg.Client({ connectionString: withDatabase(baseUrl, 'postgres') });
  await admin.connect();
  const me = (await admin.query(
    `select current_user as role, r.rolsuper as superuser, r.rolcreatedb as createdb
     from pg_roles r where r.rolname = current_user`)).rows[0];
  console.log(`实际生效角色: ${me.role}  superuser=${me.superuser}  createdb=${me.createdb}`);
  if (!me.createdb && !me.superuser) throw new Error(`角色 ${me.role} 无法建临时库，故障注入需要 CREATEDB`);

  const runId = args.run ?? RUN_ID;
  let store = null;
  let hold = null;
  try {
    console.log(`\n临时库: ${tempDb}\n`);
    await admin.query(`DROP DATABASE IF EXISTS "${tempDb}"`);
    await admin.query(`CREATE DATABASE "${tempDb}"`);
    record('创建临时库', true, tempDb);

    const client = new pg.Client({ connectionString: withDatabase(baseUrl, tempDb) });
    await client.connect();
    for (const f of MIGRATIONS) await client.query(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    await client.end();
    record('迁移 001-006 应用到临时库', true, `${MIGRATIONS.length} 个文件`);

    store = await createPgStore(withDatabase(baseUrl, tempDb));
    const controller = createController({ store, leaseTtlMs: LEASE_TTL_MS, workerId: 'worker-main' });

    console.log('\n[1] 前置：第一分片已完成并落盘，游标推进到 10');
    await store.createRun({
      runId,
      identity: IDENTITY,
      context: createContext({
        taskId: 'task-fault', runId, workflow: 'xws-weekly-competitor', capability: 'xws.feishu.import',
        identity: IDENTITY, stage: 'INIT', verifiedCursor: { start: 1, end: 0, version: 0 },
      }),
      targetEnd: 20,
      lane: 't-fault/s-fault/xws/a-fault/edge-isolated/xws.feishu.import',
    });
    const first = await controller.beginAttempt(runId, { stage: 'COLLECT', stepId: 'shard-1' });
    await controller.completeAttempt(runId, { attemptId: first.attemptId, evidenceRefs: [{ uri: 'evidence/shard-1.bin', sha256: 'a'.repeat(64) }] });
    await controller.markEvidenceValidated(runId, { evidenceRefs: [] });
    await store.upsertCommit({ commitKey: COMMIT_KEY_1, runId, attemptId: first.attemptId, target: 'feishu:base/table', status: 'VERIFIED', artifactDigest: 'b'.repeat(64), businessKey: 'shard-1' });
    const afterFirst = await controller.advanceCursor(runId, { end: 10, commitRefs: [{ commitKey: COMMIT_KEY_1 }] });
    record('第一分片提交并推进游标到 10', afterFirst.verifiedCursor.end === 10, `cursor=${JSON.stringify(afterFirst.verifiedCursor)}`);

    console.log('\n[2] 子进程 A 持锁执行中被 SIGKILL');
    hold = spawnChild('hold', tempDb, runId);
    await waitFor(() => hold.receipt, { label: '持锁子进程登记 attempt' });
    record('子进程 A 已登记 attempt 并持有 lease', hold.receipt.leaseStatus === 'HELD', `pid=${hold.receipt.pid} attempt=${hold.receipt.attemptId}`);

    const runningBefore = (await store.listAttempts(runId)).filter((a) => a.status === 'RUNNING');
    record('杀掉前权威状态里存在 RUNNING attempt', runningBefore.length === 1, `RUNNING=${runningBefore.length}`);

    hold.child.kill('SIGKILL');
    await hold.exited;
    const stillRunning = (await store.listAttempts(runId)).find((a) => a.attemptId === hold.receipt.attemptId);
    record(
      '进程被杀后状态仍完整保存在 PostgreSQL（不依赖进程内状态）',
      stillRunning?.status === 'RUNNING' && stillRunning?.leaseOwner === `worker-hold-${hold.receipt.pid}`,
      `status=${stillRunning?.status} leaseOwner=${stillRunning?.leaseOwner}`,
    );

    console.log(`\n[3] 等待 lease 过期（${LEASE_TTL_MS}ms）后由新进程恢复`);
    await new Promise((resolve) => setTimeout(resolve, LEASE_TTL_MS + 500));
    const recoverChild = spawnChild('recover', tempDb, runId);
    const exit = await recoverChild.exited;
    if (!recoverChild.receipt) {
      console.error(recoverChild.stderr || recoverChild.stdout);
      throw new Error(`恢复子进程未产出回执（exit=${JSON.stringify(exit)}）`);
    }
    const receipt = recoverChild.receipt;
    record('全新进程收回过期 lease 并从权威状态恢复', receipt.reclaimed.includes(hold.receipt.attemptId), `reclaimed=${receipt.reclaimed.join(',') || '(none)'}`);
    record('恢复时读到的游标是 10（未重复、未跳号）', receipt.cursorBefore?.end === 10, `cursorBefore=${JSON.stringify(receipt.cursorBefore)}`);
    record('恢复进程使用了新的 attempt', receipt.resumedAttemptId !== hold.receipt.attemptId, `resumed=${receipt.resumedAttemptId}`);
    record('恢复后游标推进到 20', receipt.cursorAfter?.end === 20, JSON.stringify(receipt.cursorAfter));
    record('运行终态为 SUCCEEDED', receipt.executionStatus === 'SUCCEEDED', receipt.executionStatus);

    console.log('\n[4] 幂等与终态核对');
    const killed = (await store.listAttempts(runId)).find((a) => a.attemptId === hold.receipt.attemptId);
    record('被杀 attempt 记为 FAILED + lease EXPIRED', killed.status === 'FAILED' && killed.leaseState === 'EXPIRED', `status=${killed.status} lease=${killed.leaseState}`);

    const again = await store.upsertCommit({ commitKey: COMMIT_KEY, runId, attemptId: 'attempt-dup', target: 'feishu:base/table', status: 'COMMITTED' });
    const probe = new pg.Client({ connectionString: withDatabase(baseUrl, tempDb) });
    await probe.connect();
    const commitCount = (await probe.query('select count(*)::int as n from supervisor_commit_records where commit_key = $1', [COMMIT_KEY])).rows[0].n;
    const ledger = (await probe.query('select status, count(*)::int as n from supervisor_commit_records group by status order by status')).rows;
    await probe.end();
    record('重复提交同一 commit_key 不产生第二行（恢复不重复已确认 CommitRecord）', commitCount === 1 && again.id === receipt.reusedCommitRecordId, `rows=${commitCount}`);

    const finalContext = await controller.getContext(runId);
    record(
      '运行上下文与账本一致（终态 SUCCEEDED、游标 20、账本 2 条各 1 次）',
      finalContext.executionStatus === 'SUCCEEDED' && finalContext.verifiedCursor.end === 20
      && ledger.length === 2 && ledger.every((row) => row.n === 1),
      `ledger=${ledger.map((r) => `${r.status}:${r.n}`).join(',')}`,
    );

    console.log('\n[5] 账本失败路径在真实 PG 上落库（006：status 词表必须含 FAILED）');
    // 为什么必须在这一层验：内存 store 的 updateCommit 是 Object.assign(patch)，对值域不做任何校验，
    // 所以「账本写 FAILED、库约束不收」这类漂移**所有离线测试都照不到**。
    // 而它炸的位置是 handler 失败之后的记账那一步——异常穿出 ledger.commit，失败路径连收据都写不出来。
    // （2026-09-14 真实跑 sycm.feishu.weekly 发布段时踩到，见 db/migrations/006-*.sql。）
    const failLedger = createSideEffectLedger({ store });
    const { commitKey: failKey } = await failLedger.prepare({
      runId, target: 'feishu:base/table', businessKey: 'shard-fail-drill',
    });
    const failResult = await failLedger.commit({
      commitKey: failKey,
      businessKey: 'shard-fail-drill',
      handler: async () => {
        const error = new Error('确定性拒绝：调用方没备好目标');
        error.failureClass = 'POLICY_DENIED';
        throw error;
      },
    });
    record('确定性失败的提交在真实 PG 上记为 FAILED（不再抛约束异常）',
      failResult.status === 'FAILED' && failResult.failureClass === 'POLICY_DENIED',
      `status=${failResult.status} class=${failResult.failureClass}`);

    const failProbe = new pg.Client({ connectionString: withDatabase(baseUrl, tempDb) });
    await failProbe.connect();
    const failRow = (await failProbe.query(
      'select status from supervisor_commit_records where commit_key = $1', [failKey])).rows[0];
    const failAsUnknown = (await failProbe.query(
      "select count(*)::int as n from supervisor_commit_records where commit_key = $1 and status = 'UNKNOWN'", [failKey])).rows[0].n;
    await failProbe.end();
    record('FAILED 与 UNKNOWN 在库里是两个可区分的状态（重试与对账分得开）',
      failRow?.status === 'FAILED' && failAsUnknown === 0, `库里 status=${failRow?.status ?? '<none>'}`);
  } finally {
    if (hold && hold.child.exitCode === null && hold.child.signalCode === null) hold.child.kill('SIGKILL');
    if (store) await store.close().catch(() => {});
    if (!args.keep) {
      await admin.query(`DROP DATABASE IF EXISTS "${tempDb}" WITH (FORCE)`).catch(() => {});
      record('清理临时库', true, tempDb);
    } else {
      record('保留临时库（--keep）', true, tempDb);
    }
    await admin.end().catch(() => {});
  }

  const passed = STEPS.filter((s) => s.ok).length;
  const failed = STEPS.filter((s) => !s.ok);
  console.log(`\n=== 结果：${passed}/${STEPS.length} 通过 ===`);
  for (const f of failed) console.log(`  未通过: ${f.name} — ${f.detail}`);
  if (args.json) console.log(JSON.stringify({ tempDb, steps: STEPS }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(`致命错误: ${error?.stack ?? error}`);
    process.exit(2);
  });
}
