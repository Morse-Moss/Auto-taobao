// 只读：六个 profile 的淘宝凭据里，Chromium 自己用来决定「要不要在页面加载时自动填充」的那些标志位。
//
// 为什么问这个（2026-09-23，接着 peek-fill-history.mjs）：
//   上一步拿到两条**互相矛盾**的事实：
//     · 商家浏览器里有 11 次 `times_used` ⇒ 这台机器的填充**确实工作过**；
//     · 盖文天猫那条凭据（realm 与选择器都对）却在页面上**一次都没被填**，连等 8 秒也不填。
//   ⇒ 「这台机器整体坏了」被削弱，问题大概率在**单条凭据的状态**上。
//   而 `logins` 表里恰好有一列就是干这个的：
//     · `skip_zero_click` —— Chromium 的「这条凭据不要在页面加载时零点击填充」标志。
//       它在用户**手动清掉被填进来的值**之后被置 1（=「别再这么干了」）。
//       历史实现里 FillForms 会跳过 skip_zero_click 的表单 ⇒ 这一列若为 1，就完整解释了「realm 对、选择器对、就是不填」。
//     · `date_last_used` / `date_password_modified` —— 配套时间；`date_last_filled` 已证实恒 0、不可用。
//   这三种状态（死的凭据 / 整体坏 / 零点击被关）修法完全不同，所以必须分开量。
//
// 只读账号名与标志位，**绝不读也绝不打印 password_value**。
// 原库被运行中的浏览器锁着时读复制件（六台都在跑）。
// 时间列一律 `CAST(... AS TEXT)`：Chromium 的微秒整数超出 JS number 安全范围，
// 直接选出来会抛 `RangeError: Value is too large to be represented as a JavaScript number`
// （2026-09-23 实测，见同目录 realm-gaiwen-tmall.txt 的踩坑记录）。
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

const CHROME_EPOCH_MS = 11644473600000;
const stamp = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return `${JSON.stringify(String(v))}（从未）`;
  return `${new Date(n / 1000 - CHROME_EPOCH_MS).toISOString().replace('T', ' ').slice(0, 19)}Z`;
};

function openLoginData(file) {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    db.prepare('SELECT count(*) AS n FROM logins').get();
    return { db, note: '原库' };
  } catch {
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loginflags-')), 'Login Data');
    fs.copyFileSync(file, copy);
    return { db: new DatabaseSync(copy, { readOnly: true }), note: '复制件（原库被浏览器锁着）' };
  }
}

// 这一份 SELECT 就是本探针的全部判据来源。时间列全部走 CAST(... AS TEXT)。
const SELECT = [
  'origin_url', 'signon_realm', 'username_value',
  'skip_zero_click', 'blacklisted_by_user', 'scheme', 'times_used',
  'CAST(date_created AS TEXT) AS date_created',
  'CAST(date_last_used AS TEXT) AS date_last_used',
  'CAST(date_last_filled AS TEXT) AS date_last_filled',
  'CAST(date_password_modified AS TEXT) AS date_password_modified',
  'actor_login_approved',
].join(', ');

const zeroClick = (v) => {
  const n = Number(v);
  if (n === 0) return '0（允许零点击填充）';
  if (n === 1) return '1（**禁止**零点击填充 ——「别再这么干了」）';
  return `${JSON.stringify(String(v))}（异常值）`;
};

let total = 0;
for (const [name, dir] of PROFILES) {
  console.log(`\n== ${name}  (${dir})`);
  let any = false;
  for (const which of ['Default/Login Data', 'Default/Login Data For Account']) {
    const file = `${dir}/${which}`;
    if (!fs.existsSync(file)) continue;
    const { db, note } = openLoginData(file);
    const rows = db.prepare(
      `SELECT ${SELECT} FROM logins WHERE origin_url LIKE ? OR signon_realm LIKE ?`,
    ).all('%taobao.com%', '%taobao.com%');
    db.close();
    console.log(`   [${which}] ${rows.length} 行（${note}）`);
    for (const row of rows) {
      any = true;
      total += 1;
      console.log(`     realm=${row.signon_realm}`);
      console.log(`       账号=${JSON.stringify(String(row.username_value))}`);
      console.log(`       skip_zero_click=${zeroClick(row.skip_zero_click)}`);
      console.log(`       拉黑=${row.blacklisted_by_user}  scheme=${row.scheme}  用过=${row.times_used}  actor_login_approved=${row.actor_login_approved}`);
      console.log(`       建于=${stamp(row.date_created)}`);
      console.log(`       最后使用=${stamp(row.date_last_used)}  改密=${stamp(row.date_password_modified)}  最后填充=${stamp(row.date_last_filled)}`);
    }
  }
  if (!any) console.log('   （没有淘宝相关凭据）');
}
console.log(`\n合计 ${total} 行淘宝凭据。`);
