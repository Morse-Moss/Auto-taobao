#!/usr/bin/env node
// 交付物验收（2026-10-19）
//
// 只读复核 package-kefu-chat.mjs 的产物，**不采信打包脚本的自报**：
//   ① 每店 sessionCount / messageCount 与 manifest 自洽
//   ② 每条消息都落在声明的时间窗口内，方向字段合法，msgId 无跨会话重复
//   ③ CSV 带 BOM 且行数 = 会话数 + 1；txt 的会话块数 = 会话数
//   ④ 总览.html 里四家店都在
// 退出码：0 = 全过；1 = 有问题（逐条打印 ❌）。
//
// 用法：
//   node skills/qianniu-kefu-chat/scripts/verify-pack.mjs --out output/kefu-chat/2026-W42
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = { out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out.out = path.resolve(String(argv[++i] ?? ''));
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
    else throw new Error(`未知参数：${argv[i]}`);
  }
  if (!out.help && !out.out) throw new Error('必须给 --out <交付目录>');
  return out;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('node skills/qianniu-kefu-chat/scripts/verify-pack.mjs --out <交付目录>');
    return 0;
  }
  const outDir = options.out;
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
  const [startText, endText] = manifest.period.split(' ~ ');
  const winStart = Date.parse(`${startText}T00:00:00+08:00`);
  const winEnd = Date.parse(`${endText}T00:00:00+08:00`) + 86400000; // 含末日整天

  let problems = 0;
  const fail = (msg) => { console.log(`  ❌ ${msg}`); problems += 1; };

  for (const shop of manifest.shops) {
    const dir = path.join(outDir, shop.name);
    console.log(`\n[${shop.name}] 清单自报：${shop.sessions} 场 / ${shop.messages} 条`);

    const txtFile = fs.readdirSync(dir).find((n) => n.endsWith('.txt'));
    const csvFile = fs.readdirSync(dir).find((n) => n.endsWith('.csv'));
    const jsonFile = fs.readdirSync(dir).find((n) => n.endsWith('.json'));
    for (const [label, file] of [['txt', txtFile], ['csv', csvFile], ['json', jsonFile]]) {
      if (!file) fail(`缺少 ${label} 文件`);
    }
    if (!txtFile || !csvFile || !jsonFile) continue;

    const data = JSON.parse(fs.readFileSync(path.join(dir, jsonFile), 'utf8'));

    // ① 条数自洽
    const msgCount = data.sessions.reduce((sum, s) => sum + s.messages.length, 0);
    if (data.sessions.length !== shop.sessions) fail(`sessionCount 不一致：json ${data.sessions.length} vs manifest ${shop.sessions}`);
    if (msgCount !== shop.messages) fail(`messageCount 不一致：json ${msgCount} vs manifest ${shop.messages}`);

    // ② 窗口 / 方向 / 重复
    let outOfWindow = 0;
    let noDir = 0;
    let dupIds = 0;
    const seenIds = new Set();
    for (const s of data.sessions) {
      if (!s.messages.length) fail(`空会话 ${s.cid}`);
      for (const m of s.messages) {
        if (!(m.sendTime >= winStart && m.sendTime < winEnd)) outOfWindow += 1;
        if (!['buyer', 'agent', 'system'].includes(m.dir)) noDir += 1;
        if (m.msgId) {
          if (seenIds.has(m.msgId)) dupIds += 1;
          else seenIds.add(m.msgId);
        }
      }
    }
    if (outOfWindow) fail(`${outOfWindow} 条消息落在 ${manifest.period} 之外`);
    if (noDir) fail(`${noDir} 条消息没有合法方向`);
    if (dupIds) fail(`${dupIds} 条消息 id 跨会话重复`);

    // ③ CSV / txt
    const csvRaw = fs.readFileSync(path.join(dir, csvFile));
    if (!(csvRaw[0] === 0xEF && csvRaw[1] === 0xBB && csvRaw[2] === 0xBF)) fail('CSV 缺 BOM（Excel 打开会乱码）');
    const csvLines = csvRaw.toString('utf8').replace(/^\uFEFF/u, '').split('\r\n').filter(Boolean);
    if (csvLines.length !== shop.sessions + 1) fail(`CSV 行数 ${csvLines.length} ≠ 会话数+1 ${shop.sessions + 1}`);

    const txt = fs.readFileSync(path.join(dir, txtFile), 'utf8');
    const blocks = (txt.match(/^会话 \d+｜/gmu) ?? []).length;
    if (blocks !== shop.sessions) fail(`txt 会话块 ${blocks} ≠ 会话数 ${shop.sessions}`);

    // 实际跨度（从数据算，不信 stats）
    const times = data.sessions.flatMap((s) => s.messages.map((m) => m.sendTime)).sort((a, b) => a - b);
    const fmt = (t) => new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const sample = txt.split('\n').find((line) => /^\[\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/u.test(line)) ?? '(无样例)';

    console.log(`  实际跨度 ${fmt(times[0])} ~ ${fmt(times[times.length - 1])}`);
    console.log(`  客服签署 ${[...new Set(data.sessions.flatMap((s) => s.servingAgents))].join('/') || '（无）'}`);
    console.log(`  txt ${(Buffer.byteLength(txt) / 1024).toFixed(0)}KB 块${blocks}｜csv 行${csvLines.length}`
      + `｜json ${(fs.statSync(path.join(dir, jsonFile)).size / 1024 / 1024).toFixed(1)}MB`);
    console.log(`  样例：${sample.slice(0, 90)}`);
  }

  const htmlFile = path.join(outDir, '总览.html');
  if (!fs.existsSync(htmlFile)) fail('缺少 总览.html');
  else {
    const html = fs.readFileSync(htmlFile, 'utf8');
    if (!/<table>/u.test(html)) fail('总览.html 没有表格');
    for (const shop of manifest.shops) if (!html.includes(shop.name)) fail(`总览.html 缺 ${shop.name} 行`);
  }

  console.log(`\n${problems === 0 ? '✅ 验收通过（0 问题）' : `❌ 验收不通过：${problems} 个问题`}`);
  return problems === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`[kefu] 验收脚本失败：${error.message}`);
  process.exitCode = 1;
}
