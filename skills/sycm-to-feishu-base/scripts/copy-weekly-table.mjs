#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PROXY = 'http://127.0.0.1:3456';
const VALUE_OPTIONS = new Set([
  'base-url',
  'source-table-id',
  'source-table-name',
  'new-table-name',
  'proxy',
  'confirm-base',
]);

const optionKey = (name) => name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());

export function parseOptions(argv) {
  const options = { proxy: DEFAULT_PROXY, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (name === 'apply') {
      options.apply = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options[optionKey(name)] = value;
    index += 1;
  }

  const { baseUrl, sourceTableId, sourceTableName, newTableName } = options;
  if (!baseUrl || !sourceTableId || !sourceTableName || !newTableName) {
    throw new Error('Required: --base-url, --source-table-id, --source-table-name, --new-table-name');
  }

  const parsed = new URL(baseUrl);
  const match = parsed.pathname.match(/^\/base\/([^/]+)$/u);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.feishu.cn') || !match) {
    throw new Error('Base URL must be an https://*.feishu.cn/base/<app-token> URL');
  }
  const appToken = match[1];
  const urlTableId = parsed.searchParams.get('table');
  if (urlTableId && urlTableId !== sourceTableId) {
    throw new Error('Base URL table does not match --source-table-id');
  }
  if (options.apply && !options.confirmBase) {
    throw new Error('Write mode requires --confirm-base <app-token>');
  }
  if (options.apply && options.confirmBase !== appToken) {
    throw new Error('--confirm-base does not match the Base app token');
  }

  return {
    baseUrl,
    appToken,
    sourceTableId,
    sourceTableName,
    newTableName,
    proxy: options.proxy,
    apply: options.apply,
    ...(options.confirmBase ? { confirmBase: options.confirmBase } : {}),
  };
}

function fieldIdMap(snapshot) {
  const map = new Map();
  const names = new Set();
  for (const field of snapshot.fields ?? []) {
    if (!field?.id || !field?.name) throw new Error('Every field requires an id and name');
    if (names.has(field.name)) throw new Error(`Duplicate field name: ${field.name}`);
    names.add(field.name);
    map.set(field.id, field.name);
  }
  return map;
}

function normalizeString(value, snapshot, ids) {
  if (value === snapshot.id) return '<SELF_TABLE>';
  if (ids.has(value)) return `<FIELD:${ids.get(value)}>`;
  return value
    .replace(/\$table\[([^\]]+)\]/gu, (_, id) => `$table[${id === snapshot.id ? '<SELF_TABLE>' : id}]`)
    .replace(/\$field\[([^\]]+)\]/gu, (_, id) => `$field[${ids.has(id) ? `<FIELD:${ids.get(id)}>` : id}]`);
}

function normalizeValue(value, snapshot, ids, { omitRecords = false } = {}) {
  if (typeof value === 'string') return normalizeString(value, snapshot, ids);
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, snapshot, ids, { omitRecords }));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    // Feishu regenerates backlink identity/name when a table is copied. The
    // forward relation target (tableId/baseId/multiple) remains authoritative.
    .filter(([key, item]) => !(omitRecords && key === 'records') &&
      key !== 'backFieldId' && key !== 'backFieldName' &&
      !(key === 'filterInfo' && item == null))
    .map(([key, item]) => [normalizeString(key, snapshot, ids), normalizeValue(item, snapshot, ids, { omitRecords })])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeExInfo(exInfo, snapshot, ids) {
  if (!exInfo || (!exInfo.aiPrompt && !exInfo.customOpenTypeData)) return null;
  return normalizeValue({
    aiPrompt: exInfo.aiPrompt ?? null,
    customOpenTypeData: exInfo.customOpenTypeData ?? null,
  }, snapshot, ids);
}

function normalizedStructure(snapshot) {
  const ids = fieldIdMap(snapshot);
  return {
    // The frontend model does not guarantee object-key iteration order after
    // a copy. Field identity is the field name; view.visibleFieldIds below
    // remains the authoritative column order.
    fields: (snapshot.fields ?? []).map((field) => ({
      name: field.name,
      type: field.type,
      property: normalizeValue(field.property ?? null, snapshot, ids),
      exInfo: normalizeExInfo(field.exInfo, snapshot, ids),
    })).sort((left, right) => left.name.localeCompare(right.name)),
    views: (snapshot.views ?? []).map((view) => ({
      name: view.name,
      type: view.type,
      visibleFieldIds: (view.visibleFieldIds ?? []).map((id) => ids.has(id) ? `<FIELD:${ids.get(id)}>` : id),
      property: normalizeValue(view.property ?? null, snapshot, ids, { omitRecords: true }),
    })),
  };
}

