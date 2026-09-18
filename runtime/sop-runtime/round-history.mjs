// 轮次历史（只追加）：回答「这种麻烦多久来一次」。
//
// 为什么要有它 —— 起因是决定要做一件真事：给浏览器加「自动登录」（见
// docs/ops/LOGIN-RECOVERY-OPTIONS.md §3）。做不做取决于一件事实，而这件事**当时任何地方都答不了**：
// 「登录失效这类需要人到现场的事，到底多久来一次」。没有这个数字，就只能凭印象决定，
// 而印象总是偏向最近一次踩坑。
//
// 为什么既有落点都不够（2026-09-18 逐处核过，不是推测）：
//   1. `round-state.json`：`days[dayKey]` 只留一个 `lastOutcome`，`openAlert` 只有一个槽。
//      一天里发生两次不同的事，只留得下最后一次。
//   2. `durable_runs.blocker` / `human_gate_status`：是**运行行上的可变列**（`context.blocker`
//      一个对象，写一次覆盖一次），且只在「建了 run」时才有行。
//   3. 最要命的一条：**体检拦下、队列等人工这两类最常见的「需要人」根本不建 run**
//      （`WAITING_HUMAN` 路径刻意不创建运行，见 capability-scheduler 的注释）——
//      所以它们连 `durable_attempts` 里的一行都没有。用 DB 统计会把最该看见的那类漏掉。
//   4. 收据本身不落盘：`--serve` 每轮只往 stdout 打一行摘要，进程一退就没了。
//   ⇒ 结论：需要一个**追加式**落点，且它必须能记下「没建 run 的那些轮次」。
//
// 三条设计约束（都是刻意的）：
//   1. **只写不读来决策。** 这个文件不是第二份状态真相 —— 没有任何判定读它。
//      `round-state.json` 仍是「该不该跑」的唯一记忆；本文件只供人与统计脚本事后看。
//      一旦有判定开始读它，「状态」就有两份了，而且两份迟早不一致。
//   2. **落在稳定路径上**，不能落在 `workDir`。`workDir` 默认是 `runtime/sop-runtime/<prefix>-<时间戳>`
//      ——**每次起进程都是一个新目录**（见 runtime-bootstrap.mjs）。写在那里，历史会随进程重启清零，
//      而「多久来一次」恰恰需要跨重启、跨周。默认路径见 DEFAULT_HISTORY_FILE。
//   3. **不写自由文本。** 行里只有枚举、键名与结构化标识（店铺、机器、浏览器配置、告警编号）。
//      失败原文最多留 200 字并过一遍凭据遮盖。理由是这种文件会被反复复制进诊断包。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { redactSensitive } from '../notify-feishu-core.mjs';
import { needsOf } from './round-notify-policy.mjs';

export const ROUND_HISTORY_VERSION = 'round-history-v1';

// 稳定路径：点号前缀与本仓库既有的运行态约定一致（`runtime/.collect-child-pid` 等），
// 且被 .gitignore 的 `runtime/**/*.jsonl` 覆盖 —— 它是运行态，不是交付产物。
export const DEFAULT_HISTORY_FILE = 'runtime/.round-history.jsonl';

// 记哪些轮次：**过了到期闸门**的那些。
//   不记 NOT_DUE —— 定时指纹每 15 分钟醒一次，13 家店一天就是上千行纯噪声，
//     而「没到期」不是「这一轮干了什么」。
//   不记 ALREADY_DONE —— 那是「今天已经跑过」的重复醒来，同上。
// 注意这个口径与通知口径**不同**（通知只记非静默的）：历史要的是分母，
// 所以「过了闸门但体检没通过」「过了闸门但队列为空」都必须留下，否则比例的分母会偏。
export const HISTORY_SKIP_OUTCOMES = Object.freeze(['SKIPPED_NOT_DUE', 'SKIPPED_ALREADY_DONE']);

export const ROUND_HISTORY_FIELDS = Object.freeze([
  'version', 'at', 'dayKey',
  'outcome', 'reason', 'needs', 'needsKnown',
  'businessKey', 'capability', 'storeId', 'shopName', 'machine', 'browserProfile',
  'alertId', 'notifyStatus', 'notifyAction', 'notifyError',
  'healthStatus',
]);

export function shouldRecord({ outcome } = {}) {
  return !HISTORY_SKIP_OUTCOMES.includes(String(outcome ?? '').trim());
}

const asText = (value) => (value === undefined || value === null ? '' : String(value).trim());

