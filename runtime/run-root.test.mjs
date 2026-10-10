import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  REPO_ROOT,
  DEFAULT_EXTERNAL_RUN_ROOT,
  DEFAULT_RETENTION,
  resolveRunRoot,
  buildRunLayout,
  ensureRunLayout,
  writeManifest,
  legacyEvidenceRoot
} from './run-root.mjs';

// 优先级三档：--evidence-root 实参 > SYCM_RUN_ROOT 环境变量 > 机器级外部默认目录。
test('resolveRunRoot: 实参优先于环境变量', () => {
  const resolved = resolveRunRoot({ cliRoot: 'D:/x/cli-runs', envRoot: 'D:/x/env-runs' });
  assert.equal(resolved, path.resolve('D:/x/cli-runs'));
});

test('resolveRunRoot: 无实参时环境变量优先于默认目录', () => {
  const resolved = resolveRunRoot({ cliRoot: '', envRoot: 'D:/x/env-runs' });
  assert.equal(resolved, path.resolve('D:/x/env-runs'));
});

test('resolveRunRoot: 环境变量也按未传入时读 process.env.SYCM_RUN_ROOT', () => {
  const prev = process.env.SYCM_RUN_ROOT;
  process.env.SYCM_RUN_ROOT = 'D:/x/proxy-env-runs';
  try {
    assert.equal(resolveRunRoot({}), path.resolve('D:/x/proxy-env-runs'));
  } finally {
    if (prev === undefined) delete process.env.SYCM_RUN_ROOT;
    else process.env.SYCM_RUN_ROOT = prev;
  }
});

test('resolveRunRoot: 三者都空时落到机器级外部默认目录（仓库之外）', () => {
  const prev = process.env.SYCM_RUN_ROOT;
  delete process.env.SYCM_RUN_ROOT;
  try {
    const resolved = resolveRunRoot({ cliRoot: '   ', envRoot: '' });
    assert.equal(resolved, DEFAULT_EXTERNAL_RUN_ROOT);
    // 默认值必须在源码仓库之外（只断言字符串，绝不 mkdir 真实默认目录）。
    // 注意：不能用裸 startsWith(REPO_ROOT)——同级目录 sycm-automation-runs
    // 在字符串前缀上必然以仓库名开头，但路径语义上在仓库之外。
    assert.ok(!resolved.startsWith(REPO_ROOT + path.sep), `默认运行根不得位于仓库内: ${resolved}`);
    assert.notEqual(resolved, REPO_ROOT);
    // 路径语义上的「仓库之外」：relative 结果以 .. 开头（跨盘符时为绝对路径）。
    const rel = path.relative(REPO_ROOT, resolved);
    assert.ok(rel.startsWith('..') || path.isAbsolute(rel), `默认运行根必须在仓库之外: ${resolved}`);
    assert.equal(resolved, path.resolve(path.dirname(REPO_ROOT), 'sycm-automation-runs'));
  } finally {
    if (prev !== undefined) process.env.SYCM_RUN_ROOT = prev;
  }
});

test('buildRunLayout: 七个字段按 spec §7.2 结构拼路', () => {
  const layout = buildRunLayout('D:/x/runs', 'promotion-daily', '2026-10-09', 'run-001');
  const expectedRoot = path.resolve('D:/x/runs', 'promotion-daily', '2026-10-09', 'run-001');
  assert.equal(layout.root, expectedRoot);
  assert.equal(layout.receiptFile, path.join(expectedRoot, 'run-receipt.json'));
  assert.equal(layout.manifestFile, path.join(expectedRoot, 'manifest.json'));
  assert.equal(layout.logsDir, path.join(expectedRoot, 'logs'));
  assert.equal(layout.artifactsDir, path.join(expectedRoot, 'artifacts'));
  assert.equal(layout.screenshotsDir, path.join(expectedRoot, 'screenshots'));
  assert.equal(layout.downloadsDir, path.join(expectedRoot, 'downloads'));
  assert.equal(Object.keys(layout).length, 7);
});

