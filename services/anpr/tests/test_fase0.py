"""Pruebas de las correcciones de la Fase 0 (umbrales de detección y consenso por nitidez)."""

import numpy as np

import app.aplicacion.detector as detector_mod
from app.aplicacion.detector import DetectionPipeline, byte_track_thresholds
from app.infraestructura.detectors import MockDetector


def test_umbral_configurado_se_respeta(monkeypatch):
    monkeypatch.setattr(detector_mod, "PLATE_CONFIDENCE_THRESHOLD", 0.50)
    high, low = byte_track_thresholds()
    assert high == 0.50
    assert 0.05 <= low < high


def test_umbral_bajo_no_supera_al_alto(monkeypatch):
    monkeypatch.setattr(detector_mod, "PLATE_CONFIDENCE_THRESHOLD", 0.04)
    high, low = byte_track_thresholds()
    assert low <= high


def test_lectura_borrosa_no_vota():
    pipeline = DetectionPipeline(detector=MockDetector())
    pipeline.update_track_plate(1, "PBA1234", 0.9, quality=10.0)   # borrosa: no vota
    pipeline.update_track_plate(1, "PBA1284", 0.6, quality=80.0)   # nítida
    assert pipeline.get_track_info(1)["plate"] == "PBA1284"


def test_consenso_supera_a_una_lectura_aislada():
    pipeline = DetectionPipeline(detector=MockDetector())
    for _ in range(3):
        pipeline.update_track_plate(7, "PBA1234", 0.7, quality=80.0)
    pipeline.update_track_plate(7, "PBA1284", 0.9, quality=80.0)
    assert pipeline.get_track_info(7)["plate"] == "PBA1234"


def test_estado_confirmada_no_borra_la_placa():
    pipeline = DetectionPipeline(detector=MockDetector())
    pipeline.update_track_plate(3, "PBA1234", 0.8, quality=80.0)
    pipeline.update_track_plate(3, "", 0.0, "confirmada")
    info = pipeline.get_track_info(3)
    assert info["plate"] == "PBA1234"
    assert info["status"] == "confirmada"
