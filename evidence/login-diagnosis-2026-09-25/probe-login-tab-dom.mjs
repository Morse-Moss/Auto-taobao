// 只读：把网林天猫窗口里每个页签的当前 DOM 现场读回来（不点、不导航、不提交）。
// 目的：回答「登录页上现在有没有一个要人点『同意』的浮层」以及它长什么样。
const PROXY = 'http://127.0.0.1:19042';

const EXPR = `(() => {
  const pick = (e) => ({
    tag: e.tagName,
    id: String(e.id || '').slice(0, 60),
    cls: String(e.className || '').slice(0, 120),
    t: String(e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    vis: e.offsetParent !== null,
  });
  const all = [...document.querySelectorAll('div,span,a,button,label,p,input')];
  const hits = all
    .filter((e) => /协议|同意|确认|继续|了解并同意|授权/.test(String(e.textContent || '')))
    .filter((e) => e.offsetParent !== null)
    .slice(0, 25)
    .map(pick);
  const boxes = [...document.querySelectorAll('input[type=checkbox]')]
    .map((e) => ({ id: e.id, name: e.name, cls: String(e.className).slice(0, 80), checked: e.checked, vis: e.offsetParent !== null }))
    .slice(0, 15);
  const body = document.body ? document.body.innerText : '';
  return JSON.stringify({
    href: location.href,
    title: document.title,
    bodyLen: body.length,
    bodyHead: body.replace(/\\s+/g, ' ').slice(0, 400),
    hits,
    checkboxes: boxes,
  });
})()`;

async function evalOn(target, expression) {
  const res = await fetch(`${PROXY}/eval?target=${encodeURIComponent(target)}`, { method: 'POST', body: expression });
  const text = await res.text();
  if (!res.ok) return { error: `HTTP ${res.status} ${text.slice(0, 200)}` };
  try { return JSON.parse(text)?.value ?? null; } catch { return { raw: text.slice(0, 400) }; }
}

const list = await (await fetch(`${PROXY}/targets`)).json();
const pages = (Array.isArray(list) ? list : (list.targets ?? [])).filter((t) => t.type === 'page');
console.log(`页签 ${pages.length} 个`);
for (const page of pages) {
  console.log('='.repeat(70));
  console.log(`${page.targetId}  ${String(page.url).slice(0, 110)}`);
  const value = await evalOn(page.targetId, EXPR);
  let parsed = null;
  try { parsed = JSON.parse(value); } catch { /* 原样打印 */ }
  console.log(parsed ? JSON.stringify(parsed, null, 1) : JSON.stringify(value));
}
