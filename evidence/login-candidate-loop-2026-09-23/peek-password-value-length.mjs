// 只读复核（2026-09-23）：`logins.password_value` 到底有多长。
//
// 上一步（peek-crypt-prefix.mjs）报出「密文 3 字节」，而合法的密文最短是
// 3（`v10` 前缀）+ 12（nonce）+ 0 + 16（GCM tag）= 31 字节。
// 3 字节意味着这一列里**一个字节的密文都没有**。这个结论太重，不能只靠 SQL 侧的
// `length()`（它对 TEXT/BLOB 的口径不同：TEXT 数字符、BLOB 数字节，而列的声明类型
// 与存储类型在 SQLite 里可以是两回事）—— 所以这里三路并取：
//   ① SQL 侧：typeof / length / length(hex(...))（hex 长度 = 字节数 × 2，与类型无关）
//   ② JS 侧：把值取回来，量它自己的 byteLength（Uint8Array 还是 string，都能量）
//   ③ 表结构：`logins` 的声明类型，以及这个库里还有没有别的表在存密码
// 只读前若干字节的十六进制与长度，**绝不还原明文**。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PROFILES = [
  ['盖文天猫', 'D:/Retire/edge-profiles/gaiwen-flagship'],
  ['商家浏览器', 'D:/Retire/edge-daily-report-profile'],
];

function openLoginData(file) {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    db.prepare('SELECT count(*) AS n FROM logins').get();
    return { db, note: '原库' };
  } catch {
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pvlen-')), 'Login Data');
    fs.copyFileSync(file, copy);
    return { db: new DatabaseSync(copy, { readOnly: true }), note: '复制件（原库被浏览器锁着）' };
  }
}

const size = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') return `string/${Buffer.byteLength(v, 'binary') || v.length} 字节`;
  if (v instanceof Uint8Array) return `Uint8Array/${v.byteLength} 字节`;
  return `${typeof v}/${String(v).length}`;
};

for (const [name, dir] of PROFILES) {
  const file = `${dir}/Default/Login Data`;
  if (!fs.existsSync(file)) continue;
  const { db, note } = openLoginData(file);
  console.log(`\n===== ${name}（${note}）=====`);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  console.log(`表：${tables.join(', ')}`);

  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='logins'").get()?.sql ?? '(没有 logins 的 DDL)';
  const decl = /password_value\s+([A-Za-z]+)/u.exec(ddl);
  console.log(`logins 里 password_value 的声明类型：${decl ? decl[1] : '(未匹配)'}`);

  const rows = db.prepare('SELECT username_value, signon_realm, password_value, password_type,'
    + ' typeof(password_value) AS t, length(password_value) AS lc, length(hex(password_value)) AS lh,'
    + ' hex(substr(password_value, 1, 8)) AS head8 FROM logins').all();
  for (const row of rows) {
    console.log(`\n  账号=${JSON.stringify(String(row.username_value))}  realm=${row.signon_realm}`);
    console.log(`    SQL 侧：typeof=${row.t}  length=${row.lc}  length(hex)=${row.lh}（⇒ 字节数 ${Number(row.lh) / 2}）  前 8 字节 hex=${row.head8}`);
    console.log(`    JS  侧：${size(row.password_value)}   password_type=${row.password_type}`);
  }

  // 这个库里还有没有别的表在存密码（换张表继续存 = 「新库路径」那条 pref 的形态）
  const extra = [];
  for (const table of tables) {
    if (table.startsWith('sqlite_')) continue;
    const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((c) => c.name);
    const hit = cols.filter((c) => /password|secret|cipher/u.test(c));
    if (hit.length > 0) extra.push(`${table}(${cols.length} 列；疑似列：${hit.join(',')})`);
  }
  console.log(`\n  其它疑似存放密码的表：${extra.length ? extra.join(' | ') : '无'}`);
  db.close();
}
