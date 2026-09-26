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
  buildLoginPreflightArgs, buildMerchantLoginGuardArgs, renderCommand, renderJobEntryCommand,
} from './daily-job-plan.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const argsOf = (plan, name) => plan.steps.find((s) => s.name === name).args;

test('四步的顺序是「先保证实例在 → 再看一眼登录态 → 再修共享实例的会话 → 再跑链」', () => {
  // 反过来（先跑链）时，链的第 0 步体检会整轮拦下并发一条**本可以不出**的告警；
  // 告警这个通道被无谓地用一次就少一次可信度。
  // 而登录态体检必须排在**起实例之后**：实例不在时它一个页面都读不到，只留下一片「读不到」。
  // 2026-09-25 加的第三步（共享商家浏览器守卫）也必须排在链之前：链的**整轮级体检**跑在
  // 那台实例上，它挂掉的处置是「整轮不跑」—— 守卫晚一步，五家店就一家都不开跑。
  const plan = buildJobPlan();
  assert.deepEqual(plan.steps.map((s) => s.name),
    ['ensure-instances', 'login-preflight', 'ensure-merchant-login', 'chain']);
  assert.equal(plan.steps[0].blocking, false, '起实例失败不该阻断链：权威判据在链的体检里');
  // 登录态体检**不是闸门**：它的三个退出码只落进日志，不许拦住链 ——
  // 冷启动之后页面还没归位时它会判「没结论」，而那是链的归位会自己解决的事。
  assert.equal(plan.steps[1].blocking, false, '登录态体检不该阻断链（它不是「今天能不能写」的判据）');
  assert.equal(plan.steps[2].blocking, false,
    '共享实例守卫也不是闸门：它没登成时，链自己那一次整轮级体检会如实报「整轮不跑」并告警');
  assert.equal(plan.steps[3].blocking, true);
});

