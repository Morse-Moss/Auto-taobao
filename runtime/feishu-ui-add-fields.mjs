#!/usr/bin/env node

const proxy = 'http://127.0.0.1:3456';
const target = process.argv[2];
const tableId = process.argv[3];
const fields = process.argv.slice(4);
const baseUrl = `https://rcndesfqro3x.feishu.cn/base/OWebbPUcBa7B8JseYLccQCy9nkf?table=${tableId}`;
if (!target || !tableId || fields.length === 0) throw new Error('usage: node feishu-ui-add-fields.mjs TARGET TABLE_ID FIELD...');

async function post(path, body) {
  const response = await fetch(`${proxy}${path}`, { method: 'POST', body });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error);
  return payload;
}

async function evalPage(expression) {
  const payload = await post(`/eval?target=${encodeURIComponent(target)}`, expression);
  if (payload.error) throw new Error(payload.error);
  return payload.value;
}

async function ensureTable() {
  const current = await evalPage('location.href');
  if (!String(current).includes(`table=${tableId}`)) {
    await fetch(`${proxy}/navigate?target=${encodeURIComponent(target)}&url=${encodeURIComponent(baseUrl)}`);
    await sleep(1200);
  }
  const checked = await evalPage('location.href');
  if (!String(checked).includes(`table=${tableId}`)) throw new Error(`target is not on ${tableId}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const name of fields) {
  await ensureTable();
  const already = await evalPage(`Boolean(store.getState().bitable.Fields?.[${JSON.stringify(tableId)}]?.fieldMap && Object.values(store.getState().bitable.Fields[${JSON.stringify(tableId)}].fieldMap).some(f => f.name === ${JSON.stringify(name)}))`);
  if (already) continue;
  let hasAdd = await evalPage("Boolean(document.querySelector('[data-e2e=bitable-add-new-filed-btn]'))");
  if (!hasAdd) {
    await evalPage("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); 'closed'");
    await post(`/clickAt?target=${encodeURIComponent(target)}`, '[data-e2e=bitable-customize-field-btn]');
    await sleep(300);
    hasAdd = await evalPage("Boolean(document.querySelector('[data-e2e=bitable-add-new-filed-btn]'))");
  }
  if (!hasAdd) throw new Error(`field panel did not open for ${name}`);
  await post(`/clickAt?target=${encodeURIComponent(target)}`, '[data-e2e=bitable-add-new-filed-btn]');
  await sleep(220);
  const encoded = JSON.stringify(name);
  const result = await evalPage(`(() => {
    const input = document.querySelector('.bitable-field-title-input__input');
    if (!input) throw new Error('field title input not found for ${encoded}');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${encoded});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`);
  if (result !== name) throw new Error(`field title did not stick: ${name} -> ${result}`);
  await post(`/clickAt?target=${encodeURIComponent(target)}`, '.bitable-button-confirm');
  await sleep(900);
}

console.log(JSON.stringify({ added: fields }, null, 2));
