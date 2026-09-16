#!/usr/bin/env node

// Dedicated merchant session for the daily operations report.
//
// 商家号与买家号不能共用浏览器实例（生意参谋/阿里妈妈/飞书要商家号，
// 小旺神插件只有买家号能用）⇒ 这条链必须有自己的调试端口与 profile。
// 端口与 profile 的权威值见 runtime/browser-ports.mjs，这里不另写一份。
import { BROWSER_PROFILES, PROJECT_PORTS } from './browser-ports.mjs';

process.env.PROJECT_BROWSER_PORT ||= String(PROJECT_PORTS.dailyReportBrowser);
process.env.PROJECT_BROWSER_PROFILE ||= BROWSER_PROFILES.dailyReport;
process.env.PROJECT_BROWSER_URL ||= 'https://sycm.taobao.com/';

await import('./start-project-browser.mjs');
