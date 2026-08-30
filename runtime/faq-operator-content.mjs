import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FAQ_LABEL_CATALOG } from './faq-text-analysis.mjs';

export const FAQ_OPERATOR_CONTENT_VERSION = 'faq-operator-content-v1.0.0';

const PYTHON_READER = fileURLToPath(new URL('./read-faq-operator-xlsx.py', import.meta.url));

export const FAQ_TYPICAL_QUESTIONS = Object.freeze({
  '重量大/搬运困难': '浴缸重量是否过大，搬运和上楼是否困难？',
  '不包安装/安装费贵': '商品是否包含安装，额外安装费用大概是多少？',
  '异味问题': '商品到货后是否存在异味，通常多久可以散去？',
  '尺寸不符/偏大偏小': '商品实际尺寸是否准确，能否适配预留空间？',
  '排水/漏水问题': '浴缸排水是否顺畅，使用中是否容易漏水？',
  '品质瑕疵(划痕/裂纹/破损)': '商品到货时是否容易出现划痕、裂纹或破损？',
  '物流/运输问题': '物流配送是否及时，能否安全送货入户？',
  '售后差/不处理': '出现问题后售后是否及时响应并妥善处理？',
  '价格/保价问题': '商品价格和保价政策是否稳定、透明？',
  '清洁困难': '浴缸日常清洁和打理是否方便？',
  '深度不够/太浅': '浴缸深度是否足够，泡澡时能否舒适浸泡？',
  '系统默认/无内容': '商品是否只有系统默认好评，缺少有效评价内容？',
  '问答内容': '用户问答中主要关注了哪些商品信息？',
  '好评-外观颜值': '浴缸外观和设计是否好看？',
  '好评-质感材质': '浴缸材质和做工是否有质感？',
  '好评-性价比': '这款浴缸的价格和整体表现是否值得购买？',
  '好评-保温/舒适': '浴缸泡澡体验是否舒适，保温效果是否好？',
  '好评-客服服务': '客服咨询和服务是否耐心、及时？',
  '好评-无异味': '商品是否没有明显异味？',
  '好评-易清洁': '浴缸是否容易清洁和日常打理？',
  '其他评价': '用户对商品还有哪些其他评价？',
});

function runReader(xlsxPath, python) {
  const command = python ?? (process.platform === 'win32' ? 'py' : 'python3');
  const args = python || process.platform !== 'win32' ? [] : ['-3'];
  const result = spawnSync(command, [...args, PYTHON_READER, xlsxPath], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`FAQ operator XLSX reading failed: ${(result.stderr || result.stdout).trim()}`);
  return JSON.parse(result.stdout);
}

export function operatorContentFromRows(rows, { sourcePath = '', sourceHash = '' } = {}) {
  const expected = new Set(FAQ_LABEL_CATALOG.map(({ label }) => label));
  const content = Object.fromEntries(FAQ_LABEL_CATALOG.map(({ label }) => [label, {
    痛点描述: '',
    典型问题: FAQ_TYPICAL_QUESTIONS[label],
    典型用户原话: '',
  }]));
  const seen = new Set();
  for (const row of rows ?? []) {
    const label = String(row.痛点类型 ?? '').trim();
    if (!label) continue;
    if (!expected.has(label)) throw new Error(`Operator XLSX contains unknown FAQ label: ${label}`);
    if (seen.has(label)) throw new Error(`Operator XLSX contains duplicate FAQ label: ${label}`);
    seen.add(label);
    content[label] = {
      痛点描述: String(row.痛点描述 ?? '').trim(),
      典型问题: FAQ_TYPICAL_QUESTIONS[label],
      典型用户原话: String(row.典型用户原话 ?? '').trim(),
    };
  }
  const requiredPainLabels = FAQ_LABEL_CATALOG.filter(({ isPainPoint }) => isPainPoint).map(({ label }) => label);
  const missing = requiredPainLabels.filter((label) => !seen.has(label));
  if (missing.length) throw new Error(`Operator XLSX is missing pain labels: ${missing.join(', ')}`);
  return { version: FAQ_OPERATOR_CONTENT_VERSION, source: { path: sourcePath, sha256: sourceHash }, content };
}

export function readOperatorContent(xlsxPath, { python } = {}) {
  const sourcePath = resolve(xlsxPath);
  const sourceHash = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
  const workbook = runReader(sourcePath, python);
  return operatorContentFromRows(workbook.rows, { sourcePath, sourceHash });
}
