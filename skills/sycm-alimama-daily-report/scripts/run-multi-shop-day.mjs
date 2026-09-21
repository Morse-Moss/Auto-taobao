#!/usr/bin/env node
//
// 按店铺循环跑一天的日报链 —— 「多店铺一轮」的那层驱动。
//
// 为什么需要它（2026-09-18 一轮多店铺实测的结论）：单店那十个步骤早就脚本化了，
// 但把它们串起来靠的是人手 —— **每家店一份口头顺序**，而顺序里有三处错一步就静默变形的地方：
//   · 落位要做两次（采集把生意参谋那个页签留在报表预览页 ⇒ 回填前必须回位 + 重跑 date-picker --site sycm）；
//   · 三个写入方的 `--shop-key` 必须同值（不同值 = 回填并进另一家店那一代证据目录）；
//   · 推送段的 `--shop-xlsx` / `--promotion-zip` 是**必填**，而这两个路径只有采集段知道
//     ⇒ 采集与推送必须在同一轮里，中间不能换人接手（换手就成手填路径 = 「默认值即目标」的形态）。
// 手抄顺序时这三条都不显眼，而它们的失败分别是「0 行」「目录贴错标签」「missing required argument」。
// 所以驱动存在的意义不是省几条命令，而是**把顺序与一致性变成代码**，让它只有一种走法。
//
// 三种模式（默认最保守的那一种）：
//   默认（排练）          落位 + 采集 + 干跑，**一个字节都不写飞书**。真跑前的自检用。
//   --verify-existing N  推送段走只读核对（`--verify-existing --expected-before-count N`）：
//                        核对「目标日那一天那一行还在、字段还对」，不新增不覆盖。
//   --commit             真写（推送 + 回填都加 `--commit`）。**目标日已被写过会硬重复停止**，先按 SOP §9.3 删那天。
//   --allow-missing-peer 补跑**历史日**时给回填开的降级开关（默认关，见 backfill 那段的长注释）：
//                        历史日的 SYCM 表格取不到「同行同层均值」行，不打开它，第 10 步必定 fail-closed 停下。
//
// 每台店各走一遍的十个阶段（顺序即 SOP §10.1；第 7/8 步的顺序是实测结论，不是偏好）：
//   1 alimama-date   2 promotion-submit   3 sycm-date       4 shop-report   5 promotion-fetch
//   6 push           7 sycm-reset         8 sycm-date-again 9 backfill      10 readback
//
// 为什么 7/8 必须分开：第 4 步点开「日报」预览会把生意参谋那个页签导到
// `lyone/auto_analysis/datafetch/report_generation`，而回填只认 `qos/.../shop/performance` ⇒
// 先回位、再重跑一次落位（重新导航会把页签与日期一起重置）。漏做第 8 步的症状是
// `expected one 当日询单人数 table, got 0`。
//
// 一条链跨两个浏览器（这是本文件里唯一「不同阶段用不同代理」的原因）：
//   采集段与询单读取跑在**这家店自己的**代理（19041~19044）——采集脚本只认代理，裸 CDP 端口连不上；
//   推送段与回读段跑在**商家浏览器**的代理（19023）——它们要读飞书 base 页，而那页只在那一个浏览器里。
//
// ---------------------------- 定时（无人值守）怎么用 ----------------------------
//
// 定时器只做一件事：到点敲一条命令。判据、叫人都在命令里（见
// docs/ops/MULTI-SHOP-AND-INTERACTION-DECISION.md §5.4 的三层划分）：
//
//   node skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs \
//        --date yesterday --commit --notify            （Windows 计划任务里写成一行）
//
// 为什么日期要写成字面量 `yesterday` 而不是让调度器去算：调度器算日期就是把
// 「Asia/Shanghai 的昨日」这条口径抄到命令之外，抄一份就是等着它与落位脚本漂移。
// 这里用**落位脚本同一个函数**（shanghaiToday/shiftIso）解析，且只认这一个字面量 ——
// 写错（如 `yestoday`）会当场报错，不会静默落成「今天」。
//
// 为什么定时跑的那一天**必须**是「昨天」：SYCM「询单到付款」表格里那行「同行同层均值」
// 只有预设「1天」（＝昨日）才有（2026-09-19 实测）⇒ 补跑任何历史日都拿不到基准。
// 定时任务天然落在这一档上，因此不需要 `--allow-missing-peer`（那是补历史日才用的降级开关）。
//
// `--notify`：**只有出错才发**（成功一声不响），且只在 `--commit` 那一档发 ——
// 排练/只读核对失败是「你正在看屏幕时的事」，发到飞书只会训练人忽略这个信号。
// 想看文案但不想真的发：`--notify-print`（用同一个渲染器打印，不投递）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BROWSER_IDS, BROWSER_LABELS, PROJECT_PORTS, ROUTES, shopBrowserKeys, shopInstance } from '../../../runtime/browser-ports.mjs';
import { normalizePages } from '../../../runtime/page-normalize.mjs';
import { READABLE_SOURCE_KEYS, renderAlertText } from '../../../runtime/notify-feishu-core.mjs';
import { createPlatformHealthCheck } from '../../../runtime/xws-platform-health-preflight.mjs';
import { shiftIso, shanghaiToday } from './date-picker.mjs';
import { describeIdentity, expectArgs, formatArgv, shopIdentity } from './shop-identities.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const NODE = process.execPath;
// 叫人走**既有的投递出口**（零参数 CLI，配置从飞书 profile 读）。这里不另写一条 HTTP：
// 那条链已经带着「没送达必然非零退出码」的性质，自己再写一遍就多出一个「以为发了、其实没人收到」的形态。
const NOTIFY_CLI = path.join(REPO_ROOT, 'runtime/notify-feishu.mjs');
const MACHINE = process.env.COMPUTERNAME || process.env.HOSTNAME || hostname();
const SITE_SYCM_ENTRY = 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop';
const SYCM_FRAGMENT = 'sycm.taobao.com/qos/service/frame/shop/performance';

// 三种模式是**闭集**。为什么要显式列出并校验：push 那一支是靠 `mode === 'commit'` /
// `mode === 'verify'` 两个分支决定加不加参数的，传进来一个别的值（比如 'dry' 这种想当然的写法）
// 会既不加 `--commit` 也不加 `--verify-existing` —— 静默变成排练，而调用方以为自己开了提交。
export const MODES = Object.freeze(['rehearse', 'verify', 'commit']);

// 阶段名是**闭集**，而且 `--only` 的实现是「不点名就跳过」—— 所以拼错一个名字不会报错，
// 只会把十个阶段全部跳过：整轮「跑完」、退出码 0、一步没做。这正是本项目反复出现的
// 「静默落空」形态，因此在解析期就把它钉死。常量与 buildShopStages 的真实产出由函数内
// 一条断言互锁（两处漂移会当场抛错，而不是让 `--only` 的合法值清单慢慢腐化）。
export const STAGE_NAMES = Object.freeze([
  'health-check', 'alimama-date', 'promotion-submit', 'sycm-date', 'shop-report', 'promotion-fetch',
  'push', 'sycm-reset', 'sycm-date-again', 'backfill', 'readback',
]);

// 体检要「恰好各一个」的页面 —— 定义搬去了叶子模块 `runtime/expected-pages.mjs`（2026-09-21）。
//
// 为什么搬：补页那一套（`runtime/shop-pages.mjs`）本来就要用它，而它此前住在本文件里
// ⇒ 依赖方向是倒的（`runtime/` import `skills/`），并且**一形成环**就再也加不进新东西
// （失败路径收尾、体检归位都要用补页那一套）。抽成叶子之后是单向的：驱动 → 补页/归位 → 那里。
// 这里**既 import 又 export**（不是单纯转出去）：本文件内部还在用这两个函数，
// 而 `export … from` 只转不落地、不产生本地绑定 —— 只转的话本文件里那三处调用会直接 ReferenceError。
// 对外名字与从前逐字相同，两处断言「与驱动同源」的用例（shop-pages / run-multi-shop-day）一个字都不用改。
import { expectedPagesForDailyBrowser, expectedPagesForShop } from './expected-pages.mjs';

export { expectedPagesForDailyBrowser, expectedPagesForShop };

// ---------------------------------------------------------------- 目标日：只有一个来源

// 允许的字面量是**闭集**：写错一个字母必须当场报错，不能静默落成别的日子
// （`--date today` 这类「差不多能用」的取值一律不要 —— 每多一个，就多一种
// 「调度器以为它算的是另一天」的可能，而日报链对日期是最敏感的）。
export const TARGET_DATE_LITERALS = Object.freeze(['yesterday']);

/**
 * 把 `--date` 的取值解析成 ISO 日期。**纯函数**（`now` 由调用方冻结一次，
 * 执行过程中不再取时间 —— 跨零点时「昨天」会漂到另一天，那是相对日期的最大风险）。
 */
export function resolveTargetDate(raw, now = new Date()) {
  const value = String(raw ?? '').trim();
  if (TARGET_DATE_LITERALS.includes(value)) return shiftIso(shanghaiToday(now), -1);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const options = `YYYY-MM-DD 或 ${TARGET_DATE_LITERALS.join(' / ')}`;
  if (!value) throw new Error(`missing --date：要给 ${options}（定时任务写 --date yesterday）`);
  throw new Error(`invalid --date ${JSON.stringify(raw)}：要给 ${options}`);
}

