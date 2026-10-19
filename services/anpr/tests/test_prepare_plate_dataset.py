"""Conversion real de pose a deteccion y rechazo de datos que invalidan la evaluacion."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

from PIL import Image

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "prepare_plate_dataset.py"
SPEC = importlib.util.spec_from_file_location("prepare_plate_dataset", SCRIPT)
preparation = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = preparation
SPEC.loader.exec_module(preparation)

POSE = "0 0.5 0.5 0.8 0.6 0.1 0.2 2 0.9 0.2 2 0.9 0.8 2 0.1 0.8 2\n"


class TestPreparePlateDataset(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "original"
        self.output = self.root / "prepared"
        for split, color in (("train", (80, 20, 40)), ("val", (20, 80, 40))):
            (self.source / "images" / split).mkdir(parents=True)
            (self.source / "labels" / split).mkdir(parents=True)
            Image.new("RGB", (100, 60), color).save(self.source / "images" / split / f"pose_{split}.jpg")
            (self.source / "labels" / split / f"pose_{split}.txt").write_text(POSE)
        (self.source / "data.yaml").write_text("path: /obsolete/pose\nkpt_shape: [4, 3]\n")

    def test_converts_pose_preserves_splits_and_source_and_previews(self):
        before = {str(p.relative_to(self.source)): p.read_bytes() for p in self.source.rglob("*") if p.is_file()}
        report = preparation.prepare_dataset(self.source, self.output, preview_count=2)
        self.assertEqual(report["splits"]["train"]["images"], 1)
        self.assertEqual(report["splits"]["val"]["images"], 1)
        self.assertEqual(report["splits"]["train"]["source_row_columns"], {"17": 1})
        self.assertTrue(report["synthetic_origin_inferred"])
        self.assertEqual(len((self.output / "labels/train/pose_train.txt").read_text().split()), 5)
        self.assertNotIn("path:", (self.output / "data.yaml").read_text())
        self.assertNotIn("kpt_shape", (self.output / "data.yaml").read_text())
        self.assertTrue((self.output / "preview/contact_sheet.jpg").exists())
        self.assertEqual(json.loads((self.output / "provenance.json").read_text(encoding="utf-8"))["preserved_splits"], True)
        self.assertEqual(before, {str(p.relative_to(self.source)): p.read_bytes() for p in self.source.rglob("*") if p.is_file()})

    def test_rejects_duplicate_pixels_across_splits_even_different_files(self):
        image = Image.open(self.source / "images/train/pose_train.jpg")
        (self.source / "images/val/pose_val.jpg").unlink()
        image.save(self.source / "images/val/pose_val.png")
        with self.assertRaisesRegex(ValueError, "Fuga entre particiones"):
            preparation.prepare_dataset(self.source, self.output)
        self.assertFalse(self.output.exists())

    def test_rejects_missing_label_without_publishing_partial_dataset(self):
        (self.source / "labels/val/pose_val.txt").unlink()
        with self.assertRaisesRegex(ValueError, "pares imagen/etiqueta incompletos"):
            preparation.prepare_dataset(self.source, self.output)
        self.assertFalse(self.output.exists())

    def test_rejects_invalid_bbox_keypoints_class_and_nonfinite(self):
        for label in ("0 0.95 0.5 0.8 0.6", POSE.replace("0.1 0.2 2", "1.1 0.2 2"),
                      POSE.replace("0 ", "1 ", 1), "0 nan 0.5 0.8 0.6"):
            with self.subTest(label=label):
                (self.source / "labels/train/pose_train.txt").write_text(label)
                with self.assertRaises(ValueError):
                    preparation.prepare_dataset(self.source, self.output)
                self.assertFalse(self.output.exists())

    def test_refuses_existing_output_and_nested_output(self):
        self.output.mkdir()
        marker = self.output / "preserve.txt"
        marker.write_text("keep")
        with self.assertRaisesRegex(ValueError, "destino ya existe"):
            preparation.prepare_dataset(self.source, self.output)
        self.assertEqual(marker.read_text(), "keep")
        with self.assertRaisesRegex(ValueError, "sin anidamiento"):
            preparation.prepare_dataset(self.source, self.source / "nested")

    def test_detection_and_negative_images_remain_valid(self):
        (self.source / "labels/train/pose_train.txt").write_text("0 0.5 0.5 0.8 0.6\n")
        (self.source / "labels/val/pose_val.txt").write_text("")
        report = preparation.prepare_dataset(self.source, self.output, preview_count=0)
        self.assertEqual(report["splits"]["val"]["empty_labels"], 1)
        self.assertEqual((self.output / "labels/val/pose_val.txt").read_text(), "")
        self.assertFalse((self.output / "preview").exists())


if __name__ == "__main__":
    unittest.main()
