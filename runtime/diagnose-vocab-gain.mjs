#!/usr/bin/env node
// Read-only probe #3: 词表外表达量化。
// 问题：属性列 71%「无注明」里，有多少是「标题写了但词表没收」，有多少是「标题真没写」？
// 方法：对本周表全量跑 buildCompetitorRecord 拿到推导值，再单独检测一组「明显同义但未入表」的词。
import { readFileSync } from 'node:fs';
import { buildCompetitorRecord } from '../skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs';
import { activeProfileName, baseUrl, envFilePath } from './feishu-targets.mjs';

// 目标一律从唯一来源取：写死 base token / 表 id 会静默打到旧租户（坑 35）。
const PROFILE = activeProfileName();
const API_ROOT = 'https://open.feishu.cn/open-apis';
const APP_TOKEN = baseUrl(PROFILE).match(/\/base\/([^?/#]+)/u)[1];
const ENV_FILE = envFilePath(PROFILE);
const env = {};
for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/u)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/u);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/gu, '');
}
const auth = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
}).then((r) => r.json());
if (auth.code !== 0) throw new Error(`auth failed: ${auth.code} ${auth.msg}`);
const headers = { Authorization: `Bearer ${auth.tenant_access_token}` };
const flat = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(flat).join(' ').trim();
  if (typeof v === 'object') return flat(v.text ?? v.value ?? v.name ?? '');
  return String(v).trim();
};
async function load(tableId) {
  const out = [];
  let token;
  do {
    const q = new URLSearchParams({ page_size: '500' });
    if (token) q.set('page_token', token);
    const page = await fetch(`${API_ROOT}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?${q}`, { headers }).then((r) => r.json());
    if (page.code !== 0) throw new Error(`records failed ${tableId}: ${page.code} ${page.msg}`);
    out.push(...(page.data.items ?? []));
    token = page.data.has_more ? page.data.page_token : undefined;
  } while (token);
  return out;
}

// 词表内（现状）vs 同义但未入表（候选）。仅用于量化潜在增益，不改任何线上口径。
const EXT = {
  外形: ['圆形', '正圆', '扇形', '三角', '方缸', '长方形', '正方', '鹅蛋', '水滴', '船型', '马槽', '腰形', '贝壳', '弧'],
  功能: ['水疗', '冲浪', '气泡', '加热', '保温', '蓝牙', '音乐', '喷雾', '臭氧'],
  安装方式: ['一体式', '落地式', '挂墙'],
  风格: ['中古', '复古', '北欧', '现代', '法式', '侘寂', '原木', '工业风', '艺术', '简约'],
  材质分类: ['树脂', '不锈钢', '亚克力板', '石英石', '岩板'],
};

const tableIdIndex = process.argv.indexOf('--table-id');
const targetTableId = tableIdIndex >= 0 ? String(process.argv[tableIdIndex + 1] ?? '') : '';
if (!targetTableId) throw new Error('--table-id <竞品周表 id> is required（本周的表 id 每次都不一样，不许写死）');

const rows = await load(targetTableId);
console.log(`目标周表 ${targetTableId}   ${rows.length} 行   profile ${PROFILE}\n`);
console.log('字段'.padEnd(8) + '词表内命中'.padStart(10) + '词表外候选'.padStart(12) + '真无信息'.padStart(10) + '  潜在有值率');
for (const [attr, words] of Object.entries(EXT)) {
  let inVocab = 0; let outside = 0; let none = 0;
  for (const r of rows) {
    const f = r.fields ?? {};
    const title = `${flat(f['商品标题'])} ${flat(f['卖点'])}`;
    const built = buildCompetitorRecord({
      商品标题: flat(f['商品标题']), 价格: flat(f['价格']),
      是否有效竞品: flat(f['是否有效竞品']), 月收货人数: flat(f['月收货人数']), 卖点: flat(f['卖点']),
    }, { searchKeyword: '' });
    const v = built[attr] ?? [];
    if (v.includes('不适用')) continue;
    if (!v.includes('无注明')) { inVocab += 1; continue; }
    if (words.some((w) => title.includes(w))) outside += 1;
    else none += 1;
  }
  const valid = inVocab + outside + none;
  console.log(
    attr.padEnd(8)
    + String(inVocab).padStart(10)
    + String(outside).padStart(12)
    + String(none).padStart(10)
    + `   ${(100 * inVocab / valid).toFixed(1)}% → ${(100 * (inVocab + outside) / valid).toFixed(1)}%`,
  );
}
console.log('\n注：词表外候选仅为「同义/近义表达」的宽口径统计，用于判断收益上限，不构成改口径的建议。');
