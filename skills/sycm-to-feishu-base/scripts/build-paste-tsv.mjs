#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_HEADERS = ['排名', '搜索词', '搜索人气', '点击率', '支付转化率'];

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell.length === 0) {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && csv[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (quoted) throw new Error('unterminated CSV quote');
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    if (row.some(value => value !== '')) rows.push(row);
  }
  return rows;
}

export function buildPasteTsv(csv) {
  const rows = parseCsv(csv.replace(/^\uFEFF/, ''));
  const headers = rows.shift();
  if (!headers || headers.length !== EXPECTED_HEADERS.length || headers.some((value, i) => value !== EXPECTED_HEADERS[i])) {
    throw new Error(`expected exactly five columns: ${EXPECTED_HEADERS.join(',')}`);
  }
  if (rows.length === 0) throw new Error('CSV contains no data rows');
  if (rows.some(row => row.length !== EXPECTED_HEADERS.length)) throw new Error('CSV contains a malformed row');
  if (rows.some(row => row.some(value => value.includes('\t') || value.includes('\r') || value.includes('\n')))) {
    throw new Error('TSV data contains a tab or newline inside a cell');
  }
  return rows.map(row => row.join('\t')).join('\r\n');
}

async function main() {
  const input = process.argv[2];
  if (!input || process.argv.includes('--help')) {
    console.log('Usage: node build-paste-tsv.mjs INPUT.csv > paste.tsv');
    process.exitCode = input ? 0 : 1;
    return;
  }
  process.stdout.write(buildPasteTsv(await readFile(path.resolve(input), 'utf8')));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
