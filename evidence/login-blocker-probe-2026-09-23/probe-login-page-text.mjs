// 只读探针：把「那两个还掉登录的窗口里遗留的登录页」上**现在写着什么**读回来。
//
// 为什么值得读（它能把「两种可能」收成一种）：
//   下午那一轮 `LOGIN_NOT_CONFIRMED` 的措辞是「密码不对，或平台要求额外验证」——
//   这句话把判断权交给了收信人。而**登录页自己其实会写**：密码错会显示「账号或密码错误」，
//   要验证会显示「请完成验证」。读一次页面文字就能把「两种可能」收成一种，
//   而收信人最需要的恰恰是这一条（密码该改／还是该做验证）。
//
// 只读边界（本文件只做这几件事，**不点、不导航、不新建页签、不提交**）：
//   · 列 `/targets`（读）；
//   · 对「URL 里带 login.taobao.com / havanaone」的页签做一次 `/eval`，只读文本与表单状态；
//   · 跑前跑后各数一次**每个窗口的页签条数**，逐个比对——「只读」这句话要有账可查。
//
// 用法：node evidence/login-blocker-probe-2026-09-23/probe-login-page-text.mjs
// 产物：同目录 `login-page-text.json` ＋ `login-page-text.txt`
import fs from 'node:fs';
import path from 'node:path';

import { SHOP_BROWSERS } from '../../runtime/browser-ports.mjs';

const TARGETS = [
  ['网林天猫', SHOP_BROWSERS['网林天猫']?.proxyPort],
  ['盖文天猫', SHOP_BROWSERS['盖文天猫']?.proxyPort],
];

// 只读表达式：页面文字、URL、表单现状。**不含任何点击/赋值**。
const READ_EXPR = `(() => {
  const body = document.body ? (document.body.innerText || '') : '';
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { valueLen: (el.value || '').length, checked: !!el.checked, visible: r.width > 0 && r.height > 0 };
  };
  return JSON.stringify({
    href: location.href,
    title: document.title,
    text: body.replace(/\\s+/g, ' ').trim().slice(0, 600),
    id: pick('#fm-login-id'),
    password: pick('#fm-login-password'),
    agreement: pick('#fm-agreement-checkbox'),
    errorish: (body.match(/[^\\n]{0,30}(错误|失败|不正确|验证|受限|安全|频繁|稍后)[^\\n]{0,40}/g) || []).slice(0, 6),
  });
})()`;

const listTargets = async (proxyPort) => {
  const r = await fetch(`http://127.0.0.1:${proxyPort}/targets`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`GET /targets → HTTP ${r.status}`);
  const list = await r.json();
  return (Array.isArray(list) ? list : (list.targets ?? [])).filter((t) => t.type === 'page');
};

const evalOn = async (proxyPort, targetId, expression) => {
  const r = await fetch(`http://127.0.0.1:${proxyPort}/eval?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: expression, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`POST /eval → HTTP ${r.status}`);
  return (await r.json())?.value;
};

const report = { startedAt: new Date().toISOString(), windows: [], notes: [] };
const lines = [];
const say = (l) => { lines.push(l); process.stdout.write(`${l}\n`); };

for (const [shop, proxyPort] of TARGETS) {
  const entry = { shop, proxyPort, ok: false };
  report.windows.push(entry);
  say(`\n=== ${shop}（代理 ${proxyPort}）`);
  if (!proxyPort) { say('  未登记该店代理端口 —— 跳过（不猜）'); continue; }
  try {
    const before = await listTargets(proxyPort);
    entry.tabsBefore = before.map((t) => ({ targetId: t.targetId, url: t.url }));
    const loginTabs = before.filter((t) => /login\.taobao\.com|havanaone/u.test(String(t.url)));
    say(`  页签 ${before.length} 个，其中登录页 ${loginTabs.length} 个`);
    entry.loginTabs = [];
    for (const tab of loginTabs) {
      const raw = await evalOn(proxyPort, tab.targetId, READ_EXPR);
      const parsed = raw ? JSON.parse(raw) : null;
      entry.loginTabs.push({ targetId: tab.targetId, ...parsed });
      say(`  · ${tab.targetId}`);
      say(`    href=${parsed?.href}`);
      say(`    文字=${JSON.stringify(parsed?.text?.slice(0, 300))}`);
      say(`    账号框=${JSON.stringify(parsed?.id)} 密码框=${JSON.stringify(parsed?.password)} 勾选框=${JSON.stringify(parsed?.agreement)}`);
      say(`    疑似提示=${JSON.stringify(parsed?.errorish)}`);
    }
    const after = await listTargets(proxyPort);
    entry.tabsAfter = after.map((t) => ({ targetId: t.targetId, url: t.url }));
    entry.tabLedgerUnchanged = JSON.stringify(entry.tabsBefore) === JSON.stringify(entry.tabsAfter);
    say(`  只读账：跑前跑后页签**逐个相同**=${entry.tabLedgerUnchanged}`);
    entry.ok = true;
  } catch (error) {
    entry.error = String(error?.message ?? error);
    say(`  读不到：${entry.error}`);
  }
}

report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(import.meta.dirname, 'login-page-text.json'), `${JSON.stringify(report, null, 1)}\n`, 'utf8');
fs.writeFileSync(path.join(import.meta.dirname, 'login-page-text.txt'), `${lines.join('\n')}\n`, 'utf8');
