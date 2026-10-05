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

import { collectingShopKeys, shopBrowserKeys, SHOPS_NOT_COLLECTING_YET } from './browser-ports.mjs';
import { SHOP_DEPARTMENTS } from './feishu-targets.mjs';
import {
  BATCH_FILES, BATCH_SIZE_BY_MEMORY, DEFAULT_BATCH_SIZE, SHARED_INSTANCE_KEYS, assertBatchCoversRegistry,
  batchLoginArtifactName, batchableShopKeys, buildBatchSteps, buildLoginPreflightStep, buildSharedStep,
  describeBatch, planBatches, releaseAfterBatch, resolveBatchSize, resolveShopNames,
} from './batch-plan.mjs';
import { REPO_ROOT } from './version.mjs';

// 两个口径别混：
//   · REGISTERED ＝ 登记表全部实例 —— 只有「实例/登记」类的事才用它；
//   · ALL        ＝ **参与采集**的店铺 —— 分批层认的就是它（`batchableShopKeys()`）。
// 2026-09-30 白天两者差 1 家（第 13 家挂在「还没开始收集」里），当晚用户拍板开 13 家后**逐字相同**。
// 2026-10-05 用户指令「销售二部的全停止」⇒ 两者**又一次**不同，且这次是成组的（销售2部 5 家）。
// 这一层里的断言绝大多数是分批语义，所以默认用 ALL；两个集合的关系由下面两条 test 单独守。
const REGISTERED = shopBrowserKeys();
const ALL = collectingShopKeys();

test('「参与采集」是登记表的子集，没有店掉进缝里', () => {
  // 这条守住「有没有店掉进缝里」：采集名单里出现未登记的店 ⇒ 那台实例根本起不来；
  // 登记表里有店既不在采集名单、也不在「还没开始收集」表里 ⇒ 它今天一步都不会跑，而整轮报全绿。
  assert.ok(ALL.every((key) => REGISTERED.includes(key)),
    '有店在采集名单里却不在登记表 —— 那台实例根本起不来');
  // 2026-10-05 起两者**应当**不同（销售2部停采），所以这条只守方向、不守相等。
  // 「登记表里没在采的店」必须逐个都能在「还没开始收集」表里找到名字，否则它就真的掉缝里了。
  const stopped = REGISTERED.filter((key) => !ALL.includes(key));
  for (const key of stopped) {
    assert.ok(SHOPS_NOT_COLLECTING_YET.includes(key),
      `「${key}」既不在采集名单、也不在 SHOPS_NOT_COLLECTING_YET 里 —— 它今天一步都不会跑，而整轮报全绿`);
  }
});

test('销售2部 5 家停采、销售1部 8 家在采（2026-10-05 用户指令钉住）', () => {
  // 为什么单独钉一条：部门切分是**业务决定**，不是实现细节。上面那条只守「没掉缝里」，
  // 守不住「停的是不是恰好那 5 家」—— 少停一家会变成静默的少采，多停一家会变成误伤。
  const s2 = Object.entries(SHOP_DEPARTMENTS).filter(([, dept]) => dept === 'sales2').map(([k]) => k);
  const s1 = Object.entries(SHOP_DEPARTMENTS).filter(([, dept]) => dept === 'sales1').map(([k]) => k);
  assert.equal(s2.length, 5, '销售2部 5 家这个数变了 —— 部门表与本用例要一起更新');
  assert.equal(s1.length, 8, '销售1部 8 家这个数变了 —— 部门表与本用例要一起更新');
  assert.equal(ALL.length, 8, '参与采集应当正好是销售1部 8 家');
  for (const key of s2) {
    assert.ok(!ALL.includes(key), `销售2部的「${key}」还在采集名单里 —— 停采指令没生效`);
  }
  for (const key of s1) {
    assert.ok(ALL.includes(key), `销售1部的「${key}」被误踢出采集 —— 停采范围只该是销售2部`);
  }
  // 登记表本身不能动：实例侧（起停/登录/盘点/标签页）一律按登记表走，销售2部照样要能起实例。
  assert.equal(REGISTERED.length, 13, '登记表应当仍是 13 家 —— 停采只动采集名单，不动登记表');
});

