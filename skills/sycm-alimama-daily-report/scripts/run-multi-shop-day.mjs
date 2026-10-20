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
//   --login-preflight <文件>  跑前登录态结论（`check-login-shops.mjs --json` 的产物）。
//                        给了它，失败告警才会**点名哪个店哪个后台掉登录** —— 那正是「页面不齐」的
//                        真因；不给就是「这一轮没查过」，告警会如实这么写（不假装查过）。
//                        读不到那个文件**不报错、也不拦采集**：它是诊断层，不是闸门。
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
// 但**今天实际用的不是上面这一条**：定时任务跑的是 `scripts/run-daily-job.mjs`，
// 它先起实例、再跑一次只读的登录态体检、最后才跑链 —— 并把那份体检的结论用
// `--login-preflight <文件>` 交给链（见 runtime/daily-job-plan.mjs）。所以上面那条
// 裸命令只在「手动排障」时用；用它跑的失败告警会如实说「这一轮没有先查登录态」。
//
// 为什么日期要写成字面量 `yesterday` 而不是让调度器去算：调度器算日期就是把
// 「Asia/Shanghai 的昨日」这条口径抄到命令之外，抄一份就是等着它与落位脚本漂移。
// 这里用**落位脚本同一个函数**（`date-picker.mjs` 的 `shanghaiToday`/`shiftIso`，2026-10-06 起
// 连 `resolveTargetDate` 本身也住在那里、本文件只是转出）解析，且只认这一个字面量 ——
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
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 告警节流（同一条编号在时间窗内不重复发）的唯一实现在 runtime/alert-throttle.mjs
// （2026-09-24 抽出）。抽出的理由是**第二条会叫人的链**（跑前登录守卫）没有它 ——
// 判据只写在本文件旁边时，就只有本文件有判据：那次实测并发 5 条同一天的登录告警。
import { ALERT_THROTTLE_FILE, readAlertThrottleEntry, resolveAlertDedup, writeAlertThrottle } from '../../../runtime/alert-throttle.mjs';
// `shopBrowserKeys` 仍要留：它是**实例**口径（`proxyPortForBrowser` 要认任何一家已登记店），
// 而 `collectingShopKeys` 是**采集**口径（默认跑哪几家）。两者在「有没有还没开始收集的店」上会不同。
import { BROWSER_IDS, BROWSER_LABELS, PROJECT_PORTS, ROUTES, collectingShopKeys, shopBrowserKeys, shopInstance } from '../../../runtime/browser-ports.mjs';
import { normalizePages } from '../../../runtime/page-normalize.mjs';
// 「页签属于哪个期望页面」的唯一判据（2026-09-22 收编）。这里原先也是整串 `includes`，
// 而生意参谋的登录跳转页把目标地址放在 `_target=` 里 ⇒ 会被算成工作页 ⇒ 这份「停手快照」
// 会报出错误的位置、`judgeResetLanded` 也会判错。判据必须与体检、落位同源。
import { urlMatchesFragment } from '../../../runtime/target-url-match.mjs';
import { READABLE_SOURCE_KEYS, renderAlertText } from '../../../runtime/notify-feishu-core.mjs';
import { HEALTH_CODES, createPlatformHealthCheck } from '../../../runtime/xws-platform-health-preflight.mjs';
// 日期原语（`shiftIso`/`shanghaiToday`/`resolveTargetDate`）的 import 挪到下面
// 「目标日：只有一个来源」那一段 —— 那里也是它们的转出口，两处写会看着像两份来源。
// 平台词表（`sites` → 中文页名）的唯一来源。告警里说「哪个后台掉登录」时必须用它，
// 不许在这里另抄一份「生意参谋 / 阿里妈妈」—— 抄一份就是等着它与探测判据漂开。
// `isSycmLoginWallUrl`：判「这一轮的整轮阻断是不是登录墙造成的」只此一处实现
//（`login-merchant-core.mjs`，注释里点名 2026-09-25 的同一个现场）。在这里另写一份正则，
// 两边迟早漂开 —— 而漂开的症状是「同一种现场两个结论」，且两边看着都能自证。
import { SITES, isSycmLoginWallUrl } from './login-merchant-core.mjs';
import { describeIdentity, expectArgs, formatArgv, shopIdentity } from './shop-identities.mjs';
// 「遮挡层没关掉」这个机器标记的**唯一来源**（产出在 collect-core 的 describeOverlayAttempt）。
// 消费方（`shopFailureCause`）import 它、不写字面量：两边各写一份，改名那天就会静默漂移成
// 「这一类永远归到兜底」，而告警照发、看起来一切正常。
import { OVERLAY_NOT_DISMISSED_TOKEN } from './collect-core.mjs';
// 「这一天的源表里根本没有日期行」这个机器标记的**唯一来源**（产出在 inquiry-core 的
// `describeDateRowGap`）。消费方 import 它、不写字面量 —— 理由同上：两边各写一份，
// 改名那天会静默漂成「这一类又归回兜底」，而兜底那一档会叫人 + 驻留，代价是白挂几小时。
import { INQUIRY_ROW_MISSING_TOKEN, SOURCE_NO_ROW_FOR_DATE_TOKEN } from './inquiry-core.mjs';
// 「数据已核对、仅截图缺失」这个退出码的**唯一来源**（定义在 readback 那边）。
// 同样不写字面量 4：两边各写一份，哪天改了就会静默失配成「又变回真故障」。
import { SCREENSHOT_INCOMPLETE_EXIT_CODE } from './readback-daily-report.mjs';
// 失败现场的「感知层」（2026-09-28）。它只做一件事：某步失败时，把**页面当时长什么样**
// 落成可读事实（截图 + DOM 摘要 + 可见元素 + 视口）。放在这里 import 的用意与上面两条一致：
// 判据/产物的定义只有一处，消费方 import 它，不另抄一份形状。
import { captureFailureState } from './failure-perception.mjs';
// 「已知问题 → 处置」的记忆表（2026-09-28）。分诊用它决定「这次失败要不要打扰人」。
// **它的键被互锁钉在 `FAILURE_CAUSES` 上**（见 remediation-table.test.mjs 第 1 条），
// 所以这里 import 它不会引入第二套分类。
import { triageFailures, lookupRemediation } from './remediation-table.mjs';
// ⑨b（2026-09-29）：告警闸门要问「这一家该不该先交给 agent」，判据必须与派单**同源**，
// 不许在这里另写一份「哪些成因算 agent 的活」—— 两份判据漂开的那天，
// 会出现「派单说交给 agent、告警说快叫人」这种自相矛盾，而两边都各自看起来正常。
import { classifyShopEscalation } from '../../../runtime/escalation-plan.mjs';
import {
  isWaitingOperatorAccountShop,
  isWaitingOperatorAccountStatus,
  waitingOperatorAccountRecord,
} from '../../../runtime/daily-report-shop-gates.mjs';
import { writeDownloadManifest } from '../../../runtime/daily-report-download-manifest.mjs';
// 统一 summary schema（三链对齐 P1 迁移第 2 步，2026-10-11）：并写统一字段（version/workflow/
// shop/evidence/failureClass/noActionRequired/autoRepair.attempted）＋ 落盘前写入时校验。
// 方向是干净的 skills → runtime 叶子：校验器零 import、纯函数、不含任何业务判据
// （分诊表/修复表都在 skills 侧，见 runtime/unified-summary-schema.mjs 文件头纪律）。
// 旧字段一个不动（repairRequest.noActionRequired 等原样保留）——绞杀者迁移的并写期，
// 消费方继续读旧路径，观察期满两轮后再切（草案第四节）。
import { UNIFIED_SUMMARY_VERSION, validateSummary } from '../../../runtime/unified-summary-schema.mjs';
// 全仓统一提醒词表（2026-10-13）。三张 daily 词表 + 两个闭集**住在那里**，本文件转出：
// 判据只能有一个落点，而 skills 下的模块不许被 runtime 反向依赖 ⇒ 数据住 runtime。
// `remediation-table.test.mjs` / `repair-actions.test.mjs` / `scripts/hold-and-resume.mjs`
// 从本文件 import `FAILURE_CAUSES` / `HUMAN_REQUIRED_CAUSES` 的写法一行不用改。
import {
  DAILY_ACTION_BY_CAUSE,
  DAILY_FAILURE_CAUSES,
  DAILY_HUMAN_REQUIRED_CAUSES,
  DAILY_REASON_BY_CAUSE,
  DAILY_RESUME_SENTENCE,
  buildTechBlock,
} from '../../../runtime/alert-copy.mjs';
// 版本号（技术定位块的「版本」那一行）。读不到时 `currentVersion()` 自己给一句
// 「读不到版本号文件」的说明，不猜、不编一个号出来。
import { currentVersion } from '../../../runtime/version.mjs';
// 「失败 → 该试哪些修复动作」的候选菜单（2026-09-29）。它把感知层的事实与分诊表的方向
// 合成一份**给 agent 看的修复请求单**（97-repair-request.json）：
//   分诊表说「这一类值得重试」，但没说「重试之前要对页面做什么」；本模块补上那一半。
// **它只给候选、不做决定** —— 决定权（挑哪个动作、要不要换下一个）留给 agent。
// 这也是本模块零 import 的原因：它不依赖链里的任何东西，所以不引入第二套分类。
import { planRepair, STAGE_PAGE_HINT } from './repair-actions.mjs';
// 「哪个阶段跑在哪台浏览器上」的唯一口径（2026-10-14 加）。链外还有三处要用同一个答案，
// 所以它必须是一个能被 import 的叶子，而不是只活在本文件 stage 表里的两个局部变量。
import { proxyForStage, stageUsesSharedPage } from './stage-browsers.mjs';

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

// 2026-10-06 搬进 `date-picker.mjs`（叶子），这里 import 之后**原样转出** —— 对外名字逐字不变。
// 搬的理由见 `date-picker.mjs` 那一段：`runtime/escalation-plan.mjs`（派单计划）也要把定时任务里
// 那句 `--date yesterday` 解析成同一天，而它**不能** import 本文件 —— 本文件已经 import 了它
// （`classifyShopEscalation`），反向再 import 就成环。（口径与做法完全照 `expected-pages.mjs` 那次。）
// **既 import 又 export**（不是 `export … from`）：本文件内部还在用 `resolveTargetDate`，
// 而 `export … from` 只转不落地、不产生本地绑定 —— 只转的话那一处调用会直接 ReferenceError。
import { BLOCKED_BY_OVERLAY_TOKEN, resolveTargetDate, TARGET_DATE_LITERALS } from './date-picker.mjs';

export { resolveTargetDate, TARGET_DATE_LITERALS };


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

// 结论闭集与「需要人」子集：**唯一定义在 `runtime/alert-copy.mjs`**（2026-10-13 全仓统一词表）。
// 这里保留同名导出，只为不改既有调用方的 import（链内部用的是 alert-copy 那一份）。
export const FAILURE_CAUSES = DAILY_FAILURE_CAUSES;
export const HUMAN_REQUIRED_CAUSES = DAILY_HUMAN_REQUIRED_CAUSES;

// 三张词表同样住在 alert-copy 的 daily 分支（一字未改地搬过去）。本地别名保持链内可读。
const REASON_BY_CAUSE = DAILY_REASON_BY_CAUSE;
const RESUME_SENTENCE = DAILY_RESUME_SENTENCE;
const ACTION_BY_CAUSE = DAILY_ACTION_BY_CAUSE;

/**
 * `--only` 的点名判据：**只此一处实现**。
 *
 * 为什么必须抽成函数（2026-10-07 缺陷 ㉘）：`--only` 原先只在 `run()` 内部生效，
 * 而 `push` 的源产物守卫（`withSourcePaths`）写在**调用 `run()` 之前的外层循环里** ——
 * 于是「只想补回填」时（`--only health-check,sycm-date-again,backfill`），push 明明会被跳过，
 * 守卫却照样先跑一遍，因为 `record.source` 里没有本轮的产物而抛
 * 「没有拿到 shopXlsxPath / promotionZipPath」⇒ **整家店在 push 之前就死了**，
 * 而且日志里连「7. push」那一行都不打印（让人以为卡在别处）。
 *
 * 抽成同一个函数的理由与其余判据一致：两处各写一遍 `only.includes(...)` 就是两个事实，
 * 改动一处就漂移 —— 而这次的漂移形态是「被跳过的阶段仍然被执行前置校验」。
 */
export function stageSelected(only, name) {
  return !only || only.includes(name);
}

/**
 * 一家店的失败是哪一类。
 *
 * **成因不同、要做的事不同，就必须分开**：收信人照着一条对不上现场的建议去做，
 * 比不通知更糟（2026-09-19 那条「点保存密码」的登录告警就是这么被判错的）。
 *
 * `DUPLICATE_TARGET` 单独一类，因为它的下一步与别的**相反** —— 不用做任何事
 * （那一天的数据已经在飞书里了）。把它并进「失败」就是每天喊一次狼来了。
 */
export function shopFailureCause(record) {
  // ⚠️ 2026-10-05 修一个真缺陷：`record = {}` 这个默认值**只对 `undefined` 生效**，
  // 传进来 `null` 时照样穿透 ⇒ 下面读 `record.failureOutput` 直接抛
  // `Cannot read properties of null`。这不是测试造样本的问题：
  // 汇总里任何一条**缺记录**的店（`Object.entries` 拿到的 value 是 null）
  // 都会让 `roundFailureSummary` 整段崩掉，一轮汇总全丢。
  // 判据本身只读 `failureOutput` 与 `failedStage` 两个键，给个空对象等价。
  const r = record ?? {};
  // 「这一项订购不在账号上」**优先于所有别的结论**：它决定的是「收信人要不要去平台」，
  // 而别的结论在这个原因下照着做都没用。
  // 2026-09-21 科塔现场正是被报成「这家店的窗口里页面不齐，去打开窗口把页面补上」——
  // 照着做的人白跑一趟浏览器，问题不会好。判据是**确定性名字**（`date-picker.mjs` 只在这一种
  // 情况下抛它，且抛出前一定先问过平台，问不到就不给这个名字）。
  if (/SHOP_FUNC_NO_PERMISSION/u.test(String(r.failureOutput ?? ''))) return 'SHOP_FUNC_NO_PERMISSION';
  // 2026-09-26 加：平台自己的全屏弹窗压住整页、而且试过多种关法都没关掉。
  // 判据是**确定性标记**（`collect-core` 只在「检出了全屏遮挡层，且 ESC／有序候选都试过仍没关掉」
  // 这一种情况下写它），不是靠在这里猜措辞。标记本身从 collect-core import，不抄字面量。
  // 为什么必须单列：兜底那句的下一步是「这一轮不需要你在浏览器里做什么」，而这一类的下一步
  // 恰恰**相反** —— 要人去把那一层关掉（2026-09-26 早上科塔就是这么被报错的）。
  if (String(r.failureOutput ?? '').includes(OVERLAY_NOT_DISMISSED_TOKEN)) return 'PAGE_OBSTRUCTED';
  // ── 2026-10-10 加第二条判据：**要点的东西被一个盖住视口的层挡住了** ──────────────
  // 为什么必须有第二条（2026-10-09 盖文淘宝现场）：“优惠竞争力下降提醒”那个 antd 弹窗
  // 盖住了「询单到付款」页签，`date-picker` 的 `aim()` 抛的是
  // `point (492,277) is covered by SPAN.goods-subIndex-text` —— 一句看不出成因的话。
  // 上面那条 `OVERLAY_NOT_DISMISSED` 只在**采集段走完"扫-选-点-回读"整套流程**时才写，
  // 而 `date-picker` 那一步压根不走那套流程 ⇒ 失败落进兜底 `STAGE_FAILED` ⇒
  // 候选成了 `REAPPLY_DATES`（设计上恒 `applied:false`，是个报告者）与 `RELOAD_PAGE`，
  // **唯一对症的 `DISMISS_OVERLAYS` 根本没进菜单**（它在 `REPAIR_TABLE[PAGE_OBSTRUCTED]` 里）。
  // 于是 `--auto-repair` 两轮全空、派 agent 也只能从同样的候选里挑 ⇒ 自动化对这类失败无解。
  //
  // 判据是**抛出侧写下的确定性标记**（`date-picker.BLOCKED_BY_OVERLAY_TOKEN`）：
  // `aim()` 在抛错那一刻手里就有 `hit`，当场就能回答「挡住它的东西是不是一个盖住视口的层」。
  // 刻意**不**在上层猜措辞、也不靠"感知层里有个像弹窗的层"这种间接推断 ——
  // 前者措辞一改就静默失效，后者会把「页面上有个静态 dialog 容器」也算进来。
  // 标记从 date-picker import，不抄字面量。
  if (String(r.failureOutput ?? '').includes(BLOCKED_BY_OVERLAY_TOKEN)) return 'PAGE_OBSTRUCTED';
  // 2026-10-06 加：源表里**这一天的日期行一个都没有**（空态），不是「读不到」、更不是「数据是 0」。
  // 判据是**确定性标记**（`inquiry-core` 的 `describeDateRowGap` 只在「0 个日期行」这一种情况下写它），
  // 不是靠在这里猜措辞。
  //
  // 为什么必须单列（2026-10-05 `网林家居` 现场）：并进 `STAGE_FAILED` 的代价是三重的 ——
  //   ① 告警照兜底那句说「这一轮不需要你在浏览器里做什么…把这条消息转给技术同学」，而技术同学
  //      到了现场也做不了任何事（平台那一天就是没有这一行）；
  //   ② 自进化菜单按 `STAGE_FAILED` 派 `REAPPLY_DATES`，而那个动作**是报告者不是执行者** ⇒ 白跑一轮；
  //   ③ 分诊按 `STAGE_FAILED` 落「要人处理」+ 驻留判据按「空菜单」落「脚本自修不动」⇒
  //      为一件不需要人做的事把窗口白挂几小时。
  if (String(r.failureOutput ?? '').includes(SOURCE_NO_ROW_FOR_DATE_TOKEN)) return 'SOURCE_NO_ROW_FOR_DATE';
  // 2026-10-07 加：**飞书侧**这一天的行还没建出来（与上面那一条是相反的一件事）。
  //
  // 判据同样是确定性标记（`inquiry-core` 的 `describeFeishuRowGap` 只在「候选行数＝0」时写它）。
  // 为什么必须单列（2026-10-06 现场：8 家店前 9 步全部成功、第 10 步全部 `got 0`）：
  //   ① 落回 `STAGE_FAILED` 的告警会说「这一轮不需要你在浏览器里做什么…把这条消息转给技术同学」，
  //      而真因与浏览器无关（那张表少了一行，而且**这一步本可以自动补**）；
  //   ② 自进化菜单按 `STAGE_FAILED` 会派 `REAPPLY_DATES`/`RELOAD_PAGE` 去动页面 —— 全是白跑
  //      （2026-10-06 那次真跑的证据：8 家各烧掉一轮 `--auto-repair`，8 份请求单全给的是页面动作）；
  //   ③ 分诊会把它落回「要人处理」，而它其实是**已经修好的那一步**（`ensure-inquiry-rows`）没跑成功。
  // 刻意**不**把它放进 `HUMAN_REQUIRED_CAUSES`：窗口留住没有用 —— 没有哪一页需要人碰。
  if (String(r.failureOutput ?? '').includes(INQUIRY_ROW_MISSING_TOKEN)) return 'INQUIRY_ROW_MISSING';
  // 2026-10-07 加（缺陷 ③ 的**逐店**那一半）：第 0 步体检被挡时，先分清是「**掉登录**」
  // 还是「页面真的缺」。这两件事的下一步相反 —— 掉登录要去登录（重开页面只会再落回登录页），
  // 缺页才要去补页。而在此之前两者都落 `SHOP_BLOCKED`，收信人拿到的下一步是去补页。
  //
  // 现场（补科塔淘宝 10-06）：店铺那台实例掉登录后，生意参谋页被踢到 `custom/login.htm?_target=…`，
  // 结构判据不算它命中 ⇒ 报 `TARGET_PAGE_MISSING`「目标页面不在这个浏览器里」。
  // 判据用体检 finding 的**编号**（`blockingCodes`），不用措辞 —— 本项目在 `.includes('…')` 上吃过亏。
  if (r.failedStage === 'health-check') {
    const codes = (Array.isArray(r.stages) ? r.stages : [])
      .filter((item) => item?.stage === 'health-check')
      .flatMap((item) => (Array.isArray(item.blockingCodes) ? item.blockingCodes : []));
    if (codes.includes(HEALTH_CODES.TARGET_PAGE_LOGIN_WALL)) return 'NEEDS_LOGIN';
    return 'SHOP_BLOCKED';
  }
  if (r.failedStage === 'push'
    && /duplicate daily report row exists/u.test(String(r.failureOutput ?? ''))) return 'DUPLICATE_TARGET';
  // 2026-10-10 加（缺陷 ㉝ 的「逐店 · 链中间」那一半）：**失败那一刻页面停在登录墙上** ⇒
  // 这一家的问题是**登录**，不是页面、不是数据、更不是「不明原因」。
  //
  // 现场（2026-10-08 网林天猫，停在第 2 步 `alimama-date`）：阿里妈妈被踢到 `…#!/login/index`，
  // 而阶段自己的 stdout/stderr 里**一个字都没有那个 URL**（它只报 `state did not settle to <日期>`）
  // ⇒ 只读 `failureOutput` 判不出来。URL 只活在感知层的产物里
  //（`98-failure-state.txt` 的「URL：」那一行，来源＝`FAILURE_STATE_EXPRESSION` 的 `location.href`）。
  // 所以判据取自 `record.perception.state.url` —— 那是**同一次失败**留下的现场，不是另一次。
  //
  // 为什么必须单列（而不是留在兜底 `STAGE_FAILED`）：两者要做的事**相反** ——
  // 兜底那一档给的是页面动作／转技术同学，而这一档要给的是「去登录那个后台」；
  // 而且 `STAGE_FAILED` 会让自进化菜单派 `REAPPLY_DATES`/`RELOAD_PAGE` 去动页面，全是白跑
  //（2026-10-08 那次 agent 实测：两个候选都试过、两次重试均 exit 1）。与 ⑳ 的方向也相反：
  // ⑳ 是「宽正则把登录跳转页当掉登录」的假红，本条是「真掉登录被判成页面问题」的假绿归因。
  if (loginWallOf({ url: r.perception?.state?.url })) return 'NEEDS_LOGIN';
  return 'STAGE_FAILED';
}

