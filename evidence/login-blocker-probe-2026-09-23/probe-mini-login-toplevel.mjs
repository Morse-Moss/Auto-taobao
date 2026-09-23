// 一次性实例真机探针：`havanalogin.taobao.com/mini_login.htm` **带参数顶层直接打开**能不能用。
//
// 为什么问这个（这决定了盖文天猫要不要人工登，是 0 人工还是 1 次人工的分水岭）：
//   盖文天猫的密码库里那条凭据 origin = `https://havanalogin.taobao.com`，
//   而自动登录脚本打开的登录页 origin = `https://login.taobao.com`（另一台主机）。
//   Chromium **只按 origin 匹配** ⇒ 那条凭据永远填不上 ⇒ 必然判 NO_SAVED_CREDENTIAL（已实测）。
//   唯一不用人工的出路：**让脚本去打开凭据所属 origin 上的登录页**。
//   而那个 origin 上到底哪个 URL 是活的 —— 平台自己给了答案：生意参谋登录页内嵌的
//   iframe src（2026-09-23 从 19045 的登录页上只读读出，见 gaiwen-tmall-login-frame.json）。
//
// 本探针只回答一件事：把那个 src **顶层**打开，页面上有没有真的登录表单。
//   对照组：同一个 URL **去掉查询参数** —— 既有的实测说法是它会回「非法请求 [appNameError]」。
//   两组并排跑，才能说清「是这条 origin 死，还是缺参数才死」。
//   （本仓纪律：判据要看**同行并排对照**，不能拿「一次失败」当结论。）
//
// 它**不填任何账号**、不提交、不点：临时 profile 里本来也没有凭据，填不了。
// 三条纪律同既有演练：未登记端口 + 临时 profile；端口先探空再起；跑完 taskkill /T + 端口回读。
//
// 用法：node evidence/login-blocker-probe-2026-09-23/probe-mini-login-toplevel.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const NODE = process.execPath;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const say = (line) => process.stdout.write(`${line}\n`);

const BROWSER_PORT = 19937;
const PROXY_PORT = 19947;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;

// 平台自己给的带参数地址（逐字来自 19045 上那个登录页的 iframe src，只把 rnd 换成新的）。
const WITH_PARAMS = 'https://havanalogin.taobao.com/mini_login.htm?lang=zh_cn&appName=taobao'
  + '&appEntrance=sycm_new&styleType=vertical&bizParams=&notLoadSsoView=true&notKeepLogin=false'
  + '&isMobile=false&cssUrl=https://g.alicdn.com/dt/sycm-login-css/0.0.1/sycm-iframe-style.css'
  + '&returnUrl=https://sycm.taobao.com/portal/home.htm&rnd=0.1234567890';
// 对照组：同主机、同路径，**不带任何查询参数**。
const BARE = 'https://havanalogin.taobao.com/mini_login.htm';

const report = { startedAt: new Date().toISOString(), browserPort: BROWSER_PORT, proxyPort: PROXY_PORT, cases: [] };
const note = (name, detail) => { say(`  · ${name}：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };

async function portAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    return `HTTP ${r.status}`;
  } catch { return null; }
}

async function evalOn(targetId, expression) {
  const r = await fetch(`${PROXY}/eval?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: expression, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`POST /eval → HTTP ${r.status}`);
  return (await r.json())?.value;
}

/**
 * 开一个页再导航过去 —— 刻意**不**用 `/new?url=<外站>`。
 *
 * 为什么（本轮实测）：`/new` 带上外站 URL 时，代理那一侧会卡在这一跳上直到超时
 * （第一次跑就是死在这里：`!! 探针中断：The operation was aborted due to timeout`，
 * 而那一刻连 `href` 都还没读到）。先开 `about:blank` 再 `/navigate` 就把
 * 「建页签」与「加载外站」两件事拆开了，两边各自有超时，失败也知道死在哪一半。
 */
