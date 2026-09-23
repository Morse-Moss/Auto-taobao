// 「哪个实例配哪两个启动脚本」—— 起停脚本共用的**唯一口径**。
//
// 为什么要有这个模块（而不是让 start-all / stop-all 各写一份）：
//   起与停必须作用在**同一组**目标上。分成两份清单的话，迟早出现「起的时候知道 7 个实例、
//   停的时候只认 6 个」—— 第 7 个会永远活着，而且没有任何一处会报错。这是同一件事两处实现的
//   典型后果，也是这套系统反复在治的病，所以这里只留一份。
//
// 三条设计约束：
//   1) **不写死端口。** port / profile / browserId / label 一律从 `buildDeclarationPlan()`
//      的条目取（那条链的源头是 runtime/browser-ports.mjs）。本文件里出现数字就是 bug
//      （有一条守卫会扫 scripts/ 与 runtime/ 下的端口字面量）。
//   2) **纯函数。** 只算「该执行哪两条命令」，不 spawn、不探测、不读进程表。这样它可以在
//      离线测试里被完整断言，而 start-all/stop-all 只剩下真正的 I/O。
//   3) **「怎么起」与「怎么算该不该起」分开。** 前者是本文件的 buildLaunchCommands；
//      后者是 selectActions（输入是 browser-inventory 的判决，输出是动作）。两者都能单独测。
//
// 「哪个实例配哪个脚本」这件事**故意**不做成自动推导（例如按 kind 拼文件名）：
// 推导看起来省事，但它会让「脚本被改名」这件事静默生效 —— 名字变了，拼出来的路径不存在，
// 报错会发生在 spawn 那一刻而不是这里。显式表让改名必须同时改这一行。
import { buildDeclarationPlan } from './browser-inventory.mjs';
// 「店铺标识页的 URL 长什么样」只此一处实现（shop-window-label.mjs 的 labelPageUrlFor）。
// 在这里复用它、而不是另拼一个 file:// 地址：两处拼地址的后果是**两个格式**，而其中一处
// 改了（多带一个参数、换个页面文件）另一处不会跟着改 —— 表现就是「窗口首屏那个页面点不动」，
// 而没有任何一处会报错。
import { labelPageUrlFor } from './shop-window-label.mjs';

/** 浏览器实例与代理各自的启动脚本。路径相对仓库根。 */
const LAUNCHERS = Object.freeze({
  competitorBrowser: 'runtime/start-project-browser.mjs',
  competitorProxy: 'runtime/start-competitor-proxy.mjs',
  dailyReportBrowser: 'runtime/start-daily-report-browser.mjs',
  dailyReportProxy: 'runtime/start-daily-report-proxy.mjs',
  sharedBrowser: 'runtime/start-project-browser.mjs', // 店铺实例复用通用启动器（靠环境变量定位）
  sharedProxy: 'runtime/start-shop-proxy.mjs', // 店铺代理一家一个进程，键由参数给
});

/**
 * 一个实例「怎么起」。返回两条命令，顺序有意义：**先浏览器、后代理**。
 *
 * 为什么顺序有意义：代理在 import 期就定死了「连哪个浏览器」（见 start-shop-proxy.mjs 的说明）。
 * 浏览器还没起来就起代理，代理会拿着一个连不上的目标活着 —— 它的 /health 照样回 200，
 * 于是「代理在」这个判据会通过，而实际什么都驱动不了。先起浏览器能让这件事自然成立。
 */
