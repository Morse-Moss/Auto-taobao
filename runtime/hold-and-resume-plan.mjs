// 驻留 → 判据转正 → 只补失败店自动续跑：**纯函数部分**（判据、命令、文案）。
//
// 为什么单独一层：这里每一条判据判错的代价都不是「难看」，而是
// 「每天白挂几个小时」或者「人赶到时窗口已经没了」—— 所以它们必须能被离线用例与突变验证覆盖，
// 而不是埋在 `scripts/hold-and-resume.mjs` 那个会起子进程的 CLI 里。
// 分工与 `runtime/daily-job-plan.mjs` / `scripts/run-daily-job.mjs`、`runtime/batch-plan.mjs` /
// `scripts/run-batches.mjs` 完全一致：**计划是纯的，执行是薄的**。
//
// 依赖方向：本文件**只依赖 node 内建**，不 import 任何 `skills/` 下的东西
//（`runtime/arch-boundary.test.mjs` 会红）。业务词表（哪几种失败算「需要人」）由调用方传进来。
//
// 背景（为什么不是「另起一个 hold 脚本」）：
//   宿主在驱动命令结束时回收**整棵进程树** ⇒ `start-all.mjs` 起的窗口在命令结束后 0.26 秒就不在了
//   （`runtime/batch-plan.mjs` 记着这条实测）。所以「保住窗口」唯一可靠的形态是**这一轮不结束** ——
//   驻留进程活着，窗口就活着。这也是本模块存在的理由。

/** 驻留的默认截止时间（当天几点几分）。 */
export const DEFAULT_HOLD_UNTIL = '12:00';

/**
 * 轮询间隔按**判据的成本与噪声**分，不按「统一一个好记的数」：
 *   · 广告那条是只读的 DOM 查询（便宜、无副作用、可以问得很勤）；
 *   · 登录那条要连淘宝后台读页面（贵，而且频繁探测本身就可能触发风控），问得慢一点。
 */
export const POLL_SECONDS_BY_CAUSE = Object.freeze({
  PAGE_OBSTRUCTED: 30,
  NEEDS_LOGIN: 120,
  ROUND_BLOCKED: 120,
});
export const DEFAULT_POLL_SECONDS = 60;
/** 驻留期间往日志写一行状态的间隔（不许静默）。 */
export const STATUS_EVERY_MS = 15 * 60 * 1000;

/** `'12:00'` → `720`。格式不对**不回落**：回落成 0 会让驻留立刻结束。 */
export function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(String(text ?? '').trim());
  if (!match) return { ok: false, error: `时间要写成 HH:MM（收到 ${JSON.stringify(text ?? null)}）` };
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return { ok: false, error: `时间超出范围：${text}` };
  return { ok: true, minutes: hours * 60 + minutes };
}

/** 一天里的第几分钟（本地时钟，与 `parseClock` 同一把尺子）。 */
export function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** 到点了吗。 */
export function deadlineReached({ nowMinutes, untilMinutes }) {
  return nowMinutes >= untilMinutes;
}

/**
 * 这一轮该不该驻留、要替哪几家等。
 *
 * `failed` 的形状是调用方归一化过的逐店失败：`[{ shop, cause, stage }]`（cause 由链的分类器给）。
 * **不给 `humanCauses` 就当空集**（＝什么都不驻留）：默认行为必须是「与从前逐字相同」，
 * 而「多驻留一轮」的代价是白挂几小时。
 *
 * 整轮被挡（`roundBlocked`）**一律算需要人**：能挡住整轮的只有两种成因 ——
 * 商家浏览器掉登录（2026-09-25 现场）与页面真的缺（2026-09-22 现场）—— 两种都只有人能解除。
 * 它不受 `humanCauses` 管：那是个**逐店**词表，用在这里会漏掉「一家都没跑起来」的那一轮。
 */
export function holdDecision({ failed = [], roundBlocked = false, roundCause = null, humanCauses = [] } = {}) {
  const human = (Array.isArray(failed) ? failed : [])
    .filter((item) => item && humanCauses.includes(item.cause));
  if (roundBlocked === true) {
    return {
      needed: true,
      roundLevel: true,
      causes: roundCause ? [roundCause] : [],
      subjects: [],
      // 整轮被挡 ⇒ 没有任何店跑过 ⇒ **不能点名**（不给 `--shops` 就是整轮重跑）。
      resumeShops: null,
    };
  }
  return {
    needed: human.length > 0,
    roundLevel: false,
    causes: [...new Set(human.map((item) => item.cause))],
    subjects: human.map((item) => item.shop),
    // 只补需要人那几家。整轮重跑会撞「同一天＋同店铺」的查重键：
    // 已经写进去的那几家会被硬停，把一次成功续跑变成一个新告警。
    resumeShops: human.map((item) => item.shop),
  };
}

/** 按成因取轮询间隔：取**最小**的那个（多成因时以最勤的判据为准）。 */
export function pollSecondsFor(causes = []) {
  const values = (Array.isArray(causes) ? causes : [])
    .map((cause) => POLL_SECONDS_BY_CAUSE[cause])
    .filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : DEFAULT_POLL_SECONDS;
}

