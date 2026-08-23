import { createHash } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function payloadLines(rawPayload) {
  if (typeof rawPayload !== 'string' || rawPayload.trim() === '') {
    throw new Error('SKU payload is empty');
  }
  return rawPayload.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
}

function lineKind(value) {
  if (/^\d+(?:\.\d+)?(?:毫米|mm|厘米|cm|公分|米|m)$/iu.test(value)) return 'dimension';
  if (value.includes('|')) return 'label-line';
  return 'tuple';
}

function specificationParts(value, separator) {
  const source = String(value ?? '').trim();
  if (!source.includes(separator)) return null;
  const parts = source.split(separator).map((segment) => segment.trim()).filter(Boolean);
  return { separator, parts };
}

function stableSpecificationSeparator(values) {
  const candidates = ['-', '+'].filter((separator) => {
    const sourceValues = values.map((value) => String(value ?? ''));
    return sourceValues.some((value) => value.includes(separator))
      && sourceValues.every((value) => !value.includes(separator)
        || specificationParts(value, separator)?.parts.length >= 2);
  });
  return candidates.includes('-') ? '-' : candidates.length === 1 ? candidates[0] : null;
}

function expectedPropertyIndexes(snapshot) {
  const properties = snapshot?.properties;
  if (!Array.isArray(properties) || properties.length !== 2) {
    throw new Error('Page snapshot must contain exactly two SKU properties');
  }
  const indexes = properties.map((property) => property?.propertyIndex);
  if (!indexes.every(Number.isInteger) || new Set(indexes).size !== indexes.length) {
    throw new Error('Page snapshot property indexes are invalid');
  }
  return indexes;
}

function mapPropertiesToPayload(lines, snapshot) {
  const byHash = new Map();
  lines.forEach((line, index) => {
    const hash = sha256(line);
    if (byHash.has(hash)) throw new Error('Captured payload contains an ambiguous duplicate line');
    byHash.set(hash, index);
  });

  const properties = snapshot.properties.map((property) => {
    const values = property?.values;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error('Page snapshot property has no values');
    }
    const seenValueIndexes = new Set();
    return {
      propertyIndex: property.propertyIndex,
      propertyNameSha256: String(property.propertyNameSha256 ?? ''),
      values: values.map((value) => {
        if (!Number.isInteger(value?.valueIndex) || seenValueIndexes.has(value.valueIndex)) {
          throw new Error('Page snapshot property value indexes are invalid');
        }
        seenValueIndexes.add(value.valueIndex);
        const payloadLineIndex = byHash.get(String(value.nameSha256 ?? ''));
        if (payloadLineIndex == null) throw new Error('Page option has no matching captured payload line');
        return {
          valueIndex: value.valueIndex,
          payloadLineIndex,
          payloadLineSha256: String(value.nameSha256),
          empty: Boolean(value.empty),
        };
      }).sort((left, right) => left.valueIndex - right.valueIndex),
    };
  }).sort((left, right) => left.propertyIndex - right.propertyIndex);

  const mappedIndexes = properties.flatMap((property) => property.values.map((value) => value.payloadLineIndex));
  if (new Set(mappedIndexes).size !== mappedIndexes.length) {
    throw new Error('Captured payload line maps to more than one page option');
  }
  if (mappedIndexes.length !== lines.length) throw new Error('Captured payload contains an unmapped payload line');
  return properties;
}