export function buildLaunchCommands(entry) {
  if (entry.kind === 'competitor') {
    return [
      { role: 'browser', file: LAUNCHERS.competitorBrowser, args: [], env: {} },
      { role: 'proxy', file: LAUNCHERS.competitorProxy, args: [], env: {} },
    ];
  }
  if (entry.kind === 'dailyReport') {
    return [
      { role: 'browser', file: LAUNCHERS.dailyReportBrowser, args: [], env: {} },
      { role: 'proxy', file: LAUNCHERS.dailyReportProxy, args: [], env: {} },
    ];
  }
  if (entry.kind === 'shop') {
    // 通用启动器没有「店铺」这个概念，靠这三个环境变量定位 profile、调试端口与**首屏页面**。
    // 值都取自登记表条目 —— 传错就是串店，而串店在这套系统里是静默失败。
    return [
      {
        role: 'browser',
        file: LAUNCHERS.sharedBrowser,
        args: [],
        env: {
          PROJECT_BROWSER_PORT: String(entry.browserPort),
          PROJECT_BROWSER_PROFILE: entry.profile,
          // 首屏＝**这家店自己的标识页**（而不是启动器的默认 `about:blank`）。
          //
          // 为什么（2026-09-23 用户两条原话：「不要空页」、「每个店铺的浏览器要有标识页」）：
          // 通用启动器的 `START_URL` 默认是 `about:blank`，而 `start-all` 从不设这个变量
          // ⇒ **每次冷启动都恰好留下一个空白页**。它没有任何用途（`prunePlan` 对 blank 的策略
          // 本来就是「永远关」），却正是用户反复看到的那一个「空页」；而标识页原先是靠
          // 起完之后再跑一遍 `shop-window-label.mjs --commit` 补的 —— 那一步失败或没跑到时，
          // 窗口上就既没有店名、又留着那个空白页。
          //
          // 把首屏直接设成标识页，一次解决两件事，而且**没有新增任何页签**：
          //   · 窗口一开出来，标题里就写着店名（`windowTitleFor`），页面上大字写着店名与会员名；
          //   · 那个「等谁来接管」的空白页压根不存在。
          // 它同时也是链路已经容忍的东西：`shop-window-label.mjs` 的 label 分支会认出现成的
          // 标识页并**原地导航**（`reused: true`，把登录态/实际会员名补上），不会再堆一个。
          //
          // 为什么只给店铺实例（竞品链与日报链不动）：这两条链的首屏有它们自己的语义
          // （日报链的商家浏览器已自带 `https://sycm.taobao.com/`；竞品链那条不读店铺身份）。
          // 给它们套一个店铺标识页是**把标签贴错窗口**，那比留一个空白页更坏。
          PROJECT_BROWSER_URL: labelPageUrlFor({ shop: entry.key, port: entry.browserPort }),
        },
      },
      // 代理这一条用**运营叫法**（登记表的键）当参数：start-shop-proxy 会用它去查登记表，
      // 拼错会当场抛错而不是静默回落到别的店。中文经 spawn 传递不经过 shell，无编码问题。
      { role: 'proxy', file: LAUNCHERS.sharedProxy, args: [entry.key], env: {} },
    ];
  }
  throw new Error(`未登记的实例类型「${entry.kind}」—— 起停计划无从生成；请在 buildLaunchCommands 里补上它的启动器`);
}

/**
 * 由盘点结果决定「哪些角色需要起」。
 *
 * 分桶的口径与 browser-inventory.judgeInstance 一一对应，而且**故意**保持一一对应：
 * 那边说「缺代理」，这边就只能起代理；两边若各有一套映射，就会出现「判成 ready 却被起了」
 * 这种没人能解释的行为。
 *
 * 两个桶必须**拒绝动作**，而不是「尽力而为」：
 *   · foreign      —— 端口上是别人的 profile。起一个只会把调试端点接到别人身上，
 *                     而且全程不报错（点击、导航、导出都成功，只是拿回别家的数据）。
 *   · unconfirmed  —— 端口在监听但读不出身份。这时候起东西等于赌，赌输的代价同上。
 * 这两桶里不动的理由要原样带给操作者，而不是用一句「跳过」盖掉。
 */
export function selectActions(judgement) {
  switch (judgement) {
    case 'ready': return { start: [], reason: '已就位，不动' };
    case 'proxy-missing': return { start: ['proxy'], reason: '浏览器在，代理没起（不用碰浏览器）' };
    case 'browser-missing': return { start: ['browser'], reason: '代理在，浏览器没了' };
    case 'missing': return { start: ['browser', 'proxy'], reason: '两样都没有，起一整套' };
    case 'foreign': return { start: [], reason: '端口上是别的 profile，拒绝启动（先查清是谁的）' };
    case 'unconfirmed': return { start: [], reason: '端口在监听但读不出身份，不赌（人看一眼）' };
    default: return { start: [], reason: `未知判决「${judgement}」，拒绝启动` };
  }
}

/**
 * 一个实例「怎么停」—— 停的顺序与起**相反**：先代理、后浏览器。
 *
 * 为什么：代理是唯一还能驱动浏览器的入口。先断掉它，浏览器才不会在被杀的过程中
 * 又被派一个新任务（那会留下半截的下载、半截的导航）。这条与起的时候「先浏览器后代理」
 * 一起构成一句可检验的话：**浏览器永远比代理活得久**。
 *
 * 停止手法只在 stop-all 里实现（那是有副作用的 I/O），这里只给顺序与判据。
 */
export function buildStopOrder(entry) {
  return [
    { role: 'proxy', file: LAUNCHERS[entry.kind === 'competitor' ? 'competitorProxy' : entry.kind === 'dailyReport' ? 'dailyReportProxy' : 'sharedProxy'], args: entry.kind === 'shop' ? [entry.key] : [] },
    { role: 'browser', file: LAUNCHERS[entry.kind === 'competitor' ? 'competitorBrowser' : entry.kind === 'dailyReport' ? 'dailyReportBrowser' : 'sharedBrowser'], args: [] },
  ];
}

