// launch-plan.mjs 的离线判据。
//
// 这个文件盯的是「起」与「停」共用同一份口径这件事 —— 分成两份清单的后果不是不好看，
// 而是会多出一个**永远活着**的实例，而且没有任何一处会报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { buildChildEnv, buildFullPlan, buildLaunchCommands, buildStopOrder, INSTANCE_ENV_KEYS, launcherHintFor, matchInstances, onlyHelpText, planInstanceStop, selectActions, taskkillArgs } from './launch-plan.mjs';
import { buildDeclarationPlan, summarize } from './browser-inventory.mjs';
import { SHOP_BROWSERS, shopBrowserKeys } from './browser-ports.mjs';
// 用**同一个实现**当断言的期望值：断言里另拼一份期望 URL 的话，改实现时会两处一起漂，
// 而这条判据从此只会证明「实现等于它自己」。
import { labelPageUrlFor } from './shop-window-label.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

test('每个声明实例都有「先浏览器、后代理」两条命令 —— 起停都从这一份计划出发', () => {
  const plan = buildFullPlan();
  assert.equal(plan.length, buildDeclarationPlan().length, '起停计划漏了实例，或凭空多了实例');
  for (const item of plan) {
    assert.equal(item.launch.length, 2, `${item.who} 的启动命令不是两条`);
    assert.deepEqual(item.launch.map((c) => c.role), ['browser', 'proxy'],
      `${item.who} 的顺序不对：代理在 import 期就定死了连哪个浏览器，浏览器没起来它也会「健康」`);
  }
});

test('计划里提到的启动脚本都必须真实存在（改名不许静默生效）', () => {
  // 「按 kind 拼文件名」能省掉这张显式表，但脚本被改名时它会静默拼出一个不存在的路径，
  // 报错点会跑到 spawn 那一刻。这条测试把失败提前到测试期。
  const seen = new Set();
  for (const item of buildFullPlan()) {
    for (const command of [...item.launch, ...item.stopOrder]) {
      seen.add(command.file);
      assert.ok(existsSync(path.join(REPO_ROOT, command.file)),
        `${item.who} 指向的启动脚本不存在：${command.file}`);
    }
  }
  assert.ok(seen.size >= 4, `只用到 ${seen.size} 个启动脚本，可能有人把两条链合并成了一个（账号边界不允许）`);
});

test('店铺实例的参数与身份取自登记表条目，改条目计划就跟着改', () => {
  for (const key of shopBrowserKeys()) {
    const entry = { kind: 'shop', key, profile: SHOP_BROWSERS[key].profile, browserPort: SHOP_BROWSERS[key].browserPort };
    const [browser, proxy] = buildLaunchCommands(entry);
    assert.equal(browser.env.PROJECT_BROWSER_PORT, String(SHOP_BROWSERS[key].browserPort));
    assert.equal(browser.env.PROJECT_BROWSER_PROFILE, SHOP_BROWSERS[key].profile);
    // 代理用运营叫法当参数：拼错会当场抛错，不会静默回落到别的店
    assert.deepEqual(proxy.args, [key]);
    // 换了条目，计划必须跟着变 —— 否则说明数字被抄进了本模块
    const other = buildLaunchCommands({ ...entry, browserPort: 1, profile: 'D:/x' });
    assert.equal(other[0].env.PROJECT_BROWSER_PORT, '1');
    assert.equal(other[0].env.PROJECT_BROWSER_PROFILE, 'D:/x');
  }
});

