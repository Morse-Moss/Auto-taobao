import fs from 'node:fs';
import path from 'node:path';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, WidthType, BorderStyle, ShadingType, AlignmentType, LevelFormat } from 'docx';

const out = path.resolve(import.meta.dirname, '..', 'docs', 'ops', '商品数据与运营自动化-WorkBuddy用户手册-2026-09-27.docx');
const border = { style: BorderStyle.SINGLE, size: 1, color: 'D9E1F2' };
const borders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };
const cell = (text, width, bold = false) => new TableCell({ width: { size: width, type: WidthType.DXA }, shading: { fill: bold ? 'EAF2F8' : 'FFFFFF', type: ShadingType.CLEAR }, children: [new Paragraph({ children: [new TextRun({ text, bold })] })] });
const table = (headers, rows) => new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: headers.map(() => Math.floor(9360 / headers.length)), borders, rows: [new TableRow({ children: headers.map((h, i) => cell(h, Math.floor(9360 / headers.length), true)) }), ...rows.map(row => new TableRow({ children: row.map((v, i) => cell(String(v), Math.floor(9360 / headers.length))) }))] });
const p = (text, options = {}) => new Paragraph({ spacing: { after: 120 }, ...options, children: [new TextRun(text)] });
const bullet = text => new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: [new TextRun(text)] });
const numbered = text => new Paragraph({ numbering: { reference: 'numbers', level: 0 }, children: [new TextRun(text)] });
const code = text => new Paragraph({ style: 'Code', spacing: { before: 80, after: 120 }, children: [new TextRun({ text, font: 'Consolas', size: 20 })] });