/**
 * 「动手之前先把实例确认到」——写进修复请求单的那几行（2026-10-09 加）。
 *
 * 为什么必须有它：`--batches` 形态**每一批跑完就释放**（`runtime/batch-plan.mjs` 的
 * `releaseAfterBatch`：链成功、链失败、链压根没跑到，一律释放；而 `stop` 用的是与 `start`
 * **同一份 `--only` 名单** ⇒ 失败的那一家也在释放名单里）。第②层（修复 agent）的作业指导书
 * 却假定「脚本侧驻留不退出、窗口留着、现场就在」—— 那个前提**只在非分批形态成立**
 * （`run-daily-job.mjs` 不带 `--batches` 时确实没有 stop 步）。
 *
 * 实测代价（只读统计 `evidence/` 下各轮的 `97-repair-agent-report.md`，09-28~10-07 共 27 份）：
 * **20 份**的结论是「现场已不在 ⇒ 未执行任何修复动作 ⇒ 转人」，也就是**动作还没试就判了转人**。
 * 而 10-07 网林家居之所以能救回来，是因为那个 agent **自己即兴补了一句**
 * `start-all-hold.mjs --only …` —— 这一步原先不在指导书里，换个人/换个更严格的读法就会停手。
 *
 * 为什么写成「先确认」而**不**断言「已经被释放」：
 * 这张单子是**链跑到一半**写的，那一刻实例还活着；真正被释放是在这一批结束之后。
 * 而且给了 `--no-release` 时实例**不会**被放掉 —— 写「已被释放」在那种情况下就是假话，
 * 而本仓最贵的一类错误正是「说了一句不对的话」。所以给的是**可回读的判据**（代理在不在听）。
 *
 * 「先确认」不是礼貌，是防串店：`--proxy` 是唯一的实例选择器（见 `repair-shop-stage.mjs`
 * 头部的纪律），代理连不上时它会回落到**商家浏览器默认端口** —— 那是对着**另一台**做事。
 */
export function buildInstancePrecondition({ shopKey, stage = null } = {}) {
  // 2026-10-14：**按阶段选实例**（规则唯一实现在 `stage-browsers.mjs`）。
  // 原先这里恒取 `shopInstance(shopKey).proxyPort`，于是 `readback` 失败时单子叫 agent 去
  // 确认**店铺实例**在不在 —— 而失败那一步跑在共用商家浏览器上，与那一台无关。
  // 「先确认再动手」这条纪律本身没变，变的是「确认哪一台」。
  const proxy = proxyForStage({ stage, shopKey });
  const shared = stageUsesSharedPage(stage);
  return {
    why: shared
      ? `阶段「${stage}」跑在**共用商家浏览器**上（五家店共用那一页飞书底单），不是这家店自己的实例。`
        + '这一批跑完可能已经把实例放掉了（--batches 每批都释放），而代理连不上时任何页面修复动作都执行不到 —— '
        + '不先确认就可能对着别的一台做事。'
      : `这一批跑完可能已经把这家店的浏览器放掉了（--batches 每批都释放，失败的那家也在名单里）。`
        + '代理连不上时任何页面修复动作都执行不到，而 --proxy 是唯一的实例选择器 —— '
        + '不先确认就可能对着别的一台做事。',
    checkCommand: `curl -s -m 5 ${proxy}/targets`,
    // start-all 是**幂等**的：实例已在位时它不碰它 ⇒ 这条命令在「还在」的情况下也安全。
    // 用 hold 形态是因为普通 start-all 起完就退、宿主会回收整棵进程树，窗口留不到 agent 干完。
    // ⚠️ 共用阶段**不点店铺名**：`--only <店>` 起的是那家店自己的实例，起不到共用浏览器上
    //    （共用实例由整轮的第 0 步 / `start-all.mjs --only dailyReport` 负责）。
    //    写一条起不到目标的命令比不写更坏：agent 照着跑完会以为「实例已就位」。
    startCommand: shared
      ? 'node scripts/start-all-hold.mjs --only dailyReport'
      : `node scripts/start-all-hold.mjs --only ${shopKey}`,
    note: '先跑 checkCommand：有输出（一个 JSON 数组）就是还在，直接执行 execHint；'
      + '连不上就先跑 startCommand 把它拉起来（后台托住），确认再执行 execHint。',
  };
}

/**
 * 一次失败 → 一份**修复请求单**（2026-09-29 加）。纯函数 + 一处落盘，永不抛。
 *
 * 它是「自进化回环」的中间产物：链接三方 ——
 *   感知层（`perception.state`：失败那一刻页面长什么样）
 *   → 修复表（`planRepair`：值得一试的候选动作 + 为什么）
 *   → agent（读这张单子，挑一个动作交给 `repair-shop-stage.mjs` 执行，然后重试该阶段）。
 *
 * 产物 `97-repair-request.json` 里刻意把**三方各自要的东西**都写全：
 *   · `cause` / `stage` / `error`：给分类与重试定位；
 *   · `candidates`：agent 的菜单（含 `mutating` 与 `why`）；
 *   · `statePath` / `stateUrl` / `stateTitle`：指向完整现场事实（单子里只放摘要，不重复 3KB 文本）；
 *   · `retryStage`：**修完要重试哪一步**。取「失败的那一步」，认不出来就不给（不许猜）。
 *   · `execHint`：给人/agent 一条可直接照抄的命令（不自作主张执行）。
 *
 * **本函数不做任何动作、不改退出码、不进告警**：它只在证据目录里多写一个文件。
 * 默认不自动执行任何修复 —— 执行由 `--auto-repair`（或外部 agent）显式触发。
 *
 * @param {{shopKey:string, stage:string|null, error:string, failureOutput?:string|null,
 *          perception:object|null, logDir:string, writeFile?:Function}} o
 * @returns {object} 请求单（同时已落盘；落盘失败只记 `writeError`，不抛）
 */
