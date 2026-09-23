// 只读：商家浏览器（D:/Retire/edge-daily-report-profile）的淘宝凭据**是哪家店的账号**。
//
// 为什么必须查这一步（不是好奇心）：那一台的密码库里躺着两条**同 origin、能被自动填**的
// 淘宝凭据。如果它们属于**别的店**，那么「让脚本去自动登录这一台」的结果不是失败，
// 而是**悄悄把商家浏览器登成另一家店** —— 之后采集出来的每一个数字都属于那家店，
// 而链上没有任何一步会发现这件事（页面能开、导出能成功、数字看起来都对）。
// 这种错比「登录失败」贵得多，所以动手之前先把账号名读出来。
//
// 只读 `username_value`，**绝不读也绝不打印 `password_value`**（脚本驱动的是浏览器自己的
// 填充，不接触明文口令）。同 origin 判据与 audit-login-data-all-profiles.mjs 一致。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PROFILE = 'D:/Retire/edge-daily-report-profile';
const TARGET_ORIGIN = new URL('https://login.taobao.com/havanaone/login/login.htm?bizName=taobao').origin;

const file = `${PROFILE}/Default/Login Data`;
let db = null;
let source = file;
try {
  db = new DatabaseSync(file, { readOnly: true });
  db.prepare('SELECT count(*) AS n FROM logins').get();
} catch {
  try { db?.close(); } catch { /* 忽略 */ }
  source = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'login-user-')), 'Login Data');
  fs.copyFileSync(file, source);
  db = new DatabaseSync(source, { readOnly: true });
}

const rows = db.prepare(
  'SELECT origin_url, username_value, times_used FROM logins WHERE origin_url LIKE ?',
).all('%login.taobao.com%');
db.close();

console.log(`profile=${PROFILE}`);
console.log(`（只读账号名；不读密码。原库${source === file ? '直接打开' : '被锁，读的复制件'}）`);
console.log(`目标 origin=${TARGET_ORIGIN}`);
for (const r of rows) {
  const origin = String(r.origin_url);
  let same = false;
  try { same = new URL(origin).origin === TARGET_ORIGIN; } catch { same = false; }
  console.log(`  origin=${origin}`);
  console.log(`      账号=${JSON.stringify(String(r.username_value))}  用过=${r.times_used}  ${same ? '✅ 能被自动填' : '❌ origin 不同'}`);
}
console.log(`（共 ${rows.length} 条淘宝相关凭据）`);
