from pathlib import Path
import sys

from docx import Document
from docx.enum.table import WD_ALIGN_VERTICAL
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

DOCS = Path(r"D:\codex\plugins\cache\openai-primary-runtime\documents\26.812.11052\skills\documents\scripts")
sys.path.insert(0, str(DOCS))
from table_geometry import apply_table_geometry

OUT = Path(r"C:\Users\Administrator\Desktop\浴缸关键词经营决策三字段说明与阶段成果汇报_V1.0_20260813.docx")
BLUE, NAVY, TEXT, MUTED, LIGHT = "2E74B5", "17324D", "202124", "5F6368", "E8EEF5"


def font(run, size=11, bold=False, color=TEXT):
    run.font.name = "Calibri"
    run._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), "Calibri")
    run._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), "Calibri")
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    run.font.size = Pt(size)
    run.bold = bold
    run.font.color.rgb = RGBColor.from_string(color)


def shade(cell, color):
    props = cell._tc.get_or_add_tcPr()
    node = OxmlElement("w:shd")
    node.set(qn("w:fill"), color)
    props.append(node)


def table_header(row):
    props = row._tr.get_or_add_trPr()
    node = OxmlElement("w:tblHeader")
    node.set(qn("w:val"), "true")
    props.append(node)


def no_split(row):
    props = row._tr.get_or_add_trPr()
    props.append(OxmlElement("w:cantSplit"))


def paragraph(doc, text="", *, size=11, bold=False, color=TEXT, after=6, style=None):
    p = doc.add_paragraph(style=style)
    p.paragraph_format.space_after = Pt(after)
    r = p.add_run(text)
    font(r, size, bold, color)
    return p


def bullet(doc, text):
    p = doc.add_paragraph(style="List Bullet")
    p.paragraph_format.space_after = Pt(3)
    font(p.add_run(text), 10.5)


def grid(doc, headers, rows, widths):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"
    t.autofit = False
    table_header(t.rows[0])
    for i, value in enumerate(headers):
        cell = t.rows[0].cells[i]
        shade(cell, LIGHT)
        cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        font(p.add_run(value), 9.5, True, NAVY)
    for values in rows:
        row = t.add_row()
        no_split(row)
        for i, value in enumerate(values):
            cell = row.cells[i]
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(1)
            font(p.add_run(value), 9.3)
    apply_table_geometry(t, widths, table_width_dxa=9360, indent_dxa=120,
                         cell_margins_dxa={"top": 80, "bottom": 80, "start": 120, "end": 120})
    paragraph(doc, "", after=1)


def heading(doc, text):
    p = doc.add_paragraph(style="Heading 1")
    font(p.add_run(text), 16, True, BLUE)
    p.paragraph_format.space_before = Pt(12)
    p.paragraph_format.space_after = Pt(6)


def setup(doc):
    s = doc.sections[0]
    s.top_margin = Inches(.75); s.bottom_margin = Inches(.7)
    s.left_margin = Inches(.85); s.right_margin = Inches(.85)
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"; normal.font.size = Pt(11)
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    normal.paragraph_format.line_spacing = 1.15
    for name, size in [("Heading 1", 16), ("Heading 2", 13)]:
        st = doc.styles[name]
        st.font.name = "Calibri"; st.font.size = Pt(size); st.font.bold = True
        st._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
        st.font.color.rgb = RGBColor.from_string(BLUE)
    footer = s.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    font(footer.add_run("浴缸关键词经营决策字段说明 | 2026-08-13"), 8.5, False, MUTED)