// 2026-09-23 加。用户两条原话：「不要空页」、「每个店铺的浏览器要有标识页」。
// 这两件事在**首屏**上是同一件事：首屏给了标识页，就没有那个待接管的空白页。
test('店铺实例的首屏是它自己的标识页（不是 about:blank）—— 空页与标识页一起解决', () => {
  for (const key of shopBrowserKeys()) {
    const entry = { kind: 'shop', key, profile: SHOP_BROWSERS[key].profile, browserPort: SHOP_BROWSERS[key].browserPort };
    const [browser] = buildLaunchCommands(entry);
    const url = browser.env.PROJECT_BROWSER_URL;
    assert.ok(url, `${key} 没有给起始页 ⇒ 启动器的默认值是 about:blank，窗口里就永远躺着一个空白页`);
    assert.match(url, /shop-window-label\.html/u, `${key} 的起始页不是标识页`);
    // 店名必须真的在 URL 里：标识页靠这个 query 参数显示店名与标题。
    // 只断言「有 URL」的话，五家店给同一个地址也能过 —— 那正是「贴错窗口」的形态。
    assert.equal(new URL(url).searchParams.get('shop'), key);
    // 端口跟着条目走（换机器/改登记表时不需要改这里）
    assert.equal(new URL(url).searchParams.get('port'), String(SHOP_BROWSERS[key].browserPort));
    // 起始页地址必须与「挂标识页」那一步用的是**同一个实现**（否则是两个格式）。
    assert.equal(url, labelPageUrlFor({ shop: key, port: SHOP_BROWSERS[key].browserPort }));
  }
  // 反例：竞品链与日报链**不套**店铺标识页 —— 那是把标签贴错窗口。
  for (const kind of ['competitor', 'dailyReport']) {
    const [browser] = buildLaunchCommands({ kind, key: kind });
    assert.equal(browser.env.PROJECT_BROWSER_URL, undefined,
      `${kind} 不该被塞一个店铺标识页（日报链的商家浏览器有自己的首屏，竞品链不读店铺身份）`);
  }
});

test('竞品链与日报链的启动器不需要传端口（脚本自己从登记表取）', () => {
  for (const kind of ['competitor', 'dailyReport']) {
    for (const command of buildLaunchCommands({ kind, key: kind })) {
      assert.deepEqual(command.env, {}, `${kind} 的启动器不该由外部喂端口 —— 那会出现第二处端口来源`);
      assert.deepEqual(command.args, []);
    }
  }
});

test('停的顺序与起相反：先断代理，再动浏览器', () => {
  const item = buildFullPlan().find((i) => i.kind === 'shop');
  assert.deepEqual(item.stopOrder.map((c) => c.role), ['proxy', 'browser']);
  assert.deepEqual(item.stopOrder.map((c) => c.file), [item.launch[1].file, item.launch[0].file]);
});

test('selectActions 对每一个判决分桶都有明确处置，没有一个桶落进「未知」', () => {
  // 这条是「两处口径不许漂」的核心：browser-inventory 判出来的桶，这里必须都有对应动作。
  const buckets = Object.keys(summarize([]).counts);
  assert.ok(buckets.length >= 6, '分桶数量变了，这条判据要跟着复核');
  for (const bucket of buckets) {
    const action = selectActions(bucket);
    assert.ok(action.reason.length > 0, `${bucket} 没有给出理由 —— 「跳过」不带上理由就等于没解释`);
    assert.doesNotMatch(action.reason, /未知判决/u, `分桶 ${bucket} 在 selectActions 里没有登记`);
  }
});

test('该动的才动：ready 不动，foreign / unconfirmed 一律拒绝动作', () => {
  assert.deepEqual(selectActions('ready').start, []);
  assert.deepEqual(selectActions('foreign').start, [], '端口上是别人的 profile，起东西等于把调试端点接到别人身上');
  assert.deepEqual(selectActions('unconfirmed').start, [], '读不出身份就起东西是赌，赌输的代价是静默串店');
  // 缺什么补什么，不许「缺一半补一套」—— 多起的那一半会把「浏览器在、代理没起」变成整个实例不可用
  assert.deepEqual(selectActions('proxy-missing').start, ['proxy']);
  assert.deepEqual(selectActions('browser-missing').start, ['browser']);
  assert.deepEqual(selectActions('missing').start, ['browser', 'proxy']);
});

test('每个实例的两个角色都有对应的启动器提示（停止脚本靠它解释「为什么没动」）', () => {
  for (const item of buildFullPlan()) {
    const hint = launcherHintFor(item);
    assert.ok(existsSync(path.join(REPO_ROOT, hint.browserScript)));
    assert.ok(existsSync(path.join(REPO_ROOT, hint.proxyScript)));
    assert.notEqual(hint.browserScript, hint.proxyScript);
  }
});

