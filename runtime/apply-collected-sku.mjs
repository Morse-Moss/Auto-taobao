// 把自采 SKU 写进竞品 base 的 SKU明细（2026-10-26）。
//
// 为什么不走 apply-xws-sku-manifest：那条链的入场券是小旺神的四件套证据
// （payload + payloadSha256 + topology + capture receipt），自采数据拿不出来。
// 硬凑等于伪造证据链；而且它的 assertItem 要求 适用空间 必须非空，
// 而契约里「需人工核验」的行本来就允许 适用空间 为空（见 SKU明细 的
// 空间判定状态 闭集），照那条路走会把 191 行合法数据判成非法。
// 所以这里单独一条写入链，但**字段装配与空间判定全部复用**
// taobao-sku-dimension-core → competitor-v2-core，一处不重写。
//
// 三条纪律：
//   1) 默认只出计划，不写。`--commit --confirm-record-count N` 才真写。
//   2) **绝不覆盖已有行**。唯一键已存在就跳过（不论内容是否一致），
//      差异单独计数并在计划里给出示例，交给人判断，不自动改写别人的数据。
//   3) 写完必须独立回读校验：按唯一键重新查一遍，缺一条就算失败。

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CompetitorV2FeishuClient } from '../skills/xws-to-feishu-base/scripts/import-competitor-v2.mjs';
import { activeProfileName, competitorBaseToken, envFilePath, tableId } from './feishu-targets.mjs';
import {
  assertApprovedSpaces,
  buildItemRows,
  collectSkuItems,
  summarizeItem,
} from './taobao-sku-dimension-core.mjs';

const BATCH_LIMIT = 400;          // Feishu batch_create 上限 500，留余量
const RELATION_FIELDS = new Set(['所属竞品']);
const MULTI_FIELDS = new Set(['待补数据项']);

function parseEnv(textValue) {
  const out = {};
  for (const line of String(textValue).split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at < 0) continue;
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return out;
}

// 飞书读回来的字段形状与写入时不一样：关系字段回来是 [{record_ids:[...]}]，
// 多选是 ['a','b']，单选是字符串。比较前统一成可比的形状，否则会把
// 「内容一样但形状不同」误判成差异，进而把已有行当成冲突。
export function normalizeField(name, value) {
  // 空串与缺失必须归一：写 '' 进飞书会被存成 null，读回来是 null。
  // 不归一的话，每一条「本来就是空」的行都会被判成「内容不同」——
  // 2026-10-26 实测因此虚报了 244 行差异（都是 SKU尺寸 为空的行）。
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (RELATION_FIELDS.has(name)) {
    if (Array.isArray(value)) {
      if (value.every((item) => typeof item === 'string')) return value;
      return value.flatMap((item) => item?.record_ids ?? []).map(String);
    }
    return [String(value)];
  }
  if (MULTI_FIELDS.has(name)) {
    if (Array.isArray(value)) return value.map((item) => String(item?.text ?? item)).sort();
    return [String(value)];
  }
  if (Array.isArray(value)) return value.map((item) => String(item?.text ?? item));
  if (typeof value === 'object') {
    // URL 字段读回来是 { link, text }，其中 text 是显示文案而不是地址。
    // 取 text 会让「链接没变」被判成「链接变了」。
    if (value.link != null) return String(value.link);
    return String(value.text ?? value.value ?? '');
  }
  return String(value);
}

export function fieldsEqual(name, left, right) {
  return JSON.stringify(normalizeField(name, left)) === JSON.stringify(normalizeField(name, right));
}

// 把计划拆成写入批次。只为可测与可复算，不含网络。
export function buildPlan({ itemRows, existingByKey }) {
  const details = [];
  const toCreate = [];
  for (const { source, rows } of itemRows) {
    for (const row of rows) {
      const key = row.SKU唯一键;
      const existing = existingByKey.get(key);
      if (!existing) {
        toCreate.push(row);
        details.push({ key, action: 'toCreate', itemId: source.itemId });
        continue;
      }
      // 已存在：一律跳过。差异只记账不改写。
      const differs = Object.keys(row).filter((name) => !fieldsEqual(name, existing.fields?.[name], row[name]));
      details.push({
        key,
        action: differs.length ? 'existingKeptDiffers' : 'alreadyPresent',
        itemId: source.itemId,
        recordId: existing.recordId,
        differs,
      });
    }
  }
  const count = (action) => details.filter((item) => item.action === action).length;
  return {
    items: details,
    toCreate,
    summary: {
      totalRows: details.length,
      toCreate: count('toCreate'),
      alreadyPresent: count('alreadyPresent'),
      existingKeptDiffers: count('existingKeptDiffers'),
      itemCount: itemRows.length,
      // 写入前置条件：至少一行要建，且没有同键重复（同键重复在去重阶段就该消掉）。
      writeReady: toCreate.length > 0 && new Set(toCreate.map((row) => row.SKU唯一键)).size === toCreate.length,
    },
  };
}

