// 只读：① 首页领取区的 DOM 原文；② 生意参谋「我的」页里跟订购有关的入口。
// 只发 GET / 只读 DOM，不点击、不导航。
import { writeFileSync } from 'node:fs';

const PORT = 19044;
const expr = `(async () => {
  const out = { href: location.href };
  const box = document.querySelector('div.free-sycm-order');
  out.promoHtml = box ? box.outerHTML.slice(0, 5000) : null;

  // 「我的」页：找订购/订单相关入口
  try {
    const r = await fetch('/custom/user_info', { credentials: 'include', redirect: 'follow' });
    const t = await r.text();
    out.userInfo = { status: r.status, finalUrl: r.url, len: t.length };
    const links = Array.from(t.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\\s\\S]{0,60}?)<\\/a>/gi))
      .map((m) => ({ href: m[1], text: m[2].replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim() }))
      .filter((x) => /订购|订单|续费|服务市场|洞察|绩效/i.test(x.text + x.href));
    out.userInfo.orderLinks = links.slice(0, 25);
    out.userInfo.orderRefs = Array.from(new Set((t.match(/https?:\\/\\/[^"']*(?:fuwu|order|subscribe)[^"']*/gi) || []))).slice(0, 20);
  } catch (e) { out.userInfo = { err: String(e) }; }
  return JSON.stringify(out);
})()`;

const list = await (await fetch(`http://127.0.0.1:${PORT}/targets`, { signal: AbortSignal.timeout(8000) })).json();
const tab = (Array.isArray(list) ? list : []).find((t) => String(t.url ?? '').includes('sycm.taobao.com'));
if (!tab) { writeFileSync('D:/Retire/sycm-automation/tmp/keta-promo.txt', '没有 sycm 页签'); process.exit(0); }

const r = await fetch(`http://127.0.0.1:${PORT}/eval?target=${encodeURIComponent(tab.targetId)}`,
  { method: 'POST', body: expr, signal: AbortSignal.timeout(30000) });
const text = await r.text();
let d;
try { d = JSON.parse(JSON.parse(text).value); } catch { d = { parseError: text.slice(0, 400) }; }
writeFileSync('D:/Retire/sycm-automation/tmp/keta-promo.json', JSON.stringify(d, null, 1));

const L = [`at=${new Date().toISOString()}`, `page=${d.href ?? '?'}`, '', '## 领取区 DOM 原文'];
L.push(d.promoHtml ? d.promoHtml.replace(/></g, '>\n<') : '(没找到 div.free-sycm-order)');
L.push('');
L.push('## 「我的」页（/custom/user_info）');
L.push(JSON.stringify(d.userInfo, null, 1));
writeFileSync('D:/Retire/sycm-automation/tmp/keta-promo.txt', L.join('\n'));
console.log('ok');
