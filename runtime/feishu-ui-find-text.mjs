#!/usr/bin/env node
const target = process.argv[2];
const text = process.argv.slice(3).join(' ');
const proxy = 'http://127.0.0.1:3456';
const response = await fetch(`${proxy}/eval?target=${encodeURIComponent(target)}`, { method: 'POST', body: `(() => { const needle=${JSON.stringify(text)}; const e=[...document.querySelectorAll('*')].find(x=>x.innerText===needle&&x.children.length<3); if(!e)return null; const r=e.getBoundingClientRect(); return JSON.stringify({tag:e.tagName,cls:e.className,x:r.x,y:r.y,w:r.width,h:r.height,html:e.outerHTML.slice(0,800)}); })()` });
console.log((await response.json()).value);