export function chunk(rows, size = BATCH_LIMIT) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function parseArgs(argv) {
  const options = {
    envFile: resolve(envFilePath(activeProfileName())),
    skuFiles: [],
    outPlan: '',
    commit: false,
    repairClass: false,
    confirmRecordCount: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--sku') { options.skuFiles.push(argv[i + 1]); i += 1; continue; }
    if (flag === '--env-file') { options.envFile = argv[i + 1]; i += 1; continue; }
    if (flag === '--out-plan') { options.outPlan = argv[i + 1]; i += 1; continue; }
    if (flag === '--commit') { options.commit = true; continue; }
    if (flag === '--repair-class') { options.repairClass = true; continue; }
    if (flag === '--confirm-record-count') { options.confirmRecordCount = Number(argv[i + 1]); i += 1; continue; }
    throw new Error(`未知参数：${flag}`);
  }
  if (!options.skuFiles.length) throw new Error('至少给一个 --sku <csv>');
  if (options.commit) {
    if (!Number.isInteger(options.confirmRecordCount) || options.confirmRecordCount <= 0) {
      throw new Error('--commit 必须配 --confirm-record-count N，N 与本次动作的行数一致');
    }
  }
  return options;
}

// 飞书 URL 字段读回来是 { link, text }，直接 String() 会得到 [object Object]，
// 结果就是「主表有链接」被判成「缺链接」而整批跳过。
function linkOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') return String(value.link ?? value.text ?? value.value ?? '').trim();
  return String(value).trim();
}

// 竞品分类 在主线是**公式字段**，API 返回 [{text:"无分类",type:"text"}]，不是字符串。
// 2026-10-26 踩过：直接 String() 把 1618 行的竞品分类写成了 "[object Object]"。
// 这里做三件事：展开数组、取 text、再拿闭集校验，任何一步不对就抛，不让脏值进库。
export function classOf(value) {
  const textOf = (item) => {
    if (item == null) return '';
    if (typeof item === 'string') return item.trim();
    if (typeof item === 'object') return String(item.text ?? item.value ?? '').trim();
    return String(item).trim();
  };
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('、');
  return textOf(value);
}

const APPROVED_CLASSES = new Set([
  'A-爆款竞品', 'B-高价值竞品', 'C-差异化竞品', 'D-价格/流量型竞品', '无分类', '不适用',
]);

export function assertApprovedClass(competitorClass, itemId = '') {
  const value = String(competitorClass ?? '').trim();
  if (!value) throw new Error(`竞品分类为空：${itemId}`);
  if (/object Object/u.test(value)) throw new Error(`竞品分类 取值失败（对象没展开）：${itemId}`);
  if (!APPROVED_CLASSES.has(value)) throw new Error(`竞品分类 越界：${value}（${itemId}）`);
  return value;
}

