#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SHOP_BROWSERS, shopInstance } from '../../../runtime/browser-ports.mjs';
import { SHOP_IDENTITIES } from '../../sycm-alimama-daily-report/scripts/shop-identities.mjs';
// 轮询的三态决策是纯函数、有离线判据（`planEntryPollStep`）—— 它钉的正是原版那个病根：
// 「父菜单在、子入口不在」时**每一轮都要重新点父菜单**，而不是只在进循环前点一次。
import { planEntryPollStep, pollInquiryLink, isInquiryPage } from './inquiry-core.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function parse(argv) { const o={}; for(let i=0;i<argv.length;i+=1){if(argv[i]==='--proxy')o.proxy=argv[++i];else if(argv[i]==='--shop')o.shop=argv[++i];else if(argv[i]==='--date')o.date=argv[++i];else if(argv[i]==='--out')o.out=argv[++i];else throw new Error(`unknown argument ${argv[i]}`);} if(!o.proxy||!o.shop||!o.date||!o.out)throw new Error('--proxy --shop --date --out are required'); return o; }
async function req(url, init) { const r=await fetch(url,init); const t=await r.text(); if(!r.ok)throw new Error(`${r.status} ${t.slice(0,200)}`); return t; }
async function evalOn(proxy,target,expression){const p=JSON.parse(await req(`${proxy}/eval?target=${encodeURIComponent(target)}`,{method:'POST',body:expression})); return JSON.parse(p.value);}
const o=parse(process.argv.slice(2)); const registered=shopInstance(o.shop); if(o.proxy!==`http://127.0.0.1:${registered.proxyPort}`)throw new Error(`代理与店铺登记不一致：${o.shop}`);
const targets=JSON.parse(await req(`${o.proxy}/targets`)); let page=targets.find((t)=>t.type==='page'&&String(t.url).includes('sycm.taobao.com/qos/service/frame/shop/performance')); if(!page){const fallback=targets.find((t)=>t.type==='page'&&String(t.url).includes('sycm.taobao.com')); if(fallback){await req(`${o.proxy}/navigate?target=${encodeURIComponent(fallback.targetId)}&url=${encodeURIComponent('https://sycm.taobao.com/qos/service/frame/shop/performance/new#/shop')}`); await delay(2500); page=(JSON.parse(await req(`${o.proxy}/targets`))).find((t)=>t.type==='page'&&String(t.url).includes('sycm.taobao.com/qos/service/frame/shop/performance'));}} if(!page)throw new Error('找不到生意参谋工作页');

