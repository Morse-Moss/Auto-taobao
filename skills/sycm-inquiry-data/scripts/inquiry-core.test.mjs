import test from 'node:test';
import assert from 'node:assert/strict';
import { INQUIRY_HEADERS, parseInquiryRows, planInquiryImport } from './inquiry-core.mjs';

test('drops report summaries and maps all item rows', () => {
  const rows = [[], [], [], [], [], INQUIRY_HEADERS, ['商品A','1','2','延迟统计','1','延迟统计','0%','0','0.00','延迟统计','延迟统计','延迟统计'], ['平均值','-','2','延迟统计','1','延迟统计','0%','0','0.00','延迟统计','延迟统计','延迟统计']];
  const parsed = parseInquiryRows(rows, '2026-09-23', '盖文淘宝');
  assert.equal(parsed.length, 1); assert.equal(parsed[0].row[2], '1');
  const plan = planInquiryImport({ rows: parsed, existing: [] });
  assert.equal(plan.records[0].名称, '商品A'); assert.equal(plan.records[0].咨询人数, 2); assert.equal(plan.records[0].最终付款人数, '延迟统计');
});

// 下面三条是 2026-09-27 补的回归钉子。起因：五家店询单全部导入失败、报「缺少 12 列标准表头」。
// 根因不是平台改版 —— 仓库里 2026-09-23 存档的原始导出（契约就是照它写的）真实列名同样**不带「延」**；
// 契约里那个「延」是当初读到乱码、靠形状兜底匹配留下的痕迹。
// 旧用例把 INQUIRY_HEADERS 自己当夹具，于是「契约与真实文件是否一致」这件事从未被验过。
const EXPORT_HEADERS_2026 = ['商品名称','商品编号','咨询人数','询单人数','当日询单人数','询单转化率','当日询单转化率','当日付款人数','当日付款金额','最终付款人数','最终付款金额','最终付款件数'];

test('认真实导出里不带「延」的三个列名（真实文件的形状：2 行横幅 + 3 空行 + 表头 + 数据 + 平均值/汇总值）', () => {
  const rows = [
    ['下载数据最多5000条，超出部分会被截断！','','','','','','','','','','',''],
    ['收藏网址：d.alibaba.com，让数据帮您生意参谋！点此进入>>','','','','','','','','','','',''],
    ['','','','','','','','','','','',''],
    ['','','','','','','','','','','',''],
    ['','','','','','','','','','','',''],
    EXPORT_HEADERS_2026,
    ['商品A','123','2','延迟统计','1','延迟统计','0%','0','0.00','延迟统计','延迟统计','延迟统计'],
    ['平均值','-','2','延迟统计','1','延迟统计','0%','0','0.00','延迟统计','延迟统计','延迟统计'],
    ['汇总值','-','2','延迟统计','1','延迟统计','0%','0','0.00','延迟统计','延迟统计','延迟统计'],
  ];
  const parsed = parseInquiryRows(rows, '2026-09-26', '里可林淘宝');
  assert.equal(parsed.length, 1, '平均值/汇总值要被排除，只留商品行');
  assert.equal(parsed[0].row[2], '123');
  const plan = planInquiryImport({ rows: parsed, existing: [] });
  assert.equal(plan.records[0].最终付款人数, '延迟统计', '无「延」的源列名必须落到同一个目标字段');
});

test('乱码表头仍走形状兜底（xlrd 路径上中文 BIFF 标签会变乱码）', () => {
  const rows = [[], [], [], [], [], ['���','���','���','���','���','���','���','���','���','���','���','���'], ['商品A','1','2','延迟统计','1','延迟统计','0%','0','0.00','延迟统计','延迟统计','延迟统计']];
  const parsed = parseInquiryRows(rows, '2026-09-26', '里可林淘宝');
  assert.equal(parsed.length, 1);
});

test('列名与形状都认不出时，报错必须带上实际表头（别再让人重新解一遍文件）', () => {
  const rows = [[], [], [], [], [], ['商品名称','商品编号','访客数','浏览量','','','','','','','','']];
  assert.throws(() => parseInquiryRows(rows, '2026-09-26', '里可林淘宝'), /缺少 12 列标准表头[\s\S]*访客数/u);
});
