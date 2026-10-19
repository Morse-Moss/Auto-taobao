#!/usr/bin/env node
// 千牛客服聊天记录 · 打包（2026-10-19）
//
// 把 export-kefu-chat.mjs 归一化后的 shops/*.json 变成运营能直接用的四件套：
//   可读记录 txt / 会话清单 csv（BOM，Excel 直开）/ 全量 json / 总览 html + manifest。
//
// 用法：
//   node skills/qianniu-kefu-chat/scripts/package-kefu-chat.mjs --src <证据目录> [--out <交付目录>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatShanghai } from './kefu-chat-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

function parseArgs(argv) {
  const out = { src: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--src') out.src = path.resolve(String(argv[++i] ?? ''));
    else if (arg === '--out') out.out = path.resolve(String(argv[++i] ?? ''));
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!out.help && !out.src) throw new Error('必须给 --src <证据目录>');
  return out;
}

function escapeCsv(value) {
  const text = String(value ?? '');
  return /[",\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function whoOf(message) {
  if (message.dir === 'buyer') return '买家';
  if (message.dir === 'agent') return message.agentName ? `客服(${message.agentName})` : '客服';
  return '系统';
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('node skills/qianniu-kefu-chat/scripts/package-kefu-chat.mjs --src <证据目录> [--out <交付目录>]');
    return 0;
  }
  const shopsDir = path.join(options.src, 'shops');
  if (!fs.existsSync(shopsDir)) throw new Error(`没有找到归一化数据：${shopsDir}（先跑 export-kefu-chat.mjs）`);
  const files = fs.readdirSync(shopsDir).filter((name) => name.endsWith('.json')).sort();
  if (!files.length) throw new Error(`${shopsDir} 是空的`);

  const shops = files.map((name) => JSON.parse(fs.readFileSync(path.join(shopsDir, name), 'utf8')));
  const week = shops[0].week;
  const outDir = options.out ?? path.join(REPO_ROOT, 'output/kefu-chat', week.weekId);
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = {
    generatedAt: new Date().toISOString(),
    period: `${week.start} ~ ${week.end}`,
    weekId: week.weekId,
    lookbackDays: shops[0].lookbackDays ?? null,
    shops: [],
  };
  const rows = [];

  for (const shop of shops) {
    const name = shop.shop;
    const sessions = [...shop.sessions].sort((a, b) => a.createTime - b.createTime);
    const shopDir = path.join(outDir, name);
    fs.mkdirSync(shopDir, { recursive: true });

    // ① 可读记录
    const lines = [
      `${name} 客服聊天记录（${week.start} ~ ${week.end}）`,
      `会话 ${sessions.length} 场，消息 ${shop.stats.messages} 条，客服：${shop.stats.agents.join('、') || '（未署名）'}`,
      '',
    ];
    sessions.forEach((session, index) => {
      const tag = session.isRobot ? '［机器人会话］' : '';
      lines.push('='.repeat(70));
      lines.push(`会话 ${index + 1}｜买家 ${session.displayName}${tag}｜${session.startText} ~ ${session.endText}`
        + `｜客服 ${session.servingAgents.join('、') || '未署名'}｜${session.msgCount} 条`);
      lines.push('-'.repeat(70));
      for (const message of session.messages) {
        const body = message.text
          ? String(message.text).replace(/\s*\n\s*/gu, ' ').slice(0, 500)
          : '［卡片/系统消息，原始内容见 JSON］';
        lines.push(`[${formatShanghai(message.sendTime)}] ${whoOf(message)}: ${body}`);
      }
      lines.push('');
    });
    fs.writeFileSync(path.join(shopDir, `客服聊天记录-${name}-${week.weekId}.txt`), lines.join('\n'), 'utf8');

    // ② 会话清单 CSV
    const csv = ['买家昵称,是否机器人会话,开始时间,结束时间,消息数,客服,首条消息'];
    for (const session of sessions) {
      const firstText = (session.messages.find((message) => message.text) || {}).text || '';
      csv.push([
        session.displayName, session.isRobot ? '是' : '', session.startText, session.endText,
        session.msgCount, session.servingAgents.join('/'),
        String(firstText).replace(/\s*\n\s*/gu, ' ').slice(0, 60),
      ].map(escapeCsv).join(','));
    }
    fs.writeFileSync(path.join(shopDir, `会话清单-${name}-${week.weekId}.csv`), `\uFEFF${csv.join('\r\n')}`, 'utf8');

    // ③ 全量 JSON
    fs.writeFileSync(path.join(shopDir, `全量数据-${name}-${week.weekId}.json`), JSON.stringify({
      shop: name, period: `${week.start} ~ ${week.end}`, weekId: week.weekId,
      sessionCount: sessions.length, messageCount: shop.stats.messages, sessions,
    }, null, 1), 'utf8');

    rows.push({ name, stats: shop.stats });
    manifest.shops.push({
      name, key: shop.key,
      sessions: shop.stats.sessions, messages: shop.stats.messages,
      agents: shop.stats.agents, robotSessions: shop.stats.robotSessions,
      noBuyerSessions: shop.stats.noBuyerSessions,
      first: shop.stats.first, last: shop.stats.last,
    });
    console.log(`${name}: 会话 ${shop.stats.sessions} 消息 ${shop.stats.messages} 客服[${shop.stats.agents.join(',')}]`);
  }

  // ④ 总览
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>客服聊天记录总览 ${week.weekId}</title>
<style>
body{font-family:"Microsoft YaHei",sans-serif;background:#f5f6f8;color:#222;margin:32px;max-width:980px}
h1{font-size:22px} table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.08)}
th,td{border:1px solid #e3e6ea;padding:8px 12px;font-size:14px;text-align:left} th{background:#eef1f5}
.num{text-align:right;font-variant-numeric:tabular-nums} a{color:#1a56db;text-decoration:none}
.meta{color:#666;font-size:13px;margin:8px 0 20px}
</style></head><body>
<h1>客服聊天记录（${week.start} ~ ${week.end}）</h1>
<div class="meta">生成时间 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}｜${shops.length} 家店｜每店含：可读记录 txt、会话清单 csv、全量数据 json</div>
<table><tr><th>店铺</th><th class="num">会话数</th><th class="num">消息数</th><th>客服</th><th>时间范围</th><th>文件</th></tr>
${rows.map((row) => {
  const s = row.stats;
  return `<tr><td>${row.name}</td><td class="num">${s.sessions}</td><td class="num">${s.messages}</td>`
    + `<td>${s.agents.join('、') || '（未署名）'}</td><td>${s.first ?? '-'} ~ ${s.last ?? '-'}</td>`
    + `<td><a href="${encodeURI(row.name)}/客服聊天记录-${row.name}-${week.weekId}.txt">txt</a> · `
    + `<a href="${encodeURI(row.name)}/会话清单-${row.name}-${week.weekId}.csv">csv</a> · `
    + `<a href="${encodeURI(row.name)}/全量数据-${row.name}-${week.weekId}.json">json</a></td></tr>`;
}).join('\n')}
</table>
<p class="meta">说明：平台不支持批量导出聊天记录，以上数据由千牛「聊天记录查询」接口逐会话读取整理；每条消息保留原文（json 内 raw 字段），
方向分买家/客服/系统三类；标［机器人会话］的为店小蜜等自动接待。本目录只含 ${week.start} ~ ${week.end} 期间的消息。</p>
</body></html>`;
  fs.writeFileSync(path.join(outDir, '总览.html'), html, 'utf8');
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf8');
  console.log(`输出目录：${outDir}`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`[kefu] 打包失败：${error.message}`);
  process.exitCode = 1;
}
