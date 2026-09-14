// adapter.feishu-import 单测：采集段适配器契约与工件形状（hermetic，不调用 Python、不联网）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  adapter, capabilityId, manifestVersion, stableJson,
  setExtractorForTest, resetStateForTest, createFeishuImportPublisher,
} from '../scripts/adapter.feishu-import.mjs';
import { XWS_HEADERS } from '../scripts/import-core.mjs';
import { CAPABILITY_CONTRACT, assertAdapter } from '../../../runtime/sop-runtime/worker-adapter.mjs';

const IDENTITY = {
  tenantId: 't-1', storeId: 's-1', platform: 'xws',
  accountId: 'a-1', browserProfileId: 'p-1', contractVersion: 'xws-16f-v1',
};

function fakeWorkbook({ rows = 2 } = {}) {
  const row = Object.fromEntries(XWS_HEADERS.map((name) => [name, `${name}-value`]));
  row.月收货人数 = '100+';
  return {
    headers: [...XWS_HEADERS],
    rows: Array.from({ length: rows }, (_, index) => ({ ...row, 序号: String(index + 1) })),
    images: [{ row: 2, path: 'C:/tmp/example.png' }],
  };
}

test('依赖能力自报身份与 manifest 版本一致', () => {
  assert.equal(capabilityId, 'xws.feishu.import');
  assert.equal(manifestVersion, '1.1.0');
});

test('adapter 满足 Worker 适配器契约', () => {
  assert.doesNotThrow(() => assertAdapter(adapter));
  assert.deepEqual(CAPABILITY_CONTRACT.filter((name) => typeof adapter[name] !== 'function'), []);
});

test('stableJson 与键顺序无关，保证同结果同摘要', () => {
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));
  assert.notEqual(stableJson({ a: 1 }), stableJson({ a: 2 }));
  assert.equal(stableJson([{ b: 1, a: 1 }]), '[{"a":1,"b":1}]');
});

test('prepare 拒绝缺失的 xlsx 与缺失的 outputDir', async () => {
  await assert.rejects(() => adapter.prepare({}), /xlsxPath is required/u);
  await assert.rejects(() => adapter.prepare({ xlsxPath: 'C:/definitely/missing.xlsx' }), /XLSX file not found/u);

  const dir = await mkdtemp(path.join(tmpdir(), 'xws-adapter-'));
  const xlsx = path.join(dir, 'sample.xlsx');
  await writeFile(xlsx, 'stub', 'utf8');
  await assert.rejects(
    () => adapter.prepare({ xlsxPath: xlsx, baseUrl: 'https://h.feishu.cn/base/A?table=t' }),
    /outputDir is required/u,
  );
});

test('采集段产出可复验工件：16 列非空计数 + 摘要 + 行数', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'xws-adapter-'));
  const xlsx = path.join(dir, 'sample.xlsx');
  await writeFile(xlsx, 'stub', 'utf8');

  try {
    setExtractorForTest(() => fakeWorkbook({ rows: 2 }));
    resetStateForTest();

    await adapter.prepare({ xlsxPath: xlsx, outputDir: dir, baseUrl: 'https://h.feishu.cn/base/A?table=t' });
    const started = await adapter.start({ xlsxPath: xlsx, outputDir: dir, baseUrl: 'https://h.feishu.cn/base/A?table=t' });
    assert.equal(started.rows, 2);
    assert.equal(started.images, 1);
    assert.equal(started.countField, '月收货人数');

    const observation = await adapter.observe({ context: { identity: IDENTITY }, started });
    assert.deepEqual(observation.identity, IDENTITY);
    assert.equal(observation.rows, 2);

    const artifact = await adapter.collectArtifact({ observation });
    assert.equal(artifact.rowCount, 2);
    assert.deepEqual(artifact.range, { start: 1, end: 2 });
    // 16 列都必须出现在工件上（structure 验证器按 requiredFields 检查键存在）
    for (const header of XWS_HEADERS) {
      assert.equal(typeof artifact[header], 'number', `缺列 ${header}`);
      assert.equal(artifact[header], 2, `${header} 非空计数应为 2`);
    }
    // 摘要必须与落盘字节一致，否则 evidence-store 的 digest 校验会失败
    assert.equal(artifact.sha256, createHash('sha256').update(artifact.bytes).digest('hex'));
    assert.deepEqual(JSON.parse(artifact.bytes.toString('utf8')).headers, [...XWS_HEADERS]);

    const check = await adapter.validate(artifact);
    assert.equal(check.ok, true);
  } finally {
    setExtractorForTest(null);
    resetStateForTest();
  }
});

test('能力自检拦住表头不符的源文件', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'xws-adapter-'));
  const xlsx = path.join(dir, 'sample.xlsx');
  await writeFile(xlsx, 'stub', 'utf8');
  try {
    const broken = fakeWorkbook();
    broken.headers = [...XWS_HEADERS].map((name, index) => (index === 0 ? '序号X' : name));
    setExtractorForTest(() => broken);
    resetStateForTest();
    await assert.rejects(() => adapter.start({ xlsxPath: xlsx, outputDir: dir }), /16-field/u);
  } finally {
    setExtractorForTest(null);
    resetStateForTest();
  }
});

test('发布段钩子从工件字节重建输入，不依赖采集段内存状态', async () => {
  const artifactBytes = Buffer.from(stableJson(fakeWorkbook({ rows: 3 })), 'utf8');
  const calls = [];
  const client = {
    async listRecords() {
      return [
        { fields: { 商品图片: [{ file_token: 'f1' }] } },
        { fields: { 商品图片: [] } },
      ];
    },
  };
  const hooks = createFeishuImportPublisher({ client, artifactBytes });
  const receipt = await hooks.readBack();
  assert.equal(receipt.rows, 2);
  assert.equal(receipt.attachments, 1);
  assert.match(receipt.digest, /^[0-9a-f]{64}$/u);
  assert.ok(receipt.verifiedAt);
  calls.push(receipt.digest);
  assert.equal(calls.length, 1);

  // 同步抛错：工厂不异步初始化，缺工件直接拒绝
  assert.throws(() => createFeishuImportPublisher({ client }), /artifactBytes is required/u);
});
