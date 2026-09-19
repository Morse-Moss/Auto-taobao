// browser-inventory.mjs 的离线判据。
//
// 这个文件存在的主要目的不是「跑过」，而是把三件事钉住：
//   ① 声明表**只从 browser-ports.mjs 取**（谁在这里另抄一份端口，这里就红）；
//   ② 「读不出来」永远不许被写成 foreign 或 missing（凭抖动停线是本项目反复吃过的亏）；
//   ③ 判据的输入是纯函数，所以它能在没浏览器、没代理的机器上离线验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildDeclarationPlan,
  classifyListener,
  declaredPorts,
  findAncestorByPid,
  findUndeclaredBrowsers,
  judgeInstance,
  parseListenTable,
  parseProcessTable,
  readProcessTable,
  summarize,
  inspectInstance,
} from './browser-inventory.mjs';
import { FOREIGN_PORTS, PROJECT_PORTS, SHOP_BROWSERS, shopBrowserKeys } from './browser-ports.mjs';

test('声明表 = 两个共享实例 ＋ 每家店一个', () => {
  const plan = buildDeclarationPlan();
  assert.equal(plan.length, 2 + shopBrowserKeys().length, '共享实例数或店铺数变了，这条要跟着改口径');
  assert.deepEqual(plan.filter((e) => e.kind === 'shop').map((e) => e.key), shopBrowserKeys());
});

test('声明表里的端口/身份/profile 一律取自登记表，本文件不另写一份', () => {
  const plan = buildDeclarationPlan();
  const byKey = new Map(plan.map((e) => [e.key, e]));
  assert.equal(byKey.get('competitor').browserPort, PROJECT_PORTS.competitorBrowser);
  assert.equal(byKey.get('dailyReport').proxyPort, PROJECT_PORTS.dailyReportProxy);
  for (const key of shopBrowserKeys()) {
    assert.equal(byKey.get(key).browserPort, SHOP_BROWSERS[key].browserPort);
    assert.equal(byKey.get(key).proxyPort, SHOP_BROWSERS[key].proxyPort);
    assert.equal(byKey.get(key).profile, SHOP_BROWSERS[key].profile);
    assert.equal(byKey.get(key).browserId, SHOP_BROWSERS[key].browserId);
  }
  // 声明用到的端口必须全在 allDeclaredPorts 的范围内（多一个就是这里私加了端口）
  const declared = new Set(declaredPorts());
  for (const entry of plan) {
    assert.ok(declared.has(entry.browserPort), `${entry.who} 的浏览器端口不在登记表里`);
    assert.ok(declared.has(entry.proxyPort), `${entry.who} 的代理端口不在登记表里`);
  }
});

test('没有两个实例声明同一个端口（撞号就是「连到别人身上」的开端）', () => {
  const ports = buildDeclarationPlan().flatMap((e) => [e.browserPort, e.proxyPort]);
  assert.equal(new Set(ports).size, ports.length, '有重复端口');
});

test('parseListenTable 认两种行形态，忽略非 LISTENING 行', () => {
  const sample = [
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    127.0.0.1:19031       0.0.0.0:0              LISTENING       12345',
    '  TCP    [::1]:19041            [::]:0                 LISTENING       12346',
    '  TCP    127.0.0.1:19032       0.0.0.0:0              ESTABLISHED     999',
    '  TCP    127.0.0.1:19033       127.0.0.1:55000        TIME_WAIT       888',
    '',
  ].join('\r\n');
  const table = parseListenTable(sample);
  assert.equal(table.get(19031), 12345);
  assert.equal(table.get(19041), 12346, 'IPv6 形态也要认');
  assert.equal(table.has(19032), false, 'ESTABLISHED 不是监听');
  assert.equal(table.has(19033), false, 'TIME_WAIT 不是监听');
});

test('parseListenTable 对垃圾输入不抛错，返回空表', () => {
  assert.equal(parseListenTable(null).size, 0);
  assert.equal(parseListenTable('').size, 0);
  assert.equal(parseListenTable('随便一段中文').size, 0);
});

test('classifyListener 三分类：登记表内 / 别的项目的已知端口 / 解释不了', () => {
  assert.equal(classifyListener(PROJECT_PORTS.dailyReportBrowser), 'ours-declared');
  assert.equal(classifyListener(FOREIGN_PORTS.sharedProxy), 'foreign');
  assert.equal(classifyListener(19999), 'undeclared');
});

