// 跨轮告警去重：同一条编号的告警在时间窗内不重复发。**全仓唯一实现**。
//
// 为什么抽出来（2026-09-24）：这条判据原先只活在日报链驱动
// （`skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs`）里，于是**第二条会叫人的链**
// ——跑前登录守卫——完全没有去重。实测后果：一次预检并发 5 条同一天的告警（`sycm-login-<店>-…`），
// 而收信人只收到一片刷屏。判据写在某一个调用点旁边，就等于只有那一个调用点有判据；
// 想让「第二条链也有去重」，只能把它变成公共模块。**别再各自抄一份**：
// 抄一份的症状不是报错，而是两条链对「多久算重复」给出不同的答案。
//
// 投递链本身**不去重**（`alertId` 只是给调用方用的锚），去重只能由调用方做。
// 后果不是「多收几条」，而是收信人开始忽略这个通道 —— 而它往往是唯一会叫人动手的通道。
//
// 指纹是保险：**同一个编号、但停的地方变了**（例如从「生意参谋没切过去」变成「飞书写重复」）
// 是新信息，不该被当成重复挡掉。只有「编号相同 + 停的地方也相同」才算重复。
// 时间读不懂时**宁可发**（沉默的代价比多收一条大）。
//
// 状态文件：`runtime/alert-throttle.json`。放在 `runtime/` 下是因为那里**不进 git**
// （`.gitignore` 的 `runtime/**/*.json`），而它是本机的运行状态、不是要交付的东西。
// 名字直白写清它是什么，别让后来的人以为这是采集产物。
//
// 文件形状（2026-09-24 起支持多条编号）：
//   {
//     "alertId": "daily-round-20260924",        // ← 最近一次发送那条（顶层，向后兼容老读法）
//     "fingerprint": "SHOP_LEVEL|…",
//     "sentAt": "2026-09-24T03:00:00.000Z",
//     "byAlertId": { "<alertId>": { "fingerprint": …, "sentAt": … } }
//   }
//
// 为什么要 `byAlertId`：两条链（日报链 `daily-round-<日>`、跑前登录 `sycm-login-round-<日>`）
// 共用这一个文件，而顶层只放得下一条 ⇒ 各自覆盖对方，于是「同一天同一条只叫一次」只在
// 「上一条正好也是同编号」时才成立。顶层那三个字段保留，是为了让既有的读法
// （用例与排查脚本直接 `JSON.parse` 读顶层）继续成立 —— 改形状不该让旧读法静默读到别的东西。
// **不过期、不清理**：按 alertId 存，条目数=编号数（一天两条），不值得引入过期逻辑。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 默认状态文件（仓库根的 `runtime/alert-throttle.json`）。 */
export const ALERT_THROTTLE_FILE = path.join(path.resolve(import.meta.dirname, '..'), 'runtime/alert-throttle.json');

/**
 * 该不该发。**纯函数** —— 调用方把「上次那条记录」喂进来，它只回答发不发。
 *
 * `previous === null`（从没发过）⇒ 发。`alertId` 为空 ⇒ 发（没有编号就去重不了，宁可多发）。
 */
export function resolveAlertDedup({ previous = null, alertId = null, fingerprint = null,
  now = new Date(), windowMs = 6 * 60 * 60 * 1000 } = {}) {
  if (!alertId) return { send: true, reason: '这条告警没有编号，不去重' };
  if (!previous || previous.alertId !== alertId) return { send: true, reason: '这个编号之前没发过' };
  if (fingerprint && previous.fingerprint && previous.fingerprint !== fingerprint) {
    return { send: true, reason: '同一个编号，但这次停的地方变了 —— 算新信息' };
  }
  const ageMs = now.getTime() - new Date(previous.sentAt ?? 0).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return { send: true, reason: '上次记录的时间读不懂，宁可发' };
  if (ageMs >= windowMs) {
    return { send: true, reason: `距上次已经 ${Math.round(ageMs / 60000)} 分钟，超过窗口` };
  }
  return { send: false,
    reason: `同一条告警 ${Math.round(ageMs / 60000)} 分钟前刚发过（窗口 ${Math.round(windowMs / 3600000)} 小时），不重复发` };
}

/** 读整份状态。读不出来（文件不存在/坏 JSON）一律当「没记录过」——宁可多发。 */
export function readAlertThrottle(file = ALERT_THROTTLE_FILE) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 取**指定编号**那一条记录。这是两个调用点该用的读法（不要直接读顶层）。
 *
 * 兼容三种文件：① 新格式（有 `byAlertId`）⇒ 按编号取；② 旧格式（顶层只有一条）
 * ⇒ 顶层那条的 `alertId` 相符才认，不符就当「这个编号之前没发过」；
 * ③ 文件不存在 ⇒ `null`。
 * 第 ② 种的「不符就不认」是**必要的**：两条链共用文件，若把顶层那条别家编号的记录
 * 当成自己的 previous，去重判据会拿它比 alertId（不相等 ⇒ 发），结论虽对，
 * 但一旦将来有人把 alertId 从判据里拿掉，这里就会变成一个静默的误挡。
 */
export function readAlertThrottleEntry({ file = ALERT_THROTTLE_FILE, alertId = null } = {}) {
  const state = readAlertThrottle(file);
  if (!state || typeof state !== 'object') return null;
  const fromMap = alertId ? state.byAlertId?.[alertId] : null;
  if (fromMap && typeof fromMap === 'object') {
    return { alertId, fingerprint: fromMap.fingerprint ?? null, sentAt: fromMap.sentAt ?? null };
  }
  if (alertId && state.alertId && state.alertId !== alertId) return null;
  return state;
}

/**
 * 记一条「这个编号在某时刻发出去过」。
 *
 * 写不下去**不该影响主流程**：那只会导致多发一条，比漏发安全（所以这里吞异常）。
 * 只有真的送出去了才该调它 —— 送失败还记账，会让下一次重跑被自己的记录挡掉。
 */
export function writeAlertThrottle(entry, file = ALERT_THROTTLE_FILE) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const previous = readAlertThrottle(file) ?? {};
    const byAlertId = { ...(previous.byAlertId ?? {}) };
    if (entry?.alertId) {
      byAlertId[entry.alertId] = { fingerprint: entry.fingerprint ?? null, sentAt: entry.sentAt ?? null };
    }
    writeFileSync(file, `${JSON.stringify({ ...entry, byAlertId }, null, 2)}\n`, 'utf8');
  } catch { /* 节流状态写不下去不该影响主流程：那只会导致多发一条，比漏发安全 */ }
}
