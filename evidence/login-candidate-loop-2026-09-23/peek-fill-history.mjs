// 只读：六个 profile 的淘宝凭据「最后一次被填充」是什么时候。
//
// 为什么问这个（2026-09-23）：真机跑完发现，**开在凭据自己的 origin 上浏览器也不填**
// （见同目录 `autofill-why.txt`），于是「origin 不同」这条解释被证伪。接下来必须分清两件完全不同的事：
//   ① 只有盖文天猫那一条凭据是死的（人再登一次、保存一次就修好）；
//   ② **密码填充在这台机器上整体坏了**（那五家店全是「会话一过期就要人」）。
// 两者对用户的意义差一个量级，而 `logins.times_used` / `logins.date_last_filled` 是现成的、免费的判据：
// 后者就是「浏览器最后一次把这条凭据填进页面」的时刻。
//
// 只读账号名与计数，**绝不读也绝不打印 password_value**。
// 原库被运行中的浏览器锁着时读复制件（六台都在跑）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PROFILES = [
  ['盖文天猫', 'D:/Retire/edge-profiles/gaiwen-flagship'],
  ['里可林淘宝', 'D:/Retire/edge-profiles/likelin-home'],
  ['网林天猫', 'D:/Retire/edge-profiles/wanglin-flagship'],
  ['科塔淘宝', 'D:/Retire/edge-profiles/shop-j873522735'],
  ['盖文淘宝', 'D:/Retire/edge-profiles/suixin-custom'],
  ['商家浏览器', 'D:/Retire/edge-daily-report-profile'],
];

// Chromium 的时间是「1601-01-01 起的微秒数」；换算到人看的本地时间要说清是哪一个口径。
const CHROME_EPOCH_MS = 11644473600000;
const stamp = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return `${JSON.stringify(v)}（从未）`;
  return `${new Date(n / 1000 - CHROME_EPOCH_MS).toISOString().replace('T', ' ').slice(0, 19)}Z`;
};

function openLoginData(file) {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    db.prepare('SELECT count(*) AS n FROM logins').get();
    return { db, note: '原库' };
  } catch {
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loginhist-')), 'Login Data');
    fs.copyFileSync(file, copy);
    return { db: new DatabaseSync(copy, { readOnly: true }), note: '复制件（原库被浏览器锁着）' };
  }
}

for (const [name, dir] of PROFILES) {
  console.log(`\n== ${name}  (${dir})`);
  let any = false;
  for (const [which, rel] of [['Login Data', '/Default/Login Data'], ['Login Data For Account', '/Default/Login Data For Account']]) {
    const file = dir + rel;
    if (!fs.existsSync(file)) continue;
    const { db, note } = openLoginData(file);
    const rows = db.prepare(
      'SELECT origin_url, signon_realm, username_value, times_used, date_last_filled, blacklisted_by_user'
      + ' FROM logins WHERE origin_url LIKE ? OR signon_realm LIKE ?',
    ).all('%taobao.com%', '%taobao.com%');
    db.close();
    console.log(`   [${which}] ${rows.length} 行（${note}）`);
    for (const row of rows) {
      any = true;
      console.log(`     realm=${row.signon_realm}`);
      console.log(`       账号=${JSON.stringify(String(row.username_value))}  用过=${row.times_used}  最后填充=${stamp(row.date_last_filled)}  拉黑=${row.blacklisted_by_user}`);
    }
  }
  if (!any) console.log('   （没有淘宝相关凭据）');
}
