#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FeishuClient } from '../../xws-to-feishu-base/scripts/feishu-client.mjs';
import { buildFeishuFields, promotionIdempotencyKey, validateExportRows } from './promotion-daily-report-core.mjs';
import { activeProfileName, promotionDailyTargets, targetCredentials } from '../../../runtime/feishu-targets.mjs';
import { batchCreateWithLedger, writeFailureIsCertain } from '../../../runtime/import-write-ledger.mjs';
const PY = `import csv,io,json,sys,zipfile
sys.stdout.reconfigure(encoding='utf-8')
with zipfile.ZipFile(sys.argv[1]) as z:
 n=next(x for x in z.namelist() if x.lower().endswith('.csv'))
 raw=z.read(n)
 try: text=raw.decode('utf-8-sig')
 except UnicodeDecodeError: text=raw.decode('gb18030')
 rows=list(csv.reader(io.StringIO(text.lstrip('\\ufeff'))))
 rows=[row for row in rows[1:] if any(str(cell).strip() for cell in row)]
 headers=list(csv.reader(io.StringIO(text.lstrip('\\ufeff'))))[0]
 print(json.dumps({'csvName':n,'headers':headers,'rows':rows},ensure_ascii=False))`;

function parse(argv) {
  const o = { apply: false, evidence: 'evidence/promotion-daily-import', files: {}, profile: null, shop: null };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--keyword') o.files.keyword = path.resolve(argv[++i]);
    else if (k === '--audience') o.files.audience = path.resolve(argv[++i]);
    else if (k === '--apply') o.apply = true;
    else if (k === '--evidence') o.evidence = path.resolve(argv[++i]);
    else if (k === '--date') o.date = argv[++i];
    else if (k === '--profile') o.profile = argv[++i];
    else if (k === '--shop') o.shop = argv[++i];
    else throw new Error(`unknown argument ${k}`);
  }
  if (!o.files.keyword || !o.files.audience || !/^\d{4}-\d{2}-\d{2}$/u.test(o.date ?? '') || !o.shop) {
    throw new Error('需要 --date YYYY-MM-DD --shop <shop> --keyword <zip> --audience <zip>');
  }
  return o;
}