export function verifyStructureCopy(source, copy) {
  if (Number(copy.recordsNum ?? 0) !== 0) {
    throw new Error(`Copied weekly table must be empty; received ${copy.recordsNum}`);
  }
  const sourceStructure = normalizedStructure(source);
  const copyStructure = normalizedStructure(copy);
  if (JSON.stringify(sourceStructure) !== JSON.stringify(copyStructure)) {
    throw new Error('Copied weekly table structure differs from the source');
  }
  return {
    fieldCount: copyStructure.fields.length,
    formulaFieldCount: copyStructure.fields.filter((field) => field.type === 20).length,
    aiFieldCount: copyStructure.fields.filter((field) => field.exInfo?.aiPrompt || field.exInfo?.customOpenTypeData).length,
    viewCount: copyStructure.views.length,
    copiedRecordCount: 0,
  };
}

export function isCopyCloudSettled(previousBaseRev, state) {
  return Boolean(state?.tableExists && !state?.saving &&
    Number.isFinite(Number(state?.baseRev)) && Number(state.baseRev) > Number(previousBaseRev));
}

async function proxyJson(proxy, endpoint, init) {
  const response = await fetch(`${proxy}${endpoint}`, init);
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Proxy request failed: ${response.status} ${endpoint}`);
  }
  return payload;
}

function matchingFeishuTargets(targets, appToken, tableId) {
  return (Array.isArray(targets) ? targets : []).filter((target) => {
    if (target.type !== 'page' || !target.targetId || !target.url) return false;
    let parsed;
    try {
      parsed = new URL(target.url);
    } catch {
      return false;
    }
    return parsed.hostname.endsWith('.feishu.cn') &&
      parsed.pathname === `/base/${appToken}` &&
      parsed.searchParams.get('table') === tableId;
  });
}

export async function resolveFeishuTarget({ targets, appToken, tableId, createBaseTab, listTargets }) {
  let matches = matchingFeishuTargets(targets, appToken, tableId);
  if (matches.length === 0) {
    await createBaseTab();
    matches = matchingFeishuTargets(await listTargets(), appToken, tableId);
  }
  if (matches.length !== 1) {
    throw new Error(`Expected one open Feishu page for Base ${appToken} table ${tableId}; received ${matches.length}`);
  }
  return matches[0];
}

async function discoverTarget({ proxy, appToken, sourceTableId, baseUrl }) {
  const targetUrl = new URL(baseUrl);
  targetUrl.searchParams.set('table', sourceTableId);
  const target = await resolveFeishuTarget({
    targets: await proxyJson(proxy, '/targets'),
    appToken,
    tableId: sourceTableId,
    createBaseTab: () => proxyJson(proxy, `/new?url=${encodeURIComponent(targetUrl.toString())}`),
    listTargets: () => proxyJson(proxy, '/targets'),
  });
  return target.targetId;
}

function humanRequired(message) {
  const error = new Error(message);
  error.code = 'HUMAN_REQUIRED';
  return error;
}

export async function waitForFeishuModel({ inspect, sleep, timeoutMs = 60000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await inspect();
    const visible = [...(state?.visibleTexts ?? []), state?.bodyText ?? ''].filter(Boolean).join('\n');
    if (/验证码|滑块验证|扫码登录|短信验证|安全验证|账号异常|风控|访问受限|无权限|权限不足|请登录/u.test(visible)) {
      throw humanRequired('Feishu Base requires login, verification, security, or permission handling');
    }
    if (state?.ready && state?.targetId) return state.targetId;
    await sleep(250);
  }
  throw new Error('Timed out waiting for the Feishu Bitable frontend model');
}

async function discoverReadyTarget(options) {
  return waitForFeishuModel({
    inspect: async () => {
      const targetId = await discoverTarget(options);
      const payload = await proxyJson(options.proxy, `/eval?target=${encodeURIComponent(targetId)}`, {
        method: 'POST',
        body: `(() => {
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
              && rect.width > 0 && rect.height > 0;
          };
          const risk = /验证码|滑块验证|扫码登录|短信验证|安全验证|账号异常|风控|访问受限|无权限|权限不足|请登录/u;
          const visibleTexts = [...document.querySelectorAll('[role=dialog],button,a,[class*=captcha],[class*=Captcha],[class*=verify],[class*=Verify]')]
            .filter(visible).map((element) => (element.innerText || '').trim())
            .filter((text) => text && text.length <= 500 && risk.test(text));
          return {
            ready: Boolean(window.bitableStore?.modelOperator?.base),
            visibleTexts,
            bodyText: window.bitableStore?.modelOperator?.base ? '' : (document.body?.innerText || '').slice(0, 2000),
          };
        })()`,
      });
      return { targetId, ...(payload.value ?? {}) };
    },
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
}

async function evaluate(options, expression) {
  const target = await discoverReadyTarget(options);
  const payload = await proxyJson(options.proxy, `/eval?target=${encodeURIComponent(target)}`, {
    method: 'POST',
    body: expression,
  });
  return payload.value;
}

async function clickAt(options, selector) {
  const target = await discoverReadyTarget(options);
  return proxyJson(options.proxy, `/clickAt?target=${encodeURIComponent(target)}`, {
    method: 'POST',
    body: selector,
  });
}

async function sendKey(options, key) {
  const target = await discoverReadyTarget(options);
  return proxyJson(options.proxy, `/key?target=${encodeURIComponent(target)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
}