// 阶段名 → 收信人看得懂的中文名。措辞**只在这一处决定**：告警正文里不许出现英文阶段名
// （那是我们内部的叫法，收信人对着它不知道去点什么）。与 STAGE_NAMES 的完整性由用例双向互锁。
export const STAGE_LABELS = Object.freeze({
  'health-check': '起跑前体检',
  'alimama-date': '阿里妈妈切到那一天',
  'promotion-submit': '提交推广报表生成',
  'sycm-date': '生意参谋切到那一天',
  'shop-report': '下载店铺日报',
  'promotion-fetch': '取推广报表压缩包',
  push: '写进飞书',
  'sycm-reset': '生意参谋页回位',
  'sycm-date-again': '再切一次那一天',
  backfill: '回填询单数据',
  readback: '回读核对',
});

export function stageLabelOf(stage) {
  const label = STAGE_LABELS[stage];
  if (!label) throw new Error(`阶段 ${stage} 没有面向人的中文名（新增阶段时忘了补 STAGE_LABELS？）`);
  return label;
}

/** 阶段在这家店的第几步（从 1 数，与日志文件名上的编号一致）。认不出来返回 null，不猜。 */
export function stageNumber(key, stage) {
  const at = buildShopStages(key, { date: '1970-01-01', mode: 'rehearse' })
    .findIndex((item) => item.stage === stage);
  return at === -1 ? null : at + 1;
}

// ---------------------------------------------------------------- 出错了怎么叫人

/**
 * 结论的闭集。分类函数、原因表、下一步表必须覆盖**同一个**集合 —— 漏一条的症状是
 * 「这个结论悄悄退化成兜底文案」，而告警照发不误、看起来一切正常。
 */
export const FAILURE_CAUSES = Object.freeze(
  ['ROUND_BLOCKED', 'SHOP_BLOCKED', 'DUPLICATE_TARGET', 'SHOP_FUNC_NO_PERMISSION', 'STAGE_FAILED'],
);

/**
 * 一家店的失败是哪一类。
 *
 * **成因不同、要做的事不同，就必须分开**：收信人照着一条对不上现场的建议去做，
 * 比不通知更糟（2026-09-19 那条「点保存密码」的登录告警就是这么被判错的）。
 *
 * `DUPLICATE_TARGET` 单独一类，因为它的下一步与别的**相反** —— 不用做任何事
 * （那一天的数据已经在飞书里了）。把它并进「失败」就是每天喊一次狼来了。
 */
export function shopFailureCause(record = {}) {
  // 「这一项订购不在账号上」**优先于所有别的结论**：它决定的是「收信人要不要去平台」，
  // 而别的结论在这个原因下照着做都没用。
  // 2026-09-21 科塔现场正是被报成「这家店的窗口里页面不齐，去打开窗口把页面补上」——
  // 照着做的人白跑一趟浏览器，问题不会好。判据是**确定性名字**（`date-picker.mjs` 只在这一种
  // 情况下抛它，且抛出前一定先问过平台，问不到就不给这个名字）。
  if (/SHOP_FUNC_NO_PERMISSION/u.test(String(record.failureOutput ?? ''))) return 'SHOP_FUNC_NO_PERMISSION';
  if (record.failedStage === 'health-check') return 'SHOP_BLOCKED';
  if (record.failedStage === 'push'
    && /duplicate daily report row exists/u.test(String(record.failureOutput ?? ''))) return 'DUPLICATE_TARGET';
  return 'STAGE_FAILED';
}

/** 一轮的失败视图（纯函数；`summary` 就是落盘的 summary.json 的形状）。 */
export function roundFailureSummary(summary = {}) {
  const entries = Object.entries(summary?.shops ?? {});
  const failed = entries.filter(([, record]) => record?.status !== 'ok')
    .map(([key, record]) => ({ key, record, cause: shopFailureCause(record) }));
  const ok = entries.filter(([, record]) => record?.status === 'ok').map(([key]) => key);
  const roundBlocked = summary?.round?.healthCheckDaily?.ok === false;
  return { failed, ok, roundBlocked, roundBlockedDetails: summary?.round?.healthCheckDaily?.blockingDetails ?? null,
    any: roundBlocked || failed.length > 0, total: entries.length };
}

// 收信人在这里看到的每一个词都要是「他明天还会看到的东西」：窗口标题（`运营叫法 · 日报采集窗口`）、
// 飞书里那张表、生意参谋/阿里妈妈两个后台的中文页名。**不写**英文阶段名、不写我们的结论代号、
// 不写「重试/自愈」这类没实现的行为（承诺兑现不了比不说更糟）。
//
// 2026-09-21 追加一条硬口径：**技术串不进业务消息**。起因是首次定时真跑发出去的那条消息 ——
// 术语表全绿，正文里却带着 `evidence\multi-shop-2026-09-20`、一整条
// `node …/run-multi-shop-day.mjs --date … --commit --notify`、机器名 `DESKTOP-…`、告警编号，
// 业务人员照样看不懂。判据是「形状」不是「词表」（见 driver 的用例），
// 技术信息一律留在驱动自己的 stdout 与 job.log 里 —— 那里才是给技术同学看的。
const REASON_BY_CAUSE = Object.freeze({
  ROUND_BLOCKED: '整轮没开跑：那个开着飞书「各店铺日报」的浏览器窗口里，页面不齐。',
  SHOP_BLOCKED: '这家店的专用窗口里页面不齐，所以这家店一步都没跑。',
  DUPLICATE_TARGET: '这一天飞书里已经有数据了，脚本按「不许写第二遍」停住了。',
  SHOP_FUNC_NO_PERMISSION: '这家店在生意参谋里的「店铺绩效」现在不在账号上（平台按店铺开通的一项），所以采集页面一打开就被平台送回首页，这一天的数据没进飞书。',
  STAGE_FAILED: '这家店跑到一半停住了，这一天的数据没进飞书。',
});

// 下一步只写**收信人真能做**的，不写我们内部的排查动作（翻日志、跑命令）。
//
// 也**不写猜测的病因**：2026-09-21 那条把「最常见的是那个窗口的登录掉了」当成了既定原因，
// 而现场是「生意参谋页面停在昨天的渲染上」—— 照着做的收信人白跑一趟浏览器去登录，问题不会好。
// 成因不同、要做的事就不同（同 SKILL `operator-alert-plain-language` §4 的「结论判错」），
// 所以宁可不给具体动作，也不给一个可能是错的。
const ACTION_BY_CAUSE = Object.freeze({
  ROUND_BLOCKED: () => '打开那个开着飞书「各店铺日报」的浏览器窗口，把这两页各开一个（只留一个，多开同样会报错）：'
    + '生意参谋的「店铺」工作页、飞书「各店铺日报」底单页。开好后告诉技术同学重跑一次。',
  SHOP_BLOCKED: (ctx) => `打开这几家店各自的日报采集窗口（窗口标题里写着店名，例如「${ctx.shops[0] ?? '店名'} · 日报采集窗口」），`
    + '把缺的页面补上：生意参谋的工作页、阿里妈妈报表页各一个（多开同样会报错）。补好后告诉技术同学重跑一次。',
  DUPLICATE_TARGET: (ctx) => `不用处理：${ctx.date} 的数据已经在飞书里了。`
    + '只有确实要重写时才需要先删掉那一天的记录再跑。',
  SHOP_FUNC_NO_PERMISSION: (ctx) => `这一轮不需要你在浏览器里做什么 —— 刷新、重新登录都没用，不是登录的问题。`
    + `要恢复得把「${ctx.shops[0] ?? '这家店'}」在生意参谋里的「店铺绩效」这一项开通找回来`
    + '（生意参谋里的服务市场，看「我的订购」那一项是否到期，或直接找平台客服）。'
    + '在找回来之前，这家店每天都会停在这一步；其余店铺不受影响。',
  STAGE_FAILED: () => '这一轮不需要你在浏览器里做什么。'
    + '如果到今天下班前飞书里还是缺这一天的数据，就把这条消息转给技术同学，让他去看。',
});

// 三张表互锁（**加载期**就查）：新增一个结论却忘了给它原因/下一步，模块直接起不来。
// 放到运行期才发现的写法（比如只在告警里兜底）会让收信人收到一条对不上现场的消息，
// 而那条消息看起来完全正常。
for (const [tableName, table] of [['REASON_BY_CAUSE', REASON_BY_CAUSE], ['ACTION_BY_CAUSE', ACTION_BY_CAUSE]]) {
  const absent = FAILURE_CAUSES.filter((cause) => !table[cause]);
  if (absent.length) {
    throw new Error(`${tableName} 少了这些结论：${absent.join(' / ')}（收信人会看到一句对不上现场的兜底文案）`);
  }
}

/** 收信人看到的「哪家店、停在哪一步」。店名后面带上**他在浏览器里能看到的登录名**，方便对上窗口。 */
export function describeShopFailure(key, record) {
  const cause = shopFailureCause(record);
  const at = record?.failedStage ? stageNumber(key, record.failedStage) : null;
  const where = record?.failedStage
    ? `停在第 ${at ?? '?'} 步（${stageLabelOf(record.failedStage)}）`
    : '没跑完，但记录里没写停在哪一步';
  // 体检拦下来的那几条明细直接给出来：只说「体检没过」等于让收信人自己去翻日志。
  const specifics = (record?.blockingDetails ?? []).filter(Boolean).slice(0, 3);
  // 账号名（`里可林家居:阿彦`）**不进业务消息**：窗口标题里写的就是运营叫法（店名），
  // 业务人员靠店名就够对上窗口了；而账号名一旦被转发到群/邮件就是一条泄露面。
  // 它仍然留在驱动启动时打出的身份表里（stdout / job.log），需要时那里能查。
  return `· ${key}—— ${where}。${REASON_BY_CAUSE[cause]}`
    + (specifics.length ? `\n  ${specifics.join('\n  ')}` : '');
}

