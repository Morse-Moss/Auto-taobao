#!/usr/bin/env node
import { PROJECT_PORTS } from './browser-ports.mjs';
// 飞书网页登录态挂在**商家浏览器（乙）**上；端口来自 runtime/browser-ports.mjs。
// 2026-09-16：原先写死的 http://127.0.0.1:3456 是**别的项目**的共享代理 ——
// 那样能不能跑取决于别人的代理是否活着、以及那个浏览器里登的是谁。
const FEISHU_PROXY = `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;
const target = process.argv[2];
if (!target) throw new Error('target required');
const proxy = FEISHU_PROXY;
async function call(path, body) { const r = await fetch(`${proxy}${path}`, { method: 'POST', body }); return r.json(); }
const evalPage = async (code) => (await call(`/eval?target=${encodeURIComponent(target)}`, code)).value;
await evalPage("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 'closed'");
await call(`/clickAt?target=${encodeURIComponent(target)}`, '[data-e2e=bitable-customize-field-btn]');
await new Promise((r) => setTimeout(r, 400));
console.log(await evalPage(`JSON.stringify({body:document.body.innerText.slice(-2500), fields:[...document.querySelectorAll('[data-e2e]')].map(e=>({d:e.getAttribute('data-e2e'),t:(e.innerText||'').slice(0,120),html:e.outerHTML.slice(0,300)})).filter(x=>x.d&&/field/i.test(x.d))})`));
