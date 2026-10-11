// CLI 接线守卫（2026-10-10 加，独立验证者建）：
// 本仓三次踩过「函数级全绿但 CLI 自己没接上」的坑（--auto-repair / --defer-agent-actionable-alert /
// --relogin-on-wall 三次都是纯函数/源码扫描全绿、宿主跑起来才发现没转发）。
// 本文件的判据全部是**真实执行 `scripts/run-batches.mjs` 这个 CLI**（--print 形态：不起浏览器、
// 不写飞书、不落盘），钉住 1.8.0 架构接线的四件事实：
//   a. 未登记 workflow ⇒ 非 0 退出 + 「未登记」报错 + **没有**任何兜底执行（连计划都不打印）；
//   b. promotion-daily 不给模式 ⇒ dry-run 缺省，链命令**不含** --commit；
//   c. promotion-daily --commit ⇒ 打印转换提示 + 链命令含 --commit；
//   d. daily-report 的 --commit 开关 ⇒ 加了链命令含 --commit、不加则不含
//      （只看 chain 那一步 —— label 步骤的 --commit 是浏览器标识页旗标，不是写入旗标，不算）。
//
// 纪律（同 daily-job-plan.test.mjs 的 runHostPrint）：stdio 必须显式
// ['ignore','pipe','pipe'] —— 本机宿主沙箱对「管道 stdin 的同步 spawn」回 EBUSY（status=null），
// 会把「宿主掐断了子进程」假红成「接线断了」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'run-batches.mjs');

/** 真实执行 CLI（始终带 --print：绝不起浏览器、绝不写飞书）。 */
function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args],
    { encoding: 'utf8', cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    status: result.status,
    error: result.error,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    get out() { return `${this.stdout}\n${this.stderr}`; },
  };
}

/** 从 --print 输出里抽出 chain 那一步的命令行（含指定链文件的行）。 */
function chainLines(out, chainFile) {
  return out.split('\n').filter((l) => l.includes(chainFile));
}

/** 建一个一次性 --evidence-root（防任何意外落盘污染仓库），用完删。 */
function withTempRoot(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rb-cli-guard-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a. 未登记 workflow ⇒ 非 0 退出、报「未登记」、且没有兜底执行（连计划都不打印）', () => {
  withTempRoot((root) => {
    const r = runCli(['--workflow', 'nonexistent-xyz', '--print', '--evidence-root', root]);
    assert.notEqual(r.status, 0, `退出码必须非 0（实际 ${r.status}）error=${r.error?.message ?? 'none'}`);
    assert.match(r.out, /未登记/u, `输出必须点名「未登记」。实际：\n${r.out}`);
    // 兜底执行语义 = 打出了批次计划（哪怕只是 --print 的计划）或出现任何链入口。
    assert.doesNotMatch(r.out, /\[批次\]/u, '未登记 workflow 不许打印任何批次计划（那是兜底执行的第一步）');
    assert.doesNotMatch(r.out, /run-multi-shop-day|run-promotion-sales1/u,
      '不许出现任何链入口 —— 未登记就是立刻死，不是「换个流程继续跑」');
    // --print 不落盘自证：临时 evidence-root 里必须一个文件都没有。
    assert.deepEqual(readdirSync(root), [], '--print 不得在 evidence-root 下落任何文件');
  });
});

test('b. promotion-daily 缺省 ⇒ dry-run：链命令不含 --commit', () => {
  withTempRoot((root) => {
    const r = runCli(['--workflow', 'promotion-daily', '--date', '2026-10-09',
      '--batch-size', '5', '--print', '--evidence-root', root]);
    assert.equal(r.status, 0, `--print 没跑成：status=${r.status} error=${r.error?.message ?? 'none'} stderr=${r.stderr}`);
    assert.match(r.stdout, /模式：排练（不写飞书）/u, `缺省必须是 dry-run（排练）。实际：\n${r.stdout}`);
    const lines = chainLines(r.stdout, 'run-promotion-sales1.mjs');
    assert.ok(lines.length > 0, '计划里必须有 chain 步骤');
    for (const line of lines) {
      assert.ok(!line.includes('--commit'), `dry-run 缺省下链命令不许带 --commit。实际：${line}`);
    }
    assert.deepEqual(readdirSync(root), [], '--print 不得落盘');
  });
});

