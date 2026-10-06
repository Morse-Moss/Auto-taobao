/**
 * 「已知问题的处理表」—— 失败分诊的记忆层（2026-09-28）。
 *
 * 它要解决的问题（第一性原理）：
 *   同一类错误**第二次出现时不能被当成第一次处理**。没有这张表，每次失败都从零判断
 *   ⇒ 每次都要人（或模型）重新看一遍 ⇒ 这就是「每天要跑通都得我多轮对话」的成本来源。
 *   有了它，第一次处理过的情形，第二次可直接查表执行已知动作，**不叫人、不问模型**。
 *
 * 三条设计纪律：
 *   1) **表的键必须是既有闭集**（`run-multi-shop-day.mjs` 的 `FAILURE_CAUSES`），
 *      不许在这里另造一套分类 —— 两套分类迟早漂开，漂开那天就是「这张表永远命中不了」，
 *      而它不会报错，只会安静地退化成「每次都叫人」。加载期有互锁钉住这件事。
 *   2) **表的默认值是「叫人」，不是「自动处置」**。fail-closed：查不到 ⇒ 交给人。
 *      反过来（默认自动处置）会让「没登记过的新问题」被一个猜出来的动作处理，
 *      这比不处理更危险。
 *   3) **`auto` 动作必须是幂等且可判定的**。能登记的自动处置只有那几种
 *      「做了不会有副作用、不做也不会有副作用」的（重试 / 重跑阶段）。
 *      凡是对外部系统有副作用、或需要凭据/人手的，一律 `human`。
 *
 * 本模块是**纯数据 + 纯函数**：不 import 任何东西、不读文件、不产生副作用，
 * 所以它能被离线完全断言（含「动作名拼错」「分类漂开」这类）。
 */

/**
 * 可以自动执行的处置动作。**闭集**：写错名字会在加载期互锁里报错，
 * 而不是安静地变成「什么也没做」——后者会让「自动修了」与「没修」长得一样。
 *
 * 说明为什么只有这几个：
 *   · `RETRY_STAGE` —— 原样重跑失败的那一步。幂等的前提是该步自身幂等
 *     （本链的 `promotion-submit` 有台账、`push` 有同日去重闸门，都已保证重跑安全）。
 *   · `RETRY_WITH_SETTLE` —— 等一段时间再重跑那一步。用于「平台侧还没出数 / 页面还在重排」
 *     这类「等一等就会好」的失败。等待时长由条目自己给，不许在这里写死一个全局值。
 *   · `HUMAN` —— 交给人。它不是「失败」，是**如实承认这个我修不了**。
 */
export const REMEDIATION_ACTIONS = Object.freeze(['RETRY_STAGE', 'RETRY_WITH_SETTLE', 'HUMAN']);

/**
 * 已知问题表。键 = `FAILURE_CAUSES` 里的成因名；值 = 处置方案。
 *
 * 每条要写清楚两件事：**为什么可以自动/为什么必须人** + **做了之后怎么判定成了**。
 * 少了第二件的自动处置等于「自己说成了」——本项目反复吃过的亏（缺独立判定）。
 */