// 写时刻的分类快照。**为什么在写入时定稿、而不是报告时现查判定表**：
// 判定表以后会被改（口径会变），而历史是「当时我们是怎么判断的」的账。
// 现查会把旧事件按新口径重算，于是同一个数字昨天的报告和今天的不一样，且没人能解释差在哪。
export function buildHistoryEntry({
  at, dayKey, outcome, reason, businessKey, capability, source = {},
  notification = null, health = null,
} = {}) {
  const resolved = needsOf(reason);
  const reasonKey = asText(reason) || null;
  return {
    version: ROUND_HISTORY_VERSION,
    at: asText(at) || null,
    dayKey: asText(dayKey) || null,
    outcome: asText(outcome) || null,
    reason: reasonKey,
    needs: reasonKey ? resolved.needs : null,
    // 区分「未细分」（判定表里显式写了 null：升级这个动作本身）与「未登记」（判定表里没有这条理由，
    // 是 fail-closed 兜住的）。两者在报告里必须分开列 —— 后者往往是漏登记，是要修的东西。
    needsKnown: reasonKey ? resolved.known === true : false,
    businessKey: asText(businessKey) || null,
    capability: asText(capability) || null,
    storeId: asText(source?.storeId) || null,
    shopName: asText(source?.shopName) || null,
    machine: asText(source?.machine) || null,
    browserProfile: asText(source?.browserProfile) || null,
    alertId: asText(notification?.alertId) || null,
    notifyStatus: asText(notification?.status) || null,
    notifyAction: asText(notification?.action) || null,
    notifyError: notification?.error ? redactSensitive(asText(notification.error)).slice(0, 200) : null,
    healthStatus: asText(health?.status) || null,
  };
}

export function createMemoryRoundHistory() {
  const written = [];
  return {
    file: null,
    written,
    async append(entry) { written.push({ ...entry }); },
  };
}

// JSONL：一行一个事件，**只追加**。选 JSONL 而不是一个大 JSON 数组，是为了让「追加」这件事
// 不需要读-改-写（那个形状在断电/并发下会丢整份历史，而它恰恰是用来诊断故障的）。
export function createFileRoundHistory(file = DEFAULT_HISTORY_FILE) {
  const path = resolve(file);
  return {
    file: path,
    async append(entry) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
    },
    async read() {
      return parseHistoryText(existsSync(path) ? readFileSync(path, 'utf8') : '');
    },
  };
}

// 坏行**不静默**：数出来并连同行号报出去。吞掉坏行的后果是「历史看起来变少了」，
// 而变少正好会让「需要人」的频率**偏低**——也就是把这次统计要回答的问题答错。
export function parseHistoryText(text) {
  const entries = [];
  const corrupted = [];
  const lines = String(text ?? '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      // 数组也是 object：不排掉它，`[1,2]` 这种半截 JSON 会被当成一条**没有 at 的记录**收下，
      // 然后以「时间解析不出来」的身份混进 undated 计数 —— 看起来像脏数据，实际是坏行。
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries.push(parsed);
      else corrupted.push({ line: index + 1, reason: Array.isArray(parsed) ? 'array, not a history line' : 'not an object' });
    } catch (error) {
      corrupted.push({ line: index + 1, reason: String(error?.message ?? error).slice(0, 120) });
    }
  }
  return { entries, corrupted };
}

const DAY_MS = 24 * 60 * 60 * 1000;

const NEEDS_BUCKETS = Object.freeze(['ONSITE', 'UPSTREAM', 'CONFIG', 'RECONCILE', 'VENDOR']);

function emptyBuckets() {
  const out = {};
  for (const key of NEEDS_BUCKETS) out[key] = 0;
  // 「未细分」（判定表写了 null）与「未登记」（表里没这条理由）必须各占一个桶：
  // 合并成一个「其他」会让漏登记长期藏在里面，而漏登记是要去补的。
  out.UNSPECIFIED = 0;
  out.UNCLASSIFIED = 0;
  return out;
}

function bucketOf(entry) {
  const needs = asText(entry?.needs);
  if (entry?.needsKnown !== true) return 'UNCLASSIFIED';
  if (!needs) return 'UNSPECIFIED';
  return NEEDS_BUCKETS.includes(needs) ? needs : 'UNCLASSIFIED';
}

// 一次「麻烦」的两种形态：
//   events      新发生（真的打扰了人一次）
//   continuing  同一起还没收掉，后续轮次被去重（DEDUPED）
// 必须分开：把 DEDUPED 也算进频率，一个登录失效拖了三天会被数成几十次，
// 于是「看起来频繁得吓人」→ 去做一个本来不必做的自动登录。这正是统计最该避免的偏差。
function isContinuation(entry) {
  return asText(entry?.notifyStatus) === 'DEDUPED';
}

