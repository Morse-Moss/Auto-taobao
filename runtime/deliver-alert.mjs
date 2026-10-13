// 告警投递的**唯一公共出口**：去重判断 → 落临时文件 → 起 CLI → 只认真送出去才记账。
//
// 为什么抽这一层（2026-10-13 统一预警机制）：完成提醒要挂到四条链的收尾，而投递这件事
// 有四条硬规矩是从前一次次事故里换来的，每条链各抄一遍就等于约定它们各自漂移：
//   ① 走 `--alert-file` **不走 stdin** —— `spawn(..., { input })` 会隐式建 stdin 管道，
//      本机宿主沙箱对「给子进程管道 stdin 的同步 spawn」直接回 EBUSY（2026-09-24 四轮全灭）；
//   ② `stdio` 显式 `['ignore','pipe','pipe']` —— 默认值恰是被掐的那一形态；
//   ③ **只认真送出去才记账** —— 送失败还记账，下一次重跑会被自己的记录挡掉；
//   ④ 临时文件落 `os.tmpdir()` 并用完即删 —— 它的唯一职责是当运输工具，
//      「收信人到底看到了什么」由调用方落进自己的日志（唯一证据来源，不重复两份）。
//
// 本文件不判「该不该发这条」（那是调用方按成功/失败分支决定的事），也不构造文案
// （`runtime/alert-copy.mjs` 的职责）。它只回答：**这一条，现在，怎么出去**。

import { spawnSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readAlertThrottleEntry, resolveAlertDedup, writeAlertThrottle } from './alert-throttle.mjs';

export const NOTIFY_CLI = path.resolve(import.meta.dirname, 'notify-feishu.mjs');

/**
 * 投递一条告警。
 *
 * `action`：
 *   · `'off'`   什么都不做（没给 --notify 的默认档）；
 *   · `'print'` 只把文案交还给调用方打日志，不起进程（--notify-print 排练档）；
 *   · `'send'`  真投。
 *
 * `exec` / `throttleFile` 只为离线用例注入：真跑时一个都不传。
 *
 * 返回值统一形如 `{ delivered, suppressed, reason, receipt }`，调用方可以直接落进 summary。
 */
export function dispatchAlert({
  alert, action = 'send', log = () => {}, now = () => new Date(),
  exec = spawnSync, throttleFile = null,
} = {}) {
  if (action === 'off') return { delivered: false, suppressed: false, reason: 'off', receipt: null };
  if (!alert || typeof alert !== 'object') {
    throw new Error('dispatchAlert 需要一条告警对象（alert-copy 的构造产物）');
  }
  if (action === 'print') {
    return { delivered: false, suppressed: false, reason: 'print', receipt: null };
  }

  const verdict = resolveAlertDedup({
    previous: readAlertThrottleEntry({ file: throttleFile ?? undefined, alertId: alert.alertId }),
    alertId: alert.alertId,
    fingerprint: alert.fingerprint,
    now: now(),
  });
  if (!verdict.send) {
    log(`告警未发（去重）：${verdict.reason}（编号 ${alert.alertId ?? '无'}）`);
    return { delivered: false, suppressed: true, reason: verdict.reason, receipt: null };
  }

  const alertPath = path.join(tmpdir(), `sycm-flow-alert-${process.pid}.json`);
  writeFileSync(alertPath, JSON.stringify(alert), 'utf8');
  let result;
  try {
    result = exec(process.execPath, [NOTIFY_CLI, '--alert-file', alertPath], {
      cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    try { unlinkSync(alertPath); } catch { /* 临时文件删不掉不影响投递结论 */ }
  }
  const receipt = String(result.stdout || result.stderr || '').trim().slice(0, 300);
  log(`告警投递退出码=${result.status}：${receipt}`);
  if (result.status !== 0) {
    // 这条比失败本身更要紧：**失败已经有记录，但没人知道**。
    log('告警没送出去 —— 现在只有屏幕知道，必须有人接手（见上面的投递收据）。');
  } else {
    writeAlertThrottle({
      alertId: alert.alertId ?? null,
      fingerprint: alert.fingerprint ?? null,
      sentAt: now().toISOString(),
    }, throttleFile ?? undefined);
  }
  return { delivered: result.status === 0, suppressed: false, reason: null, receipt };
}
