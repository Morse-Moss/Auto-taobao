// 分批层的离线判据。
//
// 为什么这些断言不能省（每一条都对应一个「静默漏做」的形态）：
//   · 切批覆盖不全 ⇒ 某一家**今天一步都没跑**，而整轮报「全绿」；
//   · 同一家出现在两批 ⇒ 同一家店被两个批次同时驱动（串店的现实版本）；
//   · 起/停名单不一致 ⇒ 停的时候少一家，那家**永远活着**，且没有任何一处会报错；
//   · 停那段没有 `--yes` ⇒ stop-all 默认只打印，「释放」变成一场打印；
//   · 命令里写死端口 ⇒ 换机器就悄悄连到别人的浏览器（坑 35「默认值即目标」）；
//   · 失败也释放 ⇒ 用户明确说的「失败优先解决问题，需要人工的就转人工」被吃掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { shopBrowserKeys } from './browser-ports.mjs';
import {
  BATCH_FILES, BATCH_SIZE_BY_MEMORY, DEFAULT_BATCH_SIZE, SHARED_INSTANCE_KEYS, assertBatchCoversRegistry,
  batchableShopKeys, buildBatchSteps, buildLoginPreflightStep, buildSharedStep, describeBatch, planBatches,
  releaseAfterBatch, resolveBatchSize, resolveShopNames,
} from './batch-plan.mjs';
import { REPO_ROOT } from './version.mjs';

const ALL = shopBrowserKeys();

test('切批覆盖全部店铺，不重不漏，且保持登记表顺序', () => {
  const plan = planBatches({ size: 2 });
  const flat = plan.batches.flatMap((b) => b.shops);
  assert.deepEqual(flat, ALL, '切完之后拼起来必须与登记表逐字相同（顺序也相同）');
  assert.equal(new Set(flat).size, flat.length, '同一家店不许出现在两个批次里');
  assert.equal(plan.total, Math.ceil(ALL.length / 2));
  assert.deepEqual(plan.batches.map((b) => b.shops.length), [2, 2, 1]);
  // 科塔必须在最后一批：它失败挡不住前四家（这条是链那边的既定顺序，切批不许打乱）。
  assert.equal(plan.batches.at(-1).shops.at(-1), '科塔淘宝');
});

test('默认每批 5 家 = 本机今天的行为；给一个更大的数也只有一批', () => {
  assert.equal(DEFAULT_BATCH_SIZE, 5);
  const plan = planBatches({});
  assert.equal(plan.total, 1);
  assert.deepEqual(plan.batches[0].shops, ALL);
  assert.equal(planBatches({ size: 8 }).total, 1, '每批家数大于店铺数时就是一批');
  assert.equal(planBatches({ size: ALL.length }).total, 1);
  // 「大到不像话」也要拒：客户机上一次性开 99 个实例的结果是整机卡死，不是报错。
  assert.throws(() => planBatches({ size: 99 }), /不像话/u);
});

test('只跑几家时，切批就在这几家里切（顺序仍是登记表顺序，不是输入顺序）', () => {
  const plan = planBatches({ shops: ['科塔淘宝', '里可林淘宝'], size: 5 });
  assert.deepEqual(plan.shops, ['里可林淘宝', '科塔淘宝'], '顺序按登记表，不按命令行里打字的顺序');
  assert.equal(plan.total, 1);
});

test('resolveBatchSize：合法值照收，非法值当场抛错（不回落默认）', () => {
  assert.equal(resolveBatchSize(undefined), DEFAULT_BATCH_SIZE);
  assert.equal(resolveBatchSize(null), DEFAULT_BATCH_SIZE);
  assert.equal(resolveBatchSize(''), DEFAULT_BATCH_SIZE);
  assert.equal(resolveBatchSize('2'), 2);
  assert.equal(resolveBatchSize(3), 3);
  for (const bad of ['1O', '0', '-1', '2.5', 'abc', '999', 'NaN']) {
    assert.throws(() => resolveBatchSize(bad), /每批家数/u,
      `${JSON.stringify(bad)} 应当被拒 —— 静默回落成 5 会让客户机一次性开 5 个实例`);
  }
});

test('resolveShopNames：不认识的店铺当场抛错，并列出已登记的', () => {
  assert.deepEqual(resolveShopNames(null), ALL);
  assert.deepEqual(resolveShopNames([]), ALL);
  assert.throws(() => resolveShopNames(['里可林天猫']), /已登记/u);
  assert.equal(assertBatchCoversRegistry({ shops: ALL }), true);
  assert.throws(() => assertBatchCoversRegistry({ shops: ['不存在店'] }), /未登记/u);
  assert.throws(() => assertBatchCoversRegistry({ shops: [ALL[0], ALL[0]] }), /多次/u);
});

