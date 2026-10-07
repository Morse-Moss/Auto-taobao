// daily-job-plan.mjs 的离线判据。
//
// 这份计划的三条不变量都由本文件钉住（每条的代价都是「在没人的时候做错事」）：
//   ① 日期只有一种给法（`--date yesterday`，不写死日期）；
//   ② 历史日的降级开关不许顺手打开；
//   ③ 告警默认只落日志、不投递 —— 一封半夜发出去的飞书比不提醒更糟（会训练人忽略这个通道）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  JOB_FILES, LOGIN_PREFLIGHT_ARTIFACT, LOGIN_PREFLIGHT_FLAG, MERCHANT_LOGIN_SITE, buildJobPlan,
  buildEnsureInquiryRowsArgs, buildLoginPreflightArgs, buildMerchantLoginGuardArgs, renderCommand, renderJobEntryCommand,
} from './daily-job-plan.mjs';
import { collectingShopKeys } from './browser-ports.mjs';
// 共享实例名单的单一来源：分批形态下第 ① 步只起它（见 2026-09-30 修的那个缺陷）。
import { SHARED_INSTANCE_KEYS } from './batch-plan.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const argsOf = (plan, name) => plan.steps.find((s) => s.name === name).args;
// 按**名字**取步骤，不按下标。2026-10-06 加了一步之后，一批按下标写的断言全红了 ——
// 而它们红的理由与它们要守的东西无关（守的是「分批替换链」「commit 必须传下去」，
// 却因为「链现在是第 5 个而不是第 4 个」而红）。按下标还会让下一个人**改数字**而不是想清楚，
// 所以这里统一改成按名字取：判据只对「那一步」说话。
const stepOf = (plan, name) => {
  const found = plan.steps.find((s) => s.name === name);
  if (!found) throw new Error(`计划里没有名为 ${name} 的步骤；实际：${plan.steps.map((s) => s.name).join(' / ')}`);
  return found;
};

test('六步的顺序是「先保证实例在 → 给共用窗口挂标识 → 再看一眼登录态 → 再修共享实例的会话 → 再补行骨架 → 再跑链」', () => {
  // 反过来（先跑链）时，链的第 0 步体检会整轮拦下并发一条**本可以不出**的告警；
  // 告警这个通道被无谓地用一次就少一次可信度。
  // 而登录态体检必须排在**起实例之后**：实例不在时它一个页面都读不到，只留下一片「读不到」。
  // 2026-09-25 加的第三步（共享商家浏览器守卫）也必须排在链之前：链的**整轮级体检**跑在
  // 那台实例上，它挂掉的处置是「整轮不跑」—— 守卫晚一步，五家店就一家都不开跑。
  // 2026-10-06 加的第二步（共用窗口标识页）同样要排在链之前：它是「告警说去共用窗口」
  // 这句话的**前提**，越早挂上，后面任何一步失败时告警就已经有落点了。
  // 2026-10-07 加的最后一步（补飞书询单表的行骨架）排在链**之前、其余一切之后**：
  // 它建的是链第 10 步回填要写的那一行，越晚建越贴近真正需要它的那一刻。
  const plan = buildJobPlan();
  assert.deepEqual(plan.steps.map((s) => s.name),
    ['ensure-instances', 'label-merchant-window', 'login-preflight', 'ensure-merchant-login',
      'ensure-inquiry-rows', 'chain']);
  // 按**名字**取步骤判 blocking，不按下标：下标会让下一个人（以及这次的加法）只改数字而不想清楚。
  for (const name of ['ensure-instances', 'label-merchant-window', 'login-preflight', 'ensure-merchant-login', 'ensure-inquiry-rows']) {
    assert.equal(stepOf(plan, name).blocking, false,
      `${name} 不该阻断链：权威判据在链的体检里，在这里截断只会让告警少一层信息`);
  }
  assert.equal(stepOf(plan, 'chain').blocking, true);
});

test('登录态体检那一步：只读、且指定店铺时只体检那几家', () => {
  const args = argsOf(buildJobPlan(), 'login-preflight');
  // 一个参数都不给 ＝ 由脚本按**参与采集**的店铺自己枚举（不是「什么都不查」，
  // 也不是「登记表全部」—— 登记表里可能还有没开始收集的空店，带上它会天天假告警）。
  assert.deepEqual(args, []);
  assert.deepEqual(argsOf(buildJobPlan({ shops: ['科塔淘宝'] }), 'login-preflight'), ['--shops', '科塔淘宝']);
  // 它必须是**只读**那一条命令：不许把自动登录（--commit）误接进来
  const file = buildJobPlan().steps.find((s) => s.name === 'login-preflight').file;
  assert.match(file, /check-login-shops\.mjs/u, '这一步要的是逐店只读体检，不是单店自动登录');
  assert.doesNotMatch(args.join(' '), /--commit/u);
});

test('计划指向的文件都真实存在（脚本被改名时不许静默生效）', () => {
  for (const file of Object.values(JOB_FILES)) {
    assert.ok(existsSync(path.join(REPO_ROOT, file)), `计划里引用的文件不存在：${file}`);
  }
});

test('日期只有一种给法：默认 yesterday，且从不写死具体日期', () => {
  const plan = buildJobPlan();
  assert.deepEqual(argsOf(plan, 'chain').slice(0, 2), ['--date', 'yesterday']);
  // 传一个显式日期是允许的（补跑），但**默认**不许是日期字面量 —— 写死的日期第二天就过期。
  const explicit = buildJobPlan({ dateInput: '2026-09-17' });
  assert.deepEqual(argsOf(explicit, 'chain').slice(0, 2), ['--date', '2026-09-17']);
  assert.doesNotMatch(argsOf(buildJobPlan(), 'chain').join(' '), /\d{4}-\d{2}-\d{2}/u);
});

test('定时那一档永远不加 --allow-missing-peer（默认关，要开必须显式）', () => {
  assert.equal(argsOf(buildJobPlan(), 'chain').includes('--allow-missing-peer'), false);
  // 驱动那边这个开关是给「补跑历史日」的降级：默认打开会让「本该有基准却没有」的真故障静默通过。
  assert.equal(argsOf(buildJobPlan({ allowMissingPeer: true }), 'chain').includes('--allow-missing-peer'), true);
});

test('告警默认只落日志、不投递；要发必须显式 --notify', () => {
  // 这是「修复与发送是两步」那条纪律在定时任务上的形态：默认值的失败方向必须是「安静」。
  assert.equal(argsOf(buildJobPlan(), 'chain').includes('--notify-print'), true);
  assert.equal(argsOf(buildJobPlan(), 'chain').includes('--notify'), false);
  assert.equal(argsOf(buildJobPlan({ notify: true }), 'chain').includes('--notify'), true);
  assert.equal(argsOf(buildJobPlan({ notify: true }), 'chain').includes('--notify-print'), false);
});

test('两个告警出口同时给 ⇒ 当场抛错，不许静默丢掉一个', () => {
  // 驱动那边 `--notify-print` 会赢（resolveAlertDispatch 的判定顺序）⇒「我要发飞书」这层意图
  // 会被安静地丢掉，表现是「设了通知但一条都没发」。与其指望调用方记得，不如在这里拦住。
  assert.throws(() => buildJobPlan({ notify: true, notifyPrint: true }), /互斥/u);
});

test('--commit 永远在（这是定时任务的职责：写下今天的数据）', () => {
  assert.ok(argsOf(buildJobPlan(), 'chain').includes('--commit'));
});

