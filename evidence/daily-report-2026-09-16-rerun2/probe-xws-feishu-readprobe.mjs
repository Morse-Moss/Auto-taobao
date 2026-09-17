// 只读探针：读飞书底单记录（名称→字段 id 解析，不改任何数据）
const PROXY = 'http://127.0.0.1:19023';
const APP = 'X02Xb7fHba7mU9sr8uIcRlExn6b';
const TABLE = 'tbl84ZGwLQKyLxV3';
const VIEW = 'vewwg0rhjo';

const targets = await fetch(`${PROXY}/targets`).then(r => r.json());
const page = targets.filter(t => t.type === 'page' && t.url.includes(`/base/${APP}`));
if (page.length !== 1) { console.log('PAGE_COUNT=' + page.length); process.exit(1); }
const target = page[0];

const expression = `(() => {
  const base = window.bitableStore?.modelOperator?.base;
  if (!base) return JSON.stringify({ error: 'bitable model not ready' });
  const table = Object.values(base.tables || {}).find(item => item?.id === ${JSON.stringify(TABLE)});
  if (!table) return JSON.stringify({ error: 'authorized table not loaded' });
  const view = Object.values(table.views || {}).find(item => item?.id === ${JSON.stringify(VIEW)});
  const byName = {};
  for (const f of Object.values(table.fields || {})) if (f && f.name) byName[f.name] = f.id;
  const dateId = byName['统计日期'], shopId = byName['店铺名称'];
  const map = table.records || table.recordsMap || {};
  const rows = Object.entries(map).filter(([, v]) => v).map(([rid, r]) => {
    const f = r.fields || r;
    const pick = (id) => {
      if (!id) return null;
      const cell = f[id];
      if (cell == null) return null;
      const v = (cell && typeof cell === 'object' && 'value' in cell) ? cell.value : cell;
      return v;
    };
    const epoch = pick(dateId);
    const ms = Array.isArray(epoch) ? (epoch[0] && (epoch[0].value ?? epoch[0])) : epoch;
    const d = typeof ms === 'number' ? new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10) : null;
    const sv = pick(shopId);
    let shop = null;
    if (Array.isArray(sv)) shop = sv.map(x => (x && (x.text ?? x.value ?? x)) || '').join('').trim();
    else if (sv && typeof sv === 'object') shop = String(sv.text ?? sv.value ?? '');
    else shop = sv == null ? null : String(sv);
    return { recordId: rid, date: d, shop };
  });
  return JSON.stringify({
    baseName: base.name, tableName: table.name,
    recordsNum: table.recordsNum, rowCount: rows.length,
    dateFieldId: dateId, shopFieldId: shopId,
    viewSortInfo: view?.property?.sortInfo ?? null,
    rows,
  });
})()`;

const response = await fetch(`${PROXY}/eval?target=${encodeURIComponent(target.targetId)}`, { method: 'POST', body: expression });
const payload = await response.json();
if (!response.ok) { console.log('EVAL_FAILED', response.status, payload.error); process.exit(1); }
const p = JSON.parse(payload.value);
console.log('baseName =', p.baseName, '| tableName =', p.tableName);
console.log('recordsNum =', p.recordsNum, '| rowCount =', p.rowCount);
console.log('dateFieldId =', p.dateFieldId, '| shopFieldId =', p.shopFieldId, '| sortInfo =', JSON.stringify(p.viewSortInfo));
for (const r of (p.rows || []).sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
  console.log('  ', r.date, '|', r.shop, '|', r.recordId);
}
