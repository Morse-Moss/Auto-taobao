#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { productDataTargetsForShop, targetCredentials } from '../../../runtime/feishu-targets.mjs';
import { FeishuClient } from '../../xws-to-feishu-base/scripts/feishu-client.mjs';
import { parseInquiryRows, planInquiryImport } from './inquiry-core.mjs';
import { batchCreateWithLedger, writeFailureIsCertain } from '../../../runtime/import-write-ledger.mjs';

function args(argv) { const o={apply:false}; for(let i=0;i<argv.length;i+=1){if(argv[i]==='--file')o.file=argv[++i];else if(argv[i]==='--date')o.date=argv[++i];else if(argv[i]==='--shop')o.shop=argv[++i];else if(argv[i]==='--apply')o.apply=true;else if(argv[i]==='--evidence')o.evidence=argv[++i];else throw new Error(`unknown argument ${argv[i]}`);} if(!o.file||!o.date||!o.shop)throw new Error('--file --date --shop are required'); o.evidence??=`evidence/product-inquiry-${o.date}`; return o; }
// 与 import-product-data.mjs 同源：必须给 `stdio`，否则宿主沙箱回 `EBUSY`（`status=null`、`stderr` 空串），
// 报出来的是「XLS parser failed」这句看不出真因的话（2026-09-27 实测：底单与询单五家全灭都源于此）。
function readXls(file) { const script=path.join(import.meta.dirname,'../../sycm-product-data/scripts/read-product-xls.py'); const pythonCommand=process.env.PYTHON||'py'; const pythonPrefix=process.env.PYTHON?[]:['-3']; const r=spawnSync(pythonCommand,[...pythonPrefix,script,path.resolve(file)],{encoding:'utf8',stdio:['ignore','pipe','pipe']}); if(r.status!==0)throw new Error(`XLS parser failed：${r.stderr?.trim()||r.error?.message||`exit ${r.status}`}`); return JSON.parse(r.stdout); }
const o=args(process.argv.slice(2)); const rows=parseInquiryRows(readXls(o.file),o.date,o.shop); const target=productDataTargetsForShop(o.shop,o.date,'kcne'); const c=targetCredentials(target,'kcne'); const client=new FeishuClient({appId:c.appId,appSecret:c.appSecret,appToken:target.baseToken,tableId:target.inquiryTable}); const existing=await client.listRecords(); const plan=planInquiryImport({rows,existing}); mkdirSync(o.evidence,{recursive:true}); const receipt={source:path.resolve(o.file),shop:o.shop,date:o.date,base:target.baseName,baseToken:target.baseToken,credentialFile:c.file,sourceRows:rows.length,existingRows:existing.length,plannedRows:plan.records.length,excludedSummaryRows:2,mode:o.apply?'apply':'dry-run',manifest:plan.manifest};
// 2026-10-17 修：原先整份收据只在**最后**写一次（`writeFileSync` 排在批量写入之后）⇒ 写入中途抛错
// 就一个文件都没有，与 10-06 商品底单、10-17 推广段是同一个病根。现在先落草稿、逐批落盘。
const receiptPath=path.join(o.evidence,`receipt-${o.shop}.json`);
const flush=()=>writeFileSync(receiptPath,JSON.stringify(receipt,null,2));
if(o.apply){
  let writeFailed=false;
  try{
    await batchCreateWithLedger({client,records:plan.records,receipt,flush});
  }catch(error){
    // 4xx（参数/权限/限流）＝确定性没写成 ⇒ 1；5xx/超时/网络 ⇒ 可能已写入 ⇒ 2（UNKNOWN_WRITE）。
    flush();
    const certain=writeFailureIsCertain(receipt.writeError);
    console.error(`询单写入未完成（${certain?'确定性未写成，退出码 1':'可能已写入，UNKNOWN_WRITE 退出码 2'}）：${receipt.writeError}`
      + `；已确认写入 ${receipt.recordIds.length} 行${receipt.writeBatches?`（${receipt.writeBatches} 批）`:''}`);
    process.exitCode=certain?1:2;
    writeFailed=true;
  }
  if(!writeFailed){
    try{ receipt.afterRows=(await client.listRecords()).length; flush(); }
    catch(error){
      receipt.readbackError=String(error?.message??error);
      flush();
      console.error(`询单已写入但写后回读失败（UNKNOWN_WRITE，退出码 2）：${receipt.readbackError}`);
      process.exitCode=2;
    }
  }
}
flush(); console.log(JSON.stringify(receipt,null,2));