// ---------------------------------------------------------------------------
// 「商品分析 → 商品咨询分析」入口的查找（2026-10-09 重写；原版是死等 500ms + 只点一次父菜单）
// ---------------------------------------------------------------------------
// 这两级入口是 SPA **渲染出来的**，页面刚导航完时两个都读不到。原版的写法是：
//   进轮询前**只点一次**「商品分析」，之后 30s 的循环里**只反复找「商品咨询分析」、从不重点父菜单** ——
//   于是那一下若点空（元素还没渲染出来 ⇒ `find` 返回 undefined ⇒ 一个 click 都没发出去），
//   这一轮就**必然轮询到超时**，整条支路没有任何自愈路径。
//
// 2026-10-09 网林天猫真机复现（同批另 4 家都成；该店在 10-05/10-06/10-07 三轮也都成 ⇒ 间歇、非永久）。
// 事后只读复读（同一页签、全程未点任何东西）：
//   · 页面 `readyState=interactive`、`bodyLen=32` 时，「商品分析」精确命中 **0** 个；
//   · 等它 `complete`（约 8s）后，「商品分析」命中 1 个、「商品咨询分析」命中 **0** 个；
//   · 点一下「商品分析」后，同一页签上立刻出现「商品咨询分析 / 商品推荐分析 / 商品销售分析」。
// ⇒ 入口从未消失，缺的是「等它渲染好」+「允许重试」。
//
// 现在：每一轮**先只读读一次**，读到子入口即成功；否则只要父菜单在就**重**点一次。
// 幂等 —— 点空一次还有下一轮。轮询窗口仍是 30s（上层链给这一步的预算是 60s 下载 deadline 之内）。
//
// 失败时**留现场**：页签清单 + 读数 + 截图写进 `--out` 旁（`.failure.json` / `.failure.png`），
// 上层链的证据目录因此自动带上它。以前这条支路「失败只留一句符号」，判因只能靠人肉复现。
const INQUIRY_PARENT = '商品分析';
const INQUIRY_ENTRY = '商品咨询分析';
// 页面侧没法 import `hasInquiryPageMarker`（它在 node 里），所以这里**展开同一份词表**。
// 词表的唯一来源是 `inquiry-core.mjs` 的 `INQUIRY_PAGE_MARKERS`；`inquiry-core.test.mjs`
// 有一条判据逐字比对这两处，改一处忘另一处会立刻变红。
const PAGE_MARKERS = ['统计时间', '询单人数'];
// 词表要拼进两段不同的页面表达式，而它们的正文变量名不一样（`READ_ENTRY_STATE` 用 `t`、
// `READ_PAGE_STATE` 用 `text`）⇒ 这里必须按变量名生成，不能写死一个。
// 2026-10-23：原来写死 `t.`，在 `READ_PAGE_STATE` 里就变成引用不存在的 `t`
// ⇒ 只要正文里搜不到「商品咨询分析」（正是这条判据要救的那一现场）就抛 `ReferenceError: t is not defined`。
const markersExprOf = (varName) => PAGE_MARKERS.map((marker) => `${varName}.includes(${JSON.stringify(marker)})`).join('||');
const PAGE_MARKER_EXPR = markersExprOf('t');
const PAGE_MARKER_EXPR_TEXT = markersExprOf('text');
const READ_ENTRY_STATE = `(()=>{const t=document.body.innerText||'';const uniq=[...new Set([...document.querySelectorAll('a,span,div')].map(x=>(x.innerText||x.textContent||'').trim()))].filter(Boolean);return JSON.stringify({shop:(t.match(/(?:生意参谋\\n)([^\\n]+)/)||[])[1]||'',hasParent:t.includes(${JSON.stringify(INQUIRY_PARENT)}),hasInquiry:t.includes(${JSON.stringify(INQUIRY_ENTRY)}),exactInquiry:uniq.filter((s)=>s===${JSON.stringify(INQUIRY_ENTRY)}).length,pageMarker:(${PAGE_MARKER_EXPR}),statDate:(t.match(/统计时间\\s*(\\d{4}-\\d{2}-\\d{2})/)||[])[1]||'',url:location.href,readyState:document.readyState})})()`;
const clickByText = (needle) => `(()=>{const e=[...document.querySelectorAll('a,span,div')].find(x=>(x.innerText||x.textContent||'').trim()===${JSON.stringify(needle)});if(!e)return false;e.click();return true})()`;

async function writeFailureSnapshot({ proxy, note, reading }) {
  const pages = await (async () => { try { return (JSON.parse(await req(`${proxy}/targets`))).filter((t) => t.type === 'page').map((t) => ({ targetId: t.targetId, url: String(t.url) })); } catch { return []; } })();
  const snapshot = { at: new Date().toISOString(), shop: o.shop, date: o.date, note, expectation: { parent: INQUIRY_PARENT, entry: INQUIRY_ENTRY }, reading, pages };
  const target = pages.find((p) => p.url.includes('sycm.taobao.com'))?.targetId;
  if (target) {
    // 截图**单独走裸 fetch**：`req` 在非 2xx 上会抛，而这个端点在页签闲置后首条常返 500 —— 不该让整份快照跟着丢。
    try { const response = await fetch(`${proxy}/screenshot?target=${encodeURIComponent(target)}`); if (response.ok) { mkdirSync(path.dirname(o.out), { recursive: true }); writeFileSync(`${o.out}.failure.png`, Buffer.from(await response.arrayBuffer())); snapshot.screenshot = `${o.out}.failure.png`; } else snapshot.screenshotError = String(response.status); } catch (error) { snapshot.screenshotError = String(error?.message ?? error); }
  }
  try { mkdirSync(path.dirname(o.out), { recursive: true }); writeFileSync(`${o.out}.failure.json`, `${JSON.stringify(snapshot, null, 2)}\n`); } catch {}
  return snapshot;
}

