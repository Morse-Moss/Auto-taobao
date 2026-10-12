// 只读：各 profile 的 Cookies 库里还剩哪些 taobao 会话标记（只读 name/host/过期/是否持久，不读值）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const PROFILES = [
  ['网林天猫', 'D:/Retire/edge-profiles/wanglin-flagship'],
  ['里可林淘宝', 'D:/Retire/edge-profiles/likelin-home'],
  ['盖文淘宝', 'D:/Retire/edge-profiles/suixin-custom'],
  ['盖文天猫', 'D:/Retire/edge-profiles/gaiwen-flagship'],
  ['科塔淘宝', 'D:/Retire/edge-profiles/shop-j873522735'],
  ['商家浏览器', 'D:/Retire/edge-daily-report-profile'],
];
// 登录态相关键（只判存在与过期，不看值）
const KEYS = ['unb', 'sn', '_tb_token_', 'cookie2', 'sgcookie', 'cancelledSubSites', 'lgc', 'tracknick'];

const chromeEpoch = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n / 1000 - 11644473600000;
  return ms > 0 ? new Date(ms).toISOString() : null;
};

for (const [label, dir] of PROFILES) {
  const file = `${dir}/Default/Network/Cookies`;
  if (!fs.existsSync(file)) { console.log(`== ${label}：没有 Cookies 库`); continue; }
  let db, source = file, note = '原库';
  try { db = new DatabaseSync(file, { readOnly: true }); } catch {
    source = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ck-')), 'Cookies');
    fs.copyFileSync(file, source); db = new DatabaseSync(source, { readOnly: true }); note = '复制件';
  }
  const cols = db.prepare('PRAGMA table_info(cookies)').all().map((c) => c.name);
  const q = (sql) => { try { return db.prepare(sql).all(); } catch (e) { return [{ err: e.message }]; } };
  const total = q("SELECT count(*) AS n FROM cookies WHERE host_key LIKE '%taobao%' OR host_key LIKE '%tmall%' OR host_key LIKE '%alimama%'")[0];
  const rows = q(`SELECT host_key, name, is_persistent, has_expires, CAST(expires_utc AS TEXT) AS exp FROM cookies
                  WHERE name IN (${KEYS.map((k) => `'${k}'`).join(',')}) AND (host_key LIKE '%taobao%' OR host_key LIKE '%tmall%' OR host_key LIKE '%alimama%')`);
  db.close();
  console.log(`== ${label}（${note}）taobao/tmall/alimama cookie 共 ${total?.n ?? total?.err} 条`);
  for (const r of rows) {
    if (r.err) { console.log('   查询失败:', r.err); break; }
    console.log(`   ${r.name.padEnd(18)} ${r.host_key.padEnd(24)} 持久=${r.is_persistent} 有过期=${r.has_expires} 到期=${chromeEpoch(r.exp)}`);
  }
}