/**
 * 一条告警说清「哪几家收完了、哪几家没有、下一步做什么」。
 *
 * 字段名必须落在 `runtime/notify-feishu-core.mjs` 的 `READABLE_SOURCE_KEYS` 白名单里，
 * 否则渲染时会被静默丢掉（告警照发，收信人看不到那一行）。
 * **但白名单管的是键，管不到值** —— 值里的路径/机器名/编号照样会原样发出去，
 * 所以「不给它这些字段」才是对的写法（2026-09-21：`machine` 与 `evidence` 就是从这里漏出去的）。
 * 这一条由函数末尾的 `assertAlertIsBusinessReadable` 拦在生成处（fail-closed）。
 */
export function buildRoundFailureAlert({ date, summary, shopKeys = null, now = () => new Date() }) {
  const view = roundFailureSummary(summary);
  if (!view.any) throw new Error('这一轮没有失败却要生成告警（调用方的判定错误）—— 成功时不许叫人');
  // `shopKeys` **必填**（这一轮该跑哪几家，从配置来），缺了直接抛。
  //
  // 为什么不是「缺了就退化成空」：2026-09-21 两个调用点漏传它（改动被静默丢失 + 没有一条用例
  // 走这条接线），结果是「另外 N 家今天一步都没跑」那一行**静默消失** —— 而那一行正是收信人
  // 判断「其余几家是不是收好了」的唯一依据。安静的降级比崩溃危险得多：崩溃会有人来修，
  // 少一行字不会。家数同样只能由调用方给，不能从 `summary.shops` 数（停轮时那里只有第一家，
  // 数出来就是「0 家店」，收信人会以为今天根本没排店）。
  if (!Array.isArray(shopKeys) || shopKeys.length === 0) {
    throw new Error('buildRoundFailureAlert 必须拿到 shopKeys（这一轮该跑哪几家店）—— '
      + '缺了它「另外 N 家今天一步都没跑」那一行会静默消失，而那条消息看起来完全正常');
  }
  const when = now();
  const total = shopKeys.length;
  const failedNames = view.failed.map((item) => item.key);
  const subject = view.roundBlocked ? '全部店铺' : failedNames.length === 1 ? failedNames[0] : `${failedNames.length} 家店`;
  const causes = [...new Set([...(view.roundBlocked ? ['ROUND_BLOCKED'] : []), ...view.failed.map((item) => item.cause)])];
  // 默认「第一家失败即停整轮」⇒ 只写「没跑完 1 家」会被读成「其余几家都收好了」。
  // 2026-09-21 那条正是这个形态：对象写「日报一轮 · 5 家店」，原因写「没跑完 1 家」，
  // 而实际是**其余 4 家一步都没跑**。少写这一行，等于让收信人以为今天收工了。
  const notRun = view.roundBlocked ? [] : shopKeys.filter((key) => !(key in (summary?.shops ?? {})));

  const reason = [
    view.roundBlocked ? REASON_BY_CAUSE.ROUND_BLOCKED : null,
    ...(view.roundBlocked ? (view.roundBlockedDetails ?? []).filter(Boolean).slice(0, 3).map((line) => `  ${line}`) : []),
    view.failed.length ? `没跑完 ${view.failed.length} 家：\n${view.failed.map((item) => describeShopFailure(item.key, item.record)).join('\n')}` : null,
    notRun.length ? `· 另外 ${notRun.length} 家今天一步都没跑（有一家停住后，整轮就停了）：${notRun.join('、')}` : null,
    view.ok.length ? `已收完 ${view.ok.length} 家：${view.ok.join('、')}` : null,
  ].filter(Boolean).join('\n');

  const actions = causes.map((cause) => ACTION_BY_CAUSE[cause]({ date, shops: failedNames }));

  const alert = {
    type: 'DAILY_ROUND_FAILED',
    severity: 'ERROR',
    title: view.roundBlocked
      ? `全部店铺的日报都没跑起来（统计日 ${date}）`
      : `${subject}的日报没收完（统计日 ${date}）`,
    // 同一天同一轮共用一条锚；**是否重复投递由调用方的 resolveAlertDedup 判**（投递链本身不去重）。
    alertId: `daily-round-${date.replace(/-/gu, '')}`,
    // 指纹只服务于「同一天重复失败要不要再发一条」：停的地方没变才算重复。
    fingerprint: [
      view.roundBlocked ? 'ROUND_BLOCKED' : 'SHOP_LEVEL',
      ...view.failed.map((item) => `${item.key}@${item.record?.failedStage ?? '?'}`),
    ].join('|'),
    createdAt: when.toISOString(),
    reason,
    action: [...new Set(actions)].join('\n'),
    source: {
      targetLabel: `日报一轮 · ${total} 家店`,
      period: `统计日 ${date}`,
      capability: '各店铺日报',
      shopName: failedNames.length ? failedNames.join('、') : null,
    },
    // **故意不给** machine / 机器、evidence / 运行日志目录：它们是技术串，不该出现在业务消息里
    // （白名单只约束键，值一旦给了就会原样渲染出去）。技术同学从驱动的 stdout 与 job.log 里看，
    // 那里会把这条告警的正文、日志目录、机器名完整打出来。
  };
  assertAlertIsBusinessReadable(alert);
  return alert;
}

// 这一条链的收信人是**运营**，白名单是给全仓共用渲染器定的、里面确实有给技术同学用的键
// （`machine`/`browserProfile`/`loginUrl`）。所以「不给这些字段」这件事必须**在生成处拦**，
// 不能只靠用例：用例只在 CI 时红，而这条消息可能先被手跑发出去（2026-09-21 就是这么漏的）。
// 判据是**形状**：任何一层出现这些键名即当场抛错，而不是渲染时静默丢掉或原样发出去。
const FORBIDDEN_ALERT_KEYS = Object.freeze(['machine', 'browserProfile', 'evidence', 'logDir', 'hostname', 'profile']);
const READABLE_SOURCE_KEY_NAMES = new Set(READABLE_SOURCE_KEYS.map(([key]) => key));

export function assertAlertIsBusinessReadable(alert) {
  const seen = [];
  const walk = (value, at) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      // 用「包含」而不是「相等」：`machineName` / `hostname2` 这类变体照样是技术串。
      const hit = FORBIDDEN_ALERT_KEYS.find((bad) => key.toLowerCase().includes(bad));
      if (hit) seen.push(`${at}${key}`);
      walk(child, `${at}${key}.`);
    }
  };
  walk(alert, '');
  if (seen.length) {
    throw new Error(`告警里出现了不该给业务收信人看的字段（${seen.join('、')}）—— `
      + '机器名、运行日志目录这类信息只留在驱动自己的 stdout 与 job.log 里，不进这条消息。');
  }
  const unknown = Object.keys(alert?.source ?? {}).filter((key) => !READABLE_SOURCE_KEY_NAMES.has(key));
  if (unknown.length) {
    throw new Error(`告警的 source 里有渲染器不认识的键（${unknown.join('、')}）—— `
      + '它们会被白名单静默丢掉：收信人看不到，而你以为发出去了。要么改白名单，要么别给。');
  }
}

/**
 * 这次失败该不该往外发。**纯函数**，因为「什么时候安静」和「什么时候叫人」一样重要：
 * 排练失败的提醒发到飞书，只会训练人忽略这个信号（而它是唯一会叫你动手的通道）。
 */
export function resolveAlertDispatch({ notify = false, notifyPrint = false, mode }) {
  if (!notify && !notifyPrint) return { action: 'off', why: '没有 --notify（默认安静：只在屏幕上报错）' };
  if (notifyPrint) return { action: 'print', why: '--notify-print：只打印不投递' };
  if (mode !== 'commit') return { action: 'off', why: `--${mode === 'verify' ? 'verify-existing' : '排练'}模式不投递（失败就在屏幕前）` };
  return { action: 'send', why: '--notify 且 --commit' };
}

