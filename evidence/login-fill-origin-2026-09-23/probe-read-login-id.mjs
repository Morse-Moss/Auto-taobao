// 只读探针：读某个代理窗口里「登录页」上的**账号框明文值与页面提示文字**。
//
// 用途（2026-09-23）：判断自动登录为什么没进去，以及**被填进去的是哪个账号**
// —— 填错账号＝串号，比「没登进去」更坏。实测抓到商家浏览器里被填的是**另一家店**的账号。
//
// 只读：只读 DOM 值（账号框、页面文字），**不读密码框的值、不点任何东西、不导航**。
// 账号名不是秘密（`skills/sycm-alimama-daily-report/scripts/shop-identities.mjs` 里就有），
// 密码才是 —— 这个脚本碰不到密码。
//
// 用法（在仓库根跑）：
//   node evidence/login-fill-origin-2026-09-23/probe-read-login-id.mjs 19023 havanaone
//   node evidence/login-fill-origin-2026-09-23/probe-read-login-id.mjs 19042 havanaone
// 参数：<代理端口> <页面 URL 片段>
// 端口取自 runtime/browser-ports.mjs（店铺实例 19041-19045，日报链 19023）。
const [proxyPort, fragment] = process.argv.slice(2);
if (!proxyPort || !fragment) {
  console.error('用法：node evidence/login-fill-origin-2026-09-23/probe-read-login-id.mjs <代理端口> <页面URL片段>');
  process.exit(2);
}
const list = await (await fetch(`http://127.0.0.1:${proxyPort}/targets`, { signal: AbortSignal.timeout(8000) })).json();
const pages = (Array.isArray(list) ? list : (list.targets ?? [])).filter((t) => t.type === 'page');
const hits = pages.filter((p) => String(p.url).includes(fragment));
console.log(`代理 ${proxyPort}：匹配「${fragment}」的页签 ${hits.length} 个`);
for (const page of hits) {
  console.log(`--- ${page.title}`);
  console.log(`    url=${page.url}`);
  const expr = `(() => {
    const id = document.querySelector('#fm-login-id, input[name="fm-login-id"], input[type="text"]');
    const err = document.querySelector('.login-error, .error, [class*="error"], [class*="tip"]');
    return JSON.stringify({
      idValue: id ? id.value : null,
      idValueLen: id ? (id.value || '').length : null,
      pwdBoxExists: Boolean(document.querySelector('#fm-login-password, input[type="password"]')),
      errText: err ? (err.innerText || '').slice(0, 120) : null,
      bodyHead: (document.body.innerText || '').replace(/\\s+/gu, ' ').slice(0, 260),
    });
  })()`;
  const res = await fetch(`http://127.0.0.1:${proxyPort}/eval?target=${encodeURIComponent(page.targetId)}`, {
    method: 'POST', body: expr, signal: AbortSignal.timeout(15000),
  });
  const payload = await res.json();
  console.log(`    ${typeof payload?.value === 'string' ? payload.value : JSON.stringify(payload).slice(0, 300)}`);
}
