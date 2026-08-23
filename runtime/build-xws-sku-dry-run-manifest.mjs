import { createHash } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function required(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(name + ' is required');
  return normalized;
}

function parseJson(value, name) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(name + ' is not valid JSON');
  }
}

function productIdFromUrl(value) {
  try {
    return new URL(String(value ?? '')).searchParams.get('id') ?? '';
  } catch {
    return '';
  }
}

export function buildSkuEvidence({ rawPayload, captureReceipt, topologyText, topologyReceipt }) {
  const payloadSha256 = sha256(rawPayload);
  const topologySha256 = sha256(topologyText);
  const topology = parseJson(topologyText, 'SKU topology');
  const metadata = captureReceipt?.metadata ?? {};

  if (payloadSha256 !== required(captureReceipt?.payloadSha256, 'capture payload hash')) {
    throw new Error('Captured payload hash does not match the raw payload');
  }
  if (payloadSha256 !== required(topology?.payloadSha256, 'topology payload hash')
    || payloadSha256 !== required(topologyReceipt?.payloadSha256, 'topology receipt payload hash')) {
    throw new Error('Topology payload hash does not match the raw payload');
  }
  if (topologySha256 !== required(topologyReceipt?.topologySha256, 'topology receipt topology hash')) {
    throw new Error('topology hash does not match the topology receipt');
  }

  const productId = required(metadata.productId, 'captured product ID');
  if (productId !== required(topologyReceipt?.productId, 'topology receipt product ID')) {
    throw new Error('Topology receipt product ID differs from the captured payload');
  }
  if (productIdFromUrl(metadata.productUrl) !== productId) {
    throw new Error('Captured product URL does not match the captured product ID');
  }
  if (topology?.version !== 'xws-tmall-sku-topology-v1') {
    throw new Error('Unsupported SKU topology version');
  }
  if (!Array.isArray(topology.properties) || topology.properties.length !== 2
    || topology.properties.length !== Number(topologyReceipt?.propertyCount)) {
    throw new Error('Topology property count does not match the topology receipt');
  }
  if (!Array.isArray(topology.validCombinations)
    || topology.validCombinations.length !== Number(topologyReceipt?.validCombinationCount)) {
    throw new Error('Topology SKU combination count does not match the topology receipt');
  }
  if (required(metadata.validity, 'captured validity') !== '是') {
    throw new Error('Captured product was not a valid competitor');
  }
  const classification = required(metadata.classification, 'captured classification');
  if (!/^(?:A-|B-)/u.test(classification)) {
    throw new Error('Captured product was not an A or B competitor');
  }

  return {
    version: 'xws-sku-evidence-v1',
    captureId: required(captureReceipt?.captureId, 'capture ID'),
    payloadSha256,
    topologySha256,
    topologyVersion: topology.version,
    propertyCount: topology.properties.length,
    validCombinationCount: topology.validCombinations.length,
    source: {
      mainRecordId: required(metadata.recordId, 'captured main record ID'),
      productId,
      productUrl: required(metadata.productUrl, 'captured product URL'),
      capturedValidity: metadata.validity,
      capturedClassification: classification,
    },
  };
}