export const parseArgs = (argv, { now = new Date() } = {}) => {
  const args = { date: null, dateInput: null, shops: null, commit: false, verifyExisting: null, keepGoing: false,
    only: null, logs: null, downloads: null, shopXlsx: null, promotionZip: null,
    allowMissingPeer: false, notify: false, notifyPrint: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    // 原样收下，出了循环再解析（`--date yesterday` 要用「这一刻」的时钟算，只算一次）。
    if (key === '--date') args.dateInput = argv[++i];
    // 出错时才发飞书（成功一声不响）；`--notify-print` 只打印不投递，用来看文案。
    else if (key === '--notify') args.notify = true;
    else if (key === '--notify-print') args.notifyPrint = true;
    // 历史日（不是「昨日」）的回填降级开关。**默认关**，见 buildShopStages 里 backfill 那段。
    else if (key === '--allow-missing-peer') args.allowMissingPeer = true;
    else if (key === '--shops') args.shops = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--commit') args.commit = true;
    else if (key === '--verify-existing') args.verifyExisting = Number(argv[++i]);
    else if (key === '--keep-going') args.keepGoing = true;
    else if (key === '--only') args.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--logs') args.logs = argv[++i];
    else if (key === '--downloads') args.downloads = argv[++i];
    // 只给「采集已经跑完、要单独重跑推送段」用（那一轮的产物路径不可能再问采集要）。
    // 这两种情况下必须两种都给/都不给 —— 只给一种是「一半手填」的形态，见 withSourcePaths。
    else if (key === '--shop-xlsx') args.shopXlsx = argv[++i];
    else if (key === '--promotion-zip') args.promotionZip = argv[++i];
    else throw new Error(`unknown argument: ${key}`);
  }
  // 目标日在这里冻结（`now` 只取一次）⇒ `--date yesterday` 在执行过程中不会漂。
  args.date = resolveTargetDate(args.dateInput, now);
  if (args.commit && args.verifyExisting !== null) {
    throw new Error('--commit 与 --verify-existing 互斥：一个是写，一个是只读核对');
  }
  if (args.verifyExisting !== null && !Number.isInteger(args.verifyExisting)) {
    throw new Error('--verify-existing 需要一个整数（导入前底单的条数）');
  }
  if ((args.shopXlsx === null) !== (args.promotionZip === null)) {
    throw new Error('--shop-xlsx 与 --promotion-zip 必须成对给（少给一个就会退回采集段，两种来源混着用）');
  }
  // 0 家店不能当「都收完了」：那会让 `--shops "里可林淘宝,,网林天猫"` 这种输入跑出一个
  // 退出码 0、什么也没做的「成功」（静默落空的老形态）。
  if (args.shops && args.shops.length === 0) throw new Error('--shops 解析出来 0 家店（是不是多写了逗号？）');
  if (args.only) {
    const unknown = args.only.filter((name) => !STAGE_NAMES.includes(name));
    if (unknown.length) {
      throw new Error(`--only 里有不认识的阶段名：${unknown.join(', ')}`
        + `（合法值：${STAGE_NAMES.join(' / ')}）`
        + ' —— 不认识的会被当成「没点名」而跳过，于是整轮跑完却一步没做，退出码还是 0');
    }
  }
  return args;
};

/**
 * 一台店的全部阶段。**纯函数**（不碰网络、不读文件）⇒ 顺序与参数可以被离线断言。
 *
 * 返回的每一项：{ stage, script, argv, env, note }。`script` 为 null = 驱动自己做的事
 * （只有 sycm-reset 一项，它是一次导航，没有现成脚本）。
 */
