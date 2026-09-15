#!/usr/bin/env node
// 采集宿主（durable host）—— 把「一次自适应采集 + 它的监督环」装进一个自包含进程。
//
// 为什么需要它（2026-09-15 实测结论）：
//   之前用 tmp-run-collect2.mjs 当启动器，它自己就是那个后台任务，且把子进程 stdout 接到
//   自己的管道上。结果是：会话收尾时整棵进程树一起没了 —— 采集半途死在第 29 页，
//   `.collect-exit-code` 根本没落盘，监督环只能判 UNKNOWN。这不是采集代码的缺陷，是**宿主缺陷**。
//
// 本宿主的三条硬规矩：
//   1) **子进程的 stdout/stderr 直接写文件描述符**（不是管道）。父进程的管道被关掉会引发
//      EPIPE，把启动器带走；写 fd 没有这个问题。
//   2) 子进程 `detached: true` —— 拿到自己的进程组，尽量不被宿主的进程树回收一起带走。
//   3) 宿主自己写心跳（`.collection-host-heartbeat`），60s 一跳。**心跳是分片的**：
//      写的是「宿主还活着 / 采集进程还活着 / 监督环最后报的状态」，所以外部不用连 stdout
//      也能判断这一批到底有没有人在管。
//
// 定位（别搞混）：
//   run-collection-host  只负责「把这一次采集跑完、把证据落全」；
//   supervise-collection 只负责「现在到哪了、异常有没有送出去」；
//   round-runner         回答的是「这一轮该不该跑、跑什么、怎么收尾」。
//
// 用法：
//   node runtime/run-collection-host.mjs --pages 40 \
//        --output-dir C:/Users/Administrator/Downloads \
//        --checkpoint runtime/weekly-20260913.checkpoint.json \
//        --proxy http://127.0.0.1:3457 [--notify | --dry-run] [--label "..."]
//
// 退出码：0 = 采集正常收尾；1 = 采集失败/未知；2 = 入参或前置检查失败（进程根本没起）。
// 入参/前置检查失败一律在**启动前**报错退出 —— 那种「安静等满 60 分钟」的坑不能再犯。

import { closeSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 判据只许有一份：运行目录怎么认、进程算不算活着、退出码怎么读，全部从监督环复用。
// （复制一份出来迟早会漂移 —— 这是本项目「清单只许一份」那条规矩。）
import { discoverRunDir, isProcessAlive, readExitCode } from './supervise-collection.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const SUPERVISE = path.join(HERE, 'supervise-collection.mjs');
const COLLECTOR = 'skills/xws-export-market-analysis/scripts/run-adaptive-export.mjs';
const ENV_FILE = 'E:/小红书/.env.local';

const DEFAULTS = {
  keyword: '浴缸',
  pages: '40',
  frequency: '30-45',
  stallSeconds: '300',
  channel: 'all',
  sort: 'sales',
  price: '0-unlimited',
  export: 'csv,xlsx-images',
  runtimeDir: HERE,
  interval: 15,
  staleSeconds: 420,
  progressBudgetSeconds: 240,
  label: '浴缸竞品周采集',
  notify: false,
};

const NOTIFY_BOOL = new Set(['--notify', '--dry-run']);

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  const map = new Map([
    ['--keyword', 'keyword'],
    ['--pages', 'pages'],
    ['--frequency', 'frequency'],
    ['--stall-seconds', 'stallSeconds'],
    ['--channel', 'channel'],
    ['--sort', 'sort'],
    ['--price', 'price'],
    ['--export', 'export'],
    ['--output-dir', 'outputDir'],
    ['--checkpoint', 'checkpoint'],
    ['--proxy', 'proxy'],
    ['--runtime-dir', 'runtimeDir'],
    ['--interval', 'interval'],
    ['--stale-seconds', 'staleSeconds'],
    ['--progress-budget-seconds', 'progressBudgetSeconds'],
    ['--label', 'label'],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--notify') { options.notify = true; continue; }
    if (a === '--dry-run') { options.notify = false; continue; }
    if (NOTIFY_BOOL.has(a)) continue;
    const key = map.get(a);
    if (!key) throw new Error(`Unknown argument: ${a}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${a} requires a value`);
    options[key] = value;
    i += 1;
  }
  if (!options.outputDir) throw new Error('--output-dir is required (必须是浏览器的下载目录)');
  if (!options.checkpoint) throw new Error('--checkpoint is required');
  if (!options.proxy) throw new Error('--proxy is required');
  return options;
}

function readEnvFile(file) {
  const values = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) values[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/gu, '');
  }
  return values;
}

