import { execFileSync } from 'node:child_process';
const expression = String.raw`(() => JSON.stringify([...document.querySelectorAll('[data-field-id]')]
  .filter((el) => ['材质分类','外形','安装方式','功能','风格','尺寸','适用空间'].includes((el.innerText || '').trim()))
  .map((el) => ({
    fieldId: el.getAttribute('data-field-id'), text: (el.innerText || '').trim(),
    outer: el.outerHTML.slice(0, 3000),
    buttons: [...el.querySelectorAll('button')].map((b) => ({ text: (b.innerText || '').trim(), e2e: b.getAttribute('data-e2e'), outer: b.outerHTML.slice(0, 500) })),
  })), null, 2))()`;
const targets = JSON.parse(execFileSync('curl.exe', ['-s', 'http://127.0.0.1:3456/targets'], { encoding: 'utf8' }));
const target = targets.find((item) => item.type === 'page' && item.url.startsWith('https://rcndesfqro3x.feishu.cn/base/OWebbPUcBa7B8JseYLccQCy9nkf'))?.targetId;
if (!target) throw new Error('authorized Feishu target not found');
console.log(execFileSync('curl.exe', ['-s', '-X', 'POST', `http://127.0.0.1:3456/eval?target=${target}`, '-H', 'Content-Type: text/plain', '--data-binary', expression], { encoding: 'utf8' }));