async function openThenNavigate(url, label) {
  const created = await fetch(`${PROXY}/new?url=about%3Ablank&label=${encodeURIComponent(label)}&pinned=1`,
    { method: 'POST', signal: AbortSignal.timeout(20000) }).then((r) => r.json());
  const targetId = created.targetId;
  try {
    await fetch(`${PROXY}/navigate?target=${encodeURIComponent(targetId)}&url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(60000) });
  } catch (error) {
    // 导航超时不等于页面没打开：下面照旧读一次现场，把「读到了什么」记下来。
    say(`  （/navigate 报：${error.message} —— 仍然读一次现场）`);
  }
  return targetId;
}

// 与产品代码**同一份**表单状态表达式（不在这里另写一份，避免「验的是另一套」）。
const { FORM_STATE_EXPRESSION } = await import(
  new URL('../../skills/sycm-alimama-daily-report/scripts/login-merchant-core.mjs', import.meta.url).href
);

const children = [];
let profile = null;

async function cleanup(reason) {
  say(`\n=== 释放（${reason}）`);
  report.release = { reason, killed: [] };
  for (const child of children) {
    if (!child.pid) continue;
    const kill = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' });
    report.release.killed.push({ pid: child.pid, taskkill: `${kill.status}` });
  }
  await sleep(2500);
  report.release.browserPortAfter = await portAlive(BROWSER_PORT);
  report.release.proxyPortAfter = await portAlive(PROXY_PORT);
  report.release.ok = report.release.browserPortAfter === null && report.release.proxyPortAfter === null;
  if (profile) {
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); report.release.profileRemoved = true; }
    catch (error) { report.release.profileRemoved = String(error.message).slice(0, 200); }
  }
  say(`  端口回读：浏览器=${report.release.browserPortAfter} 代理=${report.release.proxyPortAfter}；profile 删除=${report.release.profileRemoved}`);
}

try {
  const browserBefore = await portAlive(BROWSER_PORT);
  const proxyBefore = await portAlive(PROXY_PORT);
  note('前提：两个端口事先是空的', { browserBefore, proxyBefore });
  if (browserBefore !== null || proxyBefore !== null) throw new Error('端口已被占用 ⇒ 停手');

  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-login-toplevel-'));
  report.temporaryProfile = profile;
  say(`=== 起一次性实例：port=${BROWSER_PORT} profile=${profile}`);

  children.push(spawn(NODE, [path.join(REPO, 'runtime/start-project-browser.mjs')], {
    cwd: REPO,
    env: { ...process.env, PROJECT_BROWSER_PORT: String(BROWSER_PORT), PROJECT_BROWSER_PROFILE: profile, PROJECT_BROWSER_URL: 'about:blank' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  children.push(spawn(NODE, [path.join(REPO, 'runtime/isolated-proxy/cdp-proxy.mjs')], {
    cwd: REPO,
    env: { ...process.env, CDP_PROXY_PORT: String(PROXY_PORT), CDP_BROWSER_PORT: String(BROWSER_PORT), CDP_BROWSER_ID: 'mini-login-probe', CDP_BROWSER_LABEL: '一次性探针实例（跑完就释放）' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));

  for (const [label, url] of [['调试端口', `http://127.0.0.1:${BROWSER_PORT}/json/version`], ['代理', `${PROXY}/targets`]]) {
    const deadline = Date.now() + 60000;
    let last = '';
    for (;;) {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(2500) }); if (r.ok) break; last = `HTTP ${r.status}`; }
      catch (error) { last = error.cause?.code ?? error.message; }
      if (Date.now() > deadline) throw new Error(`${label} 没就绪（${last}）`);
      await sleep(500);
    }
    note(`${label} 就绪`, 'ok');
  }

  // 两组并排跑，同一份读法。**一组坏掉不影响另一组**：只跑成一组也算有结论
  // （而且「带参数那组也读不到」本身就是结论）。
  for (const [name, url] of [['带参数（平台给的那条）', WITH_PARAMS], ['裸 URL（无参数，对照组）', BARE]]) {
    say(`\n=== ${name}`);
    say(`  ${url}`);
    try {
      const targetId = await openThenNavigate(url, name);
      await sleep(9000);
      const state = JSON.parse(await evalOn(targetId, FORM_STATE_EXPRESSION));
      const text = await evalOn(targetId, '(() => (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim().slice(0, 200))()');
      const shot = await fetch(`${PROXY}/screenshot?target=${encodeURIComponent(targetId)}`, { signal: AbortSignal.timeout(30000) });
      const dir = path.join(import.meta.dirname, 'shots');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `mini-login-${name.startsWith('带参数') ? 'with-params' : 'bare'}.png`);
      if (shot.ok) fs.writeFileSync(file, Buffer.from(await shot.arrayBuffer()));
      const found = {
        href: state.href,
        idBox: state.id ? { rect: state.id.rect, visible: state.id.visible } : null,
        passwordBox: state.password ? { rect: state.password.rect, visible: state.password.visible } : null,
        submitBox: state.submit ? { rect: state.submit.rect, visible: state.submit.visible } : null,
        agreementBox: state.agreement ? { rect: state.agreement.rect, visible: state.agreement.visible } : null,
        text: String(text ?? '').slice(0, 160),
        shot: path.relative(REPO, file),
      };
      report.cases.push({ name, url, found });
      say(`  href=${found.href}`);
      say(`  账号框=${JSON.stringify(found.idBox)} 密码框=${JSON.stringify(found.passwordBox)} 登录按钮=${JSON.stringify(found.submitBox)}`);
      say(`  正文前 160 字：${found.text}`);
    } catch (error) {
      report.cases.push({ name, url, error: String(error?.message ?? error).slice(0, 300) });
      say(`  这一组没读成：${error.message}`);
    }
  }

  const [withParams, bare] = report.cases;
  const hasForm = (c) => Boolean(c?.found?.idBox?.visible && c?.found?.passwordBox?.visible && c?.found?.submitBox?.visible);
  report.verdict = {
    withParamsRendersForm: hasForm(withParams),
    bareRendersForm: hasForm(bare),
    conclusion: hasForm(withParams)
      ? (hasForm(bare) ? '带参数与裸 URL 都能渲染登录表单' : '带参数能渲染表单、裸 URL 不能 ⇒ 这条 origin 没死，是缺参数才回「非法请求」')
      : '带参数也渲染不出登录表单 ⇒ 这条 origin 上没有可用的顶层登录页',
  };
  say(`\n=== 结论：${JSON.stringify(report.verdict)}`);
} catch (error) {
  report.fatal = String(error?.stack ?? error).slice(0, 2000);
  say(`\n!! 探针中断：${error.message}`);
} finally {
  await cleanup(report.fatal ? '中断也要释放' : '探针结束');
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(import.meta.dirname, 'probe-mini-login-toplevel.json'), `${JSON.stringify(report, null, 1)}\n`, 'utf8');
  say('明细：evidence/login-blocker-probe-2026-09-23/probe-mini-login-toplevel.json');
  process.exitCode = report.fatal ? 1 : 0;
}
