#!/usr/bin/env node
import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { PROJECT_PORTS, shopInstance } from '../../../runtime/browser-ports.mjs';
import { SHOP_IDENTITIES } from '../../sycm-alimama-daily-report/scripts/shop-identities.mjs';
import { alimamaIdentityExpression, assertMemberIdentity, createOverlayDismisser, defaultDownloadsDir, describeOverlayAttempt, describeOverlayScan, listDownloads, newEntries, overlayAfterExpression, overlayScanExpression, pickOverlayCloseCandidate } from '../../sycm-alimama-daily-report/scripts/collect-core.mjs';
import { buildProductReportUrl, PRODUCT_TASK_PREFIX, PRODUCT_TASK_RE, PRODUCT_ZIP_RE, pickFetchCandidates, pollNewProductTask, reuseCandidateTask, uniqueNewProductTask, validateProductReportState } from './product-report-core.mjs';
import { nextDownloadAction } from './download-retry-core.mjs';
// 下载入口的判据（2026-10-21 抽出）：纯函数，有离线用例，见 download-entry-core.mjs 文件头。
import { describeDownloadFailure, rankDownloadCandidates } from './download-entry-core.mjs';
// 报表页就绪的判据（2026-10-22 抽出）：同一次真机事故的另一半，见 report-ready-core.mjs 文件头。
import { describeReportReadyFailure, pollReportReady } from './report-ready-core.mjs';
// 失败现场（2026-10-13 加，㊶）：单独跑这个脚本时，`商品报表下载超时: xxx` 不再只留一句符号。
import { captureCollectorFailureScene } from '../../sycm-alimama-daily-report/scripts/collect-failure-scene.mjs';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function args(argv) { const o = { date: null, shop: null, task: null, downloads: defaultDownloadsDir(), logDir: null, locateOnly: false, resubmit: true }; for (let i=0;i<argv.length;i+=1) { const k=argv[i]; if(k==='--date')o.date=argv[++i]; else if(k==='--shop')o.shop=argv[++i]; else if(k==='--task')o.task=argv[++i]; else if(k==='--downloads')o.downloads=path.resolve(argv[++i]); else if(k==='--log-dir')o.logDir=argv[++i]; else if(k==='--locate-only')o.locateOnly=true; else if(k==='--no-resubmit')o.resubmit=false; else throw Error(`unknown argument ${k}`); } if(!/^\d{4}-\d{2}-\d{2}$/u.test(o.date??''))throw Error('--date must be YYYY-MM-DD'); if(!o.shop)throw Error('--shop is required'); return o; }
async function request(proxy, endpoint, init) { const r=await fetch(`${proxy}${endpoint}`, init); const t=await r.text(); if(!r.ok)throw Error(`${endpoint} HTTP ${r.status} ${t.slice(0,200)}`); try{return JSON.parse(t)}catch{return t} }
async function evalOn(proxy, target, expression) { const x=await request(proxy,`/eval?target=${encodeURIComponent(target)}`,{method:'POST',body:expression}); return typeof x.value==='string' ? (()=>{try{return JSON.parse(x.value)}catch{return x.value}})() : x.value; }
async function click(proxy,target,selector) { return request(proxy,`/click?target=${encodeURIComponent(target)}`,{method:'POST',body:selector}); }
async function clickPoint(proxy,target,point) { return request(proxy,`/clickPoint?target=${encodeURIComponent(target)}`,{method:'POST',body:JSON.stringify({x:point[0],y:point[1]})}); }
async function state(proxy,target,date) { return evalOn(proxy,target,`(() => JSON.stringify({href:location.href,text:document.body.innerText.slice(-9000),triggers:[...document.querySelectorAll('.mx-trigger')].map(x=>(x.innerText||'').trim()),dimensions:[...document.querySelectorAll('input[type=checkbox]')].map(x=>({value:x.value,checked:x.checked}))}))()`); }
// 报表骨架读数（2026-10-22）：只为「等就绪」服务，所以读得很浅 —— 触发器文案 + 表格行数 + 网址。
// 不读 body.innerText 全量：页面还没渲出来时读到的是空壳，读全量只会让 `state()` 的判据更难解释。
async function readReportSkeleton(proxy,target) { return evalOn(proxy,target,`(()=>{const t=document.body.innerText||'';const tables=[...document.querySelectorAll('table')].map(x=>x.querySelectorAll('tbody tr').length);return JSON.stringify({href:location.href,triggers:[...document.querySelectorAll('.mx-trigger')].map(x=>(x.innerText||'').trim()),rows:tables.length?Math.max(...tables):0,hasDimensionText:t.includes('维度'),dimInputs:document.querySelectorAll('input[type=checkbox]').length})})()`); }
async function findPage(proxy) { const ts=await request(proxy,'/targets'); const pages=ts.filter(x=>x.type==='page'&&String(x.url).includes('one.alimama.com')); if(pages.length!==1)throw Error(`expected one alimama page, got ${pages.length}`); return pages[0].targetId; }
async function identity(proxy,target,shop) { const row=SHOP_IDENTITIES.find(x=>x.key===shop); if(!row?.alimamaMemberName)throw Error(`未登记阿里妈妈身份: ${shop}`); const got=await evalOn(proxy,target,alimamaIdentityExpression()); assertMemberIdentity({expectedName:row.alimamaMemberName,expectedId:row.alimamaMemberId,observed:got}); console.log(`[身份] ${got.memberName} / ${got.memberId} ✓`); }
async function setPlanDimension(proxy,target) { const opened=await evalOn(proxy,target,`(()=>{const e=[...document.querySelectorAll('.mx-trigger')].find(x=>(x.innerText||'').includes('维度 商品'));if(!e)return false;e.click();return true})()`); if(!opened)throw Error('找不到商品数据明细维度选择器'); let changed; const deadline=Date.now()+5000; while(Date.now()<deadline){changed=await evalOn(proxy,target,`(()=>{const p=document.querySelector('input[type=checkbox][value="promotion"]');const c=document.querySelector('input[type=checkbox][value="campaign"]');if(!p||!c)return {ok:false,reason:'dimension-checkbox-missing'};if(!p.checked)p.click();if(!c.checked)c.click();const ok=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='确定');if(!ok)return {ok:false,reason:'confirm-missing'};ok.click();return {ok:true}})()`); if(changed?.ok||changed?.reason==='confirm-missing')break; await sleep(250); } if(!changed?.ok)throw Error(`设置商品+计划维度失败: ${changed?.reason}`); await sleep(2500); }
async function readProductTasks(proxy,target) { return evalOn(proxy,target,`[...new Set([...document.querySelectorAll('*')].filter(x=>x.children.length===0&&${PRODUCT_TASK_RE}.test((x.innerText||'').trim())).map(x=>(x.innerText||'').trim()))]`); }
/**
 * 读任务行的**原文**（2026-10-18 加）：候选集要靠行里的「日期范围」列认目标日，
 * 而只读任务名是认不出来的（名字里只有提交时刻，见 product-report-core 文件头）。
 * 同一条任务在展开后会有多行都含任务名 ⇒ 按名字去重，留**第一次**出现的那行（即任务行本身）。
 */
