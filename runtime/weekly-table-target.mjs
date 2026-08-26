export const WEEKLY_NAME_PATTERN = /^(竞品周|SKU周|问题库)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/u;

export function weeklyTableName(kind, startDate, endDate) {
  if (!['竞品', 'SKU', '问题库'].includes(kind)) throw new Error(`Unsupported weekly table kind: ${kind}`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/u.test(endDate)) {
    throw new Error('Weekly table dates must use YYYY-MM-DD');
  }
  const prefix = kind === '竞品' ? '竞品周' : kind === 'SKU' ? 'SKU周' : '问题库';
  return `${prefix}_${startDate}_${endDate}`;
}

export function parseWeeklyTable(table) {
  const match = String(table?.name ?? '').match(WEEKLY_NAME_PATTERN);
  if (!match) return null;
  const kind = match[1] === '竞品周' ? '竞品' : match[1] === 'SKU周' ? 'SKU' : '问题库';
  return { ...table, kind, startDate: match[2], endDate: match[3] };
}

export function latestWeeklyTable(tables, kind) {
  const candidates = (tables ?? []).map(parseWeeklyTable).filter((table) => table?.kind === kind);
  candidates.sort((left, right) => left.startDate.localeCompare(right.startDate));
  return candidates.at(-1) ?? null;
}

export function requireWeeklyTable(tables, kind, name) {
  const parsed = (tables ?? []).map(parseWeeklyTable).find((table) => table?.kind === kind && table.name === name);
  if (!parsed) throw new Error(`Weekly ${kind} table not found: ${name}`);
  return parsed;
}
