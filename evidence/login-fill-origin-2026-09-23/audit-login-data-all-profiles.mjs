// 只读审计：**每个浏览器 profile 的磁盘密码库**里到底存了哪几条凭据、分别属于哪个 origin。
//
// 为什么需要它（用户 2026-09-23 原话「我看到都有保存登录信息，为什么你不直接登录？」）：
// 自动登录靠的是**浏览器自己的密码管理器**给表单做填充，而 Chromium 的填充判据是
// 「保存凭据的 origin_url == 当前登录页的 origin」。所以「密码库里有一条记录」**不等于**
// 「脚本打开的那个登录页会被填上」—— 判据是**逐条 origin 与目标页 origin 的比对**。
//
// 只读且不碰明文：只取 origin_url / 两列的长度 / times_used / blacklisted_by_user。
// 大整数坑（上次踩过）：`date_created` 这类 WebKit 时间戳超出 JS 安全整数，选进来 node:sqlite 直接抛
//   `Value is too large to be represented as a JavaScript number` ⇒ **不选时间列**。
// 浏览器正在跑时 `Login Data` 可能被锁 ⇒ 先试只读直开，失败再复制到临时目录读（复制不改原库）。
//
// 用法：
//   node evidence/login-fill-origin-2026-09-23/audit-login-data-all-profiles.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// 6 个「机器上真正在跑」的 profile：5 家店 + 商家浏览器（日报链）。
// 竞品链（买家号）与本次无关，不列。
const PROFILES = [
  ['里可林淘宝', 'D:/Retire/edge-profiles/likelin-home'],
  ['网林天猫', 'D:/Retire/edge-profiles/wanglin-flagship'],
  ['盖文淘宝', 'D:/Retire/edge-profiles/suixin-custom'],
  ['盖文天猫', 'D:/Retire/edge-profiles/gaiwen-flagship'],
  ['科塔淘宝', 'D:/Retire/edge-profiles/shop-j873522735'],
  ['商家浏览器', 'D:/Retire/edge-daily-report-profile'],
];

// 自动登录脚本固定打开的那一页（login-merchant-core.mjs 的 TAOBAO_LOGIN_URL）。
// 它决定了「什么样的 origin 能被填上」。
const TARGET = 'https://login.taobao.com/havanaone/login/login.htm?bizName=taobao';
const targetOrigin = new URL(TARGET).origin;
console.log(`自动登录脚本打开的登录页 origin = ${targetOrigin}`);
console.log('（Chromium 只在「保存凭据的 origin_url 与当前页 origin 相同」时才做填充）\n');

let schemaPrinted = false;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'login-data-'));
for (const [who, profile] of PROFILES) {
  const file = `${profile}/Default/Login Data`;
  console.log(`== ${who}  ${profile}`);
  if (!fs.existsSync(file)) { console.log('   没有 Login Data（这个 profile 从没存过任何密码）\n'); continue; }

  let db = null;
  let source = file;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.prepare('SELECT count(*) AS n FROM logins').get();
  } catch (error) {
    // 被运行中的浏览器锁住：复制一份再读（复制不改原库）。
    try { db?.close(); } catch { /* 忽略 */ }
    source = path.join(tmpRoot, `${path.basename(profile)}-Login Data`);
    try {
      fs.copyFileSync(file, source);
      db = new DatabaseSync(source, { readOnly: true });
      console.log(`   （原库被运行中的浏览器锁着，改读复制件：${source}）`);
    } catch (error2) {
      console.log(`   读不到：${String(error2?.message ?? error2).slice(0, 140)}\n`);
      continue;
    }
  }

  try {
    if (!schemaPrinted) {
      const cols = db.prepare('PRAGMA table_info(logins)').all().map((c) => c.name);
      console.log(`   logins 表的列：${cols.join(', ')}`);
      schemaPrinted = true;
    }
    const rows = db.prepare(
      'SELECT origin_url, length(username_value) AS ulen, length(password_value) AS plen,'
      + ' times_used, blacklisted_by_user FROM logins',
    ).all();
    if (rows.length === 0) { console.log('   logins 表是空的\n'); continue; }
    for (const r of rows) {
      const origin = String(r.origin_url);
      const pageOrigin = (() => { try { return new URL(origin).origin; } catch { return '(解析不了)'; } })();
      const match = pageOrigin === targetOrigin ? '✅ 与脚本打开的登录页同 origin（能被填）' : '❌ 不同 origin（脚本那一页填不上）';
      const banned = Number(r.blacklisted_by_user) === 1 ? '  ⚠️ 这个站点被设成「从不保存」' : '';
      console.log(`   origin=${origin}`);
      console.log(`      用户名长度=${r.ulen}  密文长度=${r.plen}  用过=${r.times_used}  ${match}${banned}`);
    }
  } catch (error) {
    console.log(`   读失败：${String(error?.message ?? error).slice(0, 140)}`);
  } finally {
    try { db?.close(); } catch { /* 关不掉不影响结论 */ }
  }
  console.log('');
}
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 临时目录留着也无害 */ }
