// 采集监督环的离线测试。判据是 fail-closed 的，所以每条"负面"分支都要有对应用例。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PHASE_BUDGETS,
  classify,
  discoverRunDir,
  isProcessAlive,
  phaseBudget,
  progressKey,
  readExitCode,
  readLatestEvent,
  readTerminalMarker,
} from './supervise-collection.mjs';

const eventInfo = (name, mtimeMs, extra = {}) => ({
  state: 'OK',
  file: 'events.jsonl',
  mtimeMs,
  lines: 1,
  event: { event: name, at: new Date(mtimeMs).toISOString(), ...extra },
});
const NOW = 1_700_000_000_000;

test('classify: 读不到事件文件时只写 UNKNOWN', () => {
  const verdict = classify({ alive: true, eventInfo: { state: 'UNKNOWN', reason: 'no events' }, now: NOW, staleSeconds: 420 });
  assert.equal(verdict.status, 'UNKNOWN');
  assert.equal(verdict.detail, 'no events');
});

test('classify: 进程活着且末事件够新是 RUNNING', () => {
  const verdict = classify({ alive: true, eventInfo: eventInfo('MARKET_ANALYSIS_OPEN', NOW - 5_000), now: NOW, staleSeconds: 420 });
  assert.equal(verdict.status, 'RUNNING');
});

test('classify: 进程活着但末事件超过阈值是 SUSPECT_STALLED', () => {
  const verdict = classify({ alive: true, eventInfo: eventInfo('COLLECTING', NOW - 421_000), now: NOW, staleSeconds: 420 });
  assert.equal(verdict.status, 'SUSPECT_STALLED');
  assert.match(verdict.detail, /421s/u);
});

test('classify: 进程已退出、退出码 0 才是 COMPLETED', () => {
  const verdict = classify({ alive: false, exitCode: 0, eventInfo: eventInfo('DONE', NOW - 1_000), now: NOW, staleSeconds: 420 });
  assert.equal(verdict.status, 'COMPLETED');
  assert.match(verdict.detail, /退出码 0/u);
});

test('classify: 末事件是 DONE 但没有退出码证据时不许判成功', () => {
  // 回归：ADAPTIVE_DONE 只打到 stdout，不进 events.jsonl。旧实现靠"末事件名"去猜成功，
  // 于是一次正常结束会被判成 FAILED。现在改为"没有退出码证据 → UNKNOWN"，既不谎报成功
  // 也不谎报失败。
  const verdict = classify({ alive: false, exitCode: null, eventInfo: eventInfo('DONE', NOW - 1_000), now: NOW, staleSeconds: 420 });
  assert.equal(verdict.status, 'UNKNOWN');
  assert.match(verdict.detail, /没有退出码证据/u);
});

test('classify: 退出码非零是 FAILED', () => {
  const verdict = classify({ alive: false, exitCode: 1, eventInfo: eventInfo('FAILED', NOW - 1_000), now: NOW, staleSeconds: 420 });
  assert.equal(verdict.status, 'FAILED');
  assert.match(verdict.detail, /退出码 1/u);
});

test('classify: 给了 stdout 文件就以终端标记为准，退出码文件缺失也能判成功', () => {
  const missing = classify({
    alive: false, exitCode: null, eventInfo: eventInfo('DONE', NOW - 1_000), now: NOW, staleSeconds: 420,
    terminalMarker: null, expectTerminalMarker: true,
  });
  assert.equal(missing.status, 'FAILED');
  assert.match(missing.detail, /没有出现 ADAPTIVE_DONE/u);
  assert.match(missing.detail, /没有退出码证据/u);

  // 回归：2026-09-15 启动器随会话被回收，退出码文件没写成，但日志里的 ADAPTIVE_DONE 还在。
  const persisted = classify({
    alive: false, exitCode: null, eventInfo: eventInfo('TARGETS_CLEANED', NOW - 1_000), now: NOW, staleSeconds: 420,
    terminalMarker: '{"event":"ADAPTIVE_DONE","runId":"x"}', expectTerminalMarker: true,
  });
  assert.equal(persisted.status, 'COMPLETED');
  assert.match(persisted.detail, /未记录退出码/u);

  const contradicting = classify({
    alive: false, exitCode: 1, eventInfo: eventInfo('TARGETS_CLEANED', NOW - 1_000), now: NOW, staleSeconds: 420,
    terminalMarker: '{"event":"ADAPTIVE_DONE","runId":"x"}', expectTerminalMarker: true,
  });
  assert.equal(contradicting.status, 'FAILED');
  assert.match(contradicting.detail, /自相矛盾/u);
});