export function summarizeHistory(entries, { now = Date.now(), days = 30 } = {}) {
  const until = Number(now);
  const windowDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 30;
  const since = until - windowDays * DAY_MS;

  const traced = [];
  let undated = 0;
  let outsideWindow = 0;
  for (const entry of entries ?? []) {
    const at = Date.parse(asText(entry?.at));
    if (!Number.isFinite(at)) { undated += 1; continue; }
    if (at < since || at > until) { outsideWindow += 1; continue; }
    traced.push({ entry, at });
  }

  const events = emptyBuckets();
  const continuing = emptyBuckets();
  const byDay = new Map();
  const byStore = new Map();
  const byMachine = new Map();
  const byReason = new Map();
  let eventsTotal = 0;
  let continuingTotal = 0;
  const undelivered = { FAILED: 0, NOT_CONFIGURED: 0 };

  for (const { entry } of traced) {
    const bucket = bucketOf(entry);
    const continuingThis = isContinuation(entry);
    if (continuingThis) { continuing[bucket] += 1; continuingTotal += 1; } else { events[bucket] += 1; eventsTotal += 1; }

    const dayKey = asText(entry.dayKey) || asText(entry.at).slice(0, 10);
    const day = byDay.get(dayKey) ?? { dayKey, traced: 0, events: 0, onsite: 0 };
    day.traced += 1;
    if (!continuingThis) day.events += 1;
    if (bucket === 'ONSITE' && !continuingThis) day.onsite += 1;
    byDay.set(dayKey, day);

    const storeKey = asText(entry.storeId) || (asText(entry.shopName) || '(未标注店铺)');
    const store = byStore.get(storeKey) ?? { storeId: storeKey, traced: 0, events: 0, onsite: 0 };
    store.traced += 1;
    if (!continuingThis) store.events += 1;
    if (bucket === 'ONSITE' && !continuingThis) store.onsite += 1;
    byStore.set(storeKey, store);

    const machineKey = asText(entry.machine) || '(未标注机器)';
    const machine = byMachine.get(machineKey) ?? { machine: machineKey, traced: 0, events: 0 };
    machine.traced += 1;
    if (!continuingThis) machine.events += 1;
    byMachine.set(machineKey, machine);

    const reasonKey = asText(entry.reason) || '(无理由)';
    const reason = byReason.get(reasonKey) ?? {
      reason: reasonKey,
      needs: asText(entry.needs) || null,
      needsKnown: entry.needsKnown === true,
      title: needsOf(reasonKey).title ?? null,
      events: 0,
      continuations: 0,
      lastAt: null,
    };
    if (continuingThis) reason.continuations += 1; else reason.events += 1;
    if (!reason.lastAt || asText(entry.at) > reason.lastAt) reason.lastAt = asText(entry.at) || null;
    byReason.set(reasonKey, reason);

    // 该打扰人却没送出去：这是最该响的一类静默，必须单独数出来而不是混在「其它」里。
    // 判据看**动作**而不是看桶：只有 `action === 'SEND'` 才是「本来要打扰人」；
    // RESOLVE（恢复通知）没送出去是另一件事，混进来会把这条数字变得不可解释。
    const status = asText(entry.notifyStatus);
    if (asText(entry.notifyAction) === 'SEND' && Object.hasOwn(undelivered, status)) {
      undelivered[status] += 1;
    }
  }

  const sortedDays = [...byDay.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  const sortedReasons = [...byReason.values()].sort((a, b) => (b.events - a.events) || a.reason.localeCompare(b.reason));

  return {
    version: ROUND_HISTORY_VERSION,
    windowDays,
    sinceAt: new Date(since).toISOString(),
    untilAt: new Date(until).toISOString(),
    traced: traced.length,
    undated,
    outsideWindow,
    events: { total: eventsTotal, ...events },
    continuing: { total: continuingTotal, ...continuing },
    undelivered: { ...undelivered, total: undelivered.FAILED + undelivered.NOT_CONFIGURED },
    byDay: sortedDays,
    byStore: [...byStore.values()].sort((a, b) => (b.events - a.events) || a.storeId.localeCompare(b.storeId)),
    byMachine: [...byMachine.values()].sort((a, b) => b.traced - a.traced),
    byReason: sortedReasons,
    last: traced.length
      ? traced.reduce((latest, cur) => (cur.at > latest.at ? cur : latest)).entry
      : null,
  };
}

// 人话报告。刻意不用表格线：它会被贴进飞书/邮件/诊断包，等宽表格在那些地方会散架。
export function renderHistoryReport(summary, { file = null, corrupted = [] } = {}) {
  const lines = [];
  const onsiteDays = summary.byDay.filter((day) => day.onsite > 0).length;
  lines.push(`轮次历史（最近 ${summary.windowDays} 天，${summary.sinceAt.slice(0, 10)} ~ ${summary.untilAt.slice(0, 10)}）`);
  if (file) lines.push(`文件：${file}`);
  lines.push(`过了到期闸门的轮次：${summary.traced}（其中 ${summary.undated} 条无法解析时间，未纳入）`);
  lines.push('');

  lines.push('结论');
  lines.push(`- 需要人到现场（ONSITE）：${summary.events.ONSITE} 次新发生，涉及 ${onsiteDays} 天`);
  lines.push(`- 需要人/上游结数据（UPSTREAM）：${summary.events.UPSTREAM} 次`);
  lines.push(`- 需要改配置（CONFIG）：${summary.events.CONFIG} 次；需要看数据现状（RECONCILE）：${summary.events.RECONCILE} 次`);
  lines.push(`- 需要服务方（VENDOR）：${summary.events.VENDOR} 次`);
  lines.push(`- 要人但未细分（判定表里写 null 的升级理由）：${summary.events.UNSPECIFIED} 次`);
  lines.push(`- 判定表里查不到的理由：${summary.events.UNCLASSIFIED} 次（非 0 说明有理由漏登记，要去补）`);
  lines.push(`- 同一问题持续中（被去重、不再重复打扰）：${summary.continuing.total} 个轮次`);
  if (summary.events.total > 0) {
    const pct = ((summary.events.ONSITE / summary.events.total) * 100).toFixed(1);
    lines.push(`- 在 ${summary.events.total} 次打扰中，需要人到现场占 ${pct}%`);
  }
  if (summary.undelivered.total > 0) {
    lines.push(`- 注意：有 ${summary.undelivered.total} 次本该通知人却没送出去`
      + `（未配置出口 ${summary.undelivered.NOT_CONFIGURED}、发送失败 ${summary.undelivered.FAILED}）`);
  }
  lines.push('');

  if (summary.byDay.length) {
    lines.push('按天（只列有记录的）');
    for (const day of summary.byDay) {
      lines.push(`- ${day.dayKey}：轮次 ${day.traced}，打扰 ${day.events}，其中需要人到现场 ${day.onsite}`);
    }
    lines.push('');
  }

  if (summary.byReason.length) {
    lines.push('按理由（打扰次数降序）');
    for (const reason of summary.byReason) {
      const need = reason.needsKnown ? (reason.needs ?? '未细分') : '未登记';
      lines.push(`- ${reason.reason}（${reason.title ?? '—'}｜${need}）：打扰 ${reason.events}`
        + `${reason.continuations ? `，持续中 ${reason.continuations}` : ''}`);
    }
    lines.push('');
  }

  if (summary.byStore.length > 1) {
    lines.push('按店铺');
    for (const store of summary.byStore) {
      lines.push(`- ${store.storeId}：轮次 ${store.traced}，打扰 ${store.events}，其中需要人到现场 ${store.onsite}`);
    }
    lines.push('');
  }
  if (summary.byMachine.length > 1) {
    lines.push('按机器');
    for (const machine of summary.byMachine) {
      lines.push(`- ${machine.machine}：轮次 ${machine.traced}，打扰 ${machine.events}`);
    }
    lines.push('');
  }

  if (summary.last) {
    lines.push(`最近一条：${summary.last.at}　${summary.last.outcome}　${summary.last.reason ?? '—'}`);
  }
  // 账本里有更早的记录时要说出来：不说的话，运营看到「最近 30 天 2 次」会以为总共就 2 次，
  // 而实际可能是「最近 30 天 2 次、更早还有 40 次」——这正是决定要不要做自动登录时要看的东西。
  if (summary.outsideWindow > 0) {
    lines.push(`另有 ${summary.outsideWindow} 条更早的记录在窗口之外；要看它们把 --days 调大。`);
  }
  if (corrupted.length) {
    lines.push(`坏行：${corrupted.length} 条（行号 ${corrupted.slice(0, 10).map((item) => item.line).join(', ')}`
      + `${corrupted.length > 10 ? ' …' : ''}）——历史被读少会让「需要人」的频率偏低，先修它。`);
  }
  if (!summary.traced && !corrupted.length) {
    lines.push('还没有任何记录。这个文件是从本功能落地那一刻开始写的，**无法回填**：');
    lines.push('在那之前发生过多少次要人的事，没有留下机器可读的痕迹（飞书群里的历史消息是唯一的间接线索）。');
  }
  return `${lines.join('\n')}\n`;
}
