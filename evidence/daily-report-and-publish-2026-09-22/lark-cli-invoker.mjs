// 通用 lark-cli 调用器：绕开本机 bash 缺 coreutils 导致的 shim 失效。
// 用法：node tmp/lark.mjs docs +script --command init-draft --presentation-decision @./tmp/pd.json --format json
import { spawnSync } from 'node:child_process';

const NODE = process.execPath;
const RUN = 'C:/Users/Administrator/.workbuddy/binaries/node/cli-connector-packages/node_modules/@larksuite/cli/scripts/run.js';
const args = process.argv.slice(2);

const res = spawnSync(NODE, [RUN, ...args], {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  env: process.env,
});

console.log('=== ARGS === ' + JSON.stringify(args));
console.log('=== STATUS === ' + res.status);
console.log('=== STDOUT ===');
console.log(res.stdout ?? '');
console.log('=== STDERR ===');
console.log(res.stderr ?? '');
process.exit(res.status ?? 1);
