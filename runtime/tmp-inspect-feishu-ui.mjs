import { execFileSync } from 'node:child_process';
const targets = JSON.parse(execFileSync('curl.exe', ['-s', 'http://127.0.0.1:3456/targets'], { encoding: 'utf8' }));
const target = targets.find((item) => item.type === 'page' && item.url.startsWith('https://rcndesfqro3x.feishu.cn/base/OWebbPUcBa7B8JseYLccQCy9nkf'))?.targetId;
if (!target) throw new Error('authorized Feishu target not found');
const expression = String.raw`(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const info = (el) => { const r = el.getBoundingClientRect(); return { tag: el.tagName, id: el.id, cls: String(el.className || '').slice(0, 220), e2e: el.getAttribute('data-e2e'), selector: el.getAttribute('data-selector'), role: el.getAttribute('role'), aria: el.getAttribute('aria-label'), title: el.getAttribute('title'), text: (el.innerText || el.textContent || '').trim().slice(0, 300), value: (el.value || '').slice(0, 300), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, outer: el.outerHTML.slice(0, 700) }; };
  const names = ['字段配置','材质分类','外形','安装方式','功能','风格','尺寸','适用空间','仅保存配置','保存配置','生成','开始生成'];
  const exact = {};
  for (const name of names) exact[name] = [...document.querySelectorAll('*')].filter((el) => visible(el) && (el.innerText || el.textContent || '').trim() === name).slice(-20).map(info);
  const controls = [...document.querySelectorAll('button,[role=button],input,textarea,[contenteditable=true]')].filter(visible).map(info).slice(-500);
  const overlay = [...document.querySelectorAll('body *')].filter((el) => visible(el) && /(field|custom|setting|drawer|dialog|popover|ai|prompt|保存配置|生成)/i.test(String(el.getAttribute('data-e2e') || '') + ' ' + String(el.getAttribute('data-selector') || '') + ' ' + String(el.className || '') + ' ' + String(el.getAttribute('role') || '') + ' ' + String(el.innerText || '').slice(0, 100))).slice(-300).map(info);
  return JSON.stringify({ url: location.href, body: (document.body.innerText || '').slice(-12000), exact, controls, overlay }, null, 2);
})()`;
const out = execFileSync('curl.exe', ['-s', '-X', 'POST', 'http://127.0.0.1:3456/eval?target=' + target, '-H', 'Content-Type: text/plain', '--data-binary', expression], { encoding: 'utf8' });
console.log(out);