/**
 * 按 size 切一份名单时，每批该有几家 —— **从名单长度推，不写死数字**。
 *
 * 为什么不留 `[2, 2, 1]` 这种字面量：那是「5 家店」时代的算术。家数一路
 * 5 → 12 → 13 之后，这种字面量每加一家店就红一次，而红的原因**不是被测代码坏了**，
 * 是断言自己过期了。更糟的是它会把人的注意力从「切批有没有漏店」带到「数字对不对」上。
 * 真正的判据只有三条：拼起来逐字等于登记表、没有重复、批数＝向上取整。
 */
function batchSizes(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(Math.min(size, list.length - i));
  return out;
}

test('切批覆盖全部店铺，不重不漏，且保持登记表顺序', () => {
  const plan = planBatches({ size: 2 });
  const flat = plan.batches.flatMap((b) => b.shops);
  assert.deepEqual(flat, ALL, '切完之后拼起来必须与「参与采集的店铺」逐字相同（顺序也相同）');
  assert.equal(new Set(flat).size, flat.length, '同一家店不许出现在两个批次里');
  assert.equal(plan.total, Math.ceil(ALL.length / 2));
  assert.deepEqual(plan.batches.map((b) => b.shops.length), batchSizes(ALL, 2));
  // 最后一批的最后一家＝登记表的最后一家：**切批不许打乱登记表顺序**。
  // 顺序本身由登记表定，而它现在是「按部门排」的（销售1部 8 家在前、销售2部 5 家在后）——
  // 于是「谁在末位」会随部门调整而变，所以这里比登记表，不比某个具体店名。
  // （2026-09-30 之前末位是科塔淘宝；13 家按部门重排后是安比淘宝。变的是排序口径，不是切批。）
  assert.equal(plan.batches.at(-1).shops.at(-1), ALL.at(-1));
  for (const batch of plan.batches) {
    assert.deepEqual(batch.shops, ALL.slice((batch.index - 1) * 2, (batch.index - 1) * 2 + batch.shops.length),
      `第 ${batch.index} 批的内容必须是登记表里连续的一段 —— 切批不做任何挑选或重排`);
  }
});

test('默认每批 5 家；每批家数一旦不小于店铺总数就只有一批', () => {
  assert.equal(DEFAULT_BATCH_SIZE, 5);
  const plan = planBatches({});
  assert.equal(plan.total, Math.ceil(ALL.length / DEFAULT_BATCH_SIZE),
    `默认档下批数必须是向上取整（${ALL.length} 家 ÷ ${DEFAULT_BATCH_SIZE} 家／批）`);
  assert.deepEqual(plan.batches.flatMap((b) => b.shops), ALL, '默认档也不许漏店');
  assert.equal(planBatches({ size: ALL.length }).total, 1, '每批家数等于店铺总数时就是一批');
  assert.equal(planBatches({ size: ALL.length + 1 }).total, 1, '每批家数大于店铺总数时也是一批');
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
  // 用一个**真正没登记**的名字。原来这里写「里可林天猫」，它在 5 家时代确实未登记，
  // 2026-09-30 扩到 13 家后成了已登记店铺 ⇒ 用例静默失效（不再抛错，于是
  // 「不认识的店铺会被拒」这条判据实际上没人守了）。
  assert.throws(() => resolveShopNames(['盖文1688']), /已登记/u,
    '未登记的店铺必须当场抛错，不许静默忽略');
  assert.equal(assertBatchCoversRegistry({ shops: ALL }), true);
  assert.throws(() => assertBatchCoversRegistry({ shops: ['不存在店'] }), /未登记/u);
  assert.throws(() => assertBatchCoversRegistry({ shops: [ALL[0], ALL[0]] }), /多次/u);
});

