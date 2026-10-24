#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { productDataTargetsForShop, targetCredentials } from '../../../runtime/feishu-targets.mjs';
import { FeishuClient } from '../../xws-to-feishu-base/scripts/feishu-client.mjs';
import { planPromotionImport, validatePromotionReport } from './promotion-core.mjs';
import { batchCreateWithLedger, writeFailureIsCertain } from '../../../runtime/import-write-ledger.mjs';

// `--date` 是**必填**（2026-10-16 加）：商品数据的飞书 base 按月 × 按部门换（见
// `runtime/feishu-targets.mjs` 的 PRODUCT_DATA_MONTH_BASES），而这个脚本只拿得到 `--shop`
// （哪家店）。没有数据日期就无法解析出该写哪张 base —— 缺参就抛错，而不是回落成
// 「上个月那张」（回落会「跑成功但写进运营不看的表」。10 月整月推广缺失就是这么来的：
// 改造前这里读 profile 单对象，永远指向 9 月已关账的 base，于是 10 月 base 的
// 「商品推广数据底单」从建出来就是空表，看板引用它全是 0）。
function parse(argv){const o={files:[],shops:[],apply:false,evidence:null,date:null};for(let i=0;i<argv.length;i++){if(argv[i]==='--file')o.files.push(argv[++i]);else if(argv[i]==='--shop')o.shops.push(argv[++i]);else if(argv[i]==='--apply')o.apply=true;else if(argv[i]==='--evidence')o.evidence=argv[++i];else if(argv[i]==='--date')o.date=argv[++i];else throw Error(`unknown argument ${argv[i]}`)}if(o.files.length!==o.shops.length||!o.files.length)throw Error('每个 --file 必须对应一个 --shop');if(!/^\d{4}-\d{2}-\d{2}$/u.test(o.date??''))throw Error('missing or invalid --date (expected YYYY-MM-DD)');o.evidence??=`evidence/promotion-import-${o.date}`;return o}
function readZip(file){const pythonCommand=process.env.PYTHON||'py';const pythonPrefix=process.env.PYTHON?[]:['-3'];const r=spawnSync(pythonCommand,[...pythonPrefix,'-c',`import zipfile,csv,json,sys,io\nsys.stdout.reconfigure(encoding='utf-8')\nz=sys.argv[1]\nwith zipfile.ZipFile(z) as a:\n n=[x for x in a.namelist() if x.lower().endswith('.csv')][0]\n t=a.read(n).decode('gb18030').lstrip('\\ufeff')\n rows=list(csv.reader(io.StringIO(t)))\nprint(json.dumps({'headers':rows[0],'rows':rows[1:],'csvName':n},ensure_ascii=False))`,file],{encoding:'utf8',stdio:['ignore','pipe','pipe']});if(r.status!==0)throw Error(`ZIP parse failed：${r.stderr?.trim()||r.error?.message||`exit ${r.status}`}`);return JSON.parse(r.stdout)}

const o=parse(process.argv.slice(2));

// 每个 (file, shop) 先各自解析出自己的落点（base × 表）。一批店可能落在两张 base 里
// （10 月起按部门分 base）⇒ 后面所有「读既存 / 计划 / 写 / 回读」都必须**按 base 分组**做：
// 一个 FeishuClient 只认一个 base，混在一起就会把一半数据写进另一张表
// （2026-09-30 记录在案的未修缺陷，本版修掉：分组键是 baseToken，组内多店共享同一个
// client 与同一份去重集合；去重集合必须用**本 base 的**既存记录，用别组的会把
// 「这张表里还没有」误判成「已写过」）。
const sources=[]; const byBase=new Map();
for(let i=0;i<o.files.length;i++){
  const x=readZip(o.files[i]);
  // 空报表（表头 + 空行）是**合法的零数据**，不是坏文件：validate 返回 empty:true 而不是抛错。
  // 这里的 rows 必须换成 0，否则下面的 observedDates / duplicateRows 会把那一条空行算成一行数据。
  const verdict=validatePromotionReport(x.headers,x.rows,{date:o.date});
  const dataRows=verdict.empty?[]:x.rows;
  const shop=o.shops[i]; const target=productDataTargetsForShop(shop,o.date,'kcne');
  sources.push({file:o.files[i],shop,rows:dataRows.length,columns:x.headers.length,csvName:x.csvName,headers:x.headers,base:target.baseName,baseToken:target.baseToken,tableId:target.promotionTable,observedDates:[...new Set(dataRows.map(r=>String(r[0]??'').trim()).filter(Boolean))],
    // 空报表在收据里必须**留下痕迹**：只报 rows:0 的话，读的人分不清「当天真的没投放」
    // 和「文件是空的/没解开」，而这两种情况的后续动作完全不同。
    ...(verdict.empty?{emptyReport:true,blankRows:verdict.blankRows}:{})});
  if(!byBase.has(target.baseToken)) byBase.set(target.baseToken,{target,items:[]});
  byBase.get(target.baseToken).items.push({shop,rows:dataRows,headers:x.headers});
}

