// 凭据收敛：把「不属于这个 profile 的淘宝凭据」从密码库里删掉，让「一个浏览器 ＝ 一个身份」成立。
//
// 为什么必须做：Chromium 的自动填充只比 origin（不比路径）。同一个 origin 下有 ≥2 条凭据时
// **浏览器自己挑一条，脚本控制不了** ⇒ 可能把某家店悄悄登成另一家 —— 页面照开、导出照成、
// 每个数字看起来都对，而链上没有任何一步会发现。这种错比「登录失败」贵得多。
//
// 纪律（每条都对应一个具体的坑）：
//   · 只读账号名、**绝不读也绝不打印 `password_value`**；
//   · **默认干跑**，要真删必须显式 `--commit`；
//   · 删之前**整库备份**（`Login Data` ＋ `-wal` ＋ `-shm`），备份路径打进报告；
//   · 每条 spec 必须**恰好命中 1 条**，命中 0 条或 ≥2 条一律 fail-closed（不做"大概删这条"）；
//   · 删主表的同时删掉按 `id` 一一对应的 `sync_entities_metadata` / `logins_edge_extended`
//     （这张库里四张表 id 都是 1..N 一一对应，实测确认过），避免留下孤儿同步元数据；
//   · 删完**回读自证**：同 origin 条数必须从 N 变 1（不是"看它没报错"）。
//
// ⚠️ **同步会把删掉的拉回来**：某个 profile 的密码库若带 `sync_entities_metadata`
// 且 `count(sync_entities_metadata) == count(logins)`，说明**每条凭据都参与了同步** ⇒
// 在本地直接删，云端**可能**再下发一次（删完回读 0 条、下次启动又变回来，且不报错）。
// 所以：**删完必须起一次那个 profile 回读复核**。判据见 `peek-sync-state.mjs`。
//
// 用法（Windows 上优先用 --specs-file：命令行里的中文参数会过宿主控制台的码页）：
//   node converge-credentials.mjs --profile <路径> --specs-file <json> [--out <报告>] [--commit]
//   node converge-credentials.mjs --profile <路径> --delete "<origin>|<账号>" [--delete ...] [--commit]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const argOf = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : def;
};
const allOf = (name) => argv.reduce((acc, a, i) => (a === name ? [...acc, argv[i + 1]] : acc), []);
const has = (name) => argv.includes(name);

const PROFILE = argOf('--profile');
const SPECS = allOf('--delete').filter((s) => s && !s.startsWith('--'));
const COMMIT = has('--commit');
const LOGIN_ORIGIN = 'https://login.taobao.com';

if (!PROFILE || (SPECS.length === 0 && !argv.includes('--specs-file'))) {
  console.error('用法：node converge-credentials.mjs --profile <路径> --specs-file <json> [--commit]\n'
    + '      或：node converge-credentials.mjs --profile <路径> --delete "<origin>|<账号>" [...] [--commit]');
  process.exit(2);
}
const dir = PROFILE.replaceAll('\\', '/');
const dbFile = `${dir}/Default/Login Data`;
if (!fs.existsSync(dbFile)) {
  console.error(`没有这个密码库：${dbFile}`);
  process.exit(2);
}

const out = [];
const say = (s) => out.push(s);

// ── 背景阅读用的账号全貌 ──────────────────────────────────────────────────
function readAll(db) {
  return db.prepare('SELECT id, origin_url, username_value, times_used FROM logins ORDER BY id').all();
}
function summarize(rows, title) {
  const same = rows.filter((r) => {
    try { return new URL(String(r.origin_url)).origin === LOGIN_ORIGIN; } catch { return false; }
  });
  say(`  ${title}：共 ${rows.length} 条淘宝凭据，其中与登录页同 origin 的 ${same.length} 条`);
  for (const r of same) {
    say(`      id=${r.id}  ${r.origin_url}  →  ${JSON.stringify(String(r.username_value))}（用过 ${r.times_used}）`);
  }
  return same.length;
}

// ── 解析 spec ────────────────────────────────────────────────────────────
// `--specs-file <json>` 是给 Windows 用的：命令行里带中文参数会经过宿主控制台的码页，
// 中文可能被解成乱码，于是「要删哪一条」在到达脚本之前就已经错了（而脚本会报「命中 0 条」，
// 看起来像是库里没有，其实是参数坏了）。JSON 文件按 UTF-8 读，全程不经过 shell。
const specsFile = argOf('--specs-file', null);
let parsed;
if (specsFile) {
  const raw = JSON.parse(fs.readFileSync(specsFile, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) {
    console.error(`${specsFile} 里要一个非空的 [{ origin, username }]`);
    process.exit(2);
  }
  parsed = raw.map((r) => ({ origin: String(r.origin), username: String(r.username) }));
} else {
  parsed = SPECS.map((s) => {
    const cut = s.lastIndexOf('|');
    if (cut < 0) {
      console.error(`--delete 的格式是 "<origin>|<账号>"，收到 ${JSON.stringify(s)}`);
      process.exit(2);
    }
    return { origin: s.slice(0, cut), username: s.slice(cut + 1) };
  });
}
if (parsed.length === 0) {
  console.error('要至少一条删除目标。');
  process.exit(2);
}

// ── 备份（真删才做，但干跑时也先复制一份，保证后面读的是快照）────────────
const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\..*$/u, '');
const slug = path.basename(dir);
const backupDir = argOf('--backup-dir', `D:/Retire/edge-profile-backups/${slug}-${stamp}`);
const originLocked = (() => {
  try {
    const probe = new DatabaseSync(dbFile, { readOnly: true });
    probe.prepare('SELECT count(*) AS n FROM logins').get();
    probe.close();
    return false;
  } catch { return true; }
})();

