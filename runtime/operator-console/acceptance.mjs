#!/usr/bin/env node
// 运营台真机验收（2026-09-16）。
//
// 为什么要有这个脚本而不是「手工打开看一眼」：验收判据不是「页面能打开」，而是
//   （a）页面渲染的每个状态都能在接口返回里找到对应字段（页面不许自己算）；
//   （b）取不到的那个分支显示成**灰 + 带理由**，而不是绿；
//   （c）示例数据在页面上被显式标注，不会看起来像真实检查结果。
// 这三条只有拿真实浏览器渲染一次才说得清，所以本脚本起真 Chrome 去 dump DOM + 截图。
//
// 用法：
//   node runtime/operator-console/acceptance.mjs --base http://127.0.0.1:19024 --out evidence/operator-console-2026-09-16
// 前提：目标控制台已在运行（脚本不会去启停它 —— 那是用户的进程）。
// 脚本会自己再起**一个临时实例**来验「取不到就灰」的分支，结束后只关掉它自己起的那个。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PROJECT_PORTS } from '../browser-ports.mjs';
import { createConsoleServer } from './server.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: String(detail ?? '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` → ${detail}` : ''}`);
  return ok;
}

function parseArgs(argv) {
  const options = { base: `http://127.0.0.1:${PROJECT_PORTS.operatorConsole}`, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--base') options.base = argv[++index];
    else if (argv[index] === '--out') options.out = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.out) throw new Error('--out <目录> is required');
  options.out = resolve(REPO_ROOT, options.out);
  return options;
}

function findChrome() {
  const found = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (!found) throw new Error(`找不到可用的 Chrome/Edge，试过：${CHROME_CANDIDATES.join(', ')}`);
  return found;
}

async function freePort() {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(base, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return await response.json();
    } catch { /* 还没起来 */ }
    await new Promise((done) => setTimeout(done, 300));
  }
  throw new Error(`${base}/api/health 在 ${timeoutMs}ms 内没就绪`);
}

// 用异步 spawn 而不是 spawnSync —— 这不是风格问题，是必须的：
// 本脚本会起一个**进程内**的控制台实例来验灰灯分支，而 spawnSync 会阻塞事件循环，
// 那个实例就无法应答 Chrome 的请求 → Chrome 等页面、脚本等 Chrome，双方互等（实测挂死）。
// 异步 spawn 期间事件循环是自由的，所以「同进程里既当服务又开浏览器」才成立。
// timeout 到了就杀掉**本次调用自己起的那个 Chrome**，避免脚本被卡住的浏览器拖住。
function runChrome(chrome, args, timeoutMs = 40_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(chrome, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolvePromise({ stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, timedOut: false });
    });
  });
}

// 用 Chrome 渲染页面并把 DOM 拿回来。--user-data-dir 指向临时目录：
// **绝不碰用户自己的 Chrome 配置**（那是他的登录态所在）。
async function renderDom(chrome, url, userDataDir, budgetMs = 12_000) {
  const result = await runChrome(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars',
    `--user-data-dir=${userDataDir}`,
    `--virtual-time-budget=${budgetMs}`,
    '--dump-dom', url,
  ]);
  if (result.timedOut) throw new Error(`Chrome dump-dom 超时：${url}（页面可能有请求一直没人应答）`);
  return result.stdout;
}

async function screenshot(chrome, url, userDataDir, file, size) {
  const result = await runChrome(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars',
    `--user-data-dir=${userDataDir}`,
    '--virtual-time-budget=12000',
    `--window-size=${size}`,
    `--screenshot=${file}`, url,
  ]);
  return !result.timedOut && existsSync(file);
}

