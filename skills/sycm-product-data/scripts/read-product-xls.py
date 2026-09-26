#!/usr/bin/env python3
import json, sys
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