const tableSnapshotExpression = (selector) => `(() => {
  const base = window.bitableStore?.modelOperator?.base;
  if (!base) throw new Error('Feishu Bitable model is not ready');
  const tables = Object.values(base.tables || {}).filter(Boolean);
  const table = tables.find((item) => ${selector});
  if (!table) throw new Error('Requested table is not available');
  return JSON.stringify({
    id: table.id,
    name: table.name,
    recordsNum: table.recordsNum,
    fields: Object.values(table.fields || {}).filter(Boolean).map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      property: field.property ?? null,
      exInfo: field.exInfo ?? null,
    })),
    views: Object.values(table.views || {}).filter(Boolean).map((view) => ({
      id: view.id,
      name: view.name,
      type: view.type,
      visibleFieldIds: view._visibleFieldIds || view.property?.fields || [],
      property: view.property ?? null,
    })),
  });
})()`;

async function snapshotById(options, tableId) {
  return JSON.parse(await evaluate(options, tableSnapshotExpression(`item?.id === ${JSON.stringify(tableId)}`)));
}

async function snapshotsByName(options, tableName) {
  const value = await evaluate(options, `(() => {
    const base = window.bitableStore?.modelOperator?.base;
    if (!base) throw new Error('Feishu Bitable model is not ready');
    return JSON.stringify(Object.values(base.tables || {}).filter((item) => item?.name === ${JSON.stringify(tableName)}).map((table) => table.id));
  })()`);
  return JSON.parse(value);
}

async function baseSaveState(options, tableName) {
  return evaluate(options, `(() => {
    const base = window.bitableStore?.modelOperator?.base;
    if (!base) throw new Error('Feishu Bitable model is not ready');
    return {
      baseRev: Number(base.rev),
      saving: document.body.innerText.includes('保存中'),
      tableExists: Object.values(base.tables || {}).some((item) => item?.name === ${JSON.stringify(tableName)}),
    };
  })()`);
}