export function buildRepairRequest({ shopKey, stage = null, error = null, failureOutput = null,
  perception = null, logDir, writeFile = writeFileSync } = {}) {
  // 成因由**同一个分类器**给（`shopFailureCause`）—— 不在这里重判一遍。
  // 重判就是两套分类，而修复请求单最怕的就是「单子上的成因与告警里的成因不是同一个」。
  //
  // ⚠️ 2026-10-10 修一个真缺陷（㊲ 的**接线**那一半，补跑当场实测）：
  //   归类必须用**失败现场那段完整文本**（`record.failureOutput`，含子进程 stderr），
  //   **不是** `error.message`。理由：`error.message` 只有驱动自己包的那一句
  //   `阶段 sycm-date 失败（exit 1）`（`run-multi-shop-day.mjs` 抛错处），
  //   而 `date-picker` 写下的 `[BLOCKED_BY_OVERLAY …]` 标记**只出现在子进程 stderr 里**
  //   （被 `record.failureOutput` 收走、也被写进 `04-<stage>.txt`）。
  //   用 `error.message` 归类 ⇒ 分类器根本看不到标记 ⇒ 落 `STAGE_FAILED` ⇒
  //   候选里没有 `DISMISS_OVERLAYS`（㊲ 白修）。现场证据：2026-10-10 17:47 那次补跑，
  //   `97-repair-request.json` 写的是 `cause: STAGE_FAILED`，
  //   而同目录 `04-sycm-date.txt` 的 stderr 里明明有 `[BLOCKED_BY_OVERLAY 遮挡层=DIV.ant-…]`。
  //   `failureOutput` 缺省回落到 `error`，让只传 `error` 的调用方（与既有用例）行为不变。
  const causeText = String((failureOutput ?? error) ?? '');
  const cause = shopFailureCause({ failedStage: stage, failureOutput: causeText });
  const plan = planRepair({ cause, stage, state: perception?.state ?? null });
  const request = {
    at: new Date().toISOString(),
    shopKey, stage, cause, error: error === null ? null : String(error),
    // 现场事实落盘的地方（`failure-perception` 写的 98-failure-state.json）——
    // agent 要判断「怎么修」时必须读的是那一份完整事实，不是这里的摘要。
    statePath: perception?.files?.stateJson
      ? path.relative(REPO_ROOT, perception.files.stateJson) : null,
    stateTextPath: perception?.files?.stateText
      ? path.relative(REPO_ROOT, perception.files.stateText) : null,
    screenshotPath: perception?.files?.screenshot
      ? path.relative(REPO_ROOT, perception.files.screenshot) : null,
    // 摘要（不在单子里重复完整现场，避免两份事实漂开）：
    stateSummary: perception?.state
      ? { url: perception.state.url ?? null, title: perception.state.title ?? null,
        viewport: perception.state.viewport ?? null,
        // 2026-10-10：`overlayCount` 只说明「页面上有几个像弹窗的东西」，推不出「它正挡着事」。
        // 那个「正不正挡着」的结论**不在这里另算**：它是 `shopFailureCause` 那一条
        // `BLOCKED_BY_OVERLAY` 判据的活儿，来源是 `date-picker.aim()` 抛错那一刻的证据，
        // 也跟着 `cause` 一起进了这张单子 —— 在这里再数一遍层只会多出第二套判据。
        overlayCount: (perception.state.dialogs ?? []).length }
      : null,
    candidates: plan.candidates,
    planNote: plan.note,
    stageHint: plan.stageHint,
    // 2026-10-06 加：**这一条失败需不需要任何人做任何事**。
    //
    // 判据**不在这里另立一套**，而是直接问分诊表：`notifyLevel === 'silent'` 的语义本就是
    // 「不用做任何事」（现在只有 `DUPLICATE_TARGET` 与新加的 `SOURCE_NO_ROW_FOR_DATE` 两档）。
    // ⇒ 「不叫人」与「不驻留」是**同一个判断**，只有一处来源，不会漂。
    //
    // 为什么要落进这张单子：这是运行期唯一的跨目录通道。`unfixableShopsOf`
    // （`runtime/hold-and-resume-plan.mjs`）跑在 runtime 侧，它**不能** import skills 的分诊表，
    // 只能读 summary 里的字段；而它原先的判据是「`gaveUp` 非空 **或** 候选为空」⇒
    // 一条「谁都不用动」的成因会被算成「脚本自修不动」⇒ 驻留 4 小时等一个不存在的人。
    noActionRequired: lookupRemediation(cause).notifyLevel === 'silent',
    // 修完要重试哪一步：失败的那一步。认不出来（stage 为空）就如实置 null，不猜。
    retryStage: stage ?? null,
    // 一条可直接照抄的命令（**不自动执行**）。agent 挑好 candidate 后把它填进 --action。
    //
    // 2026-10-14：`--proxy` **按阶段选**（`stage-browsers.mjs` 是唯一口径）。
    // 原先这里恒取「这家店自己的代理」，于是 `readback` 失败时这条命令指着的浏览器
    // **不是**出问题的那一台 —— 而 `repair-shop-stage.mjs` 的一致性闸门又要求
    // 「--shop 与 --proxy 对得上」，于是 agent 连「改成共用那台」都做不到（会当场被拦）。
    // 两者一起把修复钉死在**动不到目标页**的地方（10-13 网林淘宝实证）。
    execHint: `node skills/sycm-alimama-daily-report/scripts/repair-shop-stage.mjs`
      + ` --shop ${shopKey} --proxy ${proxyForStage({ stage, shopKey })}`
      + ` --stage ${stage ?? '<stage>'} --cause ${cause} --action <候选动作>`
      // logDir 认不出来就**不给 --log-dir**（写 `<stage>` 比写一个像路径的垃圾更诚实，
      // 也避免调用方把提示当命令直接粘贴执行）。
      + (logDir ? ` --log-dir ${path.relative(REPO_ROOT, logDir)}` : ''),
    // 2026-10-09 加：**执行任何修复动作之前，先把实例确认到**（判据与理由见上面那个函数）。
    // 落在单子里而不是只写在作业指导书里 —— 这张单子是 agent 到场后第一件读的东西，
    // 20/27 份修复报告「现场已不在 ⇒ 转人」说明只靠文档不够。
    // 2026-10-14：它也跟着阶段走（共用阶段要确认的是共用那台，不是店铺实例）。
    instancePrecondition: buildInstancePrecondition({ shopKey, stage }),
  };
  if (typeof writeFile === 'function' && logDir) {
    try {
      const outPath = path.join(logDir, '97-repair-request.json');
      writeFile(outPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
      request.path = path.relative(REPO_ROOT, outPath);
    } catch (err) {
      // 落盘失败不该改变失败语义（主线已经失败了）—— 如实记，不抛。
      request.writeError = String(err?.message ?? err);
    }
  }
  return request;
}

/**
 * 统一 summary 字段并写（三链对齐 P1 迁移第 2 步，2026-10-11，拍板七项全按推荐）。
 *
 * 治的病：九个下游消费方（unfixableShopsOf / failedShopsOf / classifyShopEscalation …）全部
 * 长在日报链的私有字段路径上，2026-10-11 07:00 推广轮 8 家全败却「照常释放」的直接成因
 * 就是它不落 summary.json ⇒ 释放判定恒读「无失败」（草案 1.1）。本函数把统一 schema 的
 * 字段**并写**进既有 summary：**旧字段一个不动**（repairRequest.noActionRequired /
 * repairRequest.cause / failedStage / failureOutput 等原样保留），消费方观察期内继续读旧路径。
 *
 * 新增字段（草案 3.2/3.3，口径见 runtime/unified-summary-schema.mjs）：
 *   · 顶层：version（'unified-summary-v1'，拍板 6.4-A 三链同串）、workflow（'daily-report'）；
 *   · 逐店（pending 除外——初值 {status:'pending',…} 一个不动，校验器已豁免）：
 *     shop＝map 键（不变量 1）、evidence＝该店证据目录（相对仓库根，与落盘日志里
 *     `<--logs 根>/<店名>` 同一款拼法，status 为 ok/failed/waiting 都补——agent 到场
 *     第一件事靠它指路，成功店与 waiting 店现状没有任何字段指路）；
 *   · 失败店：failureClass＝`shopFailureCause` 对该记录**写时算**的结果（推导函数一行不动，
 *     只把执行时机从消费方读时挪到写时——「同一失败两个读者两种归因」的漂移面被删掉，
 *     草案 6.1-A）、noActionRequired＝与 repairRequest.noActionRequired 同源同值
 *     （值的唯一构造点仍是 buildRepairRequest 里那张分诊表，这里只落位到记录顶层，
 *     拍板 6.3-A；双写期间两处必须相等——「不算两份事实」的前提，守卫测试钉住）；
 *   · autoRepair 存在时：attempted 布尔（发起过至少一次修复尝试＝rounds 非空或
 *     gaveUp 非空或 rescued——区分「修过没救回来」与「压根没修」）。
 *
 * waiting 店的 evidence 在**这里**（汇总处）补而不是改 gates 构造器：构造器
 * `waitingOperatorAccountRecord` 不知道 logs 根（它在 runtime、拿不到本轮 --logs），
 * 改它就得把路径参数穿进 runtime——破坏面大且方向反了；这里手里就有 logRoot，一行完事。
 *
 * 纯函数（只改传入对象，不碰盘、不抛）；导出供离线用例喂样本。
 */
export function applyUnifiedSummaryFields(summary, { logRoot, repoRoot = REPO_ROOT } = {}) {
  summary.version = UNIFIED_SUMMARY_VERSION;
  summary.workflow = 'daily-report';
  for (const [key, record] of Object.entries(summary.shops ?? {})) {
    // pending 是「还没跑完」的初值，不是结论——mid-run 落盘形态一个不动（校验器已豁免）。
    if (!record || record.status === 'pending') continue;
    record.shop = key;
    record.evidence = path.relative(repoRoot, path.join(logRoot, key));
    if (record.status === 'failed') {
      // 物化：分类器仍是同一个 shopFailureCause，只是从「读时现算」变「写时落定」。
      record.failureClass = shopFailureCause(record);
      // 同源同值：值仍来自 buildRepairRequest 的分诊表（notifyLevel==='silent'），
      // 这里把它从 repairRequest 提升到记录顶层（拍板 6.3-A）。repairRequest.noActionRequired
      // 是布尔（buildRepairRequest:468 恒写），`=== true` 保形不保值变换。
      record.noActionRequired = record.repairRequest?.noActionRequired === true;
    }
    if (record.autoRepair != null) {
      const auto = record.autoRepair;
      auto.attempted = (Array.isArray(auto.rounds) && auto.rounds.length > 0)
        || (typeof auto.gaveUp === 'string' && auto.gaveUp.length > 0)
        || auto.rescued === true;
    }
  }
  return summary;
}

/**
 * 写入时校验（拍板 6.7-A，随第 2 步一起上）：落盘前调 validateSummary，
 * 不过 ⇒ **照样落盘**（证据优先——格式问题不许升级成丢整轮结论，草案 5.2）
 * ＋ stderr 醒目警告（含 errors 的 path/rule 摘要）。守卫测试随后会咬住同一批错。
 */
function warnSummarySchemaViolations(summary, where) {
  const { ok, errors } = validateSummary(summary);
  if (ok) return;
  console.error(`[驱动] ⚠️ summary 未过统一 schema 校验（${where}）—— 证据优先，照样落盘：`);
  for (const { path: at, rule, message } of errors) {
    console.error(`[驱动]   ⚠️ ${at || '(顶层)'}［${rule}］${message}`);
  }
}

/**
 * 给体检层用的**登录墙**判据（缺陷 ③ 的逐店那一半，2026-10-07 加）。
 *
 * 现场：店铺自己那台实例掉登录后，生意参谋页被平台踢到
 * `sycm.taobao.com/custom/login.htm?_target=…`。而「页签属于哪个期望页面」是**结构判据**
 * （`pagesMatching`，见 `runtime/target-url-match.mjs` 文件头）——它刻意**不**把 `_target=`
 * 里的地址算作命中，否则登录跳转页会被当成工作页 ⇒ 判成「不唯一」。这个设计是对的，
 * 副作用是：掉登录在体检里长成了「目标页找到 0 个」⇒ 报 `TARGET_PAGE_MISSING`
 * 「目标页面不在这个浏览器里…采集会从落位那一步就失败」，把排查引向页面。
 * 2026-10-07 补科塔淘宝 10-06 时就是这么被指错方向的（重开页面会被再送回登录页）。
 *
 * 判据**不在这里另写**：用 `login-merchant-core.mjs` 的 `SITES[].loggedOut` ——
 * 那是 2026-09-23 实测出来的未登录 URL 形态（生意参谋 `/custom/login.htm`，
 * 阿里妈妈 `#!/login/index`），是这条链上「掉登录」的唯一定义处。
 *
 * 「宿主是谁」由片段里的 `pageMatch` 决定，也不另立一张表：`SITES` 里每个站点自己带着它。
 *
 * 返回的函数收到 `{ fragment, targets }`，命中返回 `{ url, site }`，否则 `null`。
 * 读了但没命中 = 不是登录墙（落回 `TARGET_PAGE_MISSING`），不是「不知道」。
 */
export function makeLoginWallFinder() {
  return ({ fragment, targets } = {}) => {
    const text = String(fragment ?? '');
    const entry = Object.entries(SITES).find(([, cfg]) => text.includes(cfg.pageMatch));
    if (!entry) return null;
    const [siteKey] = entry;
    // 判据本体只有一处（`loginWallOf`）；这里只负责「先按片段锁定是哪一家店/哪个站点」。
    const found = loginWallOf({ targets, siteKeys: [siteKey] });
    return found ? { url: found.url, site: found.site } : null;
  };
}

/**
 * 「给定的 URL 里有没有哪一个正停在登录墙上」。**纯函数**（2026-10-10 加）。
 *
 * 为什么需要它、与 `makeLoginWallFinder` 的分工：
 *   · 那个函数回答的是**体检层**的问题 ——「我按这个片段查到的那一个站点，它的页签是不是
 *     被踢回登录页了」。它要求调用方**先说清是哪个站点**（`fragment`），所以只有体检那一次
 *     调用用得上。
 *   · 而失败归因面对的是 `alimama-date` 这类**链中间**的失败：那一刻根本不知道是哪个站点
 *     掉的，只知道「页面停在一个登录墙上」。所以这里换成「对所有登记站点一起判」。
 *   两者共用同一份判据（站点表的 `pageMatch` + `loggedOut`，唯一来源＝`login-merchant-core` 的
 *   `SITES`），调用点**不另写正则** —— 两边各写一份，平台改版那天会漂成「同一种现场两个结论」，
 *   而两边看着都能自证（本仓吃过这个亏）。
 *
 * 读到了、没命中 ＝ **不是登录墙**（调用方落回它原来的口径），不是「不知道」。
 *
 * @param {{targets?: Array<{url?:string}>|null, url?: string|null, siteKeys?: string[]|null}} o
 * @returns {{site: string, url: string}|null}
 */
export function loginWallOf({ targets = null, url = null, siteKeys = null } = {}) {
  const wanted = Array.isArray(siteKeys) && siteKeys.length > 0 ? siteKeys : Object.keys(SITES);
  const candidates = [];
  if (url) candidates.push(String(url));
  for (const target of (Array.isArray(targets) ? targets : [])) {
    const value = String(target?.url ?? '');
    if (value) candidates.push(value);
  }
  for (const candidate of candidates) {
    for (const siteKey of wanted) {
      const cfg = SITES[siteKey];
      if (!cfg) continue;
      if (candidate.includes(cfg.pageMatch) && cfg.loggedOut.test(candidate)) {
        return { site: siteKey, url: candidate };
      }
    }
  }
  return null;
}

/**
 * 读「这一家店此刻有没有哪个站点停在登录墙上」。**永不抛**（读不到＝ null）。
 *
 * 只在**失败那一刻**调用：那时阶段自己留下的 stdout/stderr 里往往一个字都没有那个 URL
 *（2026-10-08 网林天猫的第 2 步只报 `alimama: state did not settle to <日期>`），
 * 而页签自己的 URL 就是最直接的事实来源（代理的 `/targets` 是只读 GET）。
 * 判据走 `loginWallOf`（唯一来源），这里只负责取数。
 */
export function readLoginWallViaProxy({ proxy, readTargets = null } = {}) {
  const read = readTargets ?? (() => proxyJson(`${proxy}/targets`));
  return Promise.resolve()
    .then(() => read())
    .then((targets) => loginWallOf({ targets }))
    .catch(() => null);
}

/**
 * 阶段名 → 该阶段用哪个登录站点（`sycm` / `alimama`），判不出来给 `null`。
 *
 * 唯一来源是 `repair-actions.mjs` 的 `STAGE_PAGE_HINT`（阶段 → 目标页标签），这里只做一次
 * 「标签 → 登录站点」的映射，**不另写一张阶段表**。`feishu` 那两个阶段（push/readback）与
 * 认不出的阶段一律返回 `null` ⇒ 不探针、不补登（它们的失败不是这两个后台的会话问题）。
 */
export function reloginSiteForStage(stage) {
  const hint = STAGE_PAGE_HINT[String(stage ?? '')] ?? null;
  return hint === 'sycm' || hint === 'alimama' ? hint : null;
}

/**
 * 「这一次失败该不该走补登」——纯函数，把闸门的三条分叉钉死（可被用例与突变验证盯住）。
 *
 * - `skip`：没开开关 / 本轮已补过 / 步骤其实成功了 / 判不出站点且没有登录墙 ⇒ 什么都不做；
 * - `relogin`：页签 URL 已经命中登录墙（老路径，判据＝`loginWallOf`）；
 * - `probe`：URL 判据认不出（页面内容是兜底页也行），但这一步属于某个登录站点
 *   ⇒ 先跑一次**只读探针**再决定（不凭页面文案直连补登，见补登闸门处的注释）。
 */
export function decideReloginAttempt({ status = null, reloginOnWall = false, reloginUsed = false, wall = null, siteHint = null } = {}) {
  if (!reloginOnWall || reloginUsed) return 'skip';
  if (status === 0) return 'skip';
  if (wall) return 'relogin';
  return siteHint ? 'probe' : 'skip';
}

/**
 * 只读探针的回执 → 补登要用的「登录墙」。**永不抛**。
 *
 * 只认 `verdict === 'NEEDS_LOGIN'`：`ALREADY_LOGGED_IN` / `PARTIAL` / `PAGES_ABSENT` /
 * `STOP_AND_ALERT` 都不是「这一份会话掉了」，尤其 `PAGES_ABSENT`（退出码 3）是「页面还没归位」——
 * 那种情况补登也是白登。站点必须**明确 loggedIn === false** 才算，读到 `null`（读不到）不算：
 * 本项目的头号错误就是把「读不到」当成「掉了」。
 */
export function reloginWallFromProbe({ receipt = null, site = null } = {}) {
  const verdict = receipt?.verdict ?? null;
  if (verdict !== 'NEEDS_LOGIN') return null;
  const sites = receipt?.sites && typeof receipt.sites === 'object' ? receipt.sites : {};
  const keys = site ? [site] : Object.keys(sites);
  for (const key of keys) {
    const entry = sites[key];
    if (entry && entry.loggedIn === false) {
      return { site: key, url: typeof entry.href === 'string' ? entry.href : null };
    }
  }
  return null;
}

/**
 * 跑一次**只读**登录探针（`login-merchant.mjs --check-only`），拿结构化回执。**永不抛**。
 *
 * ⚠️ 它名不副实：`--check-only` 会把该站点已有的页签 `navigate` 到 `probeUrl` 再读 `location.href`
 * （`login-merchant.mjs` 的 `siteLoggedIn`），所以**会动页面**——只是在失败路径上跑一次、
 * 且随后无论补不补登都会重新落位，代价可接受。这条事实原先在脚本注释里被写反，2026-10-18 已改正。
 */
export function probeSiteSession({ shopKey, site = null, run = null } = {}) {
  const proxyPort = shopInstance(shopKey).proxyPort;
  const scriptPath = path.join(REPO_ROOT, 'skills/sycm-alimama-daily-report/scripts/login-merchant.mjs');
  const argv = ['--check-only', '--proxy', `http://127.0.0.1:${proxyPort}`, '--shop', shopKey, '--notify', 'off'];
  if (site) argv.push('--target', site);
  const spawn = run ?? ((cmd, args, options) => spawnSync(cmd, args, options));
  const record = { attempted: true, ok: false, receipt: null, exitCode: null, error: null, command: `${NODE} ${formatArgv([scriptPath, ...argv])}` };
  let result = null;
  try {
    result = spawn(NODE, [scriptPath, ...argv], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      // stdin 只能是 `'ignore'`（沙箱下 `'pipe'` 必回 EBUSY，与 `reloginShop`／`runStage` 同一条）。
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
  } catch (error) {
    record.error = String(error?.message ?? error);
    return record;
  }
  record.exitCode = result?.status ?? null;
  if (result?.error) record.error = String(result.error.message ?? result.error);
  const stdout = String(result?.stdout ?? '');
  const start = stdout.indexOf('{');
  if (start >= 0) {
    try {
      record.receipt = JSON.parse(stdout.slice(start));
      record.ok = true;
    } catch (error) {
      record.error = `回执不是 JSON：${String(error?.message ?? error)}`;
    }
  } else {
    record.error = '探针没有输出回执';
  }
  return record;
}

/**
 * 「整轮被挡」的**真因**（2026-10-06 加）。纯函数，输入就是体检那一步留下的 `detail` 与 `normalize`。
 *
 * 为什么必须有它（2026-10-06 的真实事故）：整轮被挡时，告警的结论改判**只**照跑前那一次
 * 店铺登录体检（`--login-preflight`）来判 —— 而那一轮 8 家店后台全是好的，掉登录的是
 * **共用窗口**（商家号），它不在那份体检里 ⇒ 判据返回「问题不在登录上」，
 * 收信人拿到的下一步是「把这两页各开一个」，而真因是登录墙：开几个都会被送回登录页。
 * 一句对不上现场的下一步，比不通知更贵（本仓第三次吃同一个亏）。
 *
 * 判据用的是**链自己第 0 步留下的现场**：归位记录里 `reclaim` 动作的 `from` 就是
 * 「那个页签当时实际停在哪」——停在登录墙上就是登录墙。判定复用
 * `isSycmLoginWallUrl`（结构判据：host 相等 + path 相等），不在这里另写正则。
 *
 * 返回：`null`（体检通过）｜`'ROUND_LOGIN_WALL'`｜`'ROUND_BLOCKED'`。
 * **读不到 `from` 一律落回 `ROUND_BLOCKED`**：缺证据不下结论，宁可给旧口径也不编一个。
 */
export function roundCauseOf({ ok, normalize, findings = null } = {}) {
  if (ok !== false) return null;
  // ① 第一手证据（2026-10-07 加）：体检层自己已经把这一次判成了登录墙。
  //    它比下面那条更直接 —— 那条要等归位真的动过一次手才留得下 `from`。
  const byFinding = (Array.isArray(findings) ? findings : [])
    .some((finding) => finding?.code === HEALTH_CODES.TARGET_PAGE_LOGIN_WALL);
  if (byFinding) return 'ROUND_LOGIN_WALL';
  // ② 旧口径（2026-10-06）：归位记录里 `reclaim` 的 `from` 就是「那个页签当时实际停在哪」。
  const actions = Array.isArray(normalize?.actions) ? normalize.actions : [];
  const onLoginWall = actions.some((action) => isSycmLoginWallUrl(action?.from));
  return onLoginWall ? 'ROUND_LOGIN_WALL' : 'ROUND_BLOCKED';
}

/** 归位之后**仍然缺**的页面名（业务口径：就是窗口里少开的那几页）。 */
export function roundMissingPagesOf(normalize) {
  const after = Array.isArray(normalize?.after) ? normalize.after : [];
  return after.filter((item) => item && Number(item.count) === 0).map((item) => item.page).filter(Boolean);
}

/** 一轮的失败视图（纯函数；`summary` 就是落盘的 summary.json 的形状）。
 *
 * 第二个参数是**跑前登录态结论**（`check-login-shops.mjs --json` 的产物）。三条口径：
 *   ① **不给（`null`）⇒ 返回对象逐字不变** —— 一个键都不多。多一个键都会让「这条链今天
 *      与昨天不一样」，而「默认不变」是这层唯一的安全保证。
 *   ② ⚠️ 不给**不许**退化成 `[]`：那会让「没查」被读成「都不缺」，收信人看到一句「都好的」
 *      —— 而那一层根本没跑过。所以这里判的是 `=== null`，`[]` 是另一个东西（＝查了、零家）。
 *   ③ 它**不影响 `any`**：这条消息是失败告警，全绿的那天不发。登录态结论只改「怎么解释这次失败」。
 */
export function roundFailureSummary(summary = {}, { loginPreflight = null } = {}) {
  const entries = Object.entries(summary?.shops ?? {});
  const failed = entries.filter(([, record]) => record?.status !== 'ok')
    .filter(([, record]) => !isWaitingOperatorAccountStatus(record))
    .map(([key, record]) => ({ key, record, cause: shopFailureCause(record) }));
  const ok = entries.filter(([, record]) => record?.status === 'ok').map(([key]) => key);
  const waiting = entries.filter(([, record]) => isWaitingOperatorAccountStatus(record)).map(([key]) => key);
  const roundBlocked = summary?.round?.healthCheckDaily?.ok === false;
  // 整轮被挡的**真因**优先读 summary 里落盘的那一个（链在第 0 步就算好写进去，2026-10-06）；
  // 老 summary（没有那个字段）落回 `ROUND_BLOCKED` —— 与加这个字段之前逐字相同。
  const roundCause = roundBlocked ? (summary?.round?.healthCheckDaily?.roundCause ?? 'ROUND_BLOCKED') : null;
  const view = { failed, ok, waiting, roundBlocked, roundCause,
    roundBlockedDetails: summary?.round?.healthCheckDaily?.blockingDetails ?? null,
    roundMissingPages: summary?.round?.healthCheckDaily?.missingPages ?? null,
    any: roundBlocked || failed.length > 0, total: entries.length };
  if (loginPreflight === null || loginPreflight === undefined) return view;
  return { ...view, login: normalizeLoginPreflight(loginPreflight) };
}

/**
 * 告警闸门的第二道（2026-09-29，⑨b）：**「先让 agent 试一下，再叫人」**。
 *
 * 背景（三层降级的第②层一直被跳过）：
 *   用户口径是「脚本修不动 ⇒ 唤醒修复 agent ⇒ agent 也修不动才发飞书」。
 *   可链级告警原先由本文件**直接**发飞书，完全不问「这一家其实该先交给 agent」——
 *   于是第②层在真跑里从没被执行过，第③层（叫人）被提前执行。
 *   脚本自己没有 `Agent` 工具（唤不醒 agent，那是会话侧的事），所以「派 agent」这一步
 *   不可能在这里真的做掉；**能做、也是真正断掉的那一截**是：别在这一刻叫人，
 *   而是把派单落盘、把「这一轮交给 agent 了」这个意图如实说出来。
 *
 * 判据（fail-closed，只有整批都够格才拦）：
 *   · 只看 `failed` 里每一家经 `classifyShopEscalation` 是否 actionable；
 *   · **只要有一家「只能人上」**（登录掉了、权限不足、无候选可修）⇒ 照旧叫人，
 *     并把那一家的店名带出来 —— 半批能救不是「都不用叫人」的理由；
 *   · 全批都够格 ⇒ 不发飞书，返回派单（调用方落盘）。
 *
 * 为什么不是「把 actionable 的挑出来不发、剩下的照发」：那样会出现
 * 「同一轮里有些店悄悄进了 agent 队列、人只看到另一部分」—— 事后核对时
 * 「这半批去哪了」无从回答。整批进 / 整批出，是一句能写进收据的话。
 *
 * @returns {{defer: boolean, targets: object[], humanOnly: string[]}}
 */
export function planAlertDeferral({ summary = {}, summaryPath = null, loginPreflight = null, enabled = false } = {}) {
  const view = roundFailureSummary(summary, { loginPreflight });
  if (!enabled || !view.any) return { defer: false, targets: [], humanOnly: [] };
  const targets = [];
  const humanOnly = [];
  for (const { key, record } of view.failed) {
    const target = classifyShopEscalation({ shop: key, record, summaryPath });
    if (target) targets.push(target);
    else humanOnly.push(key);
  }
  // 整批失败都必须够格；`targets` 为空（一家都不够格）也不 defer —— 那正是「叫人」的场合。
  const defer = targets.length > 0 && humanOnly.length === 0;
  return { defer, targets: defer ? targets : [], humanOnly };
}

/**
 * 跑前登录态结论 —— 只留业务消息能用的那几项。
 *
 * ⚠️ 产物里还有**机器名**（`machine`）与逐店的 `href`（探针最终地址）。那些是技术串，
 * 一个都不许进这条消息（`assertAlertIsBusinessReadable` 也会在生成处拦一次）。
 * 这里做第一道：**只挑字段，不做透传** —— 透传的写法会在上游加一个字段的那天自动把它发出去。
 */
export function normalizeLoginPreflight(input) {
  if (input === null || input === undefined) return null;
  const pick = (list) => (Array.isArray(list) ? list : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      shop: item.shop ?? null,
      // 平台键一律**按词表过滤**：认不出来的键不许原样出现在业务消息里（那会是一串英文）。
      sites: (Array.isArray(item.sites) ? item.sites : []).filter((key) => Boolean(SITES[key])),
    }));
  return {
    verdict: typeof input.verdict === 'string' ? input.verdict : null,
    needHuman: pick(input.needHuman),
    unknown: pick(input.unknown),
    checked: Number.isInteger(input.checked) ? input.checked : null,
    unreadable: input.unreadable === true,
  };
}

