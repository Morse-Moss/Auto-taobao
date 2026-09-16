import { PROJECT_PORTS } from './browser-ports.mjs';
// 飞书网页登录态挂在**商家浏览器（乙）**上；端口来自 runtime/browser-ports.mjs。
// 2026-09-16：原先写死的 http://127.0.0.1:3456 是**别的项目**的共享代理 ——
// 那样能不能跑取决于别人的代理是否活着、以及那个浏览器里登的是谁。
const FEISHU_PROXY = `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;
import { execFileSync } from 'node:child_process';

const targets = JSON.parse(execFileSync('curl.exe', ['-s', `${FEISHU_PROXY}/targets`], { encoding: 'utf8' }));
const target = targets.find((item) => item.type === 'page' && item.url.startsWith('https://rcndesfqro3x.feishu.cn/base/OWebbPUcBa7B8JseYLccQCy9nkf'))?.targetId;
if (!target) throw new Error('authorized Feishu target not found');

const expression = String.raw`(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  };
  const attrs = (el) => ({
    tag: el.tagName,
    id: el.id || null,
    cls: String(el.className || '').slice(0, 220),
    role: el.getAttribute('role'),
    e2e: el.getAttribute('data-e2e'),
    selector: el.getAttribute('data-selector'),
    fieldId: el.getAttribute('data-field-id'),
    aria: el.getAttribute('aria-label'),
    title: el.getAttribute('title'),
    name: el.getAttribute('name'),
    type: el.getAttribute('type'),
    value: ('value' in el ? String(el.value || '').slice(0, 2000) : null),
    contenteditable: el.getAttribute('contenteditable'),
    text: (el.innerText || el.textContent || '').trim().slice(0, 1500),
    rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    outer: el.outerHTML.slice(0, 1800),
  });
  const all = [...document.querySelectorAll('body *')].filter(visible);
  const interesting = all.filter((el) => {
    const s = [el.getAttribute('role') || '', el.getAttribute('data-e2e') || '', el.getAttribute('data-selector') || '', String(el.className || ''), el.innerText || '', el.getAttribute('aria-label') || ''].join(' ');
    return /(prompt|ai|字段|引用|保存|生成|开始|编辑|配置|材质分类|商品标题|是否有效竞品|卖点|dialog|drawer|popover|modal)/i.test(s);
  });
  const controls = [...document.querySelectorAll('button, input, textarea, [contenteditable=true], [role=button], [role=combobox], [role=textbox]')].filter(visible).map(attrs);
  const refs = all.filter((el) => {
    const s = [el.getAttribute('data-field-id') || '', el.getAttribute('data-token-type') || '', el.getAttribute('data-ref') || '', String(el.className || ''), el.innerText || ''].join(' ');
    return /(fld[A-Za-z0-9]+|field.?reference|reference|引用|商品标题|是否有效竞品|卖点)/i.test(s);
  }).map(attrs);
  const panels = interesting.filter((el) => { const r = el.getBoundingClientRect(); return r.w > 220 && r.h > 100; }).map(attrs);
  return JSON.stringify({ url: location.href, bodyTail: (document.body.innerText || '').slice(-8000), panels: panels.slice(-80), controls: controls.slice(-200), refs: refs.slice(-200) }, null, 2);
})()`;

const out = execFileSync('curl.exe', ['-s', '-X', 'POST', `${FEISHU_PROXY}/eval?target=${target}`, '-H', 'Content-Type: text/plain', '--data-binary', expression], { encoding: 'utf8' });
console.log(out);
