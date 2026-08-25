import { createHash } from 'node:crypto';

import {
  classifySkuSpace,
  summarizeSkuDimensions,
} from '../skills/xws-to-feishu-base/scripts/competitor-v2-core.mjs';

function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function text(value) {
  return String(value ?? '').trim();
}

function required(value, name) {
  const normalized = text(value);
  if (!normalized) throw new Error(name + ' is required');
  return normalized;
}

function parsePayload(rawPayload) {
  if (typeof rawPayload !== 'string' || rawPayload.trim() === '') {
    throw new Error('SKU payload is empty');
  }
  return rawPayload.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
}

function topologyValue({ payloadLines, topology, propertyIndex, valueIndex }) {
  const property = topology?.properties?.[propertyIndex];
  const value = property?.values?.[valueIndex];
  if (!value) throw new Error('Topology value is missing: property ' + propertyIndex + ', value ' + valueIndex);
  if (!Number.isInteger(value.payloadLineIndex) || value.payloadLineIndex < 0) {
    throw new Error('Topology payload line index is invalid: property ' + propertyIndex + ', value ' + valueIndex);
  }
  const payloadValue = payloadLines[value.payloadLineIndex];
  if (!payloadValue) throw new Error('Topology payload line is missing: property ' + propertyIndex + ', value ' + valueIndex);
  if (sha256(payloadValue) !== value.payloadLineSha256) {
    throw new Error('Topology payload line hash mismatch: property ' + propertyIndex + ', value ' + valueIndex);
  }
  return { payloadValue, empty: Boolean(value.empty) };
}

function normalizeSource(source = {}) {
  return {
    productId: required(source.productId, 'productId'),
    productUrl: required(source.productUrl, 'productUrl'),
    productTitle: required(source.productTitle, 'productTitle'),
    competitorClass: required(source.competitorClass, 'competitorClass'),
    mainRecordId: required(source.mainRecordId, 'mainRecordId'),
  };
}

function parseSpecification(value, segmentCount, separator = '-', allowedSegmentCounts = [segmentCount]) {
  if (!separator) {
    if (!allowedSegmentCounts.includes(1)) {
      throw new Error('SKU specification must contain an observed number of non-empty segments');
    }
    const specification = text(value);
    if (!specification) throw new Error('SKU specification is empty');
    return { name: specification, specification };
  }
  const segments = text(value).split(separator).map((part) => part.trim()).filter(Boolean);
  if (!allowedSegmentCounts.includes(segments.length)) {
    throw new Error('SKU specification must contain an observed number of non-empty segments');
  }
  return { name: segments[0], specification: text(value) };
}

function applicableSpaceFields(space) {
  const fields = {
    空间判定状态: space.status,
    空间判定依据: space.evidence,
    采集状态: space.status === '已判定' ? '已采集' : '需人工核验',
  };
  if (space.applicableSpace) fields.适用空间 = space.applicableSpace;
  if (space.status !== '已判定') fields.待补数据项 = ['空间判定'];
  return fields;
}

