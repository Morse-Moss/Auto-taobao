// 只读：把某个 profile 里淘宝相关凭据的**匹配键**整行拉出来。
//
// 为什么需要它（2026-09-23 真机打脸之后）：上一版探针只读 `origin_url`，然后按
// 「保存凭据的 origin == 当前登录页的 origin 才能填」推出结论。真机跑完发现那条推断链断在第二环：
// **开在凭据自己的那个 origin 上（`havanalogin.taobao.com/mini_login.htm`），浏览器照样不填。**
// ⇒ 「origin 不同」不是这件事的成因，或者至少不是全部。而 Login Data 里真正决定
// 「这一页能不能填」的是 `signon_realm`（以及 `scheme`、`blacklisted_by_user`），
// 上一版探针把那几列全漏了 —— 也就是说，那个结论是**用一列数据推出了一个需要三列数据才能回答的问题**。
//
// 只读账号名，**绝不读也绝不打印 `password_value`**。
// 用法：node peek-login-realm.mjs [profile路径，默认盖文天猫那个]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PROFILE = (process.argv[2] ?? 'D:/Retire/edge-profiles/gaiwen-flagship').replaceAll('\\', '/');
const file = `${PROFILE}/Default/Login Data`;

console.log(`profile=${PROFILE}`);
if (!fs.existsSync(file)) {
  console.log('（这个 profile 没有 Login Data —— 从没存过任何密码）');
  process.exit(0);
}

let db = null;
let note = '原库直接打开';
try {
  db = new DatabaseSync(file, { readOnly: true });
  db.prepare('SELECT count(*) AS n FROM logins').get();
} catch {
  try { db?.close(); } catch { /* 忽略 */ }
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'realm-probe-')), 'Login Data');
  fs.copyFileSync(file, copy);
  db = new DatabaseSync(copy, { readOnly: true });
  note = '原库被运行中的浏览器锁着，读的复制件';
}

// 先看这张表到底有哪几列 —— 不假设 schema（上一个探针就是假设出来的）。
const cols = db.prepare('PRAGMA table_info(logins)').all().map((c) => c.name);
console.log(`（${note}；logins 表列名：${cols.join(', ')}）`);

const wanted = ['origin_url', 'signon_realm', 'scheme', 'username_value', 'username_element',
  'password_element', 'times_used', 'blacklisted_by_user', 'date_created'];
// 时间列要显式转成文本：Chromium 把它们存成**微秒级**整数（实测值 13434270020077694），
// 而 node:sqlite 默认按 JS number 读 ⇒ 直接抛 `RangeError: Value is too large`（本轮踩到）。
const asText = new Set(['date_created', 'date_last_used', 'date_password_modified', 'date_last_filled']);
const select = wanted
  .filter((c) => cols.includes(c))
  .map((c) => (asText.has(c) ? `CAST(${c} AS TEXT) AS ${c}` : c))
  .join(', ');
const rows = db.prepare(`SELECT ${select} FROM logins WHERE origin_url LIKE ? OR signon_realm LIKE ?`)
  .all('%taobao.com%', '%taobao.com%');
db.close();

console.log(`（只读账号名，不读密码；命中 ${rows.length} 行）`);
for (const row of rows) {
  console.log('  ── 一行凭据 ──');
  for (const key of wanted) {
    if (!(key in row)) continue;
    console.log(`    ${key} = ${JSON.stringify(row[key])}`);
  }
}
if (rows.length === 0) console.log('  没有淘宝相关凭据');
