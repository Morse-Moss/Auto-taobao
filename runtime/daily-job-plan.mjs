// 定时任务「到点跑什么」的**唯一口径**。
//
// 背景（为什么需要这层）：SOP §13 说的是「任务计划到点敲**一条**命令」。而今天真实要做的其实有
// **三件**：① 保证实例在（浏览器与代理；本项目的进程绑会话，机器重启或回收之后它们不在）；
// ② 看一眼五家店的登录态（只读，2026-09-23 加；**并把结论交给链**，同日晚补上）；③ 跑全链。
// 三件都塞进 `/TR` 里由 shell 拼，三个月后没人能说清当时到底跑的是什么。
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
import path from 'node:path';

export const JOB_FILES = Object.freeze({
  ensureInstances: 'scripts/start-all.mjs',
  // 跑前登录态体检 / 跑前登录守卫（两种模式，由 autoLogin 选）。2026-09-23 接进本计划。
  //   · 只读档：不开页面、不点任何东西、**也不发任何告警**（没去登就不许叫人）；
  //   · `autoLogin` 打开：会碰页面（登录），登不进去的当场各发一条飞书告警。
  // 它排在「起实例」之后、「跑链」之前 —— 实例不在时它读不到任何东西，
  // 而那正是链的第 0 步体检（归位）要负责的事。
  loginPreflight: 'skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs',
  // 全链驱动。参数口径见 skills/sycm-alimama-daily-report/references/sop.md §13。
  chain: 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs',
  // 分批驱动（2026-09-23 加，**默认不启用**）。它自己会做「起这一批 → 挂标识页 → 跑 → 停这一批」，
  // 所以启用时它**替换**上面那条 `chain`，而不是与它并排 —— 两条一起跑会让同一家店被驱动两次。
  // 路径同样以字符串写：本文件不该把编排脚本拉进模块图（理由见文件头）。
  batchChain: 'scripts/run-batches.mjs',
});

/**
 * 跑前登录态结论落在哪个文件里 + 链那一步用哪个参数收它。
 *
 * 这两样**必须只有一份**：定时链（本文件）与分批驱动（scripts/run-batches.mjs）都会用它，
 * 各写一份就会漂 —— 而漂出来的症状是「链那边参数没少、只是永远读不到结论」，
 * 于是告警退回「这一轮没有先查登录态」，看起来完全正常（本条要治的正是这种静默）。
 */
export const LOGIN_PREFLIGHT_ARTIFACT = 'login-preflight.json';
export const LOGIN_PREFLIGHT_FLAG = '--login-preflight';

/**
 * 跑前登录态体检那一步的参数。**两个调用点共用一份**。
 *
 * `json` 只在「结论确实有人接」时才给：`--json` 会**取代**那一份给人看的报告
 * （check-login-shops.mjs 是 if/else），而人翻日志时那份报告很有用。
 * 所以：有人接 ⇒ 出 JSON（跑那一步的宿主会把它同时落成文件、回显进日志）；
 * 没人接 ⇒ 保持昨天那样只打报告，链的告警会如实说「这一轮没有先查登录态」。
 *
 * `login`（2026-09-23 加）：把这一步从「只查」升级成「查 + 掉了就自己登一次」。
 *   默认**关**，由调用方显式打开 —— 因为带它之后这一步**会碰页面**（开登录页、提交表单），
 *   不再是只读；「要不要让机器去登」是调用点的决定，不该由这个纯函数替它猜。
 *   打开它的两个调用点都是自动化入口（定时链 scripts/run-daily-job.mjs 与分批驱动
 *   scripts/run-batches.mjs），理由见 CLAUDE/CHANGELOG：用户 2026-09-23 明确授权自动登录。
 */
export function buildLoginPreflightArgs({ shops = null, json = false, login = false } = {}) {
  const args = [];
  if (login) args.push('--login');
  if (shops && shops.length > 0) args.push('--shops', shops.join(','));
  if (json) args.push('--json');
  return args;
}

