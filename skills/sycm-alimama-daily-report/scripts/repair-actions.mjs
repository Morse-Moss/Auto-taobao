/**
 * 「可执行的修复动作」—— agent 修复回环里的**手**（2026-09-29）。
 *
 * 它要解决的问题（承 2026-09-28 的两层）：
 *   感知层（`failure-perception.mjs`）把失败落成**事实**（页面当时什么样）；
 *   分诊表（`remediation-table.mjs`）把失败归成**方向**（重试 / 重试并等待 / 交给人）。
 *   但「重试」这个词还不完整 —— 出问题的那一步往往需要**先对页面做一件事**才有资格重试：
 *   关掉挡住整页的弹窗、把页签归位、真重载一次、把日期重新落上去。
 *   这三层合起来才是用户要的那句：**「让 agent 根据失败原因去修复，再重试」**。
 *
 * 分工（本模块只负责第一半）：
 *   · **判断**（这一处该怎么修）→ 留给 agent：它读 `98-failure-state.json` 的事实与本模块给的
 *     **候选菜单**（`planRepair`），挑一个动作名。
 *   · **执行**（这个动作具体怎么做）→ 由 `repair-shop-stage.mjs` 落到真实页面上。
 *   本模块**不替 agent 做决定**，也不碰浏览器：它是纯数据 + 纯函数，所以能被离线完全断言。
 *
 * 三条纪律（与感知层、分诊表同一个立场）：
 *   1) **动作名是闭集**。拼错一个名字不许静默变成「什么也没做」—— 那会让「修了」与「没修」
 *      长得一样。加载期有互锁（`validateRepairActions`）钉住。
 *   2) **候选不是命令**。`planRepair` 返回的是「值得一试的动作 + 为什么值得试」，
 *      它**不保证有效**；有效性由执行后的**回读**判定（`repair-shop-stage.mjs` 落 97-repair.txt）。
 *      这一步不能省：本项目反复吃过的亏就是「自己说成了」。
 *   3) **默认空菜单**。成因认不出来 / 没有已知修法 ⇒ 返回空候选，而不是猜一个动作。
 *      猜出来的动作会往真实页面上做一件没人要求的事，比不修更危险。
 *
 * 依赖方向：本文件**零 import**，不依赖任何 `skills/` 或 `runtime/` 下的东西，
 * 因此不产生跨目录依赖边（`runtime/arch-boundary.test.mjs` 不会因它变红）。
 */

/**
 * 可以执行的修复动作。**闭集**：写错名字会在加载期互锁里报错。
 *
 * 说明为什么是这四个（每一个都必须是**幂等**且**无端到端副作用**的页面操作）：
 *   · `DISMISS_OVERLAYS` —— 关掉盖住整页的弹窗（`wrapper_dlg_*` 一族）。
 *     关不掉时动作本身会如实返回 `dismissed:false`，不会假装修好。
 *   · `RESET_PAGES` —— 把页签按期望清单归位（复用 `runtime/page-normalize.mjs`）。
 *     它只动页签、不动数据。
 *   · `RELOAD_PAGE` —— 对目标页发一次**真重载**。为什么必须单独一个动作：
 *     `navigate` 到相同 URL 是「同文档导航」，浏览器什么都不做（本项目 09-21 实测），
 *     所以「重来一次」这件事只能靠真 reload。
 *   · `REAPPLY_DATES` —— 重跑落位（把日期重新落到页面上）。人在驻留期间动过页面、
 *     或页面被我们自己重载过之后，日期筛选就已经不在原处了。
 *
 * 刻意**不在这里**的动作：
 *   · 任何写飞书的动作（那是链自己的阶段，不是「修复」）；
 *   · 任何登录动作（登录要么自动走 `login-merchant.mjs`、要么交给人，不混进修复菜单）；
 *   · 任何「点页面上的业务按钮」的动作（那可能产生平台侧副作用，必须由阶段自己决定）。
 */
export const REPAIR_ACTIONS = Object.freeze([
  'DISMISS_OVERLAYS', 'RESET_PAGES', 'RELOAD_PAGE', 'REAPPLY_DATES',
]);

/**
 * 一个动作是不是「动页面内容的」。
 *
 * 为什么要有这个分类：`DISMISS_OVERLAYS` 与 `RELOAD_PAGE` 会改变页面状态，执行前要
 * **先确认目标页是谁**（不能对着别的店的窗口做）；而 `RESET_PAGES` 本身就是归位，是安全的。
 * 执行侧（`repair-shop-stage.mjs`）拿它决定要不要先做一次身份/目标核对。
 */
