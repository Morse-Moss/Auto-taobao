#!/usr/bin/env node

/**
 * 「这一天的行骨架」：飞书「各店铺数据日报」里 (日期, 店铺) 那两列的一行（2026-10-07 加）。
 *
 * ── 为什么必须有这一步（2026-10-06 的真实事故）──────────────────────────────
 * 那一轮 8 家店跑完了前 9 步（含第 7 步 `push`：**底单全部写成功**，收据是
 * `COMMITTED_AND_VERIFIED`），到第 10 步 `backfill` 8 家**全部**报
 * `expected one Feishu row for <店> / <epoch>, got 0`（`run-inquiry-backfill.mjs`）。
 * 根因不是页面、不是登录、不是脚本：这张表的日期行是**运营侧预建**的
 *（`docs/ops/PROJECT-BROWSER-AND-PORTS.md` 第 62 行：「09-29…10-05 预建行也按 13 家铺好」），
 * 而仓库里**没有任何脚本会建行** —— 于是预建行铺到哪天，回填就只能回填到哪天。
 * 这是「外部依赖没有落进流程」的形态，不是一次性的坏运气：只要没人继续预建，它每天都全挂。
 *
 * ── 口径（用户 2026-10-07 拍板）──────────────────────────────────────────
 *   · **日级、幂等**：一天一次，只保证那一天该有的行在；已经在的行一个字节都不动。
 *   · **只写两列**：`日期` + `店铺`。这张表 33 个字段里只有 5 个可写，其余是
 *     Lookup(`type 19`) / Formula(`type 20`) 派生列 —— **行一在、底单数据一推上去，它们自己就解析出值**。
 *     所以「建行」不是造数据，只是把容器准备好。
 *   · **默认 dry-run**（`--commit` 才写）。理由与链上每一步同源：写飞书是**不可撤销**的对外动作。
 *   · **fail-closed**：表名不对 / 字段类型不对 / 目标店在「店铺」选项里不存在 / 同日同店出现多行
 *     ⇒ **整批一行都不建**（半路建一半会让状态更难说清，而「建了一半」在表上与「建完了」长得一样）。
 *   · **独立回读**：写完**重新拉一次全表**再断言，不信写入响应（本仓吃过太多次「自己说成了」）。
 *
 * ── 为什么默认是**全部 13 家登记店**（`shopBrowserKeys()`）而不是参与采集的 8 家 ──
 * 行骨架回答的是「这张表**声明**了哪些店铺」——它的「店铺」单选选项恰好是 13 项，
 * 历史预建行也按 13 家铺；而 `collectingShopKeys()`（8 家＝销售1部，销售2部整部门停采）
 * 回答的是「今天采不采」。两者只在停采时不同，而**停采是临时的**（恢复只需删一行配置）。
 * 若按 8 家铺，恢复采集那天会先缺 5 家的行、再补；按 13 家铺则不用管这件事。
 * 要收窄就显式给 `--shops`（`run-daily-job.mjs --shops` 会原样转过来）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node …/ensure-inquiry-rows.mjs --date 2026-10-06            # 排练：只算该建哪些，一个字节都不写
 *   node …/ensure-inquiry-rows.mjs --date 2026-10-06 --commit   # 真建（缺几行建几行）
 *   node …/ensure-inquiry-rows.mjs --date yesterday --commit --shops 科塔淘宝
 *   node …/ensure-inquiry-rows.mjs --date 2026-10-06 --commit --evidence evidence/daily-job-2026-10-06
 * 退出码：0＝目标行的状态已确认（本来就齐 / 建好并回读通过）；1＝失败；2＝用法错误。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dailyReportTargets, loadFeishuCredentials } from '../../../runtime/feishu-targets.mjs';
import { shopBrowserKeys } from '../../../runtime/browser-ports.mjs';
import { reportDateEpoch } from './daily-report-core.mjs';
import { resolveTargetDate } from './date-picker.mjs';
import {
  planInquiryRowSkeleton, shopOptionsOf, pickShopOptionId,
} from './inquiry-core.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const TARGET = dailyReportTargets('kcne');

/** 这张表里被写的两个字段。**其余一律不写**（派生列写不进去，硬写会报错或被忽略）。 */
const WRITTEN_FIELDS = Object.freeze(['日期', '店铺']);