/** 允许转发的可选开关（透传，不在本文件里复述它们的含义）。 */
const CHAIN_FLAGS = Object.freeze({
  notify: '--notify',
  notifyPrint: '--notify-print',
  keepGoing: '--keep-going',
  allowMissingPeer: '--allow-missing-peer',
});

const CHAIN_VALUED = Object.freeze({ shops: '--shops', only: '--only', logs: '--logs', downloads: '--downloads' });

/**
 * 分批驱动那一段的参数（**与链那一段刻意分开算**）。
 *
 * 为什么不复用 `chainArgs`：分批驱动只认其中一部分开关 —— 它没有 `--only`（阶段级筛选在
 * 「一批」这个粒度上没有意义）、也没有 `--logs`/`--downloads`（它自己按批分配证据目录，
 * 见 run-batches 里那段注释）。把链的参数表整份塞过去，轻则报「未知参数」，
 * 重则某个同名字段被当成另一层含义用掉 —— 那种错在日志里长得完全正常。
 *
 * `--batch-size` 是必给的（`--batches` 没值就当场拒，见 buildJobPlan）：
 * 「每批几家」是这个功能唯一的旋钮，它缺省掉的那天没人会注意到自己又回到了全量常驻。
 */
export function buildBatchChainArgs({
  dateInput = 'yesterday', notify = false, keepGoing = false, allowMissingPeer = false,
  shops = null, batches = null, commit = false,
} = {}) {
  const args = ['--date', dateInput, '--batch-size', String(batches)];
  // `--commit` 必须由这里显式给：分批驱动自己的默认是**排练**（不写飞书），
  // 而定时任务的职责就是「写下今天的数据」。漏了这一句，行为会从「写飞书」
  // 悄悄变成「什么都不写」，而日志里那句「模式 commit」不会有任何异常 ——
  // 这是本条最危险的一处静默降级，所以它有一条专门的用例。
  if (commit) args.push('--commit');
  args.push(notify ? CHAIN_FLAGS.notify : CHAIN_FLAGS.notifyPrint);
  if (keepGoing) args.push(CHAIN_FLAGS.keepGoing);
  if (allowMissingPeer) args.push(CHAIN_FLAGS.allowMissingPeer);
  // 排查用「只跑某几家」在这里仍然有意义：`--shops` 是「跑哪几家」，与批次粒度无关。
  if (shops) args.push(CHAIN_VALUED.shops, shops.join(','));
  return args;
}

/**
 * 定时任务要跑的三步。纯函数 —— 参数表可以被离线断言。
 *
 * 步骤顺序有意义，且是**两次实测换来的**：
 *   ① 先保证实例在（`start-all` 幂等，已就位的一个都不碰）；
 *   ② 再看一眼登录态（只读；这一步是给「跑前那一眼」留证据，不是闸门），
 *      **并把结论写成一个文件交给链**（`--login-preflight`，2026-09-23 接上）；
 *   ③ 最后跑链。
 *
 * 为什么登录态体检排在**起实例之后**：实例不在时它一个页面都读不到，只会留下一片「读不到」
 * —— 那是**本可以不出**的噪声。反过来，排在链前面才有意义：链的第 0 步体检只看
 * 「端口/页面/出网」，**不看登录态**（`runtime/xws-platform-health-preflight.mjs` 里
 * IDENTITY / SESSION 两层明写未实现），所以掉登录这件事从前只能等到采集阶段炸，
 * 炸出来的告警还是「没跑完，但记录里没写停在哪一步」。
 *
 * ⚠️ 2026-09-23 补上的一环（用户拍板「1.改」）：② 的结论原先**只落在日志里**，链一个字都看不到
 * —— 于是掉登录时链看到的仍然是「页面不齐」，发出去的告警是「把这两页各开一个」，
 * 而收信人照着做无效（掉登录时开几个页面都会被送回登录页）。现在 ② 的 stdout 会被落成
 * `login-preflight.json` 并作为 `--login-preflight` 交给 ③，链把「页面不齐」改判成
 * 「哪个店哪个后台掉登录了」。**这一步不是闸门**这一点没有变：拿不到结论时链照样跑，
 * 只是告警会如实说「这一轮没有先查登录态」。
 *
 * 为什么这一步 `blocking: false`：链的第 0 步体检才是「今天能不能写」的权威判据。
 * 在这里截断只会让告警少一层信息；而它自己判「读不到」时（冷启动后页面还没归位）
 * 更不该停 —— 那件事链的归位会自己解决。
 */
