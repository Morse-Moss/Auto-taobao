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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const HOST = path.join(HERE, 'run-collection-host.mjs');
const MERGER = path.join(PROJECT_ROOT, 'skills/xws-export-market-analysis/scripts/merge-market-analysis.mjs');
const NOTIFY_CLI = path.join(HERE, 'notify-feishu.mjs');

const STDOUT_FILE = path.join(HERE, '.collect-stdout.log');
const DRIVER_LOG = path.join(HERE, '.weekly-collection.log');

const VALUE_OPTIONS = new Map([
  ['--ranges', 'ranges'],
  ['--output-dir', 'outputDir'],
  ['--checkpoint-prefix', 'checkpointPrefix'],
  ['--proxy', 'proxy'],
  ['--label', 'label'],
  ['--pages-total', 'pagesTotal'],
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
  const options = { notify: false, label: '浴缸竞品周采集', pagesTotal: 40 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--notify') { options.notify = true; continue; }
    if (a === '--dry-run') { options.notify = false; continue; }
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

// 段内产物从 ADAPTIVE_DONE 那行拿。它由采集器自己打到 stdout（也**只**打 stdout），
// 内容是 { event, runId, checkpoint, final }，final 里带 csv/xlsx 的落地路径。
export function lastAdaptiveDone(logText) {
  const matches = String(logText ?? '').match(/\{"event":"ADAPTIVE_DONE"[^\n]*/gu);
  if (!matches?.length) return null;
  try { return JSON.parse(matches.at(-1)); } catch { return null; }
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
      '--label', `${options.label} 第 ${range.id} 页段`,
      ...(options.notify ? ['--notify'] : ['--dry-run']),
    ];
    const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function main() {
  const options = parseDriverArgs(process.argv.slice(2));
  writeFileSync(DRIVER_LOG, '');
  log(`周采集驱动启动 ranges=${options.ranges.map((r) => r.id).join(',')} 投递=${options.notify ? '飞书' : 'dry-run'}`);

  const collected = [];
  const failures = [];
  for (const range of options.ranges) {
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
  }

  const receipt = {
    version: 'weekly-collection-receipt-v1',
    at: new Date().toISOString(),
    ranges: options.ranges.map((r) => r.id),
    notify: options.notify ? 'feishu' : 'dry-run',
    collected,
    failures,
  };

  if (!collected.length) {
    log('没有任何一段产出可用产物，不合并。');
    writeFileSync(path.join(HERE, '.weekly-collection-receipt.json'), JSON.stringify(receipt, null, 2));
    process.exit(1);
  }

  const mergedCsv = path.join(HERE, `weekly-merged-${Date.now()}.csv`);
  const mergedXlsx = mergedCsv.replace(/\.csv$/u, '.xlsx');
  const mergeArgs = [];
  for (const part of collected) mergeArgs.push('--csv', part.csv);
  mergeArgs.push('--output-csv', mergedCsv);
  for (const part of collected) mergeArgs.push('--xlsx', part.xlsx);
  mergeArgs.push('--output-xlsx', mergedXlsx, '--require-images');
  log(`合并 ${collected.length} 段 → ${mergedXlsx}`);
  const merge = spawnSync(process.execPath, [MERGER, ...mergeArgs], { cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
  const mergeJson = String(merge.stdout || '').trim().split(/\r?\n/u).filter(Boolean).at(-1) ?? '';
  const mergedOk = merge.status === 0 && /"ok":\s*true/u.test(mergeJson);
  log(`合并 ${mergedOk ? '成功' : '失败'}：${mergedOk ? mergeJson.slice(0, 300) : String(merge.stderr || merge.stdout).slice(0, 400)}`);

  Object.assign(receipt, { merged: { ok: mergedOk, csv: mergedCsv, xlsx: mergedOk ? mergedXlsx : null } });
  writeFileSync(path.join(HERE, '.weekly-collection-receipt.json'), JSON.stringify(receipt, null, 2));

  // 收尾告警：真发飞书时把「覆盖了哪些段、缺了哪些段、产物在哪」一次讲清。
  const alert = {
    severity: failures.length ? 'ERROR' : 'INFO',
    title: failures.length
      ? `竞品周采集部分失败：${options.label}`
      : `竞品周采集完成：${options.label}`,
    source: { targetLabel: options.label, capability: 'xws.export.market-analysis' },
    reason: `成功 ${collected.length}/${options.ranges.length} 段；失败段：${failures.map((f) => `${f.range}（${f.reason}）`).join('、') || '无'}`,
    action: failures.length ? '查看 .weekly-collection-receipt.json 与各段 checkpoint，重跑失败段' : '可继续建周表与导入',
    evidence: { ranges: receipt.ranges.join(','), mergedXlsx: receipt.merged.xlsx ?? '', failures: failures.map((f) => f.range) },
    createdAt: new Date().toISOString(),
    alertId: `weekly-collect-${Date.now()}`,
  };
  const payload = JSON.stringify(alert);
  if (!options.notify) {
    log(`DRY-RUN 收尾告警：${payload.slice(0, 400)}`);
  } else {
    const sent = spawnSync(process.execPath, [NOTIFY_CLI], { input: payload, cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 60_000 });
    log(`收尾告警投递退出码=${sent.status}：${String(sent.stdout || sent.stderr).slice(0, 300)}`);
  }

  process.exit(failures.length || !mergedOk ? 1 : 0);
}

main().catch((error) => {
  log(`fatal: ${error.message}`);
  process.exit(1);
});
