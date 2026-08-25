#!/usr/bin/env node
const target = process.argv[2];
if (!target) throw new Error('target required');
const proxy = 'http://127.0.0.1:3456';
async function call(path, body) { const r = await fetch(`${proxy}${path}`, { method: 'POST', body }); return r.json(); }
const evalPage = async (code) => (await call(`/eval?target=${encodeURIComponent(target)}`, code)).value;
await evalPage("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 'closed'");
await call(`/clickAt?target=${encodeURIComponent(target)}`, '[data-e2e=bitable-customize-field-btn]');
await new Promise((r) => setTimeout(r, 400));
console.log(await evalPage(`JSON.stringify({body:document.body.innerText.slice(-2500), fields:[...document.querySelectorAll('[data-e2e]')].map(e=>({d:e.getAttribute('data-e2e'),t:(e.innerText||'').slice(0,120),html:e.outerHTML.slice(0,300)})).filter(x=>x.d&&/field/i.test(x.d))})`));
