#!/usr/bin/env node

// 竞品链（买家号 ＋ 小旺神）的 CDP 代理。端口、browser id 与 label 同源于
// runtime/browser-ports.mjs —— 本文件不写死任何一个数字。
//
// 为什么补这个文件（2026-09-19）：这条代理此前**没有启动器**，只能照注释手打
//   CDP_PROXY_PORT=… CDP_BROWSER_PORT=… node runtime/isolated-proxy/cdp-proxy.mjs
// 手打的命令有三个问题，每个都对应一次真实故障：
//   1) 端口数字靠人抄 ⇒ 抄错不会报错，只会「自称买家、实连商家」（坑 52 的形态）；
//   2) 与 start-daily-report-proxy.mjs 的写法不同（那个用 `||=`，裸跑安全）⇒ 同一件事两种口径；
//   3) `scripts/start-all.mjs` 要按登记表起齐所有实例时，无处可依 ⇒ 只能自己拼环境变量，
//      于是「怎么起这条代理」就有了第二个说法。
//
// 与 start-shop-proxy.mjs 的关键差别：那个**拒绝**显式传入不一致的值（串店是静默失败），
// 这里用 `||=` 让显式环境变量优先（与 start-daily-report-proxy.mjs 一致）——
// 因为这一条链是固定的，允许覆盖是给「临时换端口排查」留的口子。
import { BROWSER_IDS, BROWSER_LABELS, PROJECT_PORTS } from './browser-ports.mjs';

process.env.CDP_PROXY_PORT ||= String(PROJECT_PORTS.competitorProxy);
process.env.CDP_BROWSER_PORT ||= String(PROJECT_PORTS.competitorBrowser);
process.env.CDP_BROWSER_ID ||= BROWSER_IDS.competitor;
process.env.CDP_BROWSER_LABEL ||= BROWSER_LABELS.competitor;

await import('./isolated-proxy/cdp-proxy.mjs');