const doc = new Document({
  styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 22 } } }, paragraphStyles: [{ id: 'Code', name: 'Code', basedOn: 'Normal', run: { font: 'Consolas', size: 20, color: '333333' }, paragraph: { shading: { fill: 'F5F7FA', type: ShadingType.CLEAR } } }] },
  numbering: { config: [
    { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    { reference: 'numbers', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
  ] },
  sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1080, left: 1440, right: 1440 } } }, children: [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: '商品数据与运营自动化 WorkBuddy 用户手册', bold: true, size: 36 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 360 }, children: [new TextRun({ text: '版本：2026-09-27　适用时区：Asia/Shanghai（UTC+8）', color: '666666' })] }),
    p('本文档给出周报、店铺数据日报、商品数据日报三套流程的 WorkBuddy 提示词、触发时间、依赖关系、验收标准和人工接管方式。WorkBuddy 是唯一外部调度器；不要同时注册 Windows 任务或启动多个并发任务。'),
    new Paragraph({ text: '一、统一运行规则', heading: HeadingLevel.HEADING_1 }),
    bullet('工作目录固定为 D:\\Retire\\sycm-automation；只调用本文档指定的入口。'),
    bullet('三套流程共用商家浏览器、代理和飞书写入资源，必须遵守全局运行锁。锁冲突时退出并报告当前持有者，不得覆盖。'),
    bullet('登录、验证码、风控、权限和页面改版属于人工闸门；不得绕过平台控制。'),
    bullet('每次运行必须保留 evidence 收据；成功报告目标日期、阶段、源行数、新增数、重复数、回读结果和释放状态。'),
    bullet('任何阶段失败都不能假报完成。finally 必须释放浏览器并完成两次端口回读。'),
    new Paragraph({ text: '二、时间表与依赖', heading: HeadingLevel.HEADING_1 }),
    table(['时间（UTC+8）', '流程', '依赖与说明'], [
      ['每日 15:30', '店铺数据日报', '五店并行；先完成登录预检，再采集日报并写入飞书。'],
      ['每日 18:00', '商品数据日报', '依赖日报释放商家浏览器；运行商品底单、询单、推广三阶段。'],
      ['每周一 09:30', '周报第一阶段', '关键词采集、周表准备、竞品采集准备；与日报/商品日报不重叠。'],
      ['周一 10:30–13:30', '周报 AI 闸门', '每 30 分钟检查飞书 AI 字段；未结算必须保持 PAUSED_FOR_HUMAN。'],
      ['周一 14:00', '周报后处理', '决策历史、灰豚热度、竞品富化和发布回读。'],
    ]),
    new Paragraph({ text: '三、店铺数据日报提示词', heading: HeadingLevel.HEADING_1 }),
    p('将以下完整文字作为 WorkBuddy 任务提示词：'),
    code('你在 D:\\Retire\\sycm-automation 执行店铺数据日报。目标日期默认昨日，时区 Asia/Shanghai。执行：node scripts/run-daily-job.mjs --date yesterday --batches 1 --notify。开始前确认没有 merchant-automation 锁；使用日报流程的五店自动登录守卫。五店并行采集，任一店登录、验证码、风控或身份不一致立即停止该店并保留告警。不得绕过平台控制。每个阶段写 evidence 和 receipt，失败分类为 TRANSIENT_EXTERNAL、HUMAN_REQUIRED、POLICY_DENIED 或 UNKNOWN_WRITE。写入后必须回读核对行数和日期。成功条件是五店计划内阶段完成、飞书回读通过、浏览器/代理端口释放；释放未确认就报告失败。结束时汇报目标日期、各店状态、源行数、新增/重复数、回读和释放结果。'),
    new Paragraph({ text: '四、商品数据日报提示词', heading: HeadingLevel.HEADING_1 }),
    p('将以下完整文字作为 WorkBuddy 任务提示词：'),
    code('你在 D:\\Retire\\sycm-automation 执行商品数据自动采集。目标日期默认昨日，时区 Asia/Shanghai。先确认店铺数据日报已结束并释放资源，再执行：node scripts/run-product-data-job.mjs --date yesterday --commit --notify。覆盖五家店并行采集商品底单、商品询单、商品推广。每次运行必须使用唯一 runId 和独立下载目录，只接受本轮采集器显式返回且日期/店铺/报表类型匹配的文件，禁止从历史 Downloads 目录回退取文件。导入必须幂等，先回读再决定是否重试；写入结果未知时禁止盲目重试。推广下载遇到任务未刷新、遮挡或最新任务不可下载时，按程序内置最多三次刷新/重新发现 target/真实点击重试，以 ZIP 实际落盘为成功判据。登录、验证码、风控、权限或页面改版转人工。无论成败都释放浏览器并两次回读端口。结束汇报目标日期、五店三阶段源行数/新增/重复、飞书回读、run-receipt 状态、失败分类和释放状态。'),
    new Paragraph({ text: '五、周报提示词', heading: HeadingLevel.HEADING_1 }),
    p('周报当前由多个阶段脚本组成，WorkBuddy 必须按阶段收据编排，不得把多个命令无条件串联为“成功”。'),
    code('你在 D:\\Retire\\sycm-automation 执行周报编排。每周一 09:30 开始，目标周由当前配置确定。先获取 merchant-automation 全局锁，检查上次周报 receipt 和浏览器/代理状态，并用 node scripts/run-weekly-workflow.mjs --show-plan 读取下一阶段。阶段顺序：1) 关键词周报采集；2) 创建/导入本期周表；3) 等待飞书 AI 字段结算；4) 读取并验证 AI receipt；5) 决策历史同步；6) 灰豚热度；7) 竞品采集与 SKU/FAQ 富化；8) 周报发布与回读。AI 字段未结算时只输出 PAUSED_FOR_HUMAN，不得伪造后续完成。每阶段写 receipt，支持从最后一个成功阶段续跑。外部网络/页面问题最多重试三次；飞书写入结果未知先回读；权限、验证码、风控和页面改版转人工。最终仅在所有阶段 receipt、发布回读和资源释放均通过时报告 COMPLETED，否则报告具体阶段和人工动作。'),
    new Paragraph({ text: '六、成功标准与失败处理', heading: HeadingLevel.HEADING_1 }),
    table(['状态', '判定', 'WorkBuddy 动作'], [
      ['COMPLETED', '采集、导入、回读、收据和释放全部通过', '发送成功摘要，保留 evidence。'],
      ['RECOVERED', '首次失败后重试成功', '发送恢复摘要，记录重试次数和原因。'],
      ['TRANSIENT_EXTERNAL', '网络、页面加载、任务生成暂时失败', '按阶段最多重试三次，仍失败转人工。'],
      ['HUMAN_REQUIRED', '登录、验证码、风控、权限、AI 未结算、页面改版', '暂停并通知人工，不继续写入。'],
      ['UNKNOWN_WRITE', '写入响应未知或进程中断', '先回读目标表，确认前禁止重试。'],
      ['FAILED', '采集文件缺失、日期/店铺不匹配、回读或释放失败', '报告阶段、证据路径和人工处理建议。'],
    ]),
    new Paragraph({ text: '七、交付检查清单', heading: HeadingLevel.HEADING_1 }),
    numbered('确认客户机器已配置 Node 22、Python/openpyxl、Edge、CDP 代理和飞书凭据路径；凭据不写入仓库。'),
    numbered('首次运行后检查 evidence/product-data-job-YYYY-MM-DD/<runId>/run-receipt.json、collection.json、各导入 receipt 和 release.json。'),
    numbered('连续观察至少三次日报和一次周报；确认重复运行不会新增重复行。'),
    numbered('确认 WorkBuddy 只有一个总调度入口，并将日报、商品日报、周报按本文档时间串行执行。'),
    p('文档边界：当前系统适合单机、单租户、有人可介入的运营自动化。周报的飞书 AI 字段仍是人工闸门，未完成连续无人值守验收前，不应对客户承诺完全无人值守。'),
  ] }],
});

fs.mkdirSync(path.dirname(out), { recursive: true });
Packer.toBuffer(doc).then(buffer => fs.writeFileSync(out, buffer));
console.log(out);