test('未登记的实例类型 fail-closed（新增一条链时会被迫来这里表态）', () => {
  assert.throws(() => buildLaunchCommands({ kind: '不知道哪来的链', key: 'x' }), /未登记的实例类型/u);
});

test('起子进程前必须把「身份类」环境变量清干净 —— 残留值会让一键起齐把每家店指向同一个端口', () => {
  // 这条防的是「配置文件之外还留着一个能决定身份的值」。那种故障的表现是**全绿**：
  // 每家店的启动器都 READY，实际上只有一台浏览器，其余全是同一台。
  const ambient = {
    PATH: 'C:/Windows',
    无关变量: '保留',
    PROJECT_BROWSER_PORT: '19031', // 排查完忘了 unset 的典型残留
    PROJECT_BROWSER_PROFILE: 'D:/Retire/edge-profiles/likelin-home',
    CDP_PROXY_PORT: '19041',
    CDP_BROWSER_ID: 'edge-isolated',
    CDP_BROWSER_LABEL: '某店',
    SHOP_KEY: '某店',
    PROJECT_BROWSER_URL: 'https://example.invalid/',
  };
  const plain = buildChildEnv({ env: {} }, ambient);
  for (const key of INSTANCE_ENV_KEYS) {
    assert.equal(Object.hasOwn(plain, key), false, `${key} 没有被清掉，它会污染所有启动器`);
  }
  assert.equal(plain.PATH, 'C:/Windows', '与本实例无关的环境要原样保留');
  assert.equal(plain.无关变量, '保留', '中文键名也要保留（PowerShell/cmd 传进来的中文变量不该被误删）');

  // 计划显式给了的键必须赢，而且只能赢在它自己的实例上
  const shopEnv = buildChildEnv({ env: { PROJECT_BROWSER_PORT: '1', PROJECT_BROWSER_PROFILE: 'D:/x' } }, ambient);
  assert.equal(shopEnv.PROJECT_BROWSER_PORT, '1');
  assert.equal(shopEnv.PROJECT_BROWSER_PROFILE, 'D:/x');
  assert.equal(shopEnv.CDP_PROXY_PORT, undefined, '没在计划里给的键不许从残留环境里漏进来');
});

test('环境键清单本身是活的：少列一个就等于少清一个', () => {
  // 每个启动器实际会读的「身份类」变量都必须在这张表里。新增启动器读一个新变量时，
  // 由 start-all 的「全绿但只有一台浏览器」来发现就太贵了 —— 这条测试是那个故障的便宜版本。
  const required = [
    'PROJECT_BROWSER_PORT', 'PROJECT_BROWSER_PROFILE', 'PROJECT_BROWSER_URL',
    'SHOP_KEY', 'CDP_PROXY_PORT', 'CDP_BROWSER_PORT', 'CDP_BROWSER_ID', 'CDP_BROWSER_LABEL',
  ];
  for (const key of required) assert.ok(INSTANCE_ENV_KEYS.includes(key), `INSTANCE_ENV_KEYS 漏了 ${key}`);
});

// --- 停机判决：这套系统里唯一不可撤销的动作 ----------------------------------------

const ENTRY = { kind: 'shop', key: '科塔淘宝', profile: 'D:/Retire/edge-profiles/shop-j873522735' };
const OUR_PROXY = { script: 'start-shop-proxy.mjs', matchesScript: true, matchesKey: true };

test('停机顺序与起相反：先代理、后浏览器（浏览器永远比代理活得久）', () => {
  const { targets } = planInstanceStop(ENTRY, {
    browserPid: 20, browserVerdict: 'ours', launcherPid: 10, proxyPid: 30, proxyIdentity: OUR_PROXY,
  });
  assert.deepEqual(targets.map((t) => t.role), ['proxy', 'browser']);
});