/**
 * 「重跑哪几步」：从**最早**那处失败开始的全部阶段（多店合并＝后缀的并集还是后缀）。
 *
 * 三条不肯让步的口径：
 *   ① 一个阶段名都认不出来 ⇒ 返回 `null`（＝不点名，整链跑）。猜「从哪一步开始」的代价是
 *      **漏跑一段**，而漏跑一段的续跑看起来与成功一模一样。
 *   ② `health-check` **永远带上**：人刚动过浏览器（关弹窗、重新登录），页签与端口必须重新体检过
 *      才敢往下写；少了它，续跑会拿着一个已经变形的现场直接写飞书。
 *   ③ `floorStage` **只许把起点往前挪，不许往后**（`Math.min`）。它是「人碰过页面」那一档的补偿：
 *      驻留期间那一页被人关过弹窗、或者被我们自己重载过 ⇒ 页面上的**日期筛选**已经不在原处，
 *      而 `alimama-date` 正是把日期落上去的那一步。漏了它，续跑会拿着一个没有日期的报表页
 *      往下做 —— 出来的数看着像数据，实际是别的时段。
 */
export function resumeStageListFrom(failedStages = [], stageNames = [], { floorStage = null } = {}) {
  const indexes = (Array.isArray(failedStages) ? failedStages : [])
    .map((stage) => stageNames.indexOf(stage))
    .filter((index) => index >= 0);
  if (!indexes.length) return null;
  const floorIndex = floorStage ? stageNames.indexOf(floorStage) : -1;
  const from = Math.min(...indexes, ...(floorIndex >= 0 ? [floorIndex] : []));
  return [...new Set(['health-check', ...stageNames.slice(from)])];
}

/**
 * 「人碰过页面」那一档的续跑起点。
 *
 * 只有这两类成因会走到驻留（见 `HUMAN_REQUIRED_CAUSES`），而两类都意味着**页面状态已经不可信**：
 *   · `PAGE_OBSTRUCTED` —— 人在浏览器里关过弹窗；采集脚本自己也可能重载过那一页；
 *   · `NEEDS_LOGIN` —— 人重新登了一次，登录后的页签是全新的。
 * 两种情况下「页面上那个日期还是不是目标日」都不再成立，所以起点一律退到 `alimama-date`。
 * 不带 `health-check`：它由 ③ 无条件加上，这里再写一次就是两处说同一件事。
 */
export const RESUME_FLOOR_BY_CAUSE = Object.freeze({
  PAGE_OBSTRUCTED: 'alimama-date',
  NEEDS_LOGIN: 'alimama-date',
});

/** 多成因时取**阶段表里最靠前**的那个起点（`stageNames` 的顺序就是真实执行顺序）。 */
export function resumeFloorFor(causes = [], stageNames = []) {
  const indexes = (Array.isArray(causes) ? causes : [])
    .map((cause) => RESUME_FLOOR_BY_CAUSE[cause])
    .map((stage) => (stage ? stageNames.indexOf(stage) : -1))
    .filter((index) => index >= 0);
  if (!indexes.length) return null;
  return stageNames[Math.min(...indexes)];
}

/**
 * 续跑的命令行（**不**含 node 本体，调用方拼）。
 *
 * 刻意不传 `--login-preflight`：那个结论文件是这一轮开跑前写的，人刚登完/刚关完弹窗之后它已经过期，
 * 拿它当解释会把「这次为什么失败」说成上一次的成因。不给它的口径是「这一轮没有先查登录态」——
 * 不如前者详细，但**是真的**。
 * 也刻意不传 `--will-resume`：续跑只做一次，之后不再驻留 ⇒ 承诺「系统会自己继续」会变成假话。
 */
export function buildResumeArgv({ chainScript, date, shops = null, stages = null, notify = true } = {}) {
  const argv = [chainScript, '--date', date, '--commit'];
  if (notify) argv.push('--notify');
  if (Array.isArray(shops) && shops.length) argv.push('--shops', shops.join(','));
  if (Array.isArray(stages) && stages.length) argv.push('--only', stages.join(','));
  return argv;
}

/** 一次探测的全部结论。`state` 只允许这三种，第四种会被判成配置错误。 */
export const PROBE_STATES = Object.freeze(['ready', 'waiting', 'unknown']);

/**
 * 探测结果 → 「能不能续跑了」。
 *
 * `unknown`（读不到）**不当作 ready**：那是本项目里最贵的一类错误
 *（「读不到」被读成「好了」⇒ 拿着一个还堵着的现场去写飞书）。所以 unknown 与 waiting 一样继续等。
 * 一个探针都没有（`total === 0`）同样不算 ready —— 「没东西可探」不等于「都好了」。
 */
export function judgeProbes(probes = []) {
  const list = Array.isArray(probes) ? probes : [];
  const waiting = list.filter((probe) => probe?.state === 'waiting');
  const unknown = list.filter((probe) => probe?.state === 'unknown');
  return {
    ready: list.length > 0 && waiting.length === 0 && unknown.length === 0,
    waiting,
    unknown,
    total: list.length,
  };
}

