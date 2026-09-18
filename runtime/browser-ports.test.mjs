import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACCOUNT_KINDS,
  BROWSER_ACCOUNT,
  BROWSER_IDS,
  BROWSER_LABELS,
  BROWSER_PROFILES,
  FOREIGN_PORTS,
  FOREIGN_PROXY_ALLOWED_FILES,
  FOREIGN_PROXY_URL_PATTERN,
  PROJECT_PORTS,
  RETIRED_PORTS,
  ROUTES,
  SHOP_BROWSERS,
  SITE_ACCOUNT,
  allDeclaredPorts,
  shopBrowserKeys,
  shopInstance,
  classifyPortUsage,
  retiredPortNumbers,
  describeBrowserRoutes,
  describeOccupant,
  extractProfileFromCommandLine,
  inspectPort,
  normalizeProfile,
  resolvePort,
  routesOnBrowser,
} from './browser-ports.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- 静态守卫的取材范围：本项目自己写的 .mjs，不含浏览器 profile、运行产物，也不含测试
// --- （测试里允许写期望值）。
// 2026-09-17 起 `isolated-proxy/` **也纳入**扫描：它已经不是一个原样 vendored 的目录了
// （cdp-proxy 被本项目改过：/clickPoint、/clickRightPoint、/clickText、focus emulation、
// 端口探测拦截都是我们加的），而「跳过它」正是坑 52 藏身的地方 ——
// browser-discovery 的默认端口 9223 就在被跳过的目录里活了下来。
const SKIP_DIRS = new Set(['node_modules', '.git', 'edge-debug-profile', 'edge-daily-report-profile']);

function sourceFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || /-runs$/.test(entry.name) || /^edge-isolated-/.test(entry.name)) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(target, acc);
    else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) acc.push(target);
  }
  return acc;
}

// 去掉注释再找端口字面量：启动器的用法示例里写着端口是给操作者看的，不构成「写死」。
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

test('端口登记表：两条链不重号，日报链已从通用值挪开', () => {
  assert.ok(Object.isFrozen(PROJECT_PORTS));
  const values = Object.values(PROJECT_PORTS);
  assert.equal(new Set(values).size, values.length, '这几个端口必须互不重复（含运营台那个非浏览器端口）');
  for (const value of values) {
    assert.ok(Number.isInteger(value) && value > 1023 && value < 49152, `${value} 必须是 1024-49151 之间的固定端口`);
  }
  // 竞品链保留历史值：evidence/ 与 runtime/ 下的收据/manifest 记着它们，改名会让旧证据对不上（坑 37）。
  assert.equal(PROJECT_PORTS.competitorBrowser, 9222);
  assert.equal(PROJECT_PORTS.competitorProxy, 3457);
  // 日报链原来用 9223 / 3458：9222/9223 是 Chrome/Edge 远程调试的常见取值，
  // 3456/3457/3458 是本机其他项目也在用的一段 ⇒ 撞号后「点击都成功，操作的是别人的浏览器」。
  assert.notEqual(PROJECT_PORTS.dailyReportBrowser, 9223);
  assert.notEqual(PROJECT_PORTS.dailyReportProxy, 3458);
  // 3456 是别的项目的 CDP 代理（见 docs/ops/PROJECT-BROWSER-AND-PORTS.md §3），永远不碰。
  assert.notEqual(PROJECT_PORTS.dailyReportProxy, 3456);
  assert.notEqual(PROJECT_PORTS.dailyReportBrowser, PROJECT_PORTS.competitorBrowser);
  assert.notEqual(PROJECT_PORTS.dailyReportProxy, PROJECT_PORTS.competitorProxy);
});

test('浏览器身份与 profile：商家链与买家链各自独立，不能共用', () => {
  assert.notEqual(BROWSER_IDS.competitor, BROWSER_IDS.dailyReport);
  assert.notEqual(BROWSER_LABELS.competitor, BROWSER_LABELS.dailyReport);
  assert.notEqual(BROWSER_PROFILES.competitor, BROWSER_PROFILES.dailyReport);
});

