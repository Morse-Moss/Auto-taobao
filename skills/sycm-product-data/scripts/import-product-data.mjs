#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadFeishuCredentials, productDataTargetsForShop } from '../../../runtime/feishu-targets.mjs';
import { FeishuClient } from '../../xws-to-feishu-base/scripts/feishu-client.mjs';
import { PRODUCT_HEADERS, planProductImport } from './product-core.mjs';

// `--date` 是**必填**（2026-09-30 加）：商品数据的飞书 base 按月 × 按部门换，而这个脚本
// 只拿得到 `--shop`（哪家店）。没有数据日期就无法解析出该写哪张 base ——
// 缺参就抛错，而不是回落成「上个月那张」（回落会「跑成功但写进运营不看的表」）。
function args(argv) { const out = { files: [], shop: null, date: null, apply: false, evidence: null }; for(let i=0;i<argv.length;i+=1){if(argv[i]==='--file')out.files.push(argv[++i]);else if(argv[i]==='--shop')out.shop=argv[++i];else if(argv[i]==='--date')out.date=argv[++i];else if(argv[i]==='--apply')out.apply=true;else if(argv[i]==='--evidence')out.evidence=argv[++i];else throw new Error(`unknown argument ${argv[i]}`);} if(!out.files.length||!out.shop)throw new Error('--file and --shop are required');if(out.files.length!==1)throw new Error('one --file per --shop is required');if(!/^\d{4}-\d{2}-\d{2}$/u.test(out.date??''))throw new Error('missing or invalid --date (expected YYYY-MM-DD)');out.evidence??=`evidence/product-data-${out.date}`;return out; }
// `stdio` 三件套不能省：宿主沙箱对「给了子进程 stdin 管道」的同步 spawn 直接回 `EBUSY`
// （`errno=-4082`），此时 `status=null`、`stderr` 是空串 —— 于是 `stderr || '…'` 会抛出一句
// 看不出真因的「XLS parser failed」，看起来像解析器坏了，其实是进程压根没起来。
// 2026-09-27 实测：这处裸 `spawnSync` 让五家店的底单与询单**全部**导入失败（四轮跑，飞书零写入）。
function rowsFromXls(file) { const script = path.join(import.meta.dirname, 'read-product-xls.py'); const result = spawnSync(process.env.PYTHON || 'py', ['-3', script, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); if(result.status!==0)throw new Error(`XLS parser failed：${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`); return JSON.parse(result.stdout); }
function csvLine(row) { return row.map((value) => { const text=String(value ?? ''); return /[",\n]/u.test(text) ? `"${text.replaceAll('"','""')}"` : text; }).join(','); }
async function main(){const options=args(process.argv.slice(2));const raw=rowsFromXls(options.files[0]);if(raw.length<6||raw[4].length!==PRODUCT_HEADERS.length)throw new Error('商品报表缺少 38 列标准表头');const parsed=raw.slice(5).filter((row)=>row.length===PRODUCT_HEADERS.length&&/^\d{4}-\d{2}-\d{2}$/u.test(row[0])).map((row)=>({header:PRODUCT_HEADERS,row,sourceShop:options.shop}));const {appId,appSecret}=loadFeishuCredentials('kcne');const target=productDataTargetsForShop(options.shop,options.date,'kcne');const client=new FeishuClient({appId,appSecret,appToken:target.baseToken,tableId:target.productTable});const existing=await client.listRecords();const plan=planProductImport({rows:parsed,existing});mkdirSync(options.evidence,{recursive:true});const receipt={source:options.files[0],shop:options.shop,date:options.date,base:target.baseName,baseToken:target.baseToken,sourceRows:parsed.length,existingRows:existing.length,plannedRows:plan.records.length,mode:options.apply?'apply':'dry-run',manifest:plan.manifest};if(options.apply){const ids=[];for(let i=0;i<plan.records.length;i+=500)ids.push(...await client.batchCreateRecords(plan.records.slice(i,i+500)));receipt.recordIds=ids;receipt.afterRows=(await client.listRecords()).length;}writeFileSync(path.join(options.evidence,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
main().catch((e)=>{console.error(`导入失败：${e.message}`);process.exitCode=1});
