#!/usr/bin/env node

process.env.CDP_PROXY_PORT ||= '3458';
process.env.CDP_BROWSER_PORT ||= '9223';
process.env.CDP_BROWSER_ID ||= 'edge-daily-report';
process.env.CDP_BROWSER_LABEL ||= 'Microsoft Edge (daily report)';

await import('./isolated-proxy/cdp-proxy.mjs');
