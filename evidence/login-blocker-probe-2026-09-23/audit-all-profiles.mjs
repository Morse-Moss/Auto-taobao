// 只读：把六个浏览器 profile 的密码库里「淘宝相关凭据」一次全列出来，
// 目的一是回答「哪些凭据需要收敛（删）」，二是回答「哪家店会被登成别家」。
//
// 为什么必须查这一步（不是好奇心）：自动登录靠浏览器自己的填充，而 Chromium 的填充判据是
// 「保存凭据的 origin_url 的 origin == 当前登录页的 origin」—— **只比 origin、不比路径**。
// 于是「同一个 origin 下有几条凭据」这件事直接决定了两件事：
//   ① 能不能填上（一条同 origin 的都没有 ⇒ 填不上，脚本会判 NO_SAVED_CREDENTIAL）；
//   ② 填的**是谁**（同 origin 有多条 ⇒ 浏览器自己挑一条，而它挑错了不会报任何错，
//      结果是商家浏览器被登成**另一家店**，之后采集的每个数字都属于那家店）。
//
// 只读 `username_value`，**绝不读也绝不打印 `password_value`**。
// 时间列一律 CAST(x AS TEXT)：node:sqlite 读 Chromium 的微秒时间戳会抛 RangeError。
//
// 报告**由脚本自己写文件**（不是往 stdout 打、再由 PowerShell 落盘）：
// 本机 PowerShell 把子进程 stdout 按 GBK 解码，中文会变成「鍟嗗娴忚鍣」这种双重编码。
// 用法：node audit-all-profiles.mjs [输出文件]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const OUT = process.argv[2] ?? path.join(os.tmpdir(), 'cred-audit.txt');
const lines = [];
const say = (s) => { lines.push(s); };

// profile ↔ 它本该属于哪家店。唯一来源是 runtime/browser-ports.mjs 的登记表，
// 这里抄一份只为让人看得懂，改登记表时这里也要跟着改。
const PROFILES = [
  { key: '商家浏览器（日报专用）', profile: 'D:/Retire/edge-daily-report-profile', owner: null },
  { key: '里可林淘宝', profile: 'D:/Retire/edge-profiles/likelin-home', owner: '里可林家居' },
  { key: '网林（天猫）', profile: 'D:/Retire/edge-profiles/wanglin-flagship', owner: '网林' },
  { key: '盖文淘宝', profile: 'D:/Retire/edge-profiles/suixin-custom', owner: '随心品质定制' },
  { key: '盖文天猫', profile: 'D:/Retire/edge-profiles/gaiwen-flagship', owner: '盖文旗舰店' },
  { key: '科塔淘宝', profile: 'D:/Retire/edge-profiles/shop-j873522735', owner: 'j873522735' },
];

const LOGIN_ORIGIN = 'https://login.taobao.com';

function openReadOnly(file) {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    db.prepare('SELECT count(*) AS n FROM logins').get();
    return { db, note: '原库直接打开' };
  } catch {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-audit-'));
    const copy = path.join(dir, 'Login Data');
    fs.copyFileSync(file, copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    return { db, note: '原库被运行中的浏览器锁着，读的复制件' };
  }
}

for (const entry of PROFILES) {
  const file = `${entry.profile}/Default/Login Data`;
  say(`\n===== ${entry.key}  ${entry.profile} =====`);
  if (!fs.existsSync(file)) {
    say('  没有 Login Data —— 这个 profile 从没存过任何密码');
    continue;
  }
  const { db, note } = openReadOnly(file);
  const rows = db.prepare(`
    SELECT origin_url, username_value, times_used, skip_zero_click, blacklisted_by_user,
           CAST(date_created AS TEXT) AS date_created
    FROM logins
    ORDER BY origin_url
  `).all();
  const taobaoAll = db.prepare(`
    SELECT count(*) AS n FROM logins WHERE origin_url LIKE '%taobao.com%'
  `).get();
  db.close();

  say(`  （${note}；本库共 ${rows.length} 条凭据，其中 taobao.com 域下 ${taobaoAll.n} 条）`);
  const tb = rows.filter((r) => String(r.origin_url).includes('taobao.com'));
  if (tb.length === 0) say('  没有淘宝相关凭据');

  // 判据：只有 origin（不含路径）等于登录页 origin 的那几条会被浏览器拿去填。
  // ⚠️ 这里必须把 same 打在**同一批对象**上：早先版本打在 push 出去的副本上、
  //    统计时却过滤原始行 ⇒ 同源条数恒报 0（差点把「两条同源」的隐患报成「一条都没有」）。
  const enriched = tb.map((r) => {
    const o = String(r.origin_url);
    let same = false;
    try { same = new URL(o).origin === LOGIN_ORIGIN; } catch { same = false; }
    return { ...r, origin: o, same };
  });

  const byOrigin = new Map();
  for (const r of enriched) {
    const bucket = byOrigin.get(r.origin) ?? [];
    bucket.push(r);
    byOrigin.set(r.origin, bucket);
  }

  for (const [origin, list] of byOrigin) {
    const same = list[0].same;
    say(`  origin=${origin}`);
    say(`      ${same ? '✅ 与登录页同 origin ⇒ 会被拿来填' : '❌ origin 不同 ⇒ 填不上'}`);
    for (const r of list) {
      const ownerMark = entry.owner && String(r.username_value).includes(entry.owner) ? '【本店】' : '【外来】';
      say(`        ${ownerMark} 账号=${JSON.stringify(String(r.username_value))}`
        + `  用过=${r.times_used}  skip_zero_click=${r.skip_zero_click}  已拉黑=${r.blacklisted_by_user}`);
    }
  }

  const sameOriginRows = enriched.filter((r) => r.same);
  const distinctSame = new Set(sameOriginRows.map((r) => r.origin));
  say(`  ⇒ 与登录页同 origin 的凭据 ${sameOriginRows.length} 条（分布在 ${distinctSame.size} 条 URL 上）：`
    + (sameOriginRows.length === 0 ? '一条都没有 ⇒ 自动登录必然判 NO_SAVED_CREDENTIAL（要人工登一次并保存密码）'
      : sameOriginRows.length === 1 ? '恰好一条 ⇒ 能填、且填的一定是它'
        : '≥2 条 ⇒ 浏览器自己挑一条，**有可能登成别家**（必须先收敛）'));
}

fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
process.stdout.write(`WROTE ${OUT}\n`);
