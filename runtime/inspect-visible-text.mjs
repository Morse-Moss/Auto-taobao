import { execFileSync } from 'node:child_process';
const expression = String.raw`(() => {
 const vis=(e)=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
 const out=[...document.querySelectorAll('body *')].filter(e=>vis(e)).map(e=>{const r=e.getBoundingClientRect(); return {tag:e.tagName,cls:String(e.className||'').slice(0,180),role:e.getAttribute('role'),e2e:e.getAttribute('data-e2e'),text:(e.innerText||e.textContent||'').trim(),rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},outer:e.outerHTML.slice(0,900)}}).filter(x=>x.text&&x.text.length<=120&&x.rect.x>500&&x.rect.y>130); return JSON.stringify(out.slice(-500),null,2); })()`;
const targets=JSON.parse(execFileSync('curl.exe',['-s','http://127.0.0.1:3456/targets'],{encoding:'utf8'}));
const target=targets.find((item)=>item.type==='page'&&item.url.startsWith('https://rcndesfqro3x.feishu.cn/base/OWebbPUcBa7B8JseYLccQCy9nkf'))?.targetId;
if(!target)throw new Error('authorized Feishu target not found');
console.log(execFileSync('curl.exe',['-s','-X','POST',`http://127.0.0.1:3456/eval?target=${target}`,'-H','Content-Type: text/plain','--data-binary',expression],{encoding:'utf8'}));
