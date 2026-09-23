// 探针（2026-09-23）：**一次真实的鼠标点击能不能把凭据唤出来**。
//
// 为什么必须问这一句：上一步（peek-login-flags.mjs）把「零点击被关」也排除了 ——
// 全部 14 条凭据的 `skip_zero_click` 都是 0。但同时又冒出一条互相矛盾的事实：
// 盖文天猫那条凭据的 `date_last_used = 2026-09-23 07:37:38Z`（就是今天下午跑真机登录那会儿），
// 说明**浏览器自己认为这条凭据被用过了**，可页面上读到的 `valueLen` 一直是 0。
//
// 现代 Chromium 的密码填充是**两段式**的，这一点决定了修法：
//   · 页面加载时的「零点击填充」在多数版本上默认不开（或被 skip_zero_click 关掉）；
//   · 真正稳定生效的是「**用户手势**聚焦到用户名/密码框」→ 密码管理器把凭据填进去（或弹出下拉）。
// 所以本探针按顺序做四件事，每步之后都读一次**同一个**判据：
//   ① 现状（不碰）
//   ② 真实鼠标点击 `#fm-login-id`（走代理 /clickAt，是浏览器级 Input.dispatchMouseEvent，算用户手势）
//   ③ 真实鼠标点击 `#fm-login-password`
//   ④ 点空白处再点回用户名框（排除「只是需要重新聚焦」）
//
// 判据只用三样，且**都取自页面自身**（不看页面文字有没有变 —— 本项目已知坑）：
//   · `value.length` —— 有没有值落进来
//   · `el.matches(':autofill')` —— 浏览器是不是以「自动填充」而不是脚本赋值的方式填的
//   · `document.elementFromPoint(点击点)` —— 确认点击真的落在输入框上，而不是被遮罩吃掉
// 另外读一次数据库里那条凭据的 `date_last_used`（只读账号名与计数，绝不读 password_value），
// 看「点击」与「浏览器记账」是否同步 —— 这是区分「填了但读不到」与「根本没填」的关键。
//
// 副作用边界：只对**已经停在登录页上**的那个页签点击它的两个输入框，不新建页签、不切换店铺、
// **绝不点登录按钮**、不提交任何表单。跑完打印每个窗口的页签条数以便复查。
//
// 用法：node probe-gesture-fill.mjs [代理端口，默认 19045] [profile 目录，默认盖文天猫]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PROXY = `http://127.0.0.1:${process.argv[2] ?? '19045'}`;
const PROFILE = process.argv[3] ?? 'D:/Retire/edge-profiles/gaiwen-flagship';
const SHOTS = new URL('./shots/', import.meta.url).pathname.replace(/^\//u, '');

// 一次 eval 同时拿到全部判据；elementFromPoint 用来证明「点击点上是哪个元素」。
const STATE = `(() => {
  const probe = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      valueLen: (el.value || '').length,
      autofill: el.matches(':autofill'),
      visible: r.width > 0 && r.height > 0,
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      pointHits: hit ? (hit.id || hit.tagName) : null,
      pointIsSelf: hit === el,
    };
  };
  const focused = document.activeElement;
  return JSON.stringify({
    href: location.href,
    readyState: document.readyState,
    activeElement: focused ? (focused.id || focused.tagName) : null,
    iframeSrcs: [...document.querySelectorAll('iframe')].map((f) => String(f.src).slice(0, 120)),
    id: probe('#fm-login-id'),
    password: probe('#fm-login-password'),
    // 密码管理器弹出的下拉（不同版本选择器不同，全部记下个数，不为 0 就是「建议已出现」）
    suggestionNodes: document.querySelectorAll('[role=listbox], [role=option], #password-manager, .password-suggestions').length,
    shadowRoots: [...document.querySelectorAll('*')].filter((n) => n.shadowRoot).length,
  });
})()`;

const delay = (ms) => new Promise((r) => { setTimeout(r, ms); });
const j = async (p, init) => { const res = await fetch(`${PROXY}${p}`, init); return JSON.parse(await res.text()); };
const evalOn = async (target, expression) =>
  (await j(`/eval?target=${encodeURIComponent(target)}`, { method: 'POST', body: expression }))?.value;
const readState = async (target) => {
  try { return JSON.parse(await evalOn(target, STATE)); } catch (error) { return { error: String(error?.message ?? error) }; }
};
// /clickAt 收**裸选择器文本**（不是 JSON）—— 2026-09-22 已实测的入参不一致之一。
const clickAt = async (target, selector) => j(`/clickAt?target=${encodeURIComponent(target)}`, { method: 'POST', body: selector });

function credentialRow() {
  const file = `${PROFILE}/Default/Login Data`;
  if (!fs.existsSync(file)) return '(没有 Login Data)';
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.prepare('SELECT count(*) AS n FROM logins').get();
  } catch {
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gesture-')), 'Login Data');
    fs.copyFileSync(file, copy);
    db = new DatabaseSync(copy, { readOnly: true });
  }
  const rows = db.prepare(
    'SELECT username_value, signon_realm, times_used, CAST(date_last_used AS TEXT) AS date_last_used'
    + ' FROM logins WHERE signon_realm LIKE ? OR origin_url LIKE ?',
  ).all('%havanalogin.taobao.com%', '%havanalogin.taobao.com%');
  db.close();
  return rows.map((r) => `${JSON.stringify(String(r.username_value))} 用过=${r.times_used} 最后使用=${r.date_last_used}`).join(' | ') || '(该 realm 下没有凭据)';
}

