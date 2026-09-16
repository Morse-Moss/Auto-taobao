#!/usr/bin/env node

// Dedicated merchant session for the daily operations report.
process.env.PROJECT_BROWSER_PORT ||= '9223';
process.env.PROJECT_BROWSER_PROFILE ||= 'D:/Retire/edge-daily-report-profile';
process.env.PROJECT_BROWSER_URL ||= 'https://sycm.taobao.com/';

await import('./start-project-browser.mjs');