test('可选开关按需追加：不给就不出现，给了就原样转发', () => {
  const base = argsOf(buildJobPlan(), 'chain').join(' ');
  assert.doesNotMatch(base, /--keep-going|--shops|--only|--logs|--downloads/u);
  const full = argsOf(buildJobPlan({ keepGoing: true, shops: ['科塔淘宝', '盖文天猫'], only: ['push'] }), 'chain').join(' ');
  assert.match(full, /--keep-going/u);
  assert.match(full, /--shops 科塔淘宝,盖文天猫/u, '数组要转成逗号串，且中文不许被转义');
  assert.match(full, /--only push/u);
});

test('渲染出的命令行是 Windows 形态：反斜杠、路径带引号', () => {
  const text = renderCommand({ file: 'scripts/start-all.mjs', args: [] }, { nodeExe: 'C:\\node.exe', repoRoot: 'D:\\retire\\sycm-automation' });
  assert.match(text, /D:\\retire\\sycm-automation\\scripts\\start-all\.mjs/u);
  assert.doesNotMatch(text, /\//u, '给计划任务的路径不该出现正斜杠');
  // 路径里有空格时必须整体加引号，否则会被拆成两段参数（计划任务的解析器与 shell 不是一回事）
  const spaced = renderCommand({ file: 'scripts/a b.mjs', args: ['x y'] }, { nodeExe: 'C:\\Program Files\\node.exe', repoRoot: 'D:\\r p' });
  assert.match(spaced, /"C:\\Program Files\\node\.exe"/u);
  assert.match(spaced, /"x y"/u);
});

test('/TR 只拉起一个入口（三步由它自己按顺序执行，日志也就只有一处）', () => {
  const text = renderJobEntryCommand({ nodeExe: 'C:\\node.exe', repoRoot: 'D:\\repo', jobFile: 'scripts/run-daily-job.mjs' });
  assert.match(text, /run-daily-job\.mjs/u);
  // 三步都不许被拍平进 /TR —— 那样没人能说清到点跑的是什么
  assert.doesNotMatch(text, /start-all|run-multi-shop-day|check-login-shops/u);
});

// ---------------------------------------------------------------------------
// 分批跑（2026-09-23 加）：**默认关闭**这件事必须由判据守着，不能只写在注释里。
//
// 背景：用户要「跑完释放」，因为「全部店铺都不释放，电脑性能撑不住」。分批驱动的语义是
// 「起这一批 → 挂标识页 → 跑这一批 → 停这一批」。它一旦被误开，代价是**定时链的行为变了**
// 而没人知道 —— 所以第一条判据就是「不传 `--batches` 时，渲染出来的命令逐字不变」。
// ---------------------------------------------------------------------------
test('不启用分批时，六步与从前**逐字相同**（默认关闭是硬保证，不是注释里的承诺）', () => {
  const plan = buildJobPlan();
  assert.equal(plan.batches, null);
  assert.deepEqual(plan.steps.map((s) => s.name),
    ['ensure-instances', 'label-merchant-window', 'login-preflight', 'ensure-merchant-login',
      'ensure-inquiry-rows', 'chain']);

  // 逐字比较：跟上一次「没有分批这个概念」时渲染出来的那几行比。
  // 用固定期望值而不是「再跑一次自己」，否则这类断言永远绿（自己等于自己）。
  const render = (p) => p.steps.map((s) => renderCommand(s, { nodeExe: 'N', repoRoot: 'R' }));
  assert.deepEqual(render(plan), [
    'N R\\scripts\\start-all.mjs',
    // 2026-10-06 加：共用窗口的标识页。这一行**必须**排在实例起来之后（否则只读到「连不上代理」），
    // 且只点共用实例那一个 —— 店铺实例的首屏在冷启动时就已经是各自标识页了。
    'N R\\runtime\\shop-window-label.mjs --commit --front --subject merchant',
    'N R\\skills\\sycm-alimama-daily-report\\scripts\\check-login-shops.mjs',
    // 2026-09-25 新加的那一步：默认（`autoLogin` 未打开）必须是**只读档**，
    // 且 `--notify` 必须是 `off`（login-merchant 自己的默认值是 `auto`，会把告警投出去）。
    'N R\\skills\\sycm-alimama-daily-report\\scripts\\login-merchant.mjs --check-only --target sycm --notify off',
    // 2026-10-07 加：补飞书询单表的行骨架。`--commit` 必须**显式**给 ——
    // 那个脚本自己的默认是排练（一个字节都不写），漏了这句会静默地「一行都没建」。
    // 证据目录没给时**不给 `--evidence`**（由脚本自己挑一个兜底目录），见下一条用例。
    'N R\\skills\\sycm-alimama-daily-report\\scripts\\ensure-inquiry-rows.mjs --date yesterday --commit',
    'N R\\skills\\sycm-alimama-daily-report\\scripts\\run-multi-shop-day.mjs --date yesterday --commit --notify-print',
  ]);
  assert.doesNotMatch(render(plan).join(' '), /run-batches\.mjs/u, '默认这一档里不许出现分批驱动');
});

test('启用分批：它**替换**链那一步（不是并排），参数只带分批驱动认得的那几个', () => {
  const plan = buildJobPlan({ batches: 2 });
  assert.equal(plan.batches, 2);
  assert.deepEqual(plan.steps.map((s) => s.name),
    ['ensure-instances', 'label-merchant-window', 'ensure-merchant-login', 'ensure-inquiry-rows', 'batch-chain'],
    '两条一起跑会让同一家店被驱动两次 —— 必须是替换关系');
  const step = stepOf(plan, 'batch-chain');
  assert.match(step.file, /scripts\/run-batches\.mjs$/u);
  assert.equal(step.blocking, true);
  assert.deepEqual(step.args, ['--date', 'yesterday', '--batch-size', '2', '--commit', '--notify-print']);
  // 链那边才认的开关不许漏进来：分批驱动没有 `--only`/`--logs`/`--downloads` 的概念
  assert.doesNotMatch(step.args.join(' '), /--only|--logs|--downloads/u);
});

test('启用分批时 `--commit` 必须显式传下去（漏了它就变成「排练」，而日志看不出异常）', () => {
  // 分批驱动自己的默认是排练（不写飞书）；定时任务的职责是写下今天的数据。
  // 这条是**静默降级**里最贵的一种：不报错、不告警、日志里那句「模式」也照旧。
  assert.ok(stepOf(buildJobPlan({ batches: 2 }), 'batch-chain').args.includes('--commit'),
    '定时形态必须带 --commit，否则整轮不写飞书而没人会发现');
});

test('启用分批：告警出口与降级开关照旧按需转发', () => {
  const plan = buildJobPlan({ batches: 3, notify: true, keepGoing: true });
  assert.deepEqual(stepOf(plan, 'batch-chain').args,
    ['--date', 'yesterday', '--batch-size', '3', '--commit', '--notify', '--keep-going']);
  assert.deepEqual(stepOf(buildJobPlan({ batches: 3, shops: ['科塔淘宝'] }), 'batch-chain').args,
    ['--date', 'yesterday', '--batch-size', '3', '--commit', '--notify-print', '--shops', '科塔淘宝']);
});

test('启用分批时的形状校验：家数必须是 ≥1 的整数，且不许与链那边独有的开关同给', () => {
  for (const bad of [0, -1, 2.5, '2', null]) {
    if (bad === null) continue; // null ＝ 不启用，不是非法值
    assert.throws(() => buildJobPlan({ batches: bad }), /≥1 的整数/u, `${JSON.stringify(bad)} 应当被拒`);
  }
  // 静默忽略 `--only` 会让操作者以为自己筛过了，而实际跑的是全部 —— 宁可当场拒。
  assert.throws(() => buildJobPlan({ batches: 2, only: ['push'] }), /不能同时给/u);
  assert.throws(() => buildJobPlan({ batches: 2, logs: 'x' }), /不能同时给/u);
  assert.throws(() => buildJobPlan({ batches: 2, downloads: 'x' }), /不能同时给/u);
});

// ---------------------------------------------------------------------------
// 跑前登录态结论 → 链（2026-09-23，用户拍板「1.改」）。
//
// 为什么值得单独立一节：② 的结论原先**只落在日志里**，链一个字都看不到 —— 于是掉登录时
// 链看到的仍然是「页面不齐」，发出去的告警是「把这两页各开一个」，收信人照着做无效。
// 这里守两件事：结论真的交到了链手上；以及**没交到时不假装交到了**（那条由链侧的文案保证）。
// ---------------------------------------------------------------------------
const ARTIFACTS_DIR = path.join('D:\\repo', 'evidence', 'daily-job-2026-09-22');
const ARTIFACT_PATH = path.join(ARTIFACTS_DIR, LOGIN_PREFLIGHT_ARTIFACT);

test('跑前登录态结论真的交给链了：② 出 JSON、③ 收路径（都只在给了证据目录时）', () => {
  const plan = buildJobPlan({ artifactsDir: ARTIFACTS_DIR });
  // ② 要出 JSON：`--json` 会**取代**那份给人看的报告，所以只有「确实有人接」时才加。
  assert.deepEqual(argsOf(plan, 'login-preflight'), ['--json']);
  // 产物落点要在计划里给出：宿主照着它把这一步的 stdout 写成文件。
  assert.equal(plan.steps.find((s) => s.name === 'login-preflight').artifactPath, ARTIFACT_PATH);
  // ③ 收的是一个**路径**，而且由计划自己算出（spawn 那一刻补会让打印与执行不一致）。
  assert.deepEqual(argsOf(plan, 'chain').slice(-2), [LOGIN_PREFLIGHT_FLAG, ARTIFACT_PATH]);
  // 「打印出来的必须是真正执行的」：渲染出来的那一行必须带着真实路径。
  assert.match(renderCommand(stepOf(plan, 'chain'), { nodeExe: 'N', repoRoot: 'R' }),
    /--login-preflight D:\\repo\\evidence\\daily-job-2026-09-22\\login-preflight\.json/u);
  // 它仍然**不是闸门**（这一步的结论丢了，链照样跑）。
  assert.equal(stepOf(plan, 'login-preflight').blocking, false);
});

test('不给证据目录时：不许凭空造一个路径，也不许给链加参数', () => {
  // 宁可不给，也不给一个指向别处的路径 —— 链那侧会把「读不到」如实说成
  // 「这一轮没有先查登录态」，而不是假装查过。
  assert.deepEqual(argsOf(buildJobPlan(), 'login-preflight'), []);
  assert.equal(argsOf(buildJobPlan(), 'chain').includes(LOGIN_PREFLIGHT_FLAG), false);
  assert.equal(buildJobPlan().steps.find((s) => s.name === 'login-preflight').artifactPath, undefined);
});

// ---------------------------------------------------------------------------
// 共用窗口的标识页（2026-10-06 加）。用户原话：「我就特意设计了标识页，让用户知道是哪个窗口」。
//
// 守三件事：① 默认在、可关；② 关掉之后**只少这一步**、其余逐字不变；
// ③ 真实调用点（`scripts/run-daily-job.mjs`）真的把开关透传进来 —— 漏传的症状是静默的
// （那一步干脆不进计划，日志里少一行，而「告警说去共用窗口」又一次没有落点）。
// ---------------------------------------------------------------------------
test('共用窗口标识页：默认在（排在实例起来之后），--no-merchant-label 可整个关掉', () => {
  const on = buildJobPlan({ artifactsDir: ARTIFACTS_DIR });
  const step = stepOf(on, 'label-merchant-window');
  assert.match(step.file, /runtime\/shop-window-label\.mjs$/u, '复用的是店铺标识页那一套脚本，不是另写的');
  assert.deepEqual(step.args, ['--commit', '--front', '--subject', 'merchant']);
  assert.equal(step.blocking, false, '挂标识页只是给人看的：挂不上照样收数据，不许挡住后面的步骤');
  // 顺序：实例起来之后。实例不在时它只会读到「连不上代理」。
  assert.ok(on.steps.findIndex((s) => s.name === 'label-merchant-window')
    > on.steps.findIndex((s) => s.name === 'ensure-instances'), '标识页要排在起实例之后');
  // 分批与非分批**都要有**：那台实例是共用的，两种形态都靠它跑整轮级体检。
  assert.ok(buildJobPlan({ batches: 5 }).steps.some((s) => s.name === 'label-merchant-window'),
    '分批形态下同样要挂 —— 共用实例在两种形态里都是链的整轮级体检的落点');

  const off = buildJobPlan({ merchantLabel: false });
  assert.equal(off.merchantLabelStep, null);
  assert.equal(off.steps.some((s) => s.name === 'label-merchant-window'), false);
  // 「关掉」只该少这一步：其余步骤逐字不变（否则「关一个开关」会连带改掉别的东西）。
  assert.deepEqual(off.steps.map((s) => s.name),
    ['ensure-instances', 'login-preflight', 'ensure-merchant-login', 'ensure-inquiry-rows', 'chain']);
});

test('接线（源码级）：真实调用点真的把 merchantLabel 透传进计划（漏传是静默的）', () => {
  // 这条守的是「契约齐、测试绿、接线没接上」那一类：纯函数给得再对，
  // 入口不把开关交给它，那一步就永远不进计划，而日志里只表现为「少一行」。
  const source = readFileSync(new URL('../scripts/run-daily-job.mjs', import.meta.url), 'utf8');
  assert.match(source, /merchantLabel:\s*options\.merchantLabel/u,
    '入口没有把 merchantLabel 交给 buildJobPlan ⇒ 共用窗口永远拿不到标识页');
  assert.match(source, /'--no-merchant-label'/u,
    '入口没有解析 --no-merchant-label ⇒ 运维没有一键退回的开关');
});

// ---------------------------------------------------------------------------
// 补飞书询单表的行骨架（2026-10-07 加）。
//
// 要治的事：2026-10-06 那一轮 8 家店前 9 步全部成功（含第 7 步 push 写底单），
// 第 10 步 `backfill` **8 家全部** `got 0` —— 根因是那张表的日期行一直是**运营侧预建**的
// （铺到 10-05），而链的回填只更新、不新建。这是「外部依赖没落进流程」，
// 不修就每天可能全挂，而挂的位置离真因隔着好几层。
// 这里守四件事：默认在（含分批形态）／`--commit` 显式传／证据目录与 --shops 的转发／一键退回。
// ---------------------------------------------------------------------------
test('补行骨架那一步：默认在、排在链之前、两种形态都有、且**不是闸门**', () => {
  const on = buildJobPlan({ artifactsDir: ARTIFACTS_DIR });
  const step = stepOf(on, 'ensure-inquiry-rows');
  assert.match(step.file, /skills\/sycm-alimama-daily-report\/scripts\/ensure-inquiry-rows\.mjs$/u);
  assert.equal(step.blocking, false,
    '它失败时正确的处置不是「今天不采集」：采集与推送跟这一行无关，只有第 10 步回填需要它，'
    + '而回填可以事后补跑；当闸门会把「一张表少一行」升级成「一天的数据一条都不采」');
  // 顺序：排在链之前（它建的正是链第 10 步要写的那一行），且排在**其余一切之后**。
  assert.ok(on.steps.findIndex((s) => s.name === 'ensure-inquiry-rows')
    < on.steps.findIndex((s) => s.name === 'chain'), '必须在链之前');
  assert.ok(on.steps.findIndex((s) => s.name === 'ensure-inquiry-rows')
    > on.steps.findIndex((s) => s.name === 'ensure-merchant-login'), '排在最后一个前置步骤之后');
  // 生产跑的是分批那一档（`--batches`），所以这一步必须在分批形态里也在 ——
  // 它是**日级**的，与批次粒度无关，也不该在每个批里各建一遍。
  assert.ok(buildJobPlan({ batches: 5 }).steps.some((s) => s.name === 'ensure-inquiry-rows'),
    '分批形态下同样要补 —— 否则生产形态（--batches）里这条修复等于没接上');
  assert.equal(buildJobPlan({ batches: 5 }).steps.filter((s) => s.name === 'ensure-inquiry-rows').length, 1,
    '只该出现一次：建行是日级动作，不是每批一次');
});

test('补行骨架：`--commit` 必须显式给（漏了它＝静默地一行都不建）', () => {
  // 脚本自己的默认是**排练**（一个字节都不写）。定时任务的职责是「把今天该有的行准备好」，
  // 而漏这一句的症状是静默的：脚本照跑、日志照打 `DRY_RUN_READY`，只是没建，
  // 链照样在 backfill 全挂 —— 与本条要治的那个形态逐字相同。
  assert.ok(stepOf(buildJobPlan(), 'ensure-inquiry-rows').args.includes('--commit'));
  assert.ok(stepOf(buildJobPlan({ batches: 5 }), 'ensure-inquiry-rows').args.includes('--commit'));
  // 参数构造器本身不许替调用方默认打开写入（它会真的写飞书）。
  assert.deepEqual(buildEnsureInquiryRowsArgs({ dateInput: 'yesterday' }), ['--date', 'yesterday']);
});

test('补行骨架：日期给**字面量**（与链同一口径）、证据目录给了才带、--shops 点名时才收窄', () => {
  // 给字面量的理由：它要建的正是「链接下来会往哪一天回填」的那一行，而链拿的也是字面量、
  // 由它在那一刻自己解析。给一个算好的日期，等于让两次不同的时钟去保证「同一天」。
  assert.deepEqual(stepOf(buildJobPlan(), 'ensure-inquiry-rows').args,
    ['--date', 'yesterday', '--commit']);
  assert.deepEqual(stepOf(buildJobPlan({ artifactsDir: ARTIFACTS_DIR }), 'ensure-inquiry-rows').args,
    ['--date', 'yesterday', '--commit', '--evidence', ARTIFACTS_DIR],
    '证据目录给了才带 --evidence（由它决定收据落在哪；不给时由脚本挑兜底目录）');
  assert.deepEqual(stepOf(buildJobPlan({ shops: ['科塔淘宝'] }), 'ensure-inquiry-rows').args,
    ['--date', 'yesterday', '--shops', '科塔淘宝', '--commit'],
    '点名了只跑某几家时，建行也要收窄 —— 否则一次排查会顺手在飞书里多建 12 行');
  // 不点名时**不给** `--shops`：由脚本按全部登记店自己枚举（口径见脚本文件头）。
  assert.equal(stepOf(buildJobPlan(), 'ensure-inquiry-rows').args.includes('--shops'), false);
});

test('补行骨架：--no-ensure-inquiry-rows 一键退回（只少这一步，其余逐字不变）', () => {
  const off = buildJobPlan({ ensureInquiryRows: false, artifactsDir: ARTIFACTS_DIR });
  assert.equal(off.ensureInquiryRowsStep, null);
  assert.equal(off.steps.some((s) => s.name === 'ensure-inquiry-rows'), false);
  assert.deepEqual(off.steps.map((s) => s.name),
    ['ensure-instances', 'label-merchant-window', 'login-preflight', 'ensure-merchant-login', 'chain']);
  // 分批形态同样能关（否则「一键退回」在生产形态上不成立）。
  assert.equal(buildJobPlan({ batches: 5, ensureInquiryRows: false }).steps
    .some((s) => s.name === 'ensure-inquiry-rows'), false);
});

test('接线（源码级）：真实调用点真的把 ensureInquiryRows 透传进计划（漏传是静默的）', () => {
  // 同 merchantLabel 那条：纯函数给得再对，入口不把开关交给它，那一步就永远不进计划，
  // 而日志里只表现为「少一行」—— 这正是本条要治的形态（功能建了、没接上）。
  const source = readFileSync(new URL('../scripts/run-daily-job.mjs', import.meta.url), 'utf8');
  assert.match(source, /ensureInquiryRows:\s*options\.ensureInquiryRows/u,
    '入口没有把 ensureInquiryRows 交给 buildJobPlan ⇒ 飞书询单表的行骨架永远补不上');
  assert.match(source, /'--no-ensure-inquiry-rows'/u,
    '入口没有解析 --no-ensure-inquiry-rows ⇒ 运维没有一键退回的开关');
});

test('分批那一档：整轮的逐店预检**不进计划**，结论交接全在分批驱动内部完成', () => {
  const plan = buildJobPlan({ batches: 2, artifactsDir: ARTIFACTS_DIR });
  // 这一步带 `--login` 时必然白跑（店铺实例要等各批自己的 `start` 才起）—— 见计划里那段长注释。
  assert.equal(plan.steps.some((s) => s.name === 'login-preflight'), false,
    '分批档里不该有整轮的逐店预检：那一刻 12 家店的调试端口一个都没开');
  // 这里生成的那份没有任何人读 —— 而「写了没人读的文件」正是后来人会照着接错的地方。
  assert.equal(plan.steps.some((s) => s.artifactPath), false, '分批档里不生成结论文件');
  // run-batches.mjs 自己不认这个参数，给了会当场报未知参数（比静默无效更难查）。
  assert.equal(stepOf(plan, 'batch-chain').args.includes(LOGIN_PREFLIGHT_FLAG), false);
  // 逐批那份结论由分批驱动自己生成（见下面「宿主（分批链）也接上了」那条真跑判据）。
  assert.deepEqual(plan.steps.map((s) => s.name),
    ['ensure-instances', 'label-merchant-window', 'ensure-merchant-login', 'ensure-inquiry-rows', 'batch-chain']);
});

// ---------------------------------------------------------------------------
// 分批**真的只起这一批**（2026-09-30 修的那个缺陷）。
//
// 缺陷形态：`--batches` 只把**链**切成批，而第 ① 步照旧 `start-all.mjs`（**全部**登记实例：
// 13 家店 ＋ 竞品链）⇒ 峰值仍是一次全起，分批「省内存」一分没省、峰值与从前逐字相同 ——
// 而省内存正是分批存在的唯一理由（batch-plan.mjs 文件头：瓶颈是内存，「同时开着几个实例」
// 才是旋钮）。实测：那一轮第 0 步之后，28 个店铺端口全在（当天 12/12 家失败的轮次也在）。
// ---------------------------------------------------------------------------
test('分批形态：第 ① 步**只起共享实例**，一个店铺实例都不点名（否则分批等于没分）', () => {
  const args = argsOf(buildJobPlan({ batches: 5 }), 'ensure-instances');
  assert.deepEqual(args, ['--only', SHARED_INSTANCE_KEYS.join(',')],
    '共享实例名单只有一份（batch-plan.mjs 的 SHARED_INSTANCE_KEYS），不许在这里再写第二遍');
  for (const shop of collectingShopKeys()) {
    assert.equal(args.includes(shop), false, `分批形态的第 ① 步不许点名店铺实例：${shop}`);
  }
  // 对比：不分批那一档仍然一次起齐 —— 那是它的语义，不许被这次改动顺手改掉。
  assert.deepEqual(argsOf(buildJobPlan(), 'ensure-instances'), []);
});

test('分批形态：整轮的逐店预检不进计划（那一刻店铺实例一个都没起）', () => {
  const names = buildJobPlan({ batches: 5 }).steps.map((s) => s.name);
  assert.equal(names.includes('login-preflight'), false,
    '整轮逐店预检在分批形态下必然白跑（12 家全报「连不上调试端口」），权威的是逐批那一条');
  // 不分批那一档照旧保留它（那时实例确实都起来了，前提成立）。
  assert.equal(buildJobPlan().steps.map((s) => s.name).includes('login-preflight'), true);
});

test('接线判据：两个宿主真的把结论接上了（防「函数全绿、没人调」）', () => {
  // 为什么单独立一条：计划那一侧的判据全绿而宿主漏传时，症状是静默的 ——
  // 告警照发，只是永远说「这一轮没有先查登录态」，于是这条修复在真机上等于没做。
  const job = readFileSync(path.join(REPO_ROOT, 'scripts', 'run-daily-job.mjs'), 'utf8');
  assert.match(job, /artifactsDir/u, '宿主没把本轮证据目录交给计划 ⇒ 链永远读不到结论');
  assert.match(job, /artifactPath/u, '宿主没把体检的 stdout 落成文件 ⇒ 链那一步读的是一个不存在的路径');

  const batches = readFileSync(path.join(REPO_ROOT, 'scripts', 'run-batches.mjs'), 'utf8');
  assert.match(batches, /buildLoginPreflightStep/u, '分批链没把登录守卫那一步接进去');
  assert.match(batches, /LOGIN_PREFLIGHT_FLAG/u, '分批链没把结论传给每一批的链');
  assert.match(batches, /artifactPath/u);
  assert.match(batches, /JOB_FILES/u, '两个宿主必须共用同一份「跑哪个文件」的定义（各写一份就会漂）');
});

test('跑前登录态体检的参数只有一个来源（两个宿主共用，不许各写一份）', () => {
  assert.deepEqual(buildLoginPreflightArgs({}), []);
  assert.deepEqual(buildLoginPreflightArgs({ shops: ['科塔淘宝'] }), ['--shops', '科塔淘宝']);
  assert.deepEqual(buildLoginPreflightArgs({ json: true }), ['--json']);
  assert.deepEqual(buildLoginPreflightArgs({ shops: ['里可林淘宝', '科塔淘宝'], json: true }),
    ['--shops', '里可林淘宝,科塔淘宝', '--json']);
  // 默认**不带** `--login`：这个纯函数的默认必须是最不伤人的那一种（不带它＝只读）。
  // 「碰页面」这件事由调用点显式说 —— 打开它的两个调用点都是自动化入口。
  assert.ok(!buildLoginPreflightArgs({ json: true }).includes('--login'),
    '不给 login 时不许自作主张带上 --login');
  assert.deepEqual(buildLoginPreflightArgs({ login: true, json: true }), ['--login', '--json']);
  assert.deepEqual(buildLoginPreflightArgs({ login: true, shops: ['科塔淘宝'], json: true }),
    ['--login', '--shops', '科塔淘宝', '--json']);
  // 开关名只能是 `--login`（check-login-shops 自己的入口开关）。
  // **不许**把 `--commit` 直接透给它：那是 login-merchant.mjs 的参数，
  // check-login-shops 收到它会当场按「未知参数」退 4（而 4 与「掉登录」是两个码）——
  // 这种错在日志里长得像「参数打错了」，实际后果是整条守卫一步都没跑。
  assert.ok(!buildLoginPreflightArgs({ login: true, json: true }).includes('--commit'),
    '--commit 是子脚本的参数，不该出现在这一层的命令行上');
  assert.match(JOB_FILES.loginPreflight, /check-login-shops\.mjs$/u);
});

// ---------------------------------------------------------------------------
// 共享商家浏览器登录守卫（2026-09-25 加）。
//
// 为什么值得单独立判据：这一步没接上时的症状是**最贵的那一种** —— 链的整轮级体检跑在这台
// 共用实例上，它一掉登录，驱动的处置是「商家浏览器体检未通过 ⇒ 整轮不跑」⇒ 五家店一家都不出数，
// 而此前**没有任何一步**会给它补登录（逐店的 `--login` 打不到共用实例上）。
// 实测凭据：`evidence/daily-job-2026-09-24/job.log` 08:16 那一轮
// （`[一轮] 归位后仍不齐（生意参谋工作页=0 飞书底单页=1）` → 整轮不跑）。
// ---------------------------------------------------------------------------
test('共享实例守卫：只盯生意参谋、默认只读、告警默认不投递', () => {
  assert.equal(MERCHANT_LOGIN_SITE, 'sycm');
  // 默认（调用方不点名）必须是**只读**档：不许自作主张去提交登录表单。
  assert.deepEqual(buildMerchantLoginGuardArgs({}), ['--check-only', '--target', 'sycm', '--notify', 'off']);
  assert.deepEqual(buildMerchantLoginGuardArgs({ login: true }),
    ['--commit', '--target', 'sycm', '--notify', 'off']);
  // 第 ③ 条不变量（告警默认只落日志、不投递）在这一步上的形态：`login-merchant.mjs` 自己的
  // `--notify` 默认值是 `auto`（真的去登了没成就会投递），所以这个纯函数**必须显式写 off** ——
  // 漏了它，一个「没给 --notify」的定时任务会悄悄往飞书发一条消息，而链那侧的用例看不出来。
  for (const args of [buildMerchantLoginGuardArgs({}), buildMerchantLoginGuardArgs({ login: true })]) {
    assert.equal(args[args.indexOf('--notify') + 1], 'off', '不许落到 login-merchant 的默认 auto');
  }
  // 跟着整轮走：整轮要发时这一步也才允许发（口径由 login-merchant 自己定：真登过 + 确定要人）。
  assert.deepEqual(buildMerchantLoginGuardArgs({ login: true, notify: true }),
    ['--commit', '--target', 'sycm', '--notify', 'auto']);
  // 反向：只读档**不许**跟着整轮变成 auto —— 没去登就不许叫人（与 check-login-shops 同一纪律）。
  const readOnly = buildMerchantLoginGuardArgs({ notify: true });
  assert.equal(readOnly[readOnly.indexOf('--notify') + 1], 'off');
});

test('共享实例守卫：用自己那个脚本，且排在逐店预检之后、链之前', () => {
  assert.match(JOB_FILES.merchantLogin, /login-merchant\.mjs$/u);
  // 它是**单机脚本**，不是逐店体检那条：混起来会让「查五家」的命令去打共用实例
  // （`check-login-shops.mjs` 明确不覆盖共用实例，见它文件头那段「刻意不查」）。
  assert.doesNotMatch(JOB_FILES.merchantLogin, /check-login-shops/u);
  const names = buildJobPlan().steps.map((s) => s.name);
  assert.ok(names.indexOf('ensure-merchant-login') > names.indexOf('login-preflight'),
    '排在逐店预检之前会把两次登录提交的距离压得更近（同一账号 + 同一出口 IP）');
  assert.ok(names.indexOf('ensure-merchant-login') < names.indexOf('chain'),
    '排在链之后等于没做：链的整轮级体检已经因为这台实例掉登录而「整轮不跑」了');
  // 整轮最多一次登录提交：这一步在计划里只出现一次（分批形态也不许被复制进每一批）。
  assert.equal(names.filter((name) => name === 'ensure-merchant-login').length, 1);
  assert.equal(buildJobPlan({ batches: 2 }).steps.filter((s) => s.name === 'ensure-merchant-login').length, 1);
});

// ---------------------------------------------------------------------------
// 驻留 → 自动续跑（2026-09-26 加）。
//
// 用户原话：「碰到广告能自动关闭就自动关闭，如果关不了就要转人工，同时不要关闭浏览器，
// 这样人工才能接管，当人工关闭完广告后，系统要能识别并续跑」。
// 判据的重心不在「驻留」这个词，而在两件会被静默做错的事：
//   ① 链**成功**的那一天，这一步一个字都不许影响（默认行为逐字不变）；
//   ② 「系统会自己接着跑」这句承诺，只有在真的有驻留进程时才许说出去。
// ---------------------------------------------------------------------------
test('宿主（定时链）：驻留那一步真的接上了，且排在链之后', () => {
  const text = runHostPrint('run-daily-job.mjs', ['--date', '2026-09-22']);
  const lines = text.split('\n');
  const chainLine = lines.findIndex((line) => line.includes('run-multi-shop-day.mjs'));
  const holdLine = lines.findIndex((line) => line.includes('scripts\\hold-and-resume.mjs'));
  assert.ok(chainLine !== -1, `没找到链那一步：\n${text}`);
  assert.ok(holdLine !== -1, `驻留那一步没接上 —— 「留窗口给人」一次也不会发生：\n${text}`);
  assert.ok(holdLine > chainLine, '驻留必须排在链之后（它读的就是链写下的那份结论）');
  // 结论路径必须是**这一天**的（给字面量 yesterday 会拼出一个不存在的路径 ⇒ 它只会判「读不到」）。
  const summaryPath = path.join(REPO_ROOT, 'evidence', 'multi-shop-2026-09-22', 'summary.json');
  assert.ok(text.includes(`--summary ${summaryPath}`), `结论路径不对：\n${text}`);
  // 告警出口默认不投递：整轮没给 --notify ⇒ 这一步也必须是 --no-notify
  //（与共享实例守卫压成 `--notify off` 是同一条纪律，见本文件「三个不变量」的第 ③ 条）。
  assert.ok(text.includes('hold-and-resume.mjs --date 2026-09-22 --summary') && text.includes('--no-notify'),
    `驻留那一步的告警出口应当是 --no-notify：\n${text}`);
});

test('宿主（定时链）：只有「真有驻留」时，链的告警才敢承诺「系统会自己接着跑」', () => {
  // 链的 `ACTION_BY_CAUSE` 在两类「要人处理」的结论里，带 `--will-resume` 时写
  // 「做完不用回复、系统会自己接着跑」，不带时写「告诉技术同学重跑一次」。
  // 手工直接跑链没有驻留 ⇒ 那种情况下承诺就是一句兑现不了的假话。
  assert.match(runHostPrint('run-daily-job.mjs', ['--date', '2026-09-22']),
    /run-multi-shop-day\.mjs .*--will-resume/u, '有驻留却不告诉链 ⇒ 告警会叫人去回复/重跑');
  assert.doesNotMatch(runHostPrint('run-daily-job.mjs', ['--date', '2026-09-22', '--no-hold']),
    /--will-resume/u, '--no-hold 时不许还承诺「系统会自己接着跑」');
});

test('宿主（定时链）：--no-hold 一键退回旧行为（一个字符都不多）', () => {
  const text = runHostPrint('run-daily-job.mjs', ['--date', '2026-09-22', '--no-hold']);
  assert.doesNotMatch(text, /hold-and-resume\.mjs/u, '--no-hold 之后计划里不该再有那一步');
  // 但链那一步照旧（退回的只是「驻留」，不是「跑链」）。
  assert.match(text, /run-multi-shop-day\.mjs --date 2026-09-22 --commit/u);
});

test('宿主（定时链）：分批那一档的驻留**在分批驱动内部**，`--print` 必须把这件事说出来', () => {
  // 2026-09-26~10-06 之间这一档是「刻意不驻留」的缺口。补上之后：驻留落在分批驱动内部
  // （被挡的那一批就地收手 → 转 hold-and-resume），所以计划里**看不到**那一步是对的 ——
  // 但它不能与「分批这一档根本没驻留」长得一样，否则读 `--print` 的人会得出错误结论。
  const text = runHostPrint('run-daily-job.mjs', ['--date', '2026-09-22', '--batches', '2']);
  assert.doesNotMatch(text, /hold-and-resume\.mjs/u, '它不该作为本计划的一步出现');
  assert.doesNotMatch(text, /--will-resume/u, '链那一步不该承诺「系统会自己续跑」');
  assert.match(text, /驻留\*\*在分批驱动内部\*\*/u, '落点要说出来');
  assert.match(text, /--no-hold/u, '一键退回的开关也要说出来');
  // 关掉之后必须说「不驻留」，不能两种状态打同一句话。
  const off = runHostPrint('run-daily-job.mjs', ['--date', '2026-09-22', '--batches', '2', '--no-hold']);
  assert.match(off, /不驻留/u);
  assert.doesNotMatch(off, /驻留\*\*在分批驱动内部\*\*/u);
});

// 上面那些源码扫描与纯函数判据只能证明「字符串在那儿」。真正要守的是「宿主跑起来之后」——
// 所以下面几条**真跑一遍那个入口**（`--print` 不起任何进程、不碰浏览器、不写飞书）。
// 期望路径由本文件的 `import.meta.dirname` 推出来，不写死盘符：换机器照样成立。
const runHostPrint = (script, args) => {
  // `stdio` 必须显式写、且 stdin 只能是 `'ignore'`（2026-09-25，同 CHANGELOG 1.7.1）：
  // 不写 stdio 时默认「三根都是管道」，而本机宿主沙箱对「给子进程管道 stdin 的同步 spawn」
  // 直接回 EBUSY（`status=null`）⇒ 下面三条会以 `null !== 0` **假红**，
  // 把「宿主掐断了子进程」报成「接线断了」。
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', script), '--print', ...args],
    { encoding: 'utf8', cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  // 失败信息里必须带上 `error`：子进程**根本没起来**时 stderr 是空的，
  // 只报 stderr 的话这一条会显示成 `没跑成：undefined`，读日志的人看不出成因。
  assert.equal(result.status, 0,
    `${script} --print 没跑成：status=${result.status} error=${result.error?.message ?? 'none'} stderr=${result.stderr}`);
  return result.stdout;
};

test('宿主（定时链）真的把结论接上了：--print 里那条链命令带着 --login-preflight', () => {
  const text = runHostPrint('run-daily-job.mjs', ['--date', '2026-09-22']);
  const expected = path.join(REPO_ROOT, 'evidence', 'daily-job-2026-09-22', 'login-preflight.json');
  assert.ok(text.includes(`--login-preflight ${expected}`),
    `链那一步没拿到结论路径 —— 告警会永远说「这一轮没有先查登录态」。实际输出：\n${text}`);
  // 体检那一步必须出 JSON（不出就没有结论可以交；`--json` 只在有人接的时候才加），
  // 而且**默认带着 `--login`** —— 2026-09-23 起这一步同时是「跑前登录守卫」：
  // 掉登录的当场自己登一次（用户明确授权的自动登录），没成才叫人。
  assert.match(text, /check-login-shops\.mjs --login --json/u,
    `跑前那一步默认应当会自己登（带 --login）。实际输出：\n${text}`);
  // 这一步现在有**两个**副作用：碰页面（登录）＋ 发飞书（登不进去时）。第二件是本版新加的，
  // 而 `--print` 是运维在真跑之前唯一能核对的东西 ⇒ 它必须预告「会发告警」，
  // 否则人只知道自己被授权了自动登录，不知道自己（和收件人）还会收到一条消息。
  assert.match(text, /飞书告警/u,
    `跑前守卫的说明里必须预告「登不进去会发飞书告警」。实际输出：\n${text}`);
  // 顺序不能反：结论要在链**之前**产生。
  assert.ok(text.indexOf('check-login-shops.mjs') < text.indexOf('--login-preflight'),
    '结论必须在链开跑之前就写好，否则链读到的永远是上一轮的那份');
  // 2026-09-25 加的共享实例守卫：默认（不给 --no-auto-login 时）**必须真的去登** ——
  // 这一条是本轮修复的判据本体：它不登，链的整轮级体检就会让五家店一家都不开跑。
  // 同时钉住告警出口：整轮没给 --notify ⇒ 这一步必须是 `off`（不许悄悄投递）。
  assert.match(text, /login-merchant\.mjs --commit --target sycm --notify off/u,
    `共享商家浏览器守卫没接上（或告警出口没跟着整轮走）。实际输出：\n${text}`);
  // 它必须排在链**之前**：链的整轮级体检第一名就是它。
  assert.ok(text.indexOf('login-merchant.mjs') < text.lastIndexOf('run-multi-shop-day.mjs'),
    '共享实例守卫必须排在链之前，否则链体检时它还没登');
});

test('宿主（定时链）：--no-auto-login 退回只读体检（一个页面都不碰）', () => {
  const text = runHostPrint('run-daily-job.mjs', ['--date', '2026-09-22', '--no-auto-login']);
  // 结论仍然要交（`--json` 不能跟着一起丢）：关掉的只是「去登」，不是「交结论」。
  assert.match(text, /check-login-shops\.mjs --json/u, `--no-auto-login 之后那一步不该再带 --login：\n${text}`);
  assert.ok(!/check-login-shops\.mjs .*--login\b/u.test(text),
    `--no-auto-login 是显式静音，不许还留着 --login：\n${text}`);
  // 打印出来的说明也必须跟着开关改：`--print` 是人用来确认「将要执行什么」的唯一凭据，
  // 那里写着「只读」而实际会提交表单，就是本仓库反复在治的那种不一致。
  //
  // 2026-09-23 晚改：这一条**不再把旧文案逐字钉住**（原判据钉到闭括号为止，
  // 于是往文案里补一句真话就把它打红 —— 而补的那句恰好是本轮要的答案）。
  // 改成钉**语义**：只读档必须同时说清两件事 —— ①不开页面、不点东西；②**也不发任何告警**。
  // ②是用户第二问「登录不了为什么没有飞书提醒」的直接答案：把「为什么群里没动静」
  // 写在明面上，人才不会以为线断了。这两条任何一条丢了，说明档位与行为脱节了。
  assert.match(text, /跑前登录态体检（只读：不开页面、不点东西/u, `说明没跟着开关走：\n${text}`);
  assert.match(text, /不发任何告警/u, `只读档必须明说它不会发告警：\n${text}`);
  // 反面：只读档的说明里不许出现「会发飞书」那种承诺（说了发而实际不发 = 线断了的另一种样子）。
  assert.ok(!/飞书告警/u.test(text.split('\n').filter((l) => l.includes('login-preflight')).join('\n')),
    `--no-auto-login 这一档不许预告会发飞书：\n${text}`);
  // 共享实例守卫也要跟着退回只读档 —— 一个 `--no-auto-login` 不许只关掉一半的自动登录。
  assert.match(text, /login-merchant\.mjs --check-only --target sycm --notify off/u,
    `--no-auto-login 之后共享实例守卫应当退回只读档：\n${text}`);
});

test('宿主（分批链）也接上了：每一批的链各读**本批**那份结论，且守卫排在本批 start 之后', () => {
  const size = 2;
  // 切批＝参与采集的店铺顺序、每批 `size` 家。这里**从采集名单推**，不写死「2+2+1」：
  // 写死的话每加一家店这条用例都会红一次，而它真正要守的是「每批各读自己那份结论」
  // 与「登录守卫的位置」，与总家数无关。
  // 2026-09-30：分母从 `shopBrowserKeys()` 改成 `collectingShopKeys()` —— 分批层认的是
  // 「参与采集」那一侧（登记表里还有一家没开始收集的空店，它不切进任何一批）。
  const groups = [];
  const all = collectingShopKeys();
  for (let i = 0; i < all.length; i += size) groups.push(all.slice(i, i + size));
  const text = runHostPrint('run-batches.mjs', ['--date', '2026-09-22', '--batch-size', String(size)]);
  const dir = path.join(REPO_ROOT, 'evidence', 'batches-2026-09-22');
  const chainLines = text.split('\n').filter((line) => /run-multi-shop-day\.mjs/u.test(line));
  assert.equal(chainLines.length, groups.length, `每批 ${size} 家 ⇒ ${groups.length} 批，实际扫到 ${chainLines.length} 条链命令`);

  // 2026-09-23 晚改：结论**逐批一份**（`login-preflight-b<N>.json`），不再三批共用一份。
  // 共用一个名字时，后一批的结论会盖掉前一批 —— 而本批的链读到的仍然是「某个存在的文件」，
  // 于是「这一批的链看的是另一批的登录态」在日志里完全看不出来。
  const seen = new Set();
  chainLines.forEach((line, i) => {
    const match = line.match(/--login-preflight (\S+)/u);
    assert.ok(match, `这一批的链没拿到结论：${line}`);
    const expected = path.join(dir, `login-preflight-b${i + 1}.json`);
    assert.equal(match[1], expected, `第 ${i + 1} 批读的不是本批那份结论：${line}`);
    seen.add(match[1]);
  });
  assert.equal(seen.size, chainLines.length, `${groups.length} 批读的是同一份结论 —— 共用名字正是要治的那个病`);

  // 顺序：登录守卫必须排在**本批 start 之后**、chain 之前。
  // 2026-09-23 实测（batches.log 13:29:27）：排在 start 之前 ⇒ 五个实例还没起 ⇒
  // 五家店代理全回 HTTP 500 ⇒ 自动登录一次机会都没有，而表面上只看到一句「不是全在登录态」。
  const lineOf = (needle) => text.split('\n').findIndex((line) => line.includes(needle));
  for (const group of groups) {
    const shops = group.join(',');
    const start = lineOf(`start-all.mjs --only ${shops}`);
    const login = lineOf(`check-login-shops.mjs --login --shops ${shops} --json`);
    const chain = lineOf(`run-multi-shop-day.mjs --date 2026-09-22 --shops ${shops}`);
    assert.ok(start !== -1 && login !== -1 && chain !== -1, `这一批的三行没找齐：${shops}`);
    assert.ok(start < login, `登录守卫排在 start 之前（实例还没起，只会读到 HTTP 500）：${shops}`);
    assert.ok(login < chain, `登录守卫排在链之后（链读不到结论）：${shops}`);
  }
  // 每批一份结论 ⇒ 打印里必须逐批给出它的落点（`--print` 是人确认「将要执行什么」的唯一凭据）。
  for (let i = 1; i <= groups.length; i += 1) {
    assert.ok(text.includes(`结论落：evidence/batches-2026-09-22/login-preflight-b${i}.json`),
      `第 ${i} 批的结论落点没打印出来：\n${text}`);
  }
  // 释放口径（2026-09-23 用户第二次拍板）：打印出来的必须是「跑完释放」，不许还是旧的「失败不释放」。
  assert.match(text, /跑完释放/u, `打印的释放口径不对：\n${text}`);
  assert.doesNotMatch(text, /失败不主动释放|跑成才停/u, `还留着旧口径的说法：\n${text}`);
});

// ---------------------------------------------------------------------------
// agent 修复回环的开关透传（2026-09-29 加）
//
// 为什么这两条必须有：`autoLogin` 那次漏接就是同一个形态 —— 计划里加了参数、
// 入口忘了传，结果「本该去登却永远不登」，而日志里长得完全正常。
// 这里用两条把两个方向都钉住：**打开时要到得了链**、**不打开时逐字不变**。
// ---------------------------------------------------------------------------
test('--auto-repair 打开时，链那一步拿到 --auto-repair（透传对了方向）', () => {
  const plan = buildJobPlan({ autoRepair: true });
  const args = argsOf(plan, 'chain');
  assert.ok(args.includes('--auto-repair'), `链那一步必须拿到 --auto-repair，实际：${args.join(' ')}`);
});

test('--auto-repair 不开时，链那一步**逐字**不含它（默认关闭是硬保证）', () => {
  const plan = buildJobPlan();
  assert.doesNotMatch(argsOf(plan, 'chain').join(' '), /--auto-repair/u,
    '默认关闭这件事必须在渲染结果里看得见，不能只在注释里');
});

test('--auto-repair-max-rounds 带上值时透传，值为 0 时不透传（0 等于关，不发一个空开关）', () => {
  assert.match(argsOf(buildJobPlan({ autoRepair: true, autoRepairMaxRounds: 3 }), 'chain').join(' '),
    /--auto-repair-max-rounds 3/u);
  assert.doesNotMatch(argsOf(buildJobPlan({ autoRepair: true, autoRepairMaxRounds: 0 }), 'chain').join(' '),
    /--auto-repair-max-rounds/u);
});

test('真实入口 run-daily-job.mjs 确实把 autoRepair 传进了计划（漏接是静默的）', () => {
  // 这是 `autoLogin` 那条教训的复用：计划侧写了、入口忘了传 ⇒ 什么都没发生且没人知道。
  // 所以判据落在**入口源码**上 —— 它必须出现 `autoRepair: options.autoRepair`。
  const src = readFileSync(path.join(REPO_ROOT, 'scripts/run-daily-job.mjs'), 'utf8');
  assert.match(src, /autoRepair: options\.autoRepair/u, '入口必须把 autoRepair 传给 buildJobPlan');
  assert.match(src, /autoRepairMaxRounds: options\.autoRepairMaxRounds/u, '入口必须把配额也传下去');
  assert.match(src, /autoRepair: false/u, '入口的默认值必须是关（这条路径会真的动页面）');
});

// ---------------------------------------------------------------------------
// ★ 分批形态（**生产路径**）的自动修复透传（2026-09-29 补）
//
// 上面那三条只覆盖 `chain` 那一段（不分批）。而定时任务跑的是 `--batches 5` ⇒ 走的是
// `buildBatchChainArgs` → `scripts/run-batches.mjs` → 链，**另一条参数链**。
// 实测这一条曾经断在中间：`run-daily-job.mjs` 收下了 `--auto-repair`，
// 但 `buildBatchChainArgs` 不认它 ⇒ **生产形态下「脚本自己修」永远不执行**，
// 日志里一个字都不提示。这几条把整条链的两跳都钉住。
// ---------------------------------------------------------------------------
test('分批形态：--auto-repair 打开时，batch-chain 那一步拿到 --auto-repair', () => {
  const plan = buildJobPlan({ dateInput: 'yesterday', batches: 5, autoRepair: true, resolvedDate: '2026-09-28', artifactsDir: 'evidence/daily-job-2026-09-28' });
  const step = plan.steps.find((s) => s.name === 'batch-chain');
  assert.ok(step, '分批形态必须用 batch-chain 这一步');
  assert.ok(step.args.includes('--auto-repair'), `batch-chain 必须拿到 --auto-repair，实际：${step.args.join(' ')}`);
});

test('分批形态：--auto-repair 不开时，batch-chain **逐字**不含它（默认不变）', () => {
  const plan = buildJobPlan({ dateInput: 'yesterday', batches: 5, resolvedDate: '2026-09-28', artifactsDir: 'evidence/daily-job-2026-09-28' });
  const step = plan.steps.find((s) => s.name === 'batch-chain');
  assert.doesNotMatch(step.args.join(' '), /--auto-repair/u, '默认关闭必须在不分批形态之外也成立');
});

test('分批形态：--auto-repair-max-rounds 带上值时透传（第二跳的 valued 参数）', () => {
  const plan = buildJobPlan({ dateInput: 'yesterday', batches: 5, autoRepair: true, autoRepairMaxRounds: 2, resolvedDate: '2026-09-28', artifactsDir: 'evidence/daily-job-2026-09-28' });
  const step = plan.steps.find((s) => s.name === 'batch-chain');
  assert.match(step.args.join(' '), /--auto-repair-max-rounds 2/u);
});

// --- ⑨b：告警闸门开关也要走完两跳（2026-09-29 补）------------------------------
//
// `--auto-repair` 那次实测断在第二跳（`buildBatchChainArgs` 不认它），症状是
// 「命令行给了、生产形态下永远不生效」。新开关走的是同一条链，用同一组判据钉住。
test('分批形态：--defer-agent-actionable-alert 打开时，batch-chain 那一步拿到它', () => {
  const plan = buildJobPlan({ dateInput: 'yesterday', batches: 5, deferAgentActionableAlert: true, resolvedDate: '2026-09-28', artifactsDir: 'evidence/daily-job-2026-09-28' });
  const step = plan.steps.find((s) => s.name === 'batch-chain');
  assert.ok(step, '分批形态必须用 batch-chain 这一步');
  assert.ok(step.args.includes('--defer-agent-actionable-alert'),
    `batch-chain 必须拿到 --defer-agent-actionable-alert，实际：${step.args.join(' ')}`);
});

test('分批形态：不带它时 batch-chain **逐字**不含它（默认不变）', () => {
  const plan = buildJobPlan({ dateInput: 'yesterday', batches: 5, resolvedDate: '2026-09-28', artifactsDir: 'evidence/daily-job-2026-09-28' });
  const step = plan.steps.find((s) => s.name === 'batch-chain');
  assert.doesNotMatch(step.args.join(' '), /--defer-agent-actionable-alert/u, '默认关闭必须在不分批形态之外也成立');
});

test('第二跳：scripts/run-batches.mjs 认 --defer-agent-actionable-alert 并转发给链（源码判据）', () => {
  const src = readFileSync(path.join(REPO_ROOT, 'scripts', 'run-batches.mjs'), 'utf8');
  assert.match(src, /arg === '--defer-agent-actionable-alert'/u, 'run-batches 必须接受它');
  assert.match(src, /if \(options\.deferAgentActionableAlert\) args\.push\('--defer-agent-actionable-alert'\)/u,
    'run-batches 必须把它转发给链 —— 不转发就是「给了开关、生产形态下每批都没生效」');
});

test('第三跳：scripts/run-daily-job.mjs 收下它并透传进计划（源码判据）', () => {
  const src = readFileSync(path.join(REPO_ROOT, 'scripts', 'run-daily-job.mjs'), 'utf8');
  assert.match(src, /arg === '--defer-agent-actionable-alert'/u, 'run-daily-job 必须接受它');
  assert.match(src, /deferAgentActionableAlert: options\.deferAgentActionableAlert/u, '必须透传进计划');
});

test('第二跳：scripts/run-batches.mjs 认 --auto-repair 并把它转发给链（源码判据）', () => {
  // 第一跳（plan → run-batches）在上一组里已经用 args 断言过了；
  // 这一条盯第二跳（run-batches → run-multi-shop-day）—— 只改第一跳、第二跳不认它，
  // 症状仍然是「给了开关、链收不到」，而且报的是「未知参数」被当失败。
  const src = readFileSync(path.join(REPO_ROOT, 'scripts/run-batches.mjs'), 'utf8');
  assert.match(src, /arg === '--auto-repair'/u, 'run-batches 必须接受 --auto-repair');
  assert.match(src, /if \(options\.autoRepair\) args\.push\('--auto-repair'\)/u,
    'run-batches 必须把它转发给链');
  assert.match(src, /options\.autoRepairMaxRounds/u, '配额也要转发');
});