export function buildShopStages(shopKey, options) {
  const { date, mode, shopXlsx = null, promotionZip = null, expectedBeforeCount = null,
    downloads = null, allowMissingPeer = false } = options;
  if (!MODES.includes(mode)) {
    throw new Error(`未知模式 ${JSON.stringify(mode)}：只认 ${MODES.join(' / ')}`
      + ' —— 不能默默当排练跑（那样会「以为在提交、其实只是干跑」）');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(date ?? ''))) {
    throw new Error(`buildShopStages 需要 YYYY-MM-DD 的日期，收到 ${JSON.stringify(date)}`);
  }
  if (mode === 'verify' && !Number.isInteger(expectedBeforeCount)) {
    throw new Error('verify 模式必须给 expectedBeforeCount（导入前底单条数，整数）—— 没有它核对就没有判据');
  }
  const shop = shopInstance(shopKey);
  const identity = shopIdentity(shopKey);
  // 身份期望值**必须齐全**才开跑：缺了就是「在没有判据的情况下跑完」（坑 38 的形态）。
  const identityArgs = expectArgs(shopKey, { require: ['shop', 'member'] }).args;
  const shopProxy = `http://127.0.0.1:${shop.proxyPort}`;
  const dailyProxy = `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;
  const common = downloads ? ['--downloads', downloads] : [];
  // 审计表里那四列（browser_port / browser_id / proxy_port / …）的来源是**环境变量**，
  // 环境变量不设时回落成路线默认值 ⇒ 不设的话每家店的审计行都会写成 19022/19023，
  // 而实际打的是这家店自己的代理。所以每一阶段都显式带上它真正要连的那一组。
  const shopEnv = {
    CDP_BROWSER_PORT: String(shop.browserPort), CDP_PROXY_PORT: String(shop.proxyPort),
    CDP_BROWSER_ID: shop.browserId, CDP_BROWSER_LABEL: shop.label,
  };
  const dailyEnv = {
    CDP_BROWSER_PORT: String(PROJECT_PORTS.dailyReportBrowser),
    CDP_PROXY_PORT: String(PROJECT_PORTS.dailyReportProxy),
    CDP_BROWSER_ID: BROWSER_IDS.dailyReport, CDP_BROWSER_LABEL: BROWSER_LABELS.dailyReport,
  };
  const stages = [];
  const add = (stage, script, argv, env, note, ownAction = null) =>
    stages.push({ stage, script, argv, env, note, ownAction });

  // 体检排在最前面（SOP §10.0 的「起跑前逐项确认」落成代码）。它不采任何数据，
  // 只回答「现在能不能跑」；结论有 blocking 项就停这一家（见 runHealthCheck）。
  add('health-check', null, [], shopEnv,
    '体检：这家店的浏览器在不在、profile 对不对、两个必需页面各恰好一个', 'health');

  add('alimama-date', 'date-picker.mjs',
    ['--site', 'alimama', '--date', date, '--proxy', shopProxy], shopEnv,
    '阿里妈妈落位（日期全在 URL hash 里，navigate 即落位）');
  add('promotion-submit', 'collect-promotion-report.mjs',
    ['--phase', 'submit', '--date', date, '--proxy', shopProxy, ...common, ...identityArgs], shopEnv,
    '提交推广报表生成任务（之后平台要生成几分钟，中途用第 3/4 步填掉）');
  add('sycm-date', 'date-picker.mjs',
    ['--site', 'sycm', '--date', date, '--proxy', shopProxy], shopEnv,
    '生意参谋落位（切页签到 询单到付款 再定日期）');
  add('shop-report', 'collect-shop-report.mjs',
    ['--date', date, '--proxy', shopProxy, ...common, ...identityArgs], shopEnv,
    '点开日报预览并下载店铺工作簿（会把这个页签留在预览页）');
  add('promotion-fetch', 'collect-promotion-report.mjs',
    ['--phase', 'fetch', '--date', date, '--proxy', shopProxy, ...common, ...identityArgs], shopEnv,
    '取推广 zip（先断言任务行是「生成成功」，再真实点复选框）');

  // 注意这三个写入方的 `--shop-key` 是**同一个值**（同一个变量），不是三处各写一遍：
  // 不同值会让回填并进另一家店那一代证据目录，而目录名上看不出来（错标签比不贴标签更糟）。
  const pushArgs = ['--date', date, '--proxy', dailyProxy, '--shop-key', shopKey];
  if (shopXlsx) pushArgs.push('--shop-xlsx', shopXlsx);
  if (promotionZip) pushArgs.push('--promotion-zip', promotionZip);
  if (mode === 'commit') pushArgs.push('--commit');
  else if (mode === 'verify') pushArgs.push('--verify-existing', '--expected-before-count', String(expectedBeforeCount));
  add('push', 'run-daily-report.mjs', pushArgs, dailyEnv,
    mode === 'commit' ? '推送（会写底单新增一行）'
      : mode === 'verify' ? '推送段的**只读核对**：核那一行还在、字段还对（不写）'
        : '推送干跑（落 plan.json，不写）');

  add('sycm-reset', null, [], shopEnv,
    '生意参谋回位：把被第 4 步带走的那个页签送回 qos/.../shop/performance（驱动自己导航）', 'reset');
  add('sycm-date-again', 'date-picker.mjs',
    ['--site', 'sycm', '--date', date, '--proxy', shopProxy], shopEnv,
    '回位会重置页签与日期 ⇒ 必须重跑落位，否则回填报 expected one 当日询单人数 table, got 0');

  const backfillArgs = ['--date', date, '--proxy', shopProxy, '--source-shop', identity.fullName,
    '--shop', shopKey, '--shop-key', shopKey];
  if (mode === 'commit') backfillArgs.push('--commit');
  // 历史日的同行基准降级开关（2026-09-19 接）。
  //
  // 为什么必须能被显式打开：`run-inquiry-backfill.mjs` 的 `--allow-missing-peer` 把
  // 「同行同层均值」缺失从 fail-closed 降级成「只写询单量、那一格留空并记账」，
  // 而**驱动从来没接过这根线** ⇒ 补跑任何历史日，第 10 步必定以
  // `expected one benchmark row 同行同层均值, got 0` 收场（四家店全停在那里）。
  // 实测口径（2026-09-19，真页面）：SYCM「询单到付款」表格在**自定义日期**下只有 3 行
  // （日期行 + 汇总值 + 平均值），同行对比行只有预设「1天」（＝昨日）才有 ⇒
  // 任何历史日都拿不到基准，这不是解析失败，是数据源不给。
  //
  // 为什么**默认仍然关**：默认降级会掩盖「本该有基准却没有」的真故障。所以口径是
  // 「调用方知道自己跑的是历史日，才显式打开」——不给这个参数时，参数表与从前逐字相同。
  if (allowMissingPeer) backfillArgs.push('--allow-missing-peer');
  add('backfill', 'run-inquiry-backfill.mjs', backfillArgs, shopEnv,
    mode === 'commit' ? '询单回填（写两个字段）' : '询单回填干跑（取数 + 判处置，不写）');

  add('readback', 'readback-daily-report.mjs',
    ['--date', date, '--proxy', dailyProxy, '--shop-key', shopKey], dailyEnv,
    '独立回读 + 截图（换一条通路读同一个事实）');

  // 与 `STAGE_NAMES` 互锁：那份常量是 `--only` 的合法值来源，它一旦和真实阶段表漂移，
  // 「拼错名字」就又变成静默跳过了 —— 只是这次的错误由常量自己造出来。逐字比，不比长度。
  const produced = stages.map((item) => item.stage);
  if (produced.join(',') !== STAGE_NAMES.join(',')) {
    throw new Error('阶段表与 STAGE_NAMES 漂移了：\n'
      + `  实际产出 ${produced.join(',')}\n  常量     ${STAGE_NAMES.join(',')}`);
  }

  return stages;
}

/**
 * 把采集段的产物路径注入推送段的参数表。
 *
 * **替换而不是追加**：`buildShopStages` 是纯函数，调用方可能已经给了这两个值（离线断言用），
 * 追加会得到两个 `--shop-xlsx` —— 后一个胜出、静默，「两份真相当中有一份是假的」正是要防的东西。
 *
 * **两种来源只许存在一种**：全部来自采集段（同轮），或者全部来自命令行（单独重跑推送段）。
 * 混着用意味着有一个路径是上一轮留下的，而它在文件名上看不出来属于哪一天/哪家店。
 */
export function withSourcePaths(argv, { shopXlsx, promotionZip } = {}) {
  const both = Boolean(shopXlsx) && Boolean(promotionZip);
  const neither = !shopXlsx && !promotionZip;
  if (!both && !neither) {
    throw new Error(`源产物路径只给了一半（${shopXlsx ? '只有 --shop-xlsx' : '只有 --promotion-zip'}）`
      + ' —— 一半手填一半来自采集段，两种来源混着用。停手。');
  }
  if (neither) {
    throw new Error('没有拿到 shopXlsxPath / promotionZipPath：push 的这两个参数是必填，不猜路径。'
      + '要么让采集段（shop-report / promotion-fetch）在本轮里跑过，'
      + '要么用 --shop-xlsx + --promotion-zip 显式给一对（单独重跑推送段时）。');
  }
  for (const [flag, value] of [['--shop-xlsx', shopXlsx], ['--promotion-zip', promotionZip]]) {
    if (!existsSync(value)) throw new Error(`采集/命令行给的源产物不存在：${flag} ${value}`);
  }
  const cleaned = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--shop-xlsx' || argv[i] === '--promotion-zip') { i += 1; continue; }
    cleaned.push(argv[i]);
  }
  return cleaned.concat(['--shop-xlsx', shopXlsx, '--promotion-zip', promotionZip]);
}

/**
 * 这次代理请求的失败，**该不该重发一次**。
 *
 * 判据只有一条：**我们到底拿到 HTTP 应答没有**。
 *   没拿到（连接建不起来、建起来被重置、等到超时）⇒ 可重试：这是传输层的一次意外，
 *     下一次很可能就成。`fetch failed` 正是 undici 在 ECONNREFUSED / ECONNRESET /
 *     socket hang up 这几种情况上的统一外衣，所以它必须算进来（`cause.code` 也一并看）。
 *   拿到了（4xx/5xx）⇒ **不重试**：服务端已经给了答案，重发只会把同一个答案再问一遍，
 *     而真正要做的是把那个答案报上去（例如 400 的 `sycm date readout count=0`）。
 *
 * 为什么值得为这一条写代码（2026-09-21 第二轮排练的现场）：
 *   四家店都在第 8 步（生意参谋回位）报 `ERROR fetch failed`，而同一个端口
 *   ①71 秒前刚被第 4 步正常用过（exit 0）、②失败后 20 秒被失败收尾的只读快照又读通了
 *   （四家里三家 recovery 的 `leftAt` 有值）、③代理自己一条日志都没写（它只在连接/断开时写）、
 *   ④事后 90/90 次 TCP 全通、6/6 次 `GET /targets` 全 200。
 *   ⇒ 那不是「代理死了」，是一次**瞬时**连接失败；而它落在了一个本来已经快跑完的轮次上，
 *   把整轮判成失败（在这一步之前，飞书那一次写入已经发生）。
 *
 * 重发**安全**的前提，写在这里因为将来会有人想复用这个 helper：
 *   本文件里非只读的调用只有 `resetSycmPage` 的 `/navigate`，它把一个页签送到一个**固定 URL**
 *   ⇒ 发一次与发两次的效果相同。**将来若拿它去发 `eval`（点按钮那类），必须先回来重证这一条。**
 */
export function judgeProxyRetryable(error) {
  const message = String(error?.message ?? '');
  const cause = String(error?.cause?.code ?? error?.cause?.message ?? '');
  const both = `${message} ${cause}`;
  // 超时也是「没拿到应答」——`AbortSignal.timeout()` 给的是 TimeoutError。
  if (/TimeoutError|timed?\s*out|timeout|aborted/iu.test(both)) return true;
  return /\b(?:fetch failed|ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|EHOSTUNREACH|ENETUNREACH|socket hang up|UND_ERR_SOCKET)\b/iu
    .test(both);
}

const PROXY_ATTEMPTS = 3;
const PROXY_BACKOFF_MS = 1500;

// 导出是为了让「重试真的发生了」这件事能被**行为**断言到（见 run-multi-shop-day.test.mjs
// 里换掉 globalThis.fetch 的那两条）。只扫源码的接线判据挡不住「判据接上了但重试次数写错」。
export const proxyJson = async (url, init) => {
  let lastError = null;
  for (let attempt = 1; attempt <= PROXY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `proxy request failed: HTTP ${response.status}`);
      if (attempt > 1) console.log(`[代理] 第 ${attempt} 次才通：${url}`);
      return payload;
    } catch (error) {
      lastError = error;
      if (!judgeProxyRetryable(error)) throw error;
      if (attempt === PROXY_ATTEMPTS) break;
      const cause = error?.cause?.code ?? error?.cause?.message ?? null;
      console.log(`[代理] 连接层失败（第 ${attempt}/${PROXY_ATTEMPTS} 次）：${error?.message ?? error}`
        + `${cause ? `｜cause=${cause}` : ''} → ${PROXY_BACKOFF_MS / 1000}s 后重发 ${url}`);
      await new Promise((r) => { setTimeout(r, PROXY_BACKOFF_MS); });
    }
  }
  // 重试完还是不通 ⇒ 如实报出来，并且**要说清试了几次**：只说一句 fetch failed 的话，
  // 事后分不清「抖了一下」与「代理一直不在」。
  throw new Error(`代理连不上（连试 ${PROXY_ATTEMPTS} 次）：${url}`
    + ` —— 最后一次：${lastError?.message ?? lastError}`
    + `${lastError?.cause ? `（cause=${lastError.cause.code ?? lastError.cause.message}）` : ''}`);
};

// ------------------------------------------------- 失败路径：先把页面送回中性态

/**
 * 一家店停手时，页面到底停在哪儿 —— **只读快照**（纯函数；输入就是代理 `/targets` 的返回）。
 *
 * 为什么非要先留这一份：紧接着就要把它回位，而回位会把「它当时漂到哪儿」擦掉 ——
 * 那一句（`…/shop/performance` 还是 `…/report/preview?…`）正是事后判断「这一步为什么失败」
 * 的唯一线索。所以顺序固定是**先取证、再回位**，两份快照都落进 `summary.json` 可以并排比。
 *
 * `foreign` = 既不属于期望清单里任何一页的那些页。缺页时正需要它：漂走的那一页就在这里面。
 */
export function describePageWhereabouts(targets = [], expected = []) {
  const urls = (Array.isArray(targets) ? targets : [])
    .filter((tab) => !tab?.type || tab.type === 'page')
    .map((tab) => String(tab?.url ?? ''));
  return {
    tabs: urls.length,
    slots: expected.map((page) => ({
      page: page.name,
      count: urls.filter((url) => url.includes(page.urlFragment)).length,
    })),
    foreign: urls.filter((url) => !expected.some((page) => url.includes(page.urlFragment))),
  };
}

/**
 * 回位之后到底回没回位。
 *
 * **只按「回位后那一份快照」判，不看回位调用报没报错**：`resetSycmPage` 内部已经自检过一次，
 * 但那是它自己说的；这里用**与体检、落位同源的**那份期望页面清单再数一遍，两份结论不一致时
 * 以这一份为准。快照给 null（代理读不到）时**不算回位成功** —— 读不到就不知道，
 * 而这一条的作用正是「别把不知道当成好」。
 */
export function judgeResetLanded({ before = null, after = null, page = '生意参谋工作页' } = {}) {
  const countOf = (snapshot) => (snapshot?.slots ?? []).find((slot) => slot.page === page)?.count ?? null;
  const beforeCount = countOf(before);
  const afterCount = countOf(after);
  if (afterCount === 1) return { restored: true, beforeCount, afterCount, detail: `回位后 ${page} 恰好一个` };
  return { restored: false, beforeCount, afterCount,
    detail: `回位后 ${page} 是 ${afterCount ?? '读不到（代理连不上）'} 个（回位前 ${beforeCount ?? '读不到'} 个）`
      + ' —— 下一轮仍然会从这个起点开始，先看现场' };
}

/**
 * 生意参谋回位。
 *
 * 为什么不能只靠 `resolveTarget` 那个自愈分支：它要求「同一主机下**恰好一个**页面」。
 * 店铺浏览器里本来就有一个 `sycm.taobao.com/portal/home.htm`，而第 4 步把性能页导成了
 * 报表预览页 ⇒ 同主机两个页面 ⇒ 自愈分支不成立（它宁可报错也不乱导航，这是对的）。
 * 所以这里显式做：找到**那个被带走的页签**（同主机、既不是首页也不是性能页），送它回去。
 * 认不出来就如实报错并列出所有页面，**不猜**。
 */
async function resetSycmPage({ proxy, log }) {
  const targets = (await proxyJson(`http://127.0.0.1:${proxy}/targets`))
    .filter((t) => t.type === 'page');
  const sycmPages = targets.filter((t) => String(t.url).includes('sycm.taobao.com'));
  const performing = sycmPages.filter((t) => String(t.url).includes(SYCM_FRAGMENT));
  if (performing.length === 1) {
    log(`回位：不需要 —— 已经恰好一个性能页（${performing[0].url.slice(0, 80)}）`);
    return { action: 'none', pages: sycmPages.map((t) => t.url) };
  }
  const drifted = sycmPages.filter((t) => !String(t.url).includes('portal/home'));
  if (performing.length === 0 && drifted.length === 1) {
    log(`回位：把 ${drifted[0].url.slice(0, 90)} 送回 ${SITE_SYCM_ENTRY}`);
    await proxyJson(`http://127.0.0.1:${proxy}/navigate?target=${encodeURIComponent(drifted[0].targetId)}`
      + `&url=${encodeURIComponent(SITE_SYCM_ENTRY)}`, { method: 'POST', body: '' });
    await new Promise((r) => { setTimeout(r, 3000); });
    const after = (await proxyJson(`http://127.0.0.1:${proxy}/targets`))
      .filter((t) => t.type === 'page' && String(t.url).includes(SYCM_FRAGMENT));
    if (after.length !== 1) {
      throw new Error(`回位后仍不是恰好一个性能页（${after.length} 个）—— 停手，先看现场`);
    }
    return { action: 'navigated', pages: after.map((t) => t.url) };
  }
  throw new Error(`生意参谋页的样子不是我预期的，回位不敢乱动。同主机 ${sycmPages.length} 个页面：\n`
    + sycmPages.map((t) => `  · ${t.url}`).join('\n'));
}

