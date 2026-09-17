// 独立回读 + 截图（只读）
import { writeFileSync } from 'node:fs';
const PROXY = 'http://127.0.0.1:19023';
const APP = 'X02Xb7fHba7mU9sr8uIcRlExn6b';
const TABLE = 'tbl84ZGwLQKyLxV3';
const VIEW = 'vewwg0rhjo';

const targets = await fetch(`${PROXY}/targets`).then(r => r.json());
const page = targets.filter(t => t.type === 'page' && t.url.includes(`/base/${APP}`));
if (page.length !== 1) { console.log('PAGE_COUNT=' + page.length); process.exit(1); }
const target = page[0];
console.log('feishu url:', target.url);

const expression = `(() => {
  const base = window.bitableStore?.modelOperator?.base;
  const table = Object.values(base.tables || {}).find(item => item?.id === ${JSON.stringify(TABLE)});
  const view = Object.values(table.views || {}).find(item => item?.id === ${JSON.stringify(VIEW)});
  const byName = {};
  for (const f of Object.values(table.fields || {})) if (f && f.name) byName[f.name] = f.id;
  const map = table.records || {};
  const flat = (cell) => {
    if (cell == null) return null;
    const v = (cell && typeof cell === 'object' && 'value' in cell) ? cell.value : cell;
    if (Array.isArray(v)) return v.map(x => (x && (x.text ?? x.value ?? x)) || '').join('').trim();
    if (v && typeof v === 'object') return v.text ?? v.value ?? null;
    return v;
  };
  const rows = Object.entries(map).filter(([, v]) => v).map(([rid, r]) => {
    const f = r.fields || r;
    const epoch = flat(f[byName['统计日期']]);
    const ms = Array.isArray(epoch) ? epoch[0] : epoch;
    return { recordId: rid,
      date: typeof ms === 'number' ? new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10) : null,
      shop: flat(f[byName['店铺名称']]),
      derivedShop: flat(f[byName['店铺']]),
      kwScene: flat(f[byName['关键词推广二级场景ID']] ?? f[byName['关键词推广场景ID']]),
      auScene: flat(f[byName['人群推广二级场景ID']] ?? f[byName['人群推广场景ID']]),
      inquiry: flat(f[byName['询单量']]),
      peer: flat(f[byName['同层同行询单量']]),
    };
  });
  return JSON.stringify({ recordsNum: table.recordsNum, rowCount: rows.length, sortInfo: view?.property?.sortInfo ?? null, rows });
})()`;

const response = await fetch(`${PROXY}/eval?target=${encodeURIComponent(target.targetId)}`, { method: 'POST', body: expression });
const payload = await response.json();
if (!response.ok) { console.log('EVAL_FAILED', response.status, payload.error); process.exit(1); }
const p = JSON.parse(payload.value);
console.log('recordsNum =', p.recordsNum, '| rowCount =', p.rowCount, '| sortInfo =', JSON.stringify(p.sortInfo));
for (const r of p.rows) {
  console.log('  ', r.date, '|', r.shop, '|', r.recordId, '| 店铺=' + JSON.stringify(r.derivedShop), '| 询单量=' + JSON.stringify(r.inquiry), '| 同行=' + JSON.stringify(r.peer));
}

const shot = await fetch(`${PROXY}/screenshot?target=${encodeURIComponent(target.targetId)}&file=${encodeURIComponent('D:/Retire/sycm-automation/evidence/daily-report-2026-09-16-rerun2/feishu-source-table-after-repush.png')}`);
console.log('screenshot:', (await shot.text()).slice(0, 160));
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/xws-readback.json', JSON.stringify(p, null, 2), 'utf8');