/** 全部声明实例的起停计划（唯一来源：buildDeclarationPlan）。 */
export function buildFullPlan() {
  return buildDeclarationPlan().map((entry) => ({
    ...entry,
    launch: buildLaunchCommands(entry),
    stopOrder: buildStopOrder(entry),
  }));
}

/**
 * 「这个进程是谁」类的环境变量：**起子进程前必须从继承的环境里清掉**。
 *
 * 为什么（2026-09-19，写 start-all 时发现的真隐患）：
 * 这些启动器全部用 `||=` 取默认值（显式环境变量优先）—— 那是为「临时换端口排查」留的口子。
 * 但如果这台机器的 shell 里恰好留着一个 `PROJECT_BROWSER_PORT`（排查完忘了 unset 很常见），
 * 那么「一键起齐」会把**每一家店**都指向同一个端口：启动器们一个个起来、日志全是 READY、
 * 一键起齐报「全部就位」，而实际只有一家店有浏览器，其余全是同一台。
 * 这是本项目已经吃过三次的坑（同店四名、串店、自称买家实连商家）的同一个形状：
 * **配置文件之外的地方还留着一个能决定身份的值**。
 *
 * 所以规矩是：子进程的环境 = 清干净的本机环境 ＋ 计划里显式给的那几个键。
 * 计划说这个实例用哪个端口，就只能用哪个端口 —— 没有第二条来源。
 */
export const INSTANCE_ENV_KEYS = Object.freeze([
  'PROJECT_BROWSER_PORT',
  'PROJECT_BROWSER_PROFILE',
  'PROJECT_BROWSER_URL',
  'SHOP_KEY',
  'CDP_PROXY_PORT',
  'CDP_BROWSER_PORT',
  'CDP_BROWSER_ID',
  'CDP_BROWSER_LABEL',
]);

/** 纯函数：算出子进程该拿到的环境。第二个参数只是为了可测（默认 process.env）。 */
export function buildChildEnv(command, ambient = process.env) {
  const env = { ...ambient };
  for (const key of INSTANCE_ENV_KEYS) delete env[key];
  return { ...env, ...command.env };
}

/**
 * 「这个实例现在可以停谁」—— 纯判决，输入是**证据**，输出是待杀清单与拒停清单。
 *
 * 为什么判决要单独拿出来（而不是写在 stop-all 的循环里）：停是这套系统里唯一
 * **不可撤销**的动作。判据放在 I/O 中间时，它既没法离线验收，也没法在半夜被人复查。
 *
 * 三类证据，各自能证明的事不一样，**不许互相顶替**：
 *   browserVerdict —— 浏览器自己报的 profile。这是「这个端口属于哪家店」唯一的正面证据
 *                     （与 classifyPortUsage 同源）。读不出来（unknown）＝没有证据，不是「没问题」。
 *   proxyIdentity  —— 代理进程的**命令行**里认得出对应的启动脚本（店铺代理还要认得出店名）。
 *                     代理不监听身份，而 /health 的 browser 字段在浏览器已死时是 null，
 *                     所以命令行是它唯一可靠的抓手。
 *   launcherPid    —— 启动器 node（浏览器进程的父进程）。杀它可以连带杀掉整棵浏览器进程树，
 *                     且顺带把那个不监听任何端口的保活进程一起收掉。
 *
 * 任何一条证据不到位的角色一律**拒停**，并带上原因。宁可留下一个进程让人手工处理，
 * 也不要杀错 —— 这台机器上有别的项目在跑（FOREIGN_PORTS 那一类），杀错是不可撤销的。
 */
