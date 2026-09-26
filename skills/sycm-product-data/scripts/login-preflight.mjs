import { spawn } from 'node:child_process';
import path from 'node:path';
import { ISOLATED_PROFILES } from '../../sycm-alimama-daily-report/scripts/shop-identities.mjs';

export const LOGIN_SCRIPT = path.resolve(import.meta.dirname, '../../sycm-alimama-daily-report/scripts/check-login-shops.mjs');
export const DEFAULT_PRODUCT_SHOPS = Object.freeze(Object.keys(ISOLATED_PROFILES));

function parseJsonOutput(stdout) {
  const text = String(stdout ?? '').trim();
  for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    try {
      const value = JSON.parse(text.slice(start));
      if (value && typeof value === 'object' && typeof value.verdict === 'string') return value;
    } catch { /* 日志前缀或嵌套对象不是完整 JSON，继续找外层 */ }
  }
  return null;
}

export function parseLoginPreflightOutput(stdout) {
  const receipt = parseJsonOutput(stdout);
  if (!receipt || typeof receipt !== 'object' || typeof receipt.verdict !== 'string') {
    throw new Error('登录预检没有返回可解析的 JSON 收据');
  }
  return receipt;
}

export function loginPreflightArgs({ shops, timeoutMs = 180000 } = {}) {
  if (!Array.isArray(shops) || shops.length === 0) throw new Error('登录预检至少需要一家店铺');
  return [LOGIN_SCRIPT, '--login', '--json', '--shops', shops.join(','), '--timeout', String(timeoutMs)];
}

export function assertLoginReady({ code, receipt }) {
  if (code !== 0 || receipt?.verdict !== 'ALL_IN') {
    const verdict = receipt?.verdict ?? 'UNREADABLE';
    const alert = receipt?.roundNotify?.alertId ? `，飞书告警编号 ${receipt.roundNotify.alertId}` : '';
    throw new Error(`登录预检未通过：${verdict}${alert}`);
  }
  return receipt;
}

export function runLoginPreflight({ shops, timeoutMs = 180000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl(process.execPath, loginPreflightArgs({ shops, timeoutMs }), {
      cwd: path.resolve(import.meta.dirname, '../../..'), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: null, receipt: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => {
      let receipt = null;
      try { receipt = parseLoginPreflightOutput(stdout); } catch {
        try { receipt = parseLoginPreflightOutput(stderr); } catch { /* keep null */ }
      }
      resolve({ code, receipt, stdout, stderr });
    });
  });
}

// 商品三类数据沿用日报的五店覆盖，但按历史流程并行预检；日报脚本本身仍保持它的串行风控策略。
export function runParallelLoginPreflight({ shops, timeoutMs = 180000, spawnImpl = spawn } = {}) {
  if (!Array.isArray(shops) || shops.length === 0) throw new Error('登录预检至少需要一家店铺');
  return Promise.all(shops.map((shop) => runLoginPreflight({ shops: [shop], timeoutMs, spawnImpl })));
}

async function main(argv) {
  const shopsArg = argv[argv.indexOf('--shops') + 1] || DEFAULT_PRODUCT_SHOPS.join(',');
  const shops = shopsArg.split(',').map((value) => value.trim()).filter(Boolean);
  const results = await runParallelLoginPreflight({ shops });
  const ready = results.every((result) => result.code === 0 && result.receipt?.verdict === 'ALL_IN');
  process.stdout.write(JSON.stringify({
    code: ready ? 0 : Math.max(0, ...results.map((result) => result.code ?? 3)),
    verdict: ready ? 'ALL_IN' : 'BLOCKED',
    results: results.map((result, index) => ({ shop: shops[index], ...result })),
  }, null, 2));
  if (!ready) process.exitCode = Math.max(1, ...results.map((result) => result.code ?? 3));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
