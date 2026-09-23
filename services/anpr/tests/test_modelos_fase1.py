"""Pruebas de la integración de modelos: OCR especializado, verificador PP-OCRv6 y RF-DETR."""

import sys
import types

import numpy as np
import pytest

import app.core.ocr_engine as ocr_mod
from app.core.ocr_verifier import parse_plate_lines


def test_verificador_ignora_cabecera_ecuador():
    assert parse_plate_lines(["ECUADOR", "PSY-589"], [0.99, 0.90]) == ("PSY589", 0.90)


def test_verificador_corrige_homoglifos_por_posicion():
    # O en zona de dígitos -> 0 ; 8 en zona de letras -> B
    assert parse_plate_lines(["P8A-12O4"], [0.8])[0] == "PBA1204"


def test_verificador_cabecera_pegada_o_mal_leida():
    assert parse_plate_lines(["ECUADORPSY-589"], [0.9])[0] == "PSY589"
    assert parse_plate_lines(["ECUADGR", "PSY-589"], [0.99, 0.9])[0] == "PSY589"


def test_verificador_une_fragmentos_de_la_misma_fila():
    from app.core.ocr_verifier import merge_row_fragments
    boxes = [
        [[10, 5], [90, 5], [90, 20], [10, 20]],      # ECUADOR (arriba)
        [[60, 30], [120, 30], [120, 60], [60, 60]],  # Y-589
        [[5, 32], [55, 32], [55, 62], [5, 62]],      # PS
    ]
    txts, _ = merge_row_fragments(boxes, ["ECUADOR", "Y-589", "PS"], [0.9, 0.9, 0.9])
    assert txts == ["ECUADOR", "PSY-589"]


def test_verificador_sin_placa():
    assert parse_plate_lines(["ECUADOR", "ANT"], [0.9, 0.9]) == ("", 0.0)


class _FakeRecognizer:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.config = types.SimpleNamespace(image_color_mode="rgb")

    def run(self, image, return_confidence=False):
        return [types.SimpleNamespace(plate="PSY589", char_probs=np.array([0.9, 0.8]))]


@pytest.fixture
def fake_fast_plate_ocr(monkeypatch):
    fake = types.ModuleType("fast_plate_ocr")
    fake.LicensePlateRecognizer = _FakeRecognizer
    monkeypatch.setitem(sys.modules, "fast_plate_ocr", fake)
    return fake


def test_ocr_usa_modelo_afinado_si_existe(fake_fast_plate_ocr, tmp_path, monkeypatch):
    onnx, cfg = tmp_path / "m.onnx", tmp_path / "c.yaml"
    onnx.write_bytes(b"x")
    cfg.write_text("x")
    monkeypatch.setattr(ocr_mod, "PLATE_OCR_ONNX_PATH", str(onnx))
    monkeypatch.setattr(ocr_mod, "PLATE_OCR_CONFIG_PATH", str(cfg))
    eng = ocr_mod.FastPlateOcrEngine()
    assert eng._recognizer.kwargs["onnx_model_path"] == str(onnx)
    assert eng.model_id == "m.onnx"


def test_ocr_usa_hub_sin_preprocesado_si_no_hay_afinado(fake_fast_plate_ocr, tmp_path, monkeypatch):
    monkeypatch.setattr(ocr_mod, "PLATE_OCR_ONNX_PATH", str(tmp_path / "no_existe.onnx"))
    monkeypatch.setattr(ocr_mod, "preprocess_plate_opencv", lambda *a, **k: pytest.fail("no debe preprocesar"))
    eng = ocr_mod.FastPlateOcrEngine(preprocess=False)
    assert eng.model_id == "cct-s-v2-global-model"
    res = eng.read_text(np.full((40, 120, 3), 200, np.uint8))
    assert res[0].text == "PSY589"


def test_factory_plate_no_usa_respaldos(fake_fast_plate_ocr, monkeypatch):
    monkeypatch.setattr(ocr_mod, "OCR_ENGINE", "plate")
    assert isinstance(ocr_mod.create_ocr_engine(), ocr_mod.FastPlateOcrEngine)


def test_rfdetr_sin_paquete_da_error_claro(monkeypatch):
    from app.core import detectors
    monkeypatch.setitem(sys.modules, "rfdetr", None)
    with pytest.raises(RuntimeError, match="rfdetr"):
        detectors.create_detector("x.pth", model_type="rfdetr-nano")
