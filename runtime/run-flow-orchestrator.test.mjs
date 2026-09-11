import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  decideFaqStep,
  decideXwsStep,
  orchestrateFaq,
  orchestrateXws,
  orchestratorEventStream,
  main,
} from './run-flow-orchestrator.mjs';

const RUNTIME_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'run-flow-orchestrator.mjs');

function faqStatus(overrides = {}) {
  return {
    period: '2026-09-01_2026-09-07',
    status: 'IN_PROGRESS',
    nextAction: 'LOCK_TOP5',
    top5Count: 0,
    completedProducts: 0,
    rawRecords: 0,
    topicRecords: 0,
    operatorRecords: 0,
    summariesPublished: false,
    ...overrides,
  };
}

test('decideFaqStep advances safe deterministic stages', () => {
  for (const nextAction of ['LOCK_TOP5', 'BUILD_LOCAL_SNAPSHOT', 'ANALYZE_LOCAL', 'RUN_AI_REVIEW', 'BUILD_LOCAL_SUMMARIES']) {
    const step = decideFaqStep(faqStatus({ nextAction }));
    assert.equal(step.action, 'ADVANCE', nextAction);
  }
});

test('decideFaqStep stops for browser collection and human queue', () => {
  const browser = decideFaqStep(faqStatus({ nextAction: 'COLLECT_EVIDENCE' }));
  assert.equal(browser.action, 'STOP_HUMAN');
  assert.match(browser.reason, /浏览器/);
  const human = decideFaqStep(faqStatus({ nextAction: 'REVIEW_AI_HUMAN_QUEUE' }));
  assert.equal(human.action, 'STOP_HUMAN');
});

test('decideFaqStep refuses publication without explicit authorization', () => {
  const denied = decideFaqStep(faqStatus({ nextAction: 'PUBLISH_FEISHU_SUMMARIES' }));
  assert.equal(denied.action, 'STOP_AUTHORIZATION_REQUIRED');
  const allowed = decideFaqStep(faqStatus({ nextAction: 'PUBLISH_FEISHU_SUMMARIES' }), { authorizePublish: true });
  assert.equal(allowed.action, 'ADVANCE');
});

test('decideFaqStep recognizes DONE and fails closed on unknown actions', () => {
  assert.equal(decideFaqStep(faqStatus({ nextAction: 'DONE' })).action, 'DONE');
  const unknown = decideFaqStep(faqStatus({ nextAction: 'SOMETHING_ELSE' }));
  assert.equal(unknown.action, 'FAIL');
  assert.match(unknown.reason, /未知/);
  assert.equal(decideFaqStep(null).action, 'FAIL');
});

test('decideXwsStep maps supervisor outcomes', () => {
  assert.equal(decideXwsStep({ action: 'COMPLETED', runId: 'r' }).action, 'DONE');
  assert.equal(decideXwsStep({ action: 'SKIPPED', status: 'DONE', runId: 'r' }).action, 'DONE');
  assert.equal(decideXwsStep({ action: 'STOPPED', status: 'HUMAN_REQUIRED', runId: 'r' }).action, 'STOP_HUMAN');
  assert.equal(decideXwsStep({ action: 'STOPPED', status: 'FAILED', retryExhausted: true, runId: 'r' }).action, 'STOP_RETRY_EXHAUSTED');
  assert.equal(decideXwsStep({ action: 'STOPPED', status: 'STALLED', runId: 'r' }).action, 'STOP_HUMAN');
  assert.equal(decideXwsStep({ action: 'WAITING_FOR_BROWSER', runId: 'r' }).action, 'WAIT_BROWSER');
  assert.equal(decideXwsStep({ action: 'BUSY', runId: 'r' }).action, 'WAIT_BUSY');
  assert.equal(decideXwsStep({ action: 'NOT_FOUND', runId: 'missing' }).action, 'FAIL');
  assert.equal(decideXwsStep({ action: 'SPAWNED', runId: 'r' }).action, 'CONTINUE');
  assert.equal(decideXwsStep({ action: 'MYSTERY' }).action, 'FAIL');
  assert.equal(decideXwsStep(null).action, 'FAIL');
});

function fakeFaqSpawn() {
  const statusHistory = [
    faqStatus({ nextAction: 'LOCK_TOP5' }),
    faqStatus({ nextAction: 'ANALYZE_LOCAL', top5Count: 5, manifestLocked: true }),
    faqStatus({ nextAction: 'COLLECT_EVIDENCE', top5Count: 5, manifestLocked: true }),
  ];
  let call = 0;
  return async (script, args) => {
    assert.match(String(script), /run-faq-operator\.mjs$/u);
    if (args[0] === '--status') {
      const stdout = `${JSON.stringify(statusHistory[Math.min(call, statusHistory.length - 1)], null, 2)}\n`;
      return { code: 0, stdout, stderr: '' };
    }
    assert.equal(args[0], '--advance');
    call += 1;
    const advancedStatus = statusHistory[Math.min(call, statusHistory.length - 1)];
    return { code: 0, stdout: `${JSON.stringify({ advancedStage: 'runtime/run-question-library-collection.mjs', status: advancedStatus }, null, 2)}\n`, stderr: '' };
  };
}