export function parseXwsSkuPayload(rawPayload, source, topology) {
  const payloadLines = parsePayload(rawPayload);
  const normalizedSource = normalizeSource(source);
  if (!topology || typeof topology !== 'object') throw new Error('SKU topology is required');
  if (text(topology.version) !== 'xws-tmall-sku-topology-v1') {
    throw new Error('Unsupported SKU topology version');
  }
  if (sha256(rawPayload) !== text(topology.payloadSha256)) throw new Error('SKU payload hash mismatch');

  const propertyCount = topology.properties?.length;
  const dimensionPropertyIndex = topology.dimensionPropertyIndex;
  const specificationPropertyIndex = topology.specificationPropertyIndex;
  const specificationSegmentCount = topology.specificationSegmentCount;
  const specificationSeparator = topology.specificationSeparator == null
    ? '-'
    : String(topology.specificationSeparator);
  const specificationSegmentCounts = Array.isArray(topology.specificationSegmentCounts)
    ? topology.specificationSegmentCounts.filter(Number.isInteger)
    : [specificationSegmentCount];
  if (propertyCount !== 2 || !Number.isInteger(dimensionPropertyIndex) || !Number.isInteger(specificationPropertyIndex)
    || dimensionPropertyIndex === specificationPropertyIndex || !Number.isInteger(specificationSegmentCount)
    || specificationSegmentCount < 1) {
    throw new Error('SKU topology does not describe the verified two-property layout');
  }

  const dimensions = (topology.properties[dimensionPropertyIndex]?.values ?? []).map((_, valueIndex) => {
    const value = topologyValue({ payloadLines, topology, propertyIndex: dimensionPropertyIndex, valueIndex });
    if (value.empty) throw new Error('Dimension property contains a page-marked empty option');
    return value.payloadValue;
  });
  const specifications = (topology.properties[specificationPropertyIndex]?.values ?? []).map((_, valueIndex) => {
    const value = topologyValue({ payloadLines, topology, propertyIndex: specificationPropertyIndex, valueIndex });
    return value.empty ? null : parseSpecification(
      value.payloadValue,
      specificationSegmentCount,
      specificationSeparator,
      specificationSegmentCounts,
    );
  });
  if (dimensions.length === 0 || specifications.filter(Boolean).length === 0) {
    throw new Error('SKU topology has no usable dimension or specification values');
  }
  const dimensionSummary = summarizeSkuDimensions(dimensions);
  if (!dimensionSummary) throw new Error('SKU dimensions cannot be summarized');

  const uniqueKeys = new Set();
  const rows = (topology.validCombinations ?? []).map((combination) => {
    const skuId = required(combination?.skuId, 'topology skuId');
    const indexes = combination?.propertyValueIndexes;
    if (!Array.isArray(indexes) || indexes.length !== propertyCount || !indexes.every(Number.isInteger)) {
      throw new Error('Topology SKU ' + skuId + ' does not identify every property value');
    }
    const dimension = topologyValue({
      payloadLines,
      topology,
      propertyIndex: dimensionPropertyIndex,
      valueIndex: indexes[dimensionPropertyIndex],
    });
    const specification = topologyValue({
      payloadLines,
      topology,
      propertyIndex: specificationPropertyIndex,
      valueIndex: indexes[specificationPropertyIndex],
    });
    if (dimension.empty || specification.empty) throw new Error('Topology SKU ' + skuId + ' contains a page-marked empty option');
    const parsedSpecification = parseSpecification(
      specification.payloadValue,
      specificationSegmentCount,
      specificationSeparator,
      specificationSegmentCounts,
    );
    const space = classifySkuSpace({
      skuSize: dimension.payloadValue,
      skuSpec: parsedSpecification.specification,
      skuName: parsedSpecification.name,
    });
    const uniqueKey = normalizedSource.productId + '|' + skuId;
    if (uniqueKeys.has(uniqueKey)) throw new Error('Duplicate SKU unique key: ' + uniqueKey);
    uniqueKeys.add(uniqueKey);
    return {
      skuId,
      fields: {
        商品链接: normalizedSource.productUrl,
        商品标题: normalizedSource.productTitle,
        竞品分类: normalizedSource.competitorClass,
        SKU名称: parsedSpecification.name,
        SKU规格: parsedSpecification.specification,
        SKU尺寸: dimension.payloadValue,
        尺寸汇总: dimensionSummary,
        ...applicableSpaceFields(space),
        商品ID: normalizedSource.productId,
        SKU唯一键: uniqueKey,
        所属竞品: normalizedSource.mainRecordId,
      },
    };
  });
  if (rows.length === 0) throw new Error('SKU topology has no valid combinations');
  return {
    sourceSchema: {
      version: topology.version,
      payloadSha256: topology.payloadSha256,
      propertyCount,
      dimensionPropertyIndex,
      specificationPropertyIndex,
      validCombinationCount: rows.length,
    },
    rows,
  };
}
