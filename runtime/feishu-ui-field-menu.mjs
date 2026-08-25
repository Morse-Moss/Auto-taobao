#!/usr/bin/env node
const target = process.argv[2];
const index = Number(process.argv[3] ?? 0);
const proxy = 'http://127.0.0.1:3456';
async function call(path, body) { const r = await fetch(`${proxy}${path}`, { method: 'POST', body }); return r.json(); }
const evalPage = async (code) => (await call(`/eval?target=${encodeURIComponent(target)}`, code)).value;
await call(`/clickAt?target=${encodeURIComponent(target)}`, '[data-e2e=bitable-customize-field-btn]');
await new Promise((r) => setTimeout(r, 300));
const result = await evalPage(`(() => { const xs=[...document.querySelectorAll('[data-e2e=bitable-field-more-btn]')]; const e=xs[${index}]; if(!e) throw new Error('field more button missing'); e.click(); return document.body.innerText.slice(-1800); })()`);
console.log(result);
