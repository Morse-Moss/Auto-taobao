#!/usr/bin/env node
// 一次性探针 3（2026-09-23）：**真导航一次**，判定商家浏览器的淘宝会话到底还在不在。
//
// 探针 1/2 的教训：
//   探针 1 用 /new 建新页 → 报回 about:blank（新页在后台没真正加载完），无效。
//   探针 2 只读现有页 → 它们**停在** custom/login.htm 且 ready=complete。
//     但「停在登录页」不足以定案：那可能只是上一次会话把地址存成了登录页（恢复时照原样加载）。
// 唯一能定案的判据：**把现有页真的导航到目标地址一次，看它最终落在哪**。
//   落在 custom/login.htm ⇒ 淘宝把请求弹回登录 ⇒ 会话已失效，只能人来一次。
//   落在 performance      ⇒ 会话还在，只是页签地址脏了（那就只是页面卫生问题）。
//
// 写操作声明：会导航 `--target`（默认那一页 sycm）一次。这是它作为「生意参谋工作页」的本职动作，
// 也是链的归位本来就会做的事。不改文件、不点按钮、不关页。
//
// 用法：node tmp/probe-merchant-navigate-once.mjs [targetId]
import fs from 'node:fs';

const PROXY = 'http://127.0.0.1:19023';
const BUSINESS_URL = 'https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop';

const out = [];
const log = (line) => { out.push(line); console.log(line); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const response = await fetch(`${PROXY}${path}`, { signal: AbortSignal.timeout(40000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status} ${text.slice(0, 200)}`);
  return text;
}

const targets = JSON.parse(await get('/targets'));
const want = process.argv[2] ?? targets.find((t) => t.url.includes('sycm.taobao.com') && t.url.includes('performance'))?.targetId
  ?? targets.find((t) => t.url.includes('sycm.taobao.com'))?.targetId;
if (!want) {
  log('这个浏览器里没有 sycm 页，无法做这个判据');
  fs.writeFileSync('tmp/probe-merchant-navigate-once.txt', out.join('\n') + '\n', 'utf8');
  process.exit(0);
}

const expr = `JSON.stringify({href: location.href, title: document.title, ready: document.readyState, bodyLen: (document.body ? document.body.innerText.length : -1)})`;
const before = JSON.parse(await get(`/eval?target=${encodeURIComponent(want)}&expr=${encodeURIComponent(expr)}`)).value;
log(`=== 导航前：${want.slice(0, 8)} ===`);
log(`  ${before}`);

log('');
log(`=== 导航到目标地址一次 ===`);
log(`  url=${BUSINESS_URL}`);
const navResult = await get(`/navigate?target=${encodeURIComponent(want)}&url=${encodeURIComponent(BUSINESS_URL)}`);
log(`  /navigate 回执=${String(navResult).slice(0, 200)}`);

// 等它把登录跳转走完（淘宝的 custom/login.htm 是服务端 302，通常几秒内落定）。
for (const waitMs of [3000, 5000, 8000]) {
  await sleep(waitMs);
  const now = JSON.parse(await get(`/eval?target=${encodeURIComponent(want)}&expr=${encodeURIComponent(expr)}`)).value;
  log(`  再等 ${waitMs}ms 后：${now}`);
}

const finalState = JSON.parse(await get(`/eval?target=${encodeURIComponent(want)}&expr=${encodeURIComponent(expr)}`)).value;
const final = JSON.parse(finalState);
const onLogin = /custom\/login\.htm|login\.taobao\.com/i.test(final.href);
log('');
log('=== 判据 ===');
log(`  最终 URL = ${final.href}`);
log(`  落在登录页？ ${onLogin ? '是 ⇒ **会话已失效**（淘宝把目标地址弹回了登录页）⇒ 需要人工登录一次' : '否 ⇒ **会话还在**（只是页签地址脏了）'}`);

fs.writeFileSync('tmp/probe-merchant-navigate-once.txt', out.join('\n') + '\n', 'utf8');
