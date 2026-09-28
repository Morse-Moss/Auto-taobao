#!/usr/bin/env python3
import json, sys

# 输出编码必须**显式钉死**，不能依赖运行环境。
# 原因：node 侧是按 utf-8 解码本脚本 stdout 的（`import-product-data.mjs` /
# `import-inquiry-data.mjs` 里的 `spawnSync(..., { encoding: 'utf8' })`）。
# 而 python 在 Windows 上默认跟随 locale 输出（cp936 / GBK）—— 只要父进程环境里
# 没有 PYTHONUTF8 / PYTHONIOENCODING，中文就会被 node 按 utf-8 解成 `���…`：
# 「延迟统计」会变成 `�ӳ�ͳ��`，「当前在线」会变成 `��ǰ����`。
# 实测（2026-09-28）：`PYTHONIOENCODING=gbk` 跑本脚本，输出里 U+FFFD 出现 609 次，
# 与飞书里 2026-09-23 / 09-25 两批商品数据的乱码逐字一致。
# 同项目其它调用点都已经钉了（推广 readZip 用 sys.stdout.reconfigure，
# run-daily-report / faq-operator-content 用 PYTHONIOENCODING），这一处此前漏了。
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

try:
    import win32com.client
    excel = win32com.client.DispatchEx("Excel.Application")
    excel.Visible = False
    book = excel.Workbooks.Open(sys.argv[1], ReadOnly=True)
    sheet = book.Worksheets(1)
    used = sheet.UsedRange
    values = used.Value
    if used.Rows.Count == 1:
        values = (values,)
    rows = [["" if value is None else str(value) for value in row] for row in values]
    book.Close(False)
    excel.Quit()
except Exception:
    import xlrd
    book = xlrd.open_workbook(sys.argv[1], formatting_info=False)
    sheet = book.sheet_by_index(0)
    rows = [["" if v is None else str(v) for v in sheet.row_values(i)] for i in range(sheet.nrows)]
print(json.dumps(rows, ensure_ascii=False))