async function main(argv) {
  const options = parseArgs(argv);
  const profile = activeProfileName();
  const appToken = competitorBaseToken(profile);
  const mainTableId = tableId('competitorMain', profile);
  const skuTableId = tableId('skuDetail', profile);

  if (!existsSync(options.envFile)) throw new Error('飞书环境文件不存在');
  const env = parseEnv(readFileSync(options.envFile, 'utf8'));
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) throw new Error('飞书凭据缺失');

  const client = new CompetitorV2FeishuClient({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    appToken,
  });
  await client.authenticate();

  // 1) 自采数据
  const { items, dirtyAttrs } = collectSkuItems(options.skuFiles);
  console.log(`[写入] 自采 ${items.length} 个商品 / ${items.reduce((s, i) => s + i.skus.length, 0)} 个 SKU；脏行 ${dirtyAttrs}`);
  if (dirtyAttrs > 0) console.warn(`[写入] 有 ${dirtyAttrs} 行 属性JSON 解析失败，这些行会按「无属性」处理`);

  // 2) 主表：按 商品ID 找 recordId / 链接 / 竞品分类
  const mainRecords = await client.listRecords(mainTableId);
  const mainByProduct = new Map();
  for (const record of mainRecords) {
    const pid = String(record.fields?.商品ID ?? '').trim();
    if (!pid || mainByProduct.has(pid)) continue;
    mainByProduct.set(pid, {
      recordId: record.recordId,
      link: linkOf(record.fields?.商品链接),
      title: String(record.fields?.商品标题 ?? '').trim(),
      competitorClass: classOf(record.fields?.竞品分类),
    });
  }

  const itemRows = [];
  const skippedItems = [];
  for (const item of items) {
    const main = mainByProduct.get(item.itemId);
    if (!main || !main.recordId || !main.link || !main.competitorClass) {
      skippedItems.push({ itemId: item.itemId, reason: !main ? '主表无此商品' : '主表缺链接/竞品分类' });
      continue;
    }
    const source = {
      itemId: item.itemId,
      title: main.title || item.title,
      link: main.link,
      competitorClass: assertApprovedClass(main.competitorClass, item.itemId),
      mainRecordId: main.recordId,
    };
    const rows = assertApprovedSpaces(buildItemRows({ source, skus: item.skus }));
    itemRows.push({ source, rows, summary: summarizeItem({ item, rows }) });
  }

  // 3) SKU明细 现有行：唯一键索引（同键多条记冲突，不掩盖）
  const skuRecords = await client.listRecords(skuTableId);
  const existingByKey = new Map();
  let duplicateExistingKeys = 0;
  const counts = new Map();
  for (const record of skuRecords) {
    const key = String(record.fields?.SKU唯一键 ?? '').trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!existingByKey.has(key)) existingByKey.set(key, record);
  }
  for (const n of counts.values()) if (n > 1) duplicateExistingKeys += 1;

  // 4) 计划
  const plan = buildPlan({ itemRows, existingByKey });
  const itemSummaries = itemRows.map((entry) => entry.summary);
  const payload = {
    generatedAt: new Date().toISOString(),
    profile,
    appToken,
    mainTableId,
    skuTableId,
    sourceFiles: options.skuFiles,
    existingSkuRows: skuRecords.length,
    duplicateExistingKeys,
    skippedItems,
    statusCounts: itemSummaries.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {}),
    spaceCounts: itemSummaries.reduce((acc, item) => {
      for (const [space, n] of Object.entries(item.spaces)) acc[space] = (acc[space] || 0) + n;
      return acc;
    }, {}),
    reviewSkuCount: itemSummaries.reduce((sum, item) => sum + item.review, 0),
    items: itemSummaries,
    summary: { ...plan.summary, duplicateExistingKeys },
    // 差异样例只留 10 条：完整逐行明细不落盘（1618 行会把计划文件撑到无法阅读），
    // 但每行的 action 都可以由「自采 CSV + 目标表现状」确定性重算出来，
    // 重跑同一条命令得到的计数必须一致，这才是可复算的依据。
    diffSamples: plan.items.filter((item) => item.action === 'existingKeptDiffers').slice(0, 10),
  };
  const planJson = `${JSON.stringify(payload, null, 1)}\n`;
  if (options.outPlan) {
    mkdirSync(dirname(options.outPlan), { recursive: true });
    writeFileSync(options.outPlan, planJson, 'utf8');
    console.log(`[写入] 计划写出 ${options.outPlan}`);
  }

  console.log(`[写入] 现有 SKU明细 ${skuRecords.length} 行；重复唯一键 ${duplicateExistingKeys}`);
  console.log(`[写入] 计划：新建 ${plan.summary.toCreate} / 已存在同值 ${plan.summary.alreadyPresent} / 已存在但内容不同 ${plan.summary.existingKeptDiffers}`);
  console.log(`[写入] 跳过商品 ${skippedItems.length} 个 ${JSON.stringify(skippedItems.slice(0, 5))}`);
  console.log(`[写入] 商品状态 ${JSON.stringify(payload.statusCounts)}；空间 ${JSON.stringify(payload.spaceCounts)}；需人工核验 SKU ${payload.reviewSkuCount}`);

  // 修复模式：把 SKU明细 里 竞品分类 写错的行改回来。
  // 2026-10-26 用：公式字段返回数组，第一版 String() 把 1618 行写成 "[object Object]"。
  // 只改这一列，不动任何别的字段，改完独立回读。
  // 不带 --commit 时只报数不改，方便先看清范围。
  if (options.repairClass) {
    const expected = new Map(itemRows.map((entry) => [entry.source.itemId, entry.source.competitorClass]));
    const wrong = skuRecords
      .filter((record) => expected.has(String(record.fields?.商品ID ?? '').trim()))
      .map((record) => ({
        recordId: record.recordId,
        itemId: String(record.fields?.商品ID ?? '').trim(),
        current: String(record.fields?.竞品分类 ?? ''),
        target: expected.get(String(record.fields?.商品ID ?? '').trim()),
      }))
      .filter((record) => record.current !== record.target);

    console.log(`[修复] 需要改 竞品分类 的行：${wrong.length}（目标取值分布 ${JSON.stringify(wrong.reduce((acc, r) => {
      acc[r.target] = (acc[r.target] || 0) + 1;
      return acc;
    }, {}))}）`);
    if (!options.commit) {
      console.log('[修复] 未给 --commit，只报数，没有改任何记录。');
      return;
    }
    if (wrong.length !== options.confirmRecordCount) {
      throw new Error(`待修行数 ${wrong.length} 与 --confirm-record-count ${options.confirmRecordCount} 不一致`);
    }
    let updated = 0;
    for (const [index, batch] of chunk(wrong).entries()) {
      const data = await client.request(
        'POST',
        `/bitable/v1/apps/${appToken}/tables/${skuTableId}/records/batch_update`,
        { records: batch.map((record) => ({ record_id: record.recordId, fields: { 竞品分类: record.target } })) },
      );
      const ids = (data?.records ?? []).map((record) => String(record?.record_id ?? '').trim()).filter(Boolean);
      if (ids.length !== batch.length) throw new Error(`修复第 ${index + 1} 批期望 ${batch.length} 条，飞书只确认 ${ids.length} 条`);
      updated += ids.length;
      console.log(`[修复] 第 ${index + 1}/${Math.ceil(wrong.length / BATCH_LIMIT)} 批完成：${ids.length} 条`);
    }
    const after = await client.listRecords(skuTableId);
    const stillWrong = after
      .filter((record) => expected.has(String(record.fields?.商品ID ?? '').trim()))
      .filter((record) => String(record.fields?.竞品分类 ?? '') !== expected.get(String(record.fields?.商品ID ?? '').trim()));
    if (stillWrong.length) throw new Error(`修复后仍有 ${stillWrong.length} 行不正确`);
    const receipt = {
      generatedAt: new Date().toISOString(), action: 'repairCompetitorClass',
      profile, skuTableId, updated, remainingWrong: stillWrong.length, verified: true,
    };
    mkdirSync('evidence/collected-sku-2026-10-26', { recursive: true });
    writeFileSync('evidence/collected-sku-2026-10-26/repair-receipt.json', `${JSON.stringify(receipt, null, 1)}\n`, 'utf8');
    console.log(`[修复] 完成：改正 ${updated} 行，回读剩余错误 ${stillWrong.length}`);
    return;
  }

  if (!options.commit) {
    console.log('[写入] 未给 --commit，本次只出计划，没有写任何记录。');
    return;
  }
  if (duplicateExistingKeys > 0) throw new Error('目标表存在重复唯一键，先人工处理再写');
  if (plan.summary.toCreate !== options.confirmRecordCount) {
    throw new Error(`计划新建 ${plan.summary.toCreate} 行，与 --confirm-record-count ${options.confirmRecordCount} 不一致`);
  }
  if (!plan.summary.writeReady) throw new Error('计划未就绪（没有可建行或存在同键重复）');

  // 5) 分批写入
  const batches = chunk(plan.toCreate);
  const createdIds = [];
  for (const [index, batch] of batches.entries()) {
    const data = await client.request(
      'POST',
      `/bitable/v1/apps/${appToken}/tables/${skuTableId}/records/batch_create`,
      { records: batch.map((row) => ({ fields: row })) },
    );
    const ids = (data?.records ?? []).map((record) => String(record?.record_id ?? '').trim()).filter(Boolean);
    if (ids.length !== batch.length) {
      throw new Error(`第 ${index + 1} 批期望 ${batch.length} 条，飞书只确认 ${ids.length} 条`);
    }
    createdIds.push(...ids);
    console.log(`[写入] 第 ${index + 1}/${batches.length} 批完成：${ids.length} 条`);
  }

  // 6) 独立回读校验：按唯一键重新查一遍
  const verifyRecords = await client.listRecords(skuTableId);
  const presentKeys = new Set(verifyRecords
    .map((record) => String(record.fields?.SKU唯一键 ?? '').trim())
    .filter(Boolean));
  const missing = plan.toCreate.map((row) => row.SKU唯一键).filter((key) => !presentKeys.has(key));
  if (missing.length) throw new Error(`回读校验失败，缺 ${missing.length} 条，例如 ${missing.slice(0, 3).join(', ')}`);

  const receipt = {
    generatedAt: new Date().toISOString(),
    profile,
    appToken,
    skuTableId,
    requested: plan.summary.toCreate,
    created: createdIds.length,
    skippedExisting: plan.summary.alreadyPresent + plan.summary.existingKeptDiffers,
    batches: batches.length,
    readbackTotal: verifyRecords.length,
    readbackMissing: missing.length,
    planSha256: createHash('sha256').update(planJson, 'utf8').digest('hex'),
    verified: true,
  };
  const receiptPath = `evidence/collected-sku-2026-10-26/receipt.json`;
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 1)}\n`, 'utf8');
  console.log(`[写入] 完成：新建 ${receipt.created} 条，回读 ${receipt.readbackTotal} 行，缺失 ${receipt.readbackMissing}；回执 ${receiptPath}`);
}

const invokedDirectly = Boolean(process.argv[1])
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[写入] 失败：${error?.stack || error?.message || error}`);
    process.exitCode = 1;
  });
}
