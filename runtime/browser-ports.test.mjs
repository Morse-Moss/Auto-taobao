import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_IDS,
  BROWSER_LABELS,
  BROWSER_PROFILES,
  PROJECT_PORTS,
  classifyPortUsage,
  describeOccupant,
  extractProfileFromCommandLine,
  inspectPort,
  normalizeProfile,
  resolvePort,
} from './browser-ports.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- 静态守卫的取材范围：本项目自己写的 .mjs，不含 vendored 的 isolated-proxy、
// --- 浏览器 profile、运行产物，也不含测试（测试里允许写期望值）。
const SKIP_DIRS = new Set(['node_modules', '.git', 'isolated-proxy', 'edge-debug-profile', 'edge-daily-report-profile']);

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
  assert.equal(new Set(values).size, values.length, '四个端口必须互不重复');
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

test('生产代码里不得再写死项目端口 —— 只能从登记表取', () => {
  const literals = Object.values(PROJECT_PORTS);
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
