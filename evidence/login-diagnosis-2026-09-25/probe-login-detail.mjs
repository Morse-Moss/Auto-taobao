// 只读：把登录页当前这一屏的**结构**抓全（不点、不导航、不提交）。
// 要回答的是：这一页现在到底是「密码表单」还是「确认登录/快速进入」，
// 以及页面上有没有「协议」这两个字、它挂在哪个元素上、能不能点。
const PROXY = 'http://127.0.0.1:19042';
const TARGET = process.argv[2];
if (!TARGET) { console.error('用法：node probe-login-detail.mjs <targetId>'); process.exit(1); }

const EXPR = `(() => {
  const info = (el) => {
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, id: String(el.id||'').slice(0,50), cls: String(el.className||'').slice(0,90),
             t: String(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40),
             rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
             vis: r.width > 0 && r.height > 0 };
  };
  const byText = (re) => [...document.querySelectorAll('a,button,div,span,label,p,li')]
      .filter((e) => re.test(String(e.innerText||e.textContent||'')) )
      .filter((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0)
      .slice(0, 8).map(info);
  const html = document.documentElement.outerHTML;
  const agreeIdx = [];
  let at = html.indexOf('协议');
  while (at >= 0 && agreeIdx.length < 6) { agreeIdx.push(html.slice(Math.max(0, at - 220), at + 120)); at = html.indexOf('协议', at + 1); }
  return JSON.stringify({
    href: location.href,
    title: document.title,
    fullText: (document.body ? document.body.innerText : '').replace(/\\n{2,}/g, '\\n'),
    loginState: (() => { const el = document.querySelector('#login'); return el ? String(el.className) : null; })(),
    containerClass: (() => { const el = document.querySelector('#container'); return el ? String(el.className) : null; })(),
    passwordForm: {
      id: !!document.querySelector('#fm-login-id'),
      password: !!document.querySelector('#fm-login-password'),
      agreement: !!document.querySelector('#fm-agreement-checkbox'),
      submit: !!document.querySelector('button.fm-submit'),
    },
    fastEnter: byText(/快速进入|确认登录|一键登录|立即登录/),
    agreeNodes: byText(/协议|同意/),
    checkboxCount: document.querySelectorAll('input[type=checkbox]').length,
    htmlLen: html.length,
    agreeSnippets: agreeIdx,
  });
})()`;

const res = await fetch(`${PROXY}/eval?target=${encodeURIComponent(TARGET)}`, { method: 'POST', body: EXPR });
const text = await res.text();
if (!res.ok) { console.error(`HTTP ${res.status} ${text.slice(0, 300)}`); process.exit(1); }
const value = JSON.parse(text)?.value;
let parsed = null;
try { parsed = JSON.parse(value); } catch { /* 原样 */ }
console.log(JSON.stringify(parsed ?? value, null, 1));
