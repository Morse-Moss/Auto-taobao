// 只读：用浏览器自己的 CDP 读 cookie（不落盘、不点页面、不导航）。
// 为什么要这样读：浏览器在跑，profile 的 Cookies 库是锁着的（copyfile EBUSY），
// 而 CDP 的 Storage.getCookies 是**只读查询**，不改变任何状态。
const PORT = Number(process.argv[2] ?? 19032);
const KEYS = ['unb', 'sn', 'cookie2', 'sgcookie', 'lgc', 'tracknick', '_tb_token_', 'cancelledSubSites'];

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = Math.floor(Math.random() * 1e9);
  const onMessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== id) return;
    ws.removeEventListener('message', onMessage);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  };
  ws.addEventListener('message', onMessage);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => reject(new Error(`${method} 超时`)), 15000);
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败：' + String(e?.message ?? e))), { once: true });
});

const { cookies } = await send('Storage.getCookies');
const relevant = cookies.filter((c) => /taobao|tmall|alimama/.test(c.domain));
console.log(`taobao/tmall/alimama cookie 共 ${relevant.length} 条（全部 cookie ${cookies.length} 条）`);
for (const key of KEYS) {
  const hit = relevant.filter((c) => c.name === key);
  if (hit.length === 0) { console.log(`  ${key.padEnd(18)} 无`); continue; }
  for (const c of hit) {
    const exp = c.session ? '会话级(关闭浏览器即失效)' : new Date(c.expires * 1000).toISOString();
    console.log(`  ${key.padEnd(18)} ${String(c.domain).padEnd(24)} 到期=${exp}`);
  }
}
console.log('--- 与「同意协议」可能相关的 cookie（名字里含 agree/notice/policy/risk） ---');
const agree = relevant.filter((c) => /agree|notice|policy|risk|_samesite|havana/i.test(c.name));
if (agree.length === 0) console.log('  无');
for (const c of agree) {
  const exp = c.session ? '会话级' : new Date(c.expires * 1000).toISOString();
  console.log(`  ${c.name.padEnd(28)} ${String(c.domain).padEnd(24)} 到期=${exp}`);
}
ws.close();
