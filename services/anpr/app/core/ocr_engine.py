"""
Capa de Abstracción de Motor OCR de Alta Precisión para ANPR Industrial.

Implementaciones:
  - PaddleOcrEngine: RapidOCR PP-OCRv4 ONNX (Ultrarrápido, ~15-20ms en CPU).
  - EasyOcrEngine: EasyOCR con allowlist alfanumérico estricto.
  - HybridOcrEngine: Ensamble Industrial con Fallback Automático (RapidOCR + EasyOCR precalentado).
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from typing import NamedTuple, List, Optional

import cv2
import numpy as np

from app.config import OCR_ENGINE, TESSERACT_CMD
from app.utils.logger import get_logger

logger = get_logger("ocr_engine")


class OcrResult(NamedTuple):
    """Resultado de una lectura OCR con caja delimitadora y confianza."""
    text: str
    confidence: float
    bbox: list


# =============================================================================
# Interfaz Abstracta
# =============================================================================


class OcrEngine(ABC):
    """Interfaz abstracta para motores OCR."""

    @abstractmethod
    def read_text(self, image: np.ndarray) -> list[OcrResult]:
        """Ejecuta OCR sobre un recorte de placa preprocesado."""
        ...

    @property
    @abstractmethod
    def engine_name(self) -> str:
        """Nombre del motor OCR activo."""
        ...


# =============================================================================
# Implementación: PaddleOCR (RapidOCR PP-OCRv4 ONNX)
# =============================================================================


class PaddleOcrEngine(OcrEngine):
    """
    Motor OCR basado en RapidOCR (PP-OCRv4 ONNX Runtime).
    Ultra-rápido, con detección de orientación y ordenamiento espacial de caracteres.
    """

    def __init__(self) -> None:
        try:
            from rapidocr_onnxruntime import RapidOCR
            self._engine = RapidOCR(intra_op_num_threads=2)
            logger.info("PaddleOCR (RapidOCR ONNX Engine) inicializado con 2 hilos CPU.")
        except Exception as e:
            logger.error("Error al inicializar PaddleOCR: %s", e)
            raise

    def read_text(self, image: np.ndarray) -> list[OcrResult]:
        if image is None or image.size == 0:
            return []

        try:
            raw_results, _ = self._engine(image)
        except Exception as e:
            logger.error("Error en PaddleOCR: %s", e)
            return []

        if not raw_results:
            return []

        # Ordenar resultados espacialmente: de arriba hacia abajo y de izquierda a derecha
        def get_top_left_y(item):
            bbox = item[0]
            if bbox and len(bbox) >= 1:
                return bbox[0][1]
            return 0

        def get_top_left_x(item):
            bbox = item[0]
            if bbox and len(bbox) >= 1:
                return bbox[0][0]
            return 0

        try:
            sorted_raw = sorted(raw_results, key=lambda it: (get_top_left_y(it) // 30, get_top_left_x(it)))
        except Exception:
            sorted_raw = raw_results

        results: list[OcrResult] = []
        for item in sorted_raw:
            bbox, text, score = item
            clean = re.sub(r"[^A-Z0-9-]", "", str(text).strip().upper().replace(" ", ""))
            if len(clean) >= 2:
                results.append(OcrResult(
                    text=clean,
                    confidence=float(score),
                    bbox=bbox if bbox else []
                ))

        return results

    @property
    def engine_name(self) -> str:
        return "paddleocr"


# =============================================================================
# Implementación: EasyOCR
# =============================================================================


class EasyOcrEngine(OcrEngine):
    """Motor OCR basado en EasyOCR con allowlist alfanumérico."""

    def __init__(self, gpu: bool = False) -> None:
        import easyocr
        logger.info("Inicializando EasyOCR (GPU: %s)...", gpu)
        self._reader = easyocr.Reader(["en", "es"], gpu=gpu, verbose=False)
        self._allowlist = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"

    def read_text(self, image: np.ndarray) -> list[OcrResult]:
        if image is None or image.size == 0:
            return []

        try:
            raw_results = self._reader.readtext(image, allowlist=self._allowlist)
        except Exception as e:
            logger.error("Error en EasyOCR: %s", e)
            return []

        if not raw_results:
            return []

        def get_y(r):
            bbox = r[0]
            return bbox[0][1] if bbox else 0

        def get_x(r):
            bbox = r[0]
            return bbox[0][0] if bbox else 0

        sorted_results = sorted(raw_results, key=lambda r: (get_y(r) // 30, get_x(r)))

        results = [
            OcrResult(
                text=re.sub(r"[^A-Z0-9-]", "", str(r[1]).strip().upper().replace(" ", "")),
                confidence=float(r[2]),
                bbox=r[0] if r[0] else [],
            )
            for r in sorted_results
            if r[1] and len(str(r[1]).strip()) >= 2
        ]

        return results

    @property
    def engine_name(self) -> str:
        return "easyocr"


# =============================================================================
# Implementación: Ensamble Híbrido (RapidOCR Primario + EasyOCR Secundario)
# =============================================================================


class HybridOcrEngine(OcrEngine):
    """
    Motor Híbrido de Grado Industrial con Precalentamiento.
    Ejecuta RapidOCR como primario (~18ms). Si la lectura no contiene una placa completa
    o si las letras iniciales presentan desgaste físico, recurre a EasyOCR de respaldo.
    """

    def __init__(self) -> None:
        self._paddle = PaddleOcrEngine()
        self._easy: Optional[EasyOcrEngine] = None
        # Precalentar EasyOCR en segundo plano
        try:
            self._easy = EasyOcrEngine(gpu=False)
        except Exception as e:
            logger.warning("No se pudo precalentar EasyOCR: %s", e)
        logger.info("HybridOcrEngine (Ensamble PaddleOCR + EasyOCR Fallback) activado.")

    def _get_easy_engine(self) -> EasyOcrEngine:
        if self._easy is None:
            self._easy = EasyOcrEngine(gpu=False)
        return self._easy

    def read_text(self, image: np.ndarray) -> list[OcrResult]:
        if image is None or image.size == 0:
            return []

        # Asegurar margen/padding para que caracteres en los extremos no toquen el borde
        padded = cv2.copyMakeBorder(image, 15, 15, 25, 25, cv2.BORDER_REPLICATE)

        # 1. Intentar con PaddleOCR (RapidOCR)
        results = self._paddle.read_text(padded)

        # Si tenemos lectura completa con al menos 5 caracteres válidos y buena confianza
        has_complete_plate = any(
            len(re.sub(r"[^A-Z0-9]", "", r.text)) >= 5 and any(c.isdigit() for c in r.text) and any(c.isalpha() for c in r.text)
            for r in results
        )

        if results and has_complete_plate:
            max_conf = max(r.confidence for r in results)
            if max_conf >= 0.78:
                return results

        # 2. Si no hubo resultados o la matrícula quedó incompleta, consultar EasyOCR
        try:
            easy_results = self._get_easy_engine().read_text(padded)
            if easy_results:
                combined = list(results) + list(easy_results)
                combined.sort(key=lambda r: (len(re.sub(r"[^A-Z0-9]", "", r.text)) >= 5, r.confidence), reverse=True)
                return combined
        except Exception as e:
            logger.warning("Fallo en fallback de EasyOCR: %s", e)

        return results

    @property
    def engine_name(self) -> str:
        return "hybrid"


# =============================================================================
# Factory
# =============================================================================


def create_ocr_engine() -> OcrEngine:
    """Factory que crea el motor OCR según OCR_ENGINE en .env."""
    engine_type = OCR_ENGINE.lower().strip()

    if engine_type == "easyocr":
        return EasyOcrEngine(gpu=False)

    # Por defecto RapidOCR (PP-OCRv4 ONNX) para rendimiento ultra-rápido en tiempo real
    return PaddleOcrEngine()
