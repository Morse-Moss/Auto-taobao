// 只读：各店铺 profile 的密码库里，"淘宝登录页 origin" 上有几条凭据、都是谁。
// 只读 username_value 与元数据；**绝不读也不打印 password_value（只打印长度是否为 0）**。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const PROFILES = [
  ['网林天猫（不认那家）', 'D:/Retire/edge-profiles/wanglin-flagship'],
  ['里可林淘宝（正常）', 'D:/Retire/edge-profiles/likelin-home'],
  ['盖文淘宝', 'D:/Retire/edge-profiles/suixin-custom'],
  ['盖文天猫', 'D:/Retire/edge-profiles/gaiwen-flagship'],
  ['科塔淘宝', 'D:/Retire/edge-profiles/shop-j873522735'],
  ['商家浏览器（日报）', 'D:/Retire/edge-daily-report-profile'],
];

// 候选表里的两个登录页 origin（LOGIN_URL_CANDIDATES）
const CANDIDATES = [
  new URL('https://login.taobao.com/havanaone/login/login.htm?bizName=taobao').origin,
  new URL('https://login.taobao.com/member/login.jhtml').origin,
];

const epochToIso = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  // Chromium 时间戳：微秒，自 1601-01-01 起
  const ms = v / 1000 - 11644473600000;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
};

const out = [];
for (const [label, dir] of PROFILES) {
  const file = `${dir}/Default/Login Data`;
  const entry = { label, dir, file, exists: fs.existsSync(file), note: null, rows: [] };
  if (!entry.exists) { out.push(entry); continue; }
  let db = null;
  let source = file;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.prepare('SELECT count(*) AS n FROM logins').get();
    entry.note = '原库直接打开（没有被浏览器占用）';
  } catch (e) {
    try { db?.close(); } catch { /* ignore */ }
    source = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'login-peek-')), 'Login Data');
    fs.copyFileSync(file, source);
    db = new DatabaseSync(source, { readOnly: true });
    entry.note = `原库被锁，读复制件（${e.code || e.message}）`;
  }
  const cols = db.prepare('PRAGMA table_info(logins)').all().map((c) => c.name);
  const has = (c) => cols.includes(c);
  const select = [
    'origin_url', 'username_value', 'times_used',
    has('blacklisted_by_user') ? 'blacklisted_by_user' : '0 AS blacklisted_by_user',
    // 时间列必须 CAST 成 TEXT —— node:sqlite 直接把微秒整数读成 JS number 会 ERR_OUT_OF_RANGE。
    has('date_created') ? 'CAST(date_created AS TEXT) AS date_created' : "'0' AS date_created",
    has('date_last_used') ? 'CAST(date_last_used AS TEXT) AS date_last_used' : "'0' AS date_last_used",
    has('password_value') ? 'length(password_value) AS pw_len' : '0 AS pw_len',
  ].join(', ');
  const rows = db.prepare(`SELECT ${select} FROM logins WHERE origin_url LIKE '%taobao%'`).all();
  db.close();
  entry.rows = rows.map((r) => {
    const origin = String(r.origin_url);
    let same = false;
    try { same = CANDIDATES.includes(new URL(origin).origin); } catch { same = false; }
    return {
      origin,
      username: String(r.username_value ?? ''),
      timesUsed: Number(r.times_used ?? 0),
      blacklisted: Number(r.blacklisted_by_user ?? 0) === 1,
      createdAt: epochToIso(r.date_created),
      lastUsedAt: epochToIso(r.date_last_used),
      passwordStored: Number(r.pw_len ?? 0) > 0,
      sameOriginAsCandidate: same,
    };
  });
  entry.sameOriginCount = entry.rows.filter((r) => r.sameOriginAsCandidate).length;
  out.push(entry);
}

const path0 = process.argv[2] || 'D:/Retire/probe-live/verify-0925-credentials.json';
fs.writeFileSync(path0, JSON.stringify({ at: new Date().toISOString(), atLocal: new Date().toLocaleString('sv-SE'), candidates: CANDIDATES, profiles: out }, null, 2), 'utf8');
console.log(`written ${path0}\n`);
for (const e of out) {
  console.log(`== ${e.label}  ${e.dir}`);
  console.log(`   库：${e.exists ? '有' : '不存在'}  ${e.note ?? ''}  同候选 origin 条数=${e.sameOriginCount ?? '-'}`);
  for (const r of e.rows) {
    console.log(`   origin=${r.origin}`);
    console.log(`     账号=${JSON.stringify(r.username)} 用过=${r.timesUsed} 拉黑=${r.blacklisted} 有密码=${r.passwordStored} 建=${r.createdAt} 末次=${r.lastUsedAt} ${r.sameOriginAsCandidate ? '✅同 origin' : '❌不同 origin'}`);
  }
  if (e.rows.length === 0) console.log('   （没有 taobao 相关凭据）');
}
