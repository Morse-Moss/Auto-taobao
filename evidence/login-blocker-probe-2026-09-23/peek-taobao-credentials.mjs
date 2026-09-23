// 只读：某个浏览器 profile 的密码库里，**淘宝相关的凭据分别是哪家店的账号**。
//
// 为什么必须查这一步（不是好奇心）：自动登录靠浏览器自己的填充，而 Chromium 的填充判据是
// 「保存凭据的 origin_url 的 origin == 当前登录页的 origin」—— **只比 origin、不比路径**。
// 于是「同一个 origin 下有几条凭据」这件事直接决定了两件事：
//   ① 能不能填上（一条同 origin 的都没有 ⇒ 填不上，脚本会判 NO_SAVED_CREDENTIAL）；
//   ② 填的**是谁**（同 origin 有多条 ⇒ 浏览器自己挑一条，而它挑错了不会报任何错，
//      结果是商家浏览器被登成**另一家店**，之后采集的每个数字都属于那家店）。
// ②比①贵得多，所以动手自动登录之前，先把账号名（不是密码）读出来。
//
// 只读 `username_value`，**绝不读也绝不打印 `password_value`**。
// 用法：node peek-taobao-credentials.mjs [profile路径，默认商家浏览器]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PROFILE = (process.argv[2] ?? 'D:/Retire/edge-daily-report-profile').replaceAll('\\', '/');
const TARGET_ORIGIN = new URL('https://login.taobao.com/havanaone/login/login.htm?bizName=taobao').origin;

const file = `${PROFILE}/Default/Login Data`;
if (!fs.existsSync(file)) {
  console.log(`profile=${PROFILE}`);
  console.log('（这个 profile 没有 Login Data —— 从没存过任何密码）');
  process.exit(0);
}

let db = null;
let source = file;
let note = '原库直接打开';
try {
  db = new DatabaseSync(file, { readOnly: true });
  db.prepare('SELECT count(*) AS n FROM logins').get();
} catch {
  try { db?.close(); } catch { /* 忽略 */ }
  source = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'login-user-')), 'Login Data');
  fs.copyFileSync(file, source);
  db = new DatabaseSync(source, { readOnly: true });
  note = '原库被运行中的浏览器锁着，读的复制件';
}

const rows = db.prepare(
  'SELECT origin_url, username_value, times_used FROM logins WHERE origin_url LIKE ?',
).all('%login.taobao.com%');
db.close();

console.log(`profile=${PROFILE}`);
console.log(`（只读账号名，不读密码；${note}）`);
console.log(`脚本打开的登录页 origin=${TARGET_ORIGIN}`);
if (rows.length === 0) {
  console.log('  没有淘宝相关凭据');
}
// 同 origin 的条数就是「能不能填、会不会填错」的全部依据 —— 顺手算一下，别让人自己数。
const sameOrigin = rows.filter((r) => { try { return new URL(String(r.origin_url)).origin === TARGET_ORIGIN; } catch { return false; } });
for (const r of rows) {
  const origin = String(r.origin_url);
  let same = false;
  try { same = new URL(origin).origin === TARGET_ORIGIN; } catch { same = false; }
  console.log(`  origin=${origin}`);
  console.log(`      账号=${JSON.stringify(String(r.username_value))}  用过=${r.times_used}  ${same ? '✅ 与登录页同 origin（会被填）' : '❌ origin 不同（填不上）'}`);
}
console.log(`  ⇒ 同 origin 的凭据 ${sameOrigin.length} 条：`
  + (sameOrigin.length === 0 ? '一条都没有 ⇒ 自动登录必然判 NO_SAVED_CREDENTIAL（要人工登一次并保存密码）'
    : sameOrigin.length === 1 ? '恰好一条 ⇒ 自动登录能填、且填的一定是它'
      : `${sameOrigin.length} 条 ⇒ 浏览器自己挑一条，**有可能登成别人**（这是必须先处理的）`));