// 先给页面一点渲染时间（原版在这里死等 500ms —— 实测不够），再进「读 → 必要时重点父菜单」的循环。
//
// 2026-10-22 修：进入判据从「正文里有『商品咨询分析』这几个字」改成 `isInquiryPage`（结构特征，
// 见 `inquiry-core.mjs` 的长注释）。原来的写法在页面**已经进了询单页**时也会判负
// （10-22 里可林天猫现场：三个 Tab 都在、数据已渲染，整页正文却搜不到那两个词），
// 于是轮询空转 30 秒后报「找不到入口」——把人指到「入口没渲染」上。
// 「要不要点父菜单」仍然由 `planEntryPollStep` 决定，它看的是父菜单/子入口文案，
// 与「到没到页」是两件事，不该共用一条判据。
await delay(1500);
let entryState = await evalOn(o.proxy, page.targetId, READ_ENTRY_STATE);
if (!isInquiryPage(entryState)) {
  const inquiryDeadline = Date.now() + 30000; let entered = false; let sawPage = false;
  while (!entered && Date.now() < inquiryDeadline) {
    const p = (JSON.parse(await req(`${o.proxy}/targets`))).find((t) => t.type === 'page' && String(t.url).includes('sycm.taobao.com'));
    if (!p) { await delay(1000); continue; }
    sawPage = true; page = p;
    entryState = await evalOn(o.proxy, p.targetId, READ_ENTRY_STATE);
    // 已经在询单页 ⇒ 立刻收工；否则再决定要不要点父菜单。
    if (isInquiryPage(entryState)) { entered = true; break; }
    const step = planEntryPollStep(entryState);
    // 每一轮都重试父菜单：点空一次不该让这一轮注定失败（原版的病根就在这里）。
    if (step === 'click-parent') await evalOn(o.proxy, p.targetId, clickByText(INQUIRY_PARENT));
    await delay(1000);
  }
  if (!entered) {
    await writeFailureSnapshot({ proxy: o.proxy, note: sawPage ? '轮询 30s 内未进入商品咨询分析页（结构特征与 Tab 文案都没读到）' : '商品分析点击后找不到生意参谋页面', reading: entryState });
    throw new Error(sawPage ? '找不到商品咨询分析入口（轮询 30s 仍未出现）' : '商品分析点击后找不到生意参谋页面');
  }
  await delay(2000);
}
page=(JSON.parse(await req(`${o.proxy}/targets`))).find((t)=>t.type==='page'&&String(t.url).includes('sycm.taobao.com')); if(!page)throw new Error('询单报表页不可用');
// ⚠️ 这行**必须是反引号模板**：`${PAGE_MARKER_EXPR}` 要在 node 侧就展开成词表再发给页面。
// 2026-10-23 真机：写成双引号字符串 ⇒ 不插值 ⇒ 页面收到字面 `${PAGE_MARKER_EXPR}`
// ⇒ `$` 当标识符、紧跟 `{` ⇒ `SyntaxError: Unexpected token '{'` ⇒ 代理 400 ⇒ 询单 8/8 全灭。
// 只读复现：取出该字面量后 `new Function('return ' + expr)` 报的就是同一句。
const READ_PAGE_STATE=`(()=>{const text=document.body.innerText||'';const shop=(text.match(/(?:生意参谋\\n)([^\\n]+)/)||[])[1]||'';const day=[...document.querySelectorAll('button,a,span')].find(e=>(e.innerText||e.textContent||'').trim()==='日');const link=[...document.querySelectorAll('a.lowcode-service-download-btn')][0];let f=link&&link[Object.keys(link).find(k=>k.startsWith('__reactInternal'))];while(f&&!((f.memoizedProps||{}).link))f=f.return;return JSON.stringify({shop,hasInquiry:(text.includes('商品咨询分析')||(${PAGE_MARKER_EXPR_TEXT})),date:(text.match(/统计时间\\s*(\\d{4}-\\d{2}-\\d{2})/)||[])[1]||'',daySelected:!!day,link:f?.memoizedProps?.link||''})})()`;
// ⚠️ 这里的 `hasInquiry` 与上面 `READ_ENTRY_STATE` 共用同一份结构词表（`PAGE_MARKER_EXPR`）：
// 两处都拿「正文里有『商品咨询分析』」当「在询单页」，2026-10-22 现场证明那条文案判据会整页读不到。
// 只修入口那处、留着这里 ⇒ 入口放行后立刻在下一步以「页面状态不满足：{hasInquiry:false}」再红一次，
// 看起来像换了个新毛病，其实是同一个病根的第二个出口。
// 2026-10-21：原来这里只读一次就判死。link 是 React fiber 的 memoizedProps.link（导出接口 URL），
// 要等报表数据请求回来才被填 ——「入口 DOM 出现」≠「数据请求完成」，只读一次必然偶发假红
// （2026-10-20 网林家居当场读到 link=""，19 分钟后同样的店同样命令一次成功）。
const polled=await pollInquiryLink({read:async()=>{const p2=(JSON.parse(await req(`${o.proxy}/targets`))).find((t)=>t.type==='page'&&String(t.url).includes('sycm.taobao.com'));if(!p2)return {};page=p2;return await evalOn(o.proxy,p2.targetId,READ_PAGE_STATE);},expectedDate:o.date});
const state=polled.state;
// 轮询读数进现场：把「根本没读」和「读了十几次还是空」区分开（原版这两种都是同一句报错）。
if(polled.step!=='done')state.linkReads=polled.reads;
const expectedShop=SHOP_IDENTITIES.find((x)=>x.key===o.shop)?.sycmHeader; // 轮询可能一次都没读到页面（页签消失）⇒ state 是 {}，
// 直接读 state.shop.includes 会抛 TypeError，把「页签没了」伪装成脚本崩溃。这里用 String() 兜住，报错仍是「店铺身份不符：」。
const identityOk=expectedShop&&String(state.shop??'').includes(expectedShop); if(!identityOk)throw new Error(`店铺身份不符：${state.shop??'（轮询 '+polled.reads+' 次都没读到页面）'}`); if(!state.hasInquiry||state.date!==o.date||!state.link)throw new Error(`页面状态不满足（轮询 ${polled.reads} 次）：${JSON.stringify(state)}`);
const result=await evalOn(o.proxy,page.targetId,`fetch(${JSON.stringify(state.link)},{credentials:'include'}).then(async r=>{const b=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<b.length;i+=0x8000)s+=String.fromCharCode(...b.subarray(i,i+0x8000));return JSON.stringify({status:r.status,type:r.headers.get('content-type'),b64:btoa(s)})})`); if(result.status!==200)throw new Error(`导出接口返回 ${result.status}`); mkdirSync(path.dirname(o.out),{recursive:true}); writeFileSync(o.out,Buffer.from(result.b64,'base64')); console.log(JSON.stringify({shop:o.shop,date:o.date,out:path.resolve(o.out),bytes:Buffer.byteLength(result.b64,'base64'),endpoint:state.link},null,2));
