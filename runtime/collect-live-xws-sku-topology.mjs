import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildXwsSkuTopology } from './xws-sku-topology-core.mjs';
import { updateSkuBatchIndex } from './xws-sku-batch-index.mjs';

// 本项目专用 CDP 代理是 3457（见 docs/ops/PROJECT-BROWSER-AND-PORTS.md 与 AGENTS.md）。
// 3456 属于另一个项目、挂在用户的日常 Edge 上且**没有小旺神**——默认值写成它会静默指向错目标。
const DEFAULT_PROXY = 'http://127.0.0.1:3457';

function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const source = await response.text();
  let body;
  try {
    body = source ? JSON.parse(source) : {};
  } catch {
    throw new Error('Proxy returned non-JSON');
  }
  if (!response.ok || body?.error) throw new Error(String(body?.error || response.status));
  return body;
}

function required(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(name + ' is required');
  return normalized;
}

export function parseTopologyArgs(argv = []) {
  const options = { proxy: DEFAULT_PROXY };
  const valueOptions = new Set([
    '--product-id', '--payload-file', '--output-directory', '--target-label', '--proxy',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!valueOptions.has(argument)) throw new Error('Unknown argument: ' + argument);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(argument + ' requires a value');
    const key = argument.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    options[key] = value;
    index += 1;
  }
  options.productId = required(options.productId, '--product-id');
  options.payloadFile = required(options.payloadFile, '--payload-file');
  options.outputDirectory = required(options.outputDirectory, '--output-directory');
  options.targetLabel = String(options.targetLabel ?? `xws-sku-batch-${options.productId}`).trim();
  options.proxy = required(options.proxy, '--proxy');
  return options;
}

const PAGE_EXPRESSION = [
  '(async () => {',
  '  const hash = async (value) => {',
  '    const bytes = new TextEncoder().encode(String(value == null ? "" : value));',
  '    const digest = await crypto.subtle.digest("SHA-256", bytes);',
  '    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");',
  '  };',
  '  const data = window.__ICE_APP_CONTEXT__?.loaderData?.home?.data?.res;',
  '  const props = data?.skuBase?.props;',
  '  const skus = data?.skuBase?.skus;',
  '  const sku2info = data?.skuCore?.sku2info;',
  '  if (!Array.isArray(props) || !Array.isArray(skus) || !sku2info || typeof sku2info !== "object") {',
  '    return { ok: false };',
  '  }',
  '  const optionIndexes = new Map();',
  '  const properties = await Promise.all(props.map(async (property, propertyIndex) => {',
  '    const values = await Promise.all((property?.values || []).map(async (value, valueIndex) => {',
  '      const optionKey = String(property?.pid) + ":" + String(value?.vid);',
  '      optionIndexes.set(optionKey, [propertyIndex, valueIndex]);',
  '      return { valueIndex, nameSha256: await hash(value?.name), empty: Boolean(value?.empty) };',
  '    }));',
  '    return { propertyIndex, propertyNameSha256: await hash(property?.name), values };',
  '  }));',
  '  const skuEntries = skus.map((sku) => {',
  '    const skuId = String(sku?.skuId ?? "");',
  '    const propertyValuePairs = String(sku?.propPath ?? "").split(";").filter(Boolean)',
  '      .map((segment) => optionIndexes.get(segment) || null);',
  '    const propertyValueIndexes = propertyValuePairs.every(Boolean)',
  '      ? propertyValuePairs.slice().sort((left, right) => left[0] - right[0]).map((pair) => pair[1])',
  '      : [];',
  '    const info = sku2info[skuId] || {};',
  '    return {',
  '      skuId,',
  '      propertyValueIndexes,',
  '      hasSubPrice: Object.prototype.hasOwnProperty.call(info, "subPrice"),',
  '      hasPriceRepresentation: Object.prototype.hasOwnProperty.call(info, "subPrice")',
  '        || Boolean(info?.price && typeof info.price === "object" && String(info.price.priceMoney || "").trim()),',
  '    };',
  '  });',
  '  return {',
  '    ok: true,',
  '    productId: new URL(location.href).searchParams.get("id"),',
  '    properties,',
  '    skuEntries,',
  '  };',
  '})()',
].join('\n');

export async function main(argv = process.argv.slice(2)) {
  const options = parseTopologyArgs(argv);
  const payloadFile = resolve(options.payloadFile);
  const outputDirectory = resolve(options.outputDirectory);
  if (!existsSync(payloadFile)) throw new Error('SKU payload file is unavailable: ' + payloadFile);
  const rawPayload = await readFile(payloadFile, 'utf8');
  const targets = await requestJson(options.proxy + '/targets');
  const target = targets.find((item) => (
    item.type === 'page'
    && (!options.targetLabel || item.automationLabel === options.targetLabel || !item.automationLabel)
    && String(item.url || '').includes('id=' + options.productId)
  ));
  if (!target) throw new Error('Expected product target is unavailable: ' + options.productId);
  const response = await requestJson(options.proxy + '/eval?target=' + encodeURIComponent(target.targetId), {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: PAGE_EXPRESSION,
  });
  const pageSnapshot = response.value ?? response;
  if (!pageSnapshot?.ok || pageSnapshot.productId !== options.productId) {
    throw new Error('Product SKU structure is unavailable: ' + options.productId);
  }
  const topology = buildXwsSkuTopology(rawPayload, pageSnapshot);
  const topologyContent = JSON.stringify(topology, null, 2) + '\n';
  const topologyPath = resolve(outputDirectory, `xws-sku-topology-${options.productId}.json`);
  const receiptPath = resolve(outputDirectory, `xws-sku-topology-receipt-${options.productId}.json`);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(topologyPath, topologyContent, 'utf8');
  const receipt = {
    version: 'xws-tmall-sku-topology-receipt-v1',
    capturedAt: new Date().toISOString(),
    productId: options.productId,
    payloadFile: basename(payloadFile),
    payloadSha256: sha256(rawPayload),
    pageSnapshotSha256: sha256(JSON.stringify(pageSnapshot)),
    topologySha256: sha256(topologyContent),
    propertyCount: topology.properties.length,
    validCombinationCount: topology.validCombinations.length,
    disclosure: 'The topology file contains only payload hashes, indexes, empty markers, and SKU IDs. No raw SKU option text, browser session data, or credentials are written.',
  };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  const batchIndexPath = await updateSkuBatchIndex({
    directory: outputDirectory,
    source: { productId: options.productId },
    artifacts: { payload: payloadFile, topology: topologyPath, topologyReceipt: receiptPath },
    status: 'TOPOLOGY_CAPTURED',
    updatedAt: receipt.capturedAt,
  });
  console.log(JSON.stringify({
    topologyPath,
    receiptPath,
    productId: receipt.productId,
    payloadSha256: receipt.payloadSha256,
    topologySha256: receipt.topologySha256,
    propertyCount: receipt.propertyCount,
    validCombinationCount: receipt.validCombinationCount,
    batchIndexPath,
  }, null, 2));
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
