// 只读取证：直接用 CDP 的 Storage.getCookies 把每个浏览器的 cookie 打出来。
// 不新建页签、不导航、不发任何业务请求；只读。
// 为什么要走 CDP：profile 的 Cookies 库被浏览器独占锁着（copyfile 报 PermissionError）。
const TARGETS = [
  ['里可林淘宝', 19031, 19041],
  ['网林天猫', 19032, 19042],
  ['盖文淘宝', 19033, 19043],
  ['科塔淘宝', 19034, 19044],
  ['盖文天猫', 19035, 19045],
  ['商家浏览器', 19022, 19023],
];

const WANT = /taobao\.com|alimama\.com|tmall\.com/;

async function cookiesOf(port) {
  const v = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(8000) });
  const info = await v.json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP 超时')); }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies', params: {} }));
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      resolve(msg.result?.cookies ?? []);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); };
  });
}

for (const [name, browserPort, proxyPort] of TARGETS) {
  console.log('='.repeat(72));
  console.log(`${name}  browser:${browserPort}  proxy:${proxyPort}`);
  let all;
  try {
    all = await cookiesOf(browserPort);
  } catch (e) {
    console.log('  读不到：' + e.message);
    continue;
  }
  const mine = all.filter((c) => WANT.test(c.domain ?? ''));
  const sess = mine.filter((c) => c.session);
  const pers = mine.filter((c) => !c.session);
  console.log(`  该浏览器 cookie 总数 ${all.length}｜相关域 ${mine.length}（会话级 ${sess.length} / 持久 ${pers.length}）`);
  const key = /^(sn|unb|cookie2|cookie17|_tb_token_|sgcookie|cna|t|_l_g_|havana_lgc2_77|lgc|uc1|uc3|uc4)$/;
  const named = mine.filter((c) => key.test(c.name));
  if (named.length === 0) console.log('  关键登录键：一个都没有');
  for (const c of named) {
    console.log(`      ${c.domain.padEnd(22)} ${c.name.padEnd(18)} session=${c.session} expires=${c.expires ? new Date(c.expires * 1000).toISOString().slice(0, 10) : '-'}`);
  }
}
