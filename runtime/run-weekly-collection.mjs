#!/usr/bin/env node
// 本周竞品采集驱动 —— 把「40 页带图采集」拆成若干小段依次跑，最后合成一个带图工作簿。
//
// 为什么必须分块（2026-09-15 只读核查后的结论，别再整段跑）：
//   1) 飞书「商品图片」是附件字段（type 17），导入器靠 `extract_xws_xlsx.py` 从 **xlsx 里抽内嵌图**
//      再上传换 file_token（见 skills/xws-to-feishu-base/scripts/import-runner.mjs）。
//      所以「带图」＝**必须拿到带图的 xlsx**，CSV 里的图片 URL 用不上。
//   2) 采集器整段的结算窗口是 60 分钟，但**一旦卡住转成 partial 导出，窗口只有 5 分钟**
//      （`PARTIAL_EXPORT_SETTLEMENT_MS`）。实测 878 行 + 878 张图的 xlsx 在 5 分钟里做不出来，
//      那一 part 就只剩 CSV —— 图片没了。
//   3) 段越大越容易触发卡顿，卡顿又把窗口从 60 分钟砍到 5 分钟。所以段要小。
//   ⇒ 每段 4 页（约 150 行 / 150 张图），段内正常结算用 60 分钟窗口，稳定出带图 xlsx。
//
// 本驱动自己不碰浏览器，只做三件事：按段起采集、收集每段的 final 产物、最后合并。
// 每段都复用 run-collection-host.mjs（fd 直写 + detached + 监督环），所以宿主的规矩只有一份。
//
// 用法：
//   node runtime/run-weekly-collection.mjs --ranges 1-4,5-8 --output-dir C:/Users/Administrator/Downloads \
//        --checkpoint-prefix runtime/xws-weekly-20260913 --proxy http://127.0.0.1:3457 [--notify | --dry-run]
//
// 退出码：0 = 每段都成功且合并成功；1 = 有段落失败或合并失败（收据里写清是哪一段）。

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// 全仓统一提醒词表（2026-10-13）：流程登记、完成通知构造、兜底文案、技术定位块。
import { buildFlowOkAlert, buildTechBlock, flowFallbackCopy } from './alert-copy.mjs';
// 告警去重（同一条编号在时间窗内不重复发）的唯一实现。
import { readAlertThrottleEntry, resolveAlertDedup, writeAlertThrottle } from './alert-throttle.mjs';
// 起跑前登录态预检（2026-10-14）：小旺神会话过期时，十个段会逐个跑到「点市场分析」
// 才人道中止（run4 实测：6 段全废、每段白烧 20~60 秒，且段级告警因 EBUSY 一条都没到）。
// 预检只读、撞见登录墙就让驱动停在那之前，并由预检自己发飞书叫人。
import { shouldAbortForLogin } from './xws-weekly-login-preflight.mjs';
// 版本号（技术定位块的「版本」那一行）。
import { currentVersion } from './version.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const HOST = path.join(HERE, 'run-collection-host.mjs');
const MERGER = path.join(PROJECT_ROOT, 'skills/xws-export-market-analysis/scripts/merge-market-analysis.mjs');
const NOTIFY_CLI = path.join(HERE, 'notify-feishu.mjs');
const LOGIN_PREFLIGHT = path.join(HERE, 'xws-weekly-login-preflight.mjs');

const STDOUT_FILE = path.join(HERE, '.collect-stdout.log');
const DRIVER_LOG = path.join(HERE, '.weekly-collection.log');

const VALUE_OPTIONS = new Map([
  ['--ranges', 'ranges'],
  ['--output-dir', 'outputDir'],
  ['--checkpoint-prefix', 'checkpointPrefix'],
  ['--proxy', 'proxy'],
  ['--label', 'label'],
  ['--pages-total', 'pagesTotal'],
  ['--frequency', 'frequency'],
]);

export function parseRanges(spec) {
  const ranges = String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((token) => {
    const match = /^(\d+)-(\d+)$/u.exec(token);
    if (!match) throw new Error(`ranges 里的 "${token}" 不是 START-END 形式`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!(start >= 1) || end < start) throw new Error(`ranges 里的 "${token}" 区间不合法`);
    return { id: `${start}-${end}`, start, end };
  });
  if (!ranges.length) throw new Error('--ranges is required（例如 1-4,5-8）');
  return ranges;
}

