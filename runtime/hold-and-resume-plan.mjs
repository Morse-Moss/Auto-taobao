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

/**
 * 驻留默认挂**多久**（小时）—— 时段，不是「等到当天某个钟点」。
 *
 * 为什么必须从绝对钟点改成时段（2026-10-06 实测的缺陷）：原来的默认值是一个**绝对钟点** `'12:00'`，
 * 而日报定时排在 **15:30**。于是驻留进程每一轮启动时那个钟点**早就过了**，循环第一次判「到点」，
 * 退出码 3、**一秒都没等**。实测（真实 summary，`--no-notify --no-release`）：
 *   `[驻留] 截止 12:00（现在 16:01）｜轮询 120 秒一次`
 *   `[驻留] 到 12:00 还没等到 ⇒ 收尾`
 *   ⇒ 退出码 3（TIMED_OUT），等待 0 秒。
 * 结论：**「挂住等人处理」这条能力在 15:30 的排期下从未发生过一次**，
 * 而 `--print` 与日志都还在说「默认等到当天 12:00」—— 一句做不到的承诺。
 *
 * 绝对钟点这条口径保留（`--until HH:MM`，人显式给），但**已经过去的钟点当场拒**：
 * 静默地「立刻超时」正是上面那个缺陷的形态，而它看起来完全正常。
 */
export const DEFAULT_HOLD_HOURS = 4;

/**
 * 轮询间隔按**判据的成本与噪声**分，不按「统一一个好记的数」：
 *   · 广告那条是只读的 DOM 查询（便宜、无副作用、可以问得很勤）；
 *   · 登录那条要连淘宝后台读页面（贵，而且频繁探测本身就可能触发风控），问得慢一点。
 */
