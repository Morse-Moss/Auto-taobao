#!/usr/bin/env node
// 一次性探针 2（2026-09-23）：商家浏览器里每个页**实际**加载到了哪里？
//
// 探针 1 的教训：`Target.getTargets` 报的 `url` 是**目标地址**，不是**实际地址** ——
// 新建的页报着目标 URL，而 `location.href` 是 about:blank（根本没加载完）。
// 所以判据只能用 `location.href`（页面自己说的话），不能用 /targets 的 url 字段。
//
// 只读：只 eval，不导航、不建页、不关页。
// 用法：node tmp/probe-merchant-pages-actual.mjs
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = JSON.parse(await get('/targets'));
log(`=== 这个浏览器里有 ${targets.length} 个页；逐页读「页面自己说的话」 ===`);
for (const t of targets) {
  let state;
  const expr = `JSON.stringify({href: location.href, title: document.title, ready: document.readyState, bodyLen: (document.body ? document.body.innerText.length : -1)})`;
  try {
    state = JSON.parse(await get(`/eval?target=${encodeURIComponent(t.targetId)}&expr=${encodeURIComponent(expr)}`)).value;
  } catch (error) { state = `eval 失败：${error.message}`; }
  log(`  ${t.targetId.slice(0, 8)}`);
  log(`     /targets.url = ${t.url}`);
  log(`     页面自报     = ${state}`);
}

// 给它一次机会：如果刚才是「还没加载完」，等一会儿再读一遍。
log('');
log('=== 等 8 秒后再读一遍（区分「没加载完」与「加载不到」） ===');
await sleep(8000);
for (const t of targets) {
  let state;
  const expr = `JSON.stringify({href: location.href, ready: document.readyState})`;
  try {
    state = JSON.parse(await get(`/eval?target=${encodeURIComponent(t.targetId)}&expr=${encodeURIComponent(expr)}`)).value;
  } catch (error) { state = `eval 失败：${error.message}`; }
  log(`  ${t.targetId.slice(0, 8)}  ${state}`);
}

fs.writeFileSync('tmp/probe-merchant-pages-actual.txt', out.join('\n') + '\n', 'utf8');
