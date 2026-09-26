#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { shopBrowserKeys, shopInstance } from '../runtime/browser-ports.mjs';

const DEFAULT_SHOPS = shopBrowserKeys();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parse(argv) {
  const index = argv.indexOf('--shops');
  const shops = index >= 0
    ? String(argv[index + 1] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    : DEFAULT_SHOPS;
  const unknown = shops.filter((shop) => !DEFAULT_SHOPS.includes(shop));
  if (unknown.length) throw new Error(`未登记店铺：${unknown.join(', ')}`);
  return shops;
}

function listening(shops) {
  const ports = shops.flatMap((shop) => {
    const instance = shopInstance(shop);
    return [instance.browserPort, instance.proxyPort];
  });
  const output = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    '$ports = ConvertFrom-Json $env:PRODUCT_RELEASE_PORTS; '
      + '$rows = foreach ($p in $ports) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue }; '
      + 'if ($rows) { $rows.Count } else { 0 }',
  ], { encoding: 'utf8', env: { ...process.env, PRODUCT_RELEASE_PORTS: JSON.stringify(ports) } });
  return Number(String(output.stdout ?? '').trim()) || 0;
}

async function main() {
  const shops = parse(process.argv.slice(2));
  const command = spawnSync(process.execPath, ['scripts/stop-all.mjs', '--yes', '--only', shops.join(',')], {
    stdio: 'inherit', cwd: new URL('..', import.meta.url),
  });
  const checks = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await sleep(700);
    checks.push({ attempt, listening: listening(shops) });
  }
  const released = checks.at(-1).listening === 0;
  console.log(JSON.stringify({ shops, stopExitCode: command.status, checks, released }, null, 2));
  if (command.status !== 0 || !released) process.exitCode = 1;
}

main().catch((error) => { console.error(`商品流程释放失败：${error.message}`); process.exitCode = 1; });