export const REMEDIATION_TABLE = Object.freeze({
  // 那一天飞书里已经有数据了。**不用做任何事**。它不是失败，是「今天已经跑过了」。
  // 之所以要一条显式条目而不是靠兜底：兜底是「叫人」，而这一类的正确处置是「不叫人」——
  // 每天为它喊一次狼来了，正是把注意力磨没的方式（2026-09-28 那轮真实发生）。
  DUPLICATE_TARGET: Object.freeze({
    action: 'HUMAN',            // 字面是「交给人」，但下面的通知级别把它降成「不打扰」
    notifyLevel: 'silent',
    why: '同一天同店铺已有行 ⇒ 数据已经在飞书里，不需要任何动作。',
    verify: '无需验证：底单该日该店的行存在即证明。',
  }),

  // 平台**这一天就没有这一行**（`inquiry-core` 的 `SOURCE_NO_ROW_FOR_DATE`，2026-10-06 加）。
  // **同样不用做任何事** —— 与上面那条同形，理由也同源：不叫人、不驻留。
  //
  // 2026-10-05 `网林家居` 现场：生意参谋「询单到付款」对该店该日返回空态「暂无数据」，
  // 于是这一天的「询单量 / 同层同行询单量」注定是空的（同店同实例只换日期，`10-04` 就有数据）。
  // 为什么不能落回兜底（兜底是 `human`）：兜底那句会让人「把这条消息转给技术同学」，
  // 而技术同学到了现场也做不了任何事；更贵的是 `notifyLevel` 还兼作**驻留判据**的输入
  // （见 `run-multi-shop-day.mjs` 的 `buildRepairRequest.noActionRequired`）——
  // 落成 human 的代价不止一条告警，还有每天早上白挂几小时。
  SOURCE_NO_ROW_FOR_DATE: Object.freeze({
    action: 'HUMAN',            // 字面是「交给人」，但下面的通知级别把它降成「不打扰」
    notifyLevel: 'silent',
    why: '平台这一天就没有出这一行（表格显示「暂无数据」），不是脚本读不到、也不是数据为 0 '
      + '⇒ 重试、修页面、人去平台都变不出来。',
    verify: '无需验证：这一天底单行里「询单量 / 同层同行询单量」为空，即为已知且无解的缺口。',
  }),

  // 平台自己的全屏弹窗盖住整页、试过关法没关掉。**需要人去关**。
  // 为什么不能自动重试：遮挡层关不掉时重试只会再失败一次，白等一轮。
  PAGE_OBSTRUCTED: Object.freeze({
    action: 'RETRY_STAGE',
    notifyLevel: 'human',
    why: '遮挡层由 1.7.4 的自动关闭逻辑处理；走到这里说明自动关闭已试过且失败，'
      + '但**驻留机制会把窗口留住等人关**，所以这一轮的重试由驻留续跑承担。',
    verify: '重跑该阶段 exit 0 且后续阶段正常推进。',
  }),

  // 掉登录。**只能人登**（本链没有自动登商家浏览器的能力）。
  NEEDS_LOGIN: Object.freeze({
    action: 'HUMAN',
    notifyLevel: 'human',
    why: '登录态失效，本链没有自动登商家浏览器的能力（1.7.0 明确押后）。',
    verify: '人登后由驻留续跑，或下一个周期自然恢复。',
  }),

  // 「店铺绩效」订购不在账号上。**要人去平台找回来**，不是浏览器里的事。
  SHOP_FUNC_NO_PERMISSION: Object.freeze({
    action: 'HUMAN',
    notifyLevel: 'human',
    why: '要靠人去生意参谋把订购找回来；重试多少次都不会变。',
    verify: '人处理后在平台上能看到该功能页。',
  }),

  // 这家店的窗口里页面不齐（体检阻断）。
  SHOP_BLOCKED: Object.freeze({
    action: 'RETRY_STAGE',
    notifyLevel: 'human',
    why: '体检发现页面不齐。归位逻辑会自愈一部分；剩下的需要人补页。',
    verify: '重跑体检 exit 0（阻断项为 0）。',
  }),

  // 整轮被挡（一轮级体检不过）。**不是逐店结论**，由 hold-and-resume 单独判。
  ROUND_BLOCKED: Object.freeze({
    action: 'HUMAN',
    notifyLevel: 'human',
    why: '整轮被挡，成因只有「掉登录」与「页面真缺」两种，都只有人能解除。',
    verify: '人处理后再跑一轮。',
  }),

  // 整轮被挡的**具体成因**：共用窗口自己掉登录（2026-10-05/06 那轮的现场）。
  // 与 ROUND_BLOCKED 的区别只在「指路」：这一条要人登的是**那一个共用窗口**（19022/19023，
  // 就是开着飞书「各店铺日报」表格的那个），不是各店自己的窗口 —— 指错窗口比不指更贵。
  // 处置与判定同 ROUND_BLOCKED（本链没有自动登商家浏览器的能力，只有人能解除）。
  ROUND_LOGIN_WALL: Object.freeze({
    action: 'HUMAN',
    notifyLevel: 'human',
    why: '共用窗口掉登录 ⇒ 采集页一打开就被送回登录页，整轮一步都跑不了；只有人能登。',
    verify: '人登后由驻留续跑，或下一个周期自然恢复。',
  }),

  // 兜底：成因不明。**默认叫人**（fail-closed）。
  // 这一条是整张表的安全底座：任何时候它命中，都意味着「又出现了一个没见过的问题」，
  // 而「没见过的问题」正是最该让人看的那一类。
  STAGE_FAILED: Object.freeze({
    action: 'HUMAN',
    notifyLevel: 'human',
    why: '成因不明的阶段失败。按 fail-closed 交给人 —— 这正是新问题该出现的地方。',
    verify: '人判断后，若可复用则应向本表补一条更具体的成因。',
  }),
});