test('一个批次四段：起 → 挂标识页（每家一条）→ 跑 → 停', () => {
  const plan = planBatches({ size: 2 });
  const batch = plan.batches[0];
  const steps = buildBatchSteps(batch, { dateInput: 'yesterday', chainArgs: ['--commit', '--notify-print'] });

  assert.deepEqual(steps.map((s) => s.name.split(':')[0]),
    ['start', ...batch.shops.map(() => 'label'), 'chain', 'stop']);
  assert.equal(steps.filter((s) => s.name.startsWith('label:')).length, batch.shops.length,
    '每家店要各挂一次：shop-window-label 的 --only 只收一个店名');
  assert.equal(steps.filter((s) => s.blocking).map((s) => s.name).join(','), 'start,chain',
    '只有「起」与「跑链」是致命的；挂标识页失败、停失败都不许挡下一批');
});

test('起与停作用在同一组目标上（同一个变量渲染，不给「起 3 家停 2 家」留缝）', () => {
  for (const size of [1, 2, 3, 5]) {
    for (const batch of planBatches({ size }).batches) {
      const steps = buildBatchSteps(batch);
      const startOnly = steps.find((s) => s.name === 'start').args[1];
      const stopOnly = steps.find((s) => s.name === 'stop').args[2];
      const chainShops = steps.find((s) => s.name === 'chain').args[3];
      assert.equal(startOnly, batch.shops.join(','));
      assert.equal(stopOnly, batch.shops.join(','), '停的名单必须与起逐字相同');
      assert.equal(chainShops, batch.shops.join(','));
    }
  }
});

test('停那一行必须带 --yes（stop-all 默认只打印，不带就是「释放」变成一场打印）', () => {
  const steps = buildBatchSteps(planBatches({ size: 2 }).batches[0]);
  const stop = steps.find((s) => s.name === 'stop');
  assert.deepEqual(stop.args.slice(0, 2), ['--yes', '--only']);
});

test('链只跑本批的店铺，日期只有一种给法', () => {
  const steps = buildBatchSteps(planBatches({ size: 2 }).batches[1], { dateInput: 'yesterday' });
  const chain = steps.find((s) => s.name === 'chain');
  assert.deepEqual(chain.args.slice(0, 4), ['--date', 'yesterday', '--shops', '盖文淘宝,盖文天猫']);
  assert.ok(!chain.args.some((a) => /^\d{4}-\d{2}-\d{2}$/u.test(a)),
    '日期不许写死具体某天 —— 写死的日期第二天就过期，而它看起来还在正常工作');
});

test('命令里不许出现写死的端口（换机器就会悄悄连到别人的浏览器）', () => {
  // 判据口径与 browser-ports.test.mjs 一致：端口字面量只允许活在登记表里。
  const declared = new Set([...Object.values(BATCH_SIZE_BY_MEMORY)].map(String));
  for (const size of [1, 2, 5]) {
    for (const batch of planBatches({ size }).batches) {
      for (const step of buildBatchSteps(batch)) {
        for (const arg of step.args) {
          if (declared.has(arg)) continue; // 档位表里的数字（2/4/5）不是端口
          assert.ok(!/\b(?:190\d\d|922\d|345\d)\b/u.test(arg), `${step.name} 的参数里出现了端口字面量：${arg}`);
        }
      }
    }
  }
});

test('计划指向的文件都真实存在（脚本被改名时不许静默生效）', () => {
  for (const [role, file] of Object.entries(BATCH_FILES)) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), `${role} 指向的 ${file} 不存在`);
  }
});

// 用例名也是交付面：2026-09-23 之前这里叫「失败留着等人」，而实测证明窗口活不过本轮命令
// （见下面 failed.caveat 那几条断言）。名字与判决文案不一致会误导后来人，所以一并改成实话。
test('该不该释放：成功放行、失败不主动释放、没跑到链就收掉', () => {
  assert.deepEqual(releaseAfterBatch({ chainStatus: 0 }).release, true);
  assert.deepEqual(releaseAfterBatch({ chainStatus: null }).release, true);

  const failed = releaseAfterBatch({ chainStatus: 1 });
  assert.equal(failed.release, false, '链失败时不释放 —— 用户第 5 条：失败优先解决问题');
  assert.match(failed.why, /stop-all\.mjs --yes --only/u, '留着就得给出「处理完怎么释放」的那条命令');
  // 「留窗口」这句承诺必须带条件。
  // 2026-09-23 真机实测：start 走的是 start-all.mjs（起完就退），宿主在命令结束时回收整棵
  // 进程树 ⇒ 那批窗口在命令结束 0.26 秒后就连同启动器一起没了。所以「不释放」≠「还活着」，
  // 判决里必须把这件事说出来（否则事后翻日志的人会以为自己看漏了什么）。
  assert.match(failed.caveat, /start-all-hold\.mjs/u,
    '必须点名唯一能真把窗口留住的那条路（start-all-hold），否则这句承诺是空话');
  assert.match(failed.caveat, /活不过本轮命令/u, '必须说清「不释放」只是「我不去停它」');
  assert.equal(releaseAfterBatch({ chainStatus: 0 }).caveat, undefined,
    '成功分支没有这个限制（它本来就该收掉），不该多一句容易误读的话');

  assert.equal(releaseAfterBatch({ chainStatus: 2 }).release, false);
  assert.equal(releaseAfterBatch({ chainStatus: 3 }).release, false);
});

