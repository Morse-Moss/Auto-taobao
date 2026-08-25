import { execFileSync } from 'node:child_process';
const expression = process.argv.slice(2).join(' ');
if (!expression) throw new Error('expression required');
const targets = JSON.parse(execFileSync('curl.exe', ['-s', 'http://127.0.0.1:3456/targets'], { encoding: 'utf8' }));
const target = targets.find((item) => item.type === 'page' && item.url.startsWith('https://rcndesfqro3x.feishu.cn/base/OWebbPUcBa7B8JseYLccQCy9nkf'))?.targetId;
if (!target) throw new Error('authorized Feishu target not found');
const out = execFileSync('curl.exe', ['-s', '-X', 'POST', `http://127.0.0.1:3456/eval?target=${target}`, '-H', 'Content-Type: text/plain', '--data-binary', expression], { encoding: 'utf8' });
console.log(out);