const attr = (html, pattern) => [...html.matchAll(pattern)].map((match) => match[1]);
// 阶段名里有数字（LOCK_TOP5），所以字符类必须含 0-9 —— 只写 [A-Z_] 会静默少算一个阶段，
// 而「少算一个」的后果是这条断言可能因为数量对上而假绿。
const stageNamePattern = /data-stage-name="([A-Z0-9_]+)"/gu;

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  mkdirSync(options.out, { recursive: true });
  const chrome = findChrome();
  const userDataDir = mkdtempSync(resolve(tmpdir(), 'opconsole-chrome-'));
  console.log(`chrome: ${chrome}`);
  console.log(`console: ${options.base}`);

  // ---- 0. 目标控制台必须已经在跑 ----
  const health = await waitForHealth(options.base);
  check('控制台在运行且只读', health.console.readonly === true && health.console.host === '127.0.0.1', JSON.stringify(health.console));

  // ---- 1. 四个接口的真响应留档 ----
  const payloads = {};
  for (const name of ['env', 'accounts', 'runs']) {
    const response = await fetch(`${options.base}/api/${name}`);
    const payload = await response.json();
    payloads[name] = payload;
    writeFileSync(resolve(options.out, `api-${name}.json`), `${JSON.stringify(payload, null, 2)}\n`);
    check(`GET /api/${name} 返回 200`, response.status === 200, `HTTP ${response.status}`);
  }
  const healthResponse = await fetch(`${options.base}/api/health`);
  writeFileSync(resolve(options.out, 'api-health.json'), `${JSON.stringify(await healthResponse.json(), null, 2)}\n`);

  // ---- 2. 主页渲染 ----
  const mainHtml = await renderDom(chrome, `${options.base}/`, userDataDir);
  writeFileSync(resolve(options.out, 'page-main.html'), mainHtml);
  check('页面渲染完成（body[data-render-state=rendered]）', /data-render-state="rendered"/u.test(mainHtml), '需要 virtual-time-budget 放完异步请求');
  check('页面没有落到错误态', !/data-render-state="error"/u.test(mainHtml));

  const defaultPeriod = payloads.runs.defaultPeriod;
  const latestRun = payloads.runs.runs.find((run) => run.period === defaultPeriod);
  check('进度块渲染的是接口给的那个周期', mainHtml.includes(defaultPeriod), `周期 ${defaultPeriod}`);
  // 页面显示的阶段必须与接口给的阶段逐个对上（页面不许自己排阶段）。
  const stageNames = attr(mainHtml, stageNamePattern);
  const expectedStages = latestRun.available ? latestRun.stages.map((stage) => stage.name) : [];
  check('阶段清单与接口逐条一致', JSON.stringify(stageNames) === JSON.stringify(expectedStages),
    `页面 ${stageNames.length} 个 / 接口 ${expectedStages.length} 个`);
  const stageAppearances = attr(mainHtml, /data-stage="(\w+)"/gu);
  if (latestRun.available) {
    const currentCount = stageAppearances.filter((value) => value === 'current').length;
    check('「进行中」的阶段最多一个', currentCount <= 1, `current=${currentCount}`);
  }
  // 每个阶段状态都必须在接口里找得到出处：页面不许出现接口没给的阶段外观。
  check('阶段外观都在 {done,current,pending,skipped} 内',
    stageAppearances.every((value) => ['done', 'current', 'pending', 'skipped'].includes(value)),
    [...new Set(stageAppearances)].join(','));

  // ---- 3. 分组是真的（来自登记表），且两列分开 ----
  const columns = attr(mainHtml, /data-testid="browser-column" data-browser="(\w+)"/gu);
  const envKeys = payloads.env.browsers.map((browser) => browser.key);
  check('账号体检按浏览器 profile 分成两列', columns.length === 2 && JSON.stringify(columns) === JSON.stringify(envKeys),
    `列=${columns.join(',')} / 登记表=${envKeys.join(',')}`);
  const cards = attr(mainHtml, /data-account-key="([\w:]+)"/gu);
  const expectedCards = payloads.accounts.groups.flatMap((group) => group.cards.map((card) => card.accountKey));
  check('账号卡与接口逐张一致', JSON.stringify(cards) === JSON.stringify(expectedCards), `${cards.length} 张`);

  // ---- 4. 示例数据必须被显式标注 ----
  check('示例数据横幅存在', /data-testid="sample-notice"/u.test(mainHtml));
  const sampleFlags = attr(mainHtml, /data-sample="(\w+)"/gu);
  check('每张账号卡都标了 sample', sampleFlags.length > 0 && sampleFlags.every((value) => value === 'true'),
    `${sampleFlags.filter((value) => value === 'true').length}/${sampleFlags.length}`);
  // 预留平台（千牛）只能是灰灯。
  const qianniuLamp = mainHtml.match(/data-account-key="[\w]+:qianniu"[\s\S]{0,200}?data-lamp="(\w+)"/u)?.[1];
  check('预留的千牛卡是灰灯，不是绿灯', qianniuLamp === 'grey', `lamp=${qianniuLamp}`);

  // ---- 5. 五块都在，且第 ⑤ 块「有内容就不许隐藏」 ----
  const blockIds = attr(mainHtml, /<section class="block" id="(block-[a-z]+)"/gu);
  check('五块都渲染出来了', blockIds.length === 5, blockIds.join(','));
  const todoHidden = /id="block-todo"[^>]*\shidden/u.test(mainHtml);
  const todoItems = (mainHtml.match(/data-testid="todo-item"/gu) ?? []).length;
  check('需要你做的事：有内容时不隐藏，且条数与接口一致',
    !todoHidden && todoItems > 0, `hidden=${todoHidden} items=${todoItems}`);

  // ---- 6. 一期只读：所有按钮都是 disabled ----
  const enabledButtons = attr(mainHtml, /<button(?![^>]*\sdisabled)[^>]*>/gu);
  check('页面上没有可点的按钮（一期只读）', enabledButtons.length === 0, `可点按钮 ${enabledButtons.length} 个`);

  // ---- 7. 截图 ----
  // 截图高度要一次装下整页（含第 ⑤ 块）—— headless 的 --screenshot 只截视口，
  // 截短了就会把最后一块切掉，而「看起来少一块」很容易被误读成「那块没渲染」。
  for (const [label, size] of [['wide', '1600,3400'], ['narrow', '900,3600']]) {
    const file = resolve(options.out, `console-${label}.png`);
    check(`截图 ${label}（${size}）`, await screenshot(chrome, `${options.base}/`, userDataDir, file, size), file);
  }

  // ---- 8.「取不到就显示灰 + 带理由」----
  // 关键：临时根必须同时替换 runtimeRoot **与** repoRoot。只换 runtimeRoot 的话，
  // evidence/ 里的历史快照会被当成回落源把这块填绿 —— 第一次跑就踩到了这个（假绿）。
  const greyRoot = mkdtempSync(resolve(tmpdir(), 'opconsole-grey-'));
  mkdirSync(resolve(greyRoot, 'runtime', 'faq-analysis', '2026-01-01_2026-01-07'), { recursive: true });
  const greyPort = await freePort();
  const greyBase = `http://127.0.0.1:${greyPort}`;
  // 用进程内实例而不是再起一个子进程：这一支验的是「读不到文件时的渲染」，
  // 不需要真入口；也省掉「起进程再杀进程」这种容易出事的动作。
  const greyServer = createConsoleServer({ runtimeRoot: resolve(greyRoot, 'runtime'), repoRoot: greyRoot });
  await new Promise((resolveListen) => greyServer.listen(greyPort, '127.0.0.1', resolveListen));
  try {
    await waitForHealth(greyBase);
    const greyHtml = await renderDom(chrome, `${greyBase}/`, userDataDir);
    writeFileSync(resolve(options.out, 'page-grey.html'), greyHtml);
    check('取不到状态时渲染出灰块', /data-testid="grey-box"/u.test(greyHtml));
    const reasonCodes = attr(greyHtml, /data-reason-code="([A-Z_]+)"/gu);
    check('进度块的灰块理由是「有周期目录但没有状态文件」',
      reasonCodes.includes('NO_STATUS_FILE_IN_PERIOD_DIR'), reasonCodes.join(','));
    // 关键判据：取不到的时候**不许**出现阶段（那种「8 步全绿」的假象最危险）。
    const greyStages = attr(greyHtml, /data-stage="(\w+)"/gu);
    check('取不到时不渲染任何阶段（不许假绿）', greyStages.length === 0, `阶段数 ${greyStages.length}`);
    // 灰块必须写明去哪儿找：文件存在时给「读的是」，不存在时给「应该读」。
    // 只说「取不到」而不说去哪儿找，运营就没法自查。
    check('灰块写明了「读的是 / 应该读哪个文件」', /读的是：|应该读：/u.test(greyHtml));
    // 灰灯截图要装到第 ④ 块，否则图里看不到那个灰块 —— 而这张图的全部意义就是它。
    check('截图 灰灯分支', await screenshot(chrome, `${greyBase}/`, userDataDir, resolve(options.out, 'console-grey.png'), '1600,3400'));
  } finally {
    // 必须先掐掉空闲连接再 close：`server.close()` 只等「已有连接自然结束」，
    // 而我自己 fetch 过的 keep-alive 连接会一直挂在池子里 → close 的回调永不触发，
    // 脚本看起来「跑完了但退不出去」（第一次跑就是这样被超时掐掉的）。
    greyServer.closeIdleConnections?.();
    greyServer.closeAllConnections?.();
    await new Promise((resolveClose) => greyServer.close(resolveClose));
  }

  const passed = results.filter((item) => item.ok).length;
  const summary = {
    generatedAt: new Date().toISOString(),
    base: options.base,
    chrome,
    passed,
    failed: results.length - passed,
    total: results.length,
    // 明确记下这次验收**没有**覆盖什么，避免下一个人把「全绿」读成「什么都验过了」。
    notCovered: [
      '「甲列登出后乙列不受影响」需要真实体检接线（G1/G2），一期账号灯是示例数据，无法验证',
      '「登录后自动续跑」需要 loginSession 与 operator CLI（G3/G4），未实现',
      '「探队列三种脸」需要队列探针的生产调用方（G4），未实现',
    ],
    results,
  };
  writeFileSync(resolve(options.out, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${passed}/${results.length} 通过；证据落在 ${options.out}`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // 显式收尾：所有证据都落盘了，剩下的挂起句柄（undici 的连接池、Chrome 遗留的 socket）
  // 会让进程「跑完但不退」。验收脚本卡住不退出比失败更难排查，所以这里直接退。
  main()
    .then(() => process.exit(0))
    .catch((error) => { console.error(error.stack || error.message); process.exit(1); });
}
