#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { PROJECT_PORTS } from './browser-ports.mjs';

const DEFAULT_PROXY = `http://127.0.0.1:${PROJECT_PORTS.competitorProxy}`;
const NOTIFY = new URL('./notify-feishu.mjs', import.meta.url).pathname;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function loginPageExpression() {
  return `(() => {
    const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
    const account = document.querySelector('input[name="account"], input[autocomplete="username"], input[type="text"]');
    const password = document.querySelector('input[name="password"], input[autocomplete="current-password"], input[type="password"]');
    const buttons = [...document.querySelectorAll('button,a')].filter(visible).map((el) => ({ text: (el.innerText || el.textContent || '').replace(/\\s+/gu, ' ').trim(), href: el.href || null }));
    const body = (document.body?.innerText || '').replace(/\\s+/gu, ' ').trim();
    const captcha = [...document.querySelectorAll('iframe,[class*=captcha],[class*=verify],[id*=captcha],[id*=verify]')].some(visible)
      || /滑块|图片验证码|安全验证|风控/iu.test(body);
    return {
      href: location.href,
      account: account ? { visible: visible(account), autofill: account.matches(':autofill'), length: account.value.length } : null,
      password: password ? { visible: visible(password), autofill: password.matches(':autofill'), length: password.value.length } : null,
      loginButton: buttons.find((item) => item.text === '登录') || null,
      otherLogin: buttons.find((item) => /其它登录方式|其他登录方式/iu.test(item.text)) || null,
      captcha,
      loggedIn: !/\\/user\\/base-login/iu.test(location.pathname) && /退出|个人中心|我的账户|登录成功/iu.test(body),
    };
  })()`;
}

export function classifyLoginState(state) {
  if (!state || typeof state !== 'object') return 'PAGE_UNAVAILABLE';
  if (state.loggedIn === true) return 'ALREADY_LOGGED_IN';
  if (state.captcha === true) return 'CAPTCHA_REQUIRED';
  if (state.account?.visible && state.password?.visible) {
    if ((state.account.length || 0) > 0 && (state.password.length || 0) > 0) return 'READY_TO_SUBMIT';
    if (state.account.autofill === true || state.password.autofill === true) return 'AUTOFILL_READY';
    return 'NO_SAVED_CREDENTIAL';
  }
  return 'LOGIN_FORM_UNAVAILABLE';
}

async function request(proxy, path, init = {}) {
  const response = await fetch(`${proxy}${path}`, init);
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`proxy returned invalid JSON for ${path}`); }
  if (!response.ok || data?.error) throw new Error(String(data?.error || response.status));
  return data?.value ?? data;
}

async function notify(alert) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [NOTIFY], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill(); resolve({ status: 'FAILED', error: 'notification timeout' }); }, 30000);
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ status: 'FAILED', error: String(error.message) }); });
    child.on('close', (code) => { clearTimeout(timer); try { resolve(JSON.parse(out)); } catch { resolve({ status: code === 0 ? 'UNKNOWN' : 'FAILED', error: err.slice(0, 300) }); } });
    child.stdin.end(JSON.stringify(alert));
  });
}