test('judgeInstance：分桶按「下一步做什么」划，不按严重程度', () => {
  const ok = (probe) => judgeInstance({}, probe);
  assert.equal(ok({ status: 'occupied', verdict: 'ours', proxyReachable: true }), 'ready');
  assert.equal(ok({ status: 'occupied', verdict: 'foreign', proxyReachable: true }), 'foreign');
  assert.equal(ok({ status: 'free', verdict: 'free', proxyReachable: false }), 'missing');
  // 浏览器在、代理没起：该动作是「起代理」，不是「起一整套」
  assert.equal(ok({ status: 'occupied', verdict: 'ours', proxyReachable: false }), 'proxy-missing');
  // 代理在、浏览器没了：该动作是「起浏览器」
  assert.equal(ok({ status: 'free', verdict: 'free', proxyReachable: true }), 'browser-missing');
  // 端口在监听但读不出身份 ⇒ 给人看一眼，不判缺
  assert.equal(ok({ status: 'occupied-unidentified', verdict: 'unknown', proxyReachable: true }), 'unconfirmed');
});

test('读不出来绝不被判成 missing 或 foreign —— 抖动不是事故', () => {
  const probe = { status: 'occupied-unidentified', verdict: 'unknown', actualProfile: null, proxyReachable: false };
  assert.equal(judgeInstance({}, probe), 'unconfirmed');
  const account = summarize([{ who: '某店', judgement: 'unconfirmed' }]);
  assert.equal(account.buckets.unconfirmed.length, 1);
  assert.equal(account.buckets.missing.length, 0);
  assert.equal(account.allReady, false, 'unconfirmed 不算就位，但也不算硬失败（见退出码规则）');
});

test('summarize 把每个实例只放进一个桶，并给出 allReady', () => {
  const results = [
    { who: '甲', judgement: 'ready' },
    { who: '乙', judgement: 'ready' },
    { who: '丙', judgement: 'foreign' },
  ];
  const account = summarize(results);
  assert.deepEqual(account.counts, {
    ready: 2, 'proxy-missing': 0, 'browser-missing': 0, missing: 0, foreign: 1, unconfirmed: 0,
  });
  assert.equal(account.allReady, false);
  const allGood = summarize([{ who: '甲', judgement: 'ready' }]);
  assert.equal(allGood.allReady, true);
});

test('inspectInstance 用注入的探针即可离线跑，且不碰真实端口', async () => {
  const entry = {
    who: '假店', key: 'fake', profile: 'D:/fake', browserPort: 1, proxyPort: 2,
  };
  const seen = [];
  const result = await inspectInstance(entry, {
    inspect: async (port) => {
      seen.push(port);
      return { status: 'occupied', product: 'Edge', profile: 'D:/fake', commandLine: '--user-data-dir=D:/fake' };
    },
    probeProxy: async () => ({ reachable: true, httpStatus: 200, health: { pinnedTabs: 1 } }),
  });
  assert.deepEqual(seen, [1], '只探浏览器端口，不去碰别的端口');
  assert.equal(result.judgement, 'ready');
  assert.equal(result.probe.proxyHealth.pinnedTabs, 1);
});

test('inspectInstance：端口上是我们不认识的东西时判 foreign（有正面证据才判）', async () => {
  const result = await inspectInstance({ who: '假店', profile: 'D:/ours', browserPort: 1, proxyPort: 2 }, {
    inspect: async () => ({ status: 'occupied', product: 'Edge', profile: 'D:/someone-else' }),
    probeProxy: async () => ({ reachable: false, httpStatus: null, health: null }),
  });
  assert.equal(result.judgement, 'foreign');
  assert.equal(result.probe.actualProfile, 'D:/someone-else');
});

test('findUndeclaredBrowsers 只报「能自证是浏览器」的，系统服务与数据库一律不报', async () => {
  const listen = new Map([
    [19031, 1], // 登记表内 —— 连探都不该探
    [9222, 3], // 登记表内
    [5432, 2], // 数据库：CDP 读不出来
    [19999, 4], // 某个真的浏览器调试端口
  ]);
  const probed = [];
  const found = await findUndeclaredBrowsers(listen, {
    inspect: async (port) => {
      probed.push(port);
      return port === 19999
        ? { status: 'occupied', product: 'Microsoft Edge/149.0', profile: null }
        : { status: 'occupied-unidentified' };
    },
  });
  assert.deepEqual(found, [{ port: 19999, pid: 4, product: 'Microsoft Edge/149.0', profile: null }]);
  assert.deepEqual(probed.sort((a, b) => a - b), [5432, 19999], '登记表内的端口不该被重复探测');
});

// --- 进程表：停一个实例要靠「端口 → pid → 父进程」这条链 ----------------------------