function classifyProperties(lines, properties) {
  const propertyKinds = properties.map((property) => ({
    propertyIndex: property.propertyIndex,
    nonemptyKinds: property.values.filter((value) => !value.empty)
      .map((value) => lineKind(lines[value.payloadLineIndex])),
  }));
  const dimensions = propertyKinds.filter((property) => (
    property.nonemptyKinds.length > 0 && property.nonemptyKinds.every((kind) => kind === 'dimension')
  ));
  if (dimensions.length !== 1) throw new Error('Page snapshot does not identify one dimension property');
  const specificationProperties = propertyKinds.filter((property) => (
    property.propertyIndex !== dimensions[0].propertyIndex
    && property.nonemptyKinds.length > 0
    && property.nonemptyKinds.every((kind) => kind === 'tuple')
  ));
  if (specificationProperties.length !== 1) throw new Error('Page snapshot does not identify one specification property');
  const specificationProperty = properties.find((property) => property.propertyIndex === specificationProperties[0].propertyIndex);
  const specificationValues = specificationProperty.values.filter((value) => !value.empty)
    .map((value) => lines[value.payloadLineIndex]);
  const separator = stableSpecificationSeparator(specificationValues);
  const parsedSpecifications = specificationValues.map((value) => (
    specificationParts(value, separator) || { separator, parts: [String(value ?? '').trim()] }
  ));
  const segmentCounts = parsedSpecifications.map((specification) => specification?.parts.length ?? 0);
  const uniqueSegmentCounts = [...new Set(segmentCounts)].sort((left, right) => left - right);
  if (segmentCounts.length === 0 || uniqueSegmentCounts.some((count) => count < 1)
    || !separator) {
    throw new Error('Specification options do not have one stable separator and valid segment counts');
  }
  return {
    dimensionPropertyIndex: dimensions[0].propertyIndex,
    specificationPropertyIndex: specificationProperties[0].propertyIndex,
    specificationSegmentCount: uniqueSegmentCounts.at(-1),
    specificationSegmentCounts: uniqueSegmentCounts,
    specificationSeparator: separator,
  };
}

function validCombinations(snapshot, properties) {
  if (!Array.isArray(snapshot?.skuEntries) || snapshot.skuEntries.length === 0) {
    throw new Error('Page snapshot has no SKU entries');
  }
  const valuesByProperty = new Map(properties.map((property) => [
    property.propertyIndex,
    new Map(property.values.map((value) => [value.valueIndex, value])),
  ]));
  const propertyIndexes = properties.map((property) => property.propertyIndex);
  const seenKeys = new Set();
  const output = [];
  for (const entry of snapshot.skuEntries) {
    const skuId = String(entry?.skuId ?? '').trim();
    const indexes = entry?.propertyValueIndexes;
    if (!skuId || !Array.isArray(indexes) || indexes.length !== propertyIndexes.length
      || !indexes.every(Number.isInteger)) {
      throw new Error('Page SKU entry does not identify every property value');
    }
    const values = indexes.map((valueIndex, position) => {
      const propertyIndex = propertyIndexes[position];
      const value = valuesByProperty.get(propertyIndex)?.get(valueIndex);
      if (!value) throw new Error('Page SKU entry references an unknown property value');
      return value;
    });
    const allNonempty = values.every((value) => !value.empty);
    if (!allNonempty) continue;
    if (entry.hasSubPrice !== true && entry.hasPriceRepresentation !== true) {
      throw new Error('Nonempty page SKU has no current price representation');
    }
    const uniqueKey = skuId + '|' + indexes.join(':');
    if (seenKeys.has(uniqueKey)) throw new Error('Page snapshot contains a duplicate SKU entry');
    seenKeys.add(uniqueKey);
    output.push({ skuId, propertyValueIndexes: [...indexes] });
  }
  if (output.length === 0) throw new Error('Page snapshot has no sellable SKU combinations');
  return output.sort((left, right) => left.skuId.localeCompare(right.skuId));
}

export function buildXwsSkuTopology(rawPayload, pageSnapshot) {
  const lines = payloadLines(rawPayload);
  expectedPropertyIndexes(pageSnapshot);
  const properties = mapPropertiesToPayload(lines, pageSnapshot);
  const classified = classifyProperties(lines, properties);
  return {
    version: 'xws-tmall-sku-topology-v1',
    payloadSha256: sha256(rawPayload),
    dimensionPropertyIndex: classified.dimensionPropertyIndex,
    specificationPropertyIndex: classified.specificationPropertyIndex,
    specificationSegmentCount: classified.specificationSegmentCount,
    specificationSegmentCounts: classified.specificationSegmentCounts,
    specificationSeparator: classified.specificationSeparator,
    properties: properties.map((property) => ({
      propertyIndex: property.propertyIndex,
      propertyNameSha256: property.propertyNameSha256,
      values: property.values.map(({ valueIndex: _valueIndex, ...value }) => value),
    })),
    validCombinations: validCombinations(pageSnapshot, properties),
  };
}
