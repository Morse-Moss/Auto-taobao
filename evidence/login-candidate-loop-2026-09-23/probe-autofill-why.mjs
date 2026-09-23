// 只读探针（2026-09-23）：为什么盖文天猫那个 profile 在**凭据自己的 origin** 上也填不上。
//
// 背景：真机跑完 `--commit`（回执见同目录 `commit-gaiwen-tmall.txt`）之后发现，
// 两条候选地址**都**报 `NO_AUTOFILL`。而凭据探针说这台机器上那条凭据的
// `signon_realm = https://havanalogin.taobao.com/`、`username_element = fm-login-id`、
// `blacklisted_by_user = 0` —— 也就是说「开在凭据自己的 origin 上就会填」这条推断**被真机证伪了**。
//
// 这个探针只回答一件事：**页面上到底发生了什么**。三组事实：
//   ① 现状（不重载，直接读）
//   ② 重载之后按 2s/6s/12s/20s 各读一次（区分「时机问题」与「根本不会填」）
//   ③ 页面自身的属性（autocomplete、iframe 数、是否顶层文档、UA、webdriver）
// 全程只读：只对**已经停在登录页上**的那个页签做一次重载，不新建、不切换、不提交。
//
// 用法：node probe-autofill-why.mjs [代理端口，默认 19045]
const PROXY = `http://127.0.0.1:${process.argv[2] ?? '19045'}`;

const STATE = `(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      valueLen: (el.value || '').length,
      autofill: el.matches(':autofill'),
      autocomplete: el.getAttribute('autocomplete'),
      name: el.getAttribute('name'),
      type: el.getAttribute('type'),
      visible: r.width > 0 && r.height > 0,
    };
  };
  const form = document.querySelector('form');
  return JSON.stringify({
    href: location.href,
    readyState: document.readyState,
    isTop: window.top === window.self,
    inputs: document.querySelectorAll('input').length,
    iframes: document.querySelectorAll('iframe').length,
    formAutocomplete: form ? form.getAttribute('autocomplete') : null,
    id: pick('#fm-login-id'),
    password: pick('#fm-login-password'),
    webdriver: !!navigator.webdriver,
    ua: navigator.userAgent,
    brands: (navigator.userAgentData && navigator.userAgentData.brands || []).map((b) => b.brand + '/' + b.version).join(','),
  });
})()`;

const delay = (ms) => new Promise((r) => { setTimeout(r, ms); });
const j = async (path, init) => {
  const res = await fetch(`${PROXY}${path}`, init);
  return JSON.parse(await res.text());
};
const evalOn = async (target, expression) => {
  const res = await fetch(`${PROXY}/eval?target=${encodeURIComponent(target)}`, { method: 'POST', body: expression });
  return JSON.parse(await res.text())?.value;
};
const readState = async (target) => {
  try { return JSON.parse(await evalOn(target, STATE)); } catch (error) { return { error: String(error?.message ?? error) }; }
};

const targets = (await j('/targets'));
const pages = (Array.isArray(targets) ? targets : targets.targets ?? []).filter((t) => t.type === 'page');
console.log(`代理 ${PROXY}：${pages.length} 个页签`);
for (const p of pages) console.log(`  - ${p.targetId}  ${p.title}  ${p.url}`);

const login = pages.filter((p) => /login\.taobao\.com|havanalogin\.taobao\.com/u.test(String(p.url)));
console.log(`\n淘宝登录页页签：${login.length} 个`);
if (login.length === 0) { console.log('没有登录页 —— 不新建任何页面，直接退出'); process.exit(0); }

const target = login[login.length - 1].targetId;
console.log(`\n① 现状（target=${target}）`);
console.log(JSON.stringify(await readState(target), null, 1));

console.log('\n② 重载之后各时刻（这一页本来就停在登录页上，只重载它自己）');
await fetch(`${PROXY}/bringToFront?target=${encodeURIComponent(target)}`, { method: 'GET' }).catch(() => {});
await fetch(`${PROXY}/eval?target=${encodeURIComponent(target)}`, { method: 'POST', body: 'setTimeout(() => location.reload(), 0); "reloading"' })
  .then((r) => r.text()).catch(() => '');
for (const wait of [2000, 4000, 6000, 8000]) {
  await delay(wait);
  const s = await readState(target);
  console.log(`  +${wait}ms  ready=${s.readyState}  id.autofill=${s.id?.autofill}  id.valueLen=${s.id?.valueLen}  pwd.autofill=${s.password?.autofill}  pwd.valueLen=${s.password?.valueLen}`);
}
console.log('\n③ 页面属性（重载稳定之后）');
console.log(JSON.stringify(await readState(target), null, 1));