/**
 * 读跑前登录态结论那个文件（`check-login-shops.mjs --json` 写出来的）。
 *
 * 三种输入、三种结论，**一种都不许折成另一种**：
 *   · 没给路径（`null`）      ⇒ `null`：「这一轮没查过」。
 *   · 给了但读不出来/不是 JSON ⇒ `{ unreadable: true }`：「本来要查，结论丢了」。
 *   · 读到了                  ⇒ 归一化后的结论。
 *
 * 中间那一种刻意**不抛错**：这是一层**诊断**，不是闸门 —— 它读不到不该拦住整轮采集
 * （链的第 0 步体检才是「今天能不能写」的权威判据）。但它也不许静默降级成「都不缺」：
 * `unreadable` 会被原样说进告警文案里，收信人看得到「这次不知道是不是掉登录」。
 */
export function readLoginPreflight(filePath) {
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    // `null` / 不是对象（例如文件里只有 `null`、或写的是个数组）同样算「读不到」：
    // 折成「没查」会让「本来要查、结论丢了」从现在这条链上彻底消失。
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('结论不是一个对象');
    return normalizeLoginPreflight(parsed);
  } catch {
    return { verdict: null, needHuman: [], unknown: [], checked: null, unreadable: true };
  }
}

// 收信人在这里看到的每一个词（原因/下一步/续跑承诺）**唯一定义在
// `runtime/alert-copy.mjs` 的 daily 分支**（2026-10-13 全仓统一词表，原样搬过去、一字未改，
// 连同它们上面那几条「为什么必须单列一类」的注释）。搬移的理由：判据只能有一个落点，
// 而 skills 下的模块不许被 runtime 反向依赖 ⇒ 数据住 runtime，链这边用别名。
// 本文件顶部有它们的三张互锁（加载期就查：少一条结论模块直接起不来）。

/** 收信人看到的「哪家店、停在哪一步」。店名后面带上**他在浏览器里能看到的登录名**，方便对上窗口。 */
export function describeShopFailure(key, record, { cause = null } = {}) {
  // 结论可以由调用方**指定**：跑前登录态那一层会把「页面不齐」这类改判成「掉登录」
  // （见 buildRoundFailureAlert）。不给就自己算 —— 两个参数的调用与从前逐字相同。
  const effective = cause ?? shopFailureCause(record);
  const at = record?.failedStage ? stageNumber(key, record.failedStage) : null;
  const where = record?.failedStage
    ? `停在第 ${at ?? '?'} 步（${stageLabelOf(record.failedStage)}）`
    : '没跑完，但记录里没写停在哪一步';
  // 体检拦下来的那几条明细直接给出来：只说「体检没过」等于让收信人自己去翻日志。
  const specifics = (record?.blockingDetails ?? []).filter(Boolean).slice(0, 3);
  // 账号名（`里可林家居:阿彦`）**不进业务消息**：窗口标题里写的就是运营叫法（店名），
  // 业务人员靠店名就够对上窗口了；而账号名一旦被转发到群/邮件就是一条泄露面。
  // 它仍然留在驱动启动时打出的身份表里（stdout / job.log），需要时那里能查。
  return `· ${key}—— ${where}。${REASON_BY_CAUSE[effective]}`
    + (specifics.length ? `\n  ${specifics.join('\n  ')}` : '');
}

/** 平台键 → 中文页名。认不出来的键在归一化那一步已经被丢掉，这里只是最后兜一次底。 */
const siteLabels = (sites) => {
  const labels = (sites ?? []).map((key) => SITES[key]?.label).filter(Boolean);
  return labels.length ? labels.join('、') : '后台';
};

/**
 * 跑前登录态那一段话。四种情形各有各的说法，**一种都不许省**：
 *   ① 没查（`null`）       —— 说清「没查过」，并给出「若打开后又回登录页就是掉登录」这条自判据；
 *   ② 要查但结论丢了       —— 说清「本来要查、结论没读出来」，不许装作查过；
 *   ③ 查了、谁掉了         —— 点名哪个店哪个后台（**按平台分别说**），整轮没开跑时补一句因果；
 *   ④ 查了、都在 / 没结论  —— 分别说清（「问题不在登录上」本身就是收信人最想要的一句话）。
 *
 * 为什么这段话必须存在（2026-09-23 用户拍板「1.改」）：链的第 0 步体检只答「页面够不够」，
 * 而「页面被弹回登录页」与「页签被关掉」在它眼里**同形**（都是页面不在）。
 * 于是掉登录时告警给的是「把这两页各开一个」—— 收信人照着做**无效**（开几个都被送回登录页）。
 * 收信人照着一条对不上现场的建议去做比不通知更糟，这已经是本仓库第三次吃同一个亏。
 */
function loginPreflightLines(login, { needLogin = [], unknown = [], roundBlocked = false, roundLoginWall = false } = {}) {
  // ①′ 先判「整轮被挡的真因就是登录墙」（2026-10-06 加）。
  //
  // 它必须排在最前面：下面每一条讲的都是**各店后台**的登录态，而这一种现场里那些店后台其实是好的
  // （跑前刚查过）—— 照下面任何一条写，出来的就是「问题不在登录上」这句话本身。
  // 这一句的措辞刻意与「哪一家店掉登录」分开：掉的是**共用窗口**（商家号），只有一次登录，
  // 而且要去共用窗口里登 —— 照着逐店那条去登，会把每家自己的窗口都登一遍，然后问题照旧。
  if (roundLoginWall) {
    // 这一句只补**上面「原因」里没有的**那一半：不是哪一家店，别去它们自己的窗口里找。
    // （2026-09-18 记过同一条纪律：「原因」那一段被写成同一句话读两遍。）
    return ['（这不是哪一家店掉登录：跑前查过的那几家店后台当时都是好的，'
      + '所以别去它们各自的窗口里找 —— 只登那一个共用窗口。）'];
  }
  if (login === null) {
    return ['（这一轮没有先查登录态：上面那句「页面不齐」到底是页面被关掉了、还是掉登录后被送回'
      + '登录页，没查过。按上面的下一步做；如果打开后又被送回登录页，那就是掉登录，'
      + '要在窗口里重新登录一次。）'];
  }
  if (login.unreadable || login.verdict === null) {
    return ['（这一轮本来要查登录态，但那份结论没读出来 —— 所以不知道是不是掉登录。按上面的下一步做。）'];
  }
  if (needLogin.length > 0) {
    const who = needLogin.map((item) => `${item.shop}（${siteLabels(item.sites)}）`).join('、');
    // 整轮没开跑时，上面那句「页面不齐」就是这一件事的**症状**，必须把因果挑明 ——
    // 否则收信人会同时看到「页面不齐」与「去登录」两条对不上的话。
    const bridge = roundBlocked
      ? ' —— 上面那条「页面不齐」就是这么来的：掉登录时采集页面会被平台送回登录页，开几个都一样。'
      : '';
    return [`（跑前先查过登录态：${who}掉登录了${bridge}）`];
  }
  if (login.verdict === 'ALL_IN') {
    return ['（跑前先查过登录态：这一轮的店后台都在登录态 —— 所以问题不在登录上，按上面的下一步做。）'];
  }
  if (unknown.length > 0) {
    const who = unknown.map((item) => `${item.shop}（${siteLabels(item.sites)}）`).join('、');
    return [`（跑前先查过登录态，但这些店没读出结论：${who} —— 它们的登录态没法确认。）`];
  }
  // 查过、而且确实有店掉登录，但掉的不是**这一轮**要跑的那几家（分批时会出现）。
  // 这句必须说：不说的话，收信人会以为「没提登录＝查过没问题」—— 而这里恰恰是
  // 「有店有问题、但不是这几家」。
  return ['（跑前先查过登录态：这一轮的店都不缺登录；掉登录的是别的店。）'];
}

/**
 * 一条告警说清「哪几家收完了、哪几家没有、下一步做什么」。
 *
 * 字段名必须落在 `runtime/notify-feishu-core.mjs` 的 `READABLE_SOURCE_KEYS` 白名单里，
 * 否则渲染时会被静默丢掉（告警照发，收信人看不到那一行）。
 * **但白名单管的是键，管不到值** —— 值里的路径/机器名/编号照样会原样发出去，
 * 所以「不给它这些字段」才是对的写法（2026-09-21：`machine` 与 `evidence` 就是从这里漏出去的）。
 * 这一条由函数末尾的 `assertAlertIsBusinessReadable` 拦在生成处（fail-closed）。
 *
 * `loginPreflight`＝跑前登录态结论（`readLoginPreflight` 的产物）。**不给就是 `null`**：
 * 那会让文案退到「这一轮没有先查登录态」那一句（见 loginPreflightLines），而不是安静地少说
 * 一件事 —— 「没查」与「查了没问题」在收信人眼里必须是两句不同的话。
 */
export function buildRoundFailureAlert({ date, summary, shopKeys = null, loginPreflight = null, willResume = false, tech = null, now = () => new Date() }) {
  const view = roundFailureSummary(summary, { loginPreflight });
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
  // 登录态结论**只保留这一轮真的在跑的那几家**：那一次体检可能是一次查五家，
  // 而这一轮（尤其分批时）只跑其中几家 —— 不筛就会在告警里点名一批跟这次无关的店。
  const inRound = (item) => shopKeys.includes(item.shop);
  const needLogin = (view.login?.needHuman ?? []).filter(inRound);
  const unknownLogin = (view.login?.unknown ?? []).filter(inRound);
  const loginShops = new Set(needLogin.map((item) => item.shop));
  // 结论合并：掉登录的那些店（以及被它们挡住的整轮）改判成 NEEDS_LOGIN。
  // 「页面不齐」在掉登录下只是**症状**，照着它的下一步（去开页面）做是无效动作。
  const causeOf = (item) => (loginShops.has(item.key) ? 'NEEDS_LOGIN' : item.cause);
  // 整轮被挡时的结论分两步：先看「有没有哪一家店**自己**掉登录」（那是逐店动作、一次登一家），
  // 都没有才看整轮的真因 —— 而整轮的真因只有两种：共用窗口掉登录（登一次）与页面真的缺（去补页）。
  // 2026-10-06 之前这里只有前者，于是共用窗口掉登录时落进 `ROUND_BLOCKED`，
  // 收信人被指去补页（补了也被送回登录页）。
  const roundLoginWall = view.roundCause === 'ROUND_LOGIN_WALL';
  const blockedCause = view.roundBlocked
    ? (loginShops.size > 0 ? 'NEEDS_LOGIN' : (roundLoginWall ? 'ROUND_LOGIN_WALL' : 'ROUND_BLOCKED'))
    : null;
  const subject = view.roundBlocked ? '全部店铺' : failedNames.length === 1 ? failedNames[0] : `${failedNames.length} 家店`;
  const causes = [...new Set([...(blockedCause ? [blockedCause] : []), ...view.failed.map(causeOf)])];
  // 指纹用的成因集合：**去重 + 排序**（与失败店的出现顺序无关 —— 同一组成因换个店序不该看成两条）。
  const causeSet = [...new Set(view.failed.map(causeOf))].sort();
  // 默认「第一家失败即停整轮」⇒ 只写「没跑完 1 家」会被读成「其余几家都收好了」。
  // 2026-09-21 那条正是这个形态：对象写「日报一轮 · 5 家店」，原因写「没跑完 1 家」，
  // 而实际是**其余 4 家一步都没跑**。少写这一行，等于让收信人以为今天收工了。
  const notRun = view.roundBlocked ? [] : shopKeys.filter((key) => !(key in (summary?.shops ?? {})));

  const reason = [
    view.roundBlocked ? REASON_BY_CAUSE[blockedCause] : null,
    // 体检那几行明细只在「页面真的缺」时给：它们带着内部片段（「按片段 … 找到 0 个」），
    // 而在掉登录的现场它们只是**症状** —— 给出去等于让收信人照着去补页，白跑一趟。
    ...(view.roundBlocked && !roundLoginWall
      ? (view.roundBlockedDetails ?? []).filter(Boolean).slice(0, 3).map((line) => `  ${line}`) : []),
    // 掉登录时改说「窗口里少了哪一页」，并且**明确说不用补** —— 这一句就是防他照着旧文案去开页面的。
    ...(roundLoginWall && (view.roundMissingPages ?? []).length
      ? [`  窗口里少了：${view.roundMissingPages.join('、')} —— 这是掉登录的结果，不用你去补页。`] : []),
    // 紧跟在「页面不齐」那几行后面：这一段是**对它的解释**，顺序反了就成了一句前言不搭后语的话。
    ...loginPreflightLines(view.login ?? null, { needLogin, unknown: unknownLogin,
      roundBlocked: view.roundBlocked, roundLoginWall }),
    view.failed.length ? `没跑完 ${view.failed.length} 家：\n${view.failed.map((item) => describeShopFailure(item.key, item.record, { cause: causeOf(item) })).join('\n')}` : null,
    view.waiting.length ? `等待运营账号 ${view.waiting.length} 家：${view.waiting.join('、')}（日报流程暂缓，账号恢复后可继续）` : null,
    notRun.length ? `· 另外 ${notRun.length} 家今天一步都没跑（有一家停住后，整轮就停了）：${notRun.join('、')}` : null,
    view.ok.length ? `已收完 ${view.ok.length} 家：${view.ok.join('、')}` : null,
  ].filter(Boolean).join('\n');

  const actions = causes.map((cause) => ACTION_BY_CAUSE[cause]({
    date, shops: failedNames, needLogin: needLogin.map((item) => item.shop), willResume,
  }));

  const alert = {
    type: 'DAILY_ROUND_FAILED',
    severity: 'ERROR',
    // 标题第一段固定是流程名（2026-10-13 用户定稿第 3 条）：收信人扫一眼就知道
    // 「是哪条流程的事」，不必点开正文猜。方框词与 capability 的运营叫法同源
    // （`runtime/alert-copy.mjs` 的 FLOWS['daily-report']）。
    title: view.roundBlocked
      ? `【店铺日报】全部店铺没收完（统计日 ${date}）`
      : `【店铺日报】${subject}没收完（统计日 ${date}）`,
    // 同一天同一轮共用一条锚；**是否重复投递由调用方的 resolveAlertDedup 判**（投递链本身不去重）。
    alertId: `daily-round-${date.replace(/-/gu, '')}`,
    // 指纹只服务于「同一天这一条要不要再发」。判据是**根因集合**，不是**停的位置**（2026-10-14 改）。
    //
    // 为什么换：这条告警的「下一步」是按**成因**给的（上面 `ACTION_BY_CAUSE[cause]`），
    // 所以「要做的事有没有变」这件事只能由成因集合回答。原先的指纹是 `店@阶段`，两个方向都错：
    //   ① **轮级那一段被抹成笼统的 `ROUND_BLOCKED`**（不带成因）⇒ 两种不同的轮级成因落进
    //      同一个指纹 ⇒ 6 小时内第二条被**静默挡掉**。这是漏发，比刷屏坏得多：这两类成因要人
    //      做的事完全不同（共用窗口掉登录 ⇒ 去那个窗口登一次；页面真的不在 ⇒ 补页）。
    //      真现场：`evidence/batches-2026-10-13/batches.log` 里那两条 `daily-round-20261013`
    //      一条是掉登录、一条是店级 readback —— 成因确实不同，所以当时两条都发出去了；
    //      而「两条不同成因的轮级告警」这一形态，旧指纹是挡得掉的（判据看不出它们不同）。
    //   ② 用位置当指纹 ⇒ 同一个根因**换一家店、或换一个步骤**发作就算「新信息」再发一条。
    // 现在：`ROUND_BLOCKED:<轮级成因>` / `SHOP_LEVEL` ＋ **去重 + 排序**的店级成因集合
    // （排序是为了与店铺的出现顺序无关：同一组成因换个店序不该看成两条）。
    //
    // 代价（写出来，免得以后有人以为它漏了）：同一个成因**换一家店**发作，6 小时内不会再发一条
    // —— 那家店的名字只在第一条消息里出现过。这是有意的取舍：这个通道的职责是「叫人动手」，
    // 不是「逐家记账」；逐家状态在 `summary.json` 与飞书底单里都查得到。
    // 两个安全阀：窗口是 6 小时（过了就重发）；alertId 一天一换（第二天必然重发）。
    fingerprint: [
      view.roundBlocked ? `ROUND_BLOCKED:${blockedCause ?? 'UNKNOWN'}` : 'SHOP_LEVEL',
      ...causeSet,
    ].join('|'),
    createdAt: when.toISOString(),
    reason,
    action: [...new Set(actions)].join('\n'),
    source: {
      targetLabel: `店铺日报一轮 · ${total} 家店`,
      period: `统计日 ${date}`,
      capability: '店铺日报',
      shopName: failedNames.length ? failedNames.join('、') : null,
    },
    // 技术定位块（两段式的第二段，2026-10-13）：**调用方给才挂**。这里只透传，
    // 形状由 `buildTechBlock` 校验（白名单 5 键、值里不许有机器名）。
    // 业务第一段里**故意不给** machine / 机器、evidence / 运行日志目录 ——
    // 它们是技术串，不该出现在业务消息里（白名单只约束键，值一旦给了就会原样渲染出去）。
    // 技术同学从驱动的 stdout 与 job.log 里看，那里会把这条告警的正文、日志目录完整打出来。
    ...(tech ? { tech } : {}),
  };
  assertAlertIsBusinessReadable(alert);
  return alert;
}

// 这一条链的收信人是**运营**，白名单是给全仓共用渲染器定的、里面确实有给技术同学用的键
// （`machine`/`browserProfile`/`loginUrl`）。所以「不给这些字段」这件事必须**在生成处拦**，
// 不能只靠用例：用例只在 CI 时红，而这条消息可能先被手跑发出去（2026-09-21 就是这么漏的）。
// 判据是**形状**：任何一层出现这些键名即当场抛错，而不是渲染时静默丢掉或原样发出去。
//
// 2026-10-13 起有一个**唯一的例外子树**：`tech`（技术定位块）。它是两段式告警的第二段，
// 本来就是给技术同学的 —— 里面放证据目录、机读阶段名、退出码都是设计如此。
// 但**机器名仍然不放**（`buildTechBlock` 在生成处连查两遍：键在白名单 / 值里没有机器名），
// 所以这里对 tech 子树的判据只剩「键必须在技术白名单里」，交由 `buildTechBlock` 保证。
const FORBIDDEN_ALERT_KEYS = Object.freeze(['machine', 'browserProfile', 'evidence', 'logDir', 'hostname', 'profile']);
const READABLE_SOURCE_KEY_NAMES = new Set(READABLE_SOURCE_KEYS.map(([key]) => key));

