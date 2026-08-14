#!/usr/bin/env python3

import argparse
import csv
import hashlib
import io
import json
import tempfile
import zipfile
from decimal import Decimal, InvalidOperation
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.drawing.image import Image as WorksheetImage
from PIL import Image


HEADERS = [
    "序号",
    "商品图片",
    "商品标题",
    "商品链接",
    "价格",
    "月收货人数",
    "类目",
    "同款数",
    "平台",
    "占位类型",
    "店铺名",
    "店铺旺旺",
    "店铺类型",
    "地址",
    "收藏人数",
    "卖点",
]
COUNT_HEADERS = {"月收货人数", "付款人数"}


def supported_headers(headers):
    values = list(headers)
    return (
        len(values) == len(HEADERS)
        and values[5] in COUNT_HEADERS
        and all(value == HEADERS[index] for index, value in enumerate(values) if index != 5)
    )


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def read_csv(path):
    last_error = None
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            with open(path, "r", encoding=encoding, newline="") as handle:
                return list(csv.reader(handle))
        except UnicodeDecodeError as error:
            last_error = error
    raise last_error


def validate_rows(headers, rows):
    if not supported_headers(headers):
        raise ValueError("Xiaowangshen headers do not match the 16-column contract")
    if not rows:
        raise ValueError("Xiaowangshen dataset is empty")
    links = []
    for index, row in enumerate(rows, 1):
        if len(row) != len(HEADERS):
            raise ValueError(f"row {index} does not contain 16 columns")
        try:
            rank = int(row[0])
        except (TypeError, ValueError) as error:
            raise ValueError(f"rank is not an integer at row {index}") from error
        if rank != index:
            raise ValueError(f"ranks are not contiguous at row {index}")
        link = str(row[3] or "").strip()
        if not link:
            raise ValueError(f"empty product link at row {index}")
        links.append(link)
    if len(set(links)) != len(links):
        raise ValueError("duplicate product links detected")
    return {
        "rows": len(rows),
        "columns": len(headers),
        "rank_range": f"1-{len(rows)}",
        "empty_links": 0,
        "duplicate_links": 0,
    }


def normalize(value):
    if value is None:
        return ""
    text = str(value)
    try:
        number = Decimal(text)
        if number == number.to_integral_value():
            return format(number.quantize(Decimal("1")), "f")
        return format(number.normalize(), "f").rstrip("0").rstrip(".")
    except InvalidOperation:
        return text


def inspect_workbook(path):
    with zipfile.ZipFile(path) as archive:
        bad_member = archive.testzip()
        media = [name for name in archive.namelist() if name.startswith("xl/media/") and not name.endswith("/")]
        bad_images = []
        dimensions = {}
        for name in media:
            try:
                with Image.open(io.BytesIO(archive.read(name))) as image:
                    size = f"{image.width}x{image.height}"
                    image.verify()
                    dimensions[size] = dimensions.get(size, 0) + 1
            except Exception as error:
                bad_images.append({"name": name, "error": str(error)})

    workbook = load_workbook(path, read_only=True, data_only=False)
    sheet = workbook[workbook.sheetnames[0]]
    values = list(sheet.iter_rows(values_only=True))
    headers = ["" if value is None else str(value) for value in values[0]]
    rows = [list(row) for row in values[1:]]
    formulas = sum(
        1
        for row in values
        for value in row
        if isinstance(value, str) and value.startswith("=")
    )
    workbook.close()
    result = validate_rows(headers, rows)
    result.update({
        "sheet": workbook.sheetnames[0],
        "zip_crc_ok": bad_member is None,
        "bad_zip_member": bad_member,
        "embedded_media": len(media),
        "bad_images": len(bad_images),
        "formula_count": formulas,
        "dominant_image_dimensions": sorted(
            dimensions.items(), key=lambda item: item[1], reverse=True
        )[:5],
    })
    return headers, rows, result


def compare_rows(csv_rows, xlsx_rows):
    differences = []
    for row_index, (csv_row, xlsx_row) in enumerate(zip(csv_rows, xlsx_rows), 1):
        for column_index, (csv_value, xlsx_value) in enumerate(zip(csv_row, xlsx_row), 1):
            if column_index == 2:
                continue
            if normalize(csv_value) != normalize(xlsx_value):
                differences.append({
                    "row": row_index,
                    "column": column_index,
                    "csv": csv_value,
                    "xlsx": xlsx_value,
                })
    return differences


def validate(csv_path, xlsx_path=None, require_images=False):
    csv_table = read_csv(csv_path)
    csv_headers, csv_rows = csv_table[0], csv_table[1:]
    validation = validate_rows(csv_headers, csv_rows)
    artifacts = {
        "csv": {
            "path": str(Path(csv_path).resolve()),
            "size_bytes": Path(csv_path).stat().st_size,
            "sha256": sha256(csv_path),
        }
    }
    validation["headers"] = csv_headers

    if xlsx_path:
        xlsx_headers, xlsx_rows, workbook_validation = inspect_workbook(xlsx_path)
        if xlsx_headers != csv_headers:
            raise ValueError("CSV and XLSX headers do not match")
        if len(xlsx_rows) != len(csv_rows):
            raise ValueError("CSV and XLSX row counts do not match")
        differences = compare_rows(csv_rows, xlsx_rows)
        validation.update(workbook_validation)
        validation["non_image_field_differences"] = len(differences)
        validation["difference_samples"] = differences[:5]
        if differences:
            raise ValueError("CSV and XLSX non-image fields differ")
        if require_images and workbook_validation["embedded_media"] != len(csv_rows):
            raise ValueError("embedded image count does not match the data row count")
        if workbook_validation["bad_images"]:
            raise ValueError("workbook contains unreadable embedded images")
        if not workbook_validation["zip_crc_ok"]:
            raise ValueError("workbook ZIP CRC validation failed")
        artifacts["xlsx"] = {
            "path": str(Path(xlsx_path).resolve()),
            "size_bytes": Path(xlsx_path).stat().st_size,
            "sha256": sha256(xlsx_path),
        }
    return {"ok": True, "artifacts": artifacts, "validation": validation}


def make_self_test_fixture(directory):
    rows = [
        [1, "", "A", "https://item.taobao.com/item.htm?id=1", 100, "10", "c", "0", "淘宝", "自然位", "s", "w", "t", "a", "-", "-"],
        [2, "", "B", "https://item.taobao.com/item.htm?id=2", 200, "100+", "c", "-", "天猫", "广告位", "s", "w", "t", "a", "-", "-"],
    ]
    csv_path = directory / "fixture.csv"
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(HEADERS)
        writer.writerows(rows)

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "xlsx"
    sheet.append(HEADERS)
    for row in rows:
        sheet.append(row)
    for index in range(2):
        image_path = directory / f"image-{index}.png"
        Image.new("RGB", (2, 2), color=(index * 50, 100, 150)).save(image_path)
        sheet.add_image(WorksheetImage(image_path), f"B{index + 2}")
    xlsx_path = directory / "fixture.xlsx"
    workbook.save(xlsx_path)
    return csv_path, xlsx_path


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv")
    parser.add_argument("--xlsx")
    parser.add_argument("--require-images", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()
    try:
        if args.self_test:
            with tempfile.TemporaryDirectory(prefix="xws-validator-") as temp:
                csv_path, xlsx_path = make_self_test_fixture(Path(temp))
                result = validate(csv_path, xlsx_path, require_images=True)
        else:
            if not args.csv:
                raise ValueError("--csv is required")
            result = validate(args.csv, args.xlsx, args.require_images)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