test('discoverRunDir: 只靠一份日志就能认出运行目录', () => {
  const runtimeDir = 'D:/Retire/sycm-automation/runtime';
  const log = '{"event":"ADAPTIVE_RUN_STARTED","runId":"7292878e-ad0a-4d4f-b591-7dbb46ce35cc","start":1,"end":40}\nother line\n';
  assert.equal(discoverRunDir(log, runtimeDir), 'D:\\Retire\\sycm-automation\\runtime\\7292878e-ad0a-4d4f-b591-7dbb46ce35cc-runs');
  assert.equal(discoverRunDir('no runId here', runtimeDir), null);
  assert.equal(discoverRunDir('', runtimeDir), null);
  assert.equal(discoverRunDir(log, null), null);
  assert.equal(discoverRunDir(null, runtimeDir), null);
});

test('readExitCode: 缺文件或非法内容一律 null，不冒充 0', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xws-supervise-code-'));
  try {
    assert.equal(readExitCode(null), null);
    assert.equal(readExitCode(path.join(dir, 'missing.txt')), null);
    const bad = path.join(dir, 'bad.txt');
    writeFileSync(bad, 'not-a-number\n');
    assert.equal(readExitCode(bad), null);
    const blank = path.join(dir, 'blank.txt');
    writeFileSync(blank, '   \n');
    assert.equal(readExitCode(blank), null);
    const ok = path.join(dir, 'ok.txt');
    writeFileSync(ok, '0\n');
    assert.equal(readExitCode(ok), 0);
    writeFileSync(ok, '1\n');
    assert.equal(readExitCode(ok), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTerminalMarker: 取最后一条 ADAPTIVE_DONE，没有就是 null', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xws-supervise-stdout-'));
  try {
    const file = path.join(dir, 'stdout.log');
    writeFileSync(file, [
      '{"event":"ADAPTIVE_RUN_STARTED","runId":"r1"}',
      'noise',
      '{"event":"ADAPTIVE_DONE","runId":"r1","final":1}',
      '',
    ].join('\n'));
    assert.match(readTerminalMarker(file), /ADAPTIVE_DONE/u);
    assert.match(readTerminalMarker(file), /r1/u);

    const none = path.join(dir, 'none.log');
    writeFileSync(none, '{"event":"ADAPTIVE_RUN_STARTED"}\n');
    assert.equal(readTerminalMarker(none), null);
    assert.equal(readTerminalMarker(path.join(dir, 'absent.log')), null);
    assert.equal(readTerminalMarker(null), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readLatestEvent: 取嵌套 attempt 里最新的 events.jsonl，并按窗口排除历史 run', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xws-supervise-run-'));
  try {
    const oldDir = path.join(dir, 'attempt-1', 'a-old');
    const newDir = path.join(dir, 'attempt-2', 'a-new');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    const oldFile = path.join(oldDir, 'events.jsonl');
    const newFile = path.join(newDir, 'events.jsonl');
    writeFileSync(oldFile, '{"event":"OLD"}\n');
    writeFileSync(newFile, '{"event":"NEW","at":"2026-09-15T00:00:00.000Z"}\n');
    const past = Date.now() / 1000 - 3_600;
    utimesSync(oldFile, past, past);

    const latest = readLatestEvent(dir, 0);
    assert.equal(latest.state, 'OK');
    assert.equal(latest.event.event, 'NEW');
    assert.equal(latest.file, newFile);

    // 只看最近 30 分钟：老 run 必须被排除，读不到就只许 UNKNOWN。
    const scoped = readLatestEvent(dir, Date.now() - 30 * 60_000);
    assert.equal(scoped.state, 'OK');
    assert.equal(scoped.event.event, 'NEW');

    const tooNew = readLatestEvent(dir, Date.now() + 60_000);
    assert.equal(tooNew.state, 'UNKNOWN');

    assert.equal(readLatestEvent(path.join(dir, 'missing'), 0).state, 'UNKNOWN');

    const emptyDir = path.join(dir, 'attempt-3', 'a-empty');
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(path.join(emptyDir, 'events.jsonl'), '');
    const empty = readLatestEvent(emptyDir, 0);
    assert.equal(empty.state, 'UNKNOWN');
    assert.match(empty.reason, /empty events\.jsonl/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isProcessAlive: 当前进程活着，明显不存在的 pid 不算活着', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(Number.NaN), false);
});

test('phaseBudget: 已知阶段用自己的预算，未知阶段回落到 staleSeconds', () => {
  assert.equal(phaseBudget('MARKET_ANALYSIS_OPEN', 420), PHASE_BUDGETS.MARKET_ANALYSIS_OPEN);
  assert.equal(phaseBudget('PROGRESS', 420), PHASE_BUDGETS.PROGRESS);
  assert.equal(phaseBudget('SOME_NEW_EVENT', 420), 420);
  assert.equal(phaseBudget(undefined, 420), 420);
});

test('classify: 进程活着但停在某阶段超过该阶段预算就报疑似卡死', () => {
  // 回归：2026-09-15 settle 卡死期间，进程一直活着、事件也还在，旧判据只能说 RUNNING。
  const stalled = classify({
    alive: true, eventInfo: eventInfo('MARKET_ANALYSIS_OPEN', NOW - 50_000), now: NOW, staleSeconds: 420,
  });
  assert.equal(stalled.status, 'SUSPECT_STALLED');
  assert.equal(stalled.budgetSeconds, PHASE_BUDGETS.MARKET_ANALYSIS_OPEN);
  assert.match(stalled.detail, /MARKET_ANALYSIS_OPEN/u);

  // 同一阶段、还没到预算 → 仍然只是 RUNNING，不许把正常慢判成卡死。
  const healthy = classify({
    alive: true, eventInfo: eventInfo('MARKET_ANALYSIS_OPEN', NOW - 10_000), now: NOW, staleSeconds: 420,
  });
  assert.equal(healthy.status, 'RUNNING');
});

test('classify: 采集进度不推进时，即使事件流一直在写也报疑似卡死', () => {
  const frozen = classify({
    alive: true,
    eventInfo: eventInfo('PROGRESS', NOW - 1_000, { completedPage: 5, rows: 230 }),
    now: NOW,
    staleSeconds: 420,
    progress: { key: '5:230', silentMs: 300_000, budgetSeconds: 240 },
  });
  assert.equal(frozen.status, 'SUSPECT_STALLED');
  assert.match(frozen.detail, /5:230/u);
  assert.match(frozen.detail, /没有推进/u);

  const advancing = classify({
    alive: true,
    eventInfo: eventInfo('PROGRESS', NOW - 1_000, { completedPage: 6, rows: 276 }),
    now: NOW,
    staleSeconds: 420,
    progress: { key: '6:276', silentMs: 31_000, budgetSeconds: 240 },
  });
  assert.equal(advancing.status, 'RUNNING');
});

test('classify: 没有 PROGRESS 事件时只用阶段预算，不受进度维度影响', () => {
  const verdict = classify({
    alive: true,
    eventInfo: eventInfo('HOME_READY', NOW - 10_000),
    now: NOW,
    staleSeconds: 420,
    progress: null,
  });
  assert.equal(verdict.status, 'RUNNING');
});

test('progressKey: 只认 PROGRESS，且必须至少有一个数字字段', () => {
  assert.equal(progressKey({ event: 'PROGRESS', completedPage: 3, rows: 138 }), '3:138');
  assert.equal(progressKey({ event: 'PROGRESS', completedPage: 3 }), '3:?');
  assert.equal(progressKey({ event: 'PROGRESS', rows: 0 }), '?:0');
  assert.equal(progressKey({ event: 'PROGRESS' }), null);
  assert.equal(progressKey({ event: 'DIAGNOSTIC', completedPage: 3, rows: 138 }), null);
  assert.equal(progressKey(null), null);
});