// --- 店铺隔离实例（2026-09-18，「按店铺实例化」）--------------------------------
// 这件事本身是配置，但配置里最容易出的三种错是结构性的，所以让测试盯住：
// ① 两家店共用端口或 profile（复制粘贴事故）；② 与既有链撞号；③ 与店铺身份登记表漂移。
test('店铺实例：端口与 profile 各自唯一，且不与既有链撞号', () => {
  const keys = shopBrowserKeys();
  assert.ok(keys.length >= 1, '店铺实例表不该是空的');

  const browserPorts = keys.map((key) => SHOP_BROWSERS[key].browserPort);
  const proxyPorts = keys.map((key) => SHOP_BROWSERS[key].proxyPort);
  assert.equal(new Set(browserPorts).size, browserPorts.length, '两家店不能共用调试端口');
  assert.equal(new Set(proxyPorts).size, proxyPorts.length, '两家店不能共用代理端口');

  const profiles = keys.map((key) => SHOP_BROWSERS[key].profile);
  assert.equal(new Set(profiles).size, profiles.length, '两家店不能共用 profile —— 一个 profile 只能是一个淘宝身份');

  const taken = new Set(Object.values(PROJECT_PORTS));
  for (const port of [...browserPorts, ...proxyPorts]) {
    assert.ok(Number.isInteger(port) && port > 1023 && port < 49152, `${port} 必须是 1024-49151 之间的固定端口`);
    assert.equal(taken.has(port), false, `${port} 与 PROJECT_PORTS 里的端口撞号了`);
    assert.equal(retiredPortNumbers().includes(port), false, `退役端口 ${port} 不该被回收再利用`);
  }
  // allDeclaredPorts 必须真的把它们都算进去，否则「不得写死端口」那条守卫会漏掉一整段。
  const declared = allDeclaredPorts();
  for (const port of [...Object.values(PROJECT_PORTS), ...browserPorts, ...proxyPorts]) {
    assert.ok(declared.includes(port), `allDeclaredPorts() 漏了 ${port} —— 守卫会看不见它`);
  }
});

test('店铺实例：browserId/label 唯一，且 shopInstance 对未登记店铺 fail-closed', () => {
  const keys = shopBrowserKeys();
  for (const field of ['browserId', 'label']) {
    const values = keys.map((key) => SHOP_BROWSERS[key][field]);
    assert.equal(new Set(values).size, values.length, `${field} 必须每家店一个，否则 /health 里认不出是哪一家`);
    assert.ok(values.every((value) => typeof value === 'string' && value.length > 0), `${field} 不能为空`);
  }
  assert.deepEqual(shopInstance(keys[0]), SHOP_BROWSERS[keys[0]]);
  assert.throws(() => shopInstance('不存在的店'), /未登记的店铺实例/u);
});

test('店铺实例的 profile 必须与店铺身份登记表逐键一致 —— 两边不许各说各话', async () => {
  // 为什么交叉核对：profile↔店铺 的对应关系写在两处（这里＝端口/配置，shop-identities.mjs
  // ＝实测证据）。两边漂移的形态是「照证据去查，查到的却是另一家店」，而两处单独看都自洽。
  const { ISOLATED_PROFILES } = await import('../skills/sycm-alimama-daily-report/scripts/shop-identities.mjs');
  const byKey = Object.fromEntries(
    shopBrowserKeys().map((key) => [key, SHOP_BROWSERS[key].profile.split('/').at(-1)]),
  );
  assert.deepEqual(byKey, { ...ISOLATED_PROFILES },
    'browser-ports.mjs 的 SHOP_BROWSERS 与 shop-identities.mjs 的 ISOLATED_PROFILES 必须逐键一致');
});

test('resolvePort：显式环境变量优先，非法值抛错而不是静默回落', () => {
  const original = process.env.PROJECT_BROWSER_PORT;
  try {
    delete process.env.PROJECT_BROWSER_PORT;
    assert.equal(resolvePort('PROJECT_BROWSER_PORT', 19022), 19022);

    process.env.PROJECT_BROWSER_PORT = '19123';
    assert.equal(resolvePort('PROJECT_BROWSER_PORT', 19022), 19123);

    for (const bad of ['0', 'abc', '70000', '19022.5', '']) {
      process.env.PROJECT_BROWSER_PORT = bad;
      assert.throws(() => resolvePort('PROJECT_BROWSER_PORT', 19022), /必须是 1-65535/, `${JSON.stringify(bad)} 必须被拒`);
    }
  } finally {
    if (original === undefined) delete process.env.PROJECT_BROWSER_PORT;
    else process.env.PROJECT_BROWSER_PORT = original;
  }
});