export const POLL_SECONDS_BY_CAUSE = Object.freeze({
  PAGE_OBSTRUCTED: 30,
  NEEDS_LOGIN: 120,
  ROUND_BLOCKED: 120,
  // 整轮被挡的**具体**成因：共用窗口自己掉登录（2026-10-06 单列，见 run-multi-shop-day 的
  // `roundCauseOf`）。间隔与 `NEEDS_LOGIN` 一样取 120 秒 —— 它探的是同一个东西
  // （那台共用浏览器上还停不停在登录页），而「探得勤」对登录探针是负收益（可能触发风控）。
  // 漏了这条不会有任何报错，只会静默落回 `DEFAULT_POLL_SECONDS`（60 秒）—— 探得更勤但没意义。
  ROUND_LOGIN_WALL: 120,
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

/** `Date` → `'HH:MM'`（本地时钟）。只用于**显示**（日志与告警），判据一律用毫秒时间戳。 */
export function formatClock(date) {
  const at = date instanceof Date ? date : new Date(date);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/**
 * 算出「驻留挂到什么时候」。**纯函数**：只读传入的 `now`，不读时钟、不产生副作用。
 *
 * 两种给法，二选一：
 *   · 不给 `until` ⇒ 用**时段**（`hours`，默认 `DEFAULT_HOLD_HOURS`）。这是生产走的那一档，
 *     它与「任务几点跑」无关 —— 排期从早上挪到下午、或从下午挪到夜里，都不用改配置。
 *   · 给了 `until`（`'HH:MM'`）⇒ 用**今天的那个钟点**。人排查时想要「就挂到 17:30」时才用。
 *
 * **已经过去的钟点当场拒**，不静默超时：`--until` 指的是今天，而给一个已经过去的钟点，
 * 效果是「驻留立刻结束、一秒不等」—— 正是这次要治的那个形态（它看起来一切正常）。
 * 拒的时候把「要用时段该写什么」一起写进错误里，省掉一次来回。
 *
 * 返回 `{ ok:false, error }` 或 `{ ok:true, deadlineMs, untilText, source }`。
 * `deadlineMs` 是**绝对毫秒时间戳**（不用「当天第几分钟」：跨零点时那个口径会翻转，
 * 23:00 挂 4 小时会被算成「早就到点了」）。
 */
export function resolveHoldDeadline({ now = new Date(), until = null, hours = DEFAULT_HOLD_HOURS } = {}) {
  if (until !== null && until !== undefined && until !== '') {
    const clock = parseClock(until);
    if (!clock.ok) return { ok: false, error: clock.error };
    const at = new Date(now.getTime());
    at.setHours(Math.floor(clock.minutes / 60), clock.minutes % 60, 0, 0);
    if (at.getTime() <= now.getTime()) {
      return {
        ok: false,
        error: `--until ${until} 今天已经过了（现在 ${formatClock(now)}）。--until 指的是**今天**这个钟点，`
          + '给一个已经过去的钟点会让驻留立刻超时、一秒都不等 —— 这正是 2026-10-06 查出来的那个缺陷。'
          + `要「从现在起挂一段时间」请用 --hold-hours N（默认 ${DEFAULT_HOLD_HOURS} 小时）。`,
      };
    }
    return { ok: true, deadlineMs: at.getTime(), untilText: formatClock(at), source: 'clock' };
  }
  const value = Number(hours);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: `--hold-hours 要一个正数（收到 ${JSON.stringify(hours)}）` };
  }
  const at = new Date(now.getTime() + Math.round(value * 3_600_000));
  return { ok: true, deadlineMs: at.getTime(), untilText: formatClock(at), source: 'duration' };
}

/** 到点了吗。毫秒口径（与 `resolveHoldDeadline` 同一把尺子）。 */
export function deadlineReachedAt({ nowMs, deadlineMs }) {
  return Number(nowMs) >= Number(deadlineMs);
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
 *
 * ── 2026-09-29 扩容：`unfixableShops` ──────────────────────────────────────
 * 用户定的三层降级是「脚本自己修 → 修不动就驻留并唤醒修复 agent → agent 也不行才叫人」。
 * 于是驻留的判据不再只是「只有人能解除的成因」，还包括**脚本自己修过但没救回来的那几家**：
 * 那些店的现场必须留着（窗口不释放、失败页不导航走），修复 agent 赶过来才有东西可修。
 *
 * `unfixableShops` 由调用方给（＝`--auto-repair` 跑完后 `autoRepair.gaveUp` 非空、或成因
 * 在修复表里没候选的那些店）。刻意**不把它并进 `humanCauses`**：那个词表的语义是「成因」，
 * 而这一条说的是「这家店的自动修复没成功」——两件事混在一个词表里，将来一定会漂开。
 * 两路取并集，且**都不给时行为与从前逐字相同**。
 */
export function holdDecision({ failed = [], roundBlocked = false, roundCause = null,
  humanCauses = [], unfixableShops = [] } = {}) {
  const human = (Array.isArray(failed) ? failed : [])
    .filter((item) => item && humanCauses.includes(item.cause));
  const unfixable = (Array.isArray(failed) ? failed : [])
    .filter((item) => item && Array.isArray(unfixableShops) && unfixableShops.includes(item.shop));
  // 并集（同一家店可能同时命中两路 ⇒ 去重），且**按 `failed` 的原始顺序**输出 ——
  // 不按「先 human 再 unfixable」拼：那会让点名的次序随判据的加法而变，
  // 而收信人看到的名单顺序不该由「它是哪一路进来的」决定。判据集合只负责「进不进」。
  const wanted = new Set([...human, ...unfixable].map((item) => item.shop));
  const union = (Array.isArray(failed) ? failed : []).filter((item) => item && wanted.has(item.shop));
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
    needed: union.length > 0,
    roundLevel: false,
    causes: [...new Set(union.map((item) => item.cause))],
    subjects: union.map((item) => item.shop),
    // 只补需要人那几家。整轮重跑会撞「同一天＋同店铺」的查重键：
    // 已经写进去的那几家会被硬停，把一次成功续跑变成一个新告警。
    resumeShops: union.map((item) => item.shop),
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
 * 「脚本自己修不动」的店 —— 驻留判据的第二路（2026-09-29 加）。
 *
 * 两条判据，任一成立即算：
 *   · `record.autoRepair.gaveUp` 非空 —— `--auto-repair` 跑过、候选试用完/用完轮数仍没救回来
 *     （「修了没救回来」）；
 *   · `record.repairRequest.candidates` 为空 —— 成因在修复表里没候选，脚本**压根不知道该修什么**
 *     （「不知道怎么修」）。用户口径：这一档不该出现，遇到就驻留等 agent／人，而不是直接放弃。
 *
 * ⚠️ 只认**这两个字段**，不看 `record.status`：调用方已经把「失败的店」筛过一遍了。
 * 也刻意不看 `HUMAN_REQUIRED_CAUSES` 那类成因词表 —— 成因词表回答的是「谁最终要人」，
 * 而这里回答的是「脚本自己能不能搞定」，两件事。
 *
 * `autoRepair` 与 `repairRequest` 只在驱动真的跑过那两段流程时才有值。都没值 ⇒ 返回空数组 ⇒
 * 行为与加这个函数之前逐字相同（默认不变）。
 */
export function unfixableShopsOf(summary) {
  const out = [];
  for (const [shop, record] of Object.entries(summary?.shops ?? {})) {
    if (!record || typeof record !== 'object') continue;
    if (record.status === 'ok') continue;
    const gaveUp = record.autoRepair?.gaveUp;
    const candidates = record.repairRequest?.candidates;
    const noCandidates = Array.isArray(candidates) && candidates.length === 0;
    if (typeof gaveUp === 'string' && gaveUp.trim()) out.push(shop);
    else if (record.repairRequest && noCandidates) out.push(shop);
  }
  return out;
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

/**
 * **分批形态**下续跑的命令行：入口是**分批驱动本身**，不是链。
 *
 * 为什么不能沿用 `buildResumeArgv`（直连链）：分批形态下**店铺实例是按批起停的**
 * （`runtime/batch-plan.mjs` 的设计约束③：起与停作用在同一组目标上）。整轮被挡那一轮里，
 * 链跑完之后每一批自己的 `stop` 已经把那几家放掉了 ⇒ 直连链的续跑会在「实例不在」的现场上开跑，
 * 而它的第 0 步体检只会再报一次同样的错。所以续跑必须回到**分批驱动**：
 * 由它重新按批起实例、按批跑、按批释放。
 *
 * `--no-hold`（`noHold`，默认开）是**防递归**的那一下：续跑本身若又撞上整轮被挡，
 * 它应当老老实实退 1 结束，而不是再挂一轮 —— 那会变成「驻留套驻留」，
 * 而第一层驻留的 `--date`/`--summary` 已经过期，第二层等的是另一份结论。
 *
 * `--date` 必须给**已经解析好的那一天**（同 `buildHoldResumeArgs` 的理由）：
 * 续跑可能发生在跨零点之后，字面量 `yesterday` 那一刻会解析成另一天。
 *
 * 刻意**不传** `--only`（阶段级筛选）：分批驱动没有这个概念（它自己按批分配证据目录）。
 * 整轮被挡那一档本来也没有逐店阶段可点。
 */
export function buildBatchResumeArgv({
  batchScript, date, batchSize = null, shops = null, logs = null, notify = true, noHold = true,
} = {}) {
  const argv = [batchScript, '--date', date, '--commit'];
  if (batchSize !== null && batchSize !== undefined) argv.push('--batch-size', String(batchSize));
  argv.push(notify ? '--notify' : '--notify-print');
  if (Array.isArray(shops) && shops.length) argv.push('--shops', shops.join(','));
  if (logs) argv.push('--logs', logs);
  if (noHold) argv.push('--no-hold');
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
export function closeOutNotice({ date, subjects = [], until = null, targetLabel = '日报一轮', createdAt } = {}) {
  const who = subjects.length ? subjects.join('、') : '这一轮';
  // 截止时间是**算出来的**（`resolveHoldDeadline` 给出 `untilText`），不在这里回落到一个写死的钟点 ——
  // 写死的那个（旧的 `'12:00'`）与实际挂到的时刻不是一回事，而这条通知的作用恰恰是告诉人「几点了」。
  // 调用方没给就退成一句不含数字的话：宁可少一个数字，也不写一个错的。
  const deadlineText = until ?? '约定时间';
  return noticeBase({
    type: 'DAILY_HOLD_TIMEOUT',
    severity: 'ERROR',
    title: `${who}的日报还缺着：等到 ${deadlineText} 也没等到处理`,
    alertId: `daily-hold-${String(date).replace(/-/gu, '')}`,
    fingerprint: 'HOLD_TIMEOUT',
    date,
    targetLabel,
    shopNames: subjects,
    reason: `这一轮的浏览器窗口一直留着没关，等到 ${deadlineText} 还是没等到人来处理，所以按约定把窗口放掉、这一轮结束了，这一天的数据还是没有进飞书。`,
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
