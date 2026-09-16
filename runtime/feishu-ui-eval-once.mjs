#!/usr/bin/env node
import { PROJECT_PORTS } from './browser-ports.mjs';
// 飞书网页登录态挂在**商家浏览器（乙）**上；端口来自 runtime/browser-ports.mjs。
// 2026-09-16：原先写死的 http://127.0.0.1:3456 是**别的项目**的共享代理 ——
// 那样能不能跑取决于别人的代理是否活着、以及那个浏览器里登的是谁。
const FEISHU_PROXY = `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;
const target = process.argv[2];
const expression = process.argv.slice(3).join(' ');
const r = await fetch(`${FEISHU_PROXY}/eval?target=${encodeURIComponent(target)}`, { method: 'POST', body: expression });
console.log((await r.json()).value);