test('profile 归一化：反斜杠、引号、大小写、尾斜杠都不影响比对', () => {
  const quoted = 'msedge.exe --user-data-dir="D:\\Retire\\edge-debug-profile" --remote-debugging-port=9222';
  assert.equal(extractProfileFromCommandLine(quoted), 'D:/Retire/edge-debug-profile');

  const bare = 'msedge.exe --user-data-dir=D:/Retire/edge-daily-report-profile --no-first-run';
  assert.equal(extractProfileFromCommandLine(bare), 'D:/Retire/edge-daily-report-profile');

  assert.equal(extractProfileFromCommandLine('msedge.exe --no-first-run'), null);
  assert.equal(extractProfileFromCommandLine(null), null);
  assert.equal(normalizeProfile(' D:\\Retire\\Edge-Debug-Profile\\ '), 'd:/retire/edge-debug-profile');
  assert.equal(normalizeProfile(''), null);
});

test('classifyPortUsage 只对读得出 profile 的冲突下判决', () => {
  assert.equal(classifyPortUsage({ status: 'free' }, { expectedProfile: 'D:/a' }).verdict, 'free');
  // 同一个 profile 的两种写法必须判成 ours，否则每次启动都会误报冲突。
  assert.equal(classifyPortUsage({ status: 'occupied', profile: 'D:\\a\\' }, { expectedProfile: 'd:/a' }).verdict, 'ours');
  assert.equal(classifyPortUsage({ status: 'occupied', profile: 'D:/b' }, { expectedProfile: 'D:/a' }).verdict, 'foreign');
  // 读不出来只算 unknown：凭「探针没读到」停线，会把一次网络抖动变成一次事故。
  assert.equal(classifyPortUsage({ status: 'occupied', profile: null }, { expectedProfile: 'D:/a' }).verdict, 'unknown');
  assert.equal(classifyPortUsage({ status: 'occupied-unidentified' }, { expectedProfile: 'D:/a' }).verdict, 'unknown');
});

test('inspectPort 读出 Browser 与 profile —— 这是唯一能证明端口属于谁的证据', async () => {
  const result = await inspectPort(19022, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ Browser: 'Edg/135.0', webSocketDebuggerUrl: 'ws://127.0.0.1:19022/devtools/browser/abc' }),
    }),
    commandLineReader: async (wsUrl) => {
      assert.equal(wsUrl, 'ws://127.0.0.1:19022/devtools/browser/abc');
      return 'msedge --user-data-dir="D:\\Retire\\edge-daily-report-profile"';
    },
  });
  assert.equal(result.status, 'occupied');
  assert.equal(result.product, 'Edg/135.0');
  assert.equal(result.profile, 'D:/Retire/edge-daily-report-profile');
  assert.equal(classifyPortUsage(result, { expectedProfile: BROWSER_PROFILES.dailyReport }).verdict, 'ours');
  assert.equal(classifyPortUsage(result, { expectedProfile: BROWSER_PROFILES.competitor }).verdict, 'foreign');
});

test('inspectPort 区分「没人监听」与「在监听但不是 CDP 端点」', async () => {
  const free = await inspectPort(1, {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    listeningProbe: async () => false,
  });
  assert.equal(free.status, 'free');

  const busy = await inspectPort(1, {
    fetchImpl: async () => ({ ok: false, status: 502 }),
    listeningProbe: async () => true,
  });
  assert.equal(busy.status, 'occupied-unidentified');
  assert.equal(classifyPortUsage(busy, { expectedProfile: 'D:/a' }).verdict, 'unknown');
});

test('describeOccupant 必须说清是谁占了端口，读不出来时也如实讲', () => {
  const known = describeOccupant({ status: 'occupied', product: 'Edg/135.0', profile: 'D:/x' });
  assert.match(known, /Edg\/135\.0/);
  assert.match(known, /D:\/x/);
  const unknown = describeOccupant({ status: 'occupied-unidentified', product: null, profile: null });
  assert.match(unknown, /未识别/);
  assert.match(unknown, /不是可读的 CDP 端点/);
});