export function buildJobPlan(options = {}) {
  const {
    dateInput = 'yesterday', notify = false, notifyPrint = false, keepGoing = false,
    allowMissingPeer = false, shops = null, only = null, logs = null, downloads = null,
    batches = null, artifactsDir = null,
    // `autoLogin`（2026-09-23 加）：跑前那一步要不要「掉了就自己登一次」。
    // **默认关**（与「新能力默认关」的既有纪律一致），由宿主显式打开：
    //   `scripts/run-daily-job.mjs` 默认打开（用户 2026-09-23 明确授权自动登录），
    //   且给了 `--no-auto-login` 让运维一键退回只读体检。
    // 为什么默认关而不是默认开：这个模块也被用例与排查直接调用，
    // 而带它的那一步**会碰页面**（开登录页、提交表单）。让「碰页面」变成调用方要说的话，
    // 不是这里替所有人默认决定的事。
    autoLogin = false,
  } = options;

  // 「分批跑」是一个**显式**开关（提前算出来，因为「结论交给谁」在下面要用到它）。
  const batchMode = batches !== null && batches !== undefined;

  // 跑前登录态结论的**落点**。`artifactsDir`＝本轮证据目录（`evidence/daily-job-<日>/`）。
  // 不给它时这一步只把报告打进日志、链那一步也拿不到结论 —— 链的告警会如实说
  // 「这一轮没有先查登录态」（文案口径见 run-multi-shop-day.mjs 的 loginPreflightLines），
  // 而不是安静地少说一件事。**但真实调用点（scripts/run-daily-job.mjs）一定会给**，
  // 并由一条用例钉住这件事：少给就等于把这一整条链的修复退回原样。
  //
  // 分批那一档**刻意例外**：那条路的结果交接在分批驱动**内部**完成
  // （2026-09-23 晚改成**逐批一份**：`login-preflight-b<N>.json`，由 run-batches 负责生成与转发），
  // 所以这里既不生成 JSON、也不给 `batch-chain` 加参数 —— 这里生成的那份没有任何人读，
  // 而「写了没人读的文件」正是后来人会照着接错的地方。这一步本身仍然跑：它的报告进 job.log，
  // 是「开跑前（整轮视角）五家店登录态」那一条记录。
  //
  // ⚠️ 已知的重复（刻意留下，不是漏改）：分批形态下登录守卫会跑**两遍** ——
  // 这一整轮一遍（排在 `ensure-instances` 之后，那时七个实例都起来了，前提成立），
  // 分批驱动里再逐批一遍（那一遍查的是本批、结论也只交给本批的链）。
  // 第二遍才是权威的那一遍（它排在**本批 start 之后**）；这一遍留下是因为它同时也是
  // 定时任务日志里唯一一条「整轮视角」的记录。要收紧的话应当删掉**这一遍**、不是删分批那条。
  const loginPreflightFile = artifactsDir && !batchMode
    ? path.join(artifactsDir, LOGIN_PREFLIGHT_ARTIFACT)
    : null;

  // 告警出口必须恰好一个：两个都传会让驱动那边 `--notify-print` 赢（resolveAlertDispatch 的顺序），
  // 于是「我要发飞书」这个意图被静默丢掉。与其指望调用方记得，不如在这里当场拦住。
  if (notify && notifyPrint) {
    throw new Error('--notify 与 --notify-print 互斥：告警出口只能有一个（同时传时 --notify-print 会赢，'
      + '于是「要发飞书」这层意图被静默丢掉）');
  }

  if (batchMode) {
    if (!Number.isInteger(batches) || batches < 1) {
      throw new Error(`--batches 要一个 ≥1 的整数（每批几家），收到 ${JSON.stringify(batches)}。`
        + '不给这个开关，定时链的行为与从前逐字相同。');
    }
    if (only || logs || downloads) {
      // 这三样是**链那一段**的开关，分批驱动没有对应的概念。静默忽略它们，
      // 等于让操作者以为自己筛过了 —— 而实际跑的是全部。宁可当场拒。
      throw new Error('--only / --logs / --downloads 与 --batches 不能同时给：'
        + '分批驱动没有这三个概念（它自己按批分配证据目录）。要阶段级筛选请直接用链那条命令。');
    }
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
  // 跑前登录态结论交给链那一步。**值是一个绝对路径，而且由本文件算出**（不是 spawn 那一刻补）：
  // 「打印出来的必须是真正执行的」—— `--print` 时人看到的就是这一行的真实路径。
  if (loginPreflightFile) chainArgs.push(LOGIN_PREFLIGHT_FLAG, loginPreflightFile);

  const chainStep = batchMode
    ? {
      name: 'batch-chain',
      file: JOB_FILES.batchChain,
      args: buildBatchChainArgs({
        dateInput, notify, keepGoing, allowMissingPeer, shops, batches, commit: true,
      }),
      note: `分批跑（每批 ${batches} 家）：起这一批 → 查本批登录 → 挂店铺标识页 → 跑这一批 → 停这一批（**一律释放**）`,
      blocking: true,
    }
    : {
      name: 'chain',
      file: JOB_FILES.chain,
      args: chainArgs,
      note: '全链：体检 → 采集 → 推送 → 回填 → 回读',
      blocking: true,
    };

  return {
    dateInput,
    batches: batches ?? null,
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
        // `autoLogin` 打开时这一步同时承担「跑前登录守卫」：掉登录的当场自己登一次。
        args: buildLoginPreflightArgs({ shops, json: Boolean(loginPreflightFile), login: autoLogin }),
        // `artifactPath`：这一步的 stdout 要**落成一个文件**，不能只进日志 ——
        // 链那一步把它当参数读。没有它，「结论进告警」这句话就没有落点
        // （2026-09-23 之前正是这样：体检跑了、报告也打了，而告警仍然说「页面不齐，去开页面」）。
        ...(loginPreflightFile ? { artifactPath: loginPreflightFile } : {}),
        note: (autoLogin
          ? '跑前登录守卫（**会碰页面**：掉登录的当场用浏览器密码库登一次；登不进去的**当场各发一条飞书告警**）'
          : '跑前登录态体检（只读：不开页面、不点东西、也不发任何告警）')
          + '—— 哪家店的哪个后台掉登录了，写进日志'
          + (loginPreflightFile ? '，并交给链（掉登录时告警会直接点名，不再叫人去开页面）' : ''),
        // 同一条理由：它**不是闸门**。它的三个退出码会被记进日志
        // （0＝全在登录态；2＝有后台明确掉登录；3＝没结论/读不到），人翻日志时一眼能看到；
        // 但它不许拦住链 —— 掉了登录这件事，链自己会在采集段如实报出来。
        // `autoLogin` 改了这一步会不会碰页面，**不改它的闸门语义**：登没登上都不许由它截断整轮。
        blocking: false,
      },
      chainStep,
    ],
  };
}

/** 把一条命令渲染成 Windows 命令行文本（反斜杠、按需加引号）。 */
export function renderCommand(step, { nodeExe, repoRoot } = {}) {
  const quote = (value) => (/[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value);
  const file = `${repoRoot}\\${step.file.replaceAll('/', '\\')}`;
  return [quote(nodeExe), quote(file), ...step.args.map(quote)].join(' ');
}

/** 任务的 `/TR`：只要拉起**这一个**入口，三步由它自己按顺序执行（日志也就只有一处）。 */
export function renderJobEntryCommand({ nodeExe, repoRoot, jobFile, args = [] } = {}) {
  return renderCommand({ file: jobFile, args }, { nodeExe, repoRoot });
}
