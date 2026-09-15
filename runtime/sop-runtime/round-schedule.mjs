// 排期：回答「这一轮现在该不该跑、跑的是哪个周期、幂等键是什么」。
//
// 为什么排期要独立成一层（而不是交给 Windows 任务计划程序的触发器表达式）：
//   1. **排期是业务语义，不是操作系统语义。** 「每周一早上跑上一周（周日~周六）」这句话里，
//      周期区间的算法（周日为周首、跑的是上一周）只有本仓库知道；写进任务计划的触发器只会
//      留下一个「周一 09:00」的时间点，周期一旦对不上没人能发现。
//   2. **不绑机器。** 排期配置放在文件里，谁把它叫醒都行：常驻循环（`--serve`）、被外部定时器
//      叫醒（WorkBuddy 的定时任务 / Windows 计划任务）、或人工点一下。宿主只负责「叫醒」，
//      不负责「判断该不该跑」。
//   3. **幂等键必须与周期同源。** 由排期算出的周期直接拼成业务幂等键，所以「同一个周期跑两次」
//      这件事在准入层就被挡住，而不是靠本地文件记「今天跑过了」。
//
// 本模块是**纯逻辑**（不碰文件、不碰网络、不碰数据库）：给定配置与一个时刻，输出判定。
// 读文件、起进程、发通知都在 CLI/编排层。刻意**不** import round-runner（那会形成循环依赖：
// 编排层要 import 本模块来取排期判定）。
export const ROUND_SCHEDULE_VERSION = 'round-schedule-v1';

export const WHEN_KINDS = Object.freeze(['daily', 'weekly', 'monthly']);

// 周期口径。术语按本仓库既有 SOP 的说法（周表的口径是「周日~周六」）。
export const PERIOD_KINDS = Object.freeze([
  'TODAY',
  'YESTERDAY',
  'PREVIOUS_WEEK_SUN_SAT',
  'CURRENT_WEEK_SUN_SAT',
  'PREVIOUS_MONTH',
]);

const WEEKDAYS = Object.freeze({
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
  SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6,
});

// 身份必填项与 context-schema.REQUIRED_IDENTITY 同源。在这里重复一份**不是**为了分叉，
// 而是为了让「配置里少写一个字段」在**启动时**就报出来，而不是跑到一半在 Controller 里炸。
export const REQUIRED_IDENTITY_FIELDS = Object.freeze([
  'tenantId', 'storeId', 'platform', 'accountId', 'browserProfileId', 'contractVersion',
]);

const DEFAULT_BUSINESS_KEY_TEMPLATE = '{capability}/{windowKey}';

const asText = (value) => (value === undefined || value === null ? '' : String(value).trim());

