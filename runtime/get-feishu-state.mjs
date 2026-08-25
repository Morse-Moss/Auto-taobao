import { execFileSync } from 'node:child_process';
const targets = JSON.parse(execFileSync('curl.exe', ['-s', 'http://127.0.0.1:3456/targets'], { encoding: 'utf8' }));
const target = targets.find((item) => item.type === 'page' && item.url.startsWith('https://rcndesfqro3x.feishu.cn/base/OWebbPUcBa7B8JseYLccQCy9nkf'))?.targetId;
if (!target) throw new Error('authorized Feishu target not found');
const expr = String.raw`(() => {
 const vis=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'};
 const item=e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,id:e.id||null,cls:String(e.className||'').slice(0,180),role:e.getAttribute('role'),e2e:e.getAttribute('data-e2e'),sel:e.getAttribute('data-selector'),fid:e.getAttribute('data-field-id'),aria:e.getAttribute('aria-label'),title:e.getAttribute('title'),type:e.getAttribute('type'),value:'value' in e?String(e.value||'').slice(0,500):null,ce:e.getAttribute('contenteditable'),text:(e.innerText||e.textContent||'').trim().slice(0,700),rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},outer:e.outerHTML.slice(0,1000)}};
 const els=[...document.querySelectorAll('body *')].filter(vis);
 const controls=[...document.querySelectorAll('button,input,textarea,[contenteditable=true],[role=button],[role=textbox],[role=combobox]')].filter(vis).map(item);
 const candidates=els.filter(e=>/(提示词|prompt|引用|保存|生成|开始生成|字段配置|材质分类|商品标题|是否有效竞品|卖点|AI|智能字段|配置)/i.test([e.innerText||'',e.getAttribute('aria-label')||'',e.getAttribute('data-e2e')||'',e.getAttribute('data-selector')||'',String(e.className||'')].join(' '))).map(item);
 return JSON.stringify({url:location.href,title:document.title,body:(document.body.innerText||'').slice(-10000),controls:controls.slice(-300),candidates:candidates.filter(x=>x.rect.w>100&&x.rect.h>20).slice(-250)},null,2);
})()`;
const raw=execFileSync('curl.exe',['-s','-X','POST',`http://127.0.0.1:3456/eval?target=${target}`,'-H','Content-Type: text/plain','--data-binary',expr],{encoding:'utf8'});
const parsed=JSON.parse(raw);
const value=typeof parsed.value==='string'?JSON.parse(parsed.value):parsed.value;
console.log(JSON.stringify({target,url:value.url,title:value.title,body:value.body,controls:value.controls,candidates:value.candidates},null,2));
