import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const checks = [
  ['sycm-export-search-rank', 'skills/sycm-export-search-rank/scripts/export-search-rank.mjs'],
  ['xws-export-market-analysis', 'skills/xws-export-market-analysis/scripts/export-market-analysis.mjs'],
  ['huitun-topic-heat', 'skills/huitun-to-feishu-keyword-heat/scripts/run-huitun-topic-heat.mjs'],
];

for (const [name, script] of checks) {
  console.log(`==> ${name} self-test`);
  const result = spawnSync(process.execPath, [path.resolve(root, script), '--self-test'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