/** 驻留期间那行状态（每 `STATUS_EVERY_MS` 一行，**不许静默**）。 */
export function holdStatusLine({ at, waitedMs = 0, until, probes = [], resumed = false } = {}) {
  const stamp = at instanceof Date ? at.toTimeString().slice(0, 8) : String(at ?? '');
  const minutes = Math.max(0, Math.round(waitedMs / 60_000));
  const detail = (Array.isArray(probes) ? probes : [])
    .map((probe) => `${probe.subject}：${probe.why}`)
    .join('；');
  return `[驻留] ${stamp}（已等 ${minutes} 分钟，等到 ${until}）${resumed ? '｜已发起续跑' : ''}${detail ? `｜${detail}` : ''}`;
}

// ---------------------------------------------------------------------------
// 收信人看到的两条通知
// ---------------------------------------------------------------------------
// 两条都走既有出口（`runtime/notify-feishu.mjs`）与既有的渲染器，字段名必须落在
// `runtime/notify-feishu-core.mjs` 的 `READABLE_SOURCE_KEYS` 白名单里，否则那一行会被**静默丢掉**。
// 措辞口径同链上那一条：只用业务词（店名、窗口标题、飞书里的表名），不写英文阶段名、不写路径与命令。

function noticeBase({ type, severity, title, alertId, fingerprint, date, targetLabel, shopNames, reason, action, createdAt }) {
  return {
    type,
    severity,
    title,
    alertId,
    fingerprint,
    source: {
      targetLabel,
      shopName: Array.isArray(shopNames) ? shopNames.join('、') : shopNames,
      period: date,
      capability: '各店铺日报',
    },
    reason,
    action,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
  };
}

/**
 * 到点还没人来：**必须发**。驻留结束时窗口会被释放，而那之后人就再也接不上手了 ——
 * 静默释放等于「人以为还有现场，其实没了」。
 */
export function closeOutNotice({ date, subjects = [], until = DEFAULT_HOLD_UNTIL, targetLabel = '日报一轮', createdAt } = {}) {
  const who = subjects.length ? subjects.join('、') : '这一轮';
  return noticeBase({
    type: 'DAILY_HOLD_TIMEOUT',
    severity: 'ERROR',
    title: `${who}的日报还缺着：等到 ${until} 也没等到处理`,
    alertId: `daily-hold-${String(date).replace(/-/gu, '')}`,
    fingerprint: 'HOLD_TIMEOUT',
    date,
    targetLabel,
    shopNames: subjects,
    reason: `这一轮的浏览器窗口一直留着没关，等到 ${until} 还是没等到人来处理，所以按约定把窗口放掉、这一轮结束了，这一天的数据还是没有进飞书。`,
    action: '需要重新跑一次这一天的采集。这一次不用赶时间了 —— 上一轮的窗口已经释放。',
    createdAt,
  });
}

/**
 * 续跑结果。成功发「提示」，失败发「需要处理」——
 * 失败那一路必须说清「已经试过一次、不会再自己试」，否则收信人会一直等下去。
 *
 * ⚠️ 两种结果的 `alertId` **必须不同**（2026-09-26 写用例时发现原来的写法共用
 * `daily-hold-resumed-<日期>`）：`dispatchRoundAlert` 按 `alertId` 查那 6 小时去重窗口，
 * 而「续跑成功」这条**是要发出去**的（它是 INFO，但同样会送）⇒ 同一天里先成功过一次，
 * 之后的**失败**就会被自己的成功记录挡掉 —— 一条真正需要人看的消息**一个字都发不出去**，
 * 而日志里只留一句「这一条没往外发」。同一个事实两处实现要漂，这里是同一个编号两件事要撞。
 */
export function resumeResultNotice({ date, shops = [], ok = false, detail = null, targetLabel = '日报一轮', createdAt } = {}) {
  const who = shops.length ? shops.join('、') : '这一轮';
  const stamp = String(date).replace(/-/gu, '');
  return noticeBase({
    type: ok ? 'DAILY_HOLD_RESUMED' : 'DAILY_HOLD_RESUME_FAILED',
    severity: ok ? 'INFO' : 'ERROR',
    title: ok ? `${who}的日报已经补上了` : `${who}的日报自动续跑没成功`,
    alertId: ok ? `daily-hold-resumed-${stamp}` : `daily-hold-resume-failed-${stamp}`,
    fingerprint: ok ? 'HOLD_RESUMED' : 'HOLD_RESUME_FAILED',
    date,
    targetLabel,
    shopNames: shops,
    reason: ok
      ? `上一轮停住的那几家，在窗口里处理完之后系统自己接着把剩下的步骤跑完了，这一天的数据已经进飞书。`
      : `上一轮停住的那几家，系统自己重跑了一次仍没跑完${detail ? `（${detail}）` : ''}。`,
    action: ok
      ? '不需要你做什么。'
      : '同一家店不会再自动重跑第二次。这一次的现场在窗口里，需要技术同学看一下。',
    createdAt,
  });
}
