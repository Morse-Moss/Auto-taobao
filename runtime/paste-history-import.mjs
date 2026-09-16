import { PROJECT_PORTS } from './browser-ports.mjs';
// 飞书网页登录态挂在**商家浏览器（乙）**上；端口来自 runtime/browser-ports.mjs。
// 2026-09-16：原先写死的 http://127.0.0.1:3456 是**别的项目**的共享代理 ——
// 那样能不能跑取决于别人的代理是否活着、以及那个浏览器里登的是谁。
const FEISHU_PROXY = `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;
import fs from 'node:fs';
const target='F70F35C5CEFB80195C209AEA5D7CBEFC';
const csv=fs.readFileSync('D:/Retire/sycm-automation/runtime/latest-competitor-1-40-20260824.csv','utf8').replace(/^\uFEFF/,'');
function parse(s){const out=[];let row=[],f='',q=false;for(let i=0;i<s.length;i++){const c=s[i];if(q){if(c==='"'&&s[i+1]==='"'){f+='"';i++;}else if(c==='"')q=false;else f+=c;}else if(c==='"'&&f==='')q=true;else if(c===','){row.push(f);f='';}else if(c==='\n'){row.push(f.replace(/\r$/,''));out.push(row);row=[];f='';}else f+=c;}if(f||row.length){row.push(f.replace(/\r$/,''));out.push(row);}return out;}
const rows=parse(csv).slice(1);
const esc=v=>String(v??'').replace(/[\t\r\n]/g,' ');
const tsv=rows.map(r=>{const id=(r[3].match(/[?&]id=(\d+)/)||[])[1]||'';return [id+'-20260824',id,'','','',r[1],r[2],r[3],r[4],r[5],r[6],r[7],r[8],r[10],r[11],r[12],r[13],r[14],r[15],'浴缸','2026-08-24','v2','v1','','','','','','',''].map(esc).join('\t')}).join('\n');
fs.writeFileSync('D:/Retire/sycm-automation/runtime/latest-competitor-1-40-20260824.tsv',tsv,'utf8');
const code=`(()=>{const canvas=document.elementFromPoint(500,250);for(const type of ['mousedown','mouseup','click'])canvas?.dispatchEvent(new MouseEvent(type,{bubbles:true,clientX:500,clientY:250,button:0}));const dt=new DataTransfer();dt.setData('text/plain',${JSON.stringify(tsv)});const ev=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt});canvas?.dispatchEvent(ev);document.activeElement?.dispatchEvent(ev);return JSON.stringify({active:document.activeElement?.className,canvas:canvas?.tagName,bytes:${tsv.length},rows:${rows.length}})})()`;
const res=await fetch(`${FEISHU_PROXY}/eval?target=${target}`,{method:'POST',body:code});console.log(await res.text());
