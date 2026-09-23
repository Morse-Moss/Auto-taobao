// daily-job-plan.mjs 的离线判据。
//
// 这份计划的三条不变量都由本文件钉住（每条的代价都是「在没人的时候做错事」）：
//   ① 日期只有一种给法（`--date yesterday`，不写死日期）；
//   ② 历史日的降级开关不许顺手打开；
//   ③ 告警默认只落日志、不投递 —— 一封半夜发出去的飞书比不提醒更糟（会训练人忽略这个通道）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { JOB_FILES, buildJobPlan, renderCommand, renderJobEntryCommand } from './daily-job-plan.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const argsOf = (plan, name) => plan.steps.find((s) => s.name === name).args;

test('三步的顺序是「先保证实例在 → 再看一眼登录态 → 再跑链」', () => {
  // 反过来（先跑链）时，链的第 0 步体检会整轮拦下并发一条**本可以不出**的告警；
  // 告警这个通道被无谓地用一次就少一次可信度。
  // 而登录态体检必须排在**起实例之后**：实例不在时它一个页面都读不到，只留下一片「读不到」。
  const plan = buildJobPlan();
  assert.deepEqual(plan.steps.map((s) => s.name), ['ensure-instances', 'login-preflight', 'chain']);
  assert.equal(plan.steps[0].blocking, false, '起实例失败不该阻断链：权威判据在链的体检里');
  // 登录态体检**不是闸门**：它的三个退出码只落进日志，不许拦住链 ——
  // 冷启动之后页面还没归位时它会判「没结论」，而那是链的归位会自己解决的事。
  assert.equal(plan.steps[1].blocking, false, '登录态体检不该阻断链（它不是「今天能不能写」的判据）');
  assert.equal(plan.steps[2].blocking, true);
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
test('不启用分批时，三步与从前**逐字相同**（默认关闭是硬保证，不是注释里的承诺）', () => {
  const plan = buildJobPlan();
  assert.equal(plan.batches, null);
  assert.deepEqual(plan.steps.map((s) => s.name), ['ensure-instances', 'login-preflight', 'chain']);

  // 逐字比较：跟上一次「没有分批这个概念」时渲染出来的那三行比。
  // 用固定期望值而不是「再跑一次自己」，否则这类断言永远绿（自己等于自己）。
  const render = (p) => p.steps.map((s) => renderCommand(s, { nodeExe: 'N', repoRoot: 'R' }));
  assert.deepEqual(render(plan), [
    'N R\\scripts\\start-all.mjs',
    'N R\\skills\\sycm-alimama-daily-report\\scripts\\check-login-shops.mjs',
    'N R\\skills\\sycm-alimama-daily-report\\scripts\\run-multi-shop-day.mjs --date yesterday --commit --notify-print',
  ]);
  assert.doesNotMatch(render(plan).join(' '), /run-batches\.mjs/u, '默认这一档里不许出现分批驱动');
});

test('启用分批：它**替换**链那一步（不是并排），参数只带分批驱动认得的那几个', () => {
  const plan = buildJobPlan({ batches: 2 });
  assert.equal(plan.batches, 2);
  assert.deepEqual(plan.steps.map((s) => s.name), ['ensure-instances', 'login-preflight', 'batch-chain'],
    '两条一起跑会让同一家店被驱动两次 —— 必须是替换关系');
  const step = plan.steps[2];
  assert.match(step.file, /scripts\/run-batches\.mjs$/u);
  assert.equal(step.blocking, true);
  assert.deepEqual(step.args, ['--date', 'yesterday', '--batch-size', '2', '--commit', '--notify-print']);
  // 链那边才认的开关不许漏进来：分批驱动没有 `--only`/`--logs`/`--downloads` 的概念
  assert.doesNotMatch(step.args.join(' '), /--only|--logs|--downloads/u);
});

test('启用分批时 `--commit` 必须显式传下去（漏了它就变成「排练」，而日志看不出异常）', () => {
  // 分批驱动自己的默认是排练（不写飞书）；定时任务的职责是写下今天的数据。
  // 这条是**静默降级**里最贵的一种：不报错、不告警、日志里那句「模式」也照旧。
  assert.ok(buildJobPlan({ batches: 2 }).steps[2].args.includes('--commit'),
    '定时形态必须带 --commit，否则整轮不写飞书而没人会发现');
});

test('启用分批：告警出口与降级开关照旧按需转发', () => {
  const plan = buildJobPlan({ batches: 3, notify: true, keepGoing: true });
  assert.deepEqual(plan.steps[2].args,
    ['--date', 'yesterday', '--batch-size', '3', '--commit', '--notify', '--keep-going']);
  assert.deepEqual(buildJobPlan({ batches: 3, shops: ['科塔淘宝'] }).steps[2].args,
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

