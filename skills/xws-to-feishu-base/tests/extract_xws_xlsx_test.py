import importlib.util
import json
import tempfile
import unittest
from io import BytesIO
from pathlib import Path

from openpyxl import Workbook
from openpyxl.drawing.image import Image
from PIL import Image as PillowImage


SCRIPT = Path(__file__).parents[1] / "scripts" / "extract_xws_xlsx.py"


class ExtractXwsXlsxTest(unittest.TestCase):
    def test_stdout_json_is_ascii_safe_for_windows_child_processes(self):
        spec = importlib.util.spec_from_file_location("extract_xws_xlsx", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        payload = module.serialize_stdout({"headers": ["商品图片"]})

        self.assertTrue(payload.isascii())
        self.assertEqual(json.loads(payload), {"headers": ["商品图片"]})

    def test_maps_embedded_images_to_source_rows(self):
        spec = importlib.util.spec_from_file_location("extract_xws_xlsx", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image_path = root / "product.png"
            PillowImage.new("RGB", (4, 4), "red").save(image_path)

            workbook_path = root / "source.xlsx"
            workbook = Workbook()
            sheet = workbook.active
            sheet.append(["序号", "商品图片", "商品标题"])
            sheet.append([1, None, "第一行"])
            sheet.append([2, None, "第二行"])
            streams = [BytesIO(image_path.read_bytes()), BytesIO(image_path.read_bytes())]
            test_images = [Image(stream) for stream in streams]
            sheet.add_image(test_images[0], "B2")
            sheet.add_image(test_images[1], "B3")
            workbook.save(workbook_path)
            for stream in streams:
                stream.close()

            result = module.extract_workbook(workbook_path, root / "out")

            self.assertEqual([row["序号"] for row in result["rows"]], [1, 2])
            self.assertEqual(len(result["images"]), 2)
            self.assertEqual([item["row"] for item in result["images"]], [2, 3])
            self.assertTrue(all(Path(item["path"]).is_file() for item in result["images"]))


if __name__ == "__main__":
    unittest.main()
