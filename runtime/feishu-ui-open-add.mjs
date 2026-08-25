#!/usr/bin/env node
const target=process.argv[2];const proxy='http://127.0.0.1:3456';
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