// ── 本机日期算术（一律本地时区：排期的语义是「本机几点」）──────────────────
export function dateKey(value) {
  const at = value instanceof Date ? value : new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function addDays(value, days) {
  const at = new Date(value);
  at.setDate(at.getDate() + days);
  return at;
}

function startOfDay(value) {
  const at = new Date(value);
  at.setHours(0, 0, 0, 0);
  return at;
}

// 周日为周首：本仓库的竞品周表口径就是「周日~周六」。
function sundayOnOrBefore(value) {
  const at = startOfDay(value);
  at.setDate(at.getDate() - at.getDay());
  return at;
}

function monthStart(value) {
  const at = startOfDay(value);
  at.setDate(1);
  return at;
}

function lastDayOfMonth(value) {
  const at = startOfDay(value);
  at.setMonth(at.getMonth() + 1, 0);
  return at;
}

function parseTimeOfDay(text) {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(asText(text));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

function atTimeOfDay(day, time) {
  const at = startOfDay(day);
  at.setHours(time.hours, time.minutes, 0, 0);
  return at;
}

// 周期区间。输入是**触发日**而不是「现在」：这样即使到了周二才去看，算出来的仍然是周一那次触发
// 对应的周期——显式补跑（`--force`）时周期不会漂移到「本周围」上去。
// 注意：这**不**意味着跨天会自动补跑，自动补跑的口径见 evaluateSchedule 里对 due 的说明。
export function resolvePeriod(periodSpec, triggerAt) {
  const kind = asText(periodSpec?.kind).toUpperCase() || 'TODAY';
  const trigger = new Date(triggerAt);
  let start;
  let end;
  switch (kind) {
    case 'TODAY':
      start = startOfDay(trigger); end = startOfDay(trigger); break;
    case 'YESTERDAY':
      start = addDays(startOfDay(trigger), -1); end = addDays(startOfDay(trigger), -1); break;
    case 'PREVIOUS_WEEK_SUN_SAT':
      start = addDays(sundayOnOrBefore(trigger), -7); end = addDays(start, 6); break;
    case 'CURRENT_WEEK_SUN_SAT':
      start = sundayOnOrBefore(trigger); end = addDays(start, 6); break;
    case 'PREVIOUS_MONTH':
      start = monthStart(addDays(monthStart(trigger), -1)); end = lastDayOfMonth(start); break;
    default:
      throw new Error(`unknown period kind: ${kind}`);
  }
  const startDate = dateKey(start);
  const endDate = dateKey(end);
  return { kind, startDate, endDate, label: `${startDate}~${endDate}` };
}

// 最近一次「不晚于 now」的触发时刻。
function resolveTriggerAt(entry, nowAt) {
  const when = entry?.when ?? {};
  const kind = asText(when.kind).toLowerCase();
  const time = parseTimeOfDay(when.at);
  const now = new Date(nowAt);

  if (kind === 'daily') {
    const today = atTimeOfDay(now, time);
    return today > now ? addDays(today, -1) : today;
  }
  if (kind === 'weekly') {
    const weekday = WEEKDAYS[asText(when.weekday).toUpperCase()];
    let candidate = atTimeOfDay(now, time);
    // 从今天往回最多找 7 天：先对齐到目标星期，再看今天这一时刻过了没有。
    candidate = addDays(candidate, -(((candidate.getDay() - weekday) + 7) % 7));
    if (candidate > now) candidate = addDays(candidate, -7);
    return candidate;
  }
  if (kind === 'monthly') {
    const day = Number(when.dayOfMonth);
    const build = (year, month) => {
      const last = lastDayOfMonth(new Date(year, month, 1));
      const clamped = Math.min(day, last.getDate());
      return new Date(year, month, clamped, time.hours, time.minutes, 0, 0);
    };
    let candidate = build(now.getFullYear(), now.getMonth());
    if (candidate > now) {
      const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      candidate = build(previous.getFullYear(), previous.getMonth());
    }
    return candidate;
  }
  throw new Error(`unknown when.kind: ${kind}`);
}

function nextTriggerAfter(entry, triggerAt) {
  const when = entry?.when ?? {};
  const kind = asText(when.kind).toLowerCase();
  if (kind === 'daily') return addDays(triggerAt, 1);
  if (kind === 'weekly') return addDays(triggerAt, 7);
  const time = parseTimeOfDay(when.at);
  const day = Number(when.dayOfMonth);
  const build = (year, month) => {
    const last = lastDayOfMonth(new Date(year, month, 1));
    return new Date(year, month, Math.min(day, last.getDate()), time.hours, time.minutes, 0, 0);
  };
  const next = new Date(triggerAt.getFullYear(), triggerAt.getMonth() + 1, 1);
  return build(next.getFullYear(), next.getMonth());
}

export function renderBusinessKey(entry, { windowKey, period }) {
  const template = asText(entry?.businessKeyTemplate) || DEFAULT_BUSINESS_KEY_TEMPLATE;
  return template
    .replace(/\{capability\}/gu, asText(entry?.capability))
    .replace(/\{name\}/gu, asText(entry?.name))
    .replace(/\{windowKey\}/gu, windowKey)
    .replace(/\{periodStart\}/gu, period.startDate)
    .replace(/\{periodEnd\}/gu, period.endDate)
    .replace(/\{storeId\}/gu, asText(entry?.identity?.storeId));
}

// 校验：**任何一条不合法都不许开跑**。配置错误最坏的形态不是报错，而是「看起来在跑」。
export function validateSchedule(schedule) {
  const errors = [];
  const raw = schedule && typeof schedule === 'object' ? schedule : null;
  if (!raw) return { ok: false, errors: ['schedule must be an object'] };
  if (asText(raw.version) && asText(raw.version) !== ROUND_SCHEDULE_VERSION) {
    errors.push(`unexpected version: ${raw.version} (expected ${ROUND_SCHEDULE_VERSION})`);
  }
  if (!Array.isArray(raw.rounds) || raw.rounds.length === 0) {
    return { ok: false, errors: [...errors, 'schedule.rounds must be a non-empty array'] };
  }
  const seen = new Set();
  raw.rounds.forEach((entry, index) => {
    const where = `rounds[${index}]${asText(entry?.name) ? `(${entry.name})` : ''}`;
    const name = asText(entry?.name);
    if (!name) errors.push(`${where}: name is required`);
    else if (seen.has(name)) errors.push(`${where}: duplicate round name`);
    else seen.add(name);
    if (entry?.enabled !== undefined && typeof entry.enabled !== 'boolean') errors.push(`${where}: enabled must be a boolean when present`);
    if (!asText(entry?.capability)) errors.push(`${where}: capability is required`);

    const when = entry?.when ?? {};
    const kind = asText(when.kind).toLowerCase();
    if (!WHEN_KINDS.includes(kind)) errors.push(`${where}: when.kind must be one of ${WHEN_KINDS.join('/')}`);
    if (!parseTimeOfDay(when.at)) errors.push(`${where}: when.at must look like "09:00"`);
    if (kind === 'weekly' && !Object.hasOwn(WEEKDAYS, asText(when.weekday).toUpperCase())) {
      errors.push(`${where}: when.weekday is required for weekly rounds (e.g. "MO")`);
    }
    if (kind === 'monthly') {
      const day = Number(when.dayOfMonth);
      if (!Number.isSafeInteger(day) || day < 1 || day > 31) errors.push(`${where}: when.dayOfMonth must be 1..31 for monthly rounds`);
    }

    const periodKind = asText(entry?.period?.kind).toUpperCase() || 'TODAY';
    if (!PERIOD_KINDS.includes(periodKind)) errors.push(`${where}: period.kind must be one of ${PERIOD_KINDS.join('/')}`);

    const identity = entry?.identity ?? {};
    for (const field of REQUIRED_IDENTITY_FIELDS) {
      if (!asText(identity[field])) errors.push(`${where}: identity.${field} is required`);
    }

    const template = asText(entry?.businessKeyTemplate) || DEFAULT_BUSINESS_KEY_TEMPLATE;
    // 幂等键里必须带周期，否则「这个键跑过一次」会变成「永远不再跑」。
    if (!/\{(windowKey|periodStart|periodEnd)\}/u.test(template)) {
      errors.push(`${where}: businessKeyTemplate must include {windowKey} or {periodStart}/{periodEnd} (otherwise the key never changes and the round runs only once ever)`);
    } else if (!/^[A-Za-z0-9._~{}/-]+$/u.test(template)) {
      errors.push(`${where}: businessKeyTemplate may only contain letters, digits and . _ ~ { } / -`);
    }

    if (entry?.commit === true && !asText(entry?.operator)) {
      errors.push(`${where}: operator is required when commit is true`);
    }
    if (entry?.commit !== undefined && typeof entry.commit !== 'boolean') errors.push(`${where}: commit must be a boolean when present`);
  });
  return { ok: errors.length === 0, errors };
}

export function parseScheduleJson(text) {
  const trimmed = asText(text);
  if (!trimmed) throw new Error('schedule JSON is empty');
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`schedule JSON is not valid JSON: ${error.message}`);
  }
  const validation = validateSchedule(parsed);
  return { schedule: parsed, ...validation };
}

