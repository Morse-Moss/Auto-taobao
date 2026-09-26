#!/usr/bin/env node
import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { PROJECT_PORTS, shopInstance } from '../../../runtime/browser-ports.mjs';
import { SHOP_IDENTITIES } from '../../sycm-alimama-daily-report/scripts/shop-identities.mjs';
import { alimamaIdentityExpression, assertMemberIdentity, createOverlayDismisser, defaultDownloadsDir, listDownloads, newEntries, overlayAfterExpression, overlayScanExpression, pickOverlayCloseCandidate } from '../../sycm-alimama-daily-report/scripts/collect-core.mjs';
import { buildProductReportUrl, PRODUCT_TASK_PREFIX, PRODUCT_TASK_RE, PRODUCT_ZIP_RE, uniqueNewProductTask, validateProductReportState } from './product-report-core.mjs';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function args(argv) { const o = { date: null, shop: null, task: null, downloads: defaultDownloadsDir(), locateOnly: false }; for (let i=0;i<argv.length;i+=1) { const k=argv[i]; if(k==='--date')o.date=argv[++i]; else if(k==='--shop')o.shop=argv[++i]; else if(k==='--task')o.task=argv[++i]; else if(k==='--downloads')o.downloads=path.resolve(argv[++i]); else if(k==='--locate-only')o.locateOnly=true; else throw Error(`unknown argument ${k}`); } if(!/^\d{4}-\d{2}-\d{2}$/u.test(o.date??''))throw Error('--date must be YYYY-MM-DD'); if(!o.shop)throw Error('--shop is required'); return o; }
async function request(proxy, endpoint, init) { const r=await fetch(`${proxy}${endpoint}`, init); const t=await r.text(); if(!r.ok)throw Error(`${endpoint} HTTP ${r.status} ${t.slice(0,200)}`); try{return JSON.parse(t)}catch{return t} }
async function evalOn(proxy, target, expression) { const x=await request(proxy,`/eval?target=${encodeURIComponent(target)}`,{method:'POST',body:expression}); return typeof x.value==='string' ? (()=>{try{return JSON.parse(x.value)}catch{return x.value}})() : x.value; }
async function click(proxy,target,selector) { return request(proxy,`/click?target=${encodeURIComponent(target)}`,{method:'POST',body:selector}); }
async function clickPoint(proxy,target,point) { return request(proxy,`/clickPoint?target=${encodeURIComponent(target)}`,{method:'POST',body:JSON.stringify({x:point[0],y:point[1]})}); }
async function state(proxy,target,date) { return evalOn(proxy,target,`(() => JSON.stringify({href:location.href,text:document.body.innerText.slice(-9000),triggers:[...document.querySelectorAll('.mx-trigger')].map(x=>(x.innerText||'').trim()),dimensions:[...document.querySelectorAll('input[type=checkbox]')].map(x=>({value:x.value,checked:x.checked}))}))()`); }
async function findPage(proxy) { const ts=await request(proxy,'/targets'); const pages=ts.filter(x=>x.type==='page'&&String(x.url).includes('one.alimama.com')); if(pages.length!==1)throw Error(`expected one alimama page, got ${pages.length}`); return pages[0].targetId; }
async function identity(proxy,target,shop) { const row=SHOP_IDENTITIES.find(x=>x.key===shop); if(!row?.alimamaMemberName)throw Error(`未登记阿里妈妈身份: ${shop}`); const got=await evalOn(proxy,target,alimamaIdentityExpression()); assertMemberIdentity({expectedName:row.alimamaMemberName,expectedId:row.alimamaMemberId,observed:got}); console.log(`[身份] ${got.memberName} / ${got.memberId} ✓`); }
async function setPlanDimension(proxy,target) { const opened=await evalOn(proxy,target,`(()=>{const e=[...document.querySelectorAll('.mx-trigger')].find(x=>(x.innerText||'').includes('维度 商品'));if(!e)return false;e.click();return true})()`); if(!opened)throw Error('找不到商品数据明细维度选择器'); let changed; const deadline=Date.now()+5000; while(Date.now()<deadline){changed=await evalOn(proxy,target,`(()=>{const p=document.querySelector('input[type=checkbox][value="promotion"]');const c=document.querySelector('input[type=checkbox][value="campaign"]');if(!p||!c)return {ok:false,reason:'dimension-checkbox-missing'};if(!p.checked)p.click();if(!c.checked)c.click();const ok=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='确定');if(!ok)return {ok:false,reason:'confirm-missing'};ok.click();return {ok:true}})()`); if(changed?.ok||changed?.reason==='confirm-missing')break; await sleep(250); } if(!changed?.ok)throw Error(`设置商品+计划维度失败: ${changed?.reason}`); await sleep(2500); }
async function readProductTasks(proxy,target) { return evalOn(proxy,target,`[...new Set([...document.querySelectorAll('*')].filter(x=>x.children.length===0&&${PRODUCT_TASK_RE}.test((x.innerText||'').trim())).map(x=>(x.innerText||'').trim()))]`); }
async function submit(proxy,target,before) { const clicked=await evalOn(proxy,target,`(()=>{const e=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='下载报表');if(!e)return false;e.click();return true})()`); if(!clicked)throw Error('商品报表找不到下载报表按钮'); await sleep(1200); const confirmed=await evalOn(proxy,target,`(()=>{const e=[...document.querySelectorAll('button,span,a,div')].find(x=>x.children.length===0&&/^(确定|确认)$/.test((x.innerText||'').trim())&&x.getBoundingClientRect().width>0);if(!e)return false;e.click();return true})()`); if(!confirmed)throw Error('商品报表下载弹窗没有可点击确定'); await sleep(2500); await request(proxy,`/navigate?target=${target}&url=${encodeURIComponent('https://one.alimama.com/index.html#!/report/download-list')}`); await sleep(5000); const after=await readProductTasks(proxy,target); const task=uniqueNewProductTask(before,after); console.log(`[提交] ${task}`); return task; }
async function waitForTaskReady(proxy,target,task,timeoutMs=180000) { const deadline=Date.now()+timeoutMs; let last=''; while(Date.now()<deadline){ const rows=await evalOn(proxy,target,`[...document.querySelectorAll('tr')].map(tr=>(tr.innerText||'').replace(/\\s+/g,' ').trim()).filter(text=>text.includes(${JSON.stringify(task)}))`); last=rows[0]||'missing'; if(/生成成功/u.test(last))return last; if(/生成失败|失败/u.test(last))throw Error(`商品报表任务生成失败: ${last}`); await sleep(5000); } throw Error(`商品报表生成等待超时（${timeoutMs}ms）: ${last}`); }
async function navigateDownloadList(proxy,target) {
  await request(proxy,`/navigate?target=${target}&url=${encodeURIComponent('https://one.alimama.com/index.html#!/report/download-list')}`);
  await sleep(5000);
  return findPage(proxy);
}
async function dismissOverlay(proxy,target,selector) {
  const dismisser=createOverlayDismisser({
    evalOn: async (_args,id,expression)=>evalOn(proxy,id,expression),
    clickPoint: async (_args,id,point)=>clickPoint(proxy,id,point),
    delay: sleep,
    log: (line)=>console.log(line),
  });
  return dismisser({},target,selector);
}
async function fetchTask(proxy,target,task,downloads) {
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const before = listDownloads(downloads,PRODUCT_ZIP_RE).map(x=>x.name);
    try {
      const ready = await waitForTaskReady(proxy,target,task);
      const row = await evalOn(proxy,target,`(()=>{const n=[...document.querySelectorAll('*')].find(x=>x.children.length===0&&(x.innerText||'').trim()===${JSON.stringify(task)});const tr=n&&n.closest('tr');const box=tr&&tr.querySelector('input[type=checkbox]');if(!box)return {ok:false,reason:'checkbox-missing'};const r=box.getBoundingClientRect();return {ok:true,checked:box.checked,center:[Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]}})()`);
      if(!row?.ok)throw Error(`商品报表任务行没有复选框: ${ready}`);
      if(!row.checked){
        const scan=await evalOn(proxy,target,overlayScanExpression());
        if(scan?.blocked){await dismissOverlay(proxy,target,null);throw Error('下载任务页被平台遮挡层拦住，已尝试安全关闭并刷新重试');}
        await clickPoint(proxy,target,row.center); await sleep(800);
      } else {
        const visible = await evalOn(proxy,target,`(()=>{const n=[...document.querySelectorAll('*')].find(x=>x.children.length===0&&(x.innerText||'').trim()===${JSON.stringify(task)});const a=n?.closest('tr')?.nextElementSibling;return !!a&&getComputedStyle(a).display!=='none'})()`);
        if(!visible){
          await clickPoint(proxy,target,row.center); await sleep(500);
          await clickPoint(proxy,target,row.center); await sleep(800);
        }
      }
      const activated = await evalOn(proxy,target,`(()=>{const n=[...document.querySelectorAll('*')].find(x=>x.children.length===0&&(x.innerText||'').trim()===${JSON.stringify(task)});const tr=n&&n.closest('tr');const box=tr&&tr.querySelector('input[type=checkbox]');return !!box&&box.checked})()`);
      const actionVisible = await evalOn(proxy,target,`(()=>{const n=[...document.querySelectorAll('*')].find(x=>x.children.length===0&&(x.innerText||'').trim()===${JSON.stringify(task)});const a=n?.closest('tr')?.nextElementSibling;return !!a&&getComputedStyle(a).display!=='none'})()`);
      if(!activated||!actionVisible)throw Error('真实点击后目标任务操作行仍未显形');
      await sleep(800);
      const point=await evalOn(proxy,target,`(()=>{const n=[...document.querySelectorAll('*')].find(x=>x.children.length===0&&(x.innerText||'').trim()===${JSON.stringify(task)});const tr=n&&n.closest('tr');const a=tr&&tr.nextElementSibling;const e=a&&[...a.querySelectorAll('*')].find(x=>x.children.length===0&&(x.innerText||'').trim()==='下载'&&x.getBoundingClientRect().width>0);if(!e)return null;const b=e.closest('button')||e;const r=b.getBoundingClientRect();const cx=Math.round(r.x+r.width/2),cy=Math.round(r.y+r.height/2),hit=document.elementFromPoint(cx,cy);return {point:[cx,cy],hit:!!hit,targetHit:!!hit&&(hit===b||b.contains(hit)||hit.contains(b))}})()`);
      if(!point)throw Error('商品报表任务下载入口不可见');
      if(!point.targetHit){
        const dismissed=await dismissOverlay(proxy,target,'button');
        if(dismissed?.dismissed)throw Error('下载入口曾被平台遮挡层拦截，已关闭遮挡层并刷新重试');
        throw Error('商品报表下载入口未命中可点击元素，页面可能存在非标准遮挡');
      }
      await clickPoint(proxy,target,point.point);
      const deadline=Date.now()+60000;
      while(Date.now()<deadline){
        await sleep(2000);
        const fresh=newEntries(before,listDownloads(downloads,PRODUCT_ZIP_RE).map(x=>x.name));
        const match=fresh.find(name=>name.startsWith(task));
        if(match){const full=path.join(downloads,match);console.log(`[下载] ${full} (${statSync(full).size} bytes)`); return full;}
      }
      throw Error(`商品报表下载超时: ${task}`);
    } catch (error) {
      attempts.push({attempt, target, error: error.message});
      console.warn(`[下载重试] ${task} 第 ${attempt} 次失败：${error.message}`);
      if (attempt === 3) throw Error(`${error.message}；重试记录=${JSON.stringify(attempts)}`);
      target = await navigateDownloadList(proxy,target);
      console.log(`[下载重试] 已刷新任务管理页并重新发现 target=${target}`);
    }
  }
  throw Error(`商品报表下载未完成: ${task}`);
}
async function main(){const o=args(process.argv.slice(2));const inst=shopInstance(o.shop);const proxy=`http://127.0.0.1:${inst.proxyPort}`;let target=await findPage(proxy);await identity(proxy,target,o.shop);if(o.task){target=await navigateDownloadList(proxy,target);await fetchTask(proxy,target,o.task,o.downloads);return;}target=await navigateDownloadList(proxy,target);const before=await readProductTasks(proxy,target);await request(proxy,`/navigate?target=${target}&url=${encodeURIComponent(buildProductReportUrl(o.date))}`);await sleep(6500);target=await findPage(proxy);await setPlanDimension(proxy,target);const checked=await state(proxy,target,o.date);validateProductReportState(checked,o.date);console.log(`[校验] 商品报表 / ${o.date} / 商品+计划 ✓`);if(o.locateOnly){console.log('[排练] 未提交下载');return;}const task=await submit(proxy,target,before);target=await findPage(proxy);await fetchTask(proxy,target,task,o.downloads);}
main().catch(e=>{console.error(`采集失败：${e.message}`);process.exitCode=1});
