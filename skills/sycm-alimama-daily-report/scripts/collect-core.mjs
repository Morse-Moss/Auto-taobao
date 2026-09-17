// 日报链「采集段」的纯函数：挑新下载的文件、认下载任务名、校验统计区间含目标日。
//
// 为什么要单独拎出来（2026-09-17）：采集段一直是**操作步骤**（SOP §3/§4 里写的点击路径），
// 现场靠 %Temp% 下的临时脚本点，没有仓库内的实现。对客户演示来说这是最容易出纰漏的一环：
// 临时脚本会被清理、参数写死、失败时只留一句沉默。收编时把「判断」与「点页面」分开 ——
// 判断留在本模块（可离线单测），点页面留在线脚本里（浏览器里现跑）。
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// 生意参谋店铺报表与阿里妈妈推广报表的文件名形状（实测）。
export const SHOP_REPORT_PATTERN = /^日报_\d{8}_[0-9a-f]+(?: \(\d+\))?\.xlsx$/u;
export const PROMOTION_ZIP_PATTERN = /^营销场景报表_\d{8}_\d{6}(?: \(\d+\))?\.zip$/u;
// 下载任务在「下载任务管理」里的行名（不含后缀）。
export const PROMOTION_TASK_PATTERN = /^营销场景报表_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/u;

// 浏览器的默认下载目录。写死在仓库里会把别人的机器路径带进来，所以从环境变量推。
export function defaultDownloadsDir(env = process.env) {
  const home = env.USERPROFILE || env.HOME;
  if (!home) throw new Error('cannot derive the downloads directory: set USERPROFILE/HOME or pass --downloads');
  return path.join(home, 'Downloads');
}

export function listDownloads(dir, pattern) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    throw new Error(`cannot read downloads directory ${dir}: ${error.message}`);
  }
  return names
    .filter((name) => pattern.test(name))
    .map((name) => {
      // 「大小 + mtime」是本函数唯一的判据来源；读不到 stat 的条目直接不算候选（假文件不进候选集）。
      const stat = statSync(path.join(dir, name), { throwIfNoEntry: false });
      return stat ? { name, size: stat.size, mtimeMs: stat.mtimeMs } : null;
    })
    .filter(Boolean);
}

// 「点击前记一份名单 → 点击后只认名单里没有的」——判据取文件系统，不取页面上的按钮状态。
// 页面说「生成成功」不等于文件落到了磁盘；反过来，页面卡在旧状态时文件也可能已经下来了。
//
// 两边都是**文件名数组**（不是 listDownloads 的对象）。写这条注释是因为第一版把右边按
// `entry.name` 取、左边是字符串数组，于是 `known.has(undefined)` 恒 false ——
// 过滤静默失效，「所有文件都算新的」，取件步骤会把旧 zip 当成刚下载的那一份。
export function newEntries(before, after) {
  const known = new Set(before);
  return after.filter((name) => !known.has(name));
}

// 多个新文件时取 mtime 最新的（浏览器可能一次性落两个：本体 + 临时文件）。
export function pickNewest(entries) {
  if (!entries.length) return null;
  return entries.slice().sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
}

// 从下载任务列表里认出新提交的那个：按名字里的时间戳取最大。
// 名字是可比较的（固定 6 位时间戳），所以取最大即可，不需要额外读页面的时间列。
export function newestTaskName(names, { exportDate } = {}) {
  const wanted = exportDate ? exportDate.replace(/-/gu, '') : null;
  const candidates = names
    .map((name) => name.trim())
    .filter((name) => PROMOTION_TASK_PATTERN.test(name))
    .filter((name) => !wanted || name.replace(/^营销场景报表_/u, '').startsWith(wanted));
  if (!candidates.length) return null;
  return candidates.slice().sort().at(-1);
}

// 统计区间必须**含**目标日：含不含是这一份工作簿能不能用的前提，不能靠「看起来对」。
export function dateWithinRange(range, date) {
  if (!Array.isArray(range) || range.length !== 2) throw new Error(`invalid range: ${JSON.stringify(range)}`);
  const [from, to] = range;
  for (const value of [from, to, date]) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value ?? '')) throw new Error(`invalid date in range check: ${value}`);
  }
  return from <= date && date <= to;
}

// 采集段的参数解析。两个脚本共用，差别只在有没有 `--phase`。
export function parseCollectArgs(argv, options = {}) {
  const args = { date: null, downloads: null, proxy: null, task: null, phase: null,
    timeoutMs: options.timeoutMs ?? 30000, reportId: options.reportId ?? null };
  const allowed = new Set(options.flags ?? []);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${key} requires a value`);
      return value;
    };
    if (key === '--date') args.date = next();
    else if (key === '--downloads') args.downloads = next();
    else if (key === '--proxy') args.proxy = next();
    else if (key === '--task') args.task = next();
    else if (key === '--phase') args.phase = next();
    else if (key === '--timeout-ms') args.timeoutMs = Number(next());
    else if (key === '--report-id') args.reportId = next();
    // 布尔开关：`--locate-only` → args.locateOnly。带横线的名字一律转小驼峰，
    // 免得调用方去猜 `args['locate-only']` 还是 `args.locate_only`。
    else if (allowed.has(key)) {
      const name = key.replace(/^--/u, '').replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      args[name] = true;
    } else throw new Error(`unknown argument: ${key}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(args.date ?? '')) throw new Error('missing or invalid --date (expected YYYY-MM-DD)');
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer');
  if (options.phases) {
    if (!options.phases.includes(args.phase)) {
      throw new Error(`--phase must be one of ${options.phases.join('|')} (got ${JSON.stringify(args.phase)})`);
    }
  } else if (args.phase !== null) {
    throw new Error('this script does not take --phase');
  }
  return args;
}
