#!/usr/bin/env node
//
// 采集段第 2 步：阿里妈妈「营销场景报表」—— 两个阶段。
//
//   --phase submit  报表页滚到底 → 点「下载报表」→ 弹窗点「确定」（提交一个下载任务）
//   --phase fetch   下载任务管理 → 认出新任务那一行的「下载」→ 点它，等文件落到磁盘
//
// 为什么要分两阶段（2026-09-17）：平台侧提示「数据量大时最长 10 分钟」，提交完要等它生成。
// 分成两条命令，中间那段等待就可以拿去干别的（演示里正好用来做店铺报表那一步），
// 而不是把一段死等塞在流程中间。
//
// 点击逻辑与 2026-09-17 现场脚本逐条一致，只把日期/任务名/目录变成参数。
// 取件那一步的模型在 2026-09-17 被**推翻重写过一次**，以现场实测为准（细节见 collect-core 的
// `downloadEntryExpression` 上方注释）。三条最容易踩的：
//   ① 下载入口在**文件名那行的下一个 tr**（该行的操作行），而操作行**默认 display:none**，
//      只有该行被激活（真实点它的复选框、并回读 checked=true）才显形；
//   ② 因此不存在「底部操作栏」那条路 —— 那是当时恰好激活的那一行的操作行按钮；
//   ③ 点击前**必须当场重新量矩形**：量到点之间页面会动，差一行（41px）就会点到别的任务的单元格上，
//      `clicked:true` 却什么都不发生，而且不报错。零尺寸矩形一律 fail-closed。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PROJECT_PORTS } from '../../../runtime/browser-ports.mjs';
import {
  PROMOTION_TASK_PATTERN, PROMOTION_ZIP_PATTERN, TASK_DOWNLOAD_MARK, alimamaIdentityExpression,
  assertMemberIdentity, checkboxStateExpression, createOverlayDismisser, defaultDownloadsDir,
  describeEntryMiss, describeHitMiss, describeHitPass, describeOverlayAttempt, downloadEntryExpression,
  hitCheckExpression, listDownloads, newEntries, parseCollectArgs, pickNewest,
  restoreCheckboxesExpression, scrollIntoViewExpression, targetRowExpression,
} from './collect-core.mjs';
// 报表页 URL 形状只有 date-picker 那份实现（含场景编码与归因参数）。路由复位要重新导航到
// 同一个报表页，所以这里**取它**而不是再抄一份 —— 抄一份就会在下次改 URL 时漂移。
import { buildAlimamaUrl } from './date-picker.mjs';
// 推广任务台账（2026-09-21 晚加）：任务名只有导出日、没有目标日 ⇒「取哪一条」不许猜。
// 提交段把「亲眼看它多出来哪一条」记进台账，取件段只取那一笔。见该模块文件头。
import {
  describeStale, judgeFetchTaskName, judgeResume, judgeSubmitOutcome,
  ledgerScope, readLedger, recordConsumed, recordSubmitted, staleFor, writeLedger,
} from './promotion-task-ledger.mjs';

const ALIMAMA_LIST_URL = 'https://one.alimama.com/index.html#!/report/download-list';

// 台账默认落在仓库根的 runtime/ —— 与 alert-throttle.json 同一个位置：它俩都是**跨轮状态**，
// 不是某一轮的产物，所以不放 evidence/（那里按约定是「只读的历史证据」，不做活输入）。
// 可用 --ledger 覆盖（一次性排查、用例各指一个小文件）。
const DEFAULT_LEDGER_FILE = path.resolve(fileURLToPath(new URL('../../../runtime/promotion-task-ledger.json', import.meta.url)));

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function proxyJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status} ${text.slice(0, 160)}`);
  return text;
}

async function evalOn(args, targetId, expression) {
  const payload = JSON.parse(await proxyJson(`${args.proxy}/eval?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: expression }));
  try { return JSON.parse(payload?.value); } catch { return payload?.value; }
}

async function bringToFront(args, targetId) {
  await proxyJson(`${args.proxy}/bringToFront?target=${encodeURIComponent(targetId)}`).catch(() => {});
}

async function click(args, targetId, selector) {
  return proxyJson(`${args.proxy}/click?target=${encodeURIComponent(targetId)}`, { method: 'POST', body: selector });
}

