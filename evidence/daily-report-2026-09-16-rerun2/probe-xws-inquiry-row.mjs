// 只在询单表里找 2026-09-16 那几行（独立 tab，读完即关）
const PROXY = 'http://127.0.0.1:19023';
const APP = 'X02Xb7fHba7mU9sr8uIcRlExn6b';
const TABLE = 'tblm9Hx7R9A1YoLC';
const TARGET_EPOCH = 1789488000000; // 2026-09-16（北京时间当天 00:00）
const url = `https://kcne618basvj.feishu.cn/base/${APP}?table=${TABLE}`;

const opened = await fetch(`${PROXY}/new?url=${encodeURIComponent(url)}`).then(r => r.json());
const targetId = opened.targetId;
await new Promise(r => setTimeout(r, 7000));

const expression = `(() => {
  const base = window.bitableStore?.modelOperator?.base;
  const table = Object.values(base.tables || {}).find(item => item?.id === ${JSON.stringify(TABLE)});
  const byName = {};
  for (const f of Object.values(table.fields || {})) if (f && f.name) byName[f.name] = f.id;
  const flat = (cell) => {
    if (cell == null) return null;
    const v = (cell && typeof cell === 'object' && 'value' in cell) ? cell.value : cell;
    if (Array.isArray(v)) return v[0];
    if (v && typeof v === 'object') return v.text ?? v.value ?? null;
    return v;
  };
  const map = table.records || {};
  const hits = [];
  for (const [rid, r] of Object.entries(map)) {
    if (!r) continue;
    const f = r.fields || r;
    const raw = flat(f[byName['日期']]);
    if (Number(raw) === ${TARGET_EPOCH}) {
      hits.push({ recordId: rid, dateRaw: Number(raw), 店铺: flat(f[byName['店铺']]),
        询单量: flat(f[byName['询单量']]), 同层同行询单量: flat(f[byName['同层同行询单量']]),
        otherNonEmpty: Object.entries(f).filter(([k, c]) => k !== byName['询单量'] && k !== byName['同层同行询单量']
          && flat(c) !== null && flat(c) !== '' && flat(c) !== 0).length });
    }
  }
  return JSON.stringify({ recordsNum: table.recordsNum, hits });
})()`;

const r = await fetch(`${PROXY}/eval?target=${encodeURIComponent(targetId)}`, { method: 'POST', body: expression });
const payload = await r.json();
console.log(r.ok ? JSON.stringify(JSON.parse(payload.value), null, 1) : 'EVAL_FAILED ' + payload.error);

const closed = await fetch(`${PROXY}/close?target=${encodeURIComponent(targetId)}`, { method: 'POST', body: '' });
console.log('closed', closed.status, (await closed.text()).slice(0, 80));