/**
 * 查一次失败该怎么处置。**永不抛**：查不到也返回「叫人」。
 *
 * @param {string} cause  `FAILURE_CAUSES` 里的成因（由 `shopFailureCause` 产出）
 * @returns {{cause:string, action:string, notifyLevel:string, why:string, verify:string, known:boolean}}
 */
export function lookupRemediation(cause) {
  const entry = REMEDIATION_TABLE[cause];
  if (!entry) {
    // 未登记的成因 ⇒ fail-closed 交给人。**刻意不抛**：查表失败不该再制造一个新错误。
    return {
      cause: cause ?? null, action: 'HUMAN', notifyLevel: 'human', known: false,
      why: `未登记成因「${cause ?? '(空)'}」⇒ 按 fail-closed 交给人。`,
      verify: '人判断后向 REMEDIATION_TABLE 补登记。',
    };
  }
  return { cause, known: true, ...entry };
}

/**
 * 把一批失败条目分诊成「不用打扰人」与「要叫人」两堆。
 *
 * 这是注意力真正被释放的地方：**不是替人做事，而是替人挡掉不需要他看的事**。
 * 返回结构刻意固定（两数组 + 计数），便于离线断言与后续接告警。
 *
 * @param {Array<{key:string, record:object, cause:string}>} failed  `roundFailureSummary` 的 `failed`
 */
export function triageFailures(failed = []) {
  const silent = [];
  const needsHuman = [];
  for (const item of failed) {
    const plan = lookupRemediation(item?.cause);
    const row = { ...item, plan };
    if (plan.notifyLevel === 'silent') silent.push(row);
    else needsHuman.push(row);
  }
  return { silent, needsHuman, total: failed.length,
    silentCount: silent.length, needsHumanCount: needsHuman.length };
}

/**
 * 加载期互锁用的自检（纯函数，供测试与任何调用方在启动时跑一次）。
 *
 * 检查三件事，任一条不成立都返回错误清单：
 *   ① 表里每个动作名都在 `REMEDIATION_ACTIONS` 里（防拼错）；
 *   ② 表里每个 `notifyLevel` 都是 `silent` / `human`（防写错导致「该叫人却不叫」）；
 *   ③ 每个条目都有 `why` 与 `verify`（防「自动处置但没有判定方式」）。
 *
 * 为什么要有它：这三类错误**都不会在运行时抛**，只会安静地把行为改成别的样子
 * （拼错的动作用不了、写错的级别不叫人、缺 verify 的自动处置等于自证）。加载期挡住最便宜。
 */
export function validateRemediationTable(table = REMEDIATION_TABLE) {
  const errors = [];
  for (const [cause, entry] of Object.entries(table)) {
    if (!REMEDIATION_ACTIONS.includes(entry?.action)) {
      errors.push(`${cause}: 动作名「${entry?.action}」不在闭集 ${REMEDIATION_ACTIONS.join('/')} 里`);
    }
    if (!['silent', 'human'].includes(entry?.notifyLevel)) {
      errors.push(`${cause}: notifyLevel「${entry?.notifyLevel}」不是 silent/human`);
    }
    if (!entry?.why) errors.push(`${cause}: 缺 why（为什么这样处置）`);
    if (!entry?.verify) errors.push(`${cause}: 缺 verify（怎么判定处置成了）`);
  }
  return errors;
}
