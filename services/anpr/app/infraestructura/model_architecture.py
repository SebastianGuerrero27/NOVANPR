"""Identificacion de arquitectura sin cargar configuracion ni motores de inferencia."""
from __future__ import annotations

from pathlib import Path
from typing import Any

ARQUITECTURAS_YOLO = frozenset({"yolo26", "yolo11", "yolov8"})


def identificar_arquitectura(red: Any) -> str:
    """Identifica la familia por las capas del nn.Module, nunca por el nombre del archivo."""
    capas = list(getattr(red, "model", None) or [])
    if not capas:
        return "desconocida"
    tipos = {type(capa).__name__ for capa in capas}
    reg_max = getattr(capas[-1], "reg_max", None)
    if "C2f" in tipos:
        return "yolov8"
    if "C3k2" in tipos:
        if reg_max == 1:
            return "yolo26"
        if reg_max == 16:
            return "yolo11"
    return "desconocida"


def leer_arquitectura_onnx(path: str | Path) -> str:
    """Acepta solo la familia explicitamente registrada por nuestro exportador."""
    if Path(path).suffix.lower() != ".onnx":
        return "desconocida"
    try:
        import onnx

        model = onnx.load(str(path), load_external_data=False)
        metadata = {entry.key: entry.value for entry in model.metadata_props}
        arquitectura = metadata.get("anpr_architecture")
    except Exception:
        return "desconocida"
    return arquitectura if arquitectura in ARQUITECTURAS_YOLO else "desconocida"


def guardar_metadata_arquitectura_onnx(path: str | Path, arquitectura: str, source_sha256: str) -> None:
    """Conserva el grafo y las propiedades existentes al agregar la procedencia ANPR."""
    import onnx

    model = onnx.load(str(path), load_external_data=False)
    metadata = {entry.key: entry.value for entry in model.metadata_props}
    metadata.update(anpr_architecture=arquitectura, anpr_source_pt_sha256=source_sha256)
    onnx.helper.set_model_props(model, metadata)
    onnx.save(model, str(path))