test('生产代码里不得再写死项目端口 —— 只能从登记表取（含每个店铺实例的两个端口）', () => {
  // 2026-09-18：取材范围从 PROJECT_PORTS 扩到 allDeclaredPorts()。
  // 只扫 PROJECT_PORTS 的话，新加的店铺端口（19031-19034 调试 / 19041-19044 代理）
  // 会成为新的法外之地 —— 那正是坑 52 的形态：换一组数字继续写死，而且看起来一切正常。
  const literals = allDeclaredPorts();
  const offenders = [];
  const files = [...sourceFiles(path.join(REPO_ROOT, 'runtime')), ...sourceFiles(path.join(REPO_ROOT, 'skills')), ...sourceFiles(path.join(REPO_ROOT, 'scripts'))];
  for (const file of files) {
    if (path.basename(file) === 'browser-ports.mjs') continue;
    const body = stripComments(readFileSync(file, 'utf8'));
    const hits = literals.filter((port) => new RegExp(`\\b${port}\\b`).test(body));
    if (hits.length > 0) offenders.push(`${path.relative(REPO_ROOT, file)} -> ${hits.join(', ')}`);
  }
  assert.deepEqual(offenders, [], '这些文件把端口写死了；改成从 runtime/browser-ports.mjs 取');
});

// 坑 52：只扫「现值」是不够的。退役值不在 Object.values(PROJECT_PORTS) 里，
// 于是它可以继续以默认值的形态活着，而且看起来一切正常。
// 2026-09-17 的实例：browser-discovery.mjs 默认端口 9223（日报链退役值）
// ＋ 自报身份 edge-isolated（竞品买家链）⇒ 裸跑代理「自称买家、实连商家」。
test('退役端口与外来端口都不得出现在本项目代码的默认值里', () => {
  const forbidden = [...retiredPortNumbers(), ...Object.values(FOREIGN_PORTS)];
  const files = [...sourceFiles(path.join(REPO_ROOT, 'runtime')), ...sourceFiles(path.join(REPO_ROOT, 'skills')), ...sourceFiles(path.join(REPO_ROOT, 'scripts'))];
  const offenders = [];
  for (const file of files) {
    if (path.basename(file) === 'browser-ports.mjs') continue;
    const body = stripComments(readFileSync(file, 'utf8'));
    const hits = forbidden.filter((port) => new RegExp(`\\b${port}\\b`).test(body));
    if (hits.length > 0) offenders.push(`${path.relative(REPO_ROOT, file)} -> ${hits.join(', ')}`);
  }
  assert.deepEqual(offenders, [], '这些文件把退役/外来端口当默认值用了；改成从 runtime/browser-ports.mjs 取');
});

test('退役端口留档：每条都要说清被谁替代、为什么退', () => {
  assert.ok(RETIRED_PORTS.length > 0, '留档为空等于没留 —— 退役值必须点名');
  for (const entry of RETIRED_PORTS) {
    assert.ok(Number.isInteger(entry.port), `${entry.port} 必须是整数端口`);
    assert.ok(Object.hasOwn(PROJECT_PORTS, entry.replacedBy),
      `replacedBy=${entry.replacedBy} 不是 PROJECT_PORTS 的键；用键名而不是端口值，原值改了才不会漂移`);
    assert.notEqual(PROJECT_PORTS[entry.replacedBy], entry.port, `${entry.port} 不该又是现行的 ${entry.replacedBy}`);
    assert.match(entry.retiredAt, /^\d{4}-\d{2}-\d{2}$/u, `${entry.port} 缺退役日期`);
    assert.ok(entry.reason.length > 10, `${entry.port} 要写清为什么退`);
  }
  // 退役值与现行值不能撞车，否则「退役」就变成了「换个名字继续用」。
  const current = new Set(Object.values(PROJECT_PORTS));
  for (const port of retiredPortNumbers()) {
    assert.equal(current.has(port), false, `退役端口 ${port} 又出现在现行端口里了`);
  }
});

