#!/usr/bin/env node
const target = process.argv[2];
const fieldId = process.argv[3];
const action = process.argv[4];
const proxy = 'http://127.0.0.1:3456';
async function call(path, body) { const r = await fetch(`${proxy}${path}`, { method: 'POST', body }); return r.json(); }
const evalPage = async (code) => (await call(`/eval?target=${encodeURIComponent(target)}`, code)).value;
await call(`/clickAt?target=${encodeURIComponent(target)}`, '[data-e2e=bitable-customize-field-btn]');
await new Promise((r) => setTimeout(r, 250));
await call(`/clickAt?target=${encodeURIComponent(target)}`, `.bitable-field-panel-list-field-item.${fieldId} [data-e2e=bitable-field-more-btn]`);
await new Promise((r) => setTimeout(r, 220));
const out = await evalPage(`(() => { const e=[...document.querySelectorAll('li')].find(x=>x.innerText===${JSON.stringify(action)}); if(!e)return 'menu not found'; e.click(); return document.body.innerText.slice(-2500); })()`);
console.log(out);
