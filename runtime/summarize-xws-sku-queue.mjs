#!/usr/bin/env node
// 竞品 SKU 采集队列（只读，不写任何东西）。
//
// 两种口径 —— 它们回答的问题不同，别混用：
//
//   默认（无参数）= 主表最新状态口径
//     从竞品主表取「有效 + A/B + 有商品链接」的行，按「所属竞品」反查已采过的，
//     差值就是待采队列。这是采集入口的日常用法。
//
//   --weekly（或 --table-id <周表id>）= 周表当期口径
//     从指定（默认最新一期）竞品周表取当期的 A/B 行，看 SKU明细 里有没有它们的尺寸数据。
//     为什么需要它：主表是**最新状态**、周表是**当期快照**。一个商品这周是 B、下周降成 C
//     之后，主表口径就不含它了 —— 而周表那一期的 A/B 仍然需要尺寸。
//     2026-09-21 实测就撞在这上面：主表口径报 pending 0（看起来没有待采），
//     而按周表当期口径，09-06 期有 1 个 A-爆款竞品从没采过 SKU（商品 678598686014）。
//     判据复用 fill-weekly-attribute-labels-core.mjs 的 summarizeAbReadiness（有测试守着），
//     所以这一处不会再各写一份。
//
// 用法：
//   node runtime/summarize-xws-sku-queue.mjs
//   node runtime/summarize-xws-sku-queue.mjs --weekly
//   node runtime/summarize-xws-sku-queue.mjs --table-id tbllWI45sK0DfHpr
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
import { activeProfileName, baseUrl, competitorBaseToken, envFilePath, tableId } from './feishu-targets.mjs';
import { extractProductId, summarizeAbReadiness } from './fill-weekly-attribute-labels-core.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const WEEKLY_NAME = /^竞品周_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/u;
const PROFILE = activeProfileName();
const TARGET={appToken:competitorBaseToken(PROFILE),mainTableId:tableId('competitorMain', PROFILE),skuTableId:tableId('skuDetail', PROFILE)};
const ENV=envFilePath(PROFILE);
function env(text){const out={};for(const raw of text.split(/\r?\n/u)){const line=raw.trim();if(!line||line.startsWith('#'))continue;const i=line.indexOf('=');if(i<1)continue;let v=line.slice(i+1).trim();if((v.startsWith('\"')&&v.endsWith('\"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);out[line.slice(0,i).trim()]=v;}return out;}
function text(v){if(v==null)return '';if(Array.isArray(v))return v.map(text).join('').trim();if(typeof v==='object')return String(v.text??v.name??v.value??'').trim();return String(v).trim();}
function ids(v){const out=new Set();const visit=x=>{if(x==null)return;if(Array.isArray(x))return x.forEach(visit);if(typeof x==='string'){if(/^rec[A-Za-z0-9]+$/u.test(x))out.add(x);return;}if(typeof x==='object'){for(const k of ['record_id','recordId','record_ids','recordIds','value'])visit(x[k]);}};visit(v);return [...out];}
function itemId(url){const m=String(url).match(/(?:id=|item\/|\/item\/)(\d{8,})/u);return m?.[1]??null;}

const ARGV = process.argv.slice(2);
function argValue(name) {
  const index = ARGV.indexOf(name);
  if (index < 0) return '';
  const value = ARGV[index + 1];
  if (!value || value.startsWith('--')) throw Error(`${name} requires a value`);
  return value;
}
const WEEKLY_MODE = ARGV.includes('--weekly') || ARGV.includes('--table-id');

// 周表当期口径 —— 读法与判据都走既有的 core / 裸 OpenAPI，不复用 client（它没有列表的封装）。
async function mainWeekly(){
  if(!existsSync(ENV))throw Error('Feishu environment file unavailable');
  const credentials=env(await readFile(ENV,'utf8'));
  if(!credentials.FEISHU_APP_ID||!credentials.FEISHU_APP_SECRET)throw Error('Feishu credentials unavailable');
  const auth=await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_id:credentials.FEISHU_APP_ID,app_secret:credentials.FEISHU_APP_SECRET})}).then(r=>r.json());
  if(auth.code!==0)throw Error(`auth failed: ${auth.code} ${auth.msg}`);
  const headers={Authorization:`Bearer ${auth.tenant_access_token}`};
  const api=async path=>{const res=await fetch(`${API_ROOT}${path}`,{headers}).then(r=>r.json());if(res.code!==0)throw Error(`${path} -> ${res.code} ${res.msg}`);return res.data;};
  const listAll=async id=>{const items=[];let pageToken;do{const q=new URLSearchParams({page_size:'500'});if(pageToken)q.set('page_token',pageToken);const data=await api(`/bitable/v1/apps/${TARGET.appToken}/tables/${id}/records?${q}`);items.push(...(data.items??[]));pageToken=data.has_more?data.page_token:undefined;}while(pageToken);return items;};

  const tables=(await api(`/bitable/v1/apps/${TARGET.appToken}/tables?page_size=100`)).items??[];
  const explicit=argValue('--table-id');
  let weekly;
  if(explicit){
    weekly=tables.find(t=>t.table_id===explicit);
    if(!weekly)throw Error(`table not found in the active base: ${explicit}`);
  }else{
    const matched=tables.filter(t=>WEEKLY_NAME.test(t.name)).sort((a,b)=>a.name.localeCompare(b.name));
    if(!matched.length)throw Error('no 竞品周_* table found in the active base');
    weekly=matched[matched.length-1];
  }

  const [weeklyRecords,skuRecords]=await Promise.all([listAll(weekly.table_id),listAll(TARGET.skuTableId)]);
  const productsWithSize=new Set();
  for(const record of skuRecords){
    const f=record.fields??{};
    const productId=text(f['商品ID'])||extractProductId(text(f['商品链接']));
    if(!productId)continue;
    const hasSize=[text(f['SKU尺寸']),text(f['尺寸汇总'])].some(v=>v&&v!=='无注明');
    if(hasSize)productsWithSize.add(productId);
  }
  const rows=weeklyRecords.map(record=>({
    recordId:record.record_id,
    productId:extractProductId(text(record.fields?.['商品链接'])),
    klass:text(record.fields?.['竞品分类']),
    currentSize:text(record.fields?.['尺寸']),
    title:text(record.fields?.['商品标题']),
  }));
  const readiness=summarizeAbReadiness(rows,id=>productsWithSize.has(id));
  const pending=readiness.missing.map(item=>({...item,currentSize:rows.find(r=>r.recordId===item.recordId)?.currentSize??''}));
  console.log(JSON.stringify({
    mode:'READ_ONLY',
    scope:'weekly',
    table:{name:weekly.name,tableId:weekly.table_id,rows:weeklyRecords.length},
    skuDetail:{tableId:TARGET.skuTableId,records:skuRecords.length,productsWithSize:productsWithSize.size},
    counts:{ab:readiness.abCount,ready:readiness.readyCount,pending:readiness.missingCount},
    pending,
    note:'队列按周表当期 A/B 算（不是主表最新状态）。采集用技能 xws-sku-collection。',
  },null,2));
}

// 主表最新状态口径（默认，行为与 2026-09-21 之前逐字相同）。
async function main(){if(WEEKLY_MODE){await mainWeekly();return;}if(!existsSync(ENV))throw Error('Feishu environment file unavailable');const e=env(await readFile(ENV,'utf8'));if(!e.FEISHU_APP_ID||!e.FEISHU_APP_SECRET)throw Error('Feishu credentials unavailable');const c=new CompetitorV2FeishuClient({appId:e.FEISHU_APP_ID,appSecret:e.FEISHU_APP_SECRET,appToken:TARGET.appToken});await c.authenticate();const [main,sku]=await Promise.all([c.listRecords(TARGET.mainTableId),c.listRecords(TARGET.skuTableId)]);const linked=new Map();for(const r of sku)for(const id of ids(r.fields?.所属竞品))linked.set(id,(linked.get(id)??0)+1);const rows=main.map(r=>{const f=r.fields??{};const classification=text(f.竞品分类);const validity=text(f.是否有效竞品);const url=text(f.商品链接||f.商品链接URL||f.链接);const count=linked.get(r.recordId)??0;return {recordId:r.recordId,classification,validity,hasProductLink:Boolean(url),productId:itemId(url),skuCount:count,title:text(f.商品标题)};});const eligible=rows.filter(r=>r.validity==='是'&&/^[AB]-/u.test(r.classification)&&r.hasProductLink);const pending=eligible.filter(r=>r.skuCount===0);const unsupported=eligible.filter(r=>!r.productId);console.log(JSON.stringify({mode:'READ_ONLY',counts:{main:main.length,sku:sku.length,eligible:eligible.length,pending:pending.length,alreadyCollected:eligible.length-pending.length,unsupportedLink:unsupported.length},classification:{A:eligible.filter(r=>r.classification.startsWith('A-')).length,B:eligible.filter(r=>r.classification.startsWith('B-')).length},pending:pending.map(({title,...r})=>({...r,title:title.slice(0,120)})),unsupported:unsupported.map(({title,...r})=>({...r,title:title.slice(0,120)}))},null,2));}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
