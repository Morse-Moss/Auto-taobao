#!/usr/bin/env node
// 读回轮次历史：回答「这种麻烦多久来一次」。
//
// 为什么单独一个入口，而不是塞进 round-runner 的 --stats：
//   读历史**不需要数据库、不需要浏览器、不需要登录态**。它跑的机器可以是运营自己的笔记本，
//   而 round-runner 一启动就要建运行上下文（连库、建 registry）。把「看一眼数字」绑在
//   「整套运行时能用」上，结果是这个数字在最需要它的时候（机器正出问题时）读不出来。
//
// 退出码：
//   0  正常（含「还没有任何记录」——空账本不是错误）
//   1  账本里有坏行（历史被读少了会让频率**偏低**，先修它）
//   2  参数/文件本身有问题（给了不存在的 --file 之类）
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseHistoryText, renderHistoryReport, summarizeHistory, DEFAULT_HISTORY_FILE } from './round-history.mjs';

export const REPORT_USAGE = [
  'usage: round-history-report.mjs [--days 30] [--file <p>] [--json]',
  '',
  `--file <p>   历史文件，默认 ${DEFAULT_HISTORY_FILE}`,
  '--days <n>   统计窗口天数，默认 30（按本机时钟往前推）',
  '--json       输出结构化结果（给脚本/看板用），而不是人话报告',
  '--now <iso>  用指定时刻作为「现在」（只用于复现，不用于日常）',
  '',
].join('\n');

export function parseReportArgs(argv = []) {
  const args = { days: 30, file: null, json: false, now: null, help: false };
  const valueFlags = ['--file', '--days', '--now'];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (token === '--json') { args.json = true; continue; }
    // 先认名字再看值：反过来的话 `--nope` 会报成「--nope requires a value」，
    // 而真正的问题是「这个参数根本不存在」——错的话会把人的排查方向带偏。
    if (!valueFlags.includes(token)) throw new Error(`Unknown argument: ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`);
    index += 1;
    if (token === '--file') args.file = value;
    else if (token === '--days') args.days = Number(value);
    else args.now = value;
  }
  return args;
}

export function buildReport({ text, file = null, days = 30, now = Date.now() } = {}) {
  const { entries, corrupted } = parseHistoryText(text);
  // 坏行与「时间解析不出来」的条目都不许静默：它们都会让分母变小，从而让频率看起来更低。
  const summary = summarizeHistory(entries, { now, days });
  return { summary, corrupted, file, report: renderHistoryReport(summary, { file, corrupted }) };
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const write = options.write ?? ((chunk) => process.stdout.write(chunk));
  let args;
  try {
    args = parseReportArgs(argv);
  } catch (error) {
    write(`${error?.message ?? error}\n\n${REPORT_USAGE}`);
    return 2;
  }
  if (args.help) {
    write(REPORT_USAGE);
    return 0;
  }
  if (!Number.isFinite(args.days) || args.days <= 0) {
    write(`--days must be a positive number, got ${JSON.stringify(args.days)}\n`);
    return 2;
  }
  const nowMs = args.now ? Date.parse(args.now) : Date.now();
  if (!Number.isFinite(nowMs)) {
    write(`--now is not a parseable time: ${JSON.stringify(args.now)}\n`);
    return 2;
  }

  const file = resolve(args.file ?? DEFAULT_HISTORY_FILE);
  const readText = options.readText ?? ((target) => readFileSync(target, 'utf8'));
  // 「文件不存在」与「文件存在但空」要分开说：前者多半是路径/工作目录不对（配置问题），
  // 后者才是「落点刚建好、还没跑过」。混成一句「没有记录」会把配置错误读成正常状态。
  const missing = !existsSync(file) && !options.readText;
  const text = missing ? '' : readText(file);
  const { summary, corrupted, report } = buildReport({ text, file, days: args.days, now: nowMs });

  if (args.json) {
    write(`${JSON.stringify({ file, missing, ...summary, corrupted }, null, 2)}\n`);
  } else {
    if (missing) {
      write(`历史文件还不存在：${file}\n`
        + '这通常意味着①`round-runner` 从没在这台机器上跑过，或②工作目录/路径与该机器上的不一样。\n'
        + `（默认路径是相对仓库根写的，所以请在仓库根目录下运行本命令。）\n\n`);
    }
    write(report);
  }
  return corrupted.length ? 1 : 0;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exit(2);
    });
}
