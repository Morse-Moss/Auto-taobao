#!/usr/bin/env node
// 一次性探针（2026-09-23）：商家浏览器的生意参谋「登录态」到底是死的还是活的？
//
// 为什么要它：只读体检与 login-merchant --check-only 都只能给「页面数量不对」，
// 而按本仓库纪律「读不到 ≠ 未登录」——它们给不出登录态结论。
// 唯一能定案的判据是：**真的导航到目标地址一次，看它最终落在哪个 URL**。
// 落在 custom/login.htm ⇒ 会话已失效（要人）；落在 performance ⇒ 会话还在（只是页签脏了）。
//
// 只读性：不碰现有标签页。新建一个临时页 → 导航 → 读 → 关掉它。
// 用法：node tmp/probe-merchant-sycm-login.mjs
import fs from 'node:fs';

const PROXY = 'http://127.0.0.1:19023';
const TARGET = 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop';

const out = [];
const log = (line) => { out.push(line); console.log(line); };

async function get(path) {
  const response = await fetch(`${PROXY}${path}`, { signal: AbortSignal.timeout(40000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status} ${text.slice(0, 200)}`);
  return text;
}

const targets = JSON.parse(await get('/targets'));
log('=== 导航前，这个浏览器里的页 ===');
for (const t of targets) log(`  ${t.targetId.slice(0, 8)}  ${t.url}`);

log('');
log(`=== 新建临时页并导航到目标地址 ===`);
log(`  url=${TARGET}`);
const created = JSON.parse(await get(`/new?url=${encodeURIComponent(TARGET)}`));
const newId = created.targetId;
log(`  targetId=${newId}`);

const after = JSON.parse(await get('/targets'));
const mine = after.find((t) => t.targetId === newId);
log(`  导航后 URL=${mine?.url}`);
log(`  标题=${mine?.title}`);

let href = null;
let bodyText = null;
try {
  href = JSON.parse(await get(`/eval?target=${encodeURIComponent(newId)}&expr=${encodeURIComponent('location.href')}`));
} catch (error) { href = `eval 失败：${error.message}`; }
try {
  bodyText = JSON.parse(await get(`/eval?target=${encodeURIComponent(newId)}&expr=${encodeURIComponent('document.body ? document.body.innerText.slice(0,300) : "(no body)"')}`));
} catch (error) { bodyText = `eval 失败：${error.message}`; }
log(`  location.href=${JSON.stringify(href)}`);
log(`  body 前 300 字=${JSON.stringify(bodyText)}`);

const finalUrl = String(mine?.url ?? '');
const onLogin = /custom\/login\.htm|login\.taobao\.com|\/login/i.test(finalUrl);
log('');
log(`=== 判据 ===`);
log(`  落在登录页？ ${onLogin ? '是 ⇒ 会话已失效（要人重新登录）' : '否 ⇒ 会话还在（只是页签脏了）'}`);

// 收尾：把这个临时页关掉（只关我自己刚建的那一个）。
try {
  await get(`/close?target=${encodeURIComponent(newId)}`);
  log('  临时页已关闭');
} catch (error) {
  log(`  临时页关闭失败（不影响结论）：${error.message}`);
}

fs.writeFileSync('tmp/probe-merchant-sycm-login.txt', out.join('\n') + '\n', 'utf8');