test('c. promotion-daily --commit ⇒ 打印转换提示、链命令含 --commit', () => {
  withTempRoot((root) => {
    const r = runCli(['--workflow', 'promotion-daily', '--date', '2026-10-09',
      '--batch-size', '5', '--commit', '--print', '--evidence-root', root]);
    assert.equal(r.status, 0, `--print 没跑成：status=${r.status} error=${r.error?.message ?? 'none'} stderr=${r.stderr}`);
    assert.match(r.stdout, /已转换为\s*--mode apply|--mode apply/u,
      `兼容期转换必须打印提示。实际：\n${r.stdout}`);
    const lines = chainLines(r.stdout, 'run-promotion-sales1.mjs');
    assert.ok(lines.length > 0, '计划里必须有 chain 步骤');
    assert.ok(lines.some((l) => l.includes('--commit')),
      `--commit（=apply）下链命令必须含 --commit。实际：\n${lines.join('\n')}`);
    assert.deepEqual(readdirSync(root), [], '--print 不得落盘');
  });
});

test('d. daily-report --commit 开关：加了链命令含 --commit，不加则不含（label 的 --commit 不算）', () => {
  withTempRoot((root) => {
    const withCommit = runCli(['--workflow', 'daily-report', '--date', '2026-10-09',
      '--batch-size', '5', '--commit', '--print', '--evidence-root', root]);
    assert.equal(withCommit.status, 0, `status=${withCommit.status} stderr=${withCommit.stderr}`);
    const yesLines = chainLines(withCommit.stdout, 'run-multi-shop-day.mjs');
    assert.ok(yesLines.length > 0, '计划里必须有 chain 步骤');
    assert.ok(yesLines.some((l) => l.includes('--commit')),
      `daily-report --commit 下链命令必须含 --commit。实际：\n${yesLines.join('\n')}`);

    const noCommit = runCli(['--workflow', 'daily-report', '--date', '2026-10-09',
      '--batch-size', '5', '--print', '--evidence-root', root]);
    assert.equal(noCommit.status, 0, `status=${noCommit.status} stderr=${noCommit.stderr}`);
    const noLines = chainLines(noCommit.stdout, 'run-multi-shop-day.mjs');
    assert.ok(noLines.length > 0, '计划里必须有 chain 步骤');
    for (const line of noLines) {
      assert.ok(!line.includes('--commit'),
        `daily-report 缺省（dry-run）下链命令不许带 --commit —— label 步骤的浏览器旗标不算。实际：${line}`);
    }
    assert.deepEqual(readdirSync(root), [], '--print 不得落盘');
  });
});

// e. --notify 转发（P0-2，2026-10-11 重写）：run-promotion-sales1 已认 --notify
//    （失败才投递飞书、去重、成功才记账）⇒ apply 轮链命令必须带 --notify；
//    dry-run 轮不转（没写数据不该惊动人）且 stdout 打一行说明。旧警告「本工作流的链入口
//    不转发通知开关」已随转发落地而废除——它再出现就是回退。
test('e. promotion-daily --notify：apply 轮链命令带 --notify；dry-run 轮不转且出声说明', () => {
  withTempRoot((root) => {
    const apply = runCli(['--workflow', 'promotion-daily', '--date', '2026-10-09',
      '--batch-size', '5', '--commit', '--notify', '--print', '--evidence-root', root]);
    assert.equal(apply.status, 0, `status=${apply.status} stderr=${apply.stderr}`);
    const applyLines = chainLines(apply.stdout, 'run-promotion-sales1.mjs');
    assert.ok(applyLines.length > 0, '计划里必须有 chain 步骤');
    assert.ok(applyLines.some((l) => l.includes('--notify') && l.includes('--commit')),
      `apply + --notify 下链命令必须同时含 --commit 与 --notify。实际：\n${applyLines.join('\n')}`);
    assert.doesNotMatch(apply.stdout, /本工作流的链入口不转发通知开关/u,
      '旧警告已废除（链入口现在认 --notify），它再出现就是回退。');

    const dry = runCli(['--workflow', 'promotion-daily', '--date', '2026-10-09',
      '--batch-size', '5', '--notify', '--print', '--evidence-root', root]);
    assert.equal(dry.status, 0, `status=${dry.status} stderr=${dry.stderr}`);
    const dryLines = chainLines(dry.stdout, 'run-promotion-sales1.mjs');
    for (const line of dryLines) {
      assert.ok(!line.includes('--notify'),
        `dry-run 轮链命令不许带 --notify（没写数据不该惊动人）。实际：${line}`);
    }
    assert.match(dry.stdout, /排练（dry-run）不转发 --notify/u,
      `dry-run + --notify 必须出声说明。实际：\n${dry.stdout}`);
    assert.deepEqual(readdirSync(root), [], '--print 不得落盘');
  });
});
