#!/usr/bin/env python3

import argparse
import csv
import io
import json
import zipfile
from datetime import date, datetime

import openpyxl


def as_date(value):
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value or '').strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--shop-xlsx', required=True)
    parser.add_argument('--promotion-zip', required=True)
    parser.add_argument('--date', required=True)
    args = parser.parse_args()

    workbook = openpyxl.load_workbook(args.shop_xlsx, data_only=True, read_only=True)
    if workbook.sheetnames != ['data']:
        raise ValueError(f'expected only data sheet, got {workbook.sheetnames}')
    rows = list(workbook['data'].iter_rows(values_only=True))
    if not rows or len(rows[0]) != 119:
        raise ValueError(f'expected 119 shop columns, got {len(rows[0]) if rows else 0}')
    matches = [row for row in rows[1:] if as_date(row[0]) == args.date]
    if len(matches) != 1:
        raise ValueError(f'expected one shop row for {args.date}, got {len(matches)}')

    with zipfile.ZipFile(args.promotion_zip) as archive:
        names = [name for name in archive.namelist() if not name.endswith('/')]
        if len(names) != 1 or not names[0].lower().endswith('.csv'):
            raise ValueError(f'expected one CSV in promotion ZIP, got {names}')
        text = archive.read(names[0]).decode('gb18030').lstrip('\ufeff')
    promotion_rows = [row for row in csv.reader(io.StringIO(text)) if any(cell.strip() for cell in row)]
    if not promotion_rows or len(promotion_rows[0]) != 71:
        raise ValueError(f'expected 71 promotion columns, got {len(promotion_rows[0]) if promotion_rows else 0}')
    if any(len(row) != 71 for row in promotion_rows):
        raise ValueError('promotion CSV contains a row with an unexpected column count')

    print(json.dumps({
        'shop': {'headers': list(rows[0]), 'values': list(matches[0]), 'workbookRows': len(rows)},
        'promotion': {'headers': promotion_rows[0], 'rows': promotion_rows[1:], 'csvName': names[0]},
    }, ensure_ascii=False, default=as_date))


if __name__ == '__main__':
    main()
