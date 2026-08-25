import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyExportPair } from './source-period-proof.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function pythonCommand() {
  if (process.env.SYCM_PYTHON) return { command: process.env.SYCM_PYTHON, args: [] };
  const bundled = path.join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  const bundledCheck = spawnSync(bundled, ['-c', 'import openpyxl'], { stdio: 'ignore' });
  if (bundledCheck.status === 0) return { command: bundled, args: [] };
  return { command: 'py', args: ['-3'] };
}

async function makePair(directory) {
  const csv = path.join(directory, 'week.csv');
  const xlsx = path.join(directory, 'week.xlsx');
  const payload = path.join(directory, 'payload.json');
  const metadata = {
    source: '生意参谋搜索排行',
    sourceUrl: 'https://sycm.taobao.com/mc/free/search_rank?dateRange=2026-08-09%7C2026-08-15&dateType=recent7&cateId=50002411',
    date: '2026-08-15',
    period: '7天',
    startDate: '2026-08-09',
    endDate: '2026-08-15',
    dayCount: 7,
    dateRange: '2026-08-09 ~ 2026-08-15',
    category: '普通浴缸',
    cateId: '50002411',
    rowCount: 2,
    rankRange: '1-2',
    uniqueRanks: true,
    contiguousRanks: true,
    uniqueTerms: true,
    nonEmptyMetrics: true,
    pageSizes: [2],
  };
  const rows = [
    { rank: 1, term: '浴缸', searchPopularity: '5000 ~ 1万', clickRate: '59%', payConversionRate: '1% ~ 2.5%' },
    { rank: 2, term: '小浴缸', searchPopularity: '150 ~ 300', clickRate: '61%', payConversionRate: '-' },
  ];
  await writeFile(payload, JSON.stringify({ metadata, rows }), 'utf8');
  await writeFile(csv, `\uFEFF排名,搜索词,搜索人气,点击率,支付转化率\r\n1,浴缸,5000 ~ 1万,59%,1% ~ 2.5%\r\n2,小浴缸,150 ~ 300,61%,-\r\n`, 'utf8');
  const python = pythonCommand();
  const result = spawnSync(python.command, [...python.args, path.join(SCRIPT_DIR, 'write-workbook.py'), payload, xlsx], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { csv, xlsx };
}

test('verifies the seven-day workbook metadata and exact CSV/XLSX row pair', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sycm-period-proof-'));
  try {
    const pair = await makePair(directory);
    const proof = await verifyExportPair({ ...pair, expectedEndDate: '2026-08-15' });
    assert.equal(proof.period, '7天');
    assert.equal(proof.startDate, '2026-08-09');
    assert.equal(proof.endDate, '2026-08-15');
    assert.equal(proof.dayCount, 7);
    assert.equal(proof.rowCount, 2);
    assert.match(proof.csvSha256, /^[A-F0-9]{64}$/u);
    assert.match(proof.xlsxSha256, /^[A-F0-9]{64}$/u);

    await writeFile(pair.csv, `\uFEFF排名,搜索词,搜索人气,点击率,支付转化率\r\n1,被篡改,5000 ~ 1万,59%,1% ~ 2.5%\r\n2,小浴缸,150 ~ 300,61%,-\r\n`, 'utf8');
    await assert.rejects(
      verifyExportPair({ ...pair, expectedEndDate: '2026-08-15' }),
      /CSV and XLSX data differ/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