test('parseProcessTable 认单条结果（ConvertTo-Json 在只有 1 个进程时返回对象而不是数组）', () => {
  // 这个坑不处理，会在「本机只剩一个 node」时静默返回空表 ——
  // 而空表在停止脚本那边读作「什么都没在跑」。
  const one = parseProcessTable({ ProcessId: 100, ParentProcessId: 50, Name: 'node.exe', CommandLine: 'node  a.mjs' });
  assert.equal(one.length, 1);
  assert.deepEqual(one[0], { pid: 100, ppid: 50, name: 'node.exe', cmd: 'node a.mjs' });
  assert.deepEqual(parseProcessTable([]), []);
  assert.deepEqual(parseProcessTable(null), []);
});

test('parseProcessTable 丢掉没有 pid 的坏行，且名字统一小写（大小写会让匹配静默漏掉）', () => {
  const rows = parseProcessTable([
    { ProcessId: 1, ParentProcessId: 0, Name: 'MSEDGE.EXE', CommandLine: null },
    { ProcessId: null, Name: 'node.exe' },
    { Name: 'node.exe' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'msedge.exe');
  assert.equal(rows[0].cmd, '', '读不到命令行就如实留空，不编一句');
});

test('readProcessTable 读失败时把错误带出来，不返回一张「空的」表', async () => {
  const failed = await readProcessTable({ execSync: () => { throw new Error('拒绝访问\n第二行不该带出来'); } });
  assert.deepEqual(failed.rows, []);
  assert.equal(failed.error, '拒绝访问', '错误只留第一行（PowerShell 的堆栈会把日志冲掉）');
  const empty = await readProcessTable({ execSync: () => '' });
  assert.equal(empty.error, null);
  assert.deepEqual(empty.rows, []);
});

test('findAncestorByPid 沿父链找到启动器 node —— 这是启动器唯一的可靠抓手', () => {
  // 真实形态：node(启动器) → msedge(主进程，带 CDP 端口) → renderer
  const rows = parseProcessTable([
    { ProcessId: 10, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'node runtime/start-project-browser.mjs' },
    { ProcessId: 20, ParentProcessId: 10, Name: 'msedge.exe', CommandLine: '--user-data-dir=D:/x' },
    { ProcessId: 30, ParentProcessId: 20, Name: 'msedge.exe', CommandLine: '--type=renderer' },
  ]);
  assert.equal(findAncestorByPid(rows, 20, { name: 'node.exe' })?.pid, 10);
  assert.equal(findAncestorByPid(rows, 30, { name: 'node.exe' })?.pid, 10, '从孙进程出发也要能找到');
  // 父链断了（浏览器是用户手工起的，父进程早没了）⇒ 如实返回 null，不去猜
  assert.equal(findAncestorByPid(rows, 20, { name: 'node.exe', maxDepth: 0 }), null);
  assert.equal(findAncestorByPid(rows, 999), null);
});

test('findAncestorByPid 不会为了找一个进程而在环里挂死', () => {
  const rows = parseProcessTable([
    { ProcessId: 1, ParentProcessId: 2, Name: 'node.exe' },
    { ProcessId: 2, ParentProcessId: 1, Name: 'node.exe' },
  ]);
  const found = findAncestorByPid(rows, 1, { name: 'msedge.exe', maxDepth: 10 });
  assert.equal(found, null);
});

// 2026-09-19 实测到的静默失效：进程表查询用的那个 shell 在被重定向时按**控制台代码页**
// （本机 GBK/936）写 stdout，而读侧按 UTF-8 解码 ⇒ 任何**中文参数**都变成 `�`。
// 症状不是报错，而是「店铺代理还要认得出店名」这条证据**永远为假**：
// 它安静地少一条证据，而 stop-all 仍会凭脚本名放行 ⇒ 守卫比设计的弱，且没有任何一处会告诉你。
// 这条判据钉住那句强制 UTF-8 的指令。它没有更好的离线形态 ——
// 要读出中文参数，必须真的起一个带中文参数的进程。
test('读进程表的查询强制 UTF-8 输出（否则中文参数变乱码，店名证据静默失效）', () => {
  const source = readFileSync(new URL('./browser-inventory.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /\[Console\]::OutputEncoding=\[System\.Text\.Encoding\]::UTF8/u,
    'browser-inventory.mjs 的 PROC_QUERY 没有把子 shell 的 stdout 强制成 UTF-8：本机控制台是 GBK，'
    + '中文命令行参数（店铺代理的店名）会读成乱码，而那种失败不报错，只是让一条证据永远为假',
  );
});
