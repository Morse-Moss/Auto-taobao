// Helper for manual (assistant-performed) legacy analysis.
// Usage:
//   node manual-legacy-analysis.mjs extract          -> writes manual-pending-tasks.json (batches 18-30)
//   node manual-legacy-analysis.mjs apply <file>     -> distributes assistant output into batch dirs as provider-output.json
import fs from 'node:fs';
import path from 'node:path';

const outputDir = path.resolve('runtime', 'weekly-local-analysis', '2026-09-11-batch-6-batched');
const CATEGORY = new Set(['大词', '材质词', '场景词', '痛点词', '款式词', '风格词', '尺寸词', '功能词', '无匹配类别']);
const CLASSIFICATION = new Set(['核心大词', '安装方式词', '材质词', '形状与风格词', '功能与特点词', '尺寸词', '适用人群与场景词', '品牌词', '地域词', '颜色词', '通用词', '无匹配类别']);
const INTENT = new Set(['了解型', '购买决策型', '对比选择型', '场景需求型', '问题解决型']);
const CONTENT = new Set(['AI预测-高', 'AI预测-中', 'AI预测-低']);
const PRODUCT = new Set(['小户型深泡款', '人造石高端款', '方形独立式', '靠墙式小浴缸', '']);
const FIELDS = ['关键词归类', '标准归并词', '关键词分类', '细分标签', '用户意图', '内容热度', '对应产品方向'];
const BATCH_SIZE = 10;

const tasks = JSON.parse(fs.readFileSync(path.join(outputDir, 'tasks.json'), 'utf8'));
if (tasks.length !== 300) throw new Error(`expected 300 tasks, got ${tasks.length}`);
const batches = [];
for (let i = 0; i < tasks.length; i += BATCH_SIZE) batches.push(tasks.slice(i, i + BATCH_SIZE));
const PENDING = batches.slice(17); // batch-018 .. batch-030

const mode = process.argv[2];
if (mode === 'extract') {
  const pending = PENDING.map((batch, i) => ({
    batchName: `batch-${String(i + 18).padStart(3, '0')}`,
    tasks: batch.map((t) => ({ taskId: t.taskId, keywordId: t.keywordId, keyword: t.keyword, inputs: t.inputs })),
  }));
  fs.writeFileSync(path.join(outputDir, 'manual-pending-tasks.json'), JSON.stringify(pending, null, 2));
  console.log(`extracted ${pending.reduce((n, b) => n + b.tasks.length, 0)} pending tasks across ${pending.length} batches -> manual-pending-tasks.json`);
} else if (mode === 'apply') {
  const file = process.argv[3];
  if (!file) throw new Error('usage: apply <output-json>');
  const output = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(output)) throw new Error('output must be an array');
  const byId = new Map(output.map((o) => [String(o.taskId), o]));
  let written = 0;
  for (let i = 0; i < PENDING.length; i++) {
    const batchName = `batch-${String(i + 18).padStart(3, '0')}`;
    const batchDir = path.join(outputDir, batchName);
    fs.mkdirSync(batchDir, { recursive: true });
    const batchTasks = PENDING[i];
    const results = [];
    for (const t of batchTasks) {
      const item = byId.get(t.taskId);
      if (!item) throw new Error(`${batchName}: missing result for ${t.taskId} (${t.keyword})`);
      const f = Object.fromEntries(FIELDS.map((k) => [k, String(item[k] ?? '').trim()]));
      if (!CATEGORY.has(f['关键词归类'])) throw new Error(`${t.taskId} 关键词归类 invalid: ${f['关键词归类']}`);
      if (!f['标准归并词']) throw new Error(`${t.taskId} 标准归并词 empty`);
      if (!CLASSIFICATION.has(f['关键词分类'])) throw new Error(`${t.taskId} 关键词分类 invalid: ${f['关键词分类']}`);
      if (!INTENT.has(f['用户意图'])) throw new Error(`${t.taskId} 用户意图 invalid: ${f['用户意图']}`);
      if (!CONTENT.has(f['内容热度'])) throw new Error(`${t.taskId} 内容热度 invalid: ${f['内容热度']}`);
      if (!PRODUCT.has(f['对应产品方向'])) throw new Error(`${t.taskId} 对应产品方向 invalid: ${f['对应产品方向']}`);
      const labels = f['细分标签'].split(/[、,，;；\n]+/u).map((s) => s.trim()).filter(Boolean);
      if (labels.some((l) => l === '浴缸')) throw new Error(`${t.taskId} 细分标签 contains 浴缸`);
      results.push({ taskId: t.taskId, ...f });
      written++;
    }
    if (results.length !== batchTasks.length) throw new Error(`${batchName}: count mismatch`);
    fs.writeFileSync(path.join(batchDir, 'provider-output.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(`${batchName}: wrote ${results.length} results`);
  }
  console.log(`distributed ${written} results into ${PENDING.length} batch dirs`);
} else {
  throw new Error('usage: extract | apply <file>');
}
