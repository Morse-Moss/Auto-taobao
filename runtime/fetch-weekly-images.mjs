#!/usr/bin/env node
// 下载周报 CSV 里每行的商品主图，落到本地目录供 build-weekly-xlsx.py 嵌进 xlsx。
//
// 为什么单独一步而不是让 Python 在嵌图时顺手下载：
//   1. 下载要并发+重试+超时，Python 那边串行会跑到 10 分钟以上
//   2. 下载失败是可容忍的（记进 manifest），不该把 1384 行 xlsx 的生成一起拖死
//   3. 分两步就能「下载一次、反复调试嵌图」，不用每次重下
//
// 落盘约定（build-weekly-xlsx.py 依赖这个）：<item_id>.img
//   - 不按 URL 猜扩展名：CDN 上 .jpg 实际回 webp 的情况存在，扩展名一错后面 PIL 就要靠猜
//     PIL 是按字节嗅探格式的，扩展名写什么都不影响，所以统一用 .img 消掉这个不确定
//   - 先写 .tmp-<item_id> 再 rename：rename 在同一分区是原子的，
//     中断时目录里绝不会出现「名字对但只有半张图」的文件——那种文件最坑，看起来有图其实坏图
//   - 已存在就跳过，所以重跑天然是续传
//
// 用法：
//   node runtime/fetch-weekly-images.mjs --csv <csv> --out <dir> [--concurrency 6] [--limit N]

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseCsv } from './taobao-search-core.mjs';

const DEFAULT_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

function parseArgs(argv) {
  const args = { concurrency: DEFAULT_CONCURRENCY, limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${key} 缺少取值`);
      i += 1;
      return value;
    };
    if (key === '--csv') args.csv = next();
    else if (key === '--out') args.out = next();
    else if (key === '--concurrency') args.concurrency = Number(next());
    else if (key === '--limit') args.limit = Number(next());
    else throw new Error(`未知参数：${key}`);
  }
  if (!args.csv) throw new Error('--csv 必填');
  if (!args.out) throw new Error('--out 必填');
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error('--concurrency 必须是正整数');
  return args;
}

function itemIdOf(link) {
  const index = String(link ?? '').indexOf('id=');
  if (index < 0) return '';
  const tail = String(link).slice(index + 3);
  const match = /^\d+/u.exec(tail);
  return match ? match[0] : '';
}

// 同一张图在 CDN 上有多个规格后缀（_.webp / _.400x400.jpg 等），
// 保留原始 URL 不做改写——实测原图 120-560KB、150-275ms，没必要为了省流量去动它。
function normalizeUrl(url) {
  const text = String(url ?? '').trim();
  if (!text) return '';
  if (text.startsWith('//')) return `https:${text}`;
  return text;
}

async function downloadOnce(url, destination) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024) throw new Error(`响应过小（${buffer.length}B），不像图片`);
  await fsp.writeFile(destination, buffer);
  return buffer.length;
}

async function downloadWithRetry(url, destination, tempPath) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const bytes = await downloadOnce(url, tempPath);
      await fsp.rename(tempPath, destination); // 原子替换，不留半张图
      return { ok: true, bytes, attempt };
    } catch (error) {
      lastError = error;
      // 临时文件留在盘上会占空间且下次 rename 会覆盖它，主动清掉
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
  }
  return { ok: false, error: String(lastError?.message ?? lastError) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const csvPath = path.resolve(args.csv);
  const outDir = path.resolve(args.out);
  await fsp.mkdir(outDir, { recursive: true });

  const table = parseCsv(await fsp.readFile(csvPath, 'utf8'));
  if (table.length < 2) throw new Error(`CSV 没有数据行：${csvPath}`);
  const headers = table[0];
  const imageIndex = headers.indexOf('商品图片');
  const linkIndex = headers.indexOf('商品链接');
  if (imageIndex < 0 || linkIndex < 0) throw new Error('CSV 缺少「商品图片」或「商品链接」列');

  const tasks = [];
  const invalid = [];
  for (let i = 1; i < table.length; i += 1) {
    const row = table[i];
    if (!row.some((cell) => cell.trim())) continue;
    const itemId = itemIdOf(row[linkIndex]);
    const url = normalizeUrl(row[imageIndex]);
    if (!itemId) { invalid.push({ row: i + 1, reason: 'no_item_id' }); continue; }
    if (!url) { invalid.push({ row: i + 1, itemId, reason: 'no_image_url' }); continue; }
    tasks.push({ itemId, url, row: i + 1 });
  }

  const limited = args.limit > 0 ? tasks.slice(0, args.limit) : tasks;
  const unique = new Map();
  for (const task of limited) if (!unique.has(task.itemId)) unique.set(task.itemId, task);

  const results = { total: tasks.length, considered: unique.size, downloaded: 0, skipped: 0, failed: [] };
  const queue = [...unique.values()];
  let cursor = 0;
  const startedAt = Date.now();

  const worker = async () => {
    while (cursor < queue.length) {
      const task = queue[cursor];
      cursor += 1;
      const destination = path.join(outDir, `${task.itemId}.img`);
      const tempPath = path.join(outDir, `.tmp-${task.itemId}`);
      if (fs.existsSync(destination)) { results.skipped += 1; continue; }
      const outcome = await downloadWithRetry(task.url, destination, tempPath);
      if (outcome.ok) results.downloaded += 1;
      else results.failed.push({ itemId: task.itemId, row: task.row, url: task.url, error: outcome.error });
      const done = results.downloaded + results.skipped + results.failed.length;
      if (done % 100 === 0 || done === queue.length) {
        process.stderr.write(`[fetch] ${done}/${queue.length} 下载 ${results.downloaded} 跳过 ${results.skipped} 失败 ${results.failed.length}\n`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(args.concurrency, queue.length) }, worker));

  results.elapsedMs = Date.now() - startedAt;
  results.outDir = outDir;
  results.invalid = invalid.slice(0, 50);
  results.ok = results.failed.length === 0;
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  process.exitCode = results.failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exitCode = 2;
});