async function discover(proxy) {
  const targets = await request(proxy, '/targets');
  const candidates = (Array.isArray(targets) ? targets : []).filter((item) => item.type === 'page' && /xiaowangshen\.com/iu.test(item.url || '') && item.targetId);
  for (const candidate of candidates) {
    try {
      const state = await request(proxy, `/eval?target=${encodeURIComponent(candidate.targetId)}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: loginPageExpression() });
      if (state?.account?.visible || state?.password?.visible || state?.otherLogin) return candidate;
    } catch { /* stale target; try the next one */ }
  }
  return candidates[0] || null;
}

async function closeStaleLoginTabs(proxy, keepTargetId) {
  const targets = await request(proxy, '/targets');
  for (const item of (Array.isArray(targets) ? targets : [])) {
    if (item.targetId !== keepTargetId && item.type === 'page' && /xiaowangshen\.com/iu.test(item.url || '') && /\/login/iu.test(item.url || '')) {
      await request(proxy, `/close?target=${encodeURIComponent(item.targetId)}`).catch(() => {});
    }
  }
}

export async function runXwsLogin({ proxy = DEFAULT_PROXY, commit = true, notifyOnFailure = true } = {}) {
  const fail = async (status, reason, targetId = null) => {
    const result = { status, reason, ...(targetId ? { targetId } : {}) };
    if (commit && notifyOnFailure) result.notification = await notify({
      version: 'xws-login-alert-v1', type: 'XWS_LOGIN_REQUIRED', severity: 'HIGH',
      reason, action: '请在买家 Edge 配置中完成人工登录；如出现验证码、滑块或短信验证请人工处理。',
    });
    return result;
  };
  const target = await discover(proxy);
  if (!target) return fail('PAGE_UNAVAILABLE', '小旺神登录页不存在，请先打开小旺神登录入口。');
  const read = async () => request(proxy, `/eval?target=${encodeURIComponent(target.targetId)}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: loginPageExpression() });
  let state = await read();
  let status = classifyLoginState(state);
  if (status === 'ALREADY_LOGGED_IN') { await closeStaleLoginTabs(proxy, target.targetId); return { status, targetId: target.targetId }; }
  if (status === 'LOGIN_FORM_UNAVAILABLE' && state.otherLogin) {
    const point = await request(proxy, `/eval?target=${encodeURIComponent(target.targetId)}`, {
      method: 'POST', headers: { 'content-type': 'text/plain' },
      body: `(() => { const e=[...document.querySelectorAll('a,button')].find(x=>/其它登录方式|其他登录方式/iu.test((x.innerText||x.textContent||'').trim())); const r=e?.getBoundingClientRect(); return r ? {x:r.x+r.width/2,y:r.y+r.height/2} : null; })()`,
    });
    if (point) await request(proxy, `/clickPoint?target=${encodeURIComponent(target.targetId)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(point),
    });
    await sleep(1500); state = await read(); status = classifyLoginState(state);
  }
  if (status === 'CAPTCHA_REQUIRED') return fail(status, '小旺神出现验证码或风控，已停止自动操作。', target.targetId);
  if (status === 'NO_SAVED_CREDENTIAL' || status === 'LOGIN_FORM_UNAVAILABLE') return fail(status, '没有可用的保存账号密码表单，需人工登录并保存密码。', target.targetId);
  if (!commit) return { status, targetId: target.targetId, autofill: status === 'AUTOFILL_READY' };
  if (status === 'AUTOFILL_READY') {
    const point = await request(proxy, `/eval?target=${encodeURIComponent(target.targetId)}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: `(() => { const e = document.querySelector('input[name="account"], input[autocomplete="username"], input[type="text"]'); const r=e?.getBoundingClientRect(); return r ? {x:r.x+r.width/2,y:r.y+r.height/2} : null; })()` });
    if (point) await request(proxy, `/clickAt?target=${encodeURIComponent(target.targetId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: point.x, y: point.y }) });
    await sleep(1200); state = await read(); status = classifyLoginState(state);
  }
  if (status !== 'READY_TO_SUBMIT') return fail(status, '保存凭据未落到页面，未提交。', target.targetId);
  const submit = await request(proxy, `/eval?target=${encodeURIComponent(target.targetId)}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: `(() => { const e=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='登录'); const r=e?.getBoundingClientRect(); return r ? {x:r.x+r.width/2,y:r.y+r.height/2} : null; })()` });
  if (!submit) return fail('LOGIN_BUTTON_UNAVAILABLE', '页面上找不到小旺神登录按钮，未提交。', target.targetId);
  await request(proxy, `/clickPoint?target=${encodeURIComponent(target.targetId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submit) });
  await sleep(5000); state = await read(); status = classifyLoginState(state);
  if (status === 'ALREADY_LOGGED_IN') { await closeStaleLoginTabs(proxy, target.targetId); return { status, targetId: target.targetId }; }
  return fail(status === 'CAPTCHA_REQUIRED' ? status : 'LOGIN_NOT_CONFIRMED', '提交后仍未确认登录成功。', target.targetId);
}

if (process.argv[1] && new URL(`file://${process.argv[1].replaceAll('\\\\', '/')}`).href === import.meta.url) {
  runXwsLogin({ commit: !process.argv.includes('--check-only') }).then((result) => { console.log(JSON.stringify(result, null, 2)); if (result.status !== 'ALREADY_LOGGED_IN') process.exitCode = 2; }).catch((error) => { console.error(JSON.stringify({ status: 'FAILED', error: String(error.message) })); process.exitCode = 1; });
}
