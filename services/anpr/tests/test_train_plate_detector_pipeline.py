"""Contratos del entrenamiento sin cargar pesos ni ejecutar una red neuronal."""

import importlib.util
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np
from PIL import Image
import yaml

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "train_plate_detector.py"
SPEC = importlib.util.spec_from_file_location("train_plate_detector_pipeline", SCRIPT)
training = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(training)


class TrainingDatasetFixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data_yaml = self.root / "data.yaml"
        self.config = {"train": "images/train", "val": "images/val", "names": {0: "license_plate"}}
        for split, color in (("train", (80, 20, 40)), ("val", (20, 80, 40))):
            (self.root / "images" / split).mkdir(parents=True)
            (self.root / "labels" / split).mkdir(parents=True)
            Image.new("RGB", (100, 60), color).save(self.root / "images" / split / "plate.png")
            (self.root / "labels" / split / "plate.txt").write_text("0 0.5 0.5 0.8 0.6\n")
        self.write_yaml()

    def write_yaml(self):
        self.data_yaml.write_text(yaml.safe_dump(self.config), encoding="utf-8")


class TestValidateTrainingDataset(TrainingDatasetFixture):
    def test_portable_yaml_uses_its_parent_and_stable_content_fingerprint(self):
        report = training.validate_dataset(self.data_yaml)
        self.assertEqual(report["root"], str(self.root.resolve()))
        self.assertEqual(report["splits"], {"train": {"images": 1, "boxes": 1}, "val": {"images": 1, "boxes": 1}})
        self.assertEqual(report, training.validate_dataset(self.data_yaml))
        (self.root / "labels/val/plate.txt").write_text("")
        changed = training.validate_dataset(self.data_yaml)
        self.assertEqual(changed["splits"]["val"]["boxes"], 0)
        self.assertNotEqual(changed["sha256"], report["sha256"])

    def test_explicit_absolute_root_and_list_class_name(self):
        self.config.update(path=str(self.root), names=["license_plate"])
        self.write_yaml()
        self.assertEqual(training.validate_dataset(self.data_yaml)["root"], str(self.root.resolve()))

    def test_relative_path_is_rejected_because_ultralytics_resolves_it_differently(self):
        for relative in (".", "../dataset"):
            with self.subTest(relative=relative):
                self.config["path"] = relative
                self.write_yaml()
                with self.assertRaisesRegex(ValueError, "Omita 'path'"):
                    training.validate_dataset(self.data_yaml)

    def test_rejects_pose_yaml_and_pose_labels(self):
        self.config["kpt_shape"] = [4, 3]
        self.write_yaml()
        with self.assertRaisesRegex(ValueError, "no pose"):
            training.validate_dataset(self.data_yaml)
        del self.config["kpt_shape"]
        self.write_yaml()
        (self.root / "labels/train/plate.txt").write_text("0 0.5 0.5 0.8 0.6 0.1 0.2 2 0.9 0.2 2 0.9 0.8 2 0.1 0.8 2")
        with self.assertRaisesRegex(ValueError, "5 columnas"):
            training.validate_dataset(self.data_yaml)

    def test_rejects_duplicate_image_bytes_across_splits(self):
        shutil.copy2(self.root / "images/train/plate.png", self.root / "images/val/plate.png")
        with self.assertRaisesRegex(ValueError, "duplicada entre"):
            training.validate_dataset(self.data_yaml)

    def test_rejects_missing_labels(self):
        (self.root / "labels/val/plate.txt").unlink()
        with self.assertRaisesRegex(ValueError, "Falta etiqueta"):
            training.validate_dataset(self.data_yaml)

    def test_rejects_invalid_boxes_classes_and_nonfinite_values(self):
        for row in ("0 0.95 0.5 0.8 0.6", "0 0.5 0.5 0 0.6", "0 0.5 0.5 1.1 0.6",
                    "1 0.5 0.5 0.8 0.6", "0 nan 0.5 0.8 0.6", "0 0.5 inf 0.8 0.6",
                    "0 0.5 0.5 -0.2 0.6", "not numbers here now please"):
            with self.subTest(row=row):
                (self.root / "labels/train/plate.txt").write_text(row)
                with self.assertRaises(ValueError):
                    training.validate_dataset(self.data_yaml)

    def test_requires_nonempty_train_and_val_and_single_class(self):
        for config in ({"train": "images/train", "names": {0: "license_plate"}},
                       {**self.config, "names": {0: "car"}},
                       {**self.config, "val": "images/absent"},
                       {**self.config, "train": ["images/train"]}):
            with self.subTest(config=config):
                self.config = config
                self.write_yaml()
                with self.assertRaises(ValueError):
                    training.validate_dataset(self.data_yaml)

    def test_nested_labels_follow_nested_images(self):
        for parent in ("images", "labels"):
            source = self.root / parent / "train"
            nested = source / "camera_a"
            nested.mkdir()
            next(p for p in source.iterdir() if p.is_file()).rename(nested / ("plate.png" if parent == "images" else "plate.txt"))
        self.assertEqual(training.validate_dataset(self.data_yaml)["splits"]["train"]["boxes"], 1)


