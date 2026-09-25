// 取证：把 test:staged 里那 10 条 not ok 直接钉到「宿主掐断同步子进程」上。
// 手法＝用失败用例里逐字相同的调用形态复现，再跑一次摘掉 stdin 的对照。
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO = 'D:/Retire/sycm-automation';
const cases = [
  ['huitun-to-feishu-keyword-heat/tests/cli.test.mjs', 'skills/huitun-to-feishu-keyword-heat/scripts/run-huitun-topic-heat.mjs', '--help'],
  ['xws-export-market-analysis/tests/cli.test.mjs', 'skills/xws-export-market-analysis/scripts/export-market-analysis.mjs', '--help'],
  ['sycm-export-search-rank/scripts/full-flow.test.mjs', 'skills/sycm-export-search-rank/scripts/export-search-rank.mjs', '--help'],
];

const lines = [];
lines.push('== 原样形态（{ encoding: "utf8" }，不声明 stdio）＝测试里逐字相同的写法 ==');
for (const [testFile, rel, arg] of cases) {
  const cli = path.join(REPO, rel);
  const asIs = spawnSync(process.execPath, [cli, arg], { encoding: 'utf8' });
  lines.push(`[${testFile}]`);
  lines.push(`  原样    : status=${asIs.status} errorCode=${asIs.error?.code ?? 'none'} stdoutLen=${(asIs.stdout ?? '').length} stderrLen=${(asIs.stderr ?? '').length}`);
  const fixed = spawnSync(process.execPath, [cli, arg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  lines.push(`  摘 stdin: status=${fixed.status} errorCode=${fixed.error?.code ?? 'none'} stdoutHead=${JSON.stringify((fixed.stdout ?? '').slice(0, 48))}`);
}
lines.push('');
lines.push('== 逐行明细（上面每条「原样」若 errorCode=EBUSY 且 status=null，即用例里 assert.equal(result.status, 0) 报 null !== 0 的成因）==');

console.log(lines.join('\n'));