// 告警节流的状态文件。放在 `runtime/` 下是因为那里**不进 git**（`.gitignore` 的
// `runtime/**/*.json`），而它是本机的运行状态、不是要交付的东西。
// 名字直白写清它是什么，别让后来的人以为这是采集产物。
const ALERT_THROTTLE_FILE = path.join(REPO_ROOT, 'runtime/alert-throttle.json');

/**
 * 同一条编号的告警在时间窗内不重复发。
 *
 * 为什么要有这一层：投递链本身**不去重**（`alertId` 只是给调用方用的锚），而这条链的编号只有日期
 * （`daily-round-20260920`）⇒ 同一天每次重跑失败都会再发一条。后果不是「多收几条」，
 * 而是收信人开始忽略这个通道 —— 而它是唯一会叫人动手的通道。
 *
 * 指纹是保险：**同一个编号、但停的地方变了**（例如从「生意参谋没切过去」变成「飞书写重复」）
 * 是新信息，不该被当成重复挡掉。只有「编号相同 + 停的地方也相同」才算重复。
 * 时间读不懂时**宁可发**（沉默的代价比多收一条大）。
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

function readAlertThrottle(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function writeAlertThrottle(entry, file) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  } catch { /* 节流状态写不下去不该影响主流程：那只会导致多发一条，比漏发安全 */ }
}

/**
 * 把告警交给既有的投递出口，并把它的结论如实打出来。
 *
 * 文案用**真渲染器**（`renderAlertText`）而不是自己拼一遍 —— 自己拼的那份会和收信人
 * 实际看到的东西漂移，而漂移的症状是「本地看着对、飞书里少一行」（白名单会静默吞字段）。
 */
export function dispatchRoundAlert({ alert, dispatch, logDir = null, spawn = spawnSync, log = console.log,
  throttleFile = ALERT_THROTTLE_FILE, now = () => new Date() }) {
  const text = renderAlertText(alert);
  // **不管发不发，先把收信人会看到的那份完整打进本地日志。**
  // 技术串已经从业务消息里撤掉了，job.log 就成了事后唯一能对上「他到底看到了什么」的地方。
  log(`[驱动] 告警文案（收信人看到的）：\n${text}`);
  if (dispatch.action === 'print') {
    log('[驱动] （--notify-print：只打印、不投递）');
    return { delivered: false, printed: true };
  }
  const verdict = resolveAlertDedup({ previous: readAlertThrottle(throttleFile),
    alertId: alert?.alertId, fingerprint: alert?.fingerprint, now: now() });
  if (!verdict.send) {
    log(`[驱动] 这一条没往外发：${verdict.reason}（编号 ${alert?.alertId ?? '无'}）`);
    return { delivered: false, suppressed: true, reason: verdict.reason };
  }
  const result = spawn(NODE, [NOTIFY_CLI], {
    input: JSON.stringify(alert), cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000,
  });
  const receipt = String(result.stdout || result.stderr || '').trim().slice(0, 300);
  log(`[驱动] 告警投递退出码=${result.status}：${receipt}`);
  if (result.status !== 0) {
    // 这条比失败本身更要紧：**失败已经有记录，但没人知道**。
    console.error('[驱动] 告警没送出去 —— 现在只有屏幕知道这一轮失败了，必须有人接手（见上面的投递收据）。'
      + `${logDir ? `日志在 ${logDir}` : ''}`);
  } else {
    // 只有真的送出去了才记时间：送失败还记账，会让下一次重跑被自己的记录挡掉。
    writeAlertThrottle({ alertId: alert?.alertId ?? null, fingerprint: alert?.fingerprint ?? null,
      sentAt: new Date(now()).toISOString() }, throttleFile);
  }
  return { delivered: result.status === 0, printed: false, suppressed: false };
}

function runStage(shopKey, stage, { repoRoot, logDir }) {
  const log = (line) => console.log(`[${shopKey}] ${line}`);
  const outPath = path.join(logDir, `${String(stage.index).padStart(2, '0')}-${stage.stage}.txt`);
  const startedAt = new Date().toISOString();
  const scriptPath = path.join(repoRoot, 'skills/sycm-alimama-daily-report/scripts', stage.script);
  const command = `${NODE} ${formatArgv([scriptPath, ...stage.argv])}`;
  const result = spawnSync(NODE, [scriptPath, ...stage.argv], {
    cwd: repoRoot, encoding: 'utf8',
    env: { ...process.env, ...stage.env },
  });
  const text = `\n===== ${startedAt} =====\n$ ${command}\nexit=${result.status} signal=${result.signal ?? ''} error=${result.error?.message ?? 'none'}\n`
    + `--- stdout ---\n${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}`;
  writeFileSync(outPath, text, 'utf8');
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  for (const line of combined.split(/\r?\n/)) {
    // 采集段的两条路径标记与推送段那行 `[shop-key]` 都要在驱动这一层露出：
    // 前者是后面 push 的入参，后者是「证据目录贴对了店铺没有」当天唯一的当场证据。
    if (/^\s*(?:\[[^\]]+\]\s*)?(shopXlsxPath|promotionZipPath) = \S/u.test(line) || /\[shop-key\]/u.test(line)) log(line.trim());
  }
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
    logPath: path.relative(repoRoot, outPath), command };
}

/**
 * 从某个阶段的 stdout 里取产物路径。
 *
 * 为什么不能只认行首：两个采集脚本的打印格式**不一样**（实测原文）——
 *   collect-shop-report.mjs      `      shopXlsxPath = …`（缩进，没有前缀）
 *   collect-promotion-report.mjs `[fetch] promotionZipPath = …`（有 `[fetch] ` 前缀）
 * 只写 `^\s*<marker> = ` 会让推广 zip 的路径永远抓不到，而症状是「采集成功、push 报没有拿到路径」——
 * 一个看起来像采集问题的驱动问题。所以这里允许一个可选的行首 `[xxx] ` 前缀。
 */