/** 这张表的期望形状。名字与类型都不对就 fail-closed（写错表的代价是不可撤销的）。 */
const EXPECTED_TABLE_NAME = '各店铺数据日报';
const EXPECTED_FIELD_TYPES = Object.freeze([['日期', 5], ['店铺', 3]]);

function parseArgs(argv) {
  const args = { commit: false, shops: null, evidence: null, reportDate: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--commit') args.commit = true;
    else if (key === '--date') args.reportDate = argv[++index];
    else if (key === '--shops') {
      args.shops = String(argv[++index] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      // 空清单与「没给」是两回事：`--shops ''` 看起来像「跑了」，实际一个店都不碰。
      if (args.shops.length === 0) return { error: '--shops 给了但解析出 0 家店（要给逗号分隔的运营店名）' };
    } else if (key === '--evidence') args.evidence = argv[++index];
    else return { error: `未知参数 ${key}（可用：--date --shops --commit --evidence）` };
  }
  if (!args.reportDate) return { error: 'missing --date（要 YYYY-MM-DD 或 yesterday）' };
  return { args };
}

/** 目标店铺名单：显式给了 `--shops` 就用它，否则＝**全部登记店**（见文件头那段口径）。 */
function resolveTargetShops(args) {
  const registered = shopBrowserKeys();
  if (!args.shops) return registered;
  const unknown = args.shops.filter((shop) => !registered.includes(shop));
  // 未登记的店名一律拒：它多半是笔误，而「按笔误建行」的后果是平台侧悄悄多出一个选项。
  if (unknown.length) {
    throw new Error(`--shops 里有未登记的店铺：${unknown.join(' / ')}；已登记：${registered.join(' / ')}`);
  }
  // 顺序按登记表，不按调用方给的顺序：同一件事的产物形状不该随命令行写法而变。
  return registered.filter((shop) => args.shops.includes(shop));
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) { console.error(parsed.error); return 2; }
  const { args } = parsed;

  // 日期口径**复用链那一份**（`resolveTargetDate`）：`--date yesterday` 必须与链解析成同一天，
  // 否则会「给 A 日建行、链往 B 日回填」—— 而两边都不报错，只是回填永远 got 0。
  const reportDate = resolveTargetDate(args.reportDate);
  const epoch = reportDateEpoch(reportDate);
  const targets = resolveTargetShops(args);
  const evidenceDir = args.evidence
    ? path.resolve(args.evidence)
    : path.join(REPO_ROOT, 'evidence', `inquiry-rows-${reportDate}`);

  const clientModule = await import(pathToFileURL(path.join(REPO_ROOT,
    'skills', 'xws-to-feishu-base', 'scripts', 'feishu-client.mjs')));
  const credentials = loadFeishuCredentials('kcne');
  const client = new clientModule.FeishuClient({ appId: credentials.appId, appSecret: credentials.appSecret,
    appToken: TARGET.baseToken, tableId: TARGET.inquiryTable });

  // 一次并行拉齐：表名（证明我读写的 tableId 就是它自称的那张表）、字段（证明类型）、
  // 选项表（证明目标店真实存在）、全量行（算骨架缺哪些）。
  // 「读不到就算过」是本项目最贵的一类错，所以下面每一条读到的结论**都要被断言**。
  const [tables, fields, fieldItems, beforeRecords] = await Promise.all([
    client.listTables(), client.listFields(), client.listFieldItems(), client.listRecords(),
  ]);
  const table = tables.find((item) => item.tableId === TARGET.inquiryTable);
  if (table?.name !== EXPECTED_TABLE_NAME) {
    throw new Error(`unexpected Feishu table: ${table?.name ?? 'missing'}`
      + `（期望「${EXPECTED_TABLE_NAME}」；base=${TARGET.baseToken} tableId=${TARGET.inquiryTable}）`);
  }
  for (const [name, type] of EXPECTED_FIELD_TYPES) {
    const field = fields.find((item) => item.fieldName === name);
    if (!field || field.type !== type) {
      throw new Error(`unexpected Feishu field ${name}: ${JSON.stringify(field)}（期望 type=${type}）`);
    }
  }

  // 「店铺」选项表：**写之前**必须证明每个目标店都真实存在于选项里。
  // 为什么这一条是硬闸门（而回填里同一个函数只作降级）：回填是**更新已有行**，
  // 认不出就退回只按店名匹配，最坏是读不到；而这里是**新建行** —— 写一个选项表里没有的店名，
  // 平台可能（按字段设置）**悄悄新建一个选项**，于是表里多出一家「谁也不认识的店」，
  // 而它看起来完全正常。所以这里 fail-closed，并在错误里点名是哪几家。
  const options = shopOptionsOf(fieldItems, '店铺');
  const optionIdByShop = {};
  const withoutOption = [];
  for (const shop of targets) {
    const id = pickShopOptionId(options, shop);
    if (!id) withoutOption.push(shop);
    else optionIdByShop[shop] = id;
  }
  if (withoutOption.length) {
    throw new Error(`这些店在「${EXPECTED_TABLE_NAME}」的「店铺」选项里不存在：${withoutOption.join(' / ')}`
      + `（选项表现有：${options.map((option) => option.name).join(' / ')}）`
      + ' —— 先把选项建出来再跑；按不存在的店名建行会静默多出一个选项。');
  }

  const before = planInquiryRowSkeleton({ records: beforeRecords, reportDateEpoch: epoch, shops: targets, optionIdByShop });
  // 同日同店多行不是「已经有行了」，是**数据异常**：挑一行去回填、或再补一行，都会让异常更晚被发现。
  if (before.duplicated.length) {
    throw new Error(`同期同店出现多行（需人核对，一行都不建）：`
      + `${before.duplicated.map((item) => `${item.shop}×${item.candidateCount}`).join(' / ')}`
      + `｜日期=${reportDate}`);
  }

  const base = {
    mode: args.commit ? 'commit' : 'dry-run',
    at: new Date().toISOString(),
    reportDate, dateEpoch: epoch,
    base: { appToken: TARGET.baseToken, name: TARGET.sourceBaseName ?? null },
    table: { tableId: TARGET.inquiryTable, name: table.name },
    fields: Object.fromEntries(EXPECTED_FIELD_TYPES.map(([name, type]) => [name, type])),
    writtenFields: [...WRITTEN_FIELDS],
    targets,
    present: before.present,
    missing: before.missing,
  };

  mkdirSync(evidenceDir, { recursive: true });
  const planPath = path.join(evidenceDir, 'ensure-inquiry-rows-plan.json');
  writeFileSync(planPath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');

  let missing = [...before.missing];
  let created = [];

  const summarize = (extra) => ({
    ...extra,
    reportDate, dateEpoch: epoch,
    tableName: table.name,
    targets: targets.length,
    presentCount: before.present.length,
    missing,
    planPath,
  });

  if (missing.length > 0 && args.commit) {
    // 写入形状：**只有两个键**。值分别是毫秒 epoch（与 `push` 写底单同一个口径，
    // `reportDateEpoch` 是唯一来源）与**选项名**（不是选项 id —— 写名字时平台按选项表解析，
    // 而「选项存在」已经在上一步断言过了，所以不存在「写个错名字、平台新建一个选项」那条路）。
    const payloads = missing.map((shop) => ({ 日期: epoch, 店铺: shop }));
    const createdIds = await client.batchCreateRecords(payloads);
    if (createdIds.length !== payloads.length) {
      throw new Error(`建行返回的记录数对不上：期望 ${payloads.length}，收到 ${createdIds.length}`);
    }
    created = missing.map((shop, index) => ({ shop, recordId: createdIds[index] }));

    // **独立回读**：重新拉一次全表，用**同一个**匹配判据再算一遍。
    // 不信 `batchCreateRecords` 的返回值 —— 本仓的纪律是「写入成功必须由一次独立回读证明」。
    const after = planInquiryRowSkeleton({
      records: await client.listRecords(), reportDateEpoch: epoch, shops: targets, optionIdByShop,
    });
    if (after.duplicated.length) {
      throw new Error(`回读时出现同日同店多行：${after.duplicated.map((item) => `${item.shop}×${item.candidateCount}`).join(' / ')}`);
    }
    if (after.missing.length) {
      throw new Error(`回读时这些行仍然不在（写入没生效）：${after.missing.join(' / ')}`);
    }
    missing = [];
  }

  const status = missing.length === 0
    ? (created.length ? 'COMMITTED_AND_VERIFIED' : 'ALREADY_PRESENT')
    : 'DRY_RUN_READY';
  const receipt = { ...base, status, created, missing, planPath };
  const receiptPath = path.join(evidenceDir, 'ensure-inquiry-rows-receipt.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summarize({ status, created, receiptPath }), null, 2));
  return 0;
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().then((code) => { if (code) process.exitCode = code; }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
