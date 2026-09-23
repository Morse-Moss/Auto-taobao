// 只读：某个 Edge/Chromium profile 的**同步状态**。
//
// 为什么必须查：脚本是靠直接改 `Login Data` 这个 sqlite 库来删多余凭据的，
// 但如果这个 profile 还登录着微软账号并且开了「密码同步」，删掉的条目会被云端**再拉回来**，
// 于是「删了、回读也是 0 条」这件事是真的，但下次启动又变回 2 条 —— 而且没有任何一步会报错。
// 另外：`--disable-sync` 只是启动参数，不带它启动的窗口照样会同步。
//
// 用法：node peek-sync-state.mjs <profile路径> [...] [--out 报告文件]
//
// 报告由脚本自己写文件：本机 PowerShell 会把子进程 stdout 按 GBK 解码，
// 中文与 emoji 经它中转会变成乱码甚至二进制（Read 工具直接拒读）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = outIdx >= 0 ? argv[outIdx + 1] : null;
const PROFILES = argv.filter((_, i) => i !== outIdx && i !== outIdx + 1);
const lines = [];
const say = (s) => lines.push(s);

if (PROFILES.length === 0) {
  console.error('用法：node peek-sync-state.mjs <profile路径> [...] [--out 报告文件]');
  process.exit(2);
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) n += countFiles(full); else n += 1;
  }
  return n;
}

for (const p of PROFILES) {
  const dir = p.replaceAll('\\', '/');
  say(`\n===== ${dir} =====`);

  const prefFile = `${dir}/Default/Preferences`;
  if (fs.existsSync(prefFile)) {
    try {
      const pref = JSON.parse(fs.readFileSync(prefFile, 'utf8'));
      const info = pref?.account_info?.[0] ?? null;
      const who = info?.email ?? info?.full_name ?? info?.account_id ?? null;
      say(`  已登录的同步账号：${who ? JSON.stringify(who) : '无（没登录微软账号）'}`);
      const sync = pref?.sync ?? {};
      say(`  sync.requested=${JSON.stringify(sync.requested ?? null)}`
        + `  initial_sync_done=${JSON.stringify(sync.initial_sync_done ?? null)}`);
    } catch (e) {
      say(`  Default/Preferences 解析失败：${e.message}`);
    }
  } else {
    say('  没有 Default/Preferences');
  }

  // 更硬的判据：存在 Sync Data 目录 ⇒ 这台机器确实在做同步（与偏好项无关）。
  const syncData = `${dir}/Default/Sync Data`;
  if (fs.existsSync(syncData)) {
    let count = -1;
    try { count = countFiles(syncData); } catch { count = -1; }
    say(`  ⚠️ 存在 Sync Data 目录，里面 ${count} 个文件 ⇒ 这个 profile 做过同步（密码可能被云端留着，删了会被拉回来）`);
  } else {
    say('  ✅ 没有 Sync Data 目录 ⇒ 从没同步过，删掉就是删掉了');
  }

  // 最硬的一条判据，而且就长在密码库自己身上：Chromium 把「这条凭据的同步元数据」写进
  // `Login Data` 里的 `sync_entities_metadata` / `meta` 表。这两张表**在且非空** ⇒ 这个密码库
  // 确实参与过同步 ⇒ 从本地直接删掉一行，云端**可能**把它再拉回来（删完回读 0 条、下次启动又变 2 条，且不报错）。
  const loginData = `${dir}/Default/Login Data`;
  if (fs.existsSync(loginData)) {
    try {
      let db = null;
      let src = loginData;
      try {
        db = new DatabaseSync(loginData, { readOnly: true });
        db.prepare('SELECT count(*) AS n FROM logins').get();
      } catch {
        try { db?.close(); } catch { /* 忽略 */ }
        src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-peek-')), 'Login Data');
        fs.copyFileSync(loginData, src);
        db = new DatabaseSync(src, { readOnly: true });
      }
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        .map((r) => String(r.name));
      const syncTables = tables.filter((t) => t.startsWith('sync_') || t === 'meta');
      let detail = [];
      for (const t of syncTables) {
        let n = -1;
        try { n = db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n; } catch { n = -1; }
        detail.push(`${t}=${n}`);
      }
      const logins = db.prepare('SELECT count(*) AS n FROM logins').get().n;
      db.close();
      say(`  密码库 ${src === loginData ? '直接打开' : '读的复制件'}：logins=${logins} 条；同步元数据表 `
        + (syncTables.length ? detail.join(' ') : '一张都没有'));
      say(syncTables.some((t) => t.startsWith('sync_'))
        ? '  ⚠️ 密码库里带着同步元数据 ⇒ **直接改库删条目有被云端拉回来的风险**'
        : '  ✅ 密码库里没有同步元数据表 ⇒ 删掉就是删掉了');
    } catch (e) {
      say(`  Login Data 检查失败：${e.message}`);
    }
  }

  const localState = `${dir}/Local State`;
  if (fs.existsSync(localState)) {
    try {
      const ls = JSON.parse(fs.readFileSync(localState, 'utf8'));
      const keys = Object.keys(ls?.os_crypt ?? {}).filter((k) => k.toLowerCase().includes('account')
        || k.toLowerCase().includes('gaia'));
      say(`  Local State 里账号相关键：${keys.length ? keys.join(', ') : '无'}`);
    } catch {
      say('  Local State 解析失败');
    }
  }
}

if (OUT) {
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
  process.stdout.write(`WROTE ${OUT}\n`);
}