export const findPath = (text, marker) => {
  const match = new RegExp(`^\\s*(?:\\[[^\\]]+\\]\\s*)?${marker} = (.+)$`, 'mu').exec(text);
  return match ? match[1].trim() : null;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.commit ? 'commit' : args.verifyExisting !== null ? 'verify' : 'rehearse';
  const shops = args.shops ?? shopBrowserKeys();
  for (const key of shops) shopInstance(key);
  const logRoot = path.resolve(args.logs ?? path.join(REPO_ROOT, 'evidence', `multi-shop-${args.date}`));
  const downloads = args.downloads ?? null;
  const explicitSources = { shopXlsx: args.shopXlsx, promotionZip: args.promotionZip };
  // 失败的告警在**两个**失败出口都要能发（整轮没跑起来 / 某家店停在半路），所以算一次、用两次。
  const alertDispatch = resolveAlertDispatch({ notify: args.notify, notifyPrint: args.notifyPrint, mode });

  console.log(`[驱动] 目标日 ${args.date}｜模式 ${mode}｜店铺 ${shops.length} 家：${shops.join(' / ')}`);
  // 字面量被解析过就要说清楚解析成了哪天 —— 定时跑出来的日志里，这一行是唯一的对账依据
  // （事后没人能从 `--date yesterday` 反推出它当时算的是哪一天）。
  if (args.dateInput !== args.date) console.log(`[驱动] （--date ${args.dateInput} 按 Asia/Shanghai 解析成 ${args.date}）`);
  console.log(`[驱动] 日志根 ${logRoot}`);
  // 主机名只留在驱动侧日志里（排障要「哪台机器」），**不进告警文案**：
  // 收信人是运营，`DESKTOP-KJP4RA5` 对他们没有任何可执行含义（2026-09-21 就发过这个）。
  console.log(`[驱动] 本机 ${MACHINE}`);
  if (mode === 'commit') console.log('[驱动] --commit：会真的写飞书。目标日已有行会硬重复停止（先按 §9.3 删那天）。');
  if (mode === 'verify') console.log(`[驱动] 只读核对模式：--expected-before-count ${args.verifyExisting}（不写飞书）`);
  if (mode === 'rehearse') console.log('[驱动] 排练模式：采集是真的，两个写入方都是干跑，不写飞书。');
  if (args.notify || args.notifyPrint) console.log(`[驱动] 出错时：${alertDispatch.why}`);
  for (const key of shops) console.log(`[驱动]   ${describeIdentity(key)}`);

  const summary = { date: args.date, mode, startedAt: new Date().toISOString(), round: {}, shops: {} };

  // 一轮一次：商家浏览器的体检。推送段与回读段都跑在它上面，而飞书底单页只在那一个浏览器里
  // （采集段在别处 ⇒ 它们各自的体检在各店自己的阶段里）。它不通过就整轮都不必跑，
  // 所以这一条**与 --keep-going 无关**：换哪家店都缺同一个前提。
  // browserKey 取自路线表（`ROUTES.dailyReport.browser`），不写死键名。
  mkdirSync(logRoot, { recursive: true });
  const roundHealth = await runHealthCheck({
    shopKey: null,
    stage: { stage: 'health-check-daily', index: 0 },
    logDir: logRoot,
    repoRoot: REPO_ROOT,
    browserKey: ROUTES.dailyReport.browser,
    expectedPages: expectedPagesForDailyBrowser(),
  });
  summary.round.healthCheckDaily = {
    status: roundHealth.status,
    logPath: roundHealth.logPath,
    ok: roundHealth.detail?.ok ?? null,
    blocking: roundHealth.detail?.blocking?.map((f) => f.code) ?? null,
    // 告警里要写清「哪一页不齐」，所以明细也得留下来（只留 code 的话告警只能说「体检没过」）。
    blockingDetails: roundHealth.detail?.blocking?.map((f) => f.detail) ?? null,
    // 归位的结论也要留：体检从「只看」变成「先归位、再看」之后，
    // 「这次本来就不齐、是脚本自己修好的」与「本来就好」在 summary 上必须分得开。
    normalize: roundHealth.normalize?.verdict?.detail ?? null,
    normalizeChanged: roundHealth.normalize?.changed ?? null,
  };
  if (roundHealth.status !== 0) {
    console.error('[驱动] 商家浏览器体检未通过 ⇒ 整轮不跑（推送段与回读段都要用它）。'
      + `详见 ${roundHealth.logPath}`);
    summary.finishedAt = new Date().toISOString();
    writeFileSync(path.join(logRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    process.exitCode = 1;
    if (alertDispatch.action !== 'off') {
      dispatchRoundAlert({
        alert: buildRoundFailureAlert({ date: args.date, summary, shopKeys: shops }),
        dispatch: alertDispatch, logDir: path.relative(REPO_ROOT, logRoot),
      });
    }
    return;
  }

  for (const key of shops) {
    const shopLogDir = path.join(logRoot, key);
    mkdirSync(shopLogDir, { recursive: true });
    const record = { status: 'pending', stages: [], source: {} };
    summary.shops[key] = record;
    let index = 0;
    const run = async (stage) => {
      index += 1;
      const withIndex = { ...stage, index };
      if (args.only && !args.only.includes(stage.stage)) {
        console.log(`[${key}] ${index}. ${stage.stage} —— 跳过（--only 没点名）`);
        return { status: 0, skipped: true, stdout: '', logPath: null };
      }
      console.log(`[${key}] ${index}. ${stage.stage} —— ${stage.note}`);
      let result;
      if (withIndex.ownAction === 'health') {
        result = await runHealthCheck({ shopKey: key, stage: withIndex, logDir: shopLogDir, repoRoot: REPO_ROOT });
      } else if (withIndex.ownAction === 'reset') {
        result = await runReset(key, withIndex, { logDir: shopLogDir, repoRoot: REPO_ROOT });
      } else {
        result = runStage(key, withIndex, { repoRoot: REPO_ROOT, logDir: shopLogDir });
      }
      record.stages.push({ stage: stage.stage, status: result.status, skipped: Boolean(result.skipped),
        logPath: result.logPath ?? null, argv: stage.argv,
        // 体检到底拦在哪一条，要跟着收据一起留下来：告警里那句「哪一页不齐」就是从这儿来的。
        // 不记的话，收信人只能看到「体检没过」，还得自己去翻日志（＝太笼统）。
        blockingDetails: result.detail?.blocking?.map((finding) => finding.detail) ?? null,
        // 体检那一支的归位结论（别的阶段是 null）：它回答「这次的不齐是本来就坏、还是脚本修好的」。
        pageNormalize: result.normalize?.verdict?.detail ?? null });
      return result;
    };

    try {
      for (const stage of buildShopStages(key, { date: args.date, mode, expectedBeforeCount: args.verifyExisting, downloads,
        allowMissingPeer: args.allowMissingPeer })) {
        // 采集段产出的两条路径要在 push 之前填进参数。**三种模式都要填**：
        // `--shop-xlsx` / `--promotion-zip` 在 run-daily-report.mjs 里是必填参数，
        // 「只读核对就不给源文件」会让 push 直接 missing required argument —— 那就不是只读，
        // 而是连核对都没跑。所以 verify 与 commit 一样要带上采集段的产物路径。
        let argv = stage.argv;
        if (stage.stage === 'push') {
          const sources = explicitSources.shopXlsx
            ? explicitSources
            : { shopXlsx: record.source.shopXlsx, promotionZip: record.source.promotionZip };
          // 显式给的与采集段报的是两份真相 —— 同时存在且不同就是「有一份是假的」。
          if (explicitSources.shopXlsx && record.source.shopXlsx
            && explicitSources.shopXlsx !== record.source.shopXlsx) {
            throw new Error('--shop-xlsx 与采集段报出来的工作簿不是同一个文件'
              + `（命令行 ${explicitSources.shopXlsx}／采集段 ${record.source.shopXlsx}）—— 停手`);
          }
          argv = withSourcePaths(stage.argv, sources);
        }
        const result = await run({ ...stage, argv });
        if (result.status !== 0) {
          record.status = 'failed';
          record.failedStage = stage.stage;
          // 告警要用的两份证据，**必须在抛错之前留下**（抛出去之后就没了）：
          // ① 子进程最后那几行 —— 「这一天已经写过了」那句就藏在这里（靠它才分得出
          //    「不用处理」和「要人去登录」两种完全不同的下一步）；
          // ② 体检的阻断明细 —— 告警里「哪一页不齐」那句就是从这儿来的。
          record.failureOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(-4000);
          record.blockingDetails = result.detail?.blocking?.map((finding) => finding.detail) ?? null;
          const tail = String(result.stderr ?? '').trim().split(/\r?\n/u).slice(-12).filter(Boolean);
          if (tail.length) console.error(`[${key}]   stderr 尾部：\n${tail.map((l) => `      ${l}`).join('\n')}`);
          throw new Error(`阶段 ${stage.stage} 失败（exit ${result.status ?? result.signal}）`);
        }
        if (stage.stage === 'shop-report') {
          record.source.shopXlsx = findPath(result.stdout, 'shopXlsxPath');
          if (record.source.shopXlsx) console.log(`[${key}]   店铺工作簿 = ${record.source.shopXlsx}`);
        }
        if (stage.stage === 'promotion-fetch') {
          record.source.promotionZip = findPath(result.stdout, 'promotionZipPath');
          if (record.source.promotionZip) console.log(`[${key}]   推广 zip = ${record.source.promotionZip}`);
        }
      }
      record.status = 'ok';
    } catch (error) {
      record.error = error.message;
      console.error(`[${key}] 停在这一步：${error.message}`);
      // 失败也要收尾：先把「停手时页面停在哪」记下来，再把它送回中性态（证据先于处置，
      // 见 recoverFailedShop 的三条纪律）。位置**刻意放在「停整轮」之前** —— 放到之后的话，
      // 默认策略下断掉整个 for 循环，而唯一失败的那一家恰恰就是不会被收尾的那一家。
      record.recovery = await recoverFailedShop({ shopKey: key, logDir: shopLogDir, repoRoot: REPO_ROOT });
      if (!args.keepGoing) {
        console.error(`[驱动] 按默认策略停整轮（要看完全部店加 --keep-going）。已跑的店记在 ${path.relative(REPO_ROOT, logRoot)}。`);
        break;
      }
    }
  }

  summary.finishedAt = new Date().toISOString();
  const summaryPath = path.join(logRoot, 'summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log('\n[驱动] 汇总：');
  for (const [key, record] of Object.entries(summary.shops)) {
    console.log(`  ${key}：${record.status}${record.failedStage ? `（停在 ${record.failedStage}）` : ''}`
      + `${record.error ? ` —— ${record.error}` : ''}`);
  }
  console.log(`[驱动] 明细 ${path.relative(REPO_ROOT, summaryPath)}`);
  const anyFailed = Object.values(summary.shops).some((r) => r.status !== 'ok');
  if (anyFailed) {
    process.exitCode = 1;
    if (alertDispatch.action !== 'off') {
      dispatchRoundAlert({
        alert: buildRoundFailureAlert({ date: args.date, summary, shopKeys: shops }),
        dispatch: alertDispatch, logDir: path.relative(REPO_ROOT, logRoot),
      });
    } else if (args.notify || args.notifyPrint) {
      console.log(`[驱动] 没发提醒：${alertDispatch.why}`);
    }
  } else if (args.notify || args.notifyPrint) {
    // 成功要留一行「没发提醒」：否则「没收到消息」与「消息没发出去」在事后看起来一模一样。
    console.log(`[驱动] ${shops.length} 家店都收完了，没发提醒（--notify 只在出错时叫人）。`);
  }
}

// 体检也是驱动自己做的：它要按**浏览器实例**参数化，而且没有现成脚本。
//
// 判据：有 blocking 项就停这一家（fail-closed）。这与「探针没读到不停线」不冲突 ——
// 「没读到」在体检模块内部已经被降级成非 blocking（`AUTH_UNKNOWN`），
// 能走到这里的 blocking 都是「读到了，而且不对」。
/**
 * 体检结论 → 阶段退出码。**读不出来也不算通过**（返回 3）。
 *
 * 这是 fail-closed 的另一半：只有明确 `ok: true` 才放行。写成 `result.ok ? 0 : 2` 也「看起来对」，
 * 但那样 `undefined` / 少了 `ok` 字段的返回值会落进 2 或 0，取决于怎么写 —— 而体检模块与驱动
 * 是两个文件，它的返回形状将来变了，这里**不会**报错，只会安静地换个结论。
 * 抽成纯函数是为了让它能被离线断言：`null` 与 `{}` 必须也是「不放行」。
 */
export function healthStageStatus(result) {
  if (!result || typeof result.ok !== 'boolean') return 3;
  return result.ok ? 0 : 2;
}

/**
 * 浏览器键 → 它自己那个 CDP 代理端口。
 *
 * 权威仍是**路线表 + 店铺登记表**，这里只做一次换算（各阶段的 `env.CDP_PROXY_PORT` 也来自同一处）。
 * 认不出来就**抛错**，绝不回落到某个默认端口 —— 回落一次就是「往别的店/别的项目上写」，
 * 而症状是那家店「跑完了但什么也没采到」。
 */
export function proxyPortForBrowser(browserKey) {
  if (shopBrowserKeys().includes(browserKey)) return shopInstance(browserKey).proxyPort;
  if (browserKey === ROUTES.dailyReport.browser) return PROJECT_PORTS.dailyReportProxy;
  throw new Error(`浏览器「${browserKey}」没有登记的代理端口 —— 不猜（猜错就是往别的浏览器上写）`);
}

async function runHealthCheck({ shopKey, stage, logDir, repoRoot, browserKey = null, expectedPages = null }) {
  const label = shopKey ?? '一轮';
  const outPath = path.join(logDir, `${String(stage.index).padStart(2, '0')}-${stage.stage}.txt`);
  const lines = [];
  const log = (line) => { lines.push(line); console.log(`[${label}]   ${line}`); };
  let status = 0;
  let result = null;
  const pages = expectedPages ?? expectedPagesForShop();
  const key = browserKey ?? shopKey;

  // ── 归位：体检从「只看」升级成「先归位、再看」（2026-09-21）──────────────────
  // 缺页的绝大多数情形是「那一页并没有丢，只是被上一轮的第 5 步带到别的 URL 了」（2026-09-20 实测）。
  // 从前这一条会让**整家店一步都不跑**并叫人来补，而那是脚本顺手能做完的事。
  // 判据一分都不放宽：归位只负责把可修的修掉，修不掉的照样由下面的体检拦住。
  // 它也不抢答「连不上」：代理不通时交给体检去报（体检有它自己的连通性判据）。
  let normalize = null;
  try {
    normalize = await normalizePages({ proxyPort: proxyPortForBrowser(key), expected: pages });
    log(`归位：${normalize.verdict.detail}`);
    for (const action of normalize.actions) {
      if (action.action === 'already-one') continue;
      log(`  [归位] ${action.page}：${action.action}`
        + `${action.error ? `（${action.error}）` : ''}${normalize.dry ? '（只读，未真做）' : ''}`);
    }
  } catch (error) {
    log(`归位没做成（不改体检结论，交给下面那条判据）：${String(error?.message ?? error).split('\n')[0]}`);
  }

  try {
    const check = createPlatformHealthCheck({
      browserKey: key,
      expectedPages: pages,
    });
    result = await check({});
    const warnings = result.findings.filter((finding) => !finding.blocking);
    log(`体检${result.ok ? '通过' : '未通过'}：阻断 ${result.blocking.length} 项，告警 ${warnings.length} 项`);
    for (const finding of result.blocking) log(`  [阻断] ${finding.code}：${finding.detail}`);
    for (const finding of warnings) log(`  [告警] ${finding.code}：${finding.detail}`);
    log(`  ${result.note}`);
    status = healthStageStatus(result);
  } catch (error) {
    // 体检自己出错（模块加载/参数问题）⇒ 记非零，不静默当成通过。
    lines.push(`ERROR ${error.message}`);
    status = 3;
  }
  lines.push('');
  lines.push(JSON.stringify({ normalize, check: result }, null, 2));
  writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
  return { status, stdout: lines.join('\n'), detail: result, normalize, logPath: path.relative(repoRoot, outPath) };
}

// 回位是驱动自己做的（没有现成脚本），日志格式与别的阶段一致，便于按同一套办法看。
async function runReset(shopKey, stage, { logDir, repoRoot }) {
  const outPath = path.join(logDir, `${String(stage.index).padStart(2, '0')}-${stage.stage}.txt`);
  const lines = [];
  const log = (line) => { lines.push(line); console.log(`[${shopKey}]   ${line}`); };
  let status = 0;
  let detail = null;
  try {
    // 这一支只有驱动自己在做 I/O（要 navigate）⇒ 必须 await，否则「阶段报成功但页面没动」。
    detail = await resetSycmPage({ proxy: stage.env.CDP_PROXY_PORT, log });
  } catch (e) {
    lines.push(`ERROR ${e.message}`);
    status = 1;
  }
  writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
  return { status, stdout: lines.join('\n'), detail, logPath: path.relative(repoRoot, outPath) };
}

/**
 * 失败路径的收尾：**先把「停手时页面在哪」记下来，再把它送回中性态，然后按期望清单再数一遍。**
 *
 * 为什么失败也要做（2026-09-21 的第一性原理分析）：这个浏览器**不会关**（登录态在里面），
 * 所以每一轮结束时的页面位置就是下一轮的起点。成功路径靠第 8 步回位；而失败路径从前什么都不做
 * ⇒ 一次失败把脏状态留给下一天，脏状态再制造下一次失败 —— 这是这条链上唯一会自己长大的东西。
 *
 * 三条纪律：
 *   1) **证据先于处置**：先 `describePageWhereabouts` 再回位。反过来的话「当时漂到哪儿」就没了，
 *      而下一轮正是要拿它当起点。
 *   2) **绝不吞掉原来那个错**：本函数自己 try 住一切，永远返回对象、永不抛。抛出去会盖掉
 *      「这一轮为什么失败」，那才是主线。
 *   3) 回位没做成**只记本地**（`summary.json` 的 `recovery` + `99-recovery.txt`），**不进告警文案** ——
 *      那是技术信息，业务收信人看不懂（见 `assertAlertIsBusinessReadable` 与它的用例）。
 *
 * 依赖注入（`readTargets` / `reset`）与 `settleSlots` 同一个理由：真机才有代理，而这一支的
 * 三个分支（回位成功、回位抛错、代理读不到）必须在离线里都能断言到 —— 「只在真机上跑过」
 * 正是上次漏掉这一步的原因。
 */
export async function recoverFailedShop({ shopKey, logDir, repoRoot, readTargets = null, reset = null }) {
  const proxy = shopInstance(shopKey).proxyPort;
  const expected = expectedPagesForShop();
  const read = readTargets ?? (() => proxyJson(`http://127.0.0.1:${proxy}/targets`).catch(() => null));
  const doReset = reset ?? ((options) => resetSycmPage(options));
  const outPath = path.join(logDir, '99-recovery.txt');
  const lines = [];
  const log = (line) => { lines.push(line); console.log(`[${shopKey}]   ${line}`); };
  const snapshot = (targets) => (targets ? describePageWhereabouts(targets, expected) : null);
  const recovery = { at: new Date().toISOString(), proxyPort: proxy, leftAt: null, action: null,
    after: null, restored: null, detail: null, error: null };

  try {
    const before = await read();
    recovery.leftAt = snapshot(before);
    if (recovery.leftAt) {
      log(`停手时页面停在：${recovery.leftAt.slots.map((slot) => `${slot.page}=${slot.count}`).join('  ')}`
        + `（共 ${recovery.leftAt.tabs} 个页签）`);
      for (const url of recovery.leftAt.foreign) log(`  · 不属于期望清单：${String(url).slice(0, 110)}`);
    } else {
      log('停手时读不到页面（代理连不上）—— 回位这一支先当学不到，下面照样试一次');
    }

    const detail = await doReset({ proxy, log });
    recovery.action = detail?.action ?? null;

    const after = await read();
    recovery.after = snapshot(after);
    const verdict = judgeResetLanded({ before: recovery.leftAt, after: recovery.after });
    recovery.restored = verdict.restored;
    recovery.detail = verdict.detail;
    log(verdict.detail);
  } catch (error) {
    // 回位自己失败（认不出页面、代理连不上、navigate 回非 2xx）—— 如实记下，**不抛**。
    recovery.error = String(error?.message ?? error);
    log(`回位没做成：${recovery.error}`);
  }

  try { writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8'); } catch { /* 日志写不下去不该再抛一次 */ }
  recovery.logPath = path.relative(repoRoot, outPath);
  return recovery;
}

// 顶层入口：main 是 async（回位那一支要 await），所以这里也要 await。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
