// 全仓统一提醒词表：**每条流程的收信人看到的每一个词**都只在这里定义一次。
//
// 为什么要有这一层（2026-10-13 用户定稿，docs/ops/FEISHU-ALERT-UNIFIED-DESIGN.md）：
//   ① 四条流程（店铺日报 / 推广日报 / 商品数据 / 周报）的标题第一段必须是固定流程名，
//      收信人扫一眼就知道「是哪条流程的事」，不用点开正文猜；
//   ② 成功与失败必须分开：成功只提醒业务人员查收（纯业务、**不带技术定位块**），
//      失败用两段式（第一段业务语言，第二段「以下是给技术同学的定位信息」）；
//   ③ 技术定位块的字段收敛到五个（runId / 证据目录 / 机读阶段名 / 退出码 / 版本），
//      **不放机器名** —— 单机无定位价值，且 2026-10-06 已定「按窗口标题找，不按 hostname 找」。
//
// 依赖方向：本文件只 import `runtime/notify-feishu-core.mjs`（同一层的渲染白名单），
// **不 import skills/ 下任何东西**（`runtime/arch-boundary.test.mjs` 会红）。
// 日报链那三张词表（原因/下一步/续跑承诺）整体并入 daily 分支，**一字不改** ——
// 它们是这个仓库里最讲究的一份资产（11 类结论各有各的措辞），重写只会引入漂移。
//
// 本文件不做的事：不判要不要发（那是 dispatch/dedup 的职责）、不碰 IO、不起进程。

import { TECH_BLOCK_KEYS } from './notify-feishu-core.mjs';

// ---------------------------------------------------------------------------
// 一、四条流程
// ---------------------------------------------------------------------------

/**
 * 流程登记（键 = `runtime/workflow-catalog.mjs` 的 workflow id，逐字一致）。
 *
 *   · `label`   标题第一段的方框词，也是 capability 的运营叫法；
 *   · `short`   标题里指这一份数据时的短名（「盖文淘宝的推广还缺着」）；
 *   · `periodLabel`  「统计日 / 业务日 / 周期」—— 同一条链对不同收信人有不同叫法；
 *   · `idPrefix` 告警编号域的前缀（`<flow>-ok-<业务日>` / `<flow>-round-<业务日>`）。
 */
export const FLOWS = Object.freeze({
  'daily-report': Object.freeze({
    key: 'daily-report', label: '店铺日报', short: '日报', periodLabel: '统计日',
    capability: '店铺日报', idPrefix: 'daily',
  }),
  'promotion-daily': Object.freeze({
    key: 'promotion-daily', label: '推广日报', short: '推广', periodLabel: '业务日',
    capability: '推广日报', idPrefix: 'promotion',
  }),
  'product-daily': Object.freeze({
    key: 'product-daily', label: '商品数据', short: '商品数据', periodLabel: '统计日',
    capability: '商品数据', idPrefix: 'product',
  }),
  'weekly-report': Object.freeze({
    key: 'weekly-report', label: '周报', short: '周报', periodLabel: '周期',
    capability: '周报', idPrefix: 'weekly',
  }),
});

/** 取一条流程登记。**未登记当场抛错，绝不回退到默认流程** —— 回退的表现是「跑完了，但叫的是另一条流程」。 */
export function flowOf(workflow) {
  const flow = FLOWS[workflow];
  if (!flow) {
    throw new Error(`未登记的流程：${JSON.stringify(workflow ?? null)}（已登记：${Object.keys(FLOWS).join('、')}）`
      + ' —— 拒绝回退到任何默认流程，请先在 runtime/alert-copy.mjs 的 FLOWS 里登记');
  }
  return flow;
}

/** `2026-10-12` → `20261012`（告警编号里只用这一种日期形状）。 */
export function dateStampOf(date) {
  return String(date ?? '').replace(/-/gu, '');
}

// ---------------------------------------------------------------------------
// 二、完成通知（INFO，纯业务，**不带技术定位块**）
// ---------------------------------------------------------------------------