function readZip(file) {
  // stdio 必须显式给 ['ignore','pipe','pipe']：默认带 stdin 管道时 spawnSync 在本机会 EBUSY
  // （2026-10-11 实测：解析 ZIP 恒失败，报 "spawnSync py EBUSY"）。
  const r = spawnSync(process.env.PYTHON ?? 'py', ['-3', '-c', PY, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`ZIP解析失败: ${r.stderr || r.error?.message}`);
  return JSON.parse(r.stdout);
}
async function main(argv = process.argv.slice(2)) {
  const args = parse(argv); mkdirSync(args.evidence, { recursive: true });
  const profile = args.profile ?? activeProfileName();
  // 按月解析（2026-10-16）：推广日报的 base 由运营按月建，单对象目标会在换 base 后静默写飞。
  const target = promotionDailyTargets(profile, args.date);
  // 凭据按**目标**取（2026-10-17）：10 月这张 base 在别的组织，kcne 应用对它只能读，
  // 写会 403/1063004 —— 而且它死在 batchCreateRecords 或写后回读，容易被误读成 UNKNOWN_WRITE。
  const credentials = targetCredentials(target, profile);
  const receipt = { mode: args.apply ? 'apply' : 'dry-run', date: args.date, shop: args.shop, profile, credentialFile: credentials.file, tables: {}, sources: {} };
  for (const kind of ['keyword', 'audience']) {
    const source = readZip(args.files[kind]);
    // 阿里妈妈关键词报表近期新增两列；历史 75 列和当前 77 列均可导入，未知列仍由目标字段映射过滤。
    const expectedColumns = kind === 'keyword' ? [75, 77] : [71, 73, 75];
    // 2026-10-15（用户拍板）：两种报表都允许空表——「平台显示暂无数据」是真实业务形态，
    // 空≠失败；不填 0 的纪律不变（空态由对账门单列为「低量待确认」，不当成功也不当故障）。
    validateExportRows(source.headers, source.rows, { kind: kind === 'keyword' ? '关键词' : '人群', expectedColumns, date: args.date, allowEmpty: true });
    const tableId = target.tables?.[kind];
    if (!tableId || !target.baseToken) throw new Error(`推广日报 ${kind} 目标未完整配置（需要 baseToken 与 tables.${kind}）`);
    // targetCredentials() 的稳定返回契约是 appId/appSecret；不要绕过配置层读取旧字段名。
    const client = new FeishuClient({ appId: credentials.appId, appSecret: credentials.appSecret, appToken: target.baseToken, tableId });
    const fieldItems = await client.listFieldItems();
    const targetFields = new Map(fieldItems.map((f) => [f.field_name, f.type]));
    const existing = await client.listRecords(); const existingKeys = new Set(existing.map((r) => promotionIdempotencyKey(r.fields ?? {}, { shop: args.shop, kind })));
    const planned = []; const seen = new Set();
    for (const values of source.rows) {
      const fields = buildFeishuFields(source.headers, values, targetFields); const k = promotionIdempotencyKey(fields, { shop: args.shop, kind });
      if (existingKeys.has(k) || seen.has(k)) continue; seen.add(k); planned.push(fields);
    }
    receipt.sources[kind] = { file: args.files[kind], csvName: source.csvName, rows: source.rows.length, columns: source.headers.length };
    // 2026-10-15：捕获该店 CSV 实测的「主体ID」去重集合并落进回执——这是对账门人群归属的唯一
    // 真实来源（一店多主体是常态：2026-10-14 实测 5 家各 5-11 个主体ID；关键词报表无此列记空数组，不猜）。
    const subjectCol = source.headers.indexOf('主体ID');
    const subjectIds = subjectCol >= 0
      ? [...new Set(source.rows.map((values) => String(values[subjectCol] ?? '').trim()).filter(Boolean))].sort()
      : [];
    receipt.tables[kind] = { tableId, beforeRows: existing.length, plannedRows: planned.length, skippedRows: source.rows.length - planned.length, subjectIds };
    if (args.apply && planned.length) {
      // 逐批写入 + 每批落盘（2026-10-17 修，模块 runtime/import-write-ledger.mjs）：
      // 原先 ids 攒在局部变量里、整份收据只在 main 末尾写一次 ⇒ 写入中途抛错就一个文件都没有
      // （10-06 商品底单、10-17 推广段都是这个病根，这里是第三处）。
      const flushReceipt = () => writeFileSync(path.join(args.evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
      const block = receipt.tables[kind];
      try {
        await batchCreateWithLedger({ client, records: planned, receipt, target: block, flush: flushReceipt });
      } catch (error) {
        // 确定性拒绝（4xx/权限/限流）⇒ 真的没写成；其余（5xx/超时/网络）⇒ 可能已写入，交外层按 2 收场。
        error.writeFailureCertain = writeFailureIsCertain(block.writeError);
        error.afterWrite = !error.writeFailureCertain;
        throw error;
      }
      try {
        const after = await client.listRecords(); const written = new Set(block.recordIds); const reread = after.filter((r) => written.has(r.record_id));
        if (reread.length !== block.recordIds.length) throw new Error(`${kind} 写入后回读数量不一致`);
        block.afterRows = after.length;
      } catch (error) {
        // 走到这里**已经写过了** ⇒ 不许报成「没写成」。
        error.afterWrite = true;
        flushReceipt();
        throw error;
      }
    }
  }
  writeFileSync(path.join(args.evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
}
// 退出码纪律（2026-10-17）：写入已经发生之后的任何异常（回读炸、数量不一致、5xx 写入中途抛错）
// 一律按 **2 = UNKNOWN_WRITE** 收场；只有确定性拒绝（4xx/权限/限流，根本没写成）才是 1。
// 混成一个 1，调用方就会去逐店重试，而那些数据其实已经在表里了。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(`导入失败：${error.message}`); process.exitCode = error?.afterWrite === true ? 2 : 1; });