// --- 三条路线 × 两个浏览器 ----------------------------------------------------
// 表格本身不是文档，是判据：下面四条测试分别盯住「路线指向的浏览器存在吗」
// 「账号边界串了吗」「路线表和 skills/ 目录还对得上吗」「别的项目的代理还缠着几个地方」。

const logins = Object.values(SITE_ACCOUNT);
const KNOWN_BROWSERS = Object.keys(BROWSER_ACCOUNT);

test('路线表：每条路线要么有浏览器、要么显式标成待定或不需要，二者必居其一', () => {
  for (const [name, route] of Object.entries(ROUTES)) {
    if (route.browser === null) {
      const pending = route.browserPending === true && typeof route.pendingReason === 'string' && route.pendingReason.length > 10;
      const notNeeded = route.noBrowser === true && typeof route.noBrowserReason === 'string' && route.noBrowserReason.length > 10;
      assert.ok(pending || notNeeded, `路线 ${name} 没有浏览器，就必须写清是「待定」还是「不需要」，否则这种空白会一点点变成「没人记得」`);
      assert.ok(!(pending && notNeeded), `路线 ${name} 不能既说待定又说不需要`);
    } else {
      assert.ok(KNOWN_BROWSERS.includes(route.browser), `路线 ${name} 指向未知浏览器 ${route.browser}`);
      assert.equal(route.browserPending, undefined, `路线 ${name} 已经定下浏览器了，不该再挂 pending 标记`);
      assert.equal(route.noBrowser, undefined, `路线 ${name} 已经定下浏览器了，不该再挂 noBrowser 标记`);
    }
    assert.ok(logins.includes(route.account), `路线 ${name} 的 account=${route.account} 不是已知账号类型`);
    assert.ok(Array.isArray(route.skills), `路线 ${name} 的 skills 必须是数组（没有调用方就写空数组）`);
    assert.ok(route.sites.length > 0, `路线 ${name} 至少要写一个站点，否则无法核对账号边界`);
  }
});

test('账号边界：买家链里不许有商家站点，商家链里不许有买家站点', () => {
  const forbidden = { [ACCOUNT_KINDS.buyer]: ACCOUNT_KINDS.merchant, [ACCOUNT_KINDS.merchant]: ACCOUNT_KINDS.buyer };
  for (const [name, route] of Object.entries(ROUTES)) {
    for (const site of route.sites) {
      const required = SITE_ACCOUNT[site];
      // fail-closed：站点没登记就失败，而不是「没人知道它属于哪一边」而放过。
      assert.ok(required, `站点 ${site}（路线 ${name}）没有登记在 SITE_ACCOUNT 里`);
      if (route.browser === null) continue;
      const browserKind = BROWSER_ACCOUNT[route.browser];
      assert.notEqual(
        required,
        forbidden[browserKind],
        `路线 ${name} 把 ${site}（要 ${required} 账号）放进了 ${route.browser} 浏览器（${browserKind} 账号）——卖家版账号用不了小旺神，这条正是要规避的风险`,
      );
    }
  }
});

test('两个浏览器承载的路线各自分明，且 9222 那条是唯一带小旺神的', () => {
  assert.deepEqual(routesOnBrowser('competitor').sort(), ['competitor']);
  assert.deepEqual(routesOnBrowser('dailyReport').sort(), ['dailyReport', 'keywordHeat', 'keywordRank', 'sellerWorkbench', 'weeklyPaste']);
  assert.equal(ROUTES.competitor.needsExtension, '小旺神');
  for (const name of routesOnBrowser('dailyReport')) {
    assert.equal(ROUTES[name].needsExtension, null, `商家浏览器上的路线 ${name} 不该依赖小旺神插件`);
  }
  assert.match(describeBrowserRoutes('competitor'), /账号=buyer/);
  assert.match(describeBrowserRoutes('competitor'), /小旺神/);
  assert.match(describeBrowserRoutes('dailyReport'), /账号=merchant/);
});