async function readProductTaskRows(proxy,target) { const rows=await evalOn(proxy,target,`[...document.querySelectorAll('tr')].map(tr=>{const t=(tr.innerText||'').replace(/\\s+/g,' ').trim();const m=t.match(/商品报表_\\d{8}_\\d{6}/u);return m?{name:m[0],text:t.slice(0,400)}:null}).filter(Boolean)`); const seen=new Set(); return (rows||[]).filter(r=>{if(seen.has(r.name))return false;seen.add(r.name);return true}); }
async function submit(proxy,target,before,submittedOn) {
  // 2026-10-29 加：**提交前**先确认页面上没有全屏弹窗。
  // 现场（盖文淘宝 10-28）：点「下载报表」之后那枚「确定」被「优质计划防停投」弹窗吃掉，
  // 流程因为点到了**弹窗的**「确定」而误判 confirmed=true，错误一路拖到「轮询 30s 无新任务」
  // 才以「提交任务无法唯一确认」的面目暴露 —— 看着像平台没生成任务，实际是点错了地方。
  // 清不掉就明确报出来（带 OVERLAY_NOT_DISMISSED 标记），不再盲点一次确定。
  const guard=await evalOn(proxy,target,overlayScanExpression());
  if(guard?.blocked){
    const cleared=await dismissOverlay(proxy,target,null);
    if(!cleared?.dismissed)throw Error(`提交商品报表前有全屏弹窗且没能关掉：${describeOverlayAttempt(cleared)}`);
    console.log(`[遮挡] 提交前已清掉一层：${describeOverlayScan(cleared.scan,cleared.picked)}`);
  }
  const clicked=await evalOn(proxy,target,`(()=>{const e=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='下载报表');if(!e)return false;e.click();return true})()`); if(!clicked)throw Error('商品报表找不到下载报表按钮'); let confirmed=false; for(let round=0;round<2&&!confirmed;round+=1){ if(round>0){await evalOn(proxy,target,`(()=>{const e=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='下载报表');if(!e)return false;e.click();return true})()`);} const confirmDeadline=Date.now()+20000; while(!confirmed&&Date.now()<confirmDeadline){ await sleep(1000); confirmed=await evalOn(proxy,target,`(()=>{const e=[...document.querySelectorAll('button,span,a,div')].find(x=>x.children.length===0&&/^(确定|确认)$/.test((x.innerText||'').trim())&&x.getBoundingClientRect().width>0);if(!e)return false;e.click();return true})()`); } } if(!confirmed)throw Error('商品报表下载弹窗没有可点击确定（轮询 40s 仍未出现）'); await sleep(2500); await request(proxy,`/navigate?target=${target}&url=${encodeURIComponent('https://one.alimama.com/index.html#!/report/download-list')}`); await sleep(2000); const polled=await pollNewProductTask({before,read:()=>readProductTasks(proxy,target),timeoutMs:30000,intervalMs:2000,delay:sleep}); const after=polled.after; if(polled.timedOut)console.log(`[提交] 轮询 30s（读了 ${polled.reads} 次）仍没看到新任务，按「平台未生成」继续判`); let task; try{ task=uniqueNewProductTask(before,after); console.log(`[提交] ${task}`); }catch(error){ const reused=reuseCandidateTask({after,submittedOn}); if(!reused)throw error; task=reused; console.log(`[提交] 平台未生成新任务（同参数已交过），复用同日在册任务 ${task}；数据日期由导入器按 --date 校验`); } return task; }
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
    // 2026-10-29 补：ESC 是关模态框**最安全**的一招（不用点页面上任何东西，没有点错的可能），
    // 而本脚本此前**没注入它** —— 日志里那句「没有注入 pressEscape ⇒ 跳过 ESC 这一步」就是证据。
    // 日报链的三个采集器一直都注入着，只有商品链这两个漏了（同一机制的实现缺口）。
    pressEscape: async (_args,id)=>pressKey(proxy,id,'Escape'),
    delay: sleep,
    log: (line)=>console.log(line),
  });
  return dismisser({},target,selector);
}
// 发一个真实按键（走代理的 `/key` 白名单路由）。页面里 dispatchEvent 造的伪键盘事件
// 这一族页面不认 —— 与「el.click() 无效、真实鼠标点才落盘」是同一件事。
async function pressKey(proxy,target,key){return request(proxy,`/key?target=${encodeURIComponent(target)}`,{method:'POST',body:JSON.stringify({key})});}
/**
 * 对**一条**任务做一次完整取件：等就绪 → 勾选 → 展开操作行 → 点下载 → 等文件落盘。
 * 失败就抛，由调用方决定换下一条候选还是补提交 —— 这里不再自己重试同一条。
 *
 * 为什么不再「同一条重试 3 次」（2026-10-18）：2026-10-18 三家店的实测是，同一条任务
 * 连试 3 次的结果一模一样（同一条坏行），3 次重试只是在原地打转。日报推广链的口径是
 * 「通道坏了换通道」，所以重试的对象从「同一条」改成「候选集里的下一条」。
 */
