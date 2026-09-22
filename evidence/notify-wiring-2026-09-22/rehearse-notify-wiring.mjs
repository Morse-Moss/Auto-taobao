// 真机排练：让**真的**预检 CLI 在**没登记的端口**上、往**证据目录**里跑一遍，
// 验证两件事，且一条飞书消息都不发出去：
//   A) 默认投递出口确实被 spawn 起来了（真子进程、真 stdin、真退出码）；
//   B) 显式静音时确实**没有**起任何投递子进程。
//
// 为什么不用「假 fetch / 假 spawn」了事：本项目最贵的一课是「排练全绿 ≠ 真跑能跑」。
// 所以这里用真进程，只把「唯一不该碰的东西」（真的飞书投递）用**可控失败**挡住 ——
// `SYCM_FEISHU_PROFILE=bogus` 会让 CLI 在读 profile 时就抛错退出（零网络请求）。
//
// 用法：node tmp/_rehearse-notify-wiring.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'D:/Retire/sycm-automation';
const EVIDENCE = join(REPO, 'evidence/notify-wiring-2026-09-22');
const PREFLIGHT = join(REPO, 'runtime/xws-sku-auth-preflight.mjs');
const NOTIFY = join(REPO, 'runtime/notify-feishu.mjs');
const PRODUCT_ID = '1059970355633';

const log = [];
function say(line) {
  log.push(line);
  console.log(line);
}

function runNode(args, { env = {}, log = false } = {}) {
  return new Promise((done) => {
    // 数组传参：中文/引号不过 shell（本机 shell 会按 GBK 打坏参数）。
    const child = spawn(process.execPath, args, {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', (e) => done({ code: null, error: String(e.message), out, err }));
    child.on('close', (code) => done({ code, out, err }));
    child.stdin.end('');
    if (!log) return;
  });
}

async function startFakeProxy(targets) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/targets') {
      response.end(JSON.stringify(targets));
      return;
    }
    response.end(JSON.stringify({ value: {
      pageProductId: PRODUCT_ID,
      pluginPresent: true,
      skuControlPresent: true,
      loginMarkers: ['XWS_LOGIN'],
      visibleLoginDialog: false,
    } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function baseArgs(outputDirectory, proxy) {
  return [
    PREFLIGHT,
    '--proxy', proxy,
    '--product-id', PRODUCT_ID,
    '--product-url', `https://item.taobao.com/item.htm?id=${PRODUCT_ID}`,
    '--record-id', 'recMain',
    '--classification', 'A-爆款竞品',
    '--validity', '是',
    '--output-directory', outputDirectory,
  ];
}

function dump(dir, name, text) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text, 'utf8');
}

const targets = [{ targetId: 'target-1', type: 'page', url: `https://detail.tmall.com/item.htm?id=${PRODUCT_ID}` }];

// ── A) 默认出口：真 spawn，用可控失败挡住真实投递 ────────────────────────────
const runA = join(EVIDENCE, 'a-default-delivery-blocked');
{
  const { server, base } = await startFakeProxy(targets);
  try {
    const result = await runNode(baseArgs(runA, base), { env: { SYCM_FEISHU_PROFILE: 'bogus-on-purpose' } });
    dump(runA, 'preflight-stdout.txt', result.out);
    dump(runA, 'preflight-stderr.txt', result.err);
    say(`[A] 预检 exit=${result.code}（期望 2 = HUMAN_REQUIRED，登录墙）。`);
    const alert = JSON.parse(readFileSync(join(runA, 'xws-sku-operator-alert.json'), 'utf8'));
    say(`[A] 告警 type=${alert.type}`);
    say(`[A] delivery=${JSON.stringify(alert.delivery)}`);
    const deliveryError = String(alert.delivery?.error ?? '');
    const spawned = deliveryError.includes('Unknown Feishu profile');
    say(`[A] 判据「真子进程被拉起并把告警喂了进去」= ${spawned}`);
    if (!spawned) say('[A] FAIL：投递子进程没跑起来，或者没拿到 CLI 的报错');
    if (alert.delivery?.status !== 'FAILED') say(`[A] FAIL：期望 FAILED（没送达），实际 ${alert.delivery?.status}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ── B) 显式静音：一个投递子进程都不许起 ──────────────────────────────────────
const runB = join(EVIDENCE, 'b-muted');
{
  const { server, base } = await startFakeProxy(targets);
  try {
    const result = await runNode([...baseArgs(runB, base), '--no-notify']);
    dump(runB, 'preflight-stdout.txt', result.out);
    dump(runB, 'preflight-stderr.txt', result.err);
    say(`[B] 预检 exit=${result.code}（期望 2）。`);
    const alert = JSON.parse(readFileSync(join(runB, 'xws-sku-operator-alert.json'), 'utf8'));
    say(`[B] delivery=${JSON.stringify(alert.delivery)}`);
    if (alert.delivery?.status !== 'MUTED') say(`[B] FAIL：期望 MUTED，实际 ${alert.delivery?.status}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ── C) 页面不在位：本条路上以前一个告警都不产生 ──────────────────────────────
const runC = join(EVIDENCE, 'c-page-unavailable');
{
  const { server, base } = await startFakeProxy([]);
  try {
    const result = await runNode([...baseArgs(runC, base), '--no-notify']);
    dump(runC, 'preflight-stdout.txt', result.out);
    dump(runC, 'preflight-stderr.txt', result.err);
    say(`[C] 预检 exit=${result.code}（期望 3 = STALLED，退出码语义与改动前一致）。`);
    const alert = JSON.parse(readFileSync(join(runC, 'xws-sku-operator-alert.json'), 'utf8'));
    say(`[C] 告警 type=${alert.type}；reason=${alert.reason}`);
    const statusName = readdirSync(runC).find((n) => n.startsWith('xws-sku-auth-status-'));
    const status = JSON.parse(readFileSync(join(runC, statusName), 'utf8'));
    say(`[C] 状态工件 status=${status.status}；page.pluginPresent=${JSON.stringify(status.page.pluginPresent)}（期望 null）`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ── D) 拿 A 产出的告警喂真投递 CLI 的 --dry-run：验证契约与「人话」 ───────────
{
  const alertPath = join(runA, 'xws-sku-operator-alert.json');
  const result = await runNode([NOTIFY, '--dry-run', '--alert-file', alertPath]);
  dump(EVIDENCE, 'd-dry-run-render.txt', `${result.out}\n--- stderr ---\n${result.err}`);
  say(`[D] 投递 CLI --dry-run exit=${result.code}（期望 0，零发送）。`);
  const receipt = JSON.parse(result.out);
  const lines = String(receipt.text).split('\n');
  say(`[D] 渲染第一行 = ${lines[0]}`);
  if (/^【[^】]*】[A-Z_]{4,}$/u.test(lines[0])) say('[D] FAIL：第一行还是机器标识，标题表又漏了');
}

dump(EVIDENCE, 'rehearsal-log.txt', `${log.join('\n')}\n`);
console.log(`\n留痕：${EVIDENCE}`);
