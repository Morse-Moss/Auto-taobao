#!/usr/bin/env node
const ROOT = 'https://open.feishu.cn/open-apis';
const APP = process.env.FEISHU_APP_TOKEN || 'OWebbPUcBa7B8JseYLccQCy9nkf';
const TABLE = process.env.FEISHU_TABLE_ID || 'tbl7u5CUYiRei7AQ';
const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
if (!appId || !appSecret) throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required');

const auth = await fetch(`${ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const authBody = await auth.json();
if (!auth.ok || authBody.code !== 0) throw new Error(`Feishu auth failed: ${auth.status} ${authBody.code} ${authBody.msg}`);
const token = authBody.tenant_access_token;
const request = async (method, path, body) => {
  const response = await fetch(`${ROOT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  if (!response.ok || payload.code !== 0) throw new Error(`Feishu API failed: ${method} ${path} ${response.status} ${payload.code} ${payload.msg}`);
  return payload.data ?? {};
};

const fieldsPayload = await request('GET', `/bitable/v1/apps/${APP}/tables/${TABLE}/fields?page_size=100`);
const fields = fieldsPayload.items ?? [];
const byName = new Map(fields.map((field) => [field.field_name, field]));
const requireField = (name) => { const field = byName.get(name); if (!field) throw new Error(`Missing field: ${name}`); return field; };
const ref = (name) => `bitable::$table[${TABLE}].$field[${requireField(name).field_id}]`;
const title = ref('商品标题');
const rawMonthly = ref('月收货人数');
const price = ref('价格');
const invalidTerms = ['洗脚池', '洗脚盆', '泡脚盆', '足浴', '宠物', '狗洗澡', '猫洗澡', '婴儿', '新生儿'];
const bathtubTerms = ['浴缸', '浴桶', '浴盆', '洗澡盆'];
const accessoryTerms = ['龙头', '花洒套装', '角阀', '下水器', '排水器', '盖板', '扶手', '靠枕'];
const any = (terms) => `OR(${terms.map((term) => `FIND(${JSON.stringify(term)},${title})>0`).join(',')})`;
const invalid = any(invalidTerms);
const bathtub = any(bathtubTerms);
const accessory = any(accessoryTerms);
const validity = `IF(${invalid},"否",IF(${accessory},"否",IF(${bathtub},"是","待确认")))`;
const validGate = `(${validity}="是")`;
const monthly = ref('月收货人数计算值');
const amount = ref('月收货金额');

const operations = [
  { name: '数据开始日期', type: 5, property: { date_formatter: 'yyyy/MM/dd', auto_fill: false } },
  { name: '数据结束日期', type: 5, property: { date_formatter: 'yyyy/MM/dd', auto_fill: false } },
  { name: '是否有效竞品', type: 20, property: { formatter: '', formula_expression: validity } },
  { name: '月收货人数计算值', type: 20, property: { formatter: '0', formula_expression: `IF(NOT(${validGate}),"",IFERROR(VALUE(SUBSTITUTE(${rawMonthly},"+","")),""))` } },
  { name: '月收货金额', type: 20, property: { formatter: '0.0', formula_expression: `IF(OR(NOT(${validGate}),ISBLANK(${price}),${monthly}=""),"",${price}*${monthly})` } },
  { name: '竞品分类', type: 20, property: { formatter: '', formula_expression: `IF(OR(NOT(${validGate}),ISBLANK(${price})),"不适用",IF(AND(${monthly}>=80,${amount}>=200000),"A-爆款竞品",IF(AND(FIND("人造石",${title})>0,${monthly}>=10),"B-高价值竞品",IF(${price}>=8000,"C-差异化竞品",IF(${price}<1000,"D-价格/流量型竞品","无分类")))))` } },
  { name: '数据状态', type: 20, property: { formatter: '', formula_expression: `IF(NOT(${validGate}),"",IF(${monthly}="","部分待补","可用"))` } },
  { name: '待补数据项', type: 20, property: { formatter: '', formula_expression: `IF(NOT(${validGate}),"",IF(${monthly}="","月收货人数精确值",""))` } },
];

const plan = operations.map((operation) => {
  const current = requireField(operation.name);
  return { ...operation, fieldId: current.field_id, currentType: current.type, changed: current.type !== operation.type || JSON.stringify(current.property ?? null) !== JSON.stringify(operation.property) };
});
console.error(JSON.stringify({ mode: 'APPLY', table: TABLE, operations: plan.map(({ name, fieldId, currentType, type, changed }) => ({ name, fieldId, currentType, targetType: type, changed })) }, null, 2));
for (const operation of plan) {
  if (!operation.changed) continue;
  await request('PUT', `/bitable/v1/apps/${APP}/tables/${TABLE}/fields/${operation.fieldId}`, {
    field_name: operation.name,
    type: operation.type,
    property: operation.property,
  });
}

const afterPayload = await request('GET', `/bitable/v1/apps/${APP}/tables/${TABLE}/fields?page_size=100`);
const after = new Map((afterPayload.items ?? []).map((field) => [field.field_name, field]));
const mismatches = plan.filter((operation) => {
  const field = after.get(operation.name);
  return !field || field.type !== operation.type || (operation.type === 20 && field.property?.formula_expression !== operation.property.formula_expression);
}).map((operation) => operation.name);
if (mismatches.length) throw new Error(`Schema verification mismatches: ${mismatches.join(', ')}`);
console.log(JSON.stringify({ mode: 'APPLIED_AND_VERIFIED', changedFields: plan.filter((operation) => operation.changed).map((operation) => operation.name), formulaFields: plan.filter((operation) => operation.type === 20).map((operation) => operation.name), mismatches: [] }, null, 2));