/**
 * 一轮全部成功后的「请查收」。
 *
 * 三条不能省的口径：
 *   ① **只在该轮真的跑了 ≥1 个采集对象时调用**。整部门停采时 0 对象跑完也发「完成」是纯噪声
 *      （设计文档 §5.1）；
 *   ② 数字由调用方给，且**必须来自独立回读/写后回读**，不许来自链的自报成功计数
 *      （2026-10-13 用户定稿第 5 条）。本函数不校验数字的来源 —— 那是调用方的用例钉的事；
 *   ③ 部分成功**不要**调它：按失败告警走（设计文档 §5.1 第三行）。
 *
 * `tables` 形如 `[{ name: '底单', rows: 8 }]`，空数组时「写了哪几张表」那一行整行不输出。
 * `recovered` = 同业务日早先发过失败告警、现在补齐了 ⇒ 改发「已恢复」而不是「完成」
 * （设计文档 §5.1 第二行：编号从 `<flow>-round-<日>` 换成 `<flow>-ok-<日>`，编号不同 ⇒ 一定发）。
 */
export function buildFlowOkAlert({
  flow: workflow, date, shops = [], okCount = null, total = null, tables = [], recovered = false,
  now = () => new Date(),
} = {}) {
  const flow = flowOf(workflow);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(date ?? ''))) {
    throw new Error(`buildFlowOkAlert 需要 YYYY-MM-DD 的业务日，收到 ${JSON.stringify(date ?? null)}`);
  }
  const ran = Number.isFinite(total) ? total : shops.length;
  const ok = Number.isFinite(okCount) ? okCount : ran;
  if (ran < 1) {
    throw new Error('buildFlowOkAlert 要求这一轮至少跑了 1 个采集对象（0 对象时发「完成」是噪声）');
  }
  const when = now();
  const shopNames = (Array.isArray(shops) ? shops : []).filter(Boolean);
  const tablePart = (Array.isArray(tables) ? tables : [])
    .filter((entry) => entry && entry.name && Number.isFinite(Number(entry.rows)))
    .map((entry) => `${entry.name} ${Number(entry.rows)} 行`);
  const reason = [
    recovered ? '今天早些时候这一流程有一次没收齐，现在已全部收齐。' : null,
    `${ok}/${ran} 家全部收齐。`,
    tablePart.length ? `写了：${tablePart.join('、')}。` : null,
  ].filter(Boolean).join('');
  return {
    type: recovered ? 'ROUND_RESOLVED' : 'FLOW_COMPLETED',
    severity: 'INFO',
    title: recovered
      ? `【${flow.label}】已恢复（${flow.periodLabel} ${date}）`
      : `【${flow.label}】采集完成（${flow.periodLabel} ${date}）`,
    // 同一天同一轮共用一条锚；是否重复投递由调用方的 resolveAlertDedup 判（投递链本身不去重）。
    alertId: `${flow.idPrefix}-ok-${dateStampOf(date)}`,
    // 指纹 = 成功数/总数。同一业务日重复成功 ⇒ 6 小时窗口内挡掉（设计文档 §7.2）。
    fingerprint: `${ok}/${ran}`,
    createdAt: when.toISOString(),
    reason,
    action: '无需处理。',
    source: {
      targetLabel: shopNames.length ? `${flow.label}一轮 · ${ran} 家店` : `${flow.label}一轮`,
      period: `${flow.periodLabel} ${date}`,
      capability: flow.capability,
      shopName: shopNames.length ? shopNames.join('、') : null,
    },
    // **故意不带 tech**：成功通知是给业务收信人的，技术定位块只在失败时出现
    //（2026-10-13 用户定稿第 1 条）。
  };
}

// ---------------------------------------------------------------------------
// 三、技术定位块（只出现在失败告警的第二段）
// ---------------------------------------------------------------------------

/**
 * 组装技术定位块。**白名单在校验处连查两遍**：
 *   ① 键必须在 `notify-feishu-core` 的 `TECH_BLOCK_KEYS` 里 —— 多给一个键意味着
 *      渲染时被静默丢掉（收信人看不到，而你以为发出去了）；
 *   ② 值里不许出现机器名/登录名一类的东西 —— 这一块是给技术同学的，但**机器名仍然不放**
 *      （单机无定位价值；2026-10-06 已定「按窗口标题找，不按 hostname 找」）。
 *
 * 全空（一个值都没有）时返回 `null`：调用方据此不挂这个块，而不是挂一个只有小标题的空段。
 */
const TECH_FORBIDDEN_VALUE = /hostname|机器名|DESKTOP-|Administrator/iu;