const targets = await j('/targets');
const pages = (Array.isArray(targets) ? targets : targets.targets ?? []).filter((t) => t.type === 'page');
console.log(`代理 ${PROXY}：${pages.length} 个页签`);
for (const p of pages) console.log(`  - ${p.targetId}  ${p.title}  ${p.url}`);

const login = pages.filter((p) => /login\.taobao\.com|havanalogin\.taobao\.com/u.test(String(p.url)));
if (login.length === 0) { console.log('\n没有登录页页签 —— 不新建任何页面，直接退出'); process.exit(0); }
const target = login[login.length - 1].targetId;
console.log(`\n目标页签 target=${target}`);

console.log(`\n凭据行（点击前）：${credentialRow()}`);

const step = async (label, action, shotName) => {
  console.log(`\n== ${label}`);
  const before = await readState(target);
  console.log(`  点击前 active=${before.activeElement}  id.valueLen=${before.id?.valueLen} id.autofill=${before.id?.autofill} pwd.valueLen=${before.password?.valueLen}`);
  const clicked = await action();
  console.log(`  动作回执：${JSON.stringify(clicked)}`);
  await delay(1200);
  const after = await readState(target);
  console.log(`  点击后 active=${after.activeElement}  id.valueLen=${after.id?.valueLen} id.autofill=${after.id?.autofill} pwd.valueLen=${after.password?.valueLen} pwd.autofill=${after.password?.autofill} 建议节点=${after.suggestionNodes}`);
  console.log(`  elementFromPoint： id 命中 ${after.id?.pointHits}(self=${after.id?.pointIsSelf})  pwd 命中 ${after.password?.pointHits}(self=${after.password?.pointIsSelf})`);
  if (shotName) {
    try {
      const res = await fetch(`${PROXY}/screenshot?target=${encodeURIComponent(target)}`);
      fs.writeFileSync(path.join(SHOTS, shotName), Buffer.from(await res.arrayBuffer()));
      console.log(`  截图 → shots/${shotName}`);
    } catch (error) { console.log(`  截图失败：${String(error?.message ?? error)}`); }
  }
  return after;
};

console.log('\n① 现状（不碰）');
console.log(JSON.stringify(await readState(target), null, 1));

await step('② 真实鼠标点击 #fm-login-id', () => clickAt(target, '#fm-login-id'), 'gesture-1-after-id-click.png');
await step('③ 真实鼠标点击 #fm-login-password', () => clickAt(target, '#fm-login-password'), 'gesture-2-after-pwd-click.png');
await step('④ 点空白 → 再点回用户名框', async () => {
  await evalOn(target, 'document.body.click(); "blur"');
  await delay(400);
  return clickAt(target, '#fm-login-id');
}, 'gesture-3-after-refocus.png');

console.log(`\n凭据行（点击后）：${credentialRow()}`);

// 收尾复查：页签条数必须与开头一致（只读探针的台账）。
const after = await j('/targets');
const pagesAfter = (Array.isArray(after) ? after : after.targets ?? []).filter((t) => t.type === 'page');
console.log(`\n收尾：页签 ${pages.length} → ${pagesAfter.length}（必须相等）`);