test('批次的一行说明里同时有「第几批」与「哪几家」', () => {  const plan = planBatches({ size: 2 });
  assert.equal(describeBatch(plan.batches[1], plan.total), '第 2/3 批：盖文淘宝、盖文天猫');
});

test('切批是纯函数：同一入参两次调用结果逐字相同（不读时钟、不读环境）', () => {
  const a = planBatches({ shops: ['盖文天猫', '里可林淘宝'], size: 1 });
  const b = planBatches({ shops: ['盖文天猫', '里可林淘宝'], size: 1 });
  assert.deepEqual(a, b);
  assert.deepEqual(batchableShopKeys(), ALL);
});

test('共享实例：只起不停、且只有商家浏览器（省内存才是这个功能的目的）', () => {
  const step = buildSharedStep();
  assert.equal(step.name, 'ensure-shared');
  assert.match(step.file, /scripts\/start-all\.mjs$/u);
  assert.deepEqual(step.args, ['--only', 'dailyReport']);
  assert.deepEqual(SHARED_INSTANCE_KEYS, ['dailyReport']);
  // 竞品链不该被日报的批次顺手牵起来：这条链不读它，而它有自己的排期。
  assert.doesNotMatch(step.args.join(' '), /competitor/u);
  // 它**没有对应的 stop**：整轮都不停共享实例 —— 推送段与回读段跑在它上面。
  const stopStep = buildBatchSteps(planBatches({ size: 5 }).batches[0]).find((s) => s.name === 'stop');
  assert.doesNotMatch(stopStep.args.join(' '), /dailyReport|competitor/u,
    '释放只针对本批店铺：一旦把共享实例写进 --only，整轮的推送/回读链就被自己掐断了');
});

// ---------------------------------------------------------------------------
// 跑前登录态体检那一步（2026-09-23 加）：**整轮一次**，结论交给每一批的链。
//
// 为什么放在这一层而不是每一批：它只读、不占新实例，一次查五家与分五次查五家得到同一份结论，
// 而后者要多付四倍的等待。链内部会按本批 `--shops` 把结论筛一遍，所以共用一份不会串店。
// ---------------------------------------------------------------------------
const LOGIN_FILE = 'skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs';
const LOGIN_ARTIFACT = 'E:\\ev\\batches-2026-09-22\\login-preflight.json';

test('跑前登录态体检那一步：整轮一次、只读、不阻断，且结论落成文件', () => {
  const step = buildLoginPreflightStep({
    file: LOGIN_FILE,
    args: ['--shops', ALL.join(','), '--json'],
    artifactPath: LOGIN_ARTIFACT,
  });
  assert.equal(step.name, 'login-preflight');
  assert.equal(step.file, LOGIN_FILE, '跑哪个文件由调用方给（单一来源是 daily-job-plan 的 JOB_FILES）');
  assert.equal(step.blocking, false, '它不是闸门：读不到登录态不该拦住整轮（链的告警会如实说）');
  // 它是**只读**那一条：一个 `--commit` 都不许出现（那是自动登录的第一步，不是体检）。
  assert.doesNotMatch(step.args.join(' '), /--commit/u);
  // 结论必须落成**文件**：只进日志的话，链那一步读的就是一个不存在的路径。
  assert.equal(step.artifactPath, LOGIN_ARTIFACT);
  // 整轮一次 ⇒ `--shops` 给的是全部要跑的店，不是某一家。
  assert.equal(step.args[1], ALL.join(','));
});

test('结论交给**每一批**的链，且每批拿到的是各自独立的参数数组', () => {
  const flag = ['--login-preflight', LOGIN_ARTIFACT];
  const batches = planBatches({ size: 2 }).batches;
  const chains = batches.map((batch) => buildBatchSteps(batch, {
    dateInput: 'yesterday', chainArgs: ['--commit', ...flag],
  }).find((s) => s.name === 'chain'));

  for (const chain of chains) {
    const at = chain.args.indexOf('--login-preflight');
    assert.notEqual(at, -1, `这一批的链没拿到结论：${chain.args.join(' ')}`);
    assert.equal(chain.args[at + 1], LOGIN_ARTIFACT);
  }
  // 每一批的链参数必须是**各自一份**：共享同一个数组引用时，后一批的 `--logs` 拼接
  // 会把前一批的参数改掉（那种错在日志里长得完全正常）。
  assert.equal(new Set(chains.map((c) => c.args)).size, chains.length);
  assert.notEqual(chains[0].args, chains[1].args);
});