export function buildTechBlock(fields = {}) {
  const given = fields && typeof fields === 'object' ? fields : {};
  const unknown = Object.keys(given).filter((key) => !TECH_BLOCK_KEYS.includes(key));
  if (unknown.length) {
    throw new Error(`技术定位块里有渲染器不认识的键（${unknown.join('、')}）—— `
      + `白名单只有：${TECH_BLOCK_KEYS.join('、')}。要么改白名单，要么别给。`);
  }
  const out = {};
  for (const key of TECH_BLOCK_KEYS) {
    const value = String(given[key] ?? '').trim();
    if (!value) continue;
    if (TECH_FORBIDDEN_VALUE.test(value)) {
      throw new Error(`技术定位块的 ${key} 里出现了机器名一类的值（${value}）—— `
        + '这一块不放机器名：按窗口标题找，不按 hostname 找。');
    }
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// 四、daily 分支：从日报链整体并入的三张词表（一字不改）
// ---------------------------------------------------------------------------

// 以下三张表 + 两个闭集 2026-10-13 从 `skills/sycm-alimama-daily-report/scripts/
// run-multi-shop-day.mjs` 原样搬来（连同注释）。搬移的理由：全仓统一词表只能有一个落点，
// 而 skills 下的模块不许被 runtime 反向依赖 ⇒ 数据住 runtime，链那边 re-export。
// 原文件保留同名 re-export，`remediation-table.test.mjs` / `repair-actions.test.mjs`
// 与 `scripts/hold-and-resume.mjs` 的 import 一行不用改。

/** 结论的闭集。分类函数、原因表、下一步表必须覆盖**同一个**集合（互锁在文件末尾）。 */
export const DAILY_FAILURE_CAUSES = Object.freeze(
  ['ROUND_BLOCKED', 'ROUND_LOGIN_WALL', 'SHOP_BLOCKED', 'NEEDS_LOGIN', 'DUPLICATE_TARGET', 'SHOP_FUNC_NO_PERMISSION',
    'PAGE_OBSTRUCTED', 'SOURCE_NO_ROW_FOR_DATE', 'INQUIRY_ROW_MISSING', 'STAGE_FAILED'],
);

/**
 * **逐店**的失败里，哪几种只有人动手才能解除（驻留与自动续跑只对这几类开）。
 * 它是 `DAILY_FAILURE_CAUSES` 的子集，由加载期那条互锁与用例一起钉住。
 */
export const DAILY_HUMAN_REQUIRED_CAUSES = Object.freeze(['NEEDS_LOGIN', 'PAGE_OBSTRUCTED']);

/** 收信人看到的「为什么没跑成」。只用业务词，不写英文阶段名、不写内部代号。 */
export const DAILY_REASON_BY_CAUSE = Object.freeze({
  ROUND_BLOCKED: '整轮没开跑：那个开着飞书「各店铺日报」的浏览器窗口里，页面不齐。',
  ROUND_LOGIN_WALL: '整轮没开跑：那个共用窗口自己掉登录了 —— 采集页面一打开就被平台送回登录页，'
    + '所以这几家一起没跑起来。',
  SHOP_BLOCKED: '这家店的专用窗口里页面不齐，所以这家店一步都没跑。',
  NEEDS_LOGIN: '这家店的后台掉登录了 —— 采集页面一打开就被平台送回了登录页，开几个都一样，所以没跑成。',
  DUPLICATE_TARGET: '这一天飞书里已经有数据了，脚本按「不许写第二遍」停住了。',
  SHOP_FUNC_NO_PERMISSION: '这家店在生意参谋里的「店铺绩效」现在不在账号上（平台按店铺开通的一项），所以采集页面一打开就被平台送回首页，这一天的数据没进飞书。',
  PAGE_OBSTRUCTED: '这家店的页面上弹出了一个盖住整页的活动弹窗，脚本按过 Esc、也按过「关闭」这一类按钮，都没能把它关掉，所以停在那儿没往下跑，这一天的数据没进飞书。',
  SOURCE_NO_ROW_FOR_DATE: '这家店在生意参谋里的「询单到付款」这一张表，这一天平台自己就没有出数据（表格显示「暂无数据」），'
    + '所以「询单量 / 同层同行询单量」这两列这一天是空的，其余字段都写进去了。',
  INQUIRY_ROW_MISSING: '这一天的数据采集是好的（底单那一行已经写进飞书了），但「各店铺数据日报」那张表里'
    + '这一天的这一行还没有建出来，所以「询单量 / 同层同行询单量」这两列没地方写。',
  STAGE_FAILED: '这家店跑到一半停住了，这一天的数据没进飞书。',
});

/** 「做完不用回复、系统会自己继续」——**只在真的有驻留进程时才能说**（由调用方用 `willResume` 说了才算数）。 */
export const DAILY_RESUME_SENTENCE = Object.freeze({
  PAGE_OBSTRUCTED: '关掉之后不用回复、也不用重跑：这一轮的窗口留在原地，系统会自己接着把这家店剩下的步骤跑完。',
  NEEDS_LOGIN: '登录好之后不用回复、也不用重跑：这一轮的窗口留在原地，系统会自己接着把这家店剩下的步骤跑完。',
  ROUND_LOGIN_WALL: '登录好之后不用回复、也不用重跑：系统会自己接着把这一轮的店铺重跑一遍。',
});

/** 下一步只写**收信人真能做**的，不写内部排查动作，也不写猜测的病因。 */
export const DAILY_ACTION_BY_CAUSE = Object.freeze({
  ROUND_BLOCKED: () => '打开那个开着飞书「各店铺日报」的浏览器窗口，把这两页各开一个（只留一个，多开同样会报错）：'
    + '生意参谋的「店铺」工作页、飞书「各店铺日报」底单页。开好后告诉技术同学重跑一次。',
  ROUND_LOGIN_WALL: (ctx) => '打开那扇开着飞书「各店铺日报」表格的浏览器窗口 —— 就是共用窗口，'
    + '它里面开着「各店铺日报」这张表，各店自己的窗口里都没有这张表。'
    + '在这个窗口里把「生意参谋」重新登录一次（登录时点浏览器提示里的「保存密码」）。'
    + '只登这一处就够，不用去各店自己的窗口里登。'
    + (ctx.willResume ? DAILY_RESUME_SENTENCE.ROUND_LOGIN_WALL : '登录好之后告诉技术同学重跑一次。'),
  SHOP_BLOCKED: (ctx) => `打开这几家店各自的日报采集窗口（窗口标题里写着店名，例如「${ctx.shops[0] ?? '店名'} · 日报采集窗口」），`
    + '把缺的页面补上：生意参谋的工作页、阿里妈妈报表页各一个（多开同样会报错）。补好后告诉技术同学重跑一次。',
  NEEDS_LOGIN: (ctx) => {
    const which = (ctx.needLogin ?? []).length ? ctx.needLogin : ctx.shops;
    return `打开这几家店各自的日报采集窗口（窗口标题里写着店名，例如「${which?.[0] ?? '店名'} · 日报采集窗口」），`
      + '用这家店自己的账号重新登录一次 —— 只在这一家店自己的窗口里登，别在别的窗口里登'
      + '（每个窗口是它自己那套登录态）。'
      + (ctx.willResume ? DAILY_RESUME_SENTENCE.NEEDS_LOGIN : '登录好之后告诉技术同学重跑一次。');
  },
  PAGE_OBSTRUCTED: (ctx) => `打开「${ctx.shops[0] ?? '这家店'}」的日报采集窗口，把盖住整个页面的那个弹窗关掉`
    + '（点它右上角的叉，或者它自己那个「关闭」「我知道了」按钮）—— 登录是好的，不用重新登录。'
    + (ctx.willResume ? DAILY_RESUME_SENTENCE.PAGE_OBSTRUCTED : '关掉之后告诉技术同学重跑这一家。'),
  DUPLICATE_TARGET: (ctx) => `不用处理：${ctx.date} 的数据已经在飞书里了。`
    + '只有确实要重写时才需要先删掉那一天的记录再跑。',
  SHOP_FUNC_NO_PERMISSION: (ctx) => `这一轮不需要你在浏览器里做什么 —— 刷新、重新登录都没用，不是登录的问题。`
    + `要恢复得把「${ctx.shops[0] ?? '这家店'}」在生意参谋里的「店铺绩效」这一项开通找回来`
    + '（生意参谋里的服务市场，看「我的订购」那一项是否到期，或直接找平台客服）。'
    + '在找回来之前，这家店每天都会停在这一步；其余店铺不受影响。',
  SOURCE_NO_ROW_FOR_DATE: (ctx) => `不用处理：${ctx.date} 这一天，这一家在平台上的「询单到付款」表本身就显示「暂无数据」，`
    + '所以只有「询单量 / 同层同行询单量」这两列是空的，其余字段都已经写进飞书了。'
    + '不用重跑，也不用找技术同学 —— 这一天不会再跑出数来。',
  INQUIRY_ROW_MISSING: () => '不用在浏览器里做什么（刷新、重新登录、补页面都没用 —— 这一轮采集是好的）。'
    + '要把「各店铺数据日报」里这一天的这一行建出来：那是系统每日任务里的一步，本该开跑前就做好，'
    + '缺了就说明那一步没成功。把这条消息转给技术同学就行，不用你动手。',
  STAGE_FAILED: () => '这一轮不需要你在浏览器里做什么。'
    + '如果到今天下班前飞书里还是缺这一天的数据，就把这条消息转给技术同学，让他去看。',
});

// 三张表互锁（**加载期**就查）：新增一个结论却忘了给它原因/下一步，模块直接起不来。
// 放到运行期才发现的写法（比如只在告警里兜底）会让收信人收到一条对不上现场的消息，
// 而那条消息看起来完全正常。
for (const [tableName, table] of [['DAILY_REASON_BY_CAUSE', DAILY_REASON_BY_CAUSE], ['DAILY_ACTION_BY_CAUSE', DAILY_ACTION_BY_CAUSE]]) {
  const absent = DAILY_FAILURE_CAUSES.filter((cause) => !table[cause]);
  if (absent.length) {
    throw new Error(`${tableName} 少了这些结论：${absent.join(' / ')}（收信人会看到一句对不上现场的兜底文案）`);
  }
}

// 「需要人」那一集必须是结论闭集的**子集**（同样是加载期查）。
const strayHuman = DAILY_HUMAN_REQUIRED_CAUSES.filter((cause) => !DAILY_FAILURE_CAUSES.includes(cause));
if (strayHuman.length) {
  throw new Error(`DAILY_HUMAN_REQUIRED_CAUSES 里有不在结论闭集里的值：${strayHuman.join(' / ')}`);
}

/**
 * daily 分支的一句话（原因 + 下一步）。**成因不在表里直接抛** ——
 * 静默退化到兜底文案会让收信人收到一句对不上现场的话，而那句话看起来完全正常。
 */
export function dailyCauseCopy(cause, ctx = {}) {
  const reason = DAILY_REASON_BY_CAUSE[cause];
  const action = DAILY_ACTION_BY_CAUSE[cause];
  if (!reason || !action) {
    throw new Error(`daily 词表里没有成因「${cause}」的原因或下一步 —— `
      + '新增结论时必须同时补 DAILY_REASON_BY_CAUSE 与 DAILY_ACTION_BY_CAUSE，'
      + '不许静默退化到兜底文案（收信人会照着一句对不上现场的话去做事）');
  }
  return { reason, action: action(ctx) };
}

// ---------------------------------------------------------------------------
// 六、告警 type 登记表（闭集）
// ---------------------------------------------------------------------------

/**
 * 全仓告警 `type` 的**闭集**。新增一个 type 必须在这里登记，否则
 * `runtime/alert-type-title-guard.test.mjs` 当场红 —— 那道判据扫的是源码里的
 * `type: 'XXX'` 字面量，漏登记的症状是「新 type 的标题没人管」。
 *
 * `title` 一栏只有两种合法值：
 *   · `'table'`   标题由 `notify-feishu-core` 的 `TITLE_BY_TYPE` 兜底（守卫会查表里
 *                  真有一条人话，且不是大写标识）；
 *   · `'explicit'` 调用方给带流程名与日期的显式标题（那张通用表给不出日期）。
 *                  守卫退一步查**源码里同一处有 `title:` 且带【】** —— 这是代理判据，
 *                  真正的标题断言在各链自己的用例里（run-multi-shop-day / run-promotion-sales1 /
 *                  login-merchant-core / hold-and-resume-plan 那几条）。
 *
 * 登记不等于免责：`note` 要写清这条告警是谁发的、收信人是谁。
 */
export const ALERT_TYPES = Object.freeze({
  // —— 小旺神 / 商品采集链（runtime/xws-*.mjs，标题走通用表）——
  XWS_LOGIN_REQUIRED: Object.freeze({ title: 'table', note: '小旺神登录失效；收信人＝运营' }),
  XWS_LOGIN_RESOLVED: Object.freeze({ title: 'table', note: '小旺神登录恢复；收信人＝运营' }),
  // 2026-10-14 新增：周报竞品链起跑前登录态预检（runtime/xws-weekly-login-preflight.mjs）。
  // 与上面 SKU 链那两个**同病不同链**：标题在通用表里带链名，去重按 type 成对，
  // 两条链的登录失效互不顶掉（竞品挂了不该把 SKU 的恢复通知顶掉，反之同理）。
  XWS_WEEKLY_LOGIN_REQUIRED: Object.freeze({ title: 'table', note: '竞品周采集起跑前检出小旺神登录失效；收信人＝运营' }),
  XWS_WEEKLY_LOGIN_RESOLVED: Object.freeze({ title: 'table', note: '竞品周采集的小旺神登录态已恢复；收信人＝运营' }),
  XWS_ACCOUNT_MISMATCH: Object.freeze({ title: 'table', note: '小旺神登录账号不对；收信人＝运营' }),
  XWS_AUTH_UNKNOWN: Object.freeze({ title: 'table', note: '读不出登录结论（按不放行处理）；收信人＝运营' }),
  XWS_PLUGIN_NOT_READY: Object.freeze({ title: 'table', note: '小旺神插件没就绪；收信人＝运营' }),
  XWS_SOURCE_MISMATCH: Object.freeze({ title: 'table', note: '打开的页面不是要采集的商品；收信人＝运营' }),
  XWS_PAGE_UNAVAILABLE: Object.freeze({ title: 'table', note: '采集用的商品页不在位；收信人＝运营' }),
  // —— 登录链（skills 下两个 -core，标题走通用表）——
  LOGIN_REQUIRED: Object.freeze({ title: 'table', note: '平台登录失效（逐店体检）；收信人＝运营' }),
  ACCOUNT_MISMATCH: Object.freeze({ title: 'table', note: '登录账号不对；收信人＝运营' }),
  RISK_BLOCKED: Object.freeze({ title: 'table', note: '验证码/风控页；收信人＝运营' }),
  COMMIT_UNKNOWN: Object.freeze({ title: 'table', note: '外部写入结果未知；收信人＝运营' }),
  BUG: Object.freeze({ title: 'table', note: '疑似系统自身缺陷；收信人＝技术' }),
  BUDGET_EXHAUSTED: Object.freeze({ title: 'table', note: '自动重试次数用尽；收信人＝技术' }),
  // —— 四条主流程（标题由调用方显式给，带流程名与日期）——
  DAILY_ROUND_FAILED: Object.freeze({ title: 'explicit', note: '店铺日报一轮没收完；收信人＝运营' }),
  DAILY_HOLD_TIMEOUT: Object.freeze({ title: 'explicit', note: '驻留等到截止仍没人处理；收信人＝运营' }),
  DAILY_HOLD_RESUMED: Object.freeze({ title: 'explicit', note: '驻留后续跑成功；收信人＝运营' }),
  DAILY_HOLD_RESUME_FAILED: Object.freeze({ title: 'explicit', note: '驻留后续跑没成功；收信人＝技术' }),
  PROMOTION_ROUND_FAILED: Object.freeze({ title: 'explicit', note: '推广日报一轮没收完；收信人＝运营' }),
  PRODUCT_ROUND_FAILED: Object.freeze({ title: 'explicit', note: '商品数据一轮没收完；收信人＝运营' }),
  WEEKLY_ROUND_FAILED: Object.freeze({ title: 'explicit', note: '周报竞品采集有段落没跑完；收信人＝运营' }),
  KEFU_WEEKLY_OK: Object.freeze({ title: 'explicit', note: '客服聊天记录周采集已完成；收信人＝运营' }),
  KEFU_WEEKLY_FAILED: Object.freeze({ title: 'explicit', note: '客服聊天记录周采集没收齐；收信人＝运营' }),
  FLOW_COMPLETED: Object.freeze({ title: 'explicit', note: '任一流程收集完成（请查收）；收信人＝运营' }),
  // 标题**派生**自原来那条告警（`已恢复：<原标题>`）⇒ 流程名跟着原标题走，
  // 生成处不需要自己有【】。这是 round-notify-policy 的形态；alert-copy 的
  // buildFlowOkAlert({recovered:true}) 那一份是自己拼【】的。
  ROUND_RESOLVED: Object.freeze({
    title: 'explicit', derived: true,
    note: '早先失败、现已补齐；标题派生自原告警（round-notify-policy.buildResolvedAlert）',
  }),
});

/**
 * 扫到的 `type: 'XXX'` 里**不是告警**的那些（竞品链的记录状态机等）。
 * 每一条都要写清它是什么 —— 否则这道判据就变成了「见什么都放行」。
 */
export const NON_ALERT_TYPES = Object.freeze({
  CANDIDATE_ACCEPTED: '竞品候选被采纳（记录状态机，不是告警）',
  CANDIDATE_REJECTED: '竞品候选被否决（记录状态机，不是告警）',
  IDENTITY_IGNORED: '竞品身份被忽略（记录状态机，不是告警）',
  SETTLEMENT_EXPIRED: '竞品结算过期（记录状态机，不是告警）',
  // 淘宝自采链在页面里拼 mtop 请求参数，`type: 'GET'` 是 HTTP 方法，不是告警类型。
  // 它只在字符串模板里，不参与本仓任何告警判定（2026-10-26，来自 2a510205 的红门）。
  GET: 'mtop 请求的 HTTP 方法（页面内请求参数，不是告警类型）',
});

// ---------------------------------------------------------------------------
// 五、其余三条流程的兜底词表
// ---------------------------------------------------------------------------

/**
 * 推广 / 商品 / 周报三条链目前只有**一种**失败形态（没有逐店分诊判据，统一 schema 里
 * 恒记 `STAGE_FAILED`）。所以它们的词表是「流程 × 兜底」一项，等分诊判据落地后
 * 按 daily 分支的形状扩成多键表 —— 扩表时把 `flowFallbackCopy` 换成查表函数即可，
 * 调用方一行不用改。
 *
 * 措辞口径与 daily 的 `STAGE_FAILED` 同源：不写英文阶段名、不写路径与命令、
 * 不承诺没实现的行为。技术细节一律进技术定位块（`buildTechBlock`）。
 */
export const FLOW_FALLBACK_COPY = Object.freeze({
  'promotion-daily': Object.freeze({
    reason: '这一天的推广日报没收齐：有几家店的推广报表没采到或没写进飞书。',
    action: '这一轮不需要你在浏览器里做什么。如果到今天下班前飞书里还是缺这一天的推广数据，'
      + '就把这条消息转给技术同学，让他去看。',
  }),
  'product-daily': Object.freeze({
    reason: '这一天的商品数据没收齐：有几家店的商品底单或询单没采到、没写进飞书。',
    action: '这一轮不需要你在浏览器里做什么。如果到今天下班前飞书里还是缺这一天的商品数据，'
      + '就把这条消息转给技术同学，让他去看。',
  }),
  'weekly-report': Object.freeze({
    reason: '本周的竞品采集有段落没跑完：缺的页段没有产出可用的带图工作簿。',
    action: '不用你做任何事。把这条消息转给技术同学，他会重跑缺的那几段。',
  }),
  'daily-report': Object.freeze({
    reason: '这一天的店铺日报没收齐。',
    action: '这一轮不需要你在浏览器里做什么。如果到今天下班前飞书里还是缺这一天的数据，'
      + '就把这条消息转给技术同学，让他去看。',
  }),
});

/** 取一条流程的兜底文案。未登记的流程当场抛错（不回退）。 */
export function flowFallbackCopy(workflow) {
  const flow = flowOf(workflow);
  const copy = FLOW_FALLBACK_COPY[flow.key];
  if (!copy) {
    throw new Error(`FLOW_FALLBACK_COPY 里没有流程「${flow.key}」的兜底文案 —— 每条流程都必须有一句兜底，`
      + '否则失败时会退化成一句谁都不想看的话');
  }
  return copy;
}
