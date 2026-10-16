#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadFeishuCredentials, productDataTargetsForShop } from '../../../runtime/feishu-targets.mjs';
import { FeishuClient } from '../../xws-to-feishu-base/scripts/feishu-client.mjs';
import { planPromotionImport, validatePromotionReport } from './promotion-core.mjs';

// `--date` 是**必填**（2026-10-16 加）：商品数据的飞书 base 按月 × 按部门换（见
// `runtime/feishu-targets.mjs` 的 PRODUCT_DATA_MONTH_BASES），而这个脚本只拿得到 `--shop`
// （哪家店）。没有数据日期就无法解析出该写哪张 base —— 缺参就抛错，而不是回落成
// 「上个月那张」（回落会「跑成功但写进运营不看的表」。10 月整月推广缺失就是这么来的：
// 改造前这里读 profile 单对象，永远指向 9 月已关账的 base，于是 10 月 base 的
// 「商品推广数据底单」从建出来就是空表，看板引用它全是 0）。
function parse(argv){const o={files:[],shops:[],apply:false,evidence:null,date:null};for(let i=0;i<argv.length;i++){if(argv[i]==='--file')o.files.push(argv[++i]);else if(argv[i]==='--shop')o.shops.push(argv[++i]);else if(argv[i]==='--apply')o.apply=true;else if(argv[i]==='--evidence')o.evidence=argv[++i];else if(argv[i]==='--date')o.date=argv[++i];else throw Error(`unknown argument ${argv[i]}`)}if(o.files.length!==o.shops.length||!o.files.length)throw Error('每个 --file 必须对应一个 --shop');if(!/^\d{4}-\d{2}-\d{2}$/u.test(o.date??''))throw Error('missing or invalid --date (expected YYYY-MM-DD)');o.evidence??=`evidence/promotion-import-${o.date}`;return o}
function readZip(file){const r=spawnSync(process.env.PYTHON||'py',['-3','-c',`import zipfile,csv,json,sys,io\nsys.stdout.reconfigure(encoding='utf-8')\nz=sys.argv[1]\nwith zipfile.ZipFile(z) as a:\n n=[x for x in a.namelist() if x.lower().endswith('.csv')][0]\n t=a.read(n).decode('gb18030').lstrip('\\ufeff')\n rows=list(csv.reader(io.StringIO(t)))\nprint(json.dumps({'headers':rows[0],'rows':rows[1:],'csvName':n},ensure_ascii=False))`,file],{encoding:'utf8',stdio:['ignore','pipe','pipe']});if(r.status!==0)throw Error(`ZIP parse failed：${r.stderr?.trim()||r.error?.message||`exit ${r.status}`}`);return JSON.parse(r.stdout)}

const o=parse(process.argv.slice(2)); const c=loadFeishuCredentials('kcne');

// 每个 (file, shop) 先各自解析出自己的落点（base × 表）。一批店可能落在两张 base 里
// （10 月起按部门分 base）⇒ 后面所有「读既存 / 计划 / 写 / 回读」都必须**按 base 分组**做：
// 一个 FeishuClient 只认一个 base，混在一起就会把一半数据写进另一张表
// （2026-09-30 记录在案的未修缺陷，本版修掉：分组键是 baseToken，组内多店共享同一个
// client 与同一份去重集合；去重集合必须用**本 base 的**既存记录，用别组的会把
// 「这张表里还没有」误判成「已写过」）。
const sources=[]; const byBase=new Map();
for(let i=0;i<o.files.length;i++){
  const x=readZip(o.files[i]); validatePromotionReport(x.headers,x.rows);
  const shop=o.shops[i]; const target=productDataTargetsForShop(shop,o.date,'kcne');
  sources.push({file:o.files[i],shop,rows:x.rows.length,columns:x.headers.length,csvName:x.csvName,headers:x.headers,base:target.baseName,baseToken:target.baseToken,tableId:target.promotionTable,observedDates:[...new Set(x.rows.map(r=>String(r[0]??'').trim()).filter(Boolean))]});
  if(!byBase.has(target.baseToken)) byBase.set(target.baseToken,{target,items:[]});
  byBase.get(target.baseToken).items.push({shop,rows:x.rows,headers:x.headers});
}

const groups=[];
for(const {target,items} of byBase.values()){
  const client=new FeishuClient({appId:c.appId,appSecret:c.appSecret,appToken:target.baseToken,tableId:target.promotionTable});
  const targetFields=await client.listFields(); const targetNames=targetFields.map(f=>f.fieldName);
  const existing=await client.listRecords();
  // CSV schema 在淘宝/天猫之间可能不同（SKILL.md：preserve each downloaded source as-is）⇒
  // 组内再按表头签名分摊，各摊配各的既有字段映射。
  const byHeaders=new Map();
  for(const item of items){const key=item.headers.join('\u001f'); if(!byHeaders.has(key)) byHeaders.set(key,{headers:item.headers,rows:[]}); byHeaders.get(key).rows.push(...item.rows.map(values=>({values,shop:item.shop})));}
  for(const {headers,rows} of byHeaders.values()){
    const plan=planPromotionImport({rows:rows.map(r=>r.values),existing,headers,targetNames});
    groups.push({target,client,existingRows:existing.length,records:plan.records,manifest:plan.manifest.map((m,index)=>({...m,shop:rows[index]?.shop??null}))});
  }
}

mkdirSync(o.evidence,{recursive:true});
const receipt={sources,paramDate:o.date,date:[...new Set(sources.flatMap(s=>s.observedDates))],mode:o.apply?'apply':'dry-run',sourceRows:sources.reduce((sum,s)=>sum+s.rows,0),existingRows:groups.reduce((sum,g)=>sum+g.existingRows,0),plannedRows:groups.reduce((sum,g)=>sum+g.records.length,0),duplicateRows:sources.reduce((sum,s)=>sum+s.rows,0)-groups.reduce((sum,g)=>sum+g.records.length,0),bases:groups.map(g=>({base:g.target.baseName,baseToken:g.target.baseToken,tableId:g.target.promotionTable,existingRows:g.existingRows,plannedRows:g.records.length})),manifest:groups.flatMap(g=>g.manifest)};
if(o.apply){
  const ids=[];
  for(const g of groups){for(let i=0;i<g.records.length;i+=500)ids.push(...await g.client.batchCreateRecords(g.records.slice(i,i+500)));}
  receipt.recordIds=ids;
  // 写后回读按 base 各自做：一个总数会把「A 表写成了、B 表没写成」盖住。
  receipt.afterRows={};
  for(const g of groups) receipt.afterRows[g.target.baseToken]=(await g.client.listRecords()).length;
}
writeFileSync(`${o.evidence}/receipt.json`,JSON.stringify(receipt,null,2)); console.log(JSON.stringify(receipt,null,2));