async function fetchOneTask(proxy,target,task,downloads,meta={}) {
  const before = listDownloads(downloads,PRODUCT_ZIP_RE).map(x=>x.name);
  const ready = await waitForTaskReady(proxy,target,task);
  const row = await evalOn(proxy,target,`(()=>{const n=[...document.querySelectorAll('*')].find(x=>x.children.length===0&&(x.innerText||'').trim()===${JSON.stringify(task)});const tr=n&&n.closest('tr');const box=tr&&tr.querySelector('input[type=checkbox]');if(!box)return {ok:false,reason:'checkbox-missing'};const r=box.getBoundingClientRect();return {ok:true,checked:box.checked,center:[Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)]}})()`);
  if(!row?.ok)throw Error(`商品报表任务行没有复选框: ${ready}`);
  if(!row.checked){
    const scan=await evalOn(proxy,target,overlayScanExpression());
    if(scan?.blocked){const decision=nextDownloadAction({overlayBlocked:true,taskReady:true});await dismissOverlay(proxy,target,null);throw Error(`下载任务页被平台遮挡层拦住（${decision.action}），已尝试安全关闭并刷新重试`);}
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
  if(!activated||!actionVisible){const decision=nextDownloadAction({taskReady:true,actionVisible:false});throw Error(`真实点击后目标任务操作行仍未显形（${decision.action}）`);}
  await sleep(800);
  const probe=await evalOn(proxy,target,`(()=>{const n=[...document.querySelectorAll('*')].find(x=>x.children.length===0&&(x.innerText||'').trim()===${JSON.stringify(task)});const tr=n&&n.closest('tr');const a=tr&&tr.nextElementSibling;if(!a)return {ok:false,reason:'no-action-row'};const cands=[...a.querySelectorAll('*')].filter(x=>(x.textContent||'').includes('下载')).slice(0,20).map(x=>{const b=x.closest('button')||x.closest('a')||x;const r=b.getBoundingClientRect();return {text:(b.textContent||'').trim().slice(0,40),rect:{x:r.x,y:r.y,w:r.width,h:r.height}};});return {ok:true,cands,vw:innerWidth,vh:innerHeight};})()`);
  // 2026-10-21：判据搬到 node 侧（download-entry-core.mjs），页面侧只负责「取候选 + 报视口」。
  // 旧内联版要求「叶子节点 + 文字恰好等于下载 + 宽度>0」，平台层级一变就假红
  // （10-20 里可林天猫：现场报表已渲染 35 行、无遮挡层，却报「下载入口不可见」）。
  if(!probe||!probe.ok){throw Error(`商品报表任务行下方没有操作行（task=${task}）`);}
  const ranking=rankDownloadCandidates(probe.cands??[],{viewport:{width:probe.vw??0,height:probe.vh??0}});
  // 候选按优先级排好，逐个交给浏览器 elementFromPoint 复核，命中即点。
  // 不在这里做几何推算的命中判断 —— 那等于用一个模型代替浏览器说自己点到了。
  let point=null;
  if(ranking.ok){for(const cand of ranking.candidates){const hit=await evalOn(proxy,target,`(()=>{const h=document.elementFromPoint(${cand.point[0]},${cand.point[1]});return {hit:!!h,tag:h?h.tagName:null}})()`);if(hit?.hit){point={point:cand.point,hit:true,targetHit:true};break;}}}
  if(!point)throw Error(`商品报表下载入口不可用：${ranking.ok?`${ranking.candidates.length} 个候选都没命中（被别的元素盖住）`:describeDownloadFailure(ranking)}`);
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
    if(match){const full=path.join(downloads,match);console.log(`[下载] ${full} (${statSync(full).size} bytes)`); console.log(JSON.stringify({shop:meta.shop,date:meta.date,file:full,bytes:statSync(full).size,task})); return full;}
  }
  throw Error(`商品报表下载超时: ${task}`);
}
/**
 * 取件：按**候选集**逐条试，任一条落盘即返回。
 *
 * 候选怎么来的见 `pickFetchCandidates`（日期范围＝目标日；读不到就退回「提交当天」）。
 * 每试一条之前都重载一次下载列表页：上一条失败时页面往往已经被点坏
 * （2026-10-18 盖文淘宝第 2 次重试就是「勾上了但操作行不展开」），
 * 在坏页面上试下一条等于让下一条替上一条背锅。
 */