export const PAGE_MUTATING_ACTIONS = Object.freeze(['DISMISS_OVERLAYS', 'RELOAD_PAGE', 'REAPPLY_DATES']);

/**
 * 成因 → 值得一试的修复动作（有序：越靠前越先试）。
 *
 * ⚠️ 这里给的是**候选**，不是「一定会这么做」。真正的选择权在 agent（读现场后决定），
 * 或者在没有人时的默认推进顺序（按本表的顺序逐个试）。
 *
 * 为什么每个成因给的候选不多：候选越多，盲试的代价越大（每试一个都要真实操作页面 + 回读）。
 * 每个成因只给「按本项目历史最可能有效」的一到两个。
 *
 * 键被 `remediation-table.test.mjs` 的同一个互锁思路钉住：本表**允许**只覆盖一部分成因
 * （认不出来的成因返回空候选，那是安全的默认），但**不许出现 `FAILURE_CAUSES` 之外的名字**
 * —— 那说明两套分类已经漂开，而漂开之后本表永远命中不了、且不会报错。
 */
export const REPAIR_TABLE = Object.freeze({
  // 全屏遮挡层：先关层；关不掉换个现场再来（重载）。两条都试完仍失败 ⇒ 交给人。
  PAGE_OBSTRUCTED: Object.freeze(['DISMISS_OVERLAYS', 'RELOAD_PAGE']),
  // 页面不齐：先归位；归位不成，人补页之前先重载一次试试（有的缺页是渲染没起来）。
  SHOP_BLOCKED: Object.freeze(['RESET_PAGES', 'RELOAD_PAGE']),
  // 落位类失败（日期没落上去 / 页签没激活）：重新落位；不行就重载后重来。
  STAGE_FAILED: Object.freeze(['REAPPLY_DATES', 'RELOAD_PAGE']),
});

/**
 * 阶段名 → 该阶段最相关的「目标页」提示（供执行侧定位要修哪一页）。
 *
 * 刻意不在这里写选择器或 URL —— 那些是各脚本自己的知识，写在这里就会两处漂移。
 * 这里只给一个**语义标签**，执行侧按标签去解析真实页面（解析不到就如实报错、不猜）。
 */
export const STAGE_PAGE_HINT = Object.freeze({
  'alimama-date': 'alimama',
  'promotion-submit': 'alimama',
  'promotion-fetch': 'alimama',
  'sycm-date': 'sycm',
  'sycm-date-again': 'sycm',
  'shop-report': 'sycm',
  'sycm-reset': 'sycm',
  backfill: 'sycm',
});

/**
 * 给定一次失败，返回**候选修复**（菜单）。**永不抛**。
 *
 * 返回结构刻意固定，便于离线断言与 agent 消费：
 *   { cause, stage, candidates: [{ action, mutating, why }], known: boolean }
 *
 * 三条口径：
 *   ① 认不出的成因 ⇒ `candidates: []`、`known: false`。**不猜动作**（见纪律 3）。
 *   ② 成因认识但当前阶段没有页面提示 ⇒ 候选照给，但 `stageHint: null`；
 *      执行侧要能处理「没有提示」这一档（如实记「不知道修哪一页」，而不是随便挑一页）。
 *   ③ 若调用方传了现场事实（`state`），**把明显的矛盾指出来**（如「现场是登录页」却想重载），
 *      但仍不替 agent 否决 —— 只多给一个 `note`，让 agent 自己判。
 *
 * @param {{cause?:string, stage?:string, state?:object|null}} o
 * @returns {{cause:string|null, stage:string|null, stageHint:string|null,
 *            candidates:Array<{action:string,mutating:boolean,why:string}>, known:boolean, note:string|null}}
 */
export function planRepair({ cause = null, stage = null, state = null } = {}) {
  const actions = REPAIR_TABLE[cause];
  if (!actions) {
    return {
      cause: cause ?? null, stage: stage ?? null, stageHint: null, candidates: [], known: false,
      note: cause
        ? `成因「${cause}」没有登记修法 ⇒ 不给候选（不猜动作），交给人。`
        : '没给成因 ⇒ 不给候选（不猜动作），交给人。',
    };
  }
  const candidates = actions.map((action) => ({
    action,
    mutating: PAGE_MUTATING_ACTIONS.includes(action),
    why: REPAIR_WHY[action] ?? '',
  }));
  return {
    cause, stage: stage ?? null, stageHint: STAGE_PAGE_HINT[stage] ?? null,
    candidates, known: true, note: noteForState(state),
  };
}

