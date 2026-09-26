#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderProductJobEntry } from '../runtime/product-data-job-core.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCHTASKS = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'schtasks.exe');
const TASK = 'sycm-product-data-collection';
function parse(argv) { const o = { mode: 'print', time: '11:40' }; for (let i = 0; i < argv.length; i += 1) { const a = argv[i]; if (a === '--install') o.mode = 'install'; else if (a === '--remove') o.mode = 'remove'; else if (a === '--query') o.mode = 'query'; else if (a === '--time') o.time = argv[++i]; else if (a === '--help' || a === '-h') o.help = true; else throw new Error(`unknown argument ${a}`); } if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(o.time)) throw new Error('--time must be HH:MM'); return o; }
function run(args, capture = false) { const r = spawnSync(SCHTASKS, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' }); return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, error: r.error }; }
async function main(argv) { let o; try { o = parse(argv); } catch (e) { console.error(e.message); return 2; } if (o.help) { console.log('node scripts/schedule-install-product-data.mjs [--install|--remove|--query] [--time HH:MM]'); return 0; }
  const entry = renderProductJobEntry({ repoRoot: ROOT });
  if (o.mode === 'print') { console.log(`[商品数据自动采集] 每天 ${o.time}\n${entry}`); return 0; }
  if (o.mode === 'query') { const r = run(['/Query', '/TN', TASK, '/V', '/FO', 'LIST'], true); console.log(r.out.trim()); return r.status === 0 ? 0 : 1; }
  if (o.mode === 'remove') { const r = run(['/Delete', '/TN', TASK, '/F']); return r.status === 0 ? 0 : 2; }
  const created = run(['/Create', '/TN', TASK, '/SC', 'DAILY', '/ST', o.time, '/TR', entry, '/F']); if (created.status !== 0) return 2; const verified = run(['/Query', '/TN', TASK, '/V', '/FO', 'LIST'], true); console.log(verified.out.trim()); return verified.status === 0 ? 0 : 1;
}
if (pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exit(await main(process.argv.slice(2)));
export { main, parse };
