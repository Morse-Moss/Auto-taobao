// 用 spawn 传数组跑 SKU 剪贴板捕获（中文参数不经过 shell）。
import { spawn } from 'node:child_process';

const REPO = 'D:/Retire/sycm-automation';
const DIR = `${REPO}/evidence/sku-2026-09-21`;
const args = [
  `${REPO}/runtime/capture-xws-sku-payload.mjs`,
  '--output-directory', DIR,
  '--auth-status-file', `${DIR}/xws-sku-auth-status-20260921T015933958Z-908b62ad-d26.json`,
  '--record-id', 'recvticyHkhtcR',
  '--product-id', '921092099640',
  '--product-url', 'https://item.taobao.com/item.htm?id=921092099640',
  '--validity', '是',
  '--classification', 'B-高价值竞品',
  '--copy-feedback', '已复制',
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