test('buildRunLayout: workflowId 带 .. 或 / 或 \\ 直接抛错（防路径穿越）', () => {
  assert.throws(() => buildRunLayout('D:/x/runs', '..', '2026-10-09', 'r1'), /路径穿越/);
  assert.throws(() => buildRunLayout('D:/x/runs', 'a/b', '2026-10-09', 'r1'), /路径穿越/);
  assert.throws(() => buildRunLayout('D:/x/runs', 'a\\b', '2026-10-09', 'r1'), /路径穿越/);
  // targetDate / runId 同样消毒。
  assert.throws(() => buildRunLayout('D:/x/runs', 'w', '../escape', 'r1'), /路径穿越/);
  assert.throws(() => buildRunLayout('D:/x/runs', 'w', '2026-10-09', 'r/../x'), /路径穿越/);
});

test('buildRunLayout: 非法字符（含空格、中文、冒号）抛错', () => {
  assert.throws(() => buildRunLayout('D:/x/runs', 'daily report', '2026-10-09', 'r1'));
  assert.throws(() => buildRunLayout('D:/x/runs', '日报', '2026-10-09', 'r1'));
});

test('ensureRunLayout: 在 os.tmpdir 随机目录下真实创建且幂等（跑两次不抛）', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'run-root-test-'));
  try {
    const layout = buildRunLayout(tmpBase, 'promotion-daily', '2026-10-09', 'run-001');
    const returned = ensureRunLayout(layout);
    assert.equal(returned, layout);
    for (const dir of [layout.root, layout.logsDir, layout.artifactsDir, layout.screenshotsDir, layout.downloadsDir]) {
      assert.ok(fs.statSync(dir).isDirectory(), `应为目录: ${dir}`);
    }
    // 幂等：再跑一次不抛。
    ensureRunLayout(layout);
  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // 清理失败不判定用例失败，但不能让句柄泄漏中断测试。
    }
  }
});

test('writeManifest: 落盘回读深相等且默认 retention 对齐 spec §13', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'run-root-manifest-'));
  try {
    const layout = buildRunLayout(tmpBase, 'promotion-daily', '2026-10-09', 'run-001');
    ensureRunLayout(layout);
    const written = writeManifest(layout.manifestFile, {
      workflow: 'promotion-daily',
      workflowVersion: '1.0.0',
      targetDate: '2026-10-09',
      runId: 'run-001',
      mode: 'dry-run',
      notes: '单元测试'
    });
    assert.deepEqual(written.retention, DEFAULT_RETENTION);
    assert.deepEqual(written.retention, { successDays: 30, failureDays: 180, autoDelete: false });
    assert.equal(written.evidencePolicy, 'run-root-v1');

    const onDisk = JSON.parse(fs.readFileSync(layout.manifestFile, 'utf8'));
    assert.deepEqual(onDisk, written);
    assert.equal(onDisk.workflow, 'promotion-daily');
    assert.equal(onDisk.targetDate, '2026-10-09');
    assert.equal(onDisk.mode, 'dry-run');
  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // 同上：清理失败不判失败。
    }
  }
});

test('writeManifest: 显式 retention 覆盖默认值', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'run-root-manifest2-'));
  try {
    const layout = buildRunLayout(tmpBase, 'daily-report', '2026-10-09', 'run-002');
    ensureRunLayout(layout);
    const written = writeManifest(layout.manifestFile, {
      workflow: 'daily-report',
      targetDate: '2026-10-09',
      runId: 'run-002',
      retention: { successDays: 7, autoDelete: true }
    });
    assert.deepEqual(written.retention, { successDays: 7, failureDays: 180, autoDelete: true });
  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // 同上。
    }
  }
});

test('legacyEvidenceRoot: 返回仓库内旧 evidence 路径（仅兼容期读取，不搬数据）', () => {
  const legacy = legacyEvidenceRoot('2026-10-09');
  assert.equal(legacy, path.join(REPO_ROOT, 'evidence', 'batches-2026-10-09'));
  assert.ok(legacy.startsWith(path.join(REPO_ROOT, 'evidence')));
});