export function planInstanceStop(entry, evidence) {
  const targets = [];
  const refusals = [];

  // 代理：先看它想不想得到证据。
  if (evidence.proxyPid) {
    if (evidence.proxyIdentity?.matchesScript) {
      targets.push({
        role: 'proxy', pid: evidence.proxyPid, tree: false,
        evidence: `端口在听、进程命令行是 ${evidence.proxyIdentity.script}`
          + `${evidence.proxyIdentity.matchesKey ? ` ${entry.key}` : ''}`,
      });
    } else {
      refusals.push({
        role: 'proxy', pid: evidence.proxyPid,
        why: `端口的进程认不出是本实例的代理（命令行对不上启动脚本）—— 它可能属于别的项目`,
      });
    }
  }

  // 浏览器：只有 profile 对上才动。
  if (evidence.browserPid) {
    if (evidence.browserVerdict === 'ours') {
      // 挑启动器当靶子（一个 pid 覆盖整棵树：启动器 node → msedge 主进程 → 渲染进程）。
      // 找不到启动器时退回浏览器主进程本身 —— 少了那个保活 node，但它不监听端口、也不会
      // 重启浏览器，留着只是占内存。两条路都**只杀这一个 pid 的树**，不做任何猜测式的扩散。
      const pid = evidence.launcherPid ?? evidence.browserPid;
      targets.push({
        role: 'browser', pid, tree: true,
        evidence: evidence.launcherPid
          ? `CDP 自证 profile 一致；杀启动器 ${evidence.launcherPid}（连带浏览器进程树与保活进程）`
          : 'CDP 自证 profile 一致；没找到启动器，按浏览器主进程停',
      });
    } else if (evidence.browserVerdict === 'foreign') {
      refusals.push({
        role: 'browser', pid: evidence.browserPid,
        why: '端口上是**另一个 profile** 的浏览器 —— 那是别人的登录态，绝不动',
      });
    } else {
      refusals.push({
        role: 'browser', pid: evidence.browserPid,
        why: `端口在监听但读不出 profile（verdict=${evidence.browserVerdict}）—— 没有证据就不动`,
      });
    }
  }

  // 顺序：先代理、后浏览器（与 buildStopOrder 同一句话：浏览器永远比代理活得久）。
  const order = { proxy: 0, browser: 1 };
  targets.sort((a, b) => order[a.role] - order[b.role]);
  return { targets, refusals };
}

/** taskkill 的参数（渲染与执行共用一份，避免「打印的」与「执行的」不一样）。 */
export function taskkillArgs(pid) {
  // /T：连子进程树一起（浏览器的渲染进程、启动器 node 与它 spawn 的 msedge）。
  // /F：不协商。用 /F 的理由：这些进程没有「未保存的工作」，而留下半死的进程比强杀更糟。
  return ['/PID', String(pid), '/T', '/F'];
}

/**
 * `--only` 的解析：**可读名与内部键都收**。
 *
 * 为什么两者都收：登记表里的键是给程序用的 ASCII（`competitor` / `dailyReport`），
 * 而人在终端里打的是他熟悉的名字（「盖文天猫」）。只认一种，另一种就会被当成拼错，
 * 而拼错的表现是「跑完了，但那一家根本没被处理」—— 一个不会报错的漏做。
 *
 * 报错时列**可读名**（键只用括号补充）。把 `competitor / dailyReport` 这种内部键摆在
 * 首位，等于让人去猜「这是哪家店」—— 而这个名字他从来没在别处见过。
 */
export function matchInstances(plan, names) {
  if (!names) return { targets: plan, unknown: [] };
  const targets = plan.filter((entry) => names.includes(entry.key) || names.includes(entry.who));
  const unknown = names.filter((name) => !plan.some((entry) => entry.key === name || entry.who === name));
  return { targets, unknown };
}

/** 面向人的实例名：可读名优先，内部键只在两者不同时以括号补充。 */
export function describeInstance(entry) {
  return entry.who === entry.key ? entry.who : `${entry.who}（${entry.key}）`;
}

/** `--only` 拼错时的提示文本（两个脚本共用一份，免得同一条错误有两种说法）。 */
export function onlyHelpText(plan) {
  return `已登记：${plan.map(describeInstance).join(' / ')}`;
}


/**
 * 命令行匹配用的片段：用来在进程表里认出「这个实例的启动器进程」。
 *
 * 结论（2026-09-19 实测后修正）：**认不出来，也不该试着认。**
 * 店铺实例的启动器进程命令行是 `node runtime/start-project-browser.mjs`，5 个实例（4 家店 +
 * 竞品链）逐字相同 —— profile 与端口是通过**环境变量**传的，而环境变量不出现在命令行里。
 * 一开始我按「命令行里带 profile 路径」去认，那是错的：匹配永远为空，表现是「找不到启动器」，
 * 一个看起来像「它没在跑」的假事实。
 *
 * 正确的抓手在别处，而且更可靠：**端口 → pid → 父进程**。
 *   浏览器：netstat 给出 CDP 端口的 pid（并用 CDP 自证 profile 一致），它的父进程就是启动器 node；
 *   代理  ：netstat 给出代理端口的 pid，它本身就是那个进程。
 * 这条链每一步都是操作系统当场给的证据，不需要 pidfile（pidfile 是第二份真相，重启即陈旧）。
 * 见 runtime/browser-inventory.mjs 的 findAncestorByPid。
 */
export function launcherHintFor(entry) {
  return {
    browserScript: entry.kind === 'shop' ? LAUNCHERS.sharedBrowser
      : entry.kind === 'competitor' ? LAUNCHERS.competitorBrowser
        : LAUNCHERS.dailyReportBrowser,
    proxyScript: entry.kind === 'shop' ? LAUNCHERS.sharedProxy
      : entry.kind === 'competitor' ? LAUNCHERS.competitorProxy
        : LAUNCHERS.dailyReportProxy,
  };
}