export function findRound(schedule, name) {
  const target = asText(name);
  return (schedule?.rounds ?? []).find((entry) => asText(entry?.name) === target) ?? null;
}

// 判定一条排期：现在该不该跑、跑哪个周期、幂等键是什么、下次什么时候。
// **停用的条目也照常算窗口与下次时间**，只把 due 置假——运营看计划时需要看到「启用后它会怎么跑」，
// 而不是一片 null（一片 null 会让人以为「没配」，而真相是「配了但没开」）。
export function evaluateSchedule(entry, nowAt) {
  if (!entry || typeof entry !== 'object') throw new Error('evaluateSchedule requires a schedule entry');
  const name = asText(entry.name);
  const disabled = entry.enabled === false;
  const now = new Date(nowAt);
  const trigger = resolveTriggerAt(entry, nowAt);
  const period = resolvePeriod(entry.period, trigger);
  const windowKey = period.label;
  const next = nextTriggerAfter(entry, trigger);

  // 「到期」的口径：**只有触发日当天、且过了那个时刻，才算到期**。
  //
  // 为什么不是简单的 `now >= 最近一次触发时刻`：那个条件在第一次触发之后**永远为真**，
  // 于是每一条排期都会变成「每醒一次就跑一遍」。这种缺陷不报错、不失败，只是安静地重复干活，
  // 正是无人值守最怕的形态。所以到期必须是一个**当天成立的窗口**，而不是一个单调为真的阈值。
  //
  // 为什么不是「宽限期 N 小时」：宽限期是个没人能记住魔数，还会让「周一没开机」变成
  // 「周二悄悄补跑」，而补跑出来的那份数据没人知道它迟了一天。这里选择宁可漏跑、不要偷跑：
  // 漏跑在计划里看得见（`--show-plan` 会显示下一次触发与「最近一次已过去多久」），
  // 偷跑看不见。真要补跑是显式动作（`--force` / `--round <name>`）。
  //
  // `resolveTriggerAt` 保证 trigger <= now，所以这里只需再确认两者处在同一个本机日期。
  const sameDay = dateKey(trigger) === dateKey(now);
  const due = !disabled && sameDay;
  return {
    name,
    enabled: !disabled,
    due,
    reason: disabled ? 'DISABLED' : (due ? 'DUE' : 'NOT_DUE'),
    // triggerAt 就是「不晚于现在的最近一次触发」，也就是本次判定所针对的那一次。
    triggerAt: trigger.toISOString(),
    // 它是不是「今天这一次」。due 为真时必然为真；due 为假时配合 hoursSinceTriggerAt 让运营看出
    // 「上一次触发已过去多久」，从而发现「这周是不是漏了」。只报事实，不断言它跑没跑过
    //（那要去查运行账本，排期层看不到）。
    isLastTriggerToday: sameDay,
    hoursSinceTriggerAt: Math.round(((now - trigger) / 3_600_000) * 10) / 10,
    nextTriggerAt: next.toISOString(),
    windowKey,
    period,
    businessKey: renderBusinessKey(entry, { windowKey, period }),
  };
}