test('「已登记但还没开始收集」的店：默认名单里没有它，点它的名要说清是「还没开始收集」', () => {
  // 2026-09-30 加（用户原话：「网林家居这个是新加的店，还没有正式收集数据」；当天这家店的
  // 运营叫法从账号表里最初的「网林定制淘宝」改成了「网林家居」）。
  // 两个方向都要钉：
  //   ① 默认名单不许带上它 —— 带上它不是「多跑一家」，而是整轮失败或天天一条假告警；
  //   ② 显式点名时**报错要说对人话** —— 混成「不认识的店铺」会让人去登记表里翻，
  //      发现明明有它，从此不再相信这条报错（而这条报错是唯一的防线）。
  //
  // **当晚用户拍板「肯定开 13 家啊」⇒ 登记表里的空店清零，这条分支现实中取不到活体样本了。**
  // 所以这里改成**显式注入两个集合**来构造现场（与 shop-identities 的 `platformOf` 同一手法）：
  // 靠「仓库里恰好有一家空店」覆盖它，等于把一年只响几次的守卫交给运气 —— 空店一开就没人守。
  const registered = ['甲店', '乙店', '丙店'];
  const collecting = ['甲店', '乙店'];
  const opts = { registered, collecting };

  // 默认名单＝参与采集那几家（顺序照登记表），不带空店。
  assert.deepEqual(resolveShopNames(null, opts), collecting, '默认名单带上了没开始收集的店');
  for (const key of registered.filter((k) => !collecting.includes(k))) {
    assert.throws(() => resolveShopNames([key], opts), /还没开始收集/u,
      `点名「${key}」时必须说清是「还没开始收集」，不是「不认识」`);
    assert.throws(() => planBatches({ shops: [key], ...opts }), /还没开始收集/u);
    assert.throws(() => assertBatchCoversRegistry({ shops: [key] }, opts), /还没开始收集/u,
      '分批层的最后一道自检也只认「参与采集」集合 —— 空店不该被切进任何一批，且理由要说对人话');
  }
  // 「没开始收集」不许把「压根没登记」也吞掉：两者报错必须分家。
  assert.throws(() => resolveShopNames(['丁店'], opts), /不认识的店铺/u,
    '未登记的店被报成了别的理由 —— 两件事混成一件，人就分不清该去补哪里');
  // 注入口的默认值必须仍然是真实登记表：不注入时行为逐字不变（这一条防止注入口把生产路径改掉）。
  assert.deepEqual(resolveShopNames(null), collectingShopKeys());
  assert.throws(() => resolveShopNames(['盖文1688']), /已登记/u);
});

