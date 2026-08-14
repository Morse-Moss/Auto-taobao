#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPE_NAMES = new Map([
  [1, 'text'],
  [2, 'number'],
  [3, 'single-select'],
  [5, 'date'],
  [11, 'person'],
  [13, 'phone'],
  [15, 'url'],
  [17, 'attachment'],
  [18, 'relation'],
  [20, 'formula'],
  [21, 'lookup'],
  [22, 'location'],
  [23, 'group-chat'],
  [1001, 'created-time'],
  [1002, 'modified-time'],
  [1003, 'created-by'],
  [1004, 'modified-by'],
  [1005, 'auto-number'],
]);

export function mapVisibleFields(fields, visibleFieldIds) {
  return visibleFieldIds.map((id, index) => {
    const field = fields[id];
    if (!field) throw new Error(`visible field not found: ${id}`);
    return {
      order: index + 1,
      id,
      name: field.name,
      type: field.type,
      typeName: TYPE_NAMES.get(field.type) || `unknown-${field.type}`,
    };
  });
}

function parseArgs(argv) {
  const args = { proxy: 'http://127.0.0.1:3456' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--target') args.target = argv[++i];
    else if (key === '--url-fragment') args.urlFragment = argv[++i];
    else if (key === '--proxy') args.proxy = argv[++i];
    else if (key === '--help') args.help = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  return args;
}

async function inspect({ proxy, target, urlFragment }) {
  const targets = await fetch(`${proxy}/targets`).then(r => r.json());
  const matches = targets.filter(t => t.type === 'page' && (
    target ? t.targetId === target : urlFragment && t.url.includes(urlFragment)
  ));
  if (matches.length !== 1) throw new Error(`expected one matching page target, got ${matches.length}`);

  const page = matches[0];
  const pageUrl = new URL(page.url);
  const tableId = pageUrl.searchParams.get('table');
  const viewId = pageUrl.searchParams.get('view');
  if (!tableId || !viewId) throw new Error('target URL must include table and view parameters');

  const expression = `(() => {
    const base = window.bitableStore?.modelOperator?.base;
    if (!base) throw new Error('Feishu bitable model is not ready');
    const table = Object.values(base.tables || {}).find(t => t?.id === ${JSON.stringify(tableId)});
    if (!table) throw new Error('table not found: ' + ${JSON.stringify(tableId)});
    const view = Object.values(table.views || {}).find(v => v?.id === ${JSON.stringify(viewId)});
    if (!view) throw new Error('view not found: ' + ${JSON.stringify(viewId)});
    const fields = Object.fromEntries(Object.values(table.fields || {}).filter(Boolean).map(f => [f.id, {
      id: f.id, name: f.name, type: f.type
    }]));
    return JSON.stringify({
      baseName: base.name,
      tableId: table.id,
      tableName: table.name,
      viewId: view.id,
      viewName: view.name,
      recordsNum: table.recordsNum,
      fields,
      visibleFieldIds: view._visibleFieldIds || view.property?.fields || []
    });
  })()`;

  const response = await fetch(`${proxy}/eval?target=${encodeURIComponent(page.targetId)}`, {
    method: 'POST',
    body: expression,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `eval failed with HTTP ${response.status}`);
  const model = JSON.parse(payload.value);
  return {
    targetId: page.targetId,
    url: page.url,
    baseName: model.baseName,
    tableId: model.tableId,
    tableName: model.tableName,
    viewId: model.viewId,
    viewName: model.viewName,
    recordsNum: model.recordsNum,
    fields: mapVisibleFields(model.fields, model.visibleFieldIds),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.target && !args.urlFragment)) {
    console.log('Usage: node inspect-feishu-fields.mjs (--target ID | --url-fragment TEXT) [--proxy URL]');
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  console.log(JSON.stringify(await inspect(args), null, 2));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