async function fetchCandidates(proxy,{ submittedTask, submittedOn, downloads, meta }) {
  let target = await navigateDownloadList(proxy, await findPage(proxy));
  const rows = await readProductTaskRows(proxy,target);
  const picked = pickFetchCandidates({ rows, date: meta.date, submittedOn, submittedTask });
  console.log(`[候选] 判据=${picked.basis}｜${picked.candidates.length} 条：${picked.candidates.join('、')||'(无)'}`
    + (picked.ignoredCount ? `｜按判据排除 ${picked.ignoredCount} 条` : ''));
  const tried = [];
  for (const task of picked.candidates) {
    // 同一条任务最多试 2 次，但**只有**失败原因是「遮挡层」时才重试同一条（2026-10-18 实测）：
    // 遮挡层这条路在抛之前已经把它关掉了（日志里「全屏层剩 0 个」），重试同一条是**有效**的；
    // 而「操作行没显形 / 下载超时」这两类重试同一条的结果逐次相同（10-18 三家店各试 3 次全一样），
    // 所以那种情况直接换下一条候选，不在坏行上打转。
    for (let pass = 1; pass <= 2; pass += 1) {
      try {
        const file = await fetchOneTask(proxy,target,task,downloads,meta);
        return { file, tried, candidates: picked.candidates, basis: picked.basis };
      } catch (error) {
        tried.push({ task, pass, error: error.message });
        console.warn(`[候选] ${task} 第 ${pass} 次取不到：${error.message}`);
        target = await navigateDownloadList(proxy,target);
        if (!/遮挡层/u.test(error.message)) break;
        console.log(`[候选] ${task} 是遮挡层拦下的（已关闭）⇒ 刷新后重试同一条一次`);
      }
    }
  }
  return { file: null, tried, candidates: picked.candidates, basis: picked.basis };
}
/**
 * 走到「提交一份报表任务」为止：下载列表读 before → 报表页设维度并校验 → 提交。
 * 抽出来是因为它有**两个调用方**：首轮提交，以及候选全取不到时的**补提交**。
 * 两处必须走逐字同一段逻辑 —— 抄一份的代价是「平台改版时只有一条路会被修」。
 */