export function assertAlertIsBusinessReadable(alert) {
  const seen = [];
  const walk = (value, at) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      // 技术定位块整棵子树跳过（它是第二段，不是业务第一段）；块内的键由
      // `buildTechBlock` 的白名单校验，这里再查一遍就是两个事实。
      if (at === '' && key === 'tech') continue;
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
 * 失败告警的**技术定位块**（两段式的第二段，2026-10-13）。
 *
 * 只放 `buildTechBlock` 白名单里的五个键，且**不放机器名**（单机无定位价值；
 * 2026-10-06 已定「按窗口标题找，不按 hostname 找」）。缺值的键整行不输出。
 *
 * `exitCode` 由调用方给：两个调用点都在 `process.exitCode = 1` 落定之后才走到这里，
 * 所以「1」是这一轮真实的退出码，不是猜的。
 */
function roundTechBlock({ summary, logRoot, exitCode = 1 }) {
  const failedStages = [...new Set(Object.values(summary?.shops ?? {})
    .map((record) => record?.failedStage)
    .filter(Boolean))];
  return buildTechBlock({
    evidenceDir: path.relative(REPO_ROOT, logRoot).replaceAll('\\', '/'),
    stage: failedStages.join(','),
    exitCode,
    version: currentVersion(),
  });
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
    stopOnFirstFailure: false,
    only: null, logs: null, downloads: null, shopXlsx: null, promotionZip: null,
    allowMissingPeer: false, notify: false, notifyPrint: false, loginPreflight: null, willResume: false,
    autoRepair: false, autoRepairMaxRounds: DEFAULT_AUTO_REPAIR_MAX_ROUNDS,
    deferAgentActionableAlert: false, reloginOnWall: false, allowEmptyPromotion: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    // 原样收下，出了循环再解析（`--date yesterday` 要用「这一刻」的时钟算，只算一次）。
    if (key === '--date') args.dateInput = argv[++i];
    // 出错时才发飞书（成功一声不响）；`--notify-print` 只打印不投递，用来看文案。
    else if (key === '--notify') args.notify = true;
    else if (key === '--notify-print') args.notifyPrint = true;
    // 这一轮跑完之后会有**驻留进程**接管（定时任务用，见 scripts/hold-and-resume.mjs）
    // ⇒ 告警里才可以说「做完不用回复，系统会自己接着跑」。手工直接跑链时不给这个开关，
    // 文案就是「告诉技术同学重跑一次」（见 ACTION_BY_CAUSE 上方那条注释）。
    else if (key === '--will-resume') args.willResume = true;
    // 历史日（不是「昨日」）的回填降级开关。**默认关**，见 buildShopStages 里 backfill 那段。
    else if (key === '--allow-missing-peer') args.allowMissingPeer = true;
    // 2026-10-20 加：**推广 CSV 0 行时按实际留空**（业务口径，用户拍板「没有就留空」）。
    //
    // 为什么默认关：0 行有两种成因 ——「这家店当天真的没投」与「平台数据还没出／还没静止」——
    // 在 CSV 层面同形；同日早跑写进飞书的低值当天无法重推（只能先删那一天）。
    // 要它就得显式给，且给之前人应当已经看过平台报表页的花费汇总。
    // 它只放行「空」：「有行但日期不对」仍然拦，那是下错文件/筛选失效，与「没有数据」无关。
    else if (key === '--allow-empty-promotion') args.allowEmptyPromotion = true;
    else if (key === '--shops') args.shops = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--commit') args.commit = true;
    else if (key === '--verify-existing') args.verifyExisting = Number(argv[++i]);
    else if (key === '--keep-going') args.keepGoing = true;
    // 2026-09-25 加：**退回**「首家失败即停整轮」。默认不再启用它 ——
    // 默认值已经翻成「一家失败不带走其余」（理由见下面那个 break 处的注释）。
    // `--keep-going` 仍然接受：它是新默认值的显式声明，保留是为了不改既有调用方的命令行。
    else if (key === '--stop-on-first-failure') args.stopOnFirstFailure = true;
    // 2026-09-29 加：**失败后按「修复请求单」自动修一次再重试该阶段**。
    //
    // 为什么默认关：这是一条**会真的动页面**的路径（关弹窗、重载、重新落日期），
    // 而它接在一条本来就会写飞书的链上。默认开会让「第一次跑就出意外」的概率上升，
    // 而本项目所有默认值的安全方向都是「先什么都不做」。要它就得显式给。
    //
    // 它修什么、不修什么：只做 `REPAIR_TABLE` 里登记过的机械动作（修复动作闭集），
    // 且**只修不需要人的成因**（`HUMAN_REQUIRED_CAUSES` 一律不碰、直接留给人）。
    // 挑哪个候选按表里的顺序（表本身就是「先试哪个」的排序）。
    else if (key === '--auto-repair') args.autoRepair = true;
    // 一轮里最多自动修几次（防止「修不好 → 重试 → 又失败 → 又修」在原地打转）。
    // 默认见 `DEFAULT_AUTO_REPAIR_MAX_ROUNDS`（2026-10-09 起是 2＝菜单一次试完）。
    // 不给它时**不是**「一次修不好就停手」—— 那个默认值会让每个成因的第 2 个候选
    // 永远轮不到（`REPAIR_TABLE` 每条都是两个候选），收据里留下「候选还剩 …」。
    else if (key === '--auto-repair-max-rounds') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--auto-repair-max-rounds 需要一个非负整数（0 = 关掉自动修复）');
      }
      args.autoRepairMaxRounds = value;
    }
    // 2026-09-29 加：**「先让 agent 试一下，再叫人」**——把「三层降级」的第②层接进告警闸门。
    //
    // 为什么默认关：它改变的是「这一轮要不要打扰人」，属于行为口径，不是一个修复动作。
    // 而且它只有配合**会话侧的派单**才有意义（脚本自己没有 `Agent` 工具，唤不醒 agent）。
    // 所以默认保持原样（有需要人的失败就叫人），要它得显式给 —— 与会话侧约定好再开。
    //
    // 它做什么：把失败店按 `classifyShopEscalation`（`runtime/escalation-plan.mjs`，
    // **与派单同一份判据**）分成「agent 能救」与「只能人上」两堆。**只有全部失败店
    // 都落在「agent 能救」时**才不发飞书，并把派单落成 `escalation-handoff.json`；
    // 只要有一家只能人上，照旧发、且文案里仍然点名到店（fail-closed）。
    else if (key === '--defer-agent-actionable-alert') args.deferAgentActionableAlert = true;
    // 2026-10-10 加：**链中间撞到登录墙就地补登一次**，成功就重试该步、顺着往下跑。
    //
    // 为什么必须有它（缺陷 ㉝ 的另一半）：整轮唯一会去登的地方是分批开跑**之前**那一次
    // `login-preflight`（结论落 `login-preflight-b<N>.json`），而那是一次性的 ——
    // 会话在它之后掉线时（2026-10-08 网林天猫：07:34 判 `ALL_IN`、07:36:57 就落登录墙），
    // 余下 11 步里**没有任何一步会回头看登录态** ⇒ 一份存好的密码从头到尾没被调用过。
    //
    // 为什么默认关：它与 `--auto-repair` 同一条理由 —— 这是一条**会真的动页面、会提交表单**
    // 的路径，而每一次登录提交都是一次账号动作（平台风控看的正是同一出口 IP 短时间内的登录次数）。
    // 打开它是必须说出口的决定。宿主（`scripts/run-daily-job.mjs`）默认打开，
    // 并给了 `--no-relogin-on-wall` 让运维一键退回。
    //
    // 上限是硬的：**每家店每轮最多一次**（见下面那个 `reloginUsed`），不是「失败一次试一次」。
    else if (key === '--relogin-on-wall') args.reloginOnWall = true;
    else if (key === '--only') args.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--logs') args.logs = argv[++i];
    // 跑前登录态结论（`check-login-shops.mjs --json` 写出来的那个文件）。**只在给的时候读**：
    // 不给就是「这一轮没查过登录态」，告警文案会如实这么写（见 loginPreflightLines）。
    // ⚠️ 给了路径却读不到**不在这里报错**：它是诊断层、不是闸门，读不到不该拦住采集 ——
    // 但它会被说成「本来要查、结论没读出来」，不许静默折成「都不缺」（见 readLoginPreflight）。
    else if (key === '--login-preflight') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--login-preflight 需要一个结论文件路径');
      args.loginPreflight = value;
    }
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
    downloads = null, allowMissingPeer = false, allowEmptyPromotion = false } = options;
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
  // `--shop-key`（运营叫法）**必须给**：这一阶段要按店铺查「日报报表行标题」的登记表
  // （`collect-shop-report.mjs` 的 `SHOP_REPORT_ROW_TITLES`），而那张表的键是运营叫法，
  // 不是 `--expect-shop` 的页头店名（盖文天猫的页头叫「盖文旗舰店」）。
  // 2026-10-05 实测：少了这一个参数，登记好的店也查不到 ⇒ 静默退回默认判据
  // ⇒ 报「等不到『日报』」，看着与「根本没登记」一模一样。
  add('shop-report', 'collect-shop-report.mjs',
    ['--date', date, '--proxy', shopProxy, '--shop-key', shopKey, ...common, ...identityArgs], shopEnv,
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
  // 只透传，不在这一层做判断：放不放行由 `run-daily-report.mjs` 的 `assertSourceDates` 与
  // `buildCombinedFields` 拿「是否真的空」再判一次（两处都要，缺一处就会「过了一道又撞另一道」）。
  if (allowEmptyPromotion) pushArgs.push('--allow-empty-promotion');
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

  // 与「哪些阶段跑在共用商家浏览器上」互锁（2026-10-14 加）。
  //
  // 为什么要有它：这条规则原先只活在上面的 stage 表里（两处 `add(..., dailyProxy)`），
  // 而链**外面**还有三处在用同一个问题的答案（派单单子的 execHint / instancePrecondition、
  // 自动修复的 execRepair）。三处各自算一遍 ⇒ 一旦漂开，修复动作会指向**另一台**浏览器，
  // 而且**每一处都不会报错**（10-13 网林淘宝那次的直接成因）。
  // 现在答案只有一处（`stage-browsers.mjs` 的 `stageUsesSharedPage`），这里拿真实阶段表去核它：
  //   · 声明「跑在共用实例上」的阶段，argv/env 里必须真的是共用端口；
  //   · 其余阶段必须真的是这家店自己的端口。
  // 任一条不成立就当场抛 —— 而不是让修复层悄悄落回店铺实例。
  for (const item of stages) {
    const onSharedProxy = item.env.CDP_PROXY_PORT === String(PROJECT_PORTS.dailyReportProxy);
    if (stageUsesSharedPage(item.stage) !== onSharedProxy) {
      throw new Error(`阶段「${item.stage}」的实例归属与 stage-browsers.mjs 的声明漂移了：\n`
        + `  阶段表用的是 ${item.env.CDP_PROXY_PORT}（${onSharedProxy ? '共用商家浏览器' : '这家店自己的浏览器'}）\n`
        + `  声明说它${stageUsesSharedPage(item.stage) ? '跑在共用商家浏览器上' : '不跑在共用商家浏览器上'}\n`
        + '处置：两边一起改（这条规则被链外的三处复用，漂开时修复动作会指向另一台浏览器且不报错）。');
    }
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
      count: urls.filter((url) => urlMatchesFragment(url, page.urlFragment)).length,
    })),
    foreign: urls.filter((url) => !expected.some((page) => urlMatchesFragment(url, page.urlFragment))),
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

