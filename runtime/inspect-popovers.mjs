import { execFileSync } from 'node:child_process';
const expression = String.raw`(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const info = (el) => { const r = el.getBoundingClientRect(); return { tag: el.tagName, id: el.id, cls: String(el.className || '').slice(0,240), role: el.getAttribute('role'), e2e: el.getAttribute('data-e2e'), selector: el.getAttribute('data-selector'), text: (el.innerText || el.textContent || '').trim().slice(0,1200), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, outer: el.outerHTML.slice(0,1600) }; };
  const all = [...document.querySelectorAll('body *')].filter(visible);
  const selected = all.filter((el) => { const s = [el.getAttribute('role') || '', el.getAttribute('data-e2e') || '', el.getAttribute('data-selector') || '', String(el.className || ''), (el.innerText || '').slice(0,500)].join(' '); return /(menu|popover|dropdown|dialog|modal|field|编辑|设置|配置|删除|复制|隐藏|重命名|AI|提示词|生成)/i.test(s) && !s.includes('app-main-container'); });
  return JSON.stringify(selected.slice(-500).map(info), null, 2);
})()`;
const targets = JSON.parse(execFileSync('curl.exe', ['-s', 'http://127.0.0.1:3456/targets'], { encoding: 'utf8' }));
const target = targets.find((item) => item.type === 'page' && item.url.startsWith('https://rcndesfqro3x.feishu.cn/base/OWebbPUcBa7B8JseYLccQCy9nkf'))?.targetId;
if (!target) throw new Error('authorized Feishu target not found');
console.log(execFileSync('curl.exe', ['-s', '-X', 'POST', `http://127.0.0.1:3456/eval?target=${target}`, '-H', 'Content-Type: text/plain', '--data-binary', expression], { encoding: 'utf8' }));
