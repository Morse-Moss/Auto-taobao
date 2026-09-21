#!/usr/bin/env node
// 尺寸写回编排入口 —— 把「周表 A/B → 确认 SKU 数据在 → 写回尺寸」固化成一条命令。
//
// 为什么必须有这么一条命令，而不是继续手工跑 fill-weekly-attribute-labels.mjs：
//   2026-09-16 的事故是**顺序错** —— 写回跑在 SKU 采集之前 4 分 40 秒（02:59:19Z vs 03:03:59Z），
//   那时数据还没进来，于是回落标题规则把 A/B 行的尺寸写成了『无注明』；
//   而「只填空不覆盖」让那个错值永久锁死：重跑 1417 行、写入 0 行、静默全绿。
//   手工跑**没有任何东西阻止同样的顺序再错一次**。这条命令把它堵住。
//
// 按顺序做四件事：
//   1. 定位竞品周表（默认最新一期）
//   2. 算出这期的 A/B 行，逐行判断「SKU明细里有没有它的尺寸数据」（判据在 core 里，有测试守着）
//   3. 有缺口 ⇒ **fail-closed（退出码 3）**：打印待采队列，**一个字都不写**
//   4. 无缺口 ⇒ 调 fill-weekly-attribute-labels.mjs（默认 dry-run；--apply 才真写）
//
// 为什么要拿周表算队列，而不是主表：主表是「最新状态」，周表是「当期快照」。
// 一个商品这周是 B、下周降级成 C 之后，主表队列就不含它了 —— 而周表那一期的 A/B 仍然要尺寸。
//
// 用法：
//   node runtime/run-weekly-attribute-writeback.mjs                 # 检查 + 写回演练（什么都不写）
//   node runtime/run-weekly-attribute-writeback.mjs --check-only    # 只做检查（第 2-3 步）
//   node runtime/run-weekly-attribute-writeback.mjs --recompute-ab  # 顺带算 A/B 行的 尺寸/适用空间 重算
//   node runtime/run-weekly-attribute-writeback.mjs --recompute-ab --apply --receipt <path>
//
// 退出码：0 = 检查通过；3 = 有 A/B 缺 SKU 数据（先采集）；1 = 其它错误。
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { activeProfileName, competitorBaseToken, envFilePath, tableId } from './feishu-targets.mjs';
import { extractProductId, summarizeAbReadiness } from './fill-weekly-attribute-labels-core.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = competitorBaseToken();
const WEEKLY_NAME = /^竞品周_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/u;
const WRITEBACK_SCRIPT = fileURLToPath(new URL('./fill-weekly-attribute-labels.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
  const options = {
    apply: false, recomputeAb: false, checkOnly: false, tableId: '', receipt: '',
    envFile: envFilePath() ?? 'E:/小红书/.env.local',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--recompute-ab') options.recomputeAb = true;
    else if (arg === '--check-only') options.checkOnly = true;
    else if (['--table-id', '--receipt', '--env-file'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.apply && options.checkOnly) throw new Error('--apply 与 --check-only 互斥');
  return options;
}

function readEnv(file) {
  const values = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['"]|['"]$/gu, '');
  }
  return values;
}

const text = (value) => {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(text).join(',').trim();
  if (typeof value === 'object') return text(value.text ?? value.value ?? value.name);
  return String(value).trim();
};

const options = parseArgs(process.argv.slice(2));
const env = readEnv(options.envFile);
const auth = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
}).then((response) => response.json());
if (auth.code !== 0) throw new Error(`auth failed: ${auth.code} ${auth.msg}`);
const headers = { Authorization: `Bearer ${auth.tenant_access_token}` };

async function api(path) {
  const response = await fetch(`${API_ROOT}${path}`, { headers }).then((r) => r.json());
  if (response.code !== 0) throw new Error(`${path} -> ${response.code} ${response.msg}`);
  return response.data;
}

async function listRecords(id) {
  const items = [];
  let pageToken;
  do {
    const query = new URLSearchParams({ page_size: '500' });
    if (pageToken) query.set('page_token', pageToken);
    const data = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${id}/records?${query}`);
    items.push(...(data.items ?? []));
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);
  return items;
}

async function resolveWeeklyTable() {
  const all = (await api(`/bitable/v1/apps/${APP_TOKEN}/tables?page_size=100`)).items ?? [];
  if (options.tableId) {
    const found = all.find((table) => table.table_id === options.tableId);
    if (!found) throw new Error(`table not found in the active base: ${options.tableId}`);
    return found;
  }
  const weekly = all.filter((table) => WEEKLY_NAME.test(table.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!weekly.length) throw new Error('no 竞品周_* table found in the active base');
  return weekly[weekly.length - 1];
}

const weeklyTable = await resolveWeeklyTable();
const skuTableId = tableId('skuDetail');
const [weeklyRecords, skuRecords] = await Promise.all([
  listRecords(weeklyTable.table_id),
  listRecords(skuTableId),
]);

// SKU明细里「哪些商品已经有尺寸数据」——有 `尺寸汇总` 或 `SKU尺寸` 才算有（空行不算）。
const skuProductsWithSize = new Set();
for (const record of skuRecords) {
  const fields = record.fields ?? {};
  const productId = text(fields['商品ID']) || extractProductId(text(fields['商品链接']));
  if (!productId) continue;
  const hasSize = [text(fields['SKU尺寸']), text(fields['尺寸汇总'])].some((value) => value && value !== '无注明');
  if (hasSize) skuProductsWithSize.add(productId);
}

const weeklyRows = weeklyRecords.map((record) => ({
  recordId: record.record_id,
  productId: extractProductId(text(record.fields?.['商品链接'])),
  klass: text(record.fields?.['竞品分类']),
  currentSize: text(record.fields?.['尺寸']),
  title: text(record.fields?.['商品标题']),
}));
const readiness = summarizeAbReadiness(weeklyRows, (id) => skuProductsWithSize.has(id));

console.log(`base profile = ${activeProfileName()} / ${APP_TOKEN}`);
console.log(`周表 = ${weeklyTable.name} (${weeklyTable.table_id})，共 ${weeklyRecords.length} 行`);
console.log(`SKU明细 = ${skuTableId}，${skuRecords.length} 行 / ${skuProductsWithSize.size} 个商品有尺寸数据`);
console.log('');
console.log(`本期 A/B 共 ${readiness.abCount} 行，其中 SKU 尺寸可取的 ${readiness.readyCount} 行，缺 ${readiness.missingCount} 行`);
for (const item of readiness.missing) {
  const row = weeklyRows.find((entry) => entry.recordId === item.recordId);
  console.log(`  缺 [${item.klass}] ${item.reason} 商品id=${item.productId || '(提不出)'} 当前尺寸="${row?.currentSize ?? ''}"`);
  console.log(`      标题：${(row?.title ?? '').slice(0, 60)}`);
}

const receipt = {
  version: 'weekly-attribute-writeback-run-v1',
  mode: options.apply ? 'APPLY' : (options.checkOnly ? 'CHECK_ONLY' : 'DRY_RUN'),
  at: new Date().toISOString(),
  profile: activeProfileName(),
  appToken: APP_TOKEN,
  weeklyTable: { name: weeklyTable.name, tableId: weeklyTable.table_id, rows: weeklyRecords.length },
  skuDetail: { tableId: skuTableId, records: skuRecords.length, productsWithSize: skuProductsWithSize.size },
  readiness: {
    abCount: readiness.abCount,
    readyCount: readiness.readyCount,
    missingCount: readiness.missingCount,
    missing: readiness.missing.map((item) => {
      const row = weeklyRows.find((entry) => entry.recordId === item.recordId);
      return { ...item, title: row?.title ?? '', currentSize: row?.currentSize ?? '' };
    }),
  },
  writeback: { invoked: false, exitCode: null },
  rule: '先检查数据在不在，再写回；有缺口 fail-closed 不写（退出码 3）。缺口队列按「周表当期 A/B」算，不按主表最新状态算。',
};

const writeReceipt = () => {
  if (!options.receipt) return;
  mkdirSync(dirname(options.receipt), { recursive: true });
  writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(`receipt -> ${options.receipt}`);
};

if (readiness.missingCount > 0) {
  console.log('');
  console.log('=== 顺序闸门：有 A/B 缺 SKU 数据，本次不写 ===');
  console.log('先按上面列出的商品 id 去小旺神采集 SKU（技能 xws-sku-collection），再重跑本命令。');
  console.log('不要绕过这一步：写回在数据缺失时会回落标题规则把『无注明』写进去，');
  console.log('而「只填空不覆盖」会让那个错值永久锁死（2026-09-16 就是这么错的）。');
  console.log('采集端队列也可用 `node runtime/summarize-xws-sku-queue.mjs` 复核（那边读主表最新状态）。');
  writeReceipt();
  process.exitCode = 3;
} else if (options.checkOnly) {
  console.log('');
  console.log('检查通过：本期 A/B 的尺寸数据都已就绪（--check-only，未调写回）。');
  writeReceipt();
} else {
  const args = [WRITEBACK_SCRIPT, '--table-id', weeklyTable.table_id];
  if (options.recomputeAb) args.push('--recompute-ab');
  if (options.apply) args.push('--apply', '--confirm-app-token', APP_TOKEN);
  if (options.receipt) args.push('--receipt', options.receipt.replace(/\.json$/u, '.writeback.json'));
  console.log('');
  console.log(`检查通过，调写回：${options.apply ? '真写' : '演练（dry-run）'}${options.recomputeAb ? ' + A/B 重算' : ''}`);
  const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, stdio: 'inherit' });
  receipt.writeback = { invoked: true, exitCode: result.status };
  if (result.status !== 0) {
    writeReceipt();
    console.log('');
    console.log(`写回脚本退出码 ${result.status} —— 上面有它的输出。`);
    process.exitCode = result.status ?? 1;
  } else {
    writeReceipt();
    console.log('');
    console.log('编排完成。');
  }
}
