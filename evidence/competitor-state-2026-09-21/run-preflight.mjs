// 用 spawn 传数组跑小旺神登录态预检：中文参数不经过 shell（子 shell 会按 GBK 打坏）。
// 只读：预检本身不点击任何登录入口，只读可见工具条。
import { spawn } from 'node:child_process';

const REPO = 'D:/Retire/sycm-automation';
const args = [
  `${REPO}/runtime/xws-sku-auth-preflight.mjs`,
  '--proxy', 'http://127.0.0.1:3457',
  '--product-id', '921092099640',
  '--product-url', 'https://item.taobao.com/item.htm?id=921092099640',
  '--record-id', 'recvticyHkhtcR',
  '--classification', 'B-高价值竞品',
  '--validity', '是',
  '--output-directory', `${REPO}/evidence/sku-2026-09-21`,
];

const child = spawn(process.execPath, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });
child.on('exit', (code) => {
  console.log(`EXIT=${code}`);
  console.log('--- stdout ---');
  console.log(out);
  console.log('--- stderr ---');
  console.log(err);
});
