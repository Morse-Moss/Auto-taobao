#!/usr/bin/env node

// 日报链的 CDP 代理（商家号）。端口、browser id 与 label 同源于 runtime/browser-ports.mjs。
import { BROWSER_IDS, BROWSER_LABELS, PROJECT_PORTS } from './browser-ports.mjs';

process.env.CDP_PROXY_PORT ||= String(PROJECT_PORTS.dailyReportProxy);
process.env.CDP_BROWSER_PORT ||= String(PROJECT_PORTS.dailyReportBrowser);
process.env.CDP_BROWSER_ID ||= BROWSER_IDS.dailyReport;
process.env.CDP_BROWSER_LABEL ||= BROWSER_LABELS.dailyReport;

await import('./isolated-proxy/cdp-proxy.mjs');
