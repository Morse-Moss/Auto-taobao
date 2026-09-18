#!/usr/bin/env node

// 店铺隔离实例的 CDP 代理 —— 一家店一个进程。
//
// 为什么一个进程只能侍候一家店：cdp-proxy「连哪个浏览器」是 **import 期常量**
// （runtime/isolated-proxy/browser-discovery.mjs 的 ISOLATED_PORT）⇒ 换浏览器必须重启进程。
// 而采集脚本走的是代理的 /targets /eval /navigate /click（裸 CDP 端口只有 /json/list）⇒
// 「按店铺实例化」在代理这一层就是「一家店一个代理进程」，没有别的写法。
//
// 用法（端口与身份全部来自 runtime/browser-ports.mjs，本文件不写死任何一个）：
//   node runtime/start-shop-proxy.mjs 科塔淘宝
//   node runtime/start-shop-proxy.mjs shop-j873522735      ← profile 目录名（纯 ASCII，推荐）
//
// 重复启动是安全的：cdp-proxy 会先探测自己端口上的 /health，发现已有实例就直接退出。
//
// 与 start-daily-report-proxy.mjs 的一处**刻意不同**：那个启动器用 `||=` 让显式环境变量优先，
// 因为它只服务一条固定的链；这里显式传的值必须与登记表一致，不一致就拒绝启动 ——
// 「把 A 店的代理指向 B 店的浏览器」正是这个体系要防的串店，而它出错时是**静默的**
// （点击、导航、下载全都成功，只是拿回别家店的数据）。
import { SHOP_BROWSERS, shopBrowserKeys, shopInstance } from './browser-ports.mjs';

const dirNameOf = (entry) => entry.profile.split('/').at(-1);

// 键接受两种写法：
//   · 运营叫法（`科塔淘宝`）—— 与 shop-identities.mjs 同源，程序里用这个；
//   · profile 目录名（`shop-j873522735`）—— 纯 ASCII。
// 为什么要留 ASCII 这条路：跨 shell（Git Bash / cmd / PowerShell 的编码各不相同）传中文
// 环境变量会变成乱码，而乱码的表现是「未登记的店铺实例」—— 一个好端端的名字传丢了，
// 排查起来却像是配置写错。ASCII 键在三种 shell 里都不会被转码。
function resolveShopKey(raw) {
  if (Object.hasOwn(SHOP_BROWSERS, raw)) return raw;
  const hit = Object.entries(SHOP_BROWSERS).find(([, entry]) => dirNameOf(entry) === raw);
  return hit ? hit[0] : null;
}

const rawKey = process.argv[2] ?? process.env.SHOP_KEY;
if (!rawKey) {
  console.error(`必须指定店铺（第一个参数或 SHOP_KEY）。`);
  console.error(`  运营叫法：${shopBrowserKeys().join(' / ')}`);
  console.error(`  目录名  ：${Object.values(SHOP_BROWSERS).map(dirNameOf).join(' / ')}`);
  process.exit(2);
}
const key = resolveShopKey(rawKey);
if (!key) {
  console.error(`未登记的店铺实例「${rawKey}」。已登记：${shopBrowserKeys().join(' / ')}`);
  process.exit(2);
}
const shop = shopInstance(key);

// 显式传了就必须一致（不允许用它来「临时换个目标」）。
for (const [envName, expected] of [
  ['CDP_BROWSER_PORT', shop.browserPort],
  ['CDP_BROWSER_ID', shop.browserId],
  ['CDP_BROWSER_LABEL', shop.label],
]) {
  const given = process.env[envName];
  if (given !== undefined && String(given) !== String(expected)) {
    console.error(`[shop-proxy] 拒绝启动：${envName}=${given} 与登记表里「${key}」的 ${expected} 不一致。`
      + '店铺实例的端口与身份是身份的一部分，改了就是串店；要改请改 runtime/browser-ports.mjs。');
    process.exit(2);
  }
}

process.env.CDP_PROXY_PORT = String(shop.proxyPort);
process.env.CDP_BROWSER_PORT = String(shop.browserPort);
process.env.CDP_BROWSER_ID = shop.browserId;
process.env.CDP_BROWSER_LABEL = shop.label;

console.log(`[shop-proxy] ${key} → 浏览器 :${shop.browserPort}（${dirNameOf(shop)}），代理 :${shop.proxyPort}`);
await import('./isolated-proxy/cdp-proxy.mjs');
