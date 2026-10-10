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

// e. --notify 静默丢弃要出声（2026-10-10 对抗审查 D 项）：promotion-daily 的链参数
//    不转发通知开关 —— 调用方给了 --notify 时 stdout 必须打一行醒目警告，
//    否则「失败告警会自动投递飞书」成了没人兑现过的默认预期。
//    daily-report 档链参数**会**转发 --notify/--notify-print ⇒ 不许打这行（打了就是误报）。
test('e. promotion-daily --notify ⇒ stdout 含「不转发通知开关」警告；daily-report --notify 不打这行', () => {
  withTempRoot((root) => {
    const promo = runCli(['--workflow', 'promotion-daily', '--date', '2026-10-09',
      '--batch-size', '5', '--notify', '--print', '--evidence-root', root]);
    assert.equal(promo.status, 0, `status=${promo.status} stderr=${promo.stderr}`);
    assert.match(promo.stdout, /\[notify\] 本工作流的链入口不转发通知开关，失败告警不会自动投递飞书——请以运行汇报为准/u,
      `给了 --notify 但链不转发时必须出声。实际：\n${promo.stdout}`);

    const daily = runCli(['--workflow', 'daily-report', '--date', '2026-10-09',
      '--batch-size', '5', '--notify', '--print', '--evidence-root', root]);
    assert.equal(daily.status, 0, `status=${daily.status} stderr=${daily.stderr}`);
    assert.doesNotMatch(daily.stdout, /\[notify\]/u,
      `daily-report 的链参数会转发通知开关，这行警告打了就是误报。实际：\n${daily.stdout}`);
    assert.deepEqual(readdirSync(root), [], '--print 不得落盘');
  });
});
