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
  // `stdio` 不能省：宿主沙箱对「带 stdin 管道」的同步 spawn 直接回 `EBUSY`（`errno=-4082`），
  // 此时 `stdout` 是 **null** ⇒ 下面 `Number('') || 0` 恒等于 0 ⇒ `released` 恒 true。
  // 也就是说这句所谓的「端口二次回读」曾经是一句**恒真断言**（2026-09-27 取证：
  // 不写 stdio 返回 `{status:null, errno:'EBUSY'}`；补上后同一条命令返回 `2`）。
  const output = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    '$ports = ConvertFrom-Json $env:PRODUCT_RELEASE_PORTS; '
      + '$rows = foreach ($p in $ports) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue }; '
      + 'if ($rows) { $rows.Count } else { 0 }',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PRODUCT_RELEASE_PORTS: JSON.stringify(ports) } });
  // 读不出来 ⇒ 返回 null（＝**没有证据**），绝不返回 0（＝证据是「一个都没在听」）。这两个结论不能互换。
  const text = String(output.stdout ?? '').trim();
  if (output.status !== 0 || !/^\d+$/u.test(text)) {
    return { listening: null, error: output.error?.message ?? (text || `exit ${output.status}`) };
  }
  return { listening: Number(text), error: null };
}

async function main() {
  const shops = parse(process.argv.slice(2));
  const command = spawnSync(process.execPath, ['scripts/stop-all.mjs', '--yes', '--only', shops.join(',')], {
    stdio: 'inherit', cwd: new URL('..', import.meta.url),
  });
  const checks = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await sleep(700);
    checks.push({ attempt, ...listening(shops) });
  }
  // 只有「读到 0」才算释放；读到 null（读不出来）一律不算 —— 假绿比假红更贵。
  const released = checks.at(-1).listening === 0;
  console.log(JSON.stringify({ shops, stopExitCode: command.status, checks, released }, null, 2));
  if (command.status !== 0 || !released) process.exitCode = 1;
}

main().catch((error) => { console.error(`商品流程释放失败：${error.message}`); process.exitCode = 1; });
