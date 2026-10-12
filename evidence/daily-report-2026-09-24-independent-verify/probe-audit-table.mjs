// 只读：从审计表读 09-18～09-24 的 push / inquiry-backfill 记录（第 1 层判据）。
// 注意 stdio 必须 [ignore,pipe,pipe]——带 stdin 管道在本机会 EBUSY。
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const DOCKER = 'E:/AI/Docker/resources/bin/docker.exe';
if (!existsSync(DOCKER)) {
  console.error(`docker not found at ${DOCKER}`);
  process.exit(1);
}

const SQL = `
SELECT id,
       to_char(at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') AS local_at,
       action, outcome, report_date, shop_name, record_id,
       record_count_before, record_count_after, mode, browser_port, browser_id, proxy_port
FROM daily_report_push_audit
WHERE report_date >= '2026-09-18'
ORDER BY id;
`.trim();

const out = execFileSync(
  DOCKER,
  ['exec', 'xws-adaptive-postgres', 'psql', '-U', 'xws_runner', '-d', 'xws_automation', '-A', '-F', '|', '-t', '-c', SQL],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);

const lines = out.split(/\r?\n/).filter((l) => l.trim() !== '');
const rows = lines.map((l) => {
  const p = l.split('|');
  return {
    id: Number(p[0]), localAt: p[1], action: p[2], outcome: p[3], reportDate: p[4],
    shop: p[5], recordId: p[6], before: p[7] === '' ? null : Number(p[7]), after: p[8] === '' ? null : Number(p[8]),
    mode: p[9], browserPort: p[10] === '' ? null : Number(p[10]), browserId: p[11], proxyPort: p[12] === '' ? null : Number(p[12]),
  };
});

const path = process.argv[2] || 'D:/Retire/probe-live/verify-0924-audit.json';
writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), sql: SQL, rowCount: rows.length, rows }, null, 2), 'utf8');
console.log(`rows=${rows.length} -> ${path}`);
for (const r of rows) {
  console.log([r.id, r.localAt, r.action, r.outcome, r.reportDate, r.shop, r.before, r.after, r.browserPort ?? '-', r.proxyPort ?? '-'].join(' | '));
}
