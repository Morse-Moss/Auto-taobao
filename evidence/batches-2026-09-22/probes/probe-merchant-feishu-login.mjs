#!/usr/bin/env node
// 一次性探针 4（2026-09-23）：商家浏览器里的**飞书底单页**，会话还在不在？
// 为什么必须问：推送段（写飞书）跑在这个浏览器上。如果飞书也掉登录，
// 待办清单里就得写上「飞书也登一次」，否则人登录完淘宝还会撞第二堵墙。
// 只读：只 eval，不导航、不建页、不关页。
import fs from 'node:fs';

const PROXY = 'http://127.0.0.1:19023';
const out = [];
const log = (line) => { out.push(line); console.log(line); };

async function get(path) {
  const response = await fetch(`${PROXY}${path}`, { signal: AbortSignal.timeout(40000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status} ${text.slice(0, 200)}`);
  return text;
}

const targets = JSON.parse(await get('/targets'));
const feishu = targets.filter((t) => /feishu\.cn|feishu\.com|larksuite/i.test(t.url));
if (feishu.length === 0) {
  log('这个浏览器里没有飞书页（那是「页面不在位」的问题，不是登录态问题）');
  fs.writeFileSync('tmp/probe-merchant-feishu-login.txt', out.join('\n') + '\n', 'utf8');
  process.exit(0);
}

for (const t of feishu) {
  const expr = `JSON.stringify({
    href: location.href,
    title: document.title,
    ready: document.readyState,
    bodyLen: (document.body ? document.body.innerText.length : -1),
    head: (document.body ? document.body.innerText.slice(0, 220) : null)
  })`;
  const raw = JSON.parse(await get(`/eval?target=${encodeURIComponent(t.targetId)}&expr=${encodeURIComponent(expr)}`)).value;
  const state = JSON.parse(raw);
  log(`=== ${t.targetId.slice(0, 8)} ===`);
  log(`  href   = ${state.href}`);
  log(`  title  = ${state.title}`);
  log(`  ready  = ${state.ready}   bodyLen=${state.bodyLen}`);
  log(`  正文前 220 字 = ${JSON.stringify(state.head)}`);
  const bounced = /login|passport|signin/i.test(state.href);
  log(`  判定：${bounced ? '**被弹到登录地址**（要人登录）' : '**URL 没被弹走**（地址仍是 base 页；正文很短时可能是未登录的壳，要人看一眼窗口）'}`);
  log('');
}

fs.writeFileSync('tmp/probe-merchant-feishu-login.txt', out.join('\n') + '\n', 'utf8');
