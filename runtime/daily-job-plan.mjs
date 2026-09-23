// 定时任务「到点跑什么」的**唯一口径**。
//
// 背景（为什么需要这层）：SOP §13 说的是「任务计划到点敲**一条**命令」。而今天真实要做的其实有
// **三件**：① 保证实例在（浏览器与代理；本项目的进程绑会话，机器重启或回收之后它们不在）；
// ② 看一眼五家店的登录态（只读，2026-09-23 加）；③ 跑全链。三件都塞进 `/TR` 里由 shell 拼，
// 三个月后没人能说清当时到底跑的是什么。
// 所以口径放在这里、由 `scripts/run-daily-job.mjs` 执行、由 `scripts/schedule-install.mjs` 注册。
//
// 三条不变量（每条都对应一个已经吃过的亏）：
//   1) **日期只有一种给法**：`--date yesterday`。让驱动自己解析（时钟只取一次），
//      计划任务里不写死任何日期 —— 写死的日期在第二天就过期，而它看起来还在正常工作。
//   2) **历史日的降级开关不许顺手打开**：`--allow-missing-peer` 是给「补跑历史日」的，
//      定时跑的那一天永远落在「昨日」这一档。顺手打开会让「本该有基准却没有」的真故障静默通过。
//   3) **告警默认只落日志、不投递**：`--notify` 是「出错就发飞书」。发不发的决定权在人，
//      所以默认走 `--notify-print`（用真渲染器打印文案，一次投递都不发生）。
//      要打开必须显式传 `--notify` —— 与「修复与发送是两步」同一条纪律。
//
// 路径以**字符串**写在这里（不做 import）：这条计划只是「该跑哪个文件」，
// 不需要、也不该把能力的脚本拉进模块图（拉了就会在依赖白名单里多一条反向依赖，
// 见 runtime/arch-boundary.test.mjs 与提案 D3）。
export const JOB_FILES = Object.freeze({
  ensureInstances: 'scripts/start-all.mjs',
  // 跑前登录态体检（只读：不开页面、不点任何东西）。2026-09-23 接进本计划。
  // 它排在「起实例」之后、「跑链」之前 —— 实例不在时它读不到任何东西，
  // 而那正是链的第 0 步体检（归位）要负责的事。
  loginPreflight: 'skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs',
  // 全链驱动。参数口径见 skills/sycm-alimama-daily-report/references/sop.md §13。
  chain: 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs',
});

/** 允许转发的可选开关（透传，不在本文件里复述它们的含义）。 */
const CHAIN_FLAGS = Object.freeze({
  notify: '--notify',
  notifyPrint: '--notify-print',
  keepGoing: '--keep-going',
  allowMissingPeer: '--allow-missing-peer',
});

const CHAIN_VALUED = Object.freeze({ shops: '--shops', only: '--only', logs: '--logs', downloads: '--downloads' });

/**
 * 定时任务要跑的三步。纯函数 —— 参数表可以被离线断言。
 *
 * 步骤顺序有意义，且是**两次实测换来的**：
 *   ① 先保证实例在（`start-all` 幂等，已就位的一个都不碰）；
 *   ② 再看一眼登录态（只读；这一步是给「跑前那一眼」留证据，不是闸门）；
 *   ③ 最后跑链。
 *
 * 为什么登录态体检排在**起实例之后**：实例不在时它一个页面都读不到，只会留下一片「读不到」
 * —— 那是**本可以不出**的噪声。反过来，排在链前面才有意义：链的第 0 步体检只看
 * 「端口/页面/出网」，**不看登录态**（`runtime/xws-platform-health-preflight.mjs` 里
 * IDENTITY / SESSION 两层明写未实现），所以掉登录这件事从前只能等到采集阶段炸，
 * 炸出来的告警还是「没跑完，但记录里没写停在哪一步」。
 *
 * 为什么这一步 `blocking: false`：链的第 0 步体检才是「今天能不能写」的权威判据。
 * 在这里截断只会让告警少一层信息；而它自己判「读不到」时（冷启动后页面还没归位）
 * 更不该停 —— 那件事链的归位会自己解决。
 */