test('路线声明哪个浏览器，它名下的脚本就只能指向那个浏览器', () => {
  // 2026-09-16 的教训：灰豚链的代码默认值先迁到了乙（dailyReportProxy），
  // 登记表里那条路线却还写着「归属待定」——两个说法都在跑、测试全绿，事实已经漂了。
  // 这条判据把「表里写的」和「脚本里引用的」钉在一起：接错链是静默失败，
  // 点击、导航、导出全都成功，只是拿回的是另一个账号的数据。
  const proxyByBrowser = { competitor: PROJECT_PORTS.competitorProxy, dailyReport: PROJECT_PORTS.dailyReportProxy };
  const offenders = [];
  for (const [name, route] of Object.entries(ROUTES)) {
    if (route.browser === null) continue;
    for (const skill of route.skills) {
      // sourceFiles 已排除 .test.mjs：测试里允许为了断言而提到另一条链。
      for (const file of sourceFiles(path.join(REPO_ROOT, 'skills', skill, 'scripts'))) {
        const body = stripComments(readFileSync(file, 'utf8'));
        const where = `${skill}/${path.basename(file)}`;
        for (const [browser, port] of Object.entries(proxyByBrowser)) {
          if (browser === route.browser) continue;
          if (new RegExp(`\\b${port}\\b`).test(body)) offenders.push(`${where} 引用了 ${browser} 的代理端口 ${port}（路线 ${name} 在 ${route.browser} 上）`);
          if (body.includes(`BROWSER_IDS.${browser}`)) offenders.push(`${where} 引用了 ${browser} 的浏览器身份（路线 ${name} 在 ${route.browser} 上）`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], '这些脚本把路线指向了另一条链的浏览器');
});

test('路线表与 skills/ 目录双向一致 —— 改名会让这张表静默说谎（坑 37）', () => {
  const declared = new Set(Object.values(ROUTES).flatMap((route) => route.skills));
  const onDisk = readdirSync(path.join(REPO_ROOT, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.deepEqual(onDisk.filter((name) => !declared.has(name)).sort(), [], '这些 skill 没被任何路线认领：给它指定浏览器与账号类型，或说明它不需要浏览器');
  assert.deepEqual([...declared].filter((name) => !onDisk.includes(name)).sort(), [], '路线表里提到的 skill 在 skills/ 下不存在（被改名或删了）');
  for (const name of declared) {
    assert.ok(existsSync(path.join(REPO_ROOT, 'skills', name, 'SKILL.md')), `skills/${name}/SKILL.md 不存在`);
  }
});

test('生产代码里不得再出现别的项目的代理地址 —— 注释里提到不算，当默认值用就算', () => {
  assert.notEqual(PROJECT_PORTS.dailyReportProxy, FOREIGN_PORTS.sharedProxy);
  assert.notEqual(PROJECT_PORTS.competitorProxy, FOREIGN_PORTS.sharedProxy);

  const codeFiles = [...sourceFiles(path.join(REPO_ROOT, 'runtime')), ...sourceFiles(path.join(REPO_ROOT, 'skills')), ...sourceFiles(path.join(REPO_ROOT, 'scripts'))];
  const skillDocs = [];
  for (const name of readdirSync(path.join(REPO_ROOT, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
    const doc = path.join(REPO_ROOT, 'skills', name, 'SKILL.md');
    if (existsSync(doc)) skillDocs.push(doc);
  }

  // .mjs 先去注释：`// …原先写的是 http://127.0.0.1:3456…` 这种「解释为什么别碰它」的注释要放过，
  // 否则守卫会逼着人删掉最有价值的那行说明。.md 不处理：散文里出现它就是口径没改干净。
  const codeHits = codeFiles
    .filter((file) => FOREIGN_PROXY_URL_PATTERN.test(stripComments(readFileSync(file, 'utf8'))));
  const docHits = skillDocs.filter((file) => FOREIGN_PROXY_URL_PATTERN.test(readFileSync(file, 'utf8')));
  const actual = [...codeHits, ...docHits]
    .map((file) => path.relative(REPO_ROOT, file).replaceAll('\\', '/'))
    .sort();

  assert.deepEqual(
    actual,
    [...FOREIGN_PROXY_ALLOWED_FILES].sort(),
    '这些文件把代理指向了别的项目的服务：改成从 runtime/browser-ports.mjs 取（清单非必要不许加例外）',
  );
});
