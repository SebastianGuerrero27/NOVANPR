"""
Motores de Reconocimiento Óptico de Caracteres (OCR) para matrículas vehiculares.
Soporta PaddleOCR / RapidOCR (PP-OCRv4), YOLO Chars, EasyOCR y Mocks de prueba.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from typing import Optional, Tuple
import cv2
import numpy as np

from app.core.models import Detection
from app.utils.logger import get_logger

logger = get_logger("ocr_backends")


def preprocess_plate_for_ocr(
    image: np.ndarray,
    min_width: int = 480,
    enhance: bool = True,
) -> np.ndarray:
    """Preprocesamiento óptico adaptativo para mejorar la legibilidad de caracteres."""
    if image is None or image.size == 0:
        return image

    img = image.copy()
    h, w = img.shape[:2]

    # Escalar si es muy pequeño para permitir que el OCR distinga trazos finos
    if w < min_width and w > 0:
        scale = float(min_width) / float(w)
        target_h = max(32, int(h * scale))
        img = cv2.resize(img, (min_width, target_h), interpolation=cv2.INTER_CUBIC)

    if not enhance:
        return img

    # CLAHE en luminancia (LAB)
    if len(img.shape) == 3 and img.shape[2] == 3:
        try:
            lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
            l, a, b = cv2.split(lab)
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            cl = clahe.apply(l)
            img = cv2.cvtColor(cv2.merge((cl, a, b)), cv2.COLOR_LAB2BGR)
        except Exception:
            pass

    # Unsharp Masking sutil
    if len(img.shape) == 3:
        try:
            gaussian = cv2.GaussianBlur(img, (0, 0), sigmaX=1.5, sigmaY=1.5)
            img = cv2.addWeighted(img, 1.4, gaussian, -0.4, 0)
        except Exception:
            pass

    return img


class BaseOCREngine(ABC):
    """Interfaz abstracta para motores de reconocimiento óptico de caracteres."""

    @abstractmethod
    def read_plate(self, plate_crop: np.ndarray) -> tuple[str, float]:
        """Procesa una imagen de matrícula y retorna (texto_placa, confianza_0_a_1)."""
        pass


class PaddleOCREngine(BaseOCREngine):
    """Motor OCR basado en RapidOCR / PaddleOCR optimizado para CPU y GPU."""

    def __init__(
        self,
        lang: str = "en",
        use_gpu: bool = False,
        rec_only: bool = True,
        use_angle_cls: bool = True,
        min_crop_width: int = 480,
        enhance: bool = True,
    ) -> None:
        self.lang = lang
        self.use_gpu = use_gpu
        self.rec_only = rec_only
        self.use_angle_cls = use_angle_cls
        self.min_crop_width = min_crop_width
        self.enhance = enhance
        self._engine = None

        logger.info("Inicializando PaddleOCREngine (lang=%s, rec_only=%s, use_gpu=%s)", lang, rec_only, use_gpu)
        self._init_engine()

    def _init_engine(self) -> None:
        # 1. Intentar RapidOCR (ultrarrápido ONNX)
        try:
            from rapidocr_onnxruntime import RapidOCR
            self._engine = RapidOCR()
            self._backend_type = "rapidocr"
            logger.info("RapidOCR (ONNX) cargado exitosamente.")
            return
        except ImportError:
            pass

        # 2. Intentar PaddleOCR oficial
        try:
            from paddleocr import PaddleOCR
            self._engine = PaddleOCR(
                use_angle_cls=self.use_angle_cls,
                lang=self.lang,
                use_gpu=self.use_gpu,
                show_log=False,
            )
            self._backend_type = "paddleocr"
            logger.info("PaddleOCR oficial cargado exitosamente.")
            return
        except ImportError:
            pass

        # 3. Fallback a EasyOCR si está disponible
        try:
            import easyocr
            self._engine = easyocr.Reader([self.lang], gpu=self.use_gpu)
            self._backend_type = "easyocr"
            logger.info("EasyOCR fallback cargado.")
            return
        except ImportError:
            pass

        logger.warning("No se encontraron paquetes OCR (rapidocr, paddleocr, easyocr). Funcionará en modo pasivo.")
        self._backend_type = "none"

    def read_plate(self, plate_crop: np.ndarray) -> tuple[str, float]:
        if plate_crop is None or plate_crop.size == 0 or self._engine is None:
            return "", 0.0

        prep = preprocess_plate_for_ocr(plate_crop, self.min_crop_width, self.enhance)

        try:
            if self._backend_type == "rapidocr":
                result, _ = self._engine(prep)
                if not result:
                    return "", 0.0
                # result = [[box, text, conf], ...]
                texts = [r[1] for r in result if r[1]]
                confs = [float(r[2]) for r in result if len(r) > 2 and r[2] is not None]
                raw_text = "".join(texts)
                avg_conf = float(np.mean(confs)) if confs else 0.0
                clean_text = re.sub(r"[^A-Z0-9]", "", raw_text.upper())
                return clean_text, avg_conf

            elif self._backend_type == "paddleocr":
                result = self._engine.ocr(prep, cls=self.use_angle_cls)
                if not result or not result[0]:
                    return "", 0.0
                texts = [line[1][0] for line in result[0] if line[1]]
                confs = [float(line[1][1]) for line in result[0] if line[1]]
                raw_text = "".join(texts)
                avg_conf = float(np.mean(confs)) if confs else 0.0
                clean_text = re.sub(r"[^A-Z0-9]", "", raw_text.upper())
                return clean_text, avg_conf

            elif self._backend_type == "easyocr":
                result = self._engine.readtext(prep)
                if not result:
                    return "", 0.0
                texts = [r[1] for r in result if r[1]]
                confs = [float(r[2]) for r in result if len(r) > 2]
                raw_text = "".join(texts)
                avg_conf = float(np.mean(confs)) if confs else 0.0
                clean_text = re.sub(r"[^A-Z0-9]", "", raw_text.upper())
                return clean_text, avg_conf

        except Exception as e:
            logger.debug("Error procesando OCR en imagen: %s", e)
            return "", 0.0

        return "", 0.0


class YoloCharsOCREngine(BaseOCREngine):
    """
    Motor OCR basado en detección de caracteres individuales con YOLO.
    Ordena las cajas de caracteres de izquierda a derecha (y top-down para motos).
    """

    def __init__(self, detector: Any) -> None:
        self.detector = detector

    def read_plate(self, plate_crop: np.ndarray) -> tuple[str, float]:
        if plate_crop is None or plate_crop.size == 0 or self.detector is None:
            return "", 0.0

        try:
            detections: list[Detection] = self.detector.predict(plate_crop)
            if not detections:
                return "", 0.0

            # Ordenar por posición X (de izquierda a derecha)
            detections.sort(key=lambda d: d.bbox[0])

            chars = [d.class_name.upper() for d in detections if d.class_name]
            confs = [d.confidence for d in detections]

            text = "".join(chars)
            clean_text = re.sub(r"[^A-Z0-9]", "", text)
            avg_conf = float(np.mean(confs)) if confs else 0.0
            return clean_text, avg_conf
        except Exception as e:
            logger.debug("Error en YoloCharsOCREngine: %s", e)
            return "", 0.0


class MockOCREngine(BaseOCREngine):
    """Motor OCR mock para pruebas y validaciones."""

    def __init__(self, return_text: str = "PBX1234", return_confidence: float = 0.95) -> None:
        self.return_text = return_text
        self.return_confidence = return_confidence

    def read_plate(self, plate_crop: np.ndarray) -> tuple[str, float]:
        return self.return_text, self.return_confidence