/**
 * 每个动作「为什么值得一试」的一句话。与 `REPAIR_ACTIONS` 的注释同源，
 * 单独抽出来是为了让 `planRepair` 的返回里能带着它（agent 读的是这一份）。
 */
export const REPAIR_WHY = Object.freeze({
  DISMISS_OVERLAYS: '平台的全屏弹窗可能正盖住整页、让控件点不到；关掉它再重试。',
  RESET_PAGES: '页签可能被前一步带走或漂到别处；按期望清单归位再重试。',
  RELOAD_PAGE: '这一份渲染上元素不理会点击（本项目实测过的形态）；真重载换个新现场再试。',
  REAPPLY_DATES: '页面上的日期筛选可能已经不在目标日（重载/人动过之后常见）；重新落位再试。',
});

/**
 * 用现场事实给一句「值得注意」的话。**只提示，不否决**。
 *
 * 最有价值的一种：现场 URL 已经是登录页 —— 那么「重载页面」「关遮挡」都注定没用，
 * 真正要做的是登录（那不在修复菜单里）。把它说出来，agent 就不必自己再推一遍。
 */
function noteForState(state) {
  if (!state || typeof state !== 'object') return null;
  const url = String(state.url ?? '');
  if (/login\.htm|member\/login|havanalogin|mini_login/u.test(url)) {
    return '现场是登录页 ⇒ 页面类修复（关遮挡/重载/落位）都不会有效，真正要做的是登录。';
  }
  const empty = Number(state.domSummary?.totalElements ?? -1);
  if (empty === 0) return '现场页面几乎是空的（0 个元素）⇒ 可能是还没渲染完或页签被换走了。';
  return null;
}

/**
 * 加载期互锁：本表的动作名与成因名都在各自的闭集里，且每个候选都查得到 why。
 *
 * 检查四件事，任一条不成立都返回错误清单：
 *   ① 每个动作名都在 `REPAIR_ACTIONS` 里（防拼错）；
 *   ② 每个成因名都在传入的 `causes`（＝链的 `FAILURE_CAUSES`）里（防分类漂开）；
 *   ③ 每个候选都查得到 why（防「给了动作但说不清为什么」）；
 *   ④ 每个 `STAGE_PAGE_HINT` 的键都在传入的 `stages`（＝链的 `STAGE_NAMES`）里（防阶段名漂开）。
 *
 * 为什么把 `causes` / `stages` 做成参数而不是在这里 import：本模块必须零 import
 * （否则产生 skills 内部又一个依赖边），而那两个闭集在 `run-multi-shop-day.mjs` 里。
 * 调用方（测试）把它们传进来即可 —— 这正是「纯函数 + 依赖注入」的用法。
 */
export function validateRepairActions({ causes = null, stages = null } = {}) {
  const errors = [];
  for (const [cause, actions] of Object.entries(REPAIR_TABLE)) {
    if (Array.isArray(causes) && !causes.includes(cause)) {
      errors.push(`成因「${cause}」不在链的 FAILURE_CAUSES 里（两套分类漂开了）`);
    }
    if (!Array.isArray(actions) || actions.length === 0) {
      errors.push(`成因「${cause}」的候选为空（登记了成因却没有动作）`);
      continue;
    }
    for (const action of actions) {
      if (!REPAIR_ACTIONS.includes(action)) {
        errors.push(`成因「${cause}」里的动作「${action}」不在闭集 ${REPAIR_ACTIONS.join('/')} 里`);
      }
      if (!REPAIR_WHY[action]) errors.push(`成因「${cause}」的动作「${action}」缺 why`);
    }
  }
  if (Array.isArray(stages)) {
    for (const stage of Object.keys(STAGE_PAGE_HINT)) {
      if (!stages.includes(stage)) {
        errors.push(`STAGE_PAGE_HINT 里的阶段「${stage}」不在链的 STAGE_NAMES 里`);
      }
    }
  }
  // 每个动作都该在至少一个成因的候选里出现，否则它是死代码（登记了却永远用不到）。
  for (const action of REPAIR_ACTIONS) {
    const used = Object.values(REPAIR_TABLE).some((list) => list.includes(action));
    if (!used) errors.push(`动作「${action}」在任何成因的候选里都没出现（死动作）`);
  }
  return errors;
}