// 告警节流的状态文件与判据**2026-09-24 搬到 `runtime/alert-throttle.mjs`**（已 import 在上面）。
// 搬走的理由留在那个文件头部；这里只记一句「为什么这里看不到了」：
// 判据必须能被**每一条会叫人的链**共用，而它原先住在本文件里 ⇒ 跑前登录守卫那条链没有去重，
// 实测一次预检并发 5 条告警。这里仍然保留 `dispatchRoundAlert`（它只管本驱动的投递口径）。

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
  // `off` 必须在这里就返回（2026-09-26 补；此前**没有**这个分支）。
  //
  // 为什么这是一个真缺陷而不是洁癖：`off` 的唯一含义就是「一个字都别发」，而缺了这个分支之后，
  // 传 `off` 会**直接落到下面的去重与投递**（去重只按编号/指纹判「最近发过没」，它不读
  // `dispatch`）⇒ 一个「没让发」的调用会**真发一条飞书**出去。
  // 目前没炸，只是因为两个调用点各自在调用前写了 `if (alertDispatch.action !== 'off')` ——
  // 也就是说这条判据活在**调用方**，而这正是本项目反复吃的那一类亏：
  // 同一个事实两处实现，漏一处就静默失效（`scripts/hold-and-resume.mjs` 是第三个调用点，
  // 它差一点就成了那个「漏一处」）。判据放回它唯一该在的地方：出口自己。
  if (dispatch.action === 'off') {
    log(`[驱动] （没有打开告警：${dispatch.why ?? '--notify 未给'} —— 只打印，不投递）`);
    return { delivered: false, printed: false, suppressed: false, off: true };
  }
  if (dispatch.action === 'print') {
    log('[驱动] （--notify-print：只打印、不投递）');
    return { delivered: false, printed: true };
  }
  // 读的是**本编号**那一条（`readAlertThrottleEntry`），不是文件顶层：两条链共用这一个状态文件，
  // 顶层那条可能是另一条链刚写的（详见 runtime/alert-throttle.mjs 的文件头）。
  const verdict = resolveAlertDedup({ previous: readAlertThrottleEntry({ file: throttleFile, alertId: alert?.alertId }),
    alertId: alert?.alertId, fingerprint: alert?.fingerprint, now: now() });
  if (!verdict.send) {
    log(`[驱动] 这一条没往外发：${verdict.reason}（编号 ${alert?.alertId ?? '无'}）`);
    return { delivered: false, suppressed: true, reason: verdict.reason };
  }
  // 告警 JSON 走**文件**，不走 stdin（2026-09-25 修）。
  //
  // 为什么：`spawn(..., { input })` 会隐式给子进程建一根 **stdin 管道**，而本机宿主沙箱对
  // 「给子进程管道 stdin 的同步 spawn」直接回 `EBUSY`（`errno=-4082`／libuv `UV_EBUSY`，
  // 1~4ms 内 fail-fast、`status=null`）—— 那正是 2026-09-24 四轮里
  // `告警投递退出码=null` 的成因：**出事的时候连一条告警都发不出去**。
  // `--alert-file` 是 `runtime/notify-feishu.mjs` 本来就有的入口（实测取到过
  // `status=DRY_RUN` 的收据），换成它就不需要 stdin 管道了。
  // 落临时目录而不是证据目录：它的唯一职责是**当运输工具**，而「收信人到底看到了什么」
  // 已经由上面那行 `告警文案（收信人看到的）` 完整落在日志里（唯一证据来源，不重复两份）。
  const alertPath = path.join(tmpdir(), `sycm-round-alert-${process.pid}.json`);
  writeFileSync(alertPath, JSON.stringify(alert), 'utf8');
  // `stdio` 必须显式写：默认值就是被掐的那一形态。写完就删（同步写完即 spawn，不存在重名竞争）。
  let result;
  try {
    result = spawn(NODE, [NOTIFY_CLI, '--alert-file', alertPath], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    try { unlinkSync(alertPath); } catch { /* 临时文件删不掉不影响投递结论 */ }
  }
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

/**
 * 跑前环境自检：这台宿主会不会掐断「给子进程管道 stdin 的同步 spawn」。
 *
 * 为什么要有它（2026-09-25 加）：09-24 那四轮全灭时，日志里只有各阶段一句
 * `error=spawnSync … EBUSY`，事后读日志的人第一反应是「采集脚本坏了／登录掉了」——
 * 而它其实是**宿主执行环境的限制**，与数据、与代码逻辑都无关。把这句话在**跑之前**
 * 就打进 job.log，是唯一能把这两种成因在第一时间分开的办法。
 * （这正是本项目反复出现的同一个形态：一个结论被两种完全不同的成因共用。）
 *
 * 为什么探的是**坏形态**（`stdio: ['pipe','pipe','pipe']`）而不是已经修好的形态：
 * 本驱动自己的两个调用点已经改好（见 runStage / dispatchRoundAlert），但链上**其它**
 * 同步子进程仍在踩 —— `runtime/browser-inventory.mjs` 的 `netstat` 扫描、
 * `scripts/stop-all.mjs` 的 `netstat`/`taskkill`，以及各采集脚本内部的子进程。
 * 它们报 EBUSY 时症状都是**静默降级**（把「读不到」当成「没有」）⇒ 这一行是解释它们的唯一线索。
 *
 * 性质：只读、无副作用（探测子进程是 `node -e 0`）；探测本身失败**不抛错、不拦采集** ——
 * 它是诊断层，不是闸门。
 */
export function probeSyncSpawnSanity({ spawn = spawnSync, node = NODE } = {}) {
  const result = spawn(node, ['-e', '0'], { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' });
  const code = result?.error?.code ?? null;
  const blocked = Boolean(result?.error);
  const line = blocked
    ? `[驱动] 环境自检：宿主会掐断「给子进程管道 stdin 的同步 spawn」（${code ?? 'EBUSY'}）—— `
      + '这是宿主执行环境限制，不是数据问题。链上的同步子进程（本驱动各阶段、告警投递、'
      + 'push 阶段内部的提取器）已按 stdin=ignore 的形态调用；链外仍有未改的调用点'
      + '（runtime/browser-inventory.mjs 的 netstat 扫描、scripts/stop-all.mjs 的 netstat/taskkill），'
      + '它们若因此报 EBUSY、或静默少报了东西（把「读不到」当成「没有」），'
      + '请把这一行连同该阶段的证据一起交给维护者，别按数据问题排查。'
    : '[驱动] 环境自检：宿主没有掐断同步子进程（管道 stdin 可用）—— 这一轮不会因 EBUSY 失败。';
  return { blocked, code, detail: result?.error?.message ?? null, line };
}

/**
 * 一轮里最多自动修几次。**默认 2**（见 `--auto-repair-max-rounds` 的注释）。
 * 导出是为了让测试与调用方读同一个数，而不是各自写一遍。
 *
 * ── 2026-10-09：1 → 2，因为 1 让「候选还没试完就用完配额」变成**结构性**的 ──────────
 * 判据是这张表本身：`REPAIR_TABLE`（repair-actions.mjs）里**每个成因都给两个**候选
 * （STAGE_FAILED → REAPPLY_DATES/RELOAD_PAGE，PAGE_OBSTRUCTED → DISMISS_OVERLAYS/RELOAD_PAGE，
 * SHOP_BLOCKED → RESET_PAGES/RELOAD_PAGE）。而 `autoRepairAndRetry` 的循环是**一个候选吃一轮**，
 * 于是一旦配额 < 菜单长度，第 2 个候选**永远轮不到**，摘要里留下
 * `用完 1 轮（候选还剩 RELOAD_PAGE）`。
 * 这不是理论：2026-10-07 两家失败店（网林家居、网林天猫）的收据逐字就是这句；
 * 而网林家居最后正是靠 `RELOAD_PAGE`（被第①层漏掉的那一个）救回来的 ——
 * 第②层的 agent 补做了第①层没做到的那一下。
 * 更糟的是首位候选 `REAPPLY_DATES` 按实现**恒返回 `applied:false`**（它只是叫你去重跑落位），
 * 所以那唯一一轮经常被一个「设计上不可能生效」的动作吃掉。
 * 取 2＝「菜单一次试完」，于是停手条件回到它该有的那个（候选耗尽），而不是一个比菜单还小的配额。
 * `run-multi-shop-day.test.mjs` 里有一条守卫把「配额 ≥ 最长菜单」钉住（加候选忘了加配额会红）。
 */
export const DEFAULT_AUTO_REPAIR_MAX_ROUNDS = 2;

/**
 * 把候选动作归一成**动作名字符串**。
 *
 * 为什么需要（2026-09-29 实测，`--auto-repair` 整条路径是死的）：
 * `planRepair()` 给的候选是**对象** `{ action, mutating, why }`（契约见 repair-actions.mjs 的
 * `candidates:Array<{action:string,mutating:boolean,why:string}>`），而执行层 `applyRepairAction`
 * 拿的是**动作名**去比 `=== 'DISMISS_OVERLAYS'` 这类字面量。原代码 `const action = list[0]`
 * 直接把对象传下去 ⇒ 四路 `===` 全落空 ⇒ 抛 `没有实现的动作：[object Object]`，
 * 五家店都「试了 1 轮、applied=false」，等于**零修复动作真正执行过**。
 *
 * 为什么用例当时全绿：`run-multi-shop-day.test.mjs` 传的是**字符串数组**
 * `candidates: ['DISMISS_OVERLAYS','RELOAD_PAGE']`，生产传的是对象数组
 * —— 又一次「函数级全绿 ≠ 接线接上了」。所以这一层**同时接受两种形状**（老调用方与离线夹具
 * 都还能用），并把「形状不对」当场炸出来，而不是留给 `===` 静默落空。
 */
export function actionNameOf(candidate) {
  if (typeof candidate === 'string') return candidate;
  if (candidate && typeof candidate === 'object' && typeof candidate.action === 'string') {
    return candidate.action;
  }
  throw new Error(`修复候选既不是动作名也不是候选对象：${JSON.stringify(candidate)}`
    + ' —— 不猜动作；这条一旦走到就是接线漏了');
}

/**
 * 按修复请求单**执行一个候选动作**（只执行，不判断、不重试）。
 *
 * 为什么单独抽成一层：判断（挑哪个候选、值不值得修）是 agent 的事，
 * 执行是脚本的事。这一层只做后者，于是它可以在离线测试里被完整断言，
 * 也可以被 `--auto-repair` 与外部 agent 两条路径共用。
 *
 * 执行方式：**在同一个进程里调 `repair-shop-stage.mjs` 的纯函数**，不再 spawn 一次
 * —— 理由是本项目已经吃过「多一层子进程就多一种静默失败」（EBUSY／.cmd EINVAL）。
 * 但 `repair-shop-stage.mjs` 是 skills 侧另一个文件，直接 import 会引入
 * skills→skills 的隐式依赖；所以这里**只接受注入的 `exec`**，默认由调用方给。
 *
 * 永不抛：修复本身失败不该改变「主线已经失败」这个事实。**唯一的例外**是候选形状不合法
 * ——那不是「修没修成」，而是「根本传错了」，静默吞掉它正是这次故障的成因。
 *
 * @param {{req:object, candidates:Array<string|{action:string}>, exec:Function, log:Function}} o
 * @returns {Promise<object>} {attempted, action, applied, detail, error}
 */
export async function executeRepairCandidate({ req, candidates, exec, log = () => {} }) {
  const result = { attempted: false, action: null, applied: null, detail: null, error: null };
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) {
    // 空候选 = 表里没登记这条成因该怎么修。**如实说「没得修」**，不猜一个动作出来。
    result.detail = '没有可用的修复动作（成因未登记候选，或全部候选都已试过）';
    return result;
  }
  if (typeof exec !== 'function') {
    result.error = '没有注入 exec（无法执行修复动作）—— 这一支不会被走到，走到就是接线漏了';
    return result;
  }
  // 归一成动作名（认对象与字符串两种形状）。形状不合法直接抛——见函数注释。
  const action = actionNameOf(list[0]);
  result.attempted = true;
  result.action = action;
  try {
    const out = await exec({
      shopKey: req?.shopKey ?? null,
      stage: req?.stage ?? null,
      cause: req?.cause ?? null,
      action,
      log,
    });
    result.applied = out?.applied ?? null;
    result.detail = out?.detail ?? null;
    result.exitCode = out?.exitCode ?? null;
    // 动作自己炸了（`applyRepairAction` 把异常收进 `error` 而不是抛）与
    // 「动作执行了但没落地」是两件不同的事 —— 原先它们在 summary 里长得一样
    // （都只是 `applied=false`），排查时要重新去猜。如实转出来。
    result.error = out?.error ?? null;
  } catch (error) {
    // 修复失败**不抛**：主线已经是失败态，再抛一次只会把失败原因换成修复的原因。
    result.error = String(error?.message ?? error);
  }
  return result;
}

/**
 * **agent 修复回环**：失败 → 按请求单挑候选 → 执行 → 重试该阶段。
 *
 * 这条回环的存在理由是用户的一句话：「重试必须要让 agent 根据失败原因去修复再重试」。
 * 换句话说，重试不能是「原样再来一遍」—— 原样再来一遍对 `PAGE_OBSTRUCTED`
 * 这类成因的成功率是零（页面还是那个页面）。**修完再试**才是重试。
 *
 * 三条纪律（写进代码而不是写在文档里，因为它们会被改）：
 *   ① **只修「修复表登记过的成因」**：候选菜单为空 ⇒ 一步都不动。
 *      `NEEDS_LOGIN`／`SHOP_FUNC_NO_PERMISSION`／`ROUND_BLOCKED`／`DUPLICATE_TARGET`
 *      在 `REPAIR_TABLE` 里都没有条目 ⇒ 天然不碰，不靠另一份名单去挡。
 *      为什么不按 `HUMAN_REQUIRED_CAUSES` 判：那个集合说的是「**最终**要人参与」，
 *      而 `PAGE_OBSTRUCTED` 同时属于它**和** `REPAIR_TABLE` —— 前者是「关不掉就得人来」，
 *      后者是「先试着关」。拿前者当闸门会让这一族候选永远试不到，等于把修复层架空。
 *      **闸门只能是修复表本身**（一个来源，不会两处漂开）。
 *   ② **同一个动作不重复试**：一轮修完重试还失败，换下一个候选；候选耗尽就停 ——
 *      这不只是省时间，更是为了不在同一个错误页面上反复重载（那会把页面拖进更差的状态）。
 *   ③ **永不抛、永不改退出码**：回环失败只是让这家店维持原来的失败态，
 *      由上层照旧分诊／告警。它成功才改 `record`。
 *
 * @param {{shopKey:string, logDir:string, req:object, maxRounds:number,
 *          runStage:Function, exec:Function, log?:Function}} o
 * @returns {Promise<object>} 回环记录（会被写进 summary.shops[key].autoRepair）
 */
export async function autoRepairAndRetry({ shopKey, logDir, req, maxRounds = DEFAULT_AUTO_REPAIR_MAX_ROUNDS,
  runStage, exec, log = () => {} }) {
  const trace = { enabled: true, cause: req?.cause ?? null, stage: req?.stage ?? null,
    maxRounds, rounds: [], rescued: false, gaveUp: null, error: null };
  try {
    if (!Number.isInteger(maxRounds) || maxRounds <= 0) {
      trace.gaveUp = 'maxRounds<=0（自动修复没开或配额为零）';
      return trace;
    }
    // 候选来自请求单（＝`planRepair` 给的菜单，而它只从 `REPAIR_TABLE` 取）。
    // **空菜单就是唯一的闸门**：表里没登记这条成因 ⇒ 一个动作都不发。
    //
    // ⚠️ 刻意不另加一张「不许修」的名单：本链已经吃过「同一件事活在四处」的亏
    //    （分类值散在词表/动作表/通知表/DB CHECK，漏一处就静默失效）。
    //    要挡一条成因，正确做法是**别在 `REPAIR_TABLE` 里给它候选**，
    //    而不是在调用侧再抄一份排除名单 —— 两处判据迟早漂开。
    const remaining = Array.isArray(req?.candidates) ? [...req.candidates] : [];
    if (!remaining.length) {
      // 措辞按「这一条到底要不要人」分两档（2026-10-06）。空菜单有两种完全不同的含义：
      //   · 修复表里没登记 ⇒ 「不知道该修什么」⇒ 交给人/agent（原先只有这一支）；
      //   · 本来就无需任何人处理（`noActionRequired`）⇒ **不该说「交给人」** ——
      //     这句话会进 summary 与 job.log，读的人会以为还有一件事等着谁去做。
      // 两档合说一句的后果在 2026-10-05 是实打实的：`网林家居` 的 `gaveUp` 被下一个判据
      // （`unfixableShopsOf`）当成「脚本自修不动」⇒ 驻留 4 小时。
      trace.gaveUp = req?.noActionRequired === true
        ? `成因 ${trace.cause} 本来就不需要任何人处理（不猜动作）`
        : `成因 ${trace.cause} 在修复表里没有候选动作（不猜动作，交给人）`;
      log(`不自动修：${trace.gaveUp}`);
      return trace;
    }
    // （闸门就是上面那个「空菜单」：要挡一条成因，把它从 `REPAIR_TABLE` 里去掉即可，
    //   不在调用侧另留一份「不许修」的名单 —— 两处判据迟早漂开。）
    for (let round = 1; round <= maxRounds && remaining.length; round += 1) {
      const entry = { round, action: null, applied: null, retry: null };
      const attempt = await executeRepairCandidate({ req, candidates: remaining, exec, log });
      entry.action = attempt.action;
      entry.applied = attempt.applied;
      entry.detail = attempt.detail;
      entry.error = attempt.error;
      // 用掉就**从候选里摘掉**（纪律②）：不论成功失败，同一个动作不试第二遍。
      //
      // ⚠️ 必须按**动作名**找下标，不能 `remaining.indexOf(attempt.action)`：
      // `remaining` 里的元素是**对象**（`planRepair` 的契约），拿字符串去 indexOf 永远得 -1
      // ⇒ `splice(-1,1)` 摘掉的是**最后一个候选**，而刚试过的那个还留在队列里
      // ⇒ 同一个动作会被反复试到 maxRounds 用完。2026-09-29 实测到的正是这个形态
      // （候选是对象数组，`attempt.action` 却是字符串）。按名字找，两种形状都对。
      if (attempt.action) {
        const index = remaining.findIndex((item) => actionNameOf(item) === attempt.action);
        if (index >= 0) remaining.splice(index, 1);
      }
      if (attempt.attempted && attempt.applied !== true) {
        // 动作没能落地（页面认不出来／重载超时）⇒ 换下一个候选，不重试阶段。
        // 在「没修成」的前提下重试阶段 = 原样再来一遍，那正是这条回环要消灭的东西。
        entry.retry = { attempted: false, why: '修复动作没落地，不重试阶段（避免原样再来一遍）' };
        trace.rounds.push(entry);
        continue;
      }
      // 修成了 ⇒ 重试该阶段。重试的是**失败的那一步**（`req.retryStage`），不是整条链。
      const retryStage = req?.retryStage ?? req?.stage ?? null;
      if (!retryStage) {
        entry.retry = { attempted: false, why: '请求单里没给重试哪一步（认不出来就不猜）' };
        trace.rounds.push(entry);
        trace.gaveUp = entry.retry.why;
        return trace;
      }
      const retried = await runStage(retryStage);
      entry.retry = { attempted: true, stage: retryStage, status: retried?.status ?? null };
      trace.rounds.push(entry);
      if (retried?.status === 0) {
        trace.rescued = true;
        log(`自动修复救回来了：${attempt.action} → 重试 ${retryStage} 成功`);
        return trace;
      }
    }
    if (!trace.gaveUp) {
      // 候选在 `remaining` 里可能是**对象**（`planRepair` 的契约）。直接 `join` 会印出
      // `[object Object]` —— 2026-09-29 那轮的生产收据就是这样，读的人看不出还剩哪个动作没试。
      // 这里统一取动作名。
      const names = remaining.map((item) => {
        try { return actionNameOf(item); } catch { return JSON.stringify(item); }
      });
      trace.gaveUp = names.length
        ? `用完 ${maxRounds} 轮（候选还剩 ${names.join('、')}）`
        : '候选动作已全部试过';
    }
    return trace;
  } catch (error) {
    // 纪律③：回环自己炸了**不改主线失败语义** —— 如实记，交回上层照旧告警。
    trace.error = String(error?.message ?? error);
    return trace;
  }
}

/**
 * 用链自己的登录脚本给**这一家店**补登一次（2026-10-10 加）。**永不抛**。
 *
 * 为什么复用 `login-merchant.mjs` 而不在这里再写一次表单动作：那是**同一件事**，而且它已经
 * 带着三条 fail-closed 纪律（拿不到 `:autofill` 就停、撞验证码/滑块就停、点了没离开登录页
 * 就如实说没成）和「连着试会把账号锁住、所以不重试」的那条判据。另写一份＝把这三条各写第二遍，
 * 而漂开的那天没人看得出来（症状是「同一种现场两个结论」）。
 *
 * `--notify off` 是**刻意的**：告警出口由链自己那一个统一决定（本仓纪律 ——
 * 「不传 `--notify` 就不该有任何东西发出去」对每一个出口都成立）。开着它会在补登没成时
 * 又发一条飞书，而链稍后还会按分诊结论发它自己的那一条 ⇒ 同一个现场收到两条消息。
 *
 * `--proxy` 与 `--shop` **必须成对**：`--proxy` 是唯一的实例选择器，两者对不上时
 * `login-merchant.mjs` 什么都不碰就停（见它文件头）。这里两个值都取自登记表，
 * 所以天然一致；借这一条也把「对着别的一台做事」这条串店风险关掉。
 *
 * `stdio` 与 `runStage` 逐字一致（`stdin: 'ignore'`）：本机宿主沙箱对「给子进程管道 stdin 的
 * 同步 spawn」直接回 `EBUSY`，那不是业务问题。理由与排除过程见 TOOLING-NOTES。
 *
 * @returns {{attempted:boolean, ok:boolean, verdict:string|null, exitCode:number|null, error:string|null, note:string}}
 */
function reloginShop({ shopKey, wall = null, logDir = null }) {
  const note = () => `用浏览器密码库补登一次（站点＝${wall?.site ?? '未知'}）`;
  const proxyPort = shopInstance(shopKey).proxyPort;
  const scriptPath = path.join(REPO_ROOT, 'skills/sycm-alimama-daily-report/scripts/login-merchant.mjs');
  const argv = ['--commit', '--proxy', `http://127.0.0.1:${proxyPort}`, '--shop', shopKey, '--notify', 'off'];
  const command = `${NODE} ${formatArgv([scriptPath, ...argv])}`;
  const record = { attempted: true, ok: false, verdict: null, exitCode: null, error: null,
    note: note(), command, proxyPort };
  let result = null;
  try {
    result = spawnSync(NODE, [scriptPath, ...argv], {
      cwd: REPO_ROOT, encoding: 'utf8',
      // stdin 只能是 `'ignore'` —— 与 `runStage` 同一条（沙箱下 `'pipe'` 必回 EBUSY）。
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
  } catch (error) {
    record.error = String(error?.message ?? error);
    return record;
  }
  record.exitCode = result.status ?? null;
  if (result.error) record.error = String(result.error.message ?? result.error);
  const stdout = String(result.stdout ?? '');
  // 结论只认回执里的 `verdict`（脚本自己的词表），**不从人话里猜**。
  // 两站点都在登录态时它给 `LOGGED_IN`；`PARTIAL`（只进去一个）按「没成」处理 ——
  // 这一家的链两个后台都要用，缺一个照样跑不下去。
  try {
    const parsed = JSON.parse(stdout.slice(stdout.indexOf('{')));
    record.verdict = parsed?.verdict ?? null;
  } catch { record.verdict = null; }
  record.ok = record.verdict === 'LOGGED_IN';
  if (logDir) {
    const outPath = path.join(logDir, '96-relogin.json');
    const text = `${JSON.stringify({ ...record, wall,
      stdout: stdout.slice(-2000), stderr: String(result.stderr ?? '').slice(-2000) }, null, 2)}\n`;
    try { writeFileSync(outPath, text, 'utf8'); record.logPath = path.relative(REPO_ROOT, outPath); } catch { /* 证据写不下不改变结论 */ }
  }
  return record;
}

function runStage(shopKey, stage, { repoRoot, logDir }) {
  const log = (line) => console.log(`[${shopKey}] ${line}`);
  const outPath = path.join(logDir, `${String(stage.index).padStart(2, '0')}-${stage.stage}.txt`);
  const startedAt = new Date().toISOString();
  const scriptPath = path.join(repoRoot, 'skills/sycm-alimama-daily-report/scripts', stage.script);
  const command = `${NODE} ${formatArgv([scriptPath, ...stage.argv])}`;
  const result = spawnSync(NODE, [scriptPath, ...stage.argv], {
    cwd: repoRoot, encoding: 'utf8',
    // `stdio` 必须**显式**写，而且 stdin 只能是 `'ignore'`（2026-09-25 修）。
    //
    // 不写 stdio 时 Node 的默认值是「三根都是管道」，而本机宿主沙箱对「给子进程管道 stdin 的
    // 同步 spawn」直接回 `EBUSY`（`errno=-4082`／`UV_EBUSY`，1~4ms fail-fast、`status=null`）——
    // 2026-09-24 四轮里**每个阶段**都只留三行、连告警都发不出去，全是这一条。
    // 判据与排除过程在 `.workbuddy/memory/TOOLING-NOTES.md`（分界就在 stdin 那条管道上：
    // `['ignore',…]` 全通，`['pipe',…]` 与 `input:` 全灭；Python 的同步 subprocess 正常
    // ⇒ 与业务、Node 版本、shim 都无关）。
    stdio: ['ignore', 'pipe', 'pipe'],
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
  // 默认跑**参与采集**的那几家，不是登记表全部：登记表里可能有还没开始收集的空店
  // （2026-09-30 起 1 家）。空店跑起来只会停在身份闸门（页头店名没实测），
  // 而那是**每轮都会出现**的一条假失败。
  const shops = args.shops ?? collectingShopKeys();
  for (const key of shops) shopInstance(key);
  const logRoot = path.resolve(args.logs ?? path.join(REPO_ROOT, 'evidence', `multi-shop-${args.date}`));
  const downloads = args.downloads ?? null;
  const explicitSources = { shopXlsx: args.shopXlsx, promotionZip: args.promotionZip };
  // 失败的告警在**两个**失败出口都要能发（整轮没跑起来 / 某家店停在半路），所以算一次、用两次。
  const alertDispatch = resolveAlertDispatch({ notify: args.notify, notifyPrint: args.notifyPrint, mode });
  // 跑前登录态结论：**读一次、两个失败出口都用**。它在 main 里只读一次而不是在告警里现读，
  // 是因为「本轮读到的是什么」这件事本身要**打进驱动的 stdout / job.log** ——
  // 事后翻日志的人必须能看出「这一轮到底查没查、结论是什么」，而不是只看到告警里那句转述。
  const loginPreflight = readLoginPreflight(args.loginPreflight);

  // **跑前的第一行**：把「这台宿主会不会掐断同步子进程」先钉进 job.log。
  // 为什么必须排在所有阶段之前：事后读日志的人分不清「宿主掐断」与「采集/登录坏了」，
  // 而这两种成因的处置完全相反（一个是等环境、一个是修数据）。见 probeSyncSpawnSanity 的头注。
  console.log(probeSyncSpawnSanity().line);
  console.log(`[驱动] 目标日 ${args.date}｜模式 ${mode}｜店铺 ${shops.length} 家：${shops.join(' / ')}`);
  // 字面量被解析过就要说清楚解析成了哪天 —— 定时跑出来的日志里，这一行是唯一的对账依据
  // （事后没人能从 `--date yesterday` 反推出它当时算的是哪一天）。
  if (args.dateInput !== args.date) console.log(`[驱动] （--date ${args.dateInput} 按 Asia/Shanghai 解析成 ${args.date}）`);
  console.log(`[驱动] 日志根 ${logRoot}`);
  // 「结论文案进了告警」这件事的唯一事后证据：这一行。没有它，读日志的人分不清
  // 「这一轮本来就条没查」与「查了、但参数没接上」—— 那正是本条要治的形态。
  if (args.loginPreflight) {
    const state = loginPreflight === null ? '没读（路径为空）'
      : loginPreflight.unreadable ? '读不出来（文件不在或不是那份 JSON）'
        : `${loginPreflight.verdict}（掉登录 ${loginPreflight.needHuman.length} 家／没结论 ${loginPreflight.unknown.length} 家）`;
    console.log(`[驱动] 跑前登录态结论 ${args.loginPreflight} ⇒ ${state}`);
  } else {
    console.log('[驱动] 没有给 --login-preflight：这一轮没查过登录态（告警里会如实这么写）。');
  }
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
    // 整轮被挡的**真因**（2026-10-06 加）：`ROUND_LOGIN_WALL`（共用窗口掉登录）｜
    // `ROUND_BLOCKED`（页面真的缺）｜`null`（体检通过）。
    //
    // 为什么要落盘而不是只留在内存里传给告警：① 告警只是它**一个**读者 ——
    // 驻留那一步（`scripts/hold-and-resume.mjs`）也要照它判「这一轮要不要挂住等人」，
    // 而它在**另一个进程**里，只能读落盘的东西；② 事后复盘时「这一轮到底是哪种被挡」
    // 必须能从证据里读出来，否则人只能再跑一次体检去猜。
    // 判据是纯函数 `roundCauseOf`，输入就是这一步手里的 `detail` 与 `normalize`。
    roundCause: roundCauseOf({ ok: roundHealth.detail?.ok, normalize: roundHealth.normalize,
      findings: roundHealth.detail?.findings }),
    missingPages: roundMissingPagesOf(roundHealth.normalize),
  };
  if (roundHealth.status !== 0) {
    console.error('[驱动] 商家浏览器体检未通过 ⇒ 整轮不跑（推送段与回读段都要用它）。'
      + `详见 ${roundHealth.logPath}`);
    summary.finishedAt = new Date().toISOString();
    // 统一字段并写＋写入时校验（迁移第 2 步）：整轮被挡落盘的 summary 也带统一字段
    // （此刻 shops 还是空对象，只有顶层 version/workflow）。
    applyUnifiedSummaryFields(summary, { logRoot });
    warnSummarySchemaViolations(summary, '整轮被挡收尾');
    writeFileSync(path.join(logRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    process.exitCode = 1;
    if (alertDispatch.action !== 'off') {
      dispatchRoundAlert({
        alert: buildRoundFailureAlert({ date: args.date, summary, shopKeys: shops, loginPreflight,
          willResume: args.willResume, tech: roundTechBlock({ summary, logRoot }) }),
        dispatch: alertDispatch, logDir: path.relative(REPO_ROOT, logRoot),
      });
    }
    return;
  }

  for (const key of shops) {
    const shopLogDir = path.join(logRoot, key);
    mkdirSync(shopLogDir, { recursive: true });
    if (isWaitingOperatorAccountShop(key)) {
      const waiting = waitingOperatorAccountRecord(key);
      summary.shops[key] = waiting;
      console.log(`[${key}] 日报暂缓：等待运营账号（${waiting.state}）；继续下一家`);
      continue;
    }
    const record = { status: 'pending', stages: [], source: {} };
    summary.shops[key] = record;
    let index = 0;
    // 这一家店的全部阶段（跑一次算出来，重试时按名字在里面找）。
    // **阶段表只建一次**：自动修复要「重试失败的那一步」，它必须拿到**与首跑完全相同的
    // argv/env**（含 push 的源文件路径），否则重试就变成了「用一份不同的参数再跑一遍」。
    const stages = buildShopStages(key, { date: args.date, mode, expectedBeforeCount: args.verifyExisting, downloads,
      allowMissingPeer: args.allowMissingPeer, allowEmptyPromotion: args.allowEmptyPromotion });
    // 一家店的「把一批阶段按顺序跑完」这一段**只此一份实现**（2026-10-10，缺陷 ㊱）：
    // 首跑与「自修救回后续跑」都调它，判据（`--only` 跳过、push 源产物守卫、登录墙补登、
    // exit 4 记 evidenceIncomplete、成功时回收 source 路径、失败时抛错）两处不会漂开。
    const runStagesFrom = async (list) => {
      for (const stage of list) {
        // 采集段产出的两条路径要在 push 之前填进参数。**三种模式都要填**：
        // `--shop-xlsx` / `--promotion-zip` 在 run-daily-report.mjs 里是必填参数，
        // 「只读核对就不给源文件」会让 push 直接 missing required argument —— 那就不是只读，
        // 而是连核对都没跑。所以 verify 与 commit 一样要带上采集段的产物路径。
        // ⚠️ 只有**这一步真的会跑**时才需要源产物（2026-10-07 缺陷 ㉘）：
        // `--only` 没点名 push 时它会被 `run()` 直接跳过，此时提前去要那两个路径
        // 只会让整家店死在 push 之前。判据与 `run()` 里的跳过**同一处实现**（`stageSelected`）。
        let argv = stage.argv;
        if (stage.stage === 'push' && stageSelected(args.only, 'push')) {
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
        let result = await run({ ...stage, argv });
        // **退出码 4 = 数据已核对、仅佐证（截图）不完整**，只可能来自 readback（2026-09-28 加）。
        // 它不是数据故障：`independent-readback.json` 已落盘、两张表的结论都在里面。
        // 原先它和真故障共用 exit 1，导致「这一家其实写进去了」与「这一家没写进去」
        // 在 summary/告警里长得一样（09-27 那轮盖文淘宝就是这样）。
        // 这里如实记进 `evidenceIncomplete`，**不写 failedStage、不抛错**，让这家继续按成功收尾；
        // 但**必须留痕**，否则「缺证据」会被静默吞掉 —— 那正是本项目反复吃过的亏。
        if (result.status === SCREENSHOT_INCOMPLETE_EXIT_CODE) {
          record.evidenceIncomplete = record.evidenceIncomplete ?? [];
          record.evidenceIncomplete.push({
            stage: stage.stage,
            note: '数据回读已核对并落盘，仅截图缺失（退出码 4）',
          });
          console.error(`[${key}]   ⚠️ 第 ${stage.stage} 步：数据已核对，仅截图缺失`
            + '（计入 evidenceIncomplete，不判失败）');
          continue;
        }
        // ⑤ **撞到登录墙就地补登一次**（2026-10-10 加，默认关：`--relogin-on-wall`）。
        //
        // 补的是一个**结构性缺口**：整轮唯一会去登的地方是分批开跑**之前**那一次
        // `login-preflight`（`scripts/run-batches.mjs` 写死 `login: true`），而那是一次性的 ——
        // 会话在它之后掉线（2026-10-08 网林天猫：07:34 判 `ALL_IN`、07:36:57 就落登录墙），
        // 余下 11 步里**没有任何一步会回头看登录态** ⇒ 一份存好的密码从头到尾没被调用过。
        //
        // 落点刻意在**这一家自己的链里**（不是整轮一次）：掉登录是**店级**事实，
        // 而且只有走到这一步才知道「是哪个站点掉的」。重试的是**同一步**（`stage`），
        // 成功就顺着 `for` 继续往下 —— 不另起一轮、不重跑已经成功的步骤
        //（重跑会重复下载、重复提交，都是白付的代价）。
        //
        // 三条硬约束：
        //   · **每家店每轮最多一次**（`reloginUsed`）：登录提交是账号动作，反复试会锁号。
        //   · `--notify off`：告警出口由链自己那一个统一决定（见 `reloginShop`）。
        //   · 补登没成**一个字段都不改**：照旧走下面那条失败路径，分诊与告警口径原样不变。
        //
        // 判据取自**页签自己的 URL**（只读 `/targets`），不是从人话里猜 —— 阶段自己的
        // stdout/stderr 里往往一个字都没有那个 URL（2026-10-08 的第 2 步只报
        // `alimama: state did not settle to <日期>`）。判据本体＝`loginWallOf`（唯一来源）。
        if (result.status !== 0 && args.reloginOnWall && !reloginUsed) {
          const siteHint = reloginSiteForStage(stage.stage);
          let wall = await readLoginWallViaProxy({
            proxy: `http://127.0.0.1:${shopInstance(key).proxyPort}`,
          });
          let wallSource = wall ? 'tab-url' : null;
          // 2026-10-18 加：URL 判据认不出、但**页面内容**已经变成「页面不存在或无权访问」时，
          // 会话照样是掉了 —— 那一页是阿里妈妈的兜底页（同一 URL 换内容），`loggedOut` 正则
          // （`login/index`/`member/login`/`login.htm`）永远命中不了它。
          // 实测两次（2026-10-04 盖文天猫、2026-10-18 里可林淘宝），两次都是补登一次就好。
          //
          // 只补一次**只读探针**，不凭页面文案直接补登：真·子账号场景权限墙（2026-09-21 科塔那次）
          // 页面文案一模一样，直连补登会把它当掉登录反复试、锁号。探针的 `verdict` 是唯一分叉点。
          if (decideReloginAttempt({ status: result.status, reloginOnWall: args.reloginOnWall,
            reloginUsed, wall, siteHint }) === 'probe') {
            const probed = probeSiteSession({ shopKey: key, site: siteHint });
            record.reloginProbe = {
              site: siteHint,
              ok: probed.ok,
              verdict: probed.receipt?.verdict ?? null,
              loggedIn: probed.receipt?.sites?.[siteHint]?.loggedIn ?? null,
              href: probed.receipt?.sites?.[siteHint]?.href ?? null,
              exitCode: probed.exitCode ?? null,
              error: probed.error ?? null,
            };
            if (probed.ok) {
              wall = reloginWallFromProbe({ receipt: probed.receipt, site: siteHint });
              wallSource = wall ? 'read-only-probe' : null;
            }
            console.error(`[${key}]   这一页不是登录页 URL（判不出登录墙）⇒ 只读探针 ${siteHint}：`
              + `verdict=${record.reloginProbe.verdict ?? '未知'}`
              + `，loggedIn=${record.reloginProbe.loggedIn ?? '未知'}`
              + `（${wall ? '判为掉会话，补登一次' : '不补登，按既有失败路径处理'}）`);
          }
          if (wall) {
            reloginUsed = true;
            console.error(`[${key}]   ⚠️ 第 ${stage.stage} 步失败，且页面停在 ${wall.site} 的登录墙上`
              + ' —— 就地补登一次（每家店每轮只此一次）');
            record.relogin = reloginShop({ shopKey: key, wall, logDir: shopLogDir });
            // 这一次补登是**怎么判出来的**（`tab-url`＝页签 URL 命中登录墙；`read-only-probe`＝
            // URL 认不出、只读探针判出掉会话）。事后复盘「为什么这次补登了／没补登」只认它。
            record.relogin.source = wallSource;
            if (record.relogin.ok) {
              const retried = await run({ ...stage, argv });
              record.relogin.retry = { stage: stage.stage, status: retried.status ?? null };
              if (retried.status === 0) {
                result = retried;
                console.log(`[${key}]   ✅ 补登成功，重试第 ${stage.stage} 步通过 —— 这一家继续往下跑`);
              } else {
                console.error(`[${key}]   补登成功但重试第 ${stage.stage} 步仍失败（exit ${retried.status}）`);
              }
            } else {
              console.error(`[${key}]   补登没成（${record.relogin.verdict ?? record.relogin.error ?? '未说明'}）`
                + ' —— 按既有失败路径处理');
            }
          }
        }
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
        // 采集段产物路径的回填**已移到 `run()` 里**（2026-10-11）：放在这里的话，
        // 「自修救回后重试」那条路（走 `runNamedStage` → `run()`，不经本循环体）不回填，
        // 续跑到 push 时 `withSourcePaths` 会收到「只有 --shop-xlsx」并抛错、打断整批链。
        // 单一实现在 `run()`，首跑与重试共用。
      }
    };
    const run = async (stage) => {
      index += 1;
      const withIndex = { ...stage, index };
      if (!stageSelected(args.only, stage.stage)) {
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
        // 拦截项的**编号**也要留（2026-10-07 加）：`blockingDetails` 只有人话，而
        // `shopFailureCause` 要按编号分流（`TARGET_PAGE_LOGIN_WALL` ⇒ 下一步是登录而不是补页）。
        // 只看人话就得在归因处再猜一次措辞 —— 本项目在 `.includes('…')` 上吃过的亏已经够多。
        blockingCodes: result.detail?.blocking?.map((finding) => finding.code) ?? null,
        // 体检那一支的归位结论（别的阶段是 null）：它回答「这次的不齐是本来就坏、还是脚本修好的」。
        pageNormalize: result.normalize?.verdict?.detail ?? null });
      // 采集段产物路径的**唯一回填点**（2026-10-11 移到这里，缺陷 ㊱ 续跑改造的接线缺口）：
      // 首跑（runStagesFrom）与自修救回后的重试（runNamedStage）都经过 `run()`，
      // 两处共用同一实现、不会再漂开。原先只长在 runStagesFrom 的循环体里 ⇒ 重试
      // promotion-fetch 成功后 `record.source.promotionZip` 仍是空 ⇒ 续跑到 push 时
      // `withSourcePaths` 收到「只有 --shop-xlsx」抛错，把整批链打断（2026-10-11 11:33 那轮）。
      // 只在**这一步真的成功且没被 `--only` 跳过**时回填 —— 失败/跳过都没有产物路径可记。
      if (!result.skipped && result.status === 0) {
        if (stage.stage === 'shop-report') {
          record.source.shopXlsx = findPath(result.stdout, 'shopXlsxPath');
          if (record.source.shopXlsx) {
            record.source.shopReportManifest = path.join(shopLogDir, 'shop-report-manifest.json');
            writeDownloadManifest({ outputPath: record.source.shopReportManifest, filePath: record.source.shopXlsx,
              reportType: 'shop-report', date: args.date, shop: key, member: shopIdentity(key).alimamaMemberName });
            console.log(`[${key}]   店铺工作簿 = ${record.source.shopXlsx}`);
          }
        }
        if (stage.stage === 'promotion-fetch') {
          record.source.promotionZip = findPath(result.stdout, 'promotionZipPath');
          if (record.source.promotionZip) {
            record.source.promotionManifest = path.join(shopLogDir, 'promotion-report-manifest.json');
            writeDownloadManifest({ outputPath: record.source.promotionManifest, filePath: record.source.promotionZip,
              reportType: 'promotion-report', date: args.date, shop: key, member: shopIdentity(key).alimamaMemberName });
            console.log(`[${key}]   推广 zip = ${record.source.promotionZip}`);
          }
        }
      }
      return result;
    };
    // 按**名字**重跑一个阶段（自动修复用）。找不到就如实报，不猜一个阶段出来跑。
    // 名字比对用 `stage.stage`（闭集里那 11 个），不用下标 —— 下标会在阶段表变化时静默指错。
    const runNamedStage = async (name) => {
      const stage = stages.find((s) => s.stage === name);
      if (!stage) {
        console.error(`[${key}] 自动修复要重试 ${name}，但这一家的阶段表里没有这一步 —— 不猜，停手`);
        return { status: 1, skipped: true, why: `阶段表里没有 ${name}` };
      }
      // push 阶段的源文件路径要照旧填上（与首跑同一份 argv）。
      let argv = stage.argv;
      if (stage.stage === 'push') {
        argv = withSourcePaths(stage.argv, explicitSources.shopXlsx
          ? explicitSources
          : { shopXlsx: record.source.shopXlsx, promotionZip: record.source.promotionZip });
      }
      return run({ ...stage, argv });
    };
    // 修复动作的执行器：把「挑好的动作」交给 repair-shop-stage 的**纯函数**执行，
    // 在这一层注入而不是在驱动里再 spawn 一次子进程（多一层子进程 = 多一种静默失败）。
    //
    // ⚠️ `cause` 必须**原样转下去**（2026-10-02 修）：`applyRepairAction` 内部用
    //   `planRepair({ cause, stage, state })` 反查 `STAGE_PAGE_HINT`，拿到 `stageHint` 才能
    //   定位「该修哪一页」。原先这里把 `cause` 漏了（上游 `executeRepairCandidate` 已经
    //   把 `cause` 传进来了，见本文件 `cause: req?.cause ?? null`）⇒ `REPAIR_TABLE[undefined]`
    //   恒为 undefined ⇒ `stageHint` 恒为 null ⇒ 每个 `非 RESET_PAGES` 的动作都报
    //   「找不到要修的那一页：没有阶段页提示、且窗口里有 N 个页签 ⇒ 不猜要修哪一页」，
    //   自动修复因此**只剩 RESET_PAGES 一个候选能用**（2026-10-01 目标日 10-01 那轮三家店
    //   的 `autoRepair.rounds[].detail` 逐字相同，都卡在这一句）。
    const execRepair = async ({ shopKey, stage, cause, action, log }) => {
      // 2026-10-14：**按阶段选实例**。原先恒取这家店自己的代理 ⇒ `readback` 失败的自动修复
      // 会去动店铺实例（10-13 实测：动作落在店铺标识页上，`applied:true` 而目标页纹丝没动）。
      const proxy = proxyForStage({ stage, shopKey });
      const { applyRepairAction } = await import('./repair-shop-stage.mjs');
      const out = await applyRepairAction(
        { shop: shopKey, proxy, stage, cause, action, logDir: shopLogDir },
        // ⚠️ 契约以 `applyRepairAction` 为准：它调的是 `readTargets(args)`（传**整个 args
        //   对象**）并读回 `{ ok, targets, error }`（见 repair-shop-stage.mjs:294）。
        //   2026-09-29 真机排练实测到的坑：原先这里抄的是 `captureFailureState` 的注入形状
        //   ——`(base) => proxyJson(\`${base}/targets\`)`，其中 `base` 是**代理地址字符串**。
        //   两种同名函数、两种契约，抄错了不会报错：`readTargets` 拿到的是 `[object Object]`，
        //   拼出 `[object Object]/targets` ⇒ 每个非 `RESET_PAGES` 的动作都报
        //   「读不到页签（代理连不上）」、退 3，而 `RESET_PAGES` 因为不读页签反而「正常」。
        //   ⇒ 修复层看起来修好了（有动作执行），实际只有第一个候选能用。
        //   正确写法（2026-09-29 真机排练复验：RELOAD_PAGE / DISMISS_OVERLAYS 都能定位到页）：
        //   注意第二个参数是一个**完整对象** `{ readTargets, log }`；`readTargets` 收到的是
        //   **整个 args 对象**（`a.proxy` 才是代理地址），不是代理地址字符串。
        {
          readTargets: async (a) => {
            try {
              return { ok: true, targets: await proxyJson(`${a.proxy}/targets`), error: null };
            } catch (error) {
              return { ok: false, targets: null, error: String(error?.message ?? error) };
            }
          },
          log,
        },
      );
      return out;
    };

    // 「登录墙就地补登」这一家店是否已经用过（2026-10-10 加）。**每家店每轮最多一次** ——
    // 每一次登录提交都是一次账号动作，平台风控看的正是「同一出口 IP 短时间内的登录次数」，
    // 所以这里不是「失败一次试一次」，而是一次性的机会。声明在这一层（而不是 try 里面）
    // 是为了让它在整条店铺链上只有一个实例。
    let reloginUsed = false;

    // 「这一家失败了」的登记动作：**现场事实**（感知层）+ **修复请求单**。抽成函数是为了让两条
    // 失败路径走同一份实现 —— ① 首跑就失败（下面那个 catch 的入口）；② 自修救回后、**续跑段又失败**
    //（2026-10-16 ㊷）。两处各抄一份的话迟早漂开 —— 本仓已因此吃过 ㊲ 那次亏：单子上的成因与告警里
    // 的成因不是同一个。
    //
    // ⚠️ 约定：**它永不向外抛**。两个调用点都在 catch 块体内，而 catch 块体内再抛没有第二层接住
    //    —— 异常会穿透 `main()`，把整批链打死（2026-10-16 实证，见续跑段那一段的注释）。
    //    内部自带兜底：失败只记 `record.failureBookkeepingError`，主线失败原因一个字不改。
    const settleShopFailure = async (error) => {
      try {
        // ① 先把**页面当时长什么样**落成事实（感知层，2026-09-28 加）。
        //    顺序**必须**在 recoverFailedShop 之前：回位会把页面导航走，
        //    那一刻的 DOM/截图就没了 —— 而它正是「符号 → 事实」翻译的唯一原料。
        //    本调用**永不抛**（见 failure-perception 的三条纪律），所以它不会盖掉上面那个错；
        //    它失败只会在 record 里留下 `perception.errors`，主线失败原因一个字不改。
        record.perception = await captureFailureState({
          proxy: `http://127.0.0.1:${shopInstance(key).proxyPort}`,
          logDir: shopLogDir,
          shopKey: key,
          stage: record.failedStage ?? null,
          // 该拍哪一站的页（2026-10-13 加）。不传的话感知层恒取「第一个非 about 页签」，
          // 而店铺实例的第一个是**店铺标识页** ⇒ 现场拍错页、`ok:true`、内容却与出事那一页无关
          // （实证 evidence/batches-2026-10-10/b1/里可林淘宝/98-failure-state.txt）。
          // STAGE_PAGE_HINT 是「这一步的页面在哪一站」的唯一来源（repair-actions.mjs），
          // 认不出来的阶段给 null ⇒ 感知层退回历史行为，不会比现在更差。
          pageHint: STAGE_PAGE_HINT[record.failedStage] ?? null,
          error: error.message,
          readTargets: (base) => proxyJson(`${base}/targets`),
          evalInPage: (base, targetId, expression) => proxyJson(
            `${base}/eval?target=${encodeURIComponent(targetId)}`, { method: 'POST', body: expression },
          ),
          screenshot: async (base, targetId, file) => {
            const payload = await proxyJson(`${base}/screenshot?target=${encodeURIComponent(targetId)}`
              + `&file=${encodeURIComponent(file)}`);
            return payload.saved;
          },
        });
        // ③ 把「这次失败该怎么修」写成一份**给人/给 agent 看的修复请求单**（2026-09-29 加）。
        //    它把前面两份原料合起来：
        //      · 感知层给的事实（刚才落盘的 98-failure-state.json 内容，这里内联一份摘要）；
        //      · 分诊表给的方向 + 修复表给的候选动作（planRepair 的菜单）。
        //    **它只写文件、不做任何动作** —— 执行是 `repair-shop-stage.mjs` 的事，
        //    判断（挑哪个候选）是 agent 的事。默认不自动执行，所以这一行不改变任何既有失败语义。
        //    顺序在这里（感知之后、回位之前）：回位会把页面导航走，那之后现场事实就对不上了，
        //    而修复请求单要引用的正是「失败那一刻的现场」。
        record.repairRequest = buildRepairRequest({
          shopKey: key, stage: record.failedStage ?? null, error: error.message,
          // ⚠️ 必须把 `record.failureOutput`（含子进程 stderr）也传下去：归类要看的标记
          //   （`BLOCKED_BY_OVERLAY` 等）只活在 stderr 里，不在 `error.message` 里。
          //   2026-10-10 补跑实测：漏传这一个参数 ⇒ 单子上的成因与告警里的成因不是同一个（㊲ 白修）。
          failureOutput: record.failureOutput ?? null,
          perception: record.perception, logDir: shopLogDir,
        });
      } catch (bookkeepingError) {
        record.failureBookkeepingError = String(bookkeepingError?.message ?? bookkeepingError);
        console.error(`[${key}]   ⚠️ 失败登记本身出错（${record.failureBookkeepingError}）`
          + ' —— 照旧按失败收尾，不猜、也不向外抛');
      }
    };

    try {
      await runStagesFrom(stages);
      record.status = 'ok';
    } catch (error) {
      record.error = error.message;
      console.error(`[${key}] 停在这一步：${error.message}`);
      // ① 现场事实 + ③ 修复请求单：与「续跑段再失败」那条路径共用同一份实现。
      await settleShopFailure(error);
      // ④ **agent 修复回环**（2026-09-29 加，默认关）：按请求单挑一个候选动作 → 执行 → 重试该阶段。
      //
      //   位置刻意在这里（请求单之后、回位之前）：修复要动的是**失败那一刻的页面**，
      //   而回位会把它导航走 —— 放到回位之后，修的就不是那个坏页面了。
      //
      //   走通时它会改 `record`：`status` 翻回 ok、清掉 failedStage —— 因为「修好了」这件事
      //   必须对后面的分诊与告警都成立，否则会出现「其实修好了、但照样叫人」的假红。
      //   没走通（或没开）时它一个字段都不改，主线失败语义原样保留。
      if (args.autoRepair && args.autoRepairMaxRounds > 0) {
        const loop = await autoRepairAndRetry({
          shopKey: key, logDir: shopLogDir, req: record.repairRequest,
          maxRounds: args.autoRepairMaxRounds,
          runStage: runNamedStage,
          exec: execRepair,
          log: (line) => console.log(`[${key}]   ${line}`),
        });
        record.autoRepair = loop;
        if (loop.rescued) {
          // 救回来了：这一家不再是失败态。`stages` 里那几条失败记录**留着**（它们是事实），
          // 但 overall 状态按成功算 —— 这正是「修完再试」与「重试」的区别所在。
          //
          // ⚠️ **必须续跑失败那一步之后的余下阶段**（2026-10-10 修缺陷 ㊱）。
          //
          // 旧实现到这里就 `console.log('…按成功收尾')` 然后 `continue` 了 —— 只重试了
          // 失败的那一步（`autoRepairAndRetry` 内部跑的），**第 N+1..11 步一步都没跑**，
          // 而 `record.status` 已经是 `ok`。于是一整轮「跑完、退出码 0、汇总全 ok」，
          // 底单里却**静默缺行**：2026-10-09 那轮 `盖文淘宝` 在第 4 步被救回（后面 5-11 全没跑）、
          // `网林家居` 在第 2 步被救回（后面 3-11 全没跑），两家都没有 `07-push` 产物、
          // 底单里也没有它们那一行 —— 而 `summary.json` 两家都是 `status=ok`。
          // 更糟的是 `escalation-plan.mjs` 只收 `status!=='ok'` ⇒ 连派单也收不到，
          // 这个缺口对整条三层降级链是**完全隐形**的。
          //
          // 修法：救回后**不原样重放已成功的步骤**，而是从失败那一步的**下一步**接着跑到第 11 步。
          // 判据是 `retryStage`（＝`req.retryStage`，与 `autoRepairAndRetry` 里重试的那一步同源）——
          // 在 `stages` 里按**阶段名**定位下标（不用固定数字，阶段表变了也不会指错）。
          // 这一段与首跑共用同一个 `runStagesFrom`，`--only` 跳过、push 源产物守卫、
          // 登录墙补登、exit 4、失败抛错等判据两处不会漂开。
          const rescuedFrom = record.failedStage ?? null;
          const retryStageName = record.repairRequest?.retryStage
            ?? record.repairRequest?.stage ?? rescuedFrom;
          record.status = 'ok';
          record.rescuedFrom = rescuedFrom;
          record.rescuedBy = loop.rounds.at(-1)?.action ?? null;
          delete record.failedStage;
          delete record.error;
          console.log(`[${key}]   ✅ 自动修复后重试成功（${record.rescuedBy}）—— 接着从下一步跑完余下阶段`);
          const resumeAt = stages.findIndex((s) => s.stage === retryStageName);
          if (resumeAt < 0) {
            // 认不出失败那一步在阶段表里的位置 ⇒ 不猜一个下标出来跑（猜错会漏跑或多跑）。
            // 如实留痕并把这家的续跑标记成未完成 —— 上面的 `status='ok'` 保持不变
            //（失败那一步确实被救回了），但这一条缺口**必须可查**，不能再静默。
            record.rescueResume = { from: retryStageName, ran: [], error:
              `阶段表里找不到 ${retryStageName}，不猜续跑起点` };
            console.error(`[${key}]   ⚠️ 续跑起点 ${retryStageName} 在阶段表里找不到 —— 不猜，续跑这一步留痕不执行`);
          } else {
            const resumeStages = stages.slice(resumeAt + 1);
            const before = record.stages.length;
            // ⚠️ 这一段**必须自己接住**（2026-10-16 修缺陷 ㊷）。原注释「续跑段自己抛错就照旧走失败
            //    路径（下面那个 catch）」写错了：**这里已经在那个 catch 体内**，再抛没有第二层接住。
            //    异常会穿透 `main()`（顶层 `await main()` 没有 catch），把**整批链**打死。
            //    2026-10-15 真机实证（`evidence/batches-2026-10-15/batches.log`）：
            //      · b1 崩在 盖文淘宝 续跑段的 `shop-report` ⇒ 同批的 盖文天猫／科塔淘宝 **一步都没跑**；
            //      · b2 崩在 网林淘宝 续跑段的 `readback` ⇒ 里可林天猫／网林家居 **一步都没跑**；
            //      · 而且 `summary.json` 一个字都没写 ⇒ 释放判定读不到失败（判成「没人需要看现场」
            //        照旧释放）、`escalation-plan.mjs` 退 1 读不到结论（三层降级第 1 步直接瞎掉）。
            //    语义**不变**：续跑里再失败就是这一家真失败（`failedStage` 由 `runStagesFrom` 重新写上），
            //    只是失败只带走这一家、不带走整批。
            try {
              await runStagesFrom(resumeStages);
              record.rescueResume = {
                from: retryStageName,
                ran: record.stages.slice(before).map((entry) => entry.stage),
              };
              console.log(`[${key}]   续跑完成：${record.rescueResume.ran.join('、') || '（没有余下阶段）'}`);
            } catch (resumeError) {
              record.status = 'failed';
              record.error = resumeError.message;
              record.rescueResume = {
                from: retryStageName,
                ran: record.stages.slice(before).map((entry) => entry.stage),
                error: resumeError.message,
              };
              console.error(`[${key}]   ⚠️ 救回后的续跑段又失败（${resumeError.message}）`
                + ' —— 这一家按失败收尾；**本批其余店照常跑**（㊷：这里再抛会打死整批）');
              // 现场事实与修复请求单按**续跑段那个**失败重做一遍：否则单子指的是已经被修好的那一步，
              // 第 2 层 agent 会照着错的方向修。
              await settleShopFailure(resumeError);
            }
          }
        } else {
          console.log(`[${key}]   自动修复没救回来：${loop.gaveUp ?? loop.error ?? '未说明'}`);
        }
      }
      // ② 再收尾：把「停手时页面停在哪」记下来，再把它送回中性态（证据先于处置，
      // 见 recoverFailedShop 的三条纪律）。位置**刻意放在「停整轮」之前** —— 放到之后的话，
      // 默认策略下断掉整个 for 循环，而唯一失败的那一家恰恰就是不会被收尾的那一家。
      //
      // ⚠️ **只在真的还是失败态时收尾**（2026-10-10，缺陷 ㊱ 的续跑改造带来的边界）：
      //    自修救回并续跑成功之后，这一家已经是 `ok` —— 既没有「停手时页面」需要回位，
      //    也不该被 `--stop-on-first-failure` 判成失败而停整轮。判据用 `status !== 'ok'`，
      //    与上面那一支（失败态才置 `failed`／被救回才置 `ok`）是同一个字段，不另立判据。
      if (record.status !== 'ok') {
        record.recovery = await recoverFailedShop({ shopKey: key, logDir: shopLogDir, repoRoot: REPO_ROOT });
      }
      // 一家店失败之后要不要继续跑其余店。**2026-09-25 把默认值翻了**（旧默认＝停整轮）。
      //
      // 旧默认的理由是「出了问题就别继续写」，但实测下来它的代价远大于收益：
      //   ① 每一家店的采集/推送都是**独立的** —— 各自的浏览器实例、各自的账号、各自那几行飞书。
      //      一家失败不会让别家的数据变得不干净（每家的写都自带回读核对）。
      //   ② 实测形态（`evidence/daily-job-2026-09-24/job.log`，当天四轮全都是这个形状）：
      //      里可林停在 `alimama-date`、或停在 `push` ⇒ **停整轮** ⇒ 另外四家一步都没跑
      //      ⇒ 那天只写进 0~1 家，而它们本来都是能成的。一处已知的单店缺陷（缺陷⑤：
      //      网林停在第 6 步）就这样被放大成「一整天的数据都没有」。
      //   ③ 继续跑不会让失败变安静：轮末照旧 `anyFailed` ⇒ 退出码 1 ＋ 一条**点名到店**的告警
      //      （文案见 buildRoundFailureAlert）。失败该报还是报，只是不再连坐。
      // 所以默认改成「一家失败不带走其余」；要退回旧行为用显式的 `--stop-on-first-failure`。
      // 「救回并续跑成功」不是失败 ⇒ 不触发停整轮（判据同上，用 `status !== 'ok'`）。
      if (args.stopOnFirstFailure && record.status !== 'ok') {
        console.error(`[驱动] --stop-on-first-failure：停整轮（默认是继续跑其余店）。已跑的店记在 ${path.relative(REPO_ROOT, logRoot)}。`);
        break;
      }
    }
  }

  summary.finishedAt = new Date().toISOString();
  // 统一字段并写＋写入时校验（迁移第 2 步）：shop/evidence/failureClass/noActionRequired/
  // autoRepair.attempted 在这里物化——所有店都已收尾，此刻的记录就是终态。
  applyUnifiedSummaryFields(summary, { logRoot });
  warnSummarySchemaViolations(summary, '正常收尾');
  const summaryPath = path.join(logRoot, 'summary.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log('\n[驱动] 汇总：');
  for (const [key, record] of Object.entries(summary.shops)) {
    console.log(`  ${key}：${record.status}${record.failedStage ? `（停在 ${record.failedStage}）` : ''}`
      + `${record.error ? ` —— ${record.error}` : ''}`);
  }
  console.log(`[驱动] 明细 ${path.relative(REPO_ROOT, summaryPath)}`);
  const anyFailed = Object.values(summary.shops).some((r) => r.status !== 'ok'
    && !isWaitingOperatorAccountStatus(r));

  // 分诊（2026-09-28）：把失败按「已知问题表」分堆，只对**要人**的那堆叫人。
  // 这一步是「注意力真正被释放」的地方 —— 不是替人做事，而是替人挡掉不需要他看的事。
  // 典型收益：`DUPLICATE_TARGET`（同一天已经写过了）过去每天都会把人叫起来，
  // 而正确处置是「不用做任何事」。它现在进 `silent` 堆，不再打扰。
  //
  // 安全方向（fail-closed）：**只有整批失败全部落在 silent 堆时才不发告警**。
  // 只要有一家需要人，照旧发、且文案里仍然点名到店。未登记的成因会被
  // `lookupRemediation` 判成 `human` ⇒ 新问题永远叫得到人（这是这张表的安全底座）。
  const triage = anyFailed
    ? triageFailures(roundFailureSummary(summary, { loginPreflight }).failed)
    : null;

  // ⑨b：告警闸门的第二道 —— 「先让 agent 试一下，再叫人」（默认关，见 parseArgs 里那条注释）。
  // 「需要人」的那一档才问这个；整批已知不需要人时，上面那一支已经处理掉了。
  const deferral = planAlertDeferral({
    summary, summaryPath, loginPreflight, enabled: args.deferAgentActionableAlert,
  });

  if (anyFailed) {
    process.exitCode = 1;
    // 如实打印分诊结论（无论发不发告警都要有这一行）：否则「没收到消息」与
    // 「消息没发出去」在事后看起来一模一样 —— 这条链反复强调的一件事。
    if (triage) {
      console.log(`[驱动] 分诊：${triage.total} 处失败 —— 需人 ${triage.needsHumanCount} 处`
        + `${triage.needsHuman.length ? `（${triage.needsHuman.map((r) => `${r.key}@${r.plan.cause}`).join('、')}）` : ''}`
        + `；不需要人 ${triage.silentCount} 处`
        + `${triage.silent.length ? `（${triage.silent.map((r) => `${r.key}@${r.plan.cause}`).join('、')}）` : ''}`);
    }
    if (triage && triage.needsHumanCount === 0) {
      // 整批都不需要人 ⇒ **不发打扰**。仍然留一行日志说明为什么没发（供事后核对）。
      console.log(`[驱动] 没发提醒：${triage.total} 处失败全都落在「已知、不需要人」里`
        + `（${triage.silent.map((r) => `${r.key}@${r.plan.cause}`).join('、')}）。`);
    } else if (deferral.defer) {
      // ⑨b：这一整批失败都「agent 能救」。此刻叫人 = 跳过了三层降级的第②层。
      // 不发飞书，改把派单落盘（会话侧照着它派后台修复 agent）。
      const handoffPath = path.join(logRoot, 'escalation-handoff.json');
      writeFileSync(handoffPath, `${JSON.stringify({
        date: args.date, createdAt: new Date().toISOString(),
        note: '链级告警被闸门拦下：本批失败全部「agent 能救」⇒ 先派修复 agent，不先叫人。',
        escalatedBy: 'run-multi-shop-day.mjs --defer-agent-actionable-alert', targets: deferral.targets,
      }, null, 2)}\n`, 'utf8');
      console.log(`[驱动] 没发提醒：${deferral.targets.length} 处失败全都「agent 能救」`
        + `（${deferral.targets.map((t) => `${t.shop}@${t.cause ?? '?'}`).join('、')}）`
        + ` ⇒ 按三层降级的第②层交给修复 agent，不先叫人。`);
      console.log(`[驱动] 派单已落盘：${path.relative(REPO_ROOT, handoffPath)}`
        + '（会话侧照它派后台修复 agent；agent 也修不动才发飞书）');
    } else if (alertDispatch.action !== 'off') {
      dispatchRoundAlert({
        alert: buildRoundFailureAlert({ date: args.date, summary, shopKeys: shops, loginPreflight,
          willResume: args.willResume, tech: roundTechBlock({ summary, logRoot }) }),
        dispatch: alertDispatch, logDir: path.relative(REPO_ROOT, logRoot),
      });
    } else if (args.notify || args.notifyPrint) {
      console.log(`[驱动] 没发提醒：${alertDispatch.why}`);
    }
  } else if (args.notify || args.notifyPrint) {
    // 成功要留一行「没发提醒」：否则「没收到消息」与「消息没发出去」在事后看起来一模一样。
    const waiting = Object.entries(summary.shops)
      .filter(([, record]) => isWaitingOperatorAccountStatus(record)).map(([key]) => key);
    console.log(waiting.length
      ? `[驱动] ${shops.length - waiting.length} 家店收完，${waiting.length} 家等待运营账号（${waiting.join('、')}），没发提醒。`
      : `[驱动] ${shops.length} 家店都收完了，没发提醒（--notify 只在出错时叫人）。`);
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
      // 「目标页 0 命中」要能分清「页面真的缺」与「掉登录被踢到登录页」——
      // 判据由调用方注入（站点登录页形态住在 login-merchant-core 的 SITES 里，是唯一来源）。
      isLoginWall: makeLoginWallFinder(),
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
