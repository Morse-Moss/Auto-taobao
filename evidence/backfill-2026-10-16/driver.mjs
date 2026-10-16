// 推广补数驱动（2026-10-16）：8 家 × 2026-10-08..15 的商品报表采集 + 逐日 dry-run 导入计划。
// 只采集与 dry-run，不 --apply（写入前要给用户看过计划）。
// 断点续跑：state.json 里已 done 的 (店, 日) 跳过；失败的记录原因，重启后只补失败的。
// 运行：node evidence/backfill-2026-10-16/driver.mjs   （在仓库根目录跑）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { collectingShopKeys, shopInstance } from '../../runtime/browser-ports.mjs';

const ROOT = 'D:/Retire/sycm-automation';
const EVID = path.join(ROOT, 'evidence', 'backfill-2026-10-16');
const STATE = path.join(EVID, 'state.json');
const LOG = path.join(EVID, 'driver.log');
const DATES = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'];
const DOWNLOAD_LIST = 'https://one.alimama.com/index.html#!/report/download-list';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  fs.appendFileSync(LOG, text);
  process.stdout.write(text);
}
function readState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } }
function writeState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }
const key = (shop, date) => `${shop}|${date}`;

function run(file, args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, file), ...args], { cwd: ROOT, stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] });
    let out = ''; let err = '';
    if (capture) { child.stdout.on('data', (x) => { out += x; }); child.stderr.on('data', (x) => { err += x; }); }
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    child.on('error', (error) => resolve({ code: -1, out, err: String(error.message) }));
  });
}
function lastJsonLine(text) {
  for (const line of String(text ?? '').split(/\r?\n/u).reverse()) {
    const t = line.trim();
    if (t.startsWith('{')) { try { const v = JSON.parse(t); if (v && v.file) return v; } catch { /* 继续找上一行 */ } }
  }
  return null;
}

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const shops = collectingShopKeys();
  const state = readState();
  log(`补数驱动启动：${shops.length} 店 × ${DATES.length} 日 = ${shops.length * DATES.length} 次采集；已 done ${Object.values(state).filter((v) => v.status === 'done').length} 次`);
  for (const shop of shops) {
    const todo = DATES.filter((d) => state[key(shop, d)]?.status !== 'done');
    if (todo.length === 0) { log(`== ${shop}：8 日已全部采集，跳过`); continue; }
    log(`== ${shop}：起实例`);
    const inst = shopInstance(shop);
    const started = await run('scripts/start-all.mjs', ['--only', shop, '--timeout', '60']);
    if (started.code !== 0) {
      for (const d of todo) state[key(shop, d)] = { status: 'blocked', error: `start-all exit ${started.code}` };
      writeState(state);
      log(`== ${shop}：起实例失败（exit ${started.code}），本店全部日期记 blocked，换下一家`);
      continue;
    }
    // 页签预热：**先数后开**。冷启动只有 label 页签才需要 /new；
    // 已保温的实例（起前:ready）本身就挂着阿里妈妈页签，再开一个就会凑成 2 个 ⇒ findPage fail-closed
    // （2026-10-16 网林天猫 8 连败就是这个形状）。多于 1 个时关掉多余的，只留 1 个。
    try {
      const targets = await (await fetch(`http://127.0.0.1:${inst.proxyPort}/targets`)).json();
      const alimama = targets.filter((t) => t.type === 'page' && String(t.url).includes('one.alimama.com'));
      if (alimama.length === 0) {
        await fetch(`http://127.0.0.1:${inst.proxyPort}/new?url=${encodeURIComponent(DOWNLOAD_LIST)}`);
        log(`== ${shop}：无阿里妈妈页签，已新开，等 8s 渲染`);
        await sleep(8000);
      } else if (alimama.length === 1) {
        log(`== ${shop}：已有阿里妈妈页签，复用不新开`);
      } else {
        for (const extra of alimama.slice(1)) {
          try { await fetch(`http://127.0.0.1:${inst.proxyPort}/close?target=${encodeURIComponent(extra.targetId)}`); } catch { /* 关不掉也让采集自己报 */ }
        }
        log(`== ${shop}：有 ${alimama.length} 个阿里妈妈页签，已关掉多余 ${alimama.length - 1} 个`);
        await sleep(1500);
      }
    } catch (error) {
      log(`== ${shop}：页签预处理失败 ${error.message}（继续试采，让采集脚本自己报）`);
    }
    let loginDead = false;
    for (const date of todo) {
      if (loginDead) { state[key(shop, date)] = { status: 'blocked', error: '同店身份/登录已失败，本店余下日期不再白跑' }; continue; }
      log(`-- ${shop} ${date}：采集中`);
      const r = await run('skills/sycm-promotion-data/scripts/collect-product-report.mjs', ['--shop', shop, '--date', date, '--log-dir', path.join(EVID, shop)], { capture: true });
      const j = lastJsonLine(r.out);
      if (r.code === 0 && j?.file) {
        state[key(shop, date)] = { status: 'done', file: j.file, task: j.task, bytes: j.bytes, at: new Date().toISOString() };
        log(`-- ${shop} ${date}：✓ ${j.file}（task=${j.task}）`);
      } else {
        const msg = (r.err || r.out || '').trim().split(/\r?\n/u).filter(Boolean).slice(-3).join(' | ').slice(0, 300);
        state[key(shop, date)] = { status: 'failed', error: `exit ${r.code}: ${msg}`, at: new Date().toISOString() };
        log(`-- ${shop} ${date}：✗ exit ${r.code} ${msg}`);
        if (/身份|登录|登录页|掉登录/u.test(msg)) { loginDead = true; log(`-- ${shop}：判到身份/登录类失败，本店余下日期记 blocked（人工闸门，不反复重试）`); }
      }
      writeState(state);
    }
    log(`== ${shop}：释放浏览器`);
    const released = await run('scripts/release-product-data-browsers.mjs', ['--shops', shop], { capture: true });
    const rj = lastJsonLine(released.out) ?? (() => { try { return JSON.parse(released.out); } catch { return null; } })();
    log(`== ${shop}：释放 exit ${released.code}${rj ? ` released=${rj.released}` : ''} ${(released.err || '').trim().slice(0, 200)}`);
  }
  // 采集齐的日子各自做一次 dry-run 导入计划（8 店一批，--date 只用于解析 base，全部同日 ⇒ 同 base）
  for (const date of DATES) {
    const items = shops.map((s) => state[key(s, date)]).filter((v) => v?.status === 'done');
    if (items.length === 0) { log(`[导入 dry-run] ${date}：无可导入文件，跳过`); continue; }
    const args = [];
    for (const shop of shops) { const v = state[key(shop, date)]; if (v?.status === 'done') args.push('--file', v.file, '--shop', shop); }
    args.push('--date', date, '--evidence', path.join(EVID, 'import-dryrun', date));
    log(`[导入 dry-run] ${date}：${items.length} 家`);
    const r = await run('skills/sycm-promotion-data/scripts/import-promotion-data.mjs', args, { capture: true });
    const rj = lastJsonLine(r.out) ?? (() => { try { return JSON.parse(r.out); } catch { return null; } })();
    if (r.code === 0 && rj) log(`[导入 dry-run] ${date}：plannedRows=${rj.plannedRows} duplicateRows=${rj.duplicateRows} existingRows=${rj.existingRows} observedDates=${JSON.stringify(rj.date)}`);
    else log(`[导入 dry-run] ${date}：✗ exit ${r.code} ${(r.err || r.out || '').trim().slice(-300)}`);
  }
  const done = Object.entries(state).filter(([, v]) => v.status === 'done').length;
  const failed = Object.entries(state).filter(([, v]) => v.status === 'failed');
  const blocked = Object.entries(state).filter(([, v]) => v.status === 'blocked');
  log(`补数驱动结束：done=${done} failed=${failed.length} blocked=${blocked.length}`);
  for (const [k, v] of failed) log(`  failed ${k}: ${v.error}`);
  for (const [k, v] of blocked) log(`  blocked ${k}: ${v.error}`);
}
main().catch((e) => { log(`驱动自身崩溃：${e?.stack ?? e}`); process.exitCode = 1; });