class TestExportOnnx(unittest.TestCase):
    def test_dynamic_cpu_export_is_executed_and_benchmark_describes_scope(self):
        with tempfile.TemporaryDirectory() as temporary:
            candidate = Path(temporary) / "candidate.pt"
            candidate.write_bytes(b"candidate")
            onnx = candidate.with_suffix(".onnx")
            yolo = Mock()
            yolo.return_value.export.return_value = str(onnx)
            session = Mock()
            session.get_inputs.return_value = [SimpleNamespace(name="images")]
            session.run.return_value = [np.zeros((1, 300, 6), dtype=np.float32)]
            ort = SimpleNamespace(SessionOptions=Mock(side_effect=SimpleNamespace), InferenceSession=Mock(return_value=session))
            metadata = Mock()
            architecture_helpers = SimpleNamespace(identificar_arquitectura=Mock(return_value="yolo26"),
                                                   guardar_metadata_arquitectura_onnx=metadata)
            with patch.dict(sys.modules, {"ultralytics": SimpleNamespace(YOLO=yolo), "onnxruntime": ort,
                                          "app.infraestructura.model_architecture": architecture_helpers}):
                exported = training.export_onnx(candidate, 320)
            self.assertEqual(exported, onnx)
            metadata.assert_called_once_with(onnx, "yolo26", hashlib.sha256(b"candidate").hexdigest())
            yolo.return_value.export.assert_called_once_with(format="onnx", imgsz=320, batch=1,
                                                            dynamic=True, simplify=False, opset=17, device="cpu")
            self.assertEqual(ort.InferenceSession.call_args.kwargs["providers"], ["CPUExecutionProvider"])
            self.assertEqual(ort.InferenceSession.call_args.kwargs["sess_options"].intra_op_num_threads, 4)
            self.assertEqual(session.run.call_count, 11)
            tensor = session.run.call_args.args[1]["images"]
            self.assertEqual(tensor.shape, (1, 3, 320, 320))
            self.assertEqual(tensor.dtype, np.float32)
            result = json.loads(onnx.with_suffix(".benchmark.json").read_text())
            self.assertEqual(result["output_shapes"], [[1, 300, 6]])
            self.assertEqual(result["samples"], 10)
            self.assertIn("excluye preproceso, OCR y video", result["scope"])


class TestCandidatePromotion(TrainingDatasetFixture):
    def setUp(self):
        super().setUp()
        self.candidate = self.root / "candidate.pt"
        self.production = self.root / "production.pt"
        self.archive = self.root / "archive"
        self.candidate.write_bytes(b"candidate")
        self.production.write_bytes(b"production")
        self.constants = patch.multiple(training, DATA_YAML=self.data_yaml, PROD_PT=self.production, ARCHIVE_DIR=self.archive)
        self.constants.start()
        self.addCleanup(self.constants.stop)
        self.yolo = Mock()
        self.yolo.return_value.val.side_effect = [SimpleNamespace(box=SimpleNamespace(map=0.8)), SimpleNamespace(box=SimpleNamespace(map=0.5))]
        self.modules = patch.dict(sys.modules, {"ultralytics": SimpleNamespace(YOLO=self.yolo)})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def assert_production_unchanged(self):
        self.assertEqual(self.production.read_bytes(), b"production")
        self.assertFalse(self.archive.exists())

    def test_synthetic_validation_cannot_replace_production(self):
        (self.root / "provenance.json").write_text(json.dumps({"synthetic_origin_inferred": True}))
        with self.assertRaisesRegex(ValueError, "validación sintética"):
            training.promote(self.candidate)
        self.yolo.assert_not_called()
        self.assert_production_unchanged()

    def test_nonfinite_or_invalid_metrics_cannot_replace_production(self):
        for candidate, baseline in ((float("nan"), 0.5), (0.8, float("nan")), (float("inf"), 0.5), (0.8, -1)):
            with self.subTest(candidate=candidate, baseline=baseline):
                self.yolo.return_value.val.side_effect = [SimpleNamespace(box=SimpleNamespace(map=candidate)), SimpleNamespace(box=SimpleNamespace(map=baseline))]
                with self.assertRaisesRegex(ValueError, "métricas inválidas"):
                    training.promote(self.candidate)
                self.assert_production_unchanged()

    def test_weaker_candidate_does_not_replace_production(self):
        self.yolo.return_value.val.side_effect = [SimpleNamespace(box=SimpleNamespace(map=0.5)), SimpleNamespace(box=SimpleNamespace(map=0.8))]
        training.promote(self.candidate)
        self.assert_production_unchanged()

    def test_promotion_archives_the_previous_model(self):
        training.promote(self.candidate)
        self.assertEqual(self.production.read_bytes(), b"candidate")
        self.assertEqual([p.read_bytes() for p in self.archive.glob("*.pt")], [b"production"])

    def test_existing_derived_artifacts_prevent_stale_onnx_or_engine(self):
        for suffix in (".onnx", ".engine"):
            with self.subTest(suffix=suffix):
                artifact = self.production.with_suffix(suffix)
                artifact.write_bytes(b"old artifact")
                with self.assertRaisesRegex(ValueError, "todos los formatos juntos"):
                    training.promote(self.candidate)
                self.assert_production_unchanged()
                self.assertEqual(artifact.read_bytes(), b"old artifact")
                artifact.unlink()

    def test_missing_baseline_is_an_error_and_candidate_remains(self):
        self.production.unlink()
        with self.assertRaisesRegex(ValueError, "modelo de producción existente"):
            training.promote(self.candidate)
        self.assertEqual(self.candidate.read_bytes(), b"candidate")
        self.yolo.assert_not_called()


if __name__ == "__main__":
    unittest.main()