def build():
    doc = Document(); setup(doc)
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    font(p.add_run("浴缸关键词经营决策\n三个复杂字段说明"), 22, True, NAVY)
    p.paragraph_format.space_after = Pt(8)
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    font(p.add_run("给运营看的简版：重点词、优先级、产品方向"), 11.5, False, MUTED)
    paragraph(doc, "", after=8)
    grid(doc, ["字段", "它回答的问题", "当前实现"], [
        ["是否重点词", "这个需求是不是长期稳定存在？", "飞书公式，等历史批次回填后自动判断"],
        ["优先级", "这个词现在要不要马上跟？", "飞书公式，不必等重点词确认"],
        ["对应产品方向", "这个词对应什么产品机会？", "AI 文本，只按词里已有信息生成"],
    ], [2100, 3650, 3610])
    paragraph(doc, "一句话理解：重点词看长期，优先级看现在，产品方向看要做什么。", size=12, bold=True, color=NAVY, after=10)
    heading(doc, "现在已经完成什么")
    bullet(doc, "主表的“是否重点词”和“优先级”已改为飞书公式字段；新记录会自动套用公式。")
    bullet(doc, "已新增 3 个辅助字段：已有有效批次数、近8批出现次数、历史表的批次编号。")
    bullet(doc, "产品方向的 AI 提示词已定稿，但还没有证据证明它已在飞书保存并批量运行。")
    paragraph(doc, "为什么现在大量显示“观察中”：历史表还没有由周更导入器持续回填真实批次，因此公式没有足够的历史依据。这是正常状态，不是公式失效。", size=10.5, color=MUTED)

    doc.add_page_break()
    heading(doc, "一、是否重点词")
    paragraph(doc, "它不是“本周很热的词”，而是长期反复出现、值得沉淀为产品需求的词。")
    grid(doc, ["判断顺序", "结果"], [
        ["搜索词为空", "留空"],
        ["有效批次不足 8 次", "观察中"],
        ["品牌词，或清洁/漏水/排水/维修等服务需求", "否"],
        ["最近 8 批中出现至少 6 次", "是"],
        ["其他情况", "否"],
    ], [4700, 4660])
    paragraph(doc, "例子：", bold=True, after=3)
    bullet(doc, "一个词刚采集 2 周，即使热度高，也先是“观察中”。")
    bullet(doc, "“科勒浴缸官方旗舰店”长期出现，仍是“否”，因为它是品牌导航，不是产品需求。")
    bullet(doc, "一个产品需求连续 8 周里出现 6 次以上，才是“是”。")
    paragraph(doc, "运营怎么用：用它筛“长期要不要沉淀”。不要用它判断本周要不要抢机会。", size=11, bold=True, color=NAVY)

    doc.add_page_break()
    heading(doc, "二、优先级")
    paragraph(doc, "优先级看短期机会和时间紧迫性。它不等“是否重点词”确认，因为等满 8 周可能会错过风口。")
    grid(doc, ["结果", "什么时候出现", "运营动作"], [
        ["A-立即跟进", "新机会信号很强：至少2批、近8批只出现1次、排名前100，且购买/对比意图、搜索高、交易中或高", "快速验证：选品、内容或小批测试"],
        ["B-持续观察", "购买/对比意图明确，搜索高，交易中或高，但还不够像新风口", "持续跟踪下几周变化"],
        ["C-常规跟踪", "品牌词、服务型需求，或普通低信号词", "不抢时间，放入常规词池"],
        ["观察中", "没有有效历史批次", "先补采集，不下结论"],
    ], [2100, 4400, 2860])
    paragraph(doc, "例子：", bold=True, after=3)
    bullet(doc, "某新词只出现过 2 批，但当前排名 99，且是购买/对比意图、搜索高、交易中：可以是 A。")
    bullet(doc, "同一个词即使还是“重点词观察中”，也不影响被判为 A。")
    paragraph(doc, "运营怎么用：用它决定“现在先做什么”。A 是抢机会，B 是盯变化，C 是常规维护。", size=11, bold=True, color=NAVY)

    doc.add_page_break()
    heading(doc, "三、对应产品方向")
    paragraph(doc, "这是给运营的产品参考名，不是硬公式。它用 AI，是因为同一个词里可能同时包含场景、材质、尺寸、风格和功能，公式很难组合得自然。")
    grid(doc, ["输入", "规则"], [
        ["原始关键词", "最终事实依据。原词没写的属性，不能补。"],
        ["标准归并词、关键词分类、细分标签", "只帮助理解，和原词冲突时以原词为准。"],
        ["品牌、店铺、地域、颜色", "不生成产品方向。"],
        ["清洁、维修、漏水等服务问题", "留空，不强行转成产品。"],
    ], [3100, 6260])
    grid(doc, ["关键词", "产品方向输出"], [
        ["家用浴缸", "家用浴缸"],
        ["高端人造石浴缸", "高端人造石浴缸"],
        ["日式深泡小浴缸", "小型日式深泡浴缸"],
        ["科勒浴缸官方旗舰店", "留空"],
        ["浴缸漏水维修", "留空"],
    ], [4700, 4660])
    paragraph(doc, "运营怎么用：优先级告诉你先不先做；产品方向告诉你可以往哪个产品组合看。没有明确产品属性时留空，比猜错更好。", size=11, bold=True, color=NAVY)

    doc.add_page_break()
    heading(doc, "新增辅助字段与下一步")
    grid(doc, ["字段", "放在哪里", "作用"], [
        ["已有有效批次数", "关键词分析主表", "判断是否已有足够历史；重点词满 8 批才进入确认。"],
        ["近8批出现次数", "关键词分析主表", "判断长期稳定：最近 8 批中出现几次。"],
        ["批次编号", "历史表", "把每周新建的采集表按先后顺序串起来。"],
    ], [2600, 2500, 4260])
    heading(doc, "还没有完成的部分")
    bullet(doc, "周更导入器还要把真实历史快照回填到这两个主表辅助字段。完成后，重点词和优先级会自动从“观察中”逐步变成真实结论。")
    bullet(doc, "需要把“对应产品方向”的最新版 AI 提示词保存到飞书，并先抽样运行，再决定是否批量跑。")
    paragraph(doc, "本版边界：只说明已确定的 V1 口径。阈值是否要调整，等真实周更数据积累后再由运营复核；不要为了填满字段而人为补数据。", size=10.5, color=MUTED)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc.save(OUT)
    print(OUT)


if __name__ == "__main__":
    build()