async function preflight(options) {
  // 1) 下载目录：必须是真实下载目录。传空目录 → 导出器 baseline=0 → 安静等满 60 分钟才报超时。
  if (!existsSync(options.outputDir)) throw new Error(`--output-dir 不存在：${options.outputDir}`);
  const entries = readdirSync(options.outputDir);
  if (entries.length === 0) {
    throw new Error(`--output-dir "${options.outputDir}" 是空的。它必须是浏览器的下载目录，`
      + '否则导出器永远认不出新下载的文件（会安静等满 60 分钟才报超时）。');
  }
  // 2) CDP 代理：先看 health，代理或浏览器没起来就别浪费一轮采集。
  const healthUrl = `${options.proxy.replace(/\/+$/u, '')}/health`;
  let health;
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(8000) });
    health = await response.json();
  } catch (error) {
    throw new Error(`${healthUrl} 不可达（${error.cause?.code || error.message}）——先起浏览器与代理再跑采集`);
  }
  // 3) 凭据：只读，不打印。
  const values = readEnvFile(ENV_FILE);
  if (!values.XWS_DATABASE_URL) throw new Error(`${ENV_FILE} 里没有 XWS_DATABASE_URL`);
  return { health, databaseUrl: values.XWS_DATABASE_URL };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runtimeDir = options.runtimeDir;

  const HOST_PID = path.join(runtimeDir, '.collection-host.pid');
  const HOST_LOG = path.join(runtimeDir, '.collection-host.log');
  const HEARTBEAT = path.join(runtimeDir, '.collection-host-heartbeat');
  const CHILD_PID = path.join(runtimeDir, '.collect-child-pid');
  const CODE_FILE = path.join(runtimeDir, '.collect-exit-code');
  const STDOUT_FILE = path.join(runtimeDir, '.collect-stdout.log');

  const log = (line) => {
    const text = `[${new Date().toISOString()}] ${line}\n`;
    try { appendFileSync(HOST_LOG, text); } catch { /* 日志写不了不阻塞采集 */ }
    process.stdout.write(text);
  };

  log(`host 启动 pid=${process.pid} pages=${options.pages} out=${options.outputDir} proxy=${options.proxy} 投递=${options.notify ? '飞书' : 'dry-run'}`);

  // 前置检查失败必须**在起进程之前**退出（exit 2），否则会变成一个"看起来在跑"的空转。
  let pre;
  try {
    pre = await preflight(options);
  } catch (error) {
    log(`前置检查未通过：${error.message}`);
    process.exit(2);
  }
  log(`代理 health：${JSON.stringify(pre.health).slice(0, 300)}`);

  // 旧证据一律清掉：监督环把"文件存在"读成"已退出"，留着上一轮的值会污染判定。
  for (const file of [CODE_FILE, CHILD_PID]) {
    try { unlinkSync(file); } catch { /* 没有更好 */ }
  }
  writeFileSync(STDOUT_FILE, '');
  writeFileSync(HOST_PID, String(process.pid));

  const env = {
    ...process.env,
    XWS_DATABASE_URL: pre.databaseUrl,
    XWS_PROXY: options.proxy,
    XWS_BROWSER_ID: 'edge-isolated',
  };

  // 关键：stdio 直接给文件描述符，**不是管道**。管道会随宿主一起死，fd 不会。
  const logFd = openSync(STDOUT_FILE, 'a');
  const child = spawn(process.execPath, [
    COLLECTOR,
    '--keyword', options.keyword,
    '--pages', String(options.pages),
    '--frequency', options.frequency,
    '--stall-seconds', String(options.stallSeconds),
    '--channel', options.channel,
    '--sort', options.sort,
    '--price', options.price,
    '--export', options.export,
    '--checkpoint', options.checkpoint,
    '--output-dir', options.outputDir,
    '--proxy', options.proxy,
  ], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  closeSync(logFd); // 子进程已持有自己的副本
  writeFileSync(CHILD_PID, String(child.pid));
  log(`采集子进程 pid=${child.pid}（detached，stdio 直写 ${STDOUT_FILE}）`);

  // 监督环也 detached、也直写 fd：宿主就算被回收，它自己也还剩一条命。
  const superviseArgs = [
    SUPERVISE,
    '--pid', String(child.pid),
    '--runtime-dir', runtimeDir,
    '--stdout-file', STDOUT_FILE,
    '--exit-code-file', CODE_FILE,
    '--stale-seconds', String(options.staleSeconds),
    '--progress-budget-seconds', String(options.progressBudgetSeconds),
    '--interval', String(options.interval),
    '--label', options.label,
    ...(options.notify ? [] : ['--dry-run']),
  ];
  const superviseFd = openSync(HOST_LOG, 'a');
  const supervisor = spawn(process.execPath, superviseArgs, {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: ['ignore', superviseFd, superviseFd],
    detached: true,
  });
  closeSync(superviseFd);
  log(`监督环 pid=${supervisor.pid} 投递=${options.notify ? '飞书' : 'dry-run'}`);

  const readPid = (file) => {
    try { return Number(readFileSync(file, 'utf8').trim()); } catch { return null; }
  };
  const lastSuperviseStatus = () => {
    // 监督环的状态文件落在**运行目录**里，运行目录本身靠 stdout 日志里的 runId 推出来
    // —— 这也是宿主自己被回收后别人还能接着看的原因。
    // 优先读心跳（每跳都写，含当前 status），退回读去重状态（只在变化时写，刚开跑会是空的）。
    let text = '';
    try { text = readFileSync(STDOUT_FILE, 'utf8'); } catch { return null; }
    const runDir = discoverRunDir(text, runtimeDir);
    if (!runDir) return null;
    for (const name of ['.supervision-heartbeat.json', '.supervision-state.json']) {
      const file = path.join(runDir, name);
      if (!existsSync(file)) continue;
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed.status) return parsed.status;
      } catch { /* 读坏了就试下一个 */ }
    }
    return null;
  };

  // 心跳：外部（人 / 另一个 agent）不连 stdout 也能判断"这一批还有没有人在管"。
  let finished = false;
  const beat = () => {
    const collectorPid = readPid(CHILD_PID);
    try {
      writeFileSync(HEARTBEAT, JSON.stringify({
        host: { pid: process.pid, alive: true, at: new Date().toISOString() },
        collector: { pid: collectorPid, alive: isProcessAlive(collectorPid), pages: String(options.pages), exitCode: readExitCode(CODE_FILE) },
        supervise: { pid: supervisor.pid, alive: isProcessAlive(supervisor.pid), lastStatus: lastSuperviseStatus() },
        notify: options.notify ? 'feishu' : 'dry-run',
        finished,
      }, null, 2));
    } catch { /* 心跳写不了不影响采集 */ }
  };
  beat();
  const beatTimer = setInterval(beat, 15_000);

  const code = await new Promise((resolve) => {
    child.on('close', (exitCode) => {
      // 退出码必须由**持有 fd 的那个进程**落盘 —— 这样即使宿主被回收也已经写好了。
      writeFileSync(CODE_FILE, String(exitCode ?? -1));
      log(`采集子进程结束 code=${exitCode}`);
      finished = true;
      beat();
      resolve(exitCode ?? -1);
    });
    child.on('error', (error) => {
      log(`采集子进程启动失败：${error.message}`);
      writeFileSync(CODE_FILE, '-1');
      resolve(-1);
    });
  });

  // 给监督环最多 90s 收尾（它会在读到 COMPLETED/FAILED 时自己退出）。
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const status = lastSuperviseStatus();
    if (status === 'COMPLETED' || status === 'FAILED') break;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  clearInterval(beatTimer);
  beat();
  log(`host 收尾，采集退出码 ${code}`);
  process.exit(code === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[host] fatal:', error.message);
  process.exit(1);
});
