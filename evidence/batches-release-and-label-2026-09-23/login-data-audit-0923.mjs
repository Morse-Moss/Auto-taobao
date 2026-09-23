// 只读审计：五家店铺 profile 的**磁盘密码库**里到底存了哪些凭据（**不读明文、不打印用户名与密码**）。
//
// 为什么需要它（用户 2026-09-23 原话「我这些店铺全部都手动登录过……为什么不能自动登录」）：
// 自动登录靠浏览器自己的密码管理器填充，而**填充是按 origin 匹配的** ——
// 有凭据 ≠ 会在你当前打开的那个登录页上填充。所以「密码库里存的是哪个 origin」才是判据。
//
// 只读：`Login Data` 以 readOnly 打开；只取 origin_url / 两列的长度 / times_used，不取任何密文。
// 大整数坑：`date_created` 这类 WebKit 时间戳超出 JS 安全整数，若选进结果集，node:sqlite 会直接抛
//   `Value is too large to be represented as a JavaScript number` —— 所以**别选时间列**。
//
// 用法：
//   node evidence/batches-release-and-label-2026-09-23/login-data-audit-0923.mjs
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const BASE = 'D:/Retire/edge-profiles';

for (const dir of fs.readdirSync(BASE)) {
  const file = `${BASE}/${dir}/Default/Login Data`;
  if (!fs.existsSync(file)) continue;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(
      'SELECT origin_url, length(username_value) AS ulen, length(password_value) AS plen, times_used FROM logins',
    ).all();
    console.log(`== ${dir}  凭据条数=${rows.length}`);
    for (const r of rows) {
      console.log(`   origin=${r.origin_url}  用户名长度=${r.ulen}  密文长度=${r.plen}  用过=${r.times_used}`);
    }
  } catch (error) {
    console.log(`== ${dir}  读失败：${String(error?.message ?? error).slice(0, 150)}`);
  } finally {
    try { db?.close(); } catch { /* 关不掉不影响结论 */ }
  }
}
