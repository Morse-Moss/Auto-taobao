// 单跑 runtime/sop-runtime：run-test-suite.mjs 不递归子目录，且 `node --test <目录>` 在本机会把目录当模块解析。
// 所以显式列文件再传。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = 'D:/Retire/sycm-automation/runtime/sop-runtime';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(dir, f));
console.log('FILES=' + files.length);
for (const f of files) console.log('  ' + path.basename(f));

const res = spawnSync(process.execPath, ['--test', ...files], {
  cwd: 'D:/Retire/sycm-automation',
  encoding: 'utf8',
  maxBuffer: 128 * 1024 * 1024,
});
console.log('STATUS=' + res.status);
console.log(res.stdout ?? '');
if (res.stderr) console.log('=== STDERR ===\n' + res.stderr);
process.exit(res.status ?? 1);