export function parseDriverArgs(argv) {
  const options = { notify: false, label: '浴缸竞品周采集', pagesTotal: 40, resume: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--notify') { options.notify = true; continue; }
    if (a === '--dry-run') { options.notify = false; continue; }
    if (a === '--resume') { options.resume = true; continue; }
    const key = VALUE_OPTIONS.get(a);
    if (!key) throw new Error(`Unknown argument: ${a}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${a} requires a value`);
    options[key] = value;
    i += 1;
  }
  for (const required of ['outputDir', 'checkpointPrefix', 'proxy']) {
    if (!options[required]) throw new Error(`--${required.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  options.ranges = parseRanges(options.ranges);
  return options;
}

// 续跑决策（纯函数）：同一轮（同 checkpoint 前缀）挂了重跑时，已采成的段直接复用，
// 不重采。判据三条，缺一条都不复用：
//   ① 显式给了 --resume（不猜意图：新一周本来就要新快照，不能因为前缀巧合就跳过）；
//   ② 上一轮的收执在，且 checkpointPrefix 与本次逐字相同（前缀就是「哪一轮」的身份）；
//   ③ 那段记录的 csv/xlsx 文件此刻仍在盘上（产物被清过就重采，不许拿不存在的路径糊弄）。
export function planResume(ranges, { resume = false, prefix = '', receipt = null, exists = existsSync } = {}) {
  if (!resume || !receipt || receipt.checkpointPrefix !== prefix) {
    return { pending: ranges, reused: [] };
  }
  const done = new Map();
  for (const part of Array.isArray(receipt.collected) ? receipt.collected : []) {
    if (part?.range) done.set(part.range, part);
  }
  const pending = [];
  const reused = [];
  for (const range of ranges) {
    const part = done.get(range.id);
    if (part && part.csv && part.xlsx && exists(part.csv) && exists(part.xlsx)) {
      reused.push({ range: range.id, csv: part.csv, xlsx: part.xlsx });
    } else {
      pending.push(range);
    }
  }
  return { pending, reused };
}

// 读上一轮的收执（读不到就返回 null：没有历史不等于出错）。
function readPreviousReceipt() {
  try {
    return JSON.parse(readFileSync(path.join(HERE, '.weekly-collection-receipt.json'), 'utf8'));
  } catch {
    return null;
  }
}

// 段内产物从 ADAPTIVE_DONE 那行拿。它由采集器自己打到 stdout（也**只**打 stdout），
// 内容是 { event, runId, checkpoint, final }，final 里带 csv/xlsx 的落地路径。
export function lastAdaptiveDone(logText) {
  const matches = String(logText ?? '').match(/\{"event":"ADAPTIVE_DONE"[^\n]*/gu);
  if (!matches?.length) return null;
  try { return JSON.parse(matches.at(-1)); } catch { return null; }
}

// 起跑前登录态预检的一步（2026-10-14）。守两条既有纪律：
//   ① EBUSY：stdio 显式 ['ignore','pipe','pipe']，绝不依赖 stdin 管道传参
//      （预检的入参全走 argv，它的告警自己走 --alert-file，本驱动不碰它 stdin）；
//   ② fail-closed 的反面是「读不到不冒充」：预检没返回可解析结论 ⇒ PREFLIGHT_UNREADABLE，
//      非阻断放行（宿主 health 与监督环在后面兜底，且它们现在的告警是通的）。
export function runLoginPreflightStep(options, { spawnImpl = spawnSync } = {}) {
  const argv = [
    LOGIN_PREFLIGHT,
    '--proxy', options.proxy,
    // 静默必须显式：驱动 dry-run 时预检也不叫人（--no-notify），否则「彩排」会真发飞书。
    ...(options.notify ? [] : ['--no-notify']),
  ];
  const result = spawnImpl(process.execPath, argv, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = String(result.stdout ?? '');
  // 预检把结论 JSON 打到 stdout（**pretty 多行**，`JSON.stringify(result, null, 2)`）。
  // 2026-10-14 活体接线验证抓到的真 bug：原实现只取最后一行 ⇒ 多行 JSON 的最后一行是 `}`，
  // 解析必失败 ⇒ LOGIN_REQUIRED 被误判成 PREFLIGHT_UNREADABLE ⇒ 驱动照样起段，
  // 登录墙前白烧一段（正是本预检要防的事）。所以先按整块试，再按最后一行试。
  const trimmed = stdout.trim();
  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    try {
      parsed = JSON.parse(trimmed.split(/\r?\n/u).filter(Boolean).at(-1) ?? '');
    } catch {
      parsed = null;
    }
  }
  if (!parsed?.status) {
    return {
      status: 'PREFLIGHT_UNREADABLE',
      reason: `预检没有返回可解析结论（exit=${result.status ?? 'null'} spawn错误=${result.error?.code ?? '-'}）：${(stdout || String(result.stderr ?? '')).slice(0, 200)}`,
    };
  }
  return parsed;
}

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  try { appendFileSync(DRIVER_LOG, text); } catch { /* 日志写不了不阻塞采集 */ }
  process.stdout.write(text);
}

function runHost(range, options) {
  const checkpoint = `${options.checkpointPrefix}.part-${range.id}.json`;
  return new Promise((resolve) => {
    const args = [
      HOST,
      // 采集器的 --pages 本身就是 START-END 形式，直接透传段区间，别再拆成两个参数。
      '--pages', range.id,
      '--output-dir', options.outputDir,
      '--checkpoint', checkpoint,
      '--proxy', options.proxy,
      // 页间等待由调用方决定：默认沿用采集器的 30-45s，用户要求更快时传 10-15s。
      // 注意 10-15s 更快但更容易触发平台节流 → 层一到层三的监督环就是用来盯这件事的。
      ...(options.frequency ? ['--frequency', options.frequency] : []),
      '--label', `${options.label} 第 ${range.id} 页段`,
      // 分段的「已完成」不单独推：十几段就是十几条轰炸，真出事时反而没人看。
      // 段级只推异常，周级由本驱动汇总一条。
      ...(options.notify ? ['--notify', '--quiet-completed'] : ['--dry-run']),
    ];
    const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

// 合并十段产物（**必须**走这里，别再内联 spawnSync）：这条链唯一被宿主沙箱掐死过的地方。
// 2026-10-15 实测复现：合并处漏写 stdio ⇒ 默认 stdio（stdin 是管道）在沙箱下 spawnSync 直接
// EBUSY ⇒ status=null、stdout/stderr 全 undefined ⇒ 十段白采、合并永远报「失败：undefined」。
// 与 1.7.1（notify）/ 1.9.2（supervise deliver）同一病根，是那两次修复漏掉的第三处调用点。
export function runMergeStep(collected, { mergedCsv, spawnImpl = spawnSync, projectRoot = PROJECT_ROOT } = {}) {
  if (!mergedCsv) throw new Error('runMergeStep: mergedCsv is required');
  const mergedXlsx = mergedCsv.replace(/\.csv$/u, '.xlsx');
  const mergeArgs = [];
  for (const part of collected) mergeArgs.push('--csv', part.csv);
  mergeArgs.push('--output-csv', mergedCsv);
  for (const part of collected) mergeArgs.push('--xlsx', part.xlsx);
  mergeArgs.push('--output-xlsx', mergedXlsx, '--require-images');
  const result = spawnImpl(process.execPath, [MERGER, ...mergeArgs], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
    // stdio 必须显式写、且 stdin 只能是 'ignore'：默认值恰是被宿主沙箱掐断的那一形态（stdin 管道）。
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = String(result.stdout || '');
  const json = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1) ?? '';
  const ok = result.status === 0 && /"ok":\s*true/u.test(json);
  return { ok, mergedCsv, mergedXlsx, json, stdout, stderr: String(result.stderr || '') };
}

async function main() {
  const options = parseDriverArgs(process.argv.slice(2));
  writeFileSync(DRIVER_LOG, '');
  log(`周采集驱动启动 ranges=${options.ranges.map((r) => r.id).join(',')} 投递=${options.notify ? '飞书' : 'dry-run'}`);

  // 起跑前登录态预检：登录墙在位就不起任何一段（run4 的教训：十段全废＋告警还没到）。
  const preflight = runLoginPreflightStep(options);
  if (shouldAbortForLogin(preflight.status)) {
    log(`登录态预检未通过，放弃起段：${preflight.status} ${preflight.reason}`);
    const receipt = {
      version: 'weekly-collection-receipt-v1',
      at: new Date().toISOString(),
      ranges: options.ranges.map((r) => r.id),
      notify: options.notify ? 'feishu' : 'dry-run',
      checkpointPrefix: options.checkpointPrefix,
      resume: options.resume ? 'on' : 'off',
      collected: [],
      failures: [{
        range: 'preflight',
        code: 2,
        csv: null,
        xlsx: null,
        reason: `登录态预检：${preflight.reason}`,
      }],
      preflight,
    };
    writeFileSync(path.join(HERE, '.weekly-collection-receipt.json'), JSON.stringify(receipt, null, 2));
    // 刻意**不发**收尾告警：预检已经把人叫到了（同一次故障两条告警就是轰炸）。
    // 预检自身是 --no-notify（dry-run）时同理：彩排不往外发任何东西。
    process.exit(1);
  }
  log(`登录态预检：${preflight.status} ${preflight.reason}`);

  const collected = [];
  const failures = [];
  const receipt = {
    version: 'weekly-collection-receipt-v1',
    at: new Date().toISOString(),
    ranges: options.ranges.map((r) => r.id),
    notify: options.notify ? 'feishu' : 'dry-run',
    checkpointPrefix: options.checkpointPrefix,
    resume: options.resume ? 'on' : 'off',
    collected,
    failures,
  };
  // 收执**逐段**落盘（不是只在结尾写）：驱动被 kill / 机器重启时不丢已采成的段，
  // 重跑时 --resume 靠它判断该跳谁。这是「挂了不用十段重采」的前提。
  const writeReceipt = () => writeFileSync(path.join(HERE, '.weekly-collection-receipt.json'), JSON.stringify(receipt, null, 2));

  const { pending, reused } = planResume(options.ranges, {
    resume: options.resume,
    prefix: options.checkpointPrefix,
    receipt: readPreviousReceipt(),
  });
  if (reused.length) {
    log(`续跑复用已采成的 ${reused.length} 段：${reused.map((r) => r.range).join(',')}`);
    for (const part of reused) collected.push({ range: part.range, csv: part.csv, xlsx: part.xlsx });
    writeReceipt();
  }

  for (const range of pending) {
    log(`--- 段 ${range.id} 开始 ---`);
    const code = await runHost(range, options);
    let done = null;
    try { done = lastAdaptiveDone(readFileSync(STDOUT_FILE, 'utf8')); } catch { /* 读不到就是没有 */ }
    const csv = done?.final?.csv?.path ?? done?.final?.csv ?? null;
    const xlsx = done?.final?.xlsx?.path ?? done?.final?.xlsx ?? null;
    const hasXlsx = Boolean(xlsx) && existsSync(xlsx);
    log(`段 ${range.id} 结束 code=${code} rows=${done?.final?.rows ?? '?'} images=${done?.final?.images ?? '?'} csv=${csv ? 'yes' : 'no'} xlsx=${hasXlsx ? 'yes' : 'no'}`);
    if (code === 0 && csv && hasXlsx) {
      collected.push({ range: range.id, csv, xlsx });
    } else {
      failures.push({ range: range.id, code, csv, xlsx, reason: code === 0 ? '产物不全（缺 csv 或带图 xlsx）' : `采集退出码 ${code}` });
    }
    receipt.at = new Date().toISOString();
    writeReceipt();
  }

  if (!collected.length) {
    log('没有任何一段产出可用产物，不合并。');
    writeReceipt();
    process.exit(1);
  }

  const mergedCsv = path.join(HERE, `weekly-merged-${Date.now()}.csv`);
  log(`合并 ${collected.length} 段 → ${mergedCsv.replace(/\.csv$/u, '.xlsx')}`);
  const mergeResult = runMergeStep(collected, { mergedCsv });
  const mergedOk = mergeResult.ok;
  log(`合并 ${mergedOk ? '成功' : '失败'}：${mergedOk ? mergeResult.json.slice(0, 300) : String(mergeResult.stderr || mergeResult.stdout).slice(0, 400)}`);

  Object.assign(receipt, { merged: { ok: mergedOk, csv: mergedCsv, xlsx: mergedOk ? mergeResult.mergedXlsx : null } });
  writeFileSync(path.join(HERE, '.weekly-collection-receipt.json'), JSON.stringify(receipt, null, 2));

  // 收尾告警（2026-10-13 统一预警机制）：**成功与失败分开**——
  //   · 成功 ⇒ 只提醒业务人员查收（纯业务、不带技术定位块），编号 `weekly-ok-<业务日>`；
  //   · 失败 ⇒ 两段式（业务第一段 + 「以下是给技术同学的定位信息」），编号 `weekly-round-<业务日>`。
  // 去重走公共模块（只认真送出去才记账）；投递走**临时文件**不走 stdin（EBUSY 教训，
  // 同日报链 2026-09-25 修：spawnSync 带 stdin 管道会 EBUSY）。
  const businessDay = (() => {
    const at = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  })();
  const throttleFile = path.join(HERE, 'alert-throttle.json');
  const merged = receipt.merged ?? {};
  const failed = Array.isArray(receipt.failures) ? receipt.failures : [];
  const alert = failed.length || !merged.ok
    ? {
      type: 'WEEKLY_ROUND_FAILED',
      severity: 'ERROR',
      title: `【周报】没收齐（${businessDay}）`,
      alertId: `weekly-round-${businessDay.replace(/-/gu, '')}`,
      fingerprint: failed.map((f) => f.range).join('|') || 'merge-failed',
      createdAt: new Date().toISOString(),
      source: { targetLabel: options.label, period: businessDay, capability: '周报' },
      reason: `${flowFallbackCopy('weekly-report').reason}缺的页段：${failed.map((f) => `${f.range}（${f.reason}）`).join('、') || '无'}。`,
      action: flowFallbackCopy('weekly-report').action,
      tech: buildTechBlock({
        evidenceDir: path.relative(PROJECT_ROOT, path.join(HERE, '.weekly-collection-receipt.json')).replaceAll('\\', '/'),
        stage: failed.map((f) => `range-${f.range}`).join(','),
        exitCode: 1,
        version: currentVersion(),
      }),
    }
    : buildFlowOkAlert({
      flow: 'weekly-report',
      date: businessDay,
      okCount: collected.length,
      total: options.ranges.length,
      tables: [{ name: '竞品采集页段', rows: collected.length }],
    });
  const dedup = resolveAlertDedup({
    previous: readAlertThrottleEntry({ file: throttleFile, alertId: alert.alertId }),
    alertId: alert.alertId, fingerprint: alert.fingerprint,
  });
  if (!options.notify) {
    log(`DRY-RUN 收尾告警：${JSON.stringify(alert).slice(0, 400)}`);
  } else if (!dedup.send) {
    log(`收尾告警未发（去重）：${dedup.reason}`);
  } else {
    const alertPath = path.join(os.tmpdir(), `weekly-collect-alert-${process.pid}.json`);
    writeFileSync(alertPath, JSON.stringify(alert), 'utf8');
    const sent = spawnSync(process.execPath, [NOTIFY_CLI, '--alert-file', alertPath], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = String(sent.stdout || sent.stderr || '').trim();
    log(`收尾告警投递退出码=${sent.status}：${out.slice(0, 300)}`);
    // 只有真送出去才记账：送失败还记账，会让下一次重跑被自己的记录挡掉。
    if (sent.status === 0 && /"status"\s*:\s*"SENT"/u.test(out)) {
      writeAlertThrottle({ alertId: alert.alertId, fingerprint: alert.fingerprint, sentAt: new Date().toISOString() }, throttleFile);
    }
  }

  process.exit(failures.length || !mergedOk ? 1 : 0);
}

// isMain 守卫（2026-10-14 加）：否则测试一 import 本模块就会带着 node --test 的 argv
// 跑 main() ⇒ parseDriverArgs 抛「--ranges is required」⇒ process.exit(1) 把测试进程带走。
// 与 xws-sku-auth-preflight / xws-weekly-login-preflight 同一形状。
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    log(`fatal: ${error.message}`);
    process.exit(1);
  });
}