// 真实鼠标点击（CDP 的按下→抬起序列），点位取复核时那个「确实命中自己」的坐标。
// 为什么 fetch 段必须用它：2026-09-17 做了一次干净的对照 —— 先用正确协议激活目标任务行、
// 确认标的元素就是它那个唯一的可见「下载」（rect [136,368,49,24]、全页可见叶子恰 1 个），
// 然后对**同一个元素**先发 JS 的 el.click()（`POST /click` 按选择器）：15 秒没有任何文件落盘；
// 同一元素改用真实鼠标点中心，3 秒落盘。所以这不是「选择器选错了」的假象，是页面只认真实鼠标事件。
// 这条不影响 submit 段：那里的「下载报表」「确定」用 JS 点击是有效的，差别在页面各自怎么实现。
async function clickPoint(args, targetId, point) {
  return proxyJson(`${args.proxy}/clickPoint?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: JSON.stringify({ x: point[0], y: point[1] }) });
}

// 用哪个点：中心点命中就用中心（最不容易擦到边），否则用复核时找到的那个命中点。
function pointOf(hit) {
  const point = hit.centerIsSelf && hit.rect
    ? [Math.round(hit.rect[0] + hit.rect[2] / 2), Math.round(hit.rect[1] + hit.rect[3] / 2)]
    : hit.firstHit;
  // 零尺寸矩形算出来的「中心」是 (0,0)，点下去正好落在页面左上角 —— 实测会把阿里妈妈页
  // 从「下载任务管理」导航到「首页」。复核通过已经隐含 rect 非零，这里再挡一道：
  // 在这一页上「点到了别处」不会报错，只会静默地什么都不发生，最难查。
  if (!Array.isArray(point) || !(point[0] > 0 || point[1] > 0)) {
    throw new Error(`拒绝点击可疑坐标 ${JSON.stringify(point)}（rect=${JSON.stringify(hit.rect)}）`
      + '—— 零尺寸或缺失坐标的点击只会静默落空，甚至点到页面别处');
  }
  return point;
}

async function findAlimamaPage(args) {
  const targets = JSON.parse(await proxyJson(`${args.proxy}/targets`));
  const matches = targets.filter((target) => target.type === 'page'
    && String(target.url).includes('one.alimama.com'));
  if (matches.length !== 1) throw new Error(`expected one alimama page on ${args.proxy}, got ${matches.length}`);
  return matches[0].targetId;
}

// 动手之前先认这一屏是哪个登录（2026-09-18 加）。
// 用户原话：「肯定是要是同一家店铺的数据的，绝对不能串数据」。
// **这一页不显示店铺名**（实测只有「会员名 + 会员ID」，如「随心品质定制:阿彦 ID：887360146」），
// 所以这一侧的判据只能是会员名/会员ID；两个都要对上才算同一个登录（会员名可改、ID 不可改）。
// 为什么必须在这里拦：营销场景报表的 CSV **一个店铺身份字段都没有**（69 列全是场景与指标），
// 取错窗口不会报错 —— 文件照样落盘、数字照样进飞书，事后从产物里查不出来。
async function assertAlimamaIdentity(args, targetId) {
  const identity = await evalOn(args, targetId, alimamaIdentityExpression());
  const check = assertMemberIdentity({
    expectedName: args.expectMember, expectedId: args.expectMemberId, observed: identity,
  });
  console.log(`[身份] 阿里妈妈会员 = ${JSON.stringify(identity.memberName)}`
    + ` ID=${JSON.stringify(identity.memberId)}（这一页不显示店铺名，只有会员名）`
    + (check.checked
      ? `｜期望 ${JSON.stringify(args.expectMember ?? '')}`
        + `${args.expectMemberId ? ` / ${args.expectMemberId}` : ''} ✓`
      : '｜未给 --expect-member：只记录，不拦'));
  return identity;
}

// 点击前一律复核：按钮常在视口外（实测文档坐标 y≈1462），真实鼠标点击会静默落空且不报错
// —— 这是本项目坑 33/44 那一族。
// 判据在 collect-core 里（矩形内是否存在「视口内且命中自己」的采样点），这里只负责调用与报错措辞：
// 2026-09-17 实测过一次误判 —— 元素整个在视口右边界外时，只看中心点会直接判失败。
async function hitCheck(args, targetId, selector) {
  return evalOn(args, targetId, hitCheckExpression(selector));
}

// 平台自己的全屏弹窗压住整页时，**主动关掉再重试复核**（2026-09-19 加）。
// 为什么不并进「等一会儿重试」那一族：那套只对会自己收起的浮层成立，
// 而这一类（全屏 fixed + 五位数 z-index）**稳定复现、等多久都不好** —— 判据见 collect-core 上方长注释。
// 「扫→选→点→回读」的编排、以及「关不掉时不许改变主流程失败方向」那条约束，都在 collect-core 的
// `createOverlayDismisser` 里（用注入的假实现离线测过）；这里只把它接到本脚本的 evalOn/clickPoint 上。
const dismissBlockingOverlay = createOverlayDismisser({
  evalOn: (args, targetId, expression) => evalOn(args, targetId, expression),
  clickPoint: (args, targetId, point) => clickPoint(args, targetId, point),
  delay,
  log: (...parts) => console.log(...parts),
});

// 复核 +「被全屏弹窗挡住就关掉再来一次」。**所有** hitCheck 调用点都走它 ——
// 漏掉某一个阶段，那个阶段就是定时任务半夜挂掉的地方。
// `reLocate` 可选：取件段的入口依赖「该行处于激活态」，而激活态会衰减（实测 15 秒）；
// 关弹窗要花掉一两秒 ⇒ 关完必须**重新定位**再复核，不能拿关之前的坐标直接点。
async function hitCheckDismissingOverlay(args, targetId, selector, reLocate) {
  let hit = await hitCheck(args, targetId, selector);
  if (hit.ok) return hit;
  const attempt = await dismissBlockingOverlay(args, targetId, selector);
  if (!attempt.dismissed) return { ...hit, overlayAttempt: attempt };
  if (reLocate) await reLocate(attempt);
  return { ...(await hitCheck(args, targetId, selector)), overlayAttempt: attempt };
}

// describeOverlayAttempt 在 collect-core 里 —— 两个采集脚本共用同一份措辞，免得越写越不一样。

// ---------------------------------------------------------------- submit 定位与等待

// 定位「下载报表」按钮（叶子节点、文字完全相等），并把文档序第一个标上 data- 属性。
// 抽成函数是为了能被调用两次（正常一次、路由复位后再一次），而不是把同一段表达式抄两遍。
// 导出是给离线用例「真的跑一次」用的 —— 代码即字符串，只做字面比对会漏掉「算不出来」。
export const LOCATE_DOWNLOAD_REPORT_EXPRESSION = `(() => {
  // 同样是 hash 路由：不重载页面，上一轮标过的元素会留在 DOM 里，先清掉。
  document.querySelectorAll('[data-collect-alimama-download]')
    .forEach((el) => el.removeAttribute('data-collect-alimama-download'));
  const candidates = [...document.querySelectorAll('button,a,div,span')]
    .filter((el) => el.children.length === 0 && el.textContent.trim() === '下载报表');
  if (!candidates.length) return JSON.stringify({ found: 0 });
  candidates[0].setAttribute('data-collect-alimama-download', '1');
  const clickable = candidates[0].closest('button,a,[role=button]');
  return JSON.stringify({ found: candidates.length, tag: candidates[0].tagName,
    clickableAncestor: clickable && clickable !== candidates[0] ? clickable.tagName : null });
})()`;

// 弹窗里的候选按钮：文案只认这四个，逐个量矩形并复核「中心点命中自己」。
//
// rect / centerY / viewport 一起报，是 2026-09-20 补的：判据是「中心点落在视口内」，
// 于是「为什么点不着」的唯一可读答案就是这几个数的比较（实测 y=505 而视口高 500）。
// 少了它们，失败信息只剩 visible/hitOk 两个布尔，想还原现场只能另写一个外部探针。
export const DIALOG_BUTTONS_EXPRESSION = `(() => {
  const buttons = [...document.querySelectorAll('button,a,div,span')]
    .filter((el) => el.children.length === 0 && /^(确定|确认|取消|关闭)$/.test(el.textContent.trim()));
  const info = buttons.map((el, i) => {
    el.setAttribute('data-collect-dialog', String(i));
    const r = el.getBoundingClientRect();
    const point = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    return { i, text: el.textContent.trim(),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      centerY: Math.round(r.y + r.height / 2),
      visible: r.width > 0 && r.height > 0 && r.y >= 0 && r.y < window.innerHeight,
      hitOk: !!point && (point === el || el.contains(point) || point.contains(el)) };
  });
  return JSON.stringify({ buttons: info, viewport: [window.innerWidth, window.innerHeight] });
})()`;

/** 视口与候选的**单行**摘要，给日志和报错共用，免得两处措辞漂移。 */
export function describeDialogCandidates(buttons = [], viewport = null) {
  const shape = buttons.map((button) => `${button.text}@${JSON.stringify(button.rect)}`
    + `${button.hitOk ? '可点' : button.visible ? '点不着' : '不在视口内'}`);
  return `视口 ${viewport ? JSON.stringify(viewport) : '?'}｜${shape.length ? shape.join(' ') : '（没有候选）'}`;
}

async function locateDownloadReport(args, targetId) {
  return evalOn(args, targetId, LOCATE_DOWNLOAD_REPORT_EXPRESSION);
}

/**
 * 从弹窗候选里挑出可点的「确定」。
 *
 * 挑两个条件都要：文案恰好是「确定」，且**中心点命中自己**（被浮层盖住的按钮点不动，
 * 而页面不会报错，只表现为点了没反应）。抽成纯函数是为了它可被单独测 —— 这条判据以前
 * 只有一行内联代码，没有任何用例盖住它。
 */
export function pickConfirmButton(buttons = []) {
  return buttons.find((button) => button.text === '确定' && button.hitOk) ?? null;
}

/**
 * 等「确定」出现，最多 attempts 次、每次间隔 intervalMs。
 *
 * 为什么不是「等一个固定秒数再读一次」（2026-09-20 实测，本机五家店 4 家栽在这）：
 * 点「下载报表」→ 弹窗渲染是一段异步过程，冷启动/平台忙时超过 3 秒很常见。当时写的是
 * `await delay(3000)` 后读**一次**，读到空就报「弹窗里没有可点的确定」，而 10 分钟后再看时
 * 那两个弹窗正开着、确定按钮就在 `[259,469,24,12]` —— **判据没问题，是「只等一次」不对**。
 *
 * 第二轮（同日更晚）又栽在同一处：判据仍是「可点」，但「可点」要求**中心点落在视口内**，
 * 而弹窗底栏会落到折叠线以下。所以这一轮的动作是「点不着就把它滚进视口，下一轮按原判据重判」。
 *
 * 导出只为可测：原来这条注释写着「轮询本身没法离线测」——现在可以了。把 evalOn 指向一个假代理、
 * 用它区分「读候选」与「滚进视口」两种请求，就能把「先滚、再重判」整条路径跑一次。
 */
export async function waitForConfirmButton(args, targetId, { attempts = 30, intervalMs = 1000 } = {}) {
  let buttons = [];
  let viewport = null;
  let scrolls = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const dialog = await evalOn(args, targetId, DIALOG_BUTTONS_EXPRESSION);
    buttons = dialog?.buttons ?? [];
    viewport = dialog?.viewport ?? viewport;
    const confirm = pickConfirmButton(buttons);
    if (confirm) return { confirm, buttons, viewport, attempts: attempt, intervalMs, scrolls };
    // 文案对、却点不着 —— 2026-09-20 实测的唯一成因是**中心点落在视口外**：弹窗的固定层是
    // `top:0 height:494 overflow:auto`，而弹窗从 `top:107` 往下长且**没有 clamp**，底栏于是会落到
    // 折叠线以下（实测「确定」rect=[257,505,24,12] 而视口高 500；同一弹窗在另一家店是 y=469 就过得去）。
    // 这里判据没错、按钮也真的在，缺的只是「把它送进视口」这一步 —— 所以先滚，下一轮按**原判据**重判。
    // 不滚就等，只会把「点不着」等成 30 秒超时（这正是那一轮四家店栽的地方）。
    const wanted = buttons.find((button) => button.text === '确定');
    if (wanted) {
      await evalOn(args, targetId, scrollIntoViewExpression(`[data-collect-dialog="${wanted.i}"]`));
      scrolls += 1;
    }
    await delay(intervalMs);
  }
  return { confirm: null, buttons, viewport, attempts, intervalMs, scrolls };
}

/**
 * 弹窗里那个「取消 / 关闭」。
 *
 * 用途不是「放弃提交」（那由抛错决定），而是**清掉上一轮留下的弹窗**：2026-09-20 实测，
 * submit 失败时弹窗会留在页面上（`probe-live/pages-now.txt` 里盖文淘宝/科塔淘宝两页各挂着一个），
 * 而阿里妈妈是 hash 路由 ⇒「再导航到同一个报表 URL」不重载页面、弹窗一直在。
 * 点它没有任何对外副作用（就是取消这次下载弹窗），所以放在「动手之前」是安全的。
 *
 * 关于「残留弹窗到底会坏掉什么」——只写**核对过**的，别把它写成结论：
 * 已核：弹窗体（`dialog-body`）里带一个自己的「日期范围 昨日」，于是同页会出现**两个**「昨日」
 *       （实测 rect=[347,206,246,30] 那个在弹窗内、命中自己=true）。
 * 未核：它是否真能让 `date-picker --site alimama` 判 `date trigger ambiguous` 而停。读侧只认
 *       `.mx-trigger`，我没有证据证明弹窗里那个「昨日」是 `.mx-trigger`；而且
 *       `evidence/` 全目录里 `alimama date trigger ambiguous` 与 `state did not settle` **零命中**
 *       —— 2026-09-20 五家店的 date 阶段全部 exit=0 / APPLIED，从没因它停过。
 *       ⇒ 不删这个清理动作（代价低、无副作用），但也别拿它当已知故障的原因。
 */
export function pickCancelButton(buttons = []) {
  return buttons.find((button) => (button.text === '取消' || button.text === '关闭') && button.hitOk) ?? null;
}

/** 开跑前把上一轮留下的弹窗关掉。没有弹窗就是一次空操作（不打印、不改状态）。 */
async function clearLeftoverDialog(args, targetId) {
  const buttons = (await evalOn(args, targetId, DIALOG_BUTTONS_EXPRESSION))?.buttons ?? [];
  const cancel = pickCancelButton(buttons);
  if (!cancel) return { cleared: false, buttons };
  console.log(`[submit] 页面上有上一轮留下的弹窗（候选 ${JSON.stringify(buttons.map((b) => b.text))}）`
    + ` → 先点「${cancel.text}」关掉它，再走正常流程`);
  await click(args, targetId, `[data-collect-dialog="${cancel.i}"]`);
  await delay(1500);
  return { cleared: true, buttons };
}

/**
 * 路由复位：先回首页、再进目标报表 URL。
 *
 * 2026-09-20 实测（网林天猫）：SPA 会停在「没有下载报表」的降级视图上（正文 1828 字符），
 * 把同一个报表 URL 再导航一遍也不恢复 —— 实测 40 秒都不出按钮；而「回首页 → 再进报表 URL」
 * 2 秒内就正常了（正文 1828 → 5314 → 2408 字符）。
 * ⇒ 「找不到按钮」有两种成因：页面还没渲染完（等即可），以及路由停在了别处（等没用）。
 * 复位 URL 由 date-picker 的 buildAlimamaUrl 生成，不在这里另抄一份 URL 形状。
 */
async function resetReportRoute(args, targetId) {
  await navigateTo(args, targetId, 'https://one.alimama.com/index.html');
  await delay(2500);
  await navigateTo(args, targetId, buildAlimamaUrl({ requested: args.date }));
  await delay(2500);
}

async function navigateTo(args, targetId, url) {
  return proxyJson(`${args.proxy}/navigate?target=${encodeURIComponent(targetId)}&url=${encodeURIComponent(url)}`,
    { method: 'POST', body: '' });
}

/**
 * 诊断用：当前页的 URL 与正文长度。
 *
 * 正文长度是区分两种「找不到下载报表」的**当场证据**（2026-09-20 实测本机五家店）：
 * 降级视图只有 ~1828 字符（页框在、正文是空的），正常报表页 ~2408，回首页后 ~5314。
 * 只报 URL 不够 —— 降级视图的 URL 与正常页**一模一样**（同一个 hash 路由，参数都在）。
 */
async function reportPageState(args, targetId) {
  return evalOn(args, targetId, `(() => JSON.stringify({
    href: location.href,
    textLen: (document.body.innerText || '').length,
  }))()`);
}

/**
 * 找「下载报表」；找不到就复位路由重来，最多 attempts 轮。
 *
 * 「找不到」有两种成因，代价完全不同：①页面还没渲染完 —— 原地再找一次就有；
 * ②路由停在了降级视图 —— 等多久都没有（实测 40 秒），只有「回首页 → 再进报表 URL」能救
 * （见 resetReportRoute 注释）。所以先试便宜的（再找一次），不行才付复位的代价（约 5 秒）。
 * 这里刻意**不**加「原地等 N 秒」：实测等不出结果，而每轮复位都会重新导航并落位。
 */
async function locateDownloadReportReady(args, targetId, { attempts = 3 } = {}) {
  let located = await locateDownloadReport(args, targetId);
  for (let attempt = 1; attempt <= attempts && !located.found; attempt += 1) {
    const state = await reportPageState(args, targetId);
    console.log(`[submit] 第 ${attempt}/${attempts} 轮找不到「下载报表」｜正文 ${state.textLen} 字符`
      + `｜${state.href} → 复位路由（回首页 → 再进报表 URL）后重找`);
    await resetReportRoute(args, targetId);
    located = await locateDownloadReport(args, targetId);
  }
  return located;
}

// ---------------------------------------------------------------- 下载任务列表（提交段与取件段共用）

/**
 * 读「下载任务管理」列表里的任务名集合。
 *
 * 抽出来不是为了省行数，而是**这个词表只能有一份**：提交段用它算差集（看这一次提交多出来哪一条），
 * 取件段用它核对台账那一笔还在不在。两处各抄一份正则，迟早给出两个答案。
 * 只认**任务名形状**的叶子文本：页面上别的短文本（列头、时间戳）混进来会把差集算错。
 */
async function readTaskNames(args, targetId) {
  const read = await evalOn(args, targetId, `(() => {
    const pattern = ${PROMOTION_TASK_PATTERN.toString()};
    const found = [...document.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && pattern.test(el.textContent.trim()))
      .map((el) => el.textContent.trim());
    return JSON.stringify({ names: [...new Set(found)] });
  })()`);
  return read.names || [];
}

/** 导航到下载任务列表并读一次任务名。 */
async function openTaskList(args, targetId, { settleMs = 7000 } = {}) {
  await navigateTo(args, targetId, ALIMAMA_LIST_URL);
  await delay(settleMs);
  return readTaskNames(args, targetId);
}

/**
 * 提交之后等列表里多出那一条，返回**差集**的判定（见 judgeSubmitOutcome）。
 *
 * 为什么必须看列表而不是看提示语：提示语只说「已提交/生成中」，**不说任务名**；
 * 而取件段从今往后只认台账里这一笔 ⇒ 提交段如果不把名字观察出来，取件段就只能猜。
 *
 * ⚠️ 第一步必须是**导航到「下载任务管理」**：点完「确定」页面还停在报表页
 * （`#!/report/account?...`），那一屏上没有任何任务名。2026-09-21 排练实测过这个代价：
 * 少了这一步，`readTaskNames` 恒得空集，而**空集与「没有新增」算出来的差集一模一样** ——
 * 于是「没读到」被静默说成「平台没接受这次提交」，里可林被卡在 promotion-submit；
 * 而同一刻平台上其实已经生成了 `营销场景报表_20260921_143726`（第 1 行、生成成功、
 * 报表日期 2026-09-20）—— 提交是成功的，只是没人去看。
 */
async function waitForNewTask(args, targetId, before, { attempts = 10, intervalMs = 6000 } = {}) {
  let after = await openTaskList(args, targetId);
  for (let attempt = 1; ; attempt += 1) {
    const outcome = judgeSubmitOutcome({ before, after });
    // 多条也是「有结论」：交给调用方按核不清处理，不用再等。
    if (outcome.ok || outcome.added.length > 1 || attempt >= attempts) {
      return { ...outcome, attempts: attempt, afterCount: after.length };
    }
    console.log(`[submit] 第 ${attempt}/${attempts} 次看列表：${outcome.reason}`
      + `（提交前 ${before.length} 条、这一次读到 ${after.length} 条）→ ${intervalMs / 1000}s 后重载再看`);
    await delay(intervalMs);
    // 列表页还是同一个 URL ⇒ navigate 到同一 URL 是**同文档导航**（浏览器什么都不做）。
    // 与 date-picker 2026-09-21 那个坑同一个成因，所以这里也必须真重载。
    await evalOn(args, targetId, 'window.location.reload(); "reloading"');
    await delay(intervalMs);
    after = await readTaskNames(args, targetId);
  }
}

async function phaseSubmit(args, targetId) {
  const ledgerFile = args.ledger ?? DEFAULT_LEDGER_FILE;
  const shop = ledgerScope(args);
  // 0) 先看「下载任务管理」：这一目标日是不是已经提交过、只是没取。
  //    放在点击之前是刻意的 —— 判在点击之前，才谈得上「不产生第二次副作用」，有顺序判据钉着。
  const listBefore = await openTaskList(args, targetId);
  const resume = judgeResume({ ledger: readLedger(ledgerFile), date: args.date, shop, list: listBefore });
  const staleNote = describeStale(resume.stale);
  if (staleNote) console.log(`[submit] 注意：${staleNote}`);
  if (resume.action === 'block') throw new Error(`提交前核对未通过：${resume.reason}`);
  if (resume.action === 'reuse') {
    console.log(`[submit] ${resume.reason}`);
    console.log(`[submit] promotionTaskName = ${resume.taskName}`);
    console.log('[submit] 未点击任何东西（这一目标日的副作用已经产生过了，不再产生第二次）');
    return;
  }
  console.log(`[submit] ${resume.reason} ⇒ 照常提交`);
  // 看列表会离开报表页 ⇒ 复位回去。resetReportRoute 会把 --date 带上，所以日期不会漂。
  await resetReportRoute(args, targetId);
  const state0 = await reportPageState(args, targetId);
  console.log(`[submit] 页面 = ${state0.href}｜正文 ${state0.textLen} 字符`);
  // 先清掉上一轮留下的弹窗，再谈定位（理由见 clearLeftoverDialog 上方）。
  await clearLeftoverDialog(args, targetId);
  // 定位表达式抽成了常量（见上方 LOCATE_DOWNLOAD_REPORT_EXPRESSION），所以这里只调用；
  // 「找不到」不再直接抛 —— 先复位路由重试，原因见 locateDownloadReportReady。
  const located = await locateDownloadReportReady(args, targetId);
  if (!located.found) {
    const state = await reportPageState(args, targetId);
    throw new Error(`页面上找不到「下载报表」按钮（复位路由重试后仍没有；`
      + `正文 ${state.textLen} 字符、${state.href}）⇒ 页面没落位到报表页`);
  }
  // 报出「取的是哪个元素」：文档序第一个常常是按钮内部的文字 span 而不是 button 本身，
  // 点它靠的是事件冒泡 —— 这一点在录像里也值得说清，免得看的人以为选择器选错了。
  console.log(`[submit] 候选 ${located.found} 个，取文档序第一个（${located.tag}`
    + `${located.clickableAncestor ? `，其可点祖先是 ${located.clickableAncestor}，点击靠冒泡触发` : ''}）`);
  // 两个方向都要居中：只写 block 时窄窗口下按钮会落在视口右边界之外（2026-09-17 实测）。
  await evalOn(args, targetId, scrollIntoViewExpression('[data-collect-alimama-download="1"]'));
  await delay(1500);
  const hit = await hitCheckDismissingOverlay(args, targetId, '[data-collect-alimama-download="1"]');
  if (!hit.ok) {
    throw new Error(`「下载报表」复核未通过（${describeHitMiss(hit)}）`
      + describeOverlayAttempt(hit.overlayAttempt));
  }
  // 排练开关：定位与复核都走一遍，但不点 —— 这样能在不动任何东西的前提下先证明选择器是对的。
  if (args.locateOnly) {
    console.log(`[submit] --locate-only：找到「下载报表」并复核通过（${describeHitPass(hit)}），未点击`);
    return;
  }
  console.log(`[submit] 滚动后复核通过（${describeHitPass(hit)}）→ 点击 → `
    + `${(await click(args, targetId, '[data-collect-alimama-download="1"]')).slice(0, 80)}`);

  // 弹窗是**异步渲染**的：写死一个秒数再读一次，会把「还没渲染完」误判成「弹窗里没有确定」。
  // 2026-09-20 实测本机五家店有 4 家栽在这上面 —— 报错时弹窗其实正开着、确定就在 [259,469,24,12]。
  // 判据（文案=「确定」且中心点命中自己）一个字没改。改的只有两件事：
  //   ① 「只等一次」→「轮询到出现为止」；
  //   ② 轮询期间若「确定」已经在了但点不着（中心点在视口外），先把它滚进视口再按原判据重判。
  const waited = await waitForConfirmButton(args, targetId);
  if (!waited.confirm) {
    // 报错必须自带现场：视口、每个候选的 rect 与「可点/点不着/不在视口内」。
    // 没有这几项就只剩两个布尔，还原现场得另写外部探针（2026-09-20 就是这么绕了一大圈）。
    throw new Error(`等了 ${waited.attempts} 次（每次 ${waited.intervalMs}ms、期间滚动 ${waited.scrolls} 次）`
      + `仍没有可点的「确定」｜${describeDialogCandidates(waited.buttons, waited.viewport)}⇒ 任务未提交`);
  }
  const confirm = waited.confirm;
  console.log(`[submit] 等到「确定」(#${confirm.i})，第 ${waited.attempts} 次轮询命中`
    + `${waited.scrolls ? `（先滚动 ${waited.scrolls} 次才落进视口）` : ''}`
    + `｜${describeDialogCandidates(waited.buttons, waited.viewport)} → `
    + `${(await click(args, targetId, `[data-collect-dialog="${confirm.i}"]`)).slice(0, 80)}`);
  await delay(3500);
  const hint = await evalOn(args, targetId, `(() => {
    const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
    return JSON.stringify({ hint: (text.match(/(提交成功|已提交|生成中|请在下载[^ ]{0,12}查看|已加入下载[^ ]{0,10})/) || [''])[0] });
  })()`);
  console.log(`[submit] 提交后提示 = ${JSON.stringify(hint.hint)}`);
  // 提示语不说任务名 ⇒ 去看列表差集，把「这一次提交到底产生了哪一条」变成**观察值**记进台账。
  const observed = await waitForNewTask(args, targetId, listBefore);
  if (!observed.ok) {
    throw new Error(`提交结果核不清（看了 ${observed.attempts} 次）：${observed.reason}`
      + `｜提交前读到 ${listBefore.length} 条、最后一次读到 ${observed.afterCount ?? '?'} 条`
      + ' ⇒ 不往台账里记一笔来路不明的任务（记了就等于替下一轮编了一个判据）');
  }
  writeLedger(ledgerFile, recordSubmitted(readLedger(ledgerFile), {
    date: args.date, shop, taskName: observed.taskName, proxy: args.proxy, at: new Date().toISOString(),
  }));
  console.log(`[submit] promotionTaskName = ${observed.taskName}（${observed.reason}；台账已记：${ledgerFile}）`);
  console.log('[submit] 下一步：等它「生成成功」后跑 --phase fetch（提示语里说数据量大时最长 10 分钟）');
}

// 轮询间隔：平台自己说生成要几分钟，密集成问没有意义。15s 在「别把它问烦」与「别空等太久」之间。
const GENERATION_POLL_MS = 15000;

/**
 * 等目标任务行变成「生成成功」。
 *
 * 为什么必须等（2026-09-20 现场）：submit 段自己打印「数据量大时最长 10 分钟」，
 * 而驱动在 submit 与 fetch 之间只填了 sycm-date + shop-report 两步（实测两分钟上下）。
 * 原实现第一次看不是「生成成功」就抛，于是这一轮五家里有一家（盖文天猫）卡在这里 ——
 * 平台还在生成，不是页面不对。判据没错，错的是不给它时间。
 *
 * 仍然 fail-closed：超过预算就抛，并把「看了几次、等了多久、最后看到的行文本」带出来。
 * 「压根没出现」与「出现了但没生成成功」分开报：前者要去查 submit，后者才是平台慢。
 */
export async function waitForGenerationReady(args, targetId, wanted, deps = {}) {
  // 三个注入点只为可测：read 默认打真代理，sleep/now 默认用真实时间。
  // 没有它们，这段「等」就只能靠源码断言守 —— 而这一族的真故障恰恰是「判据对、循环不成立」，
  // 源码断言看不出循环会不会真的跑第二圈。
  const read = deps.read ?? (() => evalOn(args, targetId, targetRowExpression(wanted)));
  const sleep = deps.sleep ?? delay;
  const now = deps.now ?? Date.now;
  const budget = args.generationWaitMs ?? 660000;
  const startedAt = now();
  const deadline = startedAt + budget;
  const waited = () => Math.round((now() - startedAt) / 1000);
  let attempts = 0;
  let last = null;
  for (;;) {
    attempts += 1;
    last = await read();
    // 没有复选框是页面结构问题，等多久都不会变 ⇒ 立刻抛，不要把预算耗满。
    if (last.found && !last.hasCheckbox) {
      throw new Error(`${wanted} 那一行没有复选框，无法激活它的操作行`);
    }
    if (last.found && /生成成功/u.test(String(last.rowText))) {
      console.log(`[fetch] 目标任务行 = 第 ${last.trIndex} 行｜${String(last.rowText).slice(0, 80)}`
        + (attempts > 1 ? `｜等了 ${waited()}s、第 ${attempts} 次查看才就绪` : ''));
      return last;
    }
    if (now() >= deadline) break;
    console.log('[fetch] 还在生成（'
      + (last.found ? `行文本 ${JSON.stringify(String(last.rowText).slice(0, 60))}` : `列表里还没这一行：${last.reason}`)
      + `）｜已等 ${waited()}s，${GENERATION_POLL_MS / 1000}s 后再看（预算 ${Math.round(budget / 1000)}s）`);
    await sleep(GENERATION_POLL_MS);
  }
  if (!last.found) {
    throw new Error(`等了 ${waited()}s（${attempts} 次）列表里始终没有 ${wanted} 那一行（${last.reason}）`
      + ' ⇒ 这不是「生成慢」，是任务没提交上；先确认 submit 段真的成功了');
  }
  throw new Error(`等了 ${waited()}s（${attempts} 次，预算 ${Math.round(budget / 1000)}s）${wanted} 还不是「生成成功」`
    + `（最后看到的行文本 ${JSON.stringify(String(last.rowText).slice(0, 80))}）`
    + ' ⇒ 平台那边卡住了，去阿里妈妈「下载任务管理」人工看一眼');
}

async function phaseFetch(args, targetId) {
  const ledgerFile = args.ledger ?? DEFAULT_LEDGER_FILE;
  const shop = ledgerScope(args);
  const before = listDownloads(args.downloads, PROMOTION_ZIP_PATTERN).map((entry) => entry.name);
  console.log(`[fetch] 下载任务管理｜已有 zip ${before.length} 个｜目录 ${args.downloads}`);
  const list = await openTaskList(args, targetId);

  // 认任务名：只有两条被承认的来源 —— 调用方显式 `--task`，或台账里那一笔未取任务**且列表里核得到**。
  // 「列表里时间戳最大那条」**不再是判据**：任务名里的日期是**导出日**（提交那一刻），不含目标日，
  // 猜错就是把别天的报表当成这一天的，而那种错没有便宜的下游检查能发现（详见台账模块文件头）。
  const ledger = readLedger(ledgerFile);
  const staleNote = describeStale(staleFor(ledger, { date: args.date, shop }));
  if (staleNote) console.log(`[fetch] 注意：${staleNote}`);
  const decision = judgeFetchTaskName({ ledger, date: args.date, shop, list, explicit: args.task });
  if (!decision.ok) throw new Error(`取件前核对未通过：${decision.reason}`);
  const wanted = decision.taskName;
  console.log(`[fetch] 目标任务 = ${wanted}（${decision.reason}）`);

  // 取件前提：**先激活目标任务行**。它的操作行默认 display:none，只有这一行被激活才显形，
  // 而页面上任何时刻可见的「下载」叶子恰好 1 个 —— 不激活就会点到别的任务行的入口上，
  // 而这一页「点错」不报错。激活的可靠动作是真实鼠标点该行的复选框，并**回读** checked=true：
  // 点没点上不看接口返回值（它恒 true），看页面状态。
  const boxesBefore = await evalOn(args, targetId, checkboxStateExpression());
  // 「找到了那一行」不等于「那一行现在能取件」。任务还在生成中时，它的入口点了也不落盘，
  // 现场表现是 30 秒空等 —— 和「点错了」长得一模一样。所以先把状态判掉，别留给超时去猜；
  // 而「还没生成成功」是**可自愈**的（平台最长 10 分钟），所以是等到就绪，不是看一眼就抛。
  const row = await waitForGenerationReady(args, targetId, wanted);
  if (row.checked) {
    console.log('[fetch] 该行本就是选中态，跳过点击');
  } else {
    await selectTargetRow(args, targetId, wanted, row);
  }

  // 入口：只认**目标任务行的下一行**（它的操作行）里那个可见的「下载」。
  const entrySelector = `[${TASK_DOWNLOAD_MARK}="1"]`;
  let located = await evalOn(args, targetId, downloadEntryExpression(wanted));
  if (!located.ok) throw new Error(`找不到 ${wanted} 的操作行里的「下载」入口（${describeEntryMiss(located)}）`);
  console.log(`[fetch] 入口 = 第 ${located.actionTrIndex} 行（正是该任务行的操作行）`
    + `｜rect=${JSON.stringify(located.rect)}，center=${JSON.stringify(located.center)}`
    + `｜操作行内叶子 ${located.leavesInActionRow} 个`);
  // 全页可见的「下载」叶子应当恰好 1 个；多了说明有别的行也处于激活态，「下的是哪一条」就不再唯一。
  if (located.visibleDownloads !== 1) {
    console.log(`[fetch] 注意：页面上可见的「下载」共 ${located.visibleDownloads} 个（期望 1 个）`);
  }

  // 不在视口才滚动。**滚动本身会改变显隐状态**（实测滚完那个入口就换了一行），
  // 所以滚完必须重新定位、重新断言，不能拿滚动前的坐标继续用。
  if (!located.inViewport) {
    await evalOn(args, targetId, scrollIntoViewExpression(entrySelector));
    await delay(1200);
    located = await evalOn(args, targetId, downloadEntryExpression(wanted));
    if (!located.ok) throw new Error(`滚动后入口不再可定位（${describeEntryMiss(located)}）`);
    console.log(`[fetch] 原位置在视口外，滚动后重新定位：rect=${JSON.stringify(located.rect)}`
      + `，center=${JSON.stringify(located.center)}`);
  }

  // 复核与点击之间只隔一次往返：这一页「量到点」之间页面会动，差一行（41px）就点空。
  // 被平台自己的全屏弹窗挡住时先关掉再复核；关完必须重新定位（激活态会衰减，见上面 reLocate 的注释）。
  const hit = await hitCheckDismissingOverlay(args, targetId, entrySelector, async () => {
    const again = await evalOn(args, targetId, downloadEntryExpression(wanted));
    if (!again.ok) throw new Error(`关掉遮挡层后入口不再可定位（${describeEntryMiss(again)}）`);
    console.log(`[遮挡] 关掉后重新定位入口：rect=${JSON.stringify(again.rect)}`
      + `，center=${JSON.stringify(again.center)}`);
  });
  if (!hit.ok) {
    throw new Error(`「下载」复核未通过（${describeHitMiss(hit)}）`
      + describeOverlayAttempt(hit.overlayAttempt));
  }
  // 排练开关：选行 + 定位 + 复核都走一遍，但不点下载。
  // 选行是排练的**必要**步骤（不然操作行不显形，排练会「通过」而真跑失败），
  // 所以排练结束要把勾选状态恢复原样 —— 排练的语义是「只读」，不能留下状态改动。
  if (args.locateOnly) {
    const restored = await evalOn(args, targetId, restoreCheckboxesExpression(boxesBefore.checked));
    console.log(`[fetch] --locate-only：入口已定位并复核通过（${describeHitPass(hit)}），未点击；`
      + `勾选状态已恢复（改动 ${restored.changed} 项，现为 ${JSON.stringify(restored.checked)}）`);
    return;
  }
  const point = pointOf(hit);
  console.log(`[fetch] 复核通过（${describeHitPass(hit)}）→ 真实鼠标点击 (${point.join(',')}) → `
    + `${(await clickPoint(args, targetId, point)).slice(0, 80)}`);

  const deadline = Date.now() + args.timeoutMs;
  while (Date.now() < deadline) {
    await delay(3000);
    const fresh = newEntries(before, listDownloads(args.downloads, PROMOTION_ZIP_PATTERN).map((entry) => entry.name));
    if (fresh.length) {
      const newest = pickNewest(listDownloads(args.downloads, PROMOTION_ZIP_PATTERN)
        .filter((entry) => fresh.includes(entry.name)));
      // 新文件必须就是**目标任务**那一份。页面上「下载」按钮并没有「下载哪一条」的显式表述
      // （靠的是哪一行被激活），万一落到别的任务上，就要在这里抓住，而不是拿一份错的源文件
      // 往下走 —— 错源文件的后果是静默写错数据。
      if (!(newest.name === `${wanted}.zip` || newest.name.startsWith(`${wanted} (`))) {
        throw new Error(`落盘的不是目标任务：期望 ${wanted}.zip，实得 ${newest.name}`
          + '（下载的对象与预期不符，停在这里比继续更省事）');
      }
      console.log(`[fetch] 新文件：${newest.name}（${newest.size} bytes）`);
      console.log(`[fetch] promotionZipPath = ${path.join(args.downloads, newest.name)}`);
      // 取到了才把台账标成已取。顺序反了（先标后取）一旦取件失败，下一轮就会「复用」一笔
      // 其实从没落盘过的任务，而那笔任务在列表里已经消失 ⇒ 卡在与本轮一样的核不清上。
      writeLedger(ledgerFile, recordConsumed(readLedger(ledgerFile), {
        date: args.date, shop, taskName: wanted, at: new Date().toISOString(),
      }));
      console.log(`[fetch] 台账已标为已取：${args.date} 的 ${wanted}`);
      return;
    }
    console.log(`[fetch] 等待下载… ${Math.round((args.timeoutMs - (deadline - Date.now())) / 1000)}s`);
  }
  throw new Error(`${args.timeoutMs}ms 内没等到新 zip：判据取文件系统，页面说「生成成功」不算数`);
}

// 勾选目标任务行：**点之前先确认那一点真的是这个复选框**。
// 2026-09-17 实测踩到：页面上一个 z-index 999999 的浮层正好压住第一行，`elementFromPoint` 命中的是
// 浮层里的 TD —— 真实点击落在浮层上、复选框纹丝不动，而这一页**点错不报错**（只表现为 30 秒空等）。
// 浮层会自己收起来，所以「等一会儿、重新量、再点」就过了；把它做成显式重试，而不是让调用方去猜。
async function selectTargetRow(args, targetId, taskName, firstRow) {
  const attempts = args.selectAttempts;
  const described = (row) => `${row.checkboxHitTag ?? '?'}`
    + `${row.checkboxHitClass ? `.${row.checkboxHitClass}` : ''}`;
  let row = firstRow;
  // 只主动关一次：这一页也可能被**平台自己的全屏弹窗**压住，而那种等不好（与会自收的浮层相反）。
  // 六次重试若全是「等一会儿」，等于把一次当场能修好的失败拖成 45 秒后才报错。
  let overlayTried = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (row.checkboxHit === false) {
      console.log(`[fetch] 第 ${attempt}/${attempts} 次：复选框中心被 ${described(row)} 挡住，`
        + '等一会儿重试（不硬点 —— 这一页点错不报错）');
      if (!overlayTried) {
        overlayTried = true;
        const attemptOverlay = await dismissBlockingOverlay(args, targetId, null);
        if (attemptOverlay.dismissed) {
          await delay(600);
          row = await evalOn(args, targetId, targetRowExpression(taskName));
          if (!row.found) throw new Error(`关掉遮挡层后找不到 ${taskName} 那一行（${row.reason}）`);
          console.log(`[fetch] 遮挡层已关掉，重新量到复选框中心 ${JSON.stringify(row.checkboxCenter)}`
            + `（命中自己=${row.checkboxHit}）`);
          continue;
        }
      }
    } else {
      console.log(`[fetch] 真实鼠标点它的复选框 (${row.checkboxCenter.join(',')}) → `
        + `${(await clickPoint(args, targetId, row.checkboxCenter)).slice(0, 80)}`);
      await delay(1500);
      const after = await evalOn(args, targetId, targetRowExpression(taskName));
      if (after.checked) {
        const now = await evalOn(args, targetId, checkboxStateExpression());
        console.log(`[fetch] 回读 checked=true，当前勾选 = ${JSON.stringify(now.checked)}`);
        return after;
      }
      row = after;
      console.log(`[fetch] 第 ${attempt}/${attempts} 次点击没生效（回读 checked=false）`);
    }
    if (attempt < attempts) {
      await delay(1200);
      row = await evalOn(args, targetId, targetRowExpression(taskName));
      if (!row.found) throw new Error(`重试勾选时找不到 ${taskName} 那一行（${row.reason}）`);
    }
  }
  throw new Error(`勾选 ${taskName} 失败（试了 ${attempts} 次都回读 checked=false；`
    + `最后一次中心命中 ${described(row)}）—— 它的操作行不会显形，取件必然落空，停在这里比继续更省事`);
}

async function main() {
  const args = parseCollectArgs(process.argv.slice(2),
    { phases: ['submit', 'fetch'], flags: ['--locate-only'] });
  args.proxy = args.proxy ?? `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;
  args.downloads = path.resolve(args.downloads ?? defaultDownloadsDir());
  const targetId = await findAlimamaPage(args);
  await bringToFront(args, targetId);
  console.log(`[0/2] 阿里妈妈页 ${targetId}｜phase=${args.phase}｜目标日 ${args.date}`);
  // 身份核对必须在任何点击/导航之前：两个阶段都从它开始。
  await assertAlimamaIdentity(args, targetId);
  if (args.phase === 'submit') await phaseSubmit(args, targetId);
  else await phaseFetch(args, targetId);
}

// 被 import 时不执行 CLI（同 readback-daily-report.mjs 的写法）。
// 为什么需要它：`pickConfirmButton` 与下方两条定位表达式都是「代码即字符串」，
// 必须能在离线用例里被真正跑一次 —— 只比源码字面，看不见「这段字符串在页面上根本算不出来」。
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`\n采集失败：${error.message}`);
    process.exitCode = 1;
  });
}
