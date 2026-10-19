"""Arquitectura ONNX explicita y procedencia, sin inferir familias por nombres."""
import sys
from types import SimpleNamespace

import onnx
from onnx import TensorProto, helper
import pytest

from app.infraestructura import detectors
from app.infraestructura.model_architecture import guardar_metadata_arquitectura_onnx, leer_arquitectura_onnx


def create_onnx(path, metadata):
    graph = helper.make_graph([helper.make_node("Identity", ["x"], ["y"])], "metadata-test",
                              [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, 3, 2, 2])],
                              [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, 3, 2, 2])])
    model = helper.make_model(graph)
    helper.set_model_props(model, metadata)
    onnx.save(model, str(path))
    return model


def fake_yolo(monkeypatch, network=None):
    monkeypatch.setitem(sys.modules, "ultralytics", SimpleNamespace(
        YOLO=lambda path: SimpleNamespace(model=network, names={0: "license_plate"})))


@pytest.mark.parametrize("architecture", ["yolo26", "yolo11", "yolov8"])
def test_runtime_reads_only_explicit_supported_onnx_family(tmp_path, monkeypatch, architecture):
    path = tmp_path / "arbitrary_name.ONNX"
    create_onnx(path, {"anpr_architecture": architecture})
    fake_yolo(monkeypatch)
    assert detectors.YoloDetector(str(path)).arquitectura == architecture


@pytest.mark.parametrize("architecture", [None, "", "YOLO26", "yolo26.pt", "rfdetr", "desconocida"])
def test_missing_or_invalid_metadata_does_not_infer_from_filename_or_description(tmp_path, monkeypatch, architecture):
    path = tmp_path / "yolo26n_detector.onnx"
    metadata = {"description": "YOLO26n license plate detector"}
    if architecture is not None:
        metadata["anpr_architecture"] = architecture
    create_onnx(path, metadata)
    fake_yolo(monkeypatch)
    assert detectors.YoloDetector(str(path)).arquitectura == "desconocida"


def test_pt_structure_remains_authoritative_and_does_not_read_onnx_metadata(monkeypatch):
    layers = [type("C3k2", (), {})(), type("Detect", (), {"reg_max": 16})()]
    fake_yolo(monkeypatch, SimpleNamespace(model=layers))
    monkeypatch.setattr(detectors, "leer_arquitectura_onnx", lambda path: pytest.fail("PT must not read ONNX metadata"))
    assert detectors.YoloDetector("misleading_yolo26.pt").arquitectura == "yolo11"


def test_unknown_pt_does_not_consume_metadata_even_if_file_contains_onnx(tmp_path, monkeypatch):
    path = tmp_path / "yolo26.pt"
    create_onnx(path, {"anpr_architecture": "yolo26"})
    fake_yolo(monkeypatch)
    assert detectors.YoloDetector(str(path)).arquitectura == "desconocida"


def test_structural_family_wins_over_conflicting_onnx_metadata(tmp_path, monkeypatch):
    path = tmp_path / "model.onnx"
    create_onnx(path, {"anpr_architecture": "yolov8"})
    layers = [type("C3k2", (), {})(), type("Detect", (), {"reg_max": 1})()]
    fake_yolo(monkeypatch, SimpleNamespace(model=layers))
    assert detectors.YoloDetector(str(path)).arquitectura == "yolo26"


def test_export_metadata_preserves_graph_and_existing_properties(tmp_path):
    path = tmp_path / "model.onnx"
    original_metadata = {"names": "{0: 'license_plate'}", "imgsz": "[256, 256]",
                         "custom_property": "preserve-me", "anpr_architecture": "yolov8"}
    original = create_onnx(path, original_metadata)
    original_graph = original.graph.SerializeToString()
    source_hash = "a" * 64
    guardar_metadata_arquitectura_onnx(path, "yolo26", source_hash)
    exported = onnx.load(str(path))
    metadata = {entry.key: entry.value for entry in exported.metadata_props}
    assert metadata == {**original_metadata, "anpr_architecture": "yolo26", "anpr_source_pt_sha256": source_hash}
    assert exported.graph.SerializeToString() == original_graph
    assert leer_arquitectura_onnx(path) == "yolo26"


def test_unreadable_metadata_leaves_family_unknown(tmp_path):
    path = tmp_path / "yolo26.onnx"
    path.write_bytes(b"not an onnx graph")
    assert leer_arquitectura_onnx(path) == "desconocida"
