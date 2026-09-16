#!/usr/bin/env node
import { PROJECT_PORTS } from './browser-ports.mjs';
// 飞书网页登录态挂在**商家浏览器（乙）**上；端口来自 runtime/browser-ports.mjs。
// 2026-09-16：原先写死的 http://127.0.0.1:3456 是**别的项目**的共享代理 ——
// 那样能不能跑取决于别人的代理是否活着、以及那个浏览器里登的是谁。
const FEISHU_PROXY = `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;
const target=process.argv[2];const proxy=FEISHU_PROXY;
async function call(path,body){const r=await fetch(`${proxy}${path}`,{method:'POST',body});return r.json()}
const enc=encodeURIComponent(target);
await call(`/clickAt?target=${enc}`,'#bitable-container');
await call(`/clickAt?target=${enc}`,'[data-e2e=bitable-customize-field-btn]');
await new Promise(r=>setTimeout(r,300));
await call(`/clickAt?target=${enc}`,'[data-e2e=bitable-add-new-filed-btn]');
await new Promise(r=>setTimeout(r,300));
await call(`/clickAt?target=${enc}`,'.b-field-type.bitable-select-basic-field');
await new Promise(r=>setTimeout(r,250));
const out=await call(`/eval?target=${enc}`,`(()=>JSON.stringify({body:document.body.innerText.slice(-2000),types:[...document.querySelectorAll('.b-field-type')].map(e=>({t:e.innerText,html:e.outerHTML.slice(0,500)}))}))()`);
console.log(out.value);
