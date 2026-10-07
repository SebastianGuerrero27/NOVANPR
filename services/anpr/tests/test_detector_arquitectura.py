"""
El detector de placas de producción debe ser YOLO26 (ver models/MODEL_CARD.md).

La arquitectura se identifica por la estructura de la red, no por el nombre del archivo:
YOLO26 = bloques C3k2 + C2PSA y cabeza Detect sin DFL (reg_max = 1); YOLO11 = C3k2 con
reg_max = 16; YOLOv8 = bloques C2f.
"""

from pathlib import Path

import pytest

from app.infraestructura.detectors import identificar_arquitectura

MODELO_PRODUCCION = Path(__file__).resolve().parent.parent / "models" / "license_plate_detector.pt"


def _red(*bloques: str, reg_max: int | None = None):
    """Red falsa con capas cuyos nombres de clase imitan los de Ultralytics."""
    capas = [type(nombre, (), {})() for nombre in bloques]
    cabeza = type("Detect", (), {"reg_max": reg_max})()
    return type("DetectionModel", (), {"model": capas + [cabeza]})()


@pytest.mark.parametrize(
    "red, esperada",
    [
        (_red("Conv", "C3k2", "SPPF", "C2PSA", reg_max=1), "yolo26"),
        (_red("Conv", "C3k2", "SPPF", "C2PSA", reg_max=16), "yolo11"),
        (_red("Conv", "C2f", "SPPF", reg_max=16), "yolov8"),
        (_red("Conv", "SPPF", reg_max=16), "desconocida"),
        (None, "desconocida"),
    ],
)
def test_identificar_arquitectura(red, esperada):
    assert identificar_arquitectura(red) == esperada


def test_modelo_de_produccion_es_yolo26_de_una_clase():
    ultralytics = pytest.importorskip("ultralytics")
    assert MODELO_PRODUCCION.exists(), f"Falta {MODELO_PRODUCCION}"
    modelo = ultralytics.YOLO(str(MODELO_PRODUCCION))
    assert identificar_arquitectura(modelo.model) == "yolo26"
    assert modelo.names == {0: "license_plate"}
