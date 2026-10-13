"""
Segunda lectura OCR con PP-OCRv6 (RapidOCR + OpenVINO) sobre la mejor foto del vehículo.

PP-OCRv6 es más preciso que el OCR especializado en el benchmark local (98.7 % vs 89.6 %),
pero es demasiado lento para cada frame. Por eso solo se usa en la fase asíncrona de
verificación (main._verify_and_commit), una vez por vehículo, y su lectura se suma como
un voto con más peso al consenso temporal del track.

Si la lectura supera OCR_VERIFIER_MAX_MS, se descarta para no romper el requisito de
respuesta < 2 s del sistema.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass
from typing import Optional

import numpy as np

from app.infraestructura.config import (
    OCR_VERIFIER_ENABLED,
    OCR_VERIFIER_ENGINE,
    OCR_VERIFIER_MAX_MS,
    OCR_VERIFIER_MODEL,
    OCR_VERIFIER_THREADS,
)
from app.dominio.interpretacion_placa import MOTO, PARTICULAR, interpretar
from app.infraestructura.logger import get_logger

logger = get_logger("ocr_verifier")

_PLATE_RE = re.compile(r"[A-Z]{3}\d{3,4}|[A-Z]{2}\d{3,4}[A-Z]?")
# Cabecera "ECUADOR", tolerando lecturas imperfectas (ECUADGR, CUADOR, ECUAD0R...)
_HEADER_RE = re.compile(r"E?CUAD[A-Z0-9]?R?|ECUA[A-Z0-9]{2,3}")
_TO_LETTER = {"0": "O", "1": "I", "2": "Z", "4": "A", "5": "S", "6": "G", "8": "B"}
_TO_DIGIT = {"O": "0", "D": "0", "Q": "0", "I": "1", "L": "1", "Z": "2", "A": "4", "S": "5", "G": "6", "B": "8"}


def _norm(t: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (t or "").upper())


def _interpretar(t: str) -> str:
    """Placa (sin guion) del formato de auto o de moto que explica el texto con menos sustituciones."""
    return interpretar(t, formatos=(PARTICULAR, MOTO), digito_a_letra=_TO_LETTER, letra_a_digito=_TO_DIGIT).placa.replace("-", "")


@dataclass
class VerifierResult:
    plate: str
    confidence: float
    elapsed_ms: float
    within_budget: bool
    #: Texto leído del que sale la placa, antes de interpretar confusiones (evidencia)
    raw: str = ""


class PlateOcrVerifier:
    """Envoltorio de RapidOCR PP-OCRv6 con presupuesto de tiempo."""

    def __init__(self, model_type: str = OCR_VERIFIER_MODEL, engine: str = OCR_VERIFIER_ENGINE,
                 max_ms: float = OCR_VERIFIER_MAX_MS) -> None:
        from rapidocr import EngineType, ModelType, OCRVersion, RapidOCR

        eng = EngineType.OPENVINO if engine == "openvino" else EngineType.ONNXRUNTIME
        mt = {"tiny": ModelType.TINY, "small": ModelType.SMALL}.get(model_type, ModelType.MEDIUM)
        self._ocr = RapidOCR(params={
            "Global.log_level": "error",
            "Global.use_cls": False,
            "Det.engine_type": eng, "Det.model_type": mt, "Det.ocr_version": OCRVersion.PPOCRV6,
            "Rec.engine_type": eng, "Rec.model_type": mt, "Rec.ocr_version": OCRVersion.PPOCRV6,
            # Parámetros de detección por defecto de PaddleOCR 3 para PP-OCRv6. Los de RapidOCR
            # (lado mínimo 736 px) amplían ~10x los recortes de placa pequeños y la detección
            # de texto deja de encontrar líneas.
            "Det.limit_type": "min",
            "Det.limit_side_len": 64,
            "Det.box_thresh": 0.6,
            "Det.unclip_ratio": 1.5,
            # Hilos acotados y prioridad a la latencia de una sola lectura (no al rendimiento por lotes)
            "EngineConfig.openvino.inference_num_threads": max(1, OCR_VERIFIER_THREADS),
            "EngineConfig.openvino.performance_hint": "LATENCY",
            "EngineConfig.onnxruntime.intra_op_num_threads": max(1, OCR_VERIFIER_THREADS),
        })
        self._lock = threading.Lock()  # OpenVINO compila por sesión; serializar evita sobresuscribir la CPU
        self.max_ms = max_ms
        self.description = f"PP-OCRv6 {mt.value} ({engine})"
        self.read(np.full((64, 200, 3), 255, np.uint8))  # calentamiento (compilación OpenVINO)
        logger.info("Verificador OCR listo: %s, presupuesto %.0f ms", self.description, max_ms)

    def read(self, plate_crop: np.ndarray) -> VerifierResult:
        t0 = time.perf_counter()
        with self._lock:
            res = self._ocr(plate_crop)
        elapsed = (time.perf_counter() - t0) * 1000.0

        txts, scores = list(res.txts or []), list(res.scores or [])
        if res.boxes is not None and len(txts) > 1:
            txts, scores = merge_row_fragments(res.boxes, txts, scores)
        plate, conf, raw = leer_lineas_placa(txts, scores)
        return VerifierResult(plate, conf, elapsed, elapsed <= self.max_ms, raw)


def merge_row_fragments(boxes, txts: list[str], scores: list[float]) -> tuple[list[str], list[float]]:
    """
    Une fragmentos de texto de la misma fila (p. ej. "PS" + "Y-589"), ordenados de izquierda
    a derecha. Dos cajas están en la misma fila si su centro vertical cae dentro de la otra.
    """
    items = []
    for box, txt, score in zip(boxes, txts, scores):
        pts = np.array(box, dtype=np.float32)
        y1, y2 = float(pts[:, 1].min()), float(pts[:, 1].max())
        items.append({"x": float(pts[:, 0].min()), "y1": y1, "y2": y2, "cy": (y1 + y2) / 2, "txt": txt, "score": float(score)})
    items.sort(key=lambda it: it["cy"])
    rows: list[list[dict]] = []
    for it in items:
        row = rows[-1] if rows else None
        # La cabecera nunca se une con el texto de la placa (en placas inclinadas sus cajas se solapan)
        is_header = bool(_HEADER_RE.search(_norm(it["txt"])))
        row_is_header = bool(row) and any(_HEADER_RE.search(_norm(o["txt"])) for o in row)
        if row and not is_header and not row_is_header and any(o["y1"] <= it["cy"] <= o["y2"] or it["y1"] <= o["cy"] <= it["y2"] for o in row):
            row.append(it)
        else:
            rows.append([it])
    merged_txts, merged_scores = [], []
    for row in rows:
        row.sort(key=lambda it: it["x"])
        merged_txts.append("".join(it["txt"] for it in row))
        merged_scores.append(min(it["score"] for it in row))
    return merged_txts, merged_scores


def parse_plate_lines(txts: list[str], scores: list[float]) -> tuple[str, float]:
    """Descarta la cabecera "ECUADOR" y devuelve la línea con formato ANT de mayor confianza."""
    plate, conf, _ = leer_lineas_placa(txts, scores)
    return plate, conf


def leer_lineas_placa(txts: list[str], scores: list[float]) -> tuple[str, float, str]:
    """
    Como parse_plate_lines, y además el texto leído del que sale la placa. Una línea de la longitud
    de una placa se interpreta con el formato que necesita menos sustituciones; en una más larga
    se busca una placa leída tal cual (sin sustituciones).
    """
    for txt, score in sorted(zip(txts, scores), key=lambda x: -x[1]):
        clean = _HEADER_RE.sub("", _norm(txt))
        if len(clean) < 5:
            continue
        plate = _interpretar(clean)
        if plate:
            return plate, float(score), clean
        m = _PLATE_RE.search(clean)
        if m:
            return m.group(0), float(score), m.group(0)
    return "", 0.0, ""


_instance: Optional[PlateOcrVerifier] = None
_init_lock = threading.Lock()
_init_failed = False


def get_verifier() -> Optional[PlateOcrVerifier]:
    """Instancia única, creada bajo demanda. Retorna None si está deshabilitado o falla."""
    global _instance, _init_failed
    if not OCR_VERIFIER_ENABLED or _init_failed:
        return None
    if _instance is None:
        with _init_lock:
            if _instance is None and not _init_failed:
                try:
                    _instance = PlateOcrVerifier()
                except Exception as e:
                    _init_failed = True
                    logger.warning("Verificador PP-OCRv6 no disponible (%s). Se continúa sin segunda lectura.", e)
    return _instance