test('orchestrateFaq advances deterministic stages and stops at browser gate', async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'orch-faq-'));
  try {
    const report = await orchestrateFaq({
      periodStart: '2026-09-01',
      periodEnd: '2026-09-07',
      runtimeRoot,
      spawn: fakeFaqSpawn(),
    });
    assert.equal(report.decision, 'STOP_HUMAN');
    assert.equal(report.top5Count, 5);
    assert.equal(report.period, '2026-09-01_2026-09-07');
    const events = (await readFile(orchestratorEventStream(runtimeRoot, 'faq', '2026-09-01_2026-09-07'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(events.length, 3);
    assert.equal(events[0].nextAction, 'LOCK_TOP5');
    assert.equal(events[0].decision, 'ADVANCE');
    assert.equal(events[1].nextAction, 'ANALYZE_LOCAL');
    assert.equal(events[2].nextAction, 'COLLECT_EVIDENCE');
    assert.equal(events[2].decision, 'STOP_HUMAN');
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('orchestrateFaq refuses publish without authorization and honors dry-run', async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'orch-faq-'));
  try {
    let advanceCalls = 0;
    const spawn = async (script, args) => {
      if (args[0] === '--advance') advanceCalls += 1;
      return { code: 0, stdout: `${JSON.stringify(faqStatus({ nextAction: 'PUBLISH_FEISHU_SUMMARIES', operatorRecords: 2023 }))}\n`, stderr: '' };
    };
    const denied = await orchestrateFaq({
      periodStart: '2026-09-01', periodEnd: '2026-09-07', runtimeRoot, spawn,
    });
    assert.equal(denied.decision, 'STOP_AUTHORIZATION_REQUIRED');
    assert.equal(advanceCalls, 0);

    const dry = await orchestrateFaq({
      periodStart: '2026-09-01', periodEnd: '2026-09-07', runtimeRoot, spawn, dryRun: true, authorizePublish: true,
      publishOptions: { masterTableId: 'M', weeklyTableId: 'W', operatorXlsx: 'ops.xlsx' },
    });
    assert.equal(dry.decision, 'DRY_RUN');
    assert.match(dry.reason, /--advance/);
    assert.match(dry.reason, /--master-table-id M/);
    assert.equal(advanceCalls, 0);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('orchestrateFaq detects a stuck receipt and stops before burning the budget', async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'orch-faq-'));
  try {
    const frozen = faqStatus({ nextAction: 'ANALYZE_LOCAL' });
    const spawn = async (script, args) => ({
      code: 0,
      stdout: args[0] === '--advance'
        ? `${JSON.stringify({ advancedStage: 'runtime/run-faq-text-analysis.mjs', status: frozen }, null, 2)}\n`
        : `${JSON.stringify(frozen)}\n`,
      stderr: '',
    });
    const report = await orchestrateFaq({
      periodStart: '2026-09-01', periodEnd: '2026-09-07', runtimeRoot, spawn, maxStages: 8,
    });
    assert.equal(report.decision, 'STOP_STUCK');
    assert.ok(report.stages < 8);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('orchestrateFaq fails loudly when the controller exits nonzero', async () => {
  await assert.rejects(
    () => orchestrateFaq({
      periodStart: '2026-09-01', periodEnd: '2026-09-07', runtimeRoot: os.tmpdir(),
      spawn: async () => ({ code: 1, stdout: '', stderr: 'boom' }),
    }),
    /boom/,
  );
});

test('orchestrateXws delegates to the supervisor and stops at human gates', async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'orch-xws-'));
  try {
    const calls = [];
    const spawn = async (script, args) => {
      calls.push(args);
      assert.match(String(script), /supervise-adaptive-export\.mjs$/u);
      if (calls.length === 1) {
        assert.deepEqual(args, ['--run-id', 'RUN-1']);
        return { code: 0, stdout: `${JSON.stringify({ action: 'SPAWNED', runId: 'RUN-1', code: 0 })}\n`, stderr: '' };
      }
      return { code: 2, stdout: `${JSON.stringify({ action: 'STOPPED', runId: 'RUN-1', status: 'HUMAN_REQUIRED', error: 'browser requires human intervention: LOGIN' })}\n`, stderr: '' };
    };
    const report = await orchestrateXws({ runId: 'RUN-1', runtimeRoot, spawn, sleep: async () => {} });
    assert.equal(report.decision, 'STOP_HUMAN');
    assert.equal(report.runId, 'RUN-1');
    assert.equal(calls.length, 2);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('orchestrateXws forwards --new collection options once and completes', async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'orch-xws-'));
  try {
    const calls = [];
    const spawn = async (script, args) => {
      calls.push(args);
      if (calls.length === 1) {
        assert.deepEqual(args, ['--new', '--keyword', '浴缸', '--pages', '1-40', '--checkpoint', 'cp.json', '--proxy', 'http://127.0.0.1:3456']);
        return { code: 0, stdout: `${JSON.stringify({ action: 'SPAWNED', runId: 'NEW-1', code: 0 })}\n`, stderr: '' };
      }
      assert.deepEqual(args, ['--run-id', 'NEW-1', '--checkpoint', 'cp.json', '--proxy', 'http://127.0.0.1:3456']);
      return { code: 0, stdout: `${JSON.stringify({ action: 'COMPLETED', runId: 'NEW-1', status: 'DONE', code: 0 })}\n`, stderr: '' };
    };
    const report = await orchestrateXws({
      create: true,
      runnerArgs: ['--keyword', '浴缸', '--pages', '1-40'],
      proxy: 'http://127.0.0.1:3456',
      checkpoint: 'cp.json',
      runtimeRoot,
      spawn,
      sleep: async () => {},
    });
    assert.equal(report.decision, 'DONE');
    assert.equal(report.runId, 'NEW-1');
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('orchestrateXws honors no-wait-busy and retry-exhausted terminal', async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'orch-xws-'));
  try {
    const busy = await orchestrateXws({
      runId: 'R', runtimeRoot, waitBusy: false, spawn: async () => ({ code: 3, stdout: `${JSON.stringify({ action: 'BUSY', runId: 'R' })}\n`, stderr: '' }),
    });
    assert.equal(busy.decision, 'STOP_BUSY');

    const exhausted = await orchestrateXws({
      runId: 'R', runtimeRoot, spawn: async () => ({ code: 1, stdout: `${JSON.stringify({ action: 'STOPPED', runId: 'R', status: 'FAILED', retryExhausted: true })}\n`, stderr: '' }),
    });
    assert.equal(exhausted.decision, 'STOP_RETRY_EXHAUSTED');
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('CLI validates flow arguments and prints help', async () => {
  await assert.rejects(() => main(['--flow', 'nope']), /--flow must be faq or xws/);
  await assert.rejects(() => main(['--flow', 'faq']), /period-start must be/);
  await assert.rejects(() => main(['--flow', 'xws']), /--run-id or --new/);
  await assert.rejects(
    () => main(['--flow', 'faq', '--period-start', '2026-09-01', '--period-end', '2026-09-07', '--authorize-publish']),
    /--authorize-publish requires/,
  );
});

test('CLI dry-run against the real completed FAQ period reports DONE without spawning advances', async (context) => {
  // This is a local smoke test against untracked runtime receipts; on a clean
  // checkout (CI) the receipts do not exist, so skip instead of failing.
  const receiptsDir = path.resolve(path.dirname(RUNTIME_SCRIPT), 'faq-analysis', '2026-08-23_2026-08-29');
  if (!existsSync(receiptsDir)) {
    context.skip('local FAQ receipts for 2026-08-23_2026-08-29 are not present');
    return;
  }
  const originalCwd = process.cwd();
  const projectRoot = path.resolve(path.dirname(RUNTIME_SCRIPT), '..');
  let report;
  try {
    process.chdir(projectRoot);
    report = await main([
      '--flow', 'faq',
      '--period-start', '2026-08-23',
      '--period-end', '2026-08-29',
      '--dry-run',
    ]);
  } finally {
    process.chdir(originalCwd);
  }
  assert.ok(report, 'dry-run should return a report');
  assert.equal(report.decision, 'DONE', 'the 2026-08-23_2026-08-29 period is complete, so the orchestrator must report DONE');
});

test('orchestrateXws parses the last JSON line when the supervisor streams child output first', async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'orch-xws-'));
  try {
    const spawn = async () => ({
      code: 0,
      stdout: '{"event":"PROGRESS","page":3}\n{"event":"PROGRESS","page":4}\n{"action":"COMPLETED","runId":"R1","status":"DONE","code":0}\n',
      stderr: '',
    });
    const report = await orchestrateXws({ runId: 'R1', runtimeRoot, spawn, sleep: async () => {} });
    assert.equal(report.decision, 'DONE');
    assert.equal(report.runId, 'R1');
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('orchestrateXws falls back to stderr JSON when stdout has none', async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'orch-xws-'));
  try {
    const spawn = async () => ({
      code: 2,
      stdout: 'progress line without json\nanother plain line\n',
      stderr: '{"status":"STALLED","error":"Xiaowangshen made no page progress before the stall threshold","action":"STOPPED","runId":"R2"}\n',
    });
    const report = await orchestrateXws({ runId: 'R2', runtimeRoot, spawn, sleep: async () => {} });
    assert.equal(report.decision, 'STOP_HUMAN');
    assert.equal(report.status, 'STALLED');
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