// 供「下次什么时候跑」这类展示用。**会跳过 disabled 的条目**，但要显式列出来，
// 否则「配置里加了但没启用」在界面上看起来就像「没配」。
export function planSchedule(schedule, nowAt) {
  const validation = validateSchedule(schedule);
  if (!validation.ok) return { ok: false, errors: validation.errors, rows: [] };
  return {
    ok: true,
    errors: [],
    rows: schedule.rounds.map((entry) => {
      const decision = evaluateSchedule(entry, nowAt);
      return {
        ...decision,
        capability: asText(entry.capability),
        label: describeSchedule(entry),
      };
    }),
  };
}

const WEEKDAY_LABEL = Object.freeze({ 0: '周日', 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六' });

export function describeSchedule(entry) {
  const when = entry?.when ?? {};
  const kind = asText(when.kind).toLowerCase();
  const at = asText(when.at);
  const period = asText(entry?.period?.kind).toUpperCase() || 'TODAY';
  const periodLabel = {
    TODAY: '当天',
    YESTERDAY: '前一天',
    PREVIOUS_WEEK_SUN_SAT: '上一周（周日~周六）',
    CURRENT_WEEK_SUN_SAT: '本周（周日~周六）',
    PREVIOUS_MONTH: '上一个月',
  }[period] ?? period;
  if (kind === 'daily') return `每天 ${at}，跑${periodLabel}`;
  if (kind === 'weekly') return `每${WEEKDAY_LABEL[WEEKDAYS[asText(when.weekday).toUpperCase()]] ?? asText(when.weekday)} ${at}，跑${periodLabel}`;
  if (kind === 'monthly') return `每月 ${asText(when.dayOfMonth)} 日 ${at}，跑${periodLabel}`;
  return `${kind} ${at}`;
}

// 一次「叫醒」：把到期的排期逐条跑掉，没到期的原样跳过。
// 串行执行——浏览器写操作恒 1（§3 并发约束），排期层不制造并发。
export async function tickRounds({ schedule, nowAt = Date.now(), runRoundOnce, onResult = null } = {}) {
  if (typeof runRoundOnce !== 'function') throw new Error('tickRounds requires runRoundOnce');
  const validation = validateSchedule(schedule);
  if (!validation.ok) throw new Error(`schedule is invalid: ${validation.errors.join('; ')}`);
  const results = [];
  for (const entry of schedule.rounds) {
    const decision = evaluateSchedule(entry, nowAt);
    if (!decision.due) {
      results.push({ name: decision.name, decision, ran: false });
    } else {
      const receipt = await runRoundOnce(entry, decision);
      results.push({ name: decision.name, decision, ran: true, receipt });
    }
    if (typeof onResult === 'function') onResult(results[results.length - 1]);
  }
  return results;
}

// 常驻循环：按 intervalMs 醒一次，醒了就 tickRounds。
// 「谁把它叫醒」与「该不该跑」是两件事——宿主定时器（含 WorkBuddy 的定时任务、Windows 计划任务）
// 或这里的循环都只是叫醒者，判定始终在 evaluateSchedule/tickRounds 里。
export async function serveRounds({
  schedule,
  intervalMs = 60_000,
  now = () => Date.now(),
  runRoundOnce,
  onResult = null,
  onTick = null,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  maxTicks = Number.POSITIVE_INFINITY,
} = {}) {
  let ticks = 0;
  const tickLog = [];
  while (ticks < maxTicks) {
    const at = Number(now());
    const results = await tickRounds({ schedule, nowAt: at, runRoundOnce, onResult });
    ticks += 1;
    tickLog.push({ at, results });
    if (typeof onTick === 'function') await onTick({ at, results, tick: ticks });
    if (ticks >= maxTicks) break;
    await sleep(intervalMs);
  }
  return { ticks, tickLog };
}