test('一个批次：起 → 挂标识页（每家一条）→ 跑 → 停（不给 loginStep 时就是这四段）', () => {
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
  const batch = planBatches({ size: 2 }).batches[1];
  const steps = buildBatchSteps(batch, { dateInput: 'yesterday' });
  const chain = steps.find((s) => s.name === 'chain');
  // 断言的是**形状**（日期怎么给、店铺名单是不是只有本批），不必再复述某几个店名 ——
  // 店名与顺序的单一来源是登记表，写在这里的字面量每加一家店就要改一次。
  assert.deepEqual(chain.args.slice(0, 4), ['--date', 'yesterday', '--shops', batch.shops.join(',')],
    '链只许拿到本批这几家');
  assert.equal(batch.shops.length, 2, '用的就是「每批 2 家」那一档，链才该只看到 2 家');
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

// 用例名也是交付面。2026-09-23 用户第二次拍板，口径从「失败留着等人」翻成
// 「**每一轮跑完都要释放浏览器资源**」，这里跟着改成实话。
//
// 旧的「失败不释放」不是被证伪，而是**兑现不了**：批次的 start 走 scripts/start-all.mjs
// （起完就退），宿主在命令结束时回收的是整棵进程树 ⇒ 那批窗口在命令结束 0.26 秒后就连同
// 启动器一起没了（真机实测）。于是「不释放」的真实效果只有两个：内存没省下来、现场也没留住。
test('该不该释放：一律释放 —— 链成功、链失败、链根本没跑到，都放', () => {
  for (const chainStatus of [0, 1, 2, 3, null, undefined]) {
    assert.equal(releaseAfterBatch({ chainStatus }).release, true,
      `链退出码 ${chainStatus} 时没有释放 —— 用户 2026-09-23：每一轮跑完都要释放浏览器资源`);
  }
  // 三档的「为什么放」必须各自不同：那一行是日志里唯一能复查这是哪种情况的东西。
  const why = [releaseAfterBatch({ chainStatus: 0 }).why,
    releaseAfterBatch({ chainStatus: 1 }).why,
    releaseAfterBatch({ chainStatus: null }).why];
  assert.equal(new Set(why).size, 3, '三档的 reason 逐字相同的话，日志里看不出是哪种情况');

  // 失败那一档必须点名**唯一**能真把窗口留住的组合，否则「我要去看现场」是一句空话。
  const failed = releaseAfterBatch({ chainStatus: 1 });
  assert.match(failed.why, /start-all-hold\.mjs/u, '必须点名能真把实例托住的那条路');
  assert.match(failed.why, /--no-release/u, '两个条件缺一不可 —— 只给 --no-release 留不住窗口');
  assert.match(failed.why, /释放/u, '要说清「照旧释放」这个决定本身');
  // 旧口径的残骸不许留：`caveat` 一旦还在，读日志的人就会以为「不释放＝窗口还在」。
  assert.equal(failed.caveat, undefined, 'caveat 是旧口径的字段，一律释放之后它不该再存在');
  assert.equal(releaseAfterBatch({ chainStatus: 0 }).caveat, undefined);
});

test('批次的一行说明里同时有「第几批」与「哪几家」', () => {
  const plan = planBatches({ size: 2 });
  const batch = plan.batches[1];
  assert.equal(plan.total, Math.ceil(ALL.length / 2));
  assert.equal(describeBatch(batch, plan.total), `第 2/${plan.total} 批：${batch.shops.join('、')}`);
  // 「哪几家」必须是**这一批自己的**店，不是整轮名单 —— 那行说明是日志里唯一
  // 能看出「这一批跑了什么」的东西。
  for (const shop of batch.shops) assert.ok(describeBatch(batch, plan.total).includes(shop), shop);
  assert.ok(!describeBatch(batch, plan.total).includes(ALL.at(-1)) || batch.shops.includes(ALL.at(-1)),
    '说明里的店名只能来自本批');
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
// 跑前登录守卫那一步（2026-09-23 加，**同日改成「每一批 start 之后跑一次」**）。
//
// 位置是**实测改的，不是偏好**：旧位置（整轮一次、排在所有 start 之前）的依据是「它只读、
// 不开页面」，而 `--login` 把那条依据推翻了 —— 它要开这几家店自己的浏览器。
// 2026-09-23 实测（evidence/batches-2026-09-22/batches.log 13:29:27 那段）：
// 五个实例还没起 ⇒ 五家店的代理全回 `HTTP 500 连不上浏览器调试端口 19xxx` ⇒
// 五行全 UNREADABLE、退出码 3 ⇒ **自动登录一次机会都没有**，而表面上只看到一句
// 「不是全在登录态」。所以这里盯三件事：位置、只查本批、产物名逐批不同。
// ---------------------------------------------------------------------------
const LOGIN_FILE = 'skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs';
const LOGIN_ARTIFACT = 'E:\\ev\\batches-2026-09-22\\login-preflight.json';

test('跑前登录守卫：不是闸门、会碰页面（带 --login）、结论落成文件', () => {
  const step = buildLoginPreflightStep({
    file: LOGIN_FILE,
    args: ['--shops', ALL.join(','), '--json', '--login'],
    artifactPath: LOGIN_ARTIFACT,
  });
  assert.equal(step.name, 'login-preflight');
  assert.equal(step.file, LOGIN_FILE, '跑哪个文件由调用方给（单一来源是 daily-job-plan 的 JOB_FILES）');
  assert.equal(step.blocking, false, '它不是闸门：掉登录不该拦住整轮（链的告警会如实点名是哪家店）');
  assert.equal(step.artifactPath, LOGIN_ARTIFACT,
    '结论必须落成**文件**：只进日志的话，链那一步读的就是一个不存在的路径');
  // 措辞必须跟着参数走：带 `--login` 时会开页面、补可信手势、提交表单，
  // 这时还印「只读：不开页面、不点东西」就是一句假话 —— 而 `--print` 正是人用来确认
  // 「将要执行什么」的唯一凭据（本仓库反复在治的正是这种「打印的和实际做的不一致」）。
  assert.match(step.note, /会碰页面/u, '带 --login 时不许再说自己是只读');
  assert.doesNotMatch(step.note, /只读/u);
  const readOnly = buildLoginPreflightStep({ file: LOGIN_FILE, args: ['--shops', 'x', '--json'] });
  assert.match(readOnly.note, /只读/u, '不带 --login 时才是纯只读体检，那句「只读」才是真的');
});

test('登录守卫**排在每一批的 start 之后**，且 `--shops` 只给本批', () => {
  for (const batch of planBatches({ size: 2 }).batches) {
    const steps = buildBatchSteps(batch, {
      loginStep: buildLoginPreflightStep({
        file: LOGIN_FILE,
        args: ['--shops', batch.shops.join(','), '--json', '--login'],
        artifactPath: 'E:\\ev\\x.json',
      }),
    });
    const names = steps.map((s) => s.name);
    // 顺序就是执行顺序：起 → 查登录（会开这一批自己的页面）→ 挂标识页 → 跑 → 停。
    assert.equal(names[0], 'start');
    assert.equal(names[1], 'login-preflight', `这一批的步骤是 ${names.join(' → ')}`);
    assert.ok(names.indexOf('login-preflight') > names.indexOf('start'),
      '守卫必须排在 start 之后 —— 实例没起时它只会读到 HTTP 500，自动登录一次机会都没有');
    assert.ok(names.indexOf('login-preflight') < names.indexOf('chain'),
      '守卫必须排在 chain 之前：链要把这份结论当参数读');
    // 只查本批：整轮一份的旧写法把「批次相关的事实」当成了全局常量。
    assert.equal(steps[1].args[1], batch.shops.join(','), '`--shops` 必须只给这一批');
    // 不给 loginStep 时这一步整个不出现（定时链那边由 daily-job-plan 自己生成它）。
    assert.ok(!buildBatchSteps(batch).some((s) => s.name === 'login-preflight'),
      '不传 loginStep 却冒出一个 login-preflight —— 说明它被硬塞进了批次里');
  }
});

test('登录结论的文件名逐批不同（共用一个名字时，后一批会盖掉前一批）', () => {
  assert.equal(batchLoginArtifactName(1), 'login-preflight-b1.json');
  assert.notEqual(batchLoginArtifactName(1), batchLoginArtifactName(2),
    '两批共用一个文件名 ⇒ 「这一批的链看的是另一批的登录态」，而日志里完全看不出来');
});

test('结论交给**每一批**的链，且每批拿到的是各自独立的参数数组', () => {
  const batches = planBatches({ size: 2 }).batches;
  const chains = batches.map((batch) => {
    const flag = ['--login-preflight', `E:\\ev\\${batchLoginArtifactName(batch.index)}`];
    return buildBatchSteps(batch, {
      dateInput: 'yesterday', chainArgs: ['--commit', ...flag],
    }).find((s) => s.name === 'chain');
  });

  for (const chain of chains) {
    const at = chain.args.indexOf('--login-preflight');
    assert.notEqual(at, -1, `这一批的链没拿到结论：${chain.args.join(' ')}`);
    assert.match(chain.args[at + 1], /login-preflight-b\d+\.json$/u,
      '链必须读**本批自己**那份结论，而不是某个共用的名字');
  }
  // 每一批的链参数必须是**各自一份**：共享同一个数组引用时，后一批的 `--logs` 拼接
  // 会把前一批的参数改掉（那种错在日志里长得完全正常）。
  assert.equal(new Set(chains.map((c) => c.args)).size, chains.length);
  assert.notEqual(chains[0].args, chains[1].args);
});