async function produceTask(proxy,o) {
  let target = await navigateDownloadList(proxy, await findPage(proxy));
  const before = await readProductTasks(proxy,target);
  await request(proxy,`/navigate?target=${target}&url=${encodeURIComponent(buildProductReportUrl(o.date))}`);
  // 2026-10-22 修：原来是「固定睡眠 6.5 秒」之后就 `setPlanDimension`，而它在找不到
  // `.mx-trigger` 时**立刻 throw** ⇒ 「等 6.5 秒」+「判据只跑一次」= 报表骨架渲染慢一点就整家判死。
  // 现场见 report-ready-core.mjs 文件头（网林天猫：URL 日期对，但页面只剩 257 个 DIV、0 个「维度」）。
  // 现在改成就绪轮询：等**要点的那个元素**出现为止，超时把「看到了什么」写进报错。
  const ready = await pollReportReady({ read:()=>readReportSkeleton(proxy,target), timeoutMs:25000, intervalMs:1500, delay:sleep });
  if (ready.step !== 'ready') {
    throw Error(`${describeReportReadyFailure(ready)}（${o.date}；最后网址 ${ready.state?.href ? '在报表页' : '不在报表页'}）`);
  }
  target=await findPage(proxy);
  await setPlanDimension(proxy,target);
  const checked=await state(proxy,target,o.date);
  validateProductReportState(checked,o.date);
  console.log(`[校验] 商品报表 / ${o.date} / 商品+计划 ✓`);
  if(o.locateOnly){console.log('[排练] 未提交下载');return { locateOnly: true };}
  // 「提交当天」（+08）用于同日重跑的自愈判断：任务名里的时间戳是**提交时刻**，不是数据日。
  const submittedOn=new Date(Date.now()+8*3600*1000).toISOString().slice(0,10);
  const task=await submit(proxy,target,before,submittedOn);
  return { locateOnly: false, task, submittedOn };
}
async function run(o){const inst=shopInstance(o.shop);const proxy=`http://127.0.0.1:${inst.proxyPort}`;let target=await findPage(proxy);await identity(proxy,target,o.shop);
  if(o.task){target=await navigateDownloadList(proxy,target);await fetchOneTask(proxy,target,o.task,o.downloads,{shop:o.shop,date:o.date});return;}
  const first=await produceTask(proxy,o);
  if(first.locateOnly)return;
  const meta={shop:o.shop,date:o.date};
  let got=await fetchCandidates(proxy,{ submittedTask:first.task, submittedOn:first.submittedOn, downloads:o.downloads, meta });
  if(got.file)return;
  const exhausted=got.tried.map((x)=>`${x.task}: ${x.error}`).join('；')||'（候选为空）';
  if(!o.resubmit){throw Error(`这一目标日的 ${got.candidates.length} 条候选都取不到，且 --no-resubmit 关掉了补提交：${exhausted}`);}
  // ---------------------------------------------------------------------------
  // 换通道（2026-10-18 从日报推广链搬来）：候选全部取不到 ⇒ 补提交一条同目标日的任务，
  // 再按新列表逐条试一次。
  //
  // 第一性原理（业务方 2026-10-05 实测口径）：**任务只是通道**，业务要的是「目标日那份数据」。
  // 平台存在「最新那条点了不落盘、紧挨着另一条能下、两条数据等价」的形态，所以通道坏了换一条，
  // 而不是和某一条通道绑死 —— 之前商品链就是绑死在那一条上，一条坏整家判死。
  //
  // 上限：**一次运行最多补提交 1 次**。判据是「首轮候选全部失败」这个事实本身 ——
  // 补提交后无论成不成都不再补第二次；重跑整条命令才会再补一次（那是人主动发起的，不是链自己循环）。
  // 关掉用 `--no-resubmit`（人工熔断）。
  // ---------------------------------------------------------------------------
  console.log(`[换通道] ${got.candidates.length} 条候选全取不到（${exhausted}）⇒ 补提交一条同目标日任务，再逐条试一次`);
  const second=await produceTask(proxy,o);
  if(second.locateOnly)return;
  got=await fetchCandidates(proxy,{ submittedTask:second.task, submittedOn:second.submittedOn, downloads:o.downloads, meta });
  if(got.file)return;
  // 安全阀：候选全试完还是没落盘 ⇒ fail-closed。**绝不拿别天的数据顶替**。
  throw Error(`补提交后 ${got.candidates.length} 条候选仍全部取不到：`
    + `${got.tried.map((x)=>`${x.task}: ${x.error}`).join('；')||'（候选为空）'}`
    + ' ⇒ fail-closed：绝不拿别天的数据顶替（这一天的推广数据这次没拿到，去平台侧看）');
}
// CLI 入口（2026-10-13 加失败现场，㊶）：**先采现场、再抛** —— 抛出去之后页面可能被导航走，
// 那一刻的 DOM/截图就没了（与日报链编排层同一条纪律）。`--log-dir` 不给 ⇒ 不采
// （商品链那一轮由编排层用 `--log-dir` 指到本轮证据目录，见 run-product-data-job.mjs）。
async function main(){
  const o=args(process.argv.slice(2));
  const inst=shopInstance(o.shop);
  try{ await run(o); }
  catch(e){
    await captureCollectorFailureScene({
      proxy:`http://127.0.0.1:${inst.proxyPort}`, logDir:o.logDir, stage:'product-report', pageHint:'alimama',
      error:e.message, shopKey:o.shop,
    });
    throw e;
  }
}
main().catch(e=>{console.error(`采集失败：${e.message}`);process.exitCode=1});