export function buildJobPlan(options = {}) {
  const {
    dateInput = 'yesterday', notify = false, notifyPrint = false, keepGoing = false,
    allowMissingPeer = false, shops = null, only = null, logs = null, downloads = null,
  } = options;

  // 告警出口必须恰好一个：两个都传会让驱动那边 `--notify-print` 赢（resolveAlertDispatch 的顺序），
  // 于是「我要发飞书」这个意图被静默丢掉。与其指望调用方记得，不如在这里当场拦住。
  if (notify && notifyPrint) {
    throw new Error('--notify 与 --notify-print 互斥：告警出口只能有一个（同时传时 --notify-print 会赢，'
      + '于是「要发飞书」这层意图被静默丢掉）');
  }

  const chainArgs = ['--date', dateInput, '--commit'];
  // 默认把文案落进日志（有人翻得到、但没有任何东西被发出去）。
  chainArgs.push(notify ? CHAIN_FLAGS.notify : CHAIN_FLAGS.notifyPrint);
  for (const [key, flag] of Object.entries(CHAIN_FLAGS)) {
    // notify 已经处理过；其余开关按需追加。
    if (key === 'notify' || key === 'notifyPrint') continue;
    if (options[key]) chainArgs.push(flag);
  }
  for (const [key, flag] of Object.entries(CHAIN_VALUED)) {
    // 值一律转成字符串再给：`--shops` 传数组会被 spawn 拼成逗号连接，而驱动对空项的处理
    // 与「少给一家」是两回事（有 `--shops 0 家店` 的 fail-closed 判据），所以这里只做一次转换。
    const value = key === 'shops' || key === 'only' ? (options[key]?.join(',') ?? null) : options[key];
    if (value) chainArgs.push(flag, String(value));
  }

  return {
    dateInput,
    steps: [
      {
        name: 'ensure-instances',
        file: JOB_FILES.ensureInstances,
        args: [],
        note: '把声明实例起齐（幂等：已就位的不碰）',
        // 这一步失败**不阻止**下一步：链的第 0 步体检才是权威判据，它会给出更准的告警
        // （哪一页不齐、哪家店连不上）。在这里截断只会让告警少一层信息。
        blocking: false,
      },
      {
        name: 'login-preflight',
        file: JOB_FILES.loginPreflight,
        // 指定店铺跑（排查用）时，只体检那几家；否则查登记表里全部五家。
        args: shops ? ['--shops', shops.join(',')] : [],
        note: '跑前登录态体检（只读：不开页面、不点东西）—— 哪家店的哪个后台掉登录了，写进日志',
        // 同一条理由：它**不是闸门**。它的三个退出码会被记进日志
        // （0＝全在登录态；2＝有后台明确掉登录；3＝没结论/读不到），人翻日志时一眼能看到；
        // 但它不许拦住链 —— 掉了登录这件事，链自己会在采集段如实报出来。
        blocking: false,
      },
      {
        name: 'chain',
        file: JOB_FILES.chain,
        args: chainArgs,
        note: '全链：体检 → 采集 → 推送 → 回填 → 回读',
        blocking: true,
      },
    ],
  };
}

/** 把一条命令渲染成 Windows 命令行文本（反斜杠、按需加引号）。 */
export function renderCommand(step, { nodeExe, repoRoot } = {}) {
  const quote = (value) => (/[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value);
  const file = `${repoRoot}\\${step.file.replaceAll('/', '\\')}`;
  return [quote(nodeExe), quote(file), ...step.args.map(quote)].join(' ');
}

/** 任务的 `/TR`：只要拉起**这一个**入口，两步由它自己按顺序执行（日志也就只有一处）。 */
export function renderJobEntryCommand({ nodeExe, repoRoot, jobFile, args = [] } = {}) {
  return renderCommand({ file: jobFile, args }, { nodeExe, repoRoot });
}
