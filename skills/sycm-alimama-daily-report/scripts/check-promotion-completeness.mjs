#!/usr/bin/env node
// 推广日报对账门 CLI（2026-10-15，用户拍板「要」）。判据本体在 promotion-completeness-core.mjs
//（纯函数），这里只做三件 I/O：收回执、读飞书、把结论交出去。
//
// 用法：
//   node skills/sycm-alimama-daily-report/scripts/check-promotion-completeness.mjs --date 2026-10-14
//   … --evidence-roots evidence/promotion-batches-2026-10-14,evidence/batches-2026-10-14 --json
// 退出码：0＝分母齐（含 ZERO_CONFIRMED）；1＝有缺口；2＝用法/读取错误。
//
// 默认证据根同时扫 promotion-batches-<日> 与 batches-<日>：后者是 hold-and-resume 续跑
// 现状落批次记录的地方（--resume-logs 不透传的已知欠账，2026-10-15 复现），不扫会漏掉
// 续跑补写的那几家的回执。欠账修掉后这个默认留着无害（扫不到就是空）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectingShopKeys } from '../../../runtime/browser-ports.mjs';
import { activeProfileName, departmentOfShop, promotionDailyTargets, targetCredentials } from '../../../runtime/feishu-targets.mjs';
import { FeishuClient } from '../../xws-to-feishu-base/scripts/feishu-client.mjs';
import { expectedUnits, judgePromotionCompleteness, receiptFacts, shopSubjectSets } from './promotion-completeness-core.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

function parseArgs(argv) {
  const out = { date: null, evidenceRoots: null, profile: null, shops: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--date') out.date = argv[++i];
    else if (key === '--evidence-roots') out.evidenceRoots = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--profile') out.profile = argv[++i];
    else if (key === '--shops') out.shops = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--json') out.json = true;
    else return { error: `未知参数 ${key}（可用：--date YYYY-MM-DD --evidence-roots a,b --profile <名> --shops a,b --json）` };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(out.date ?? '')) return { error: '需要 --date YYYY-MM-DD' };
  return { args: out };
}

/** 在一个证据根下收回执（不按日期过滤：本日过滤由 receiptFacts 管，跨日回执的主体ID 集合
 *  也用于人群归属——主体是店铺结构属性）：兼容两种落盘形态（分批 b<N>/<店>/ 与链直跑 <店>/）。 */
function collectReceipts(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const tryRead = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { return null; }
  };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (/^b\d+$/u.test(entry.name)) {
      const batchDir = path.join(root, entry.name);
      for (const shopDir of fs.readdirSync(batchDir, { withFileTypes: true })) {
        if (!shopDir.isDirectory()) continue;
        const receipt = tryRead(path.join(batchDir, shopDir.name, 'receipt.json'));
        if (receipt) out.push(receipt);
      }
    } else {
      const receipt = tryRead(path.join(root, entry.name, 'receipt.json'));
      if (receipt) out.push(receipt);
    }
  }
  return out;
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) { console.error(parsed.error); return 2; }
  const { date, profile, shops, json } = parsed.args;
  const shopList = shops ?? collectingShopKeys();
  const roots = parsed.args.evidenceRoots
    ?? [path.join('evidence', `promotion-batches-${date}`), path.join('evidence', `batches-${date}`)];

  const allReceipts = roots.flatMap((root) => collectReceipts(path.resolve(REPO_ROOT, root)));
  const receipts = allReceipts.filter((receipt) => receipt?.date === date);
  const facts = receiptFacts(allReceipts, { date });
  const units = expectedUnits({ shops: shopList });

  const activeProfile = profile ?? activeProfileName();
  // 按月 × 部门解析（2026-10-26，二部接入）：与导入器同一口径，缺月/缺部门 fail-closed。
  //
  // 为什么这里必须改成「按部门各读一张表、再把行合起来」：原先只解析一个 target，
  // 二部接入后那些行在**另一张表**里 —— 只读 1 部那张，二部的每个单元都会被判成
  // 「飞书里没有」，而真实原因是「读错了表」。这种假缺口比漏检更糟：它会让人去重跑
  // 已经写对了的数据，而重跑会因为幂等键而一行都不写、看起来像又一次失败。
  const departments = [...new Set(shopList.map((shop) => departmentOfShop(shop)))].sort();
  const targetsByDepartment = new Map();
  for (const department of departments) {
    const target = promotionDailyTargets(activeProfile, date, department);
    if (!target.baseToken) { console.error(`推广日报目标未完整配置（profile=${activeProfile}，部门=${department}）`); return 2; }
    targetsByDepartment.set(department, target);
  }
  // 凭据按目标取（2026-10-17）：与导入器同一份凭据，避免「导入器用 A 组织凭据写、
  // 对账器用 B 组织凭据读」⇒ 读回 0 行、却把「读不到」当成「没写」。
  const feishuRecords = {};
  for (const kind of ['keyword', 'audience']) {
    const rows = [];
    for (const [department, target] of targetsByDepartment) {
      const tableId = target.tables?.[kind];
      if (!tableId) { console.error(`推广日报 ${kind} 目标未配置（部门=${department}）`); return 2; }
      const credentials = targetCredentials(target, activeProfile);
      const client = new FeishuClient({ appId: credentials.appId, appSecret: credentials.appSecret, appToken: target.baseToken, tableId });
      const read = await client.listRecords();
      console.log(`[对账门] 读 ${department} ${kind}：${target.baseName} / ${tableId} → ${read.length} 行`);
      rows.push(...read);
    }
    feishuRecords[kind] = rows;
  }
  // 人群归属映射的唯一来源＝回执捕获的 subjectIds（导入器从该店 CSV 实测）。
  // ⚠️ 不要用阿里妈妈会员ID（shopIdentity 的会员数字字段）做归属：会员ID 与主体ID 是
  // 不同标识空间（2026-10-15 实测：用会员ID会把全部店判成 MISMATCH）。
  const subjectSetsByShop = shopSubjectSets(allReceipts);

  const verdict = judgePromotionCompleteness({ date, units, facts, feishuRecords, subjectSetsByShop });
  if (json) {
    console.log(JSON.stringify({ ...verdict, roots, receipts: receipts.length }, null, 2));
  } else {
    console.log(`[对账门] 业务日 ${date}｜分母 ${units.length} 个单元（${shopList.length} 家 × 2 表）｜回执 ${receipts.length} 份`);
    for (const unit of verdict.units) {
      console.log(`  ${unit.verdict.padEnd(22)} ${unit.shop}·${unit.kind.padEnd(8)} planned=${unit.plannedRows ?? '—'} verified=${unit.verifiedRows} ${unit.why}`);
    }
    console.log(`[对账门] 结论：${verdict.ok ? '齐' : `缺 ${verdict.gaps.length} 个单元`}`
      + (verdict.zeroRows.length ? `；真实为空待人工确认 ${verdict.zeroRows.length} 个（${verdict.zeroRows.map((u) => `${u.shop}·${u.kind}`).join('、')}）` : ''));
  }
  return verdict.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(`对账门失败：${error.message}`); process.exitCode = 2; })
    .then((code) => { if (Number.isInteger(code)) process.exitCode = code; });
}