const groups=[];
for(const {target,items} of byBase.values()){
  // 凭据按**组内的 base** 取（不是模块级取一次）：跨组织后同一批店可能落在不同组织的
  // base 里，一个凭据写全部 = 一半 403（2026-10-16 商品链就是这么整批失败的）。
  const c=targetCredentials(target,'kcne');
  const client=new FeishuClient({appId:c.appId,appSecret:c.appSecret,appToken:target.baseToken,tableId:target.promotionTable});
  const targetFields=await client.listFields(); const targetNames=targetFields.map(f=>f.fieldName);
  const existing=await client.listRecords();
  // CSV schema 在淘宝/天猫之间可能不同（SKILL.md：preserve each downloaded source as-is）⇒
  // 组内再按表头签名分摊，各摊配各的既有字段映射。
  const byHeaders=new Map();
  for(const item of items){const key=item.headers.join('\u001f'); if(!byHeaders.has(key)) byHeaders.set(key,{headers:item.headers,rows:[]}); byHeaders.get(key).rows.push(...item.rows.map(values=>({values,shop:item.shop})));}
  for(const {headers,rows} of byHeaders.values()){
    const plan=planPromotionImport({rows:rows.map(r=>r.values),existing,headers,targetNames});
    groups.push({target,client,credentialFile:c.file,existingRows:existing.length,records:plan.records,manifest:plan.manifest.map((m,index)=>({...m,shop:rows[index]?.shop??null}))});
  }
}

mkdirSync(o.evidence,{recursive:true});
const receipt={sources,paramDate:o.date,date:[...new Set(sources.flatMap(s=>s.observedDates))],mode:o.apply?'apply':'dry-run',sourceRows:sources.reduce((sum,s)=>sum+s.rows,0),existingRows:groups.reduce((sum,g)=>sum+g.existingRows,0),plannedRows:groups.reduce((sum,g)=>sum+g.records.length,0),duplicateRows:sources.reduce((sum,s)=>sum+s.rows,0)-groups.reduce((sum,g)=>sum+g.records.length,0),bases:groups.map(g=>({base:g.target.baseName,baseToken:g.target.baseToken,tableId:g.target.promotionTable,credentialFile:g.credentialFile,existingRows:g.existingRows,plannedRows:g.records.length})),manifest:groups.flatMap(g=>g.manifest),
  // 空报表清单（2026-10-21 加）：这一批里有哪几家是「平台导出 0 行」。
  // 退出码仍然是 0 —— 零数据不是失败；但要让人一眼看出「写得少」是因为真没数据，
  // 而不是采集或写入漏了（主链据此不再把它们算成缺口）。
  ...(sources.some(s=>s.emptyReport)?{emptyReports:sources.filter(s=>s.emptyReport).map(s=>({shop:s.shop,file:s.file}))}:{})};
const receiptPath=`${o.evidence}/receipt.json`;
const flush=()=>{mkdirSync(o.evidence,{recursive:true});writeFileSync(receiptPath,JSON.stringify(receipt,null,2));};
if(o.apply){
  let writeFailed=false;
  // 逐批写入 + 每批落盘（2026-10-17 修）：原先 ids 攒在局部变量里、全部写完才赋值落盘，
  // 于是「第二批抛错」把第一批已写入的行一起丢掉，收据文件**一个都不生成**
  // （当天 `promotion-import/sales1/` 就是空目录）。现在任何时刻炸掉都留着「到那一刻为止
  // 确认写进去的行」。模块：runtime/import-write-ledger.mjs。
  try{
    for(const g of groups) await batchCreateWithLedger({client:g.client,records:g.records,receipt,flush});
  }catch(error){
    // 写入阶段的失败也要分两类：4xx（参数/权限/限流）＝确定性没写成 ⇒ 1；
    // 5xx/超时/网络/解析不出状态码 ⇒ **可能已经写入** ⇒ 2（UNKNOWN_WRITE，先回读再决定重试）。
    // 2026-10-17 那趟就是这里退成了 1，主链据此逐店重试，收据反而变成「本来就没新数据」。
    flush();
    const certain=writeFailureIsCertain(receipt.writeError);
    console.error(`推广写入未完成（${certain?'确定性未写成，退出码 1':'可能已写入，UNKNOWN_WRITE 退出码 2'}）：${receipt.writeError}`
      + `；已确认写入 ${receipt.recordIds.length} 行${receipt.writeBatches?`（${receipt.writeBatches} 批）`:''}`);
    console.log(JSON.stringify(receipt,null,2));
    process.exitCode=certain?1:2;
    writeFailed=true;
  }
  // 写后回读按 base 各自做：一个总数会把「A 表写成了、B 表没写成」盖住。
  // 写入阶段就让异常中断时仍做一次回读：那是「到底写了没写」唯一的现场判据，
  // 而退出码 2 的处置本来就是「先回读再决定要不要重试」—— 这里把回读做在当场。
  receipt.afterRows={};
  try{
    for(const g of groups) receipt.afterRows[g.target.baseToken]=(await g.client.listRecords()).length;
  }catch(error){
    receipt.readbackError=String(error?.message??error);
    flush();
    if(writeFailed) console.error(`写入失败后回读也失败，结果仍未知：${receipt.readbackError}`);
    else console.error(`推广已写入但写后回读失败（UNKNOWN_WRITE，退出码 2）：${receipt.readbackError}`);
    console.log(JSON.stringify(receipt,null,2));
    // 退出码 **2 ＝「写入已发生、写后回读失败」**，与 1（真的没写成）分开报。
    // 调用方据此走「先回读再决定要不要重试」，而不是把它当成一次普通失败去逐店重来。
    process.exitCode=2;
  }
}
flush(); console.log(JSON.stringify(receipt,null,2));