test('登录态体检那一步：只读、且指定店铺时只体检那几家', () => {
  const args = argsOf(buildJobPlan(), 'login-preflight');
  // 一个参数都不给 ＝ 查登记表里全部五家（不是「什么都不查」）
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
test('不启用分批时，四步与从前**逐字相同**（默认关闭是硬保证，不是注释里的承诺）', () => {
  const plan = buildJobPlan();
  assert.equal(plan.batches, null);
  assert.deepEqual(plan.steps.map((s) => s.name),
    ['ensure-instances', 'login-preflight', 'ensure-merchant-login', 'chain']);

  // 逐字比较：跟上一次「没有分批这个概念」时渲染出来的那几行比。
  // 用固定期望值而不是「再跑一次自己」，否则这类断言永远绿（自己等于自己）。
  const render = (p) => p.steps.map((s) => renderCommand(s, { nodeExe: 'N', repoRoot: 'R' }));
  assert.deepEqual(render(plan), [
    'N R\\scripts\\start-all.mjs',
    'N R\\skills\\sycm-alimama-daily-report\\scripts\\check-login-shops.mjs',
    // 2026-09-25 新加的那一步：默认（`autoLogin` 未打开）必须是**只读档**，
    // 且 `--notify` 必须是 `off`（login-merchant 自己的默认值是 `auto`，会把告警投出去）。
    'N R\\skills\\sycm-alimama-daily-report\\scripts\\login-merchant.mjs --check-only --target sycm --notify off',
    'N R\\skills\\sycm-alimama-daily-report\\scripts\\run-multi-shop-day.mjs --date yesterday --commit --notify-print',
  ]);
  assert.doesNotMatch(render(plan).join(' '), /run-batches\.mjs/u, '默认这一档里不许出现分批驱动');
});

test('启用分批：它**替换**链那一步（不是并排），参数只带分批驱动认得的那几个', () => {
  const plan = buildJobPlan({ batches: 2 });
  assert.equal(plan.batches, 2);
  assert.deepEqual(plan.steps.map((s) => s.name),
    ['ensure-instances', 'login-preflight', 'ensure-merchant-login', 'batch-chain'],
    '两条一起跑会让同一家店被驱动两次 —— 必须是替换关系');
  const step = plan.steps[3];
  assert.match(step.file, /scripts\/run-batches\.mjs$/u);
  assert.equal(step.blocking, true);
  assert.deepEqual(step.args, ['--date', 'yesterday', '--batch-size', '2', '--commit', '--notify-print']);
  // 链那边才认的开关不许漏进来：分批驱动没有 `--only`/`--logs`/`--downloads` 的概念
  assert.doesNotMatch(step.args.join(' '), /--only|--logs|--downloads/u);
});

test('启用分批时 `--commit` 必须显式传下去（漏了它就变成「排练」，而日志看不出异常）', () => {
  // 分批驱动自己的默认是排练（不写飞书）；定时任务的职责是写下今天的数据。
  // 这条是**静默降级**里最贵的一种：不报错、不告警、日志里那句「模式」也照旧。
  assert.ok(buildJobPlan({ batches: 2 }).steps[3].args.includes('--commit'),
    '定时形态必须带 --commit，否则整轮不写飞书而没人会发现');
});

test('启用分批：告警出口与降级开关照旧按需转发', () => {
  const plan = buildJobPlan({ batches: 3, notify: true, keepGoing: true });
  assert.deepEqual(plan.steps[3].args,
    ['--date', 'yesterday', '--batch-size', '3', '--commit', '--notify', '--keep-going']);
  assert.deepEqual(buildJobPlan({ batches: 3, shops: ['科塔淘宝'] }).steps[3].args,
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
  assert.match(renderCommand(plan.steps[3], { nodeExe: 'N', repoRoot: 'R' }),
    /--login-preflight D:\\repo\\evidence\\daily-job-2026-09-22\\login-preflight\.json/u);
  // 它仍然**不是闸门**（这一步的结论丢了，链照样跑）。
  assert.equal(plan.steps[1].blocking, false);
});

test('不给证据目录时：不许凭空造一个路径，也不许给链加参数', () => {
  // 宁可不给，也不给一个指向别处的路径 —— 链那侧会把「读不到」如实说成
  // 「这一轮没有先查登录态」，而不是假装查过。
  assert.deepEqual(argsOf(buildJobPlan(), 'login-preflight'), []);
  assert.equal(argsOf(buildJobPlan(), 'chain').includes(LOGIN_PREFLIGHT_FLAG), false);
  assert.equal(buildJobPlan().steps.find((s) => s.name === 'login-preflight').artifactPath, undefined);
});

test('分批那一档：结论交接在分批驱动内部完成，这里不生成也不转发', () => {
  const plan = buildJobPlan({ batches: 2, artifactsDir: ARTIFACTS_DIR });
  // 这里生成的那份没有任何人读 —— 而「写了没人读的文件」正是后来人会照着接错的地方。
  assert.deepEqual(argsOf(plan, 'login-preflight'), [], '分批档里不生成 JSON');
  // run-batches.mjs 自己不认这个参数，给了会当场报未知参数（比静默无效更难查）。
  assert.equal(plan.steps[3].args.includes(LOGIN_PREFLIGHT_FLAG), false);
  // 但这一步**仍然跑**：它的报告进 job.log，是定时任务日志里唯一一条「整轮视角」的记录。
  // （逐批那份结论由分批驱动自己生成 —— 见下面「宿主（分批链）也接上了」那条真跑判据。）
  assert.deepEqual(plan.steps.map((s) => s.name),
    ['ensure-instances', 'login-preflight', 'ensure-merchant-login', 'batch-chain']);
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

test('宿主（定时链）：分批那一档**不驻留**，而且这件事在 --print 里被说出来（缺口要有名字）', () => {
  // 分批存在的理由就是「跑完一批就放掉、把内存让给下一批」，与「按住几家窗口几小时」冲突。
  const text = runHostPrint('run-daily-job.mjs', ['--date', '2026-09-22', '--batches', '2']);
  assert.doesNotMatch(text, /hold-and-resume\.mjs/u);
  assert.doesNotMatch(text, /--will-resume/u);
  assert.match(text, /不驻留/u, '缺口必须被打印出来，否则读 --print 的人以为它接上了');
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
  const text = runHostPrint('run-batches.mjs', ['--date', '2026-09-22', '--batch-size', '2']);
  const dir = path.join(REPO_ROOT, 'evidence', 'batches-2026-09-22');
  const chainLines = text.split('\n').filter((line) => /run-multi-shop-day\.mjs/u.test(line));
  assert.equal(chainLines.length, 3, `2+2+1 ⇒ 三批，实际扫到 ${chainLines.length} 条链命令`);

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
  assert.equal(seen.size, chainLines.length, '三批读的是同一份结论 —— 共用名字正是要治的那个病');

  // 顺序：登录守卫必须排在**本批 start 之后**、chain 之前。
  // 2026-09-23 实测（batches.log 13:29:27）：排在 start 之前 ⇒ 五个实例还没起 ⇒
  // 五家店代理全回 HTTP 500 ⇒ 自动登录一次机会都没有，而表面上只看到一句「不是全在登录态」。
  const lineOf = (needle) => text.split('\n').findIndex((line) => line.includes(needle));
  for (const shops of ['里可林淘宝,网林天猫', '盖文淘宝,盖文天猫', '科塔淘宝']) {
    const start = lineOf(`start-all.mjs --only ${shops}`);
    const login = lineOf(`check-login-shops.mjs --login --shops ${shops} --json`);
    const chain = lineOf(`run-multi-shop-day.mjs --date 2026-09-22 --shops ${shops}`);
    assert.ok(start !== -1 && login !== -1 && chain !== -1, `这一批的三行没找齐：${shops}`);
    assert.ok(start < login, `登录守卫排在 start 之前（实例还没起，只会读到 HTTP 500）：${shops}`);
    assert.ok(login < chain, `登录守卫排在链之后（链读不到结论）：${shops}`);
  }
  // 每批一份结论 ⇒ 打印里必须逐批给出它的落点（`--print` 是人确认「将要执行什么」的唯一凭据）。
  for (let i = 1; i <= 3; i += 1) {
    assert.ok(text.includes(`结论落：evidence/batches-2026-09-22/login-preflight-b${i}.json`),
      `第 ${i} 批的结论落点没打印出来：\n${text}`);
  }
  // 释放口径（2026-09-23 用户第二次拍板）：打印出来的必须是「跑完释放」，不许还是旧的「失败不释放」。
  assert.match(text, /跑完释放/u, `打印的释放口径不对：\n${text}`);
  assert.doesNotMatch(text, /失败不主动释放|跑成才停/u, `还留着旧口径的说法：\n${text}`);
});