let workFile = dbFile;
if (COMMIT && originLocked) {
  console.error('原库被运行中的浏览器锁着 ⇒ 不能改。先停掉那个 profile 的浏览器再跑。');
  process.exit(2);
}
if (COMMIT) {
  fs.mkdirSync(backupDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${dbFile}${suffix}`;
    if (fs.existsSync(src)) fs.copyFileSync(src, `${backupDir}/Login Data${suffix}`);
  }
  say(`备份：${backupDir}（Login Data ＋ -wal ＋ -shm）`);
}

say(`目标 profile：${dir}`);
say(`模式：${COMMIT ? '**真删**' : '干跑（不写一个字节）'}`);
if (originLocked) say('（原库此刻被锁 ⇒ 干跑读的是复制件）');
if (!COMMIT && originLocked) {
  workFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'converge-')), 'Login Data');
  fs.copyFileSync(dbFile, workFile);
}

const db = new DatabaseSync(workFile, COMMIT ? {} : { readOnly: true });

const all = readAll(db);
say('');
say('── 删前 ──');
summarize(all.filter((r) => String(r.origin_url).includes('taobao.com')), '淘宝凭据');

// ── 逐条定位（fail-closed）────────────────────────────────────────────────
const victims = [];
for (const spec of parsed) {
  const hits = all.filter((r) => String(r.origin_url) === spec.origin && String(r.username_value) === spec.username);
  say('');
  say(`要删：origin=${spec.origin}  账号=${JSON.stringify(spec.username)}`);
  if (hits.length === 0) {
    say('  ✗ 命中 0 条 —— 库里没有这一条（可能已经删过）。fail-closed，不猜。');
    db.close();
    process.exit(3);
  }
  if (hits.length > 1) {
    say(`  ✗ 命中 ${hits.length} 条 —— 同一个 origin＋账号出现多行，不猜删哪一条。fail-closed。`);
    db.close();
    process.exit(3);
  }
  say(`  ✓ 命中 1 条：id=${hits[0].id}（用过 ${hits[0].times_used}）`);
  victims.push(hits[0]);
}

if (COMMIT) {
  const delLogin = db.prepare('DELETE FROM logins WHERE id = ?');
  const delMeta = db.prepare('DELETE FROM sync_entities_metadata WHERE storage_key = ?');
  const delExt = db.prepare('DELETE FROM logins_edge_extended WHERE id = ?');
  const delInsec = db.prepare('DELETE FROM insecure_credentials WHERE parent_id = ?');
  const delNotes = db.prepare('DELETE FROM password_notes WHERE parent_id = ?');
  db.exec('BEGIN');
  try {
    for (const v of victims) {
      delLogin.run(v.id);
      delMeta.run(v.id);
      delExt.run(v.id);
      delInsec.run(v.id);
      delNotes.run(v.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    say(`删除失败已回滚：${e.message}`);
    db.close();
    process.exit(4);
  }
  say('');
  say(`已删除 ${victims.length} 条（logins ＋ sync_entities_metadata ＋ logins_edge_extended 同步删）。`);
}

// ── 回读自证 ─────────────────────────────────────────────────────────────
const after = readAll(db);
say('');
if (!COMMIT) {
  say('── 干跑收尾 ──');
  say('  ⚠️ 干跑不写一个字节 ⇒ 下面这些数字**就是删前那些**，它只证明「脚本找到了该找的那几条」，');
  say('     不证明「删成功了」。要真删请加 --commit，那时这一段才是回读自证。');
  say(`  ⇒ 计划删除 ${victims.length} 条：` + victims.map((v) => `id=${v.id}(${v.username_value})`).join('、'));
} else {
  say('── 删后（回读自证）──');
  const sameAfter = summarize(after.filter((r) => String(r.origin_url).includes('taobao.com')), '淘宝凭据');
  say(`  ⇒ 与登录页同 origin 的凭据 ${sameAfter} 条：`
    + (sameAfter === 1 ? '恰好一条 ⇒ 能填、且填的一定是它 ✅'
      : sameAfter === 0 ? '一条都没有 ⇒ 自动登录必然填不上'
        : '≥2 条 ⇒ 浏览器仍可能挑错 ❌'));
  const victimsGone = victims.every((v) => !after.some((r) => r.id === v.id));
  say(`  ⇒ 被删的那几条是否真的不在了：${victimsGone ? '是 ✅' : '否 ❌（回读还能看到 ⇒ 删除没生效）'}`);
}
db.close();

if (COMMIT) say('\n⚠️ 复核要求：起一次这个 profile 的浏览器，再跑 peek-sync-state.mjs 看有没有被同步拉回来。');

const outFile = argOf('--out', null);
if (outFile) {
  fs.writeFileSync(outFile, `${out.join('\n')}\n`, 'utf8');
  process.stdout.write(`WROTE ${outFile}\n`);
} else {
  process.stdout.write(`${out.join('\n')}\n`);
}