test('浏览器：只有 CDP 自证 profile 一致才动；找不到启动器就按主进程停', () => {
  const withLauncher = planInstanceStop(ENTRY, { browserPid: 20, browserVerdict: 'ours', launcherPid: 10 });
  assert.deepEqual(withLauncher.targets, [{
    role: 'browser', pid: 10, tree: true,
    evidence: 'CDP 自证 profile 一致；杀启动器 10（连带浏览器进程树与保活进程）',
  }]);
  const noLauncher = planInstanceStop(ENTRY, { browserPid: 20, browserVerdict: 'ours', launcherPid: null });
  assert.equal(noLauncher.targets[0].pid, 20, '找不到启动器时不能改用别的 pid 猜');
  assert.match(noLauncher.targets[0].evidence, /按浏览器主进程停/u);
});

test('端口上是别人的 profile ⇒ 拒停，并说清是别人的登录态', () => {
  const { targets, refusals } = planInstanceStop(ENTRY, { browserPid: 20, browserVerdict: 'foreign', proxyPid: null });
  assert.deepEqual(targets, []);
  assert.equal(refusals.length, 1);
  assert.match(refusals[0].why, /另一个 profile/u);
});

test('读不出 profile ⇒ 也拒停（没有证据不是「没问题」）', () => {
  const { targets, refusals } = planInstanceStop(ENTRY, { browserPid: 20, browserVerdict: 'unknown' });
  assert.deepEqual(targets, []);
  assert.match(refusals[0].why, /读不出 profile/u);
});

test('代理：命令行认得出启动脚本才动。认不出就拒停（它可能属于别的项目）', () => {
  const ok = planInstanceStop(ENTRY, { proxyPid: 30, proxyIdentity: OUR_PROXY });
  assert.deepEqual(ok.targets, [{ role: 'proxy', pid: 30, tree: false, evidence: '端口在听、进程命令行是 start-shop-proxy.mjs 科塔淘宝' }]);
  const bad = planInstanceStop(ENTRY, { proxyPid: 30, proxyIdentity: { script: 'start-shop-proxy.mjs', matchesScript: false, matchesKey: false } });
  assert.deepEqual(bad.targets, []);
  assert.match(bad.refusals[0].why, /别的项目/u);
});

test('端口没人监听 ⇒ 什么都不做，也不产生拒停（「不在跑」不是异常）', () => {
  const { targets, refusals } = planInstanceStop(ENTRY, { browserPid: null, proxyPid: null });
  assert.deepEqual(targets, []);
  assert.deepEqual(refusals, []);
});

test('taskkill 参数只有一份：打印的与执行的不可能不一样', () => {
  assert.deepEqual(taskkillArgs(1234), ['/PID', '1234', '/T', '/F']);
  assert.deepEqual(taskkillArgs('1234'), taskkillArgs(1234), 'pid 传入字符串也要得到同一组参数');
});

test('--only 可读名与内部键都收，拼错时列的是可读名', () => {
  const plan = buildFullPlan();
  // 可读名（运营叫法）
  const byWho = matchInstances(plan, ['盖文天猫']);
  assert.deepEqual(byWho.targets.map((t) => t.key), ['盖文天猫']);
  assert.deepEqual(byWho.unknown, []);
  // 内部键（程序叫法）
  const byKey = matchInstances(plan, ['competitor']);
  assert.deepEqual(byKey.targets.map((t) => t.who), ['竞品链（买家号 ＋ 小旺神）']);
  // 不传 = 全选
  assert.equal(matchInstances(plan, null).targets.length, plan.length);
  // 拼错：给出 unknown，绝不回落成「全选」—— 回落的表现是「跑完了但那家没被处理」
  const typo = matchInstances(plan, ['盖文天猫店']);
  assert.deepEqual(typo.targets, []);
  assert.deepEqual(typo.unknown, ['盖文天猫店']);
  // 提示文本里必须出现的是可读名，而不是 competitor / dailyReport 这种内部键
  const help = onlyHelpText(plan);
  assert.match(help, /竞品链（买家号 ＋ 小旺神）/u);
  assert.match(help, /盖文天猫/u);
});
