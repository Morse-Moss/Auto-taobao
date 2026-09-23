// 只读：盖文天猫（19045）窗口里那个「生意参谋登录页」内嵌的登录 iframe 指向哪。
//
// 为什么只读这一步有价值：盖文天猫的密码库里那条凭据的 origin 是 `havanalogin.taobao.com`
// （登录页 origin 是 `login.taobao.com`）⇒ 浏览器按 origin 匹配 ⇒ 填不上。
// 唯一能不靠人工补救的路子是：**让脚本去打开那条凭据所属 origin 上的登录页**。
// 而那条 origin 上的页面到底是哪一个 URL（带什么参数）—— 只有平台自己知道。
// 平台的登录页就在这个窗口里开着，把它的 iframe src 读出来就是**平台自己给的答案**，
// 比去猜参数可靠。
//
// 全程不写：不 /new、不 /navigate、不点，只 /targets + 一次 /eval。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY = 'http://127.0.0.1:19045';

const list = await (await fetch(`${PROXY}/targets`)).json();
const pages = (Array.isArray(list) ? list : (list.targets ?? [])).filter((t) => t.type === 'page');
const sycm = pages.filter((p) => String(p.url).includes('sycm.taobao.com'));

const out = { proxy: PROXY, tabs: pages.map((p) => p.url), frames: null, error: null };
if (sycm.length !== 1) {
  out.error = `期望恰好一个生意参谋页，实际 ${sycm.length} 个`;
} else {
  const res = await fetch(`${PROXY}/eval?target=${encodeURIComponent(sycm[0].targetId)}`, {
    method: 'POST',
    body: `(() => JSON.stringify({
      href: location.href,
      frames: [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src, w: Math.round(f.getBoundingClientRect().width), h: Math.round(f.getBoundingClientRect().height) })),
      hasTopLevelForm: !!document.querySelector('#fm-login-id'),
    }))()`,
  });
  const payload = await res.json();
  out.frames = payload?.value ?? null;
}

writeFileSync(path.join(HERE, 'gaiwen-tmall-login-frame.json'), JSON.stringify(out, null, 1), 'utf8');
console.log(`页签 ${pages.length} 个`);
for (const t of out.tabs) console.log(`  - ${t}`);
console.log(`iframe/表单：${out.frames ?? out.error}`);