async function waitFor(check, description, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function duplicateStructure(options) {
  const selector = `.bitable-new-table-item-${options.sourceTableId} .icon-background`;
  // The current Feishu sidebar renders the menu through the button's React
  // click handler. The shared proxy's coordinate click can report success
  // while leaving that menu closed, so dispatch the exact DOM click after
  // rediscovering the source table target.
  await evaluate(options, `(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!button) throw new Error('Source table more button is missing');
    button.click();
    return true;
  })()`);
  const visibleMenuItem = `(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && rect.width > 0 && rect.height > 0;
    };
    return [...document.querySelectorAll('#bitable-contextmenu .b-menu__item')]
      .find((item) => visible(item) && (item.innerText || '').trim() === '复制数据表');
  })()`;
  await waitFor(async () => evaluate(options, `Boolean(${visibleMenuItem})`), 'copy-table menu');
  await evaluate(options, `(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && rect.width > 0 && rect.height > 0;
    };
    const item = [...document.querySelectorAll('#bitable-contextmenu .b-menu__item')]
      .find((element) => visible(element) && (element.innerText || '').trim() === '复制数据表');
    if (!item) throw new Error('Copy-table menu item is missing');
    item.click();
    return true;
  })()`);
  await waitFor(async () => evaluate(options, `Boolean(document.querySelector('.bitable-duplicate-setting-modal'))`), 'copy-table dialog');
  await evaluate(options, `(() => {
    const dialog = document.querySelector('.bitable-duplicate-setting-modal');
    if (!dialog) throw new Error('Copy-table dialog is missing');
    const input = dialog.querySelector('input[placeholder="请输入数据表名称"]');
    if (!input) throw new Error('Copy-table name input is missing');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(options.newTableName)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const labels = [...dialog.querySelectorAll('label')];
    const structureOnly = labels.find((label) => (label.innerText || '').trim() === '仅数据表结构');
    if (!structureOnly) throw new Error('Structure-only option is missing');
    const radio = structureOnly.querySelector('input[type="radio"]');
    if (!radio?.checked) structureOnly.click();
    return { name: input.value, structureOnly: Boolean(radio?.checked) };
  })()`);
  const confirmed = await evaluate(options, `(() => {
    const dialog = document.querySelector('.bitable-duplicate-setting-modal');
    const input = dialog?.querySelector('input[placeholder="请输入数据表名称"]');
    const structureOnly = [...(dialog?.querySelectorAll('label') || [])].find((label) => (label.innerText || '').trim() === '仅数据表结构');
    return Boolean(input?.value === ${JSON.stringify(options.newTableName)} && structureOnly?.querySelector('input[type="radio"]')?.checked);
  })()`);
  if (!confirmed) throw new Error('Copy-table dialog did not retain the requested name and structure-only scope');
  await evaluate(options, `(() => {
    const dialog = document.querySelector('.bitable-duplicate-setting-modal');
    const button = [...(dialog?.querySelectorAll('button') || [])].find((item) => (item.innerText || '').trim() === '复制');
    if (!button) throw new Error('Copy-table submit button is missing');
    button.click();
    return true;
  })()`);
}

export async function run(options) {
  const source = await snapshotById(options, options.sourceTableId);
  if (source.name !== options.sourceTableName) {
    throw new Error(`Source table name mismatch: ${source.name}`);
  }
  let copies = await snapshotsByName(options, options.newTableName);
  if (copies.length > 1) throw new Error(`Multiple tables named ${options.newTableName}`);
  if (!options.apply) {
    return {
      mode: 'DRY_RUN',
      appToken: options.appToken,
      sourceTableId: source.id,
      sourceTableName: source.name,
      sourceRecordCount: source.recordsNum,
      sourceFieldCount: source.fields.length,
      existingCopyCount: copies.length,
      newTableName: options.newTableName,
    };
  }

  let resumed = copies.length === 1;
  if (!resumed) {
    const beforeState = await baseSaveState(options, options.newTableName);
    await duplicateStructure(options);
    copies = await waitFor(async () => {
      const matches = await snapshotsByName(options, options.newTableName);
      return matches.length === 1 ? matches : null;
    }, 'new weekly table', 30000);
    const nameEditorActive = await evaluate(options, `(() => {
      const active = document.activeElement;
      return Boolean(active instanceof HTMLInputElement && active.closest('#J-side-bar-scroll-container'));
    })()`);
    if (nameEditorActive) await sendKey(options, 'Enter');
    await waitFor(async () => isCopyCloudSettled(
      beforeState.baseRev,
      await baseSaveState(options, options.newTableName),
    ), 'weekly table cloud save', 60000);
  }
  const copy = await snapshotById(options, copies[0]);
  const verification = verifyStructureCopy(source, copy);
  const firstViewId = copy.views[0]?.id;
  if (!firstViewId) throw new Error('Copied weekly table has no view');
  const link = new URL(options.baseUrl);
  link.searchParams.set('table', copy.id);
  link.searchParams.set('view', firstViewId);
  return {
    mode: resumed ? 'RESUMED_AND_VERIFIED' : 'COPIED_AND_VERIFIED',
    appToken: options.appToken,
    sourceTableId: source.id,
    newTableId: copy.id,
    newTableName: copy.name,
    newTableUrl: link.toString(),
    ...verification,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  console.log(JSON.stringify(await run(options), null, 2));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = error.code === 'HUMAN_REQUIRED' ? 2 : 1;
  });
}
