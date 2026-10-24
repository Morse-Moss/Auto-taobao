#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { productDataTargetsForShop, targetCredentials } from '../../../runtime/feishu-targets.mjs';
import { FeishuClient } from '../../xws-to-feishu-base/scripts/feishu-client.mjs';
import { PRODUCT_HEADERS, planProductImport } from './product-core.mjs';
import { batchCreateWithLedger, writeFailureIsCertain } from '../../../runtime/import-write-ledger.mjs';

// `--date` 是**必填**（2026-09-30 加）：商品数据的飞书 base 按月 × 按部门换，而这个脚本
// 只拿得到 `--shop`（哪家店）。没有数据日期就无法解析出该写哪张 base ——
// 缺参就抛错，而不是回落成「上个月那张」（回落会「跑成功但写进运营不看的表」）。
function args(argv) { const out = { files: [], shop: null, date: null, apply: false, evidence: null }; for(let i=0;i<argv.length;i+=1){if(argv[i]==='--file')out.files.push(argv[++i]);else if(argv[i]==='--shop')out.shop=argv[++i];else if(argv[i]==='--date')out.date=argv[++i];else if(argv[i]==='--apply')out.apply=true;else if(argv[i]==='--evidence')out.evidence=argv[++i];else throw new Error(`unknown argument ${argv[i]}`);} if(!out.files.length||!out.shop)throw new Error('--file and --shop are required');if(out.files.length!==1)throw new Error('one --file per --shop is required');if(!/^\d{4}-\d{2}-\d{2}$/u.test(out.date??''))throw new Error('missing or invalid --date (expected YYYY-MM-DD)');out.evidence??=`evidence/product-data-${out.date}`;return out; }
// `stdio` 三件套不能省：宿主沙箱对「给了子进程 stdin 管道」的同步 spawn 直接回 `EBUSY`
// （`errno=-4082`），此时 `status=null`、`stderr` 是空串 —— 于是 `stderr || '…'` 会抛出一句
// 看不出真因的「XLS parser failed」，看起来像解析器坏了，其实是进程压根没起来。
// 2026-09-27 实测：这处裸 `spawnSync` 让五家店的底单与询单**全部**导入失败（四轮跑，飞书零写入）。
function rowsFromXls(file) { const script = path.join(import.meta.dirname, 'read-product-xls.py'); const pythonCommand = process.env.PYTHON || 'py'; const pythonPrefix = process.env.PYTHON ? [] : ['-3']; const result = spawnSync(pythonCommand, [...pythonPrefix, script, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); if(result.status!==0)throw new Error(`XLS parser failed：${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`); return JSON.parse(result.stdout); }
function csvLine(row) { return row.map((value) => { const text=String(value ?? ''); return /[",\n]/u.test(text) ? `"${text.replaceAll('"','""')}"` : text; }).join(','); }
async function main(){
  const options=args(process.argv.slice(2));
  const raw=rowsFromXls(options.files[0]);
  if(raw.length<6||raw[4].length!==PRODUCT_HEADERS.length)throw new Error('商品报表缺少 38 列标准表头');
  const parsed=raw.slice(5).filter((row)=>row.length===PRODUCT_HEADERS.length&&/^\d{4}-\d{2}-\d{2}$/u.test(row[0])).map((row)=>({header:PRODUCT_HEADERS,row,sourceShop:options.shop}));
  // 凭据按**目标**取（2026-10-17）：商品 base 按月 × 部门换，10 月起在别的组织，
  // 用本组织 kcne 凭据连 listRecords 都 403/91403（2026-10-16 实测 24/24 全灭）。
  const target=productDataTargetsForShop(options.shop,options.date,'kcne');
  const {appId,appSecret,file:credentialFile}=targetCredentials(target,'kcne');
  const client=new FeishuClient({appId,appSecret,appToken:target.baseToken,tableId:target.productTable});
  const existing=await client.listRecords();
  const plan=planProductImport({rows:parsed,existing});
  mkdirSync(options.evidence,{recursive:true});
  const receiptPath=path.join(options.evidence,'receipt.json');
  const receipt={source:options.files[0],shop:options.shop,date:options.date,base:target.baseName,baseToken:target.baseToken,credentialFile,sourceRows:parsed.length,existingRows:existing.length,plannedRows:plan.records.length,mode:options.apply?'apply':'dry-run',manifest:plan.manifest};
  const flush=()=>writeFileSync(receiptPath,JSON.stringify(receipt,null,2));
  if(!options.apply){flush();console.log(JSON.stringify(receipt,null,2));return;}
  // 逐批写入 + 每批落盘（2026-10-17 修，模块 runtime/import-write-ledger.mjs）：
  // 原先 ids 攒在局部变量里、全部写完才赋值落盘 ⇒ 「第二批抛错」把第一批已写入的行一起丢掉，
  // 收据文件一个都不生成。推广段当天就是这么丢掉 46 行的证据（sales1 目录空的）。
  // **写已经发生 ⇒ 立刻落收据**（2026-10-06 那条纪律保留）：落盘排在「写后回读」之前。
  let writeFailed=false;
  try{
    await batchCreateWithLedger({client,records:plan.records,receipt,flush});
  }catch(error){
    // 4xx（参数/权限/限流）＝确定性没写成 ⇒ 1；5xx/超时/网络 ⇒ 可能已写入 ⇒ 2（UNKNOWN_WRITE）。
    flush();
    const certain=writeFailureIsCertain(receipt.writeError);
    console.error(`底单写入未完成（${certain?'确定性未写成，退出码 1':'可能已写入，UNKNOWN_WRITE 退出码 2'}）：${receipt.writeError}`
      + `；已确认写入 ${receipt.recordIds.length} 行${receipt.writeBatches?`（${receipt.writeBatches} 批）`:''}`);
    process.exitCode=certain?1:2;
    writeFailed=true;
  }
  try{receipt.afterRows=(await client.listRecords()).length;flush();}
  catch(error){
    receipt.readbackError=String(error?.message??error);
    flush();
    // 退出码 **2 ＝「写入已发生、写后回读失败」**（UNKNOWN_WRITE），与 1（真的没写成）分开报。
    // 调用方据此走「先回读再决定要不要重试」；盲目重跑会撞同日去重闸门、得 0 行。
    console.error(`导入已写入但写后回读失败（UNKNOWN_WRITE，退出码 2）：${receipt.readbackError}`);
    console.log(JSON.stringify(receipt,null,2));
    process.exitCode=2;
    return;
  }
  console.log(JSON.stringify(receipt,null,2));
  if(writeFailed) return;
}
main().catch((e)=>{console.error(`导入失败：${e.message}`);process.exitCode=1});
