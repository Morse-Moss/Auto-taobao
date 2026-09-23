// 只读：看商家浏览器（19023）现在开着哪些页签、登录页上有没有人正在输入。
//
// 为什么先做这一步再决定要不要自动登录：自动登录的第二步是「复用已经开着的登录页」
// （ensureLoginPage）。如果此刻**有人正在那个窗口里手输账号密码**，脚本会把它当成
// 「上次留下的登录页」，读到半截值就可能直接点提交 —— 那是拿别人的输入去提一次登录。
// 所以先只读看一眼：有登录页就再读一次表单状态，有人输过就先不动手。
//
// 这条脚本**不写任何东西**：不 /new、不 /navigate、不点。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY = 'http://127.0.0.1:19023';

const targets = await (await fetch(`${PROXY}/targets`)).json();
const pages = (Array.isArray(targets) ? targets : (targets.targets ?? [])).filter((t) => t.type === 'page');

const loginTabs = pages.filter((p) => String(p.url).includes('login.taobao.com/havanaone/login'));
const report = {
  proxy: PROXY,
  tabs: pages.map((p) => ({ targetId: p.targetId, url: p.url })),
  loginTabs: loginTabs.map((p) => p.targetId),
  formStates: [],
};

// 只在真的存在顶层登录页时才读表单 —— 没有登录页就说明没人正在登，没必要碰页面。
for (const tab of loginTabs) {
  const res = await fetch(`${PROXY}/eval?target=${encodeURIComponent(tab.targetId)}`, {
    method: 'POST',
    body: `(() => {
      const pick = (sel) => { const el = document.querySelector(sel); return el ? (el.value || '').length : null; };
      return JSON.stringify({ href: location.href, idLen: pick('#fm-login-id'), passwordLen: pick('#fm-login-password'), agreementChecked: !!document.querySelector('#fm-agreement-checkbox')?.checked });
    })()`,
  });
  const payload = await res.json();
  report.formStates.push({ targetId: tab.targetId, state: payload?.value ?? null });
}

writeFileSync(path.join(HERE, 'merchant-browser-tabs.json'), JSON.stringify(report, null, 1), 'utf8');
console.log(`页签 ${pages.length} 个，其中顶层登录页 ${loginTabs.length} 个`);
for (const p of report.tabs) console.log(`  - ${p.url}`);
for (const s of report.formStates) console.log(`  登录页 ${s.targetId}: ${s.state}`);
console.log(loginTabs.length === 0
  ? '⇒ 没有登录页 ⇒ 此刻没人在这个窗口里登，自动登录不会踩到别人的输入。'
  : '⇒ 有登录页，看上面 idLen/passwordLen 判断是不是有人正在输。');
