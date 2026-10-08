"""
Capa de Abstracción de Motor OCR de Alta Precisión para ANPR Industrial.

Implementaciones Científicas:
  - FastPlateOcrEngine: Fast-Plate-OCR ONNX SOTA especializado en matrículas.
  - FastAlprEngine: Framework integral Fast-ALPR (detección + OCR).
  - PaddleOcrEngine: RapidOCR PP-OCRv4 ONNX (Ultrarrápido, ~15-20ms en CPU).
  - EasyOcrEngine: EasyOCR con allowlist alfanumérico estricto.
  - HybridOcrEngine: Ensamble Industrial SOTA (Fast-Plate-OCR + RapidOCR + EasyOCR Fallback).
"""

from __future__ import annotations

import os
import re
from abc import ABC, abstractmethod
from typing import NamedTuple, List, Optional

import cv2
import numpy as np

from app.infraestructura.config import (
    FASTALPR_DET_MODEL,
    FASTALPR_OCR_MODEL,
    OCR_CONFIDENCE_THRESHOLD,
    OCR_ENGINE,
    OCR_THREADS,
    OPENCV_CLAHE_ENABLED,
    OPENCV_UNSHARP_ENABLED,
    PLATE_OCR_CONFIG_PATH,
    PLATE_OCR_HUB_MODEL,
    PLATE_OCR_ONNX_PATH,
    PLATE_OCR_PREPROCESS,
    TESSERACT_CMD,
)
from app.infraestructura.logger import get_logger

logger = get_logger("ocr_engine")

_SERVICE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _resolve_service_path(path: str) -> str:
    """Rutas relativas se resuelven respecto a services/anpr (funciona en local y en Docker)."""
    return path if os.path.isabs(path) else os.path.join(_SERVICE_DIR, path)


class OcrResult(NamedTuple):
    """Resultado de una lectura OCR con caja delimitadora y confianza."""
    text: str
    confidence: float
    bbox: list


# =============================================================================
# Pipeline de Preprocesamiento Óptico Avanzado con OpenCV
# =============================================================================


def preprocess_plate_opencv(
    image: np.ndarray,
    enable_clahe: bool = True,
    enable_unsharp: bool = True,
    target_height: int = 70,
) -> np.ndarray:
    """
    Preprocesamiento Óptico Científico con OpenCV para recortes de matrículas:
      1. Normalización de escala geométrica manteniendo relación de aspecto.
      2. CLAHE (Contrast Limited Adaptive Histogram Equalization) en espacio LAB
         para compensar sombras, destellos de faros y variación lumínica.
      3. Filtro Bilateral conservador de bordes para atenuar ruido de compresión RTSP.
      4. Unsharp Masking para intensificar gradientes de caracteres alfanuméricos.
      5. Borde replicado de protección (padding) para evitar cortes perimetrales.
    """
    if image is None or image.size == 0:
        return image

    img = image.copy()
    h, w = img.shape[:2]

    # 1. Normalización de resolución
    if h > 0 and w > 0 and (h < 40 or h > 100):
        scale = target_height / float(h)
        target_w = max(32, int(w * scale))
        img = cv2.resize(img, (target_w, target_height), interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA)

    # 2. CLAHE en espacio LAB (canal de luminancia L)
    if enable_clahe and len(img.shape) == 3 and img.shape[2] == 3:
        try:
            lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
            l_channel, a_channel, b_channel = cv2.split(lab)
            clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8))
            cl = clahe.apply(l_channel)
            merged_lab = cv2.merge((cl, a_channel, b_channel))
            img = cv2.cvtColor(merged_lab, cv2.COLOR_LAB2BGR)
        except Exception as e:
            logger.debug("Error aplicando CLAHE en LAB: %s", e)

    # 3. Filtro Bilateral para eliminar ruido conservando la nitidez de los bordes
    try:
        img = cv2.bilateralFilter(img, d=5, sigmaColor=45, sigmaSpace=45)
    except Exception:
        pass

    # 4. Unsharp Masking (Realce de altas frecuencias espaciales)
    if enable_unsharp and len(img.shape) == 3:
        try:
            blurred = cv2.GaussianBlur(img, (0, 0), sigmaX=1.5, sigmaY=1.5)
            img = cv2.addWeighted(img, 1.45, blurred, -0.45, 0)
        except Exception as e:
            logger.debug("Error aplicando Unsharp Masking: %s", e)

    # 5. Margen de seguridad replicado
    h_out, w_out = img.shape[:2]
    pad_y = max(8, int(h_out * 0.10))
    pad_x = max(14, int(w_out * 0.08))
    padded = cv2.copyMakeBorder(img, pad_y, pad_y, pad_x, pad_x, cv2.BORDER_REPLICATE)

    return padded


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
# Implementación: Fast-Plate-OCR / FastALPR ONNX
# =============================================================================


class FastPlateOcrEngine(OcrEngine):
    """
    Motor OCR ultra-rápido especializado en matrículas vehiculares (Fast-Plate-OCR ONNX).
    Modelo optimizado para reconocimiento de caracteres en matrículas en ~3-10ms por inferencia.
    """

    def __init__(self, model_name: Optional[str] = None, preprocess: Optional[bool] = None) -> None:
        import onnxruntime as ort
        from fast_plate_ocr import LicensePlateRecognizer

        self._preprocess = PLATE_OCR_PREPROCESS if preprocess is None else preprocess
        # Hilos acotados: el modelo es pequeño y se ejecuta junto al detector y al verificador
        sesion = ort.SessionOptions()
        sesion.intra_op_num_threads = max(1, OCR_THREADS)
        sesion.inter_op_num_threads = 1
        onnx_path = _resolve_service_path(PLATE_OCR_ONNX_PATH)
        config_path = _resolve_service_path(PLATE_OCR_CONFIG_PATH)

        if model_name is None and os.path.exists(onnx_path) and os.path.exists(config_path):
            # Modelo afinado con placas ecuatorianas (scripts/train_ocr.py)
            self._recognizer = LicensePlateRecognizer(
                onnx_model_path=onnx_path, plate_config_path=config_path, device="cpu", sess_options=sesion
            )
            self.model_id = os.path.basename(onnx_path)
            logger.info("FastPlateOcrEngine con modelo afinado Ecuador: %s", onnx_path)
            return

        model = model_name or PLATE_OCR_HUB_MODEL
        try:
            self._recognizer = LicensePlateRecognizer(hub_ocr_model=model, device="cpu", sess_options=sesion)
            self.model_id = model
        except Exception as e:
            logger.warning("Fallo al cargar '%s' (%s). Usando 'cct-s-v2-global-model'.", model, e)
            self._recognizer = LicensePlateRecognizer(hub_ocr_model="cct-s-v2-global-model", device="cpu", sess_options=sesion)
            self.model_id = "cct-s-v2-global-model"
        logger.info("FastPlateOcrEngine con modelo del hub '%s' (preprocesado=%s).", self.model_id, self._preprocess)

    def read_text(self, image: np.ndarray) -> list[OcrResult]:
        if image is None or image.size == 0:
            return []

        prep = (
            preprocess_plate_opencv(image, enable_clahe=OPENCV_CLAHE_ENABLED, enable_unsharp=OPENCV_UNSHARP_ENABLED)
            if self._preprocess
            else image
        )

        # Adaptar modo de color según la arquitectura del modelo ONNX (Grayscale vs RGB)
        try:
            expected_mode = getattr(self._recognizer.config, "image_color_mode", "rgb")
            if expected_mode == "grayscale":
                if len(prep.shape) == 3:
                    ocr_input = cv2.cvtColor(prep, cv2.COLOR_BGR2GRAY)
                else:
                    ocr_input = prep
            else:
                if len(prep.shape) == 3:
                    ocr_input = cv2.cvtColor(prep, cv2.COLOR_BGR2RGB)
                else:
                    ocr_input = cv2.cvtColor(prep, cv2.COLOR_GRAY2RGB)

            preds = self._recognizer.run(ocr_input, return_confidence=True)
            if not preds:
                return []

            results: list[OcrResult] = []
            for pred in preds:
                plate_str = str(pred.plate).strip().upper()
                clean = re.sub(r"[^A-Z0-9-]", "", plate_str.replace(" ", ""))
                if not clean:
                    continue

                # Calcular confianza media a partir del vector de probabilidades de caracteres
                if hasattr(pred, "char_probs") and pred.char_probs is not None and len(pred.char_probs) > 0:
                    conf = float(np.mean(pred.char_probs))
                else:
                    conf = 0.85

                results.append(OcrResult(text=clean, confidence=round(conf, 4), bbox=[]))

            return results
        except Exception as e:
            logger.error("Error en FastPlateOcrEngine.read_text: %s", e)
            return []

    @property
    def engine_name(self) -> str:
        return "fastalpr"


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
            self._engine = RapidOCR(use_angle_cls=False, intra_op_num_threads=4)
            logger.info("PaddleOCR (RapidOCR ONNX Engine) inicializado con 4 hilos CPU y angle_cls desactivado.")
        except Exception as e:
            logger.error("Error al inicializar PaddleOCR: %s", e)
            raise

    def read_text(self, image: np.ndarray) -> list[OcrResult]:
        if image is None or image.size == 0:
            return []

        prep = preprocess_plate_opencv(
            image,
            enable_clahe=OPENCV_CLAHE_ENABLED,
            enable_unsharp=OPENCV_UNSHARP_ENABLED,
        )

        try:
            raw_results, _ = self._engine(prep)
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

        prep = preprocess_plate_opencv(
            image,
            enable_clahe=OPENCV_CLAHE_ENABLED,
            enable_unsharp=OPENCV_UNSHARP_ENABLED,
        )

        try:
            raw_results = self._reader.readtext(prep, allowlist=self._allowlist)
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
# Implementación: Ensamble Híbrido SOTA (Fast-Plate-OCR + RapidOCR + EasyOCR Fallback)
# =============================================================================


class HybridOcrEngine(OcrEngine):
    """
    Motor Híbrido SOTA de Grado Industrial con Ensamble Multi-Etapa y Preprocesamiento OpenCV.
    1. Primario: Fast-Plate-OCR ONNX (~5-10ms, especializado en sintaxis de placas vehiculares).
    2. Secundario: RapidOCR PP-OCRv4 (~15-20ms, robusto ante rotaciones y caracteres aislados).
    3. Fallback: EasyOCR (para placas con desgaste físico extremo o iluminación atípica).
    """

    def __init__(self) -> None:
        self._fast_alpr: Optional[FastPlateOcrEngine] = None
        self._paddle: Optional[PaddleOcrEngine] = None
        self._easy: Optional[EasyOcrEngine] = None

        try:
            self._fast_alpr = FastPlateOcrEngine()
        except Exception as e:
            logger.warning("No se pudo iniciar FastPlateOcrEngine en ensamble híbrido: %s", e)

        try:
            self._paddle = PaddleOcrEngine()
        except Exception as e:
            logger.warning("No se pudo iniciar PaddleOcrEngine en ensamble híbrido: %s", e)

        # Precalentar EasyOCR en segundo plano si es necesario
        try:
            self._easy = EasyOcrEngine(gpu=False)
        except Exception as e:
            logger.warning("No se pudo precalentar EasyOCR: %s", e)

        logger.info("HybridOcrEngine SOTA (Fast-Plate-OCR + RapidOCR + EasyOCR Fallback) activado.")

    def _get_easy_engine(self) -> EasyOcrEngine:
        if self._easy is None:
            self._easy = EasyOcrEngine(gpu=False)
        return self._easy

    def read_text(self, image: np.ndarray) -> list[OcrResult]:
        if image is None or image.size == 0:
            return []

        all_results: list[OcrResult] = []

        # 1. Intentar con Fast-Plate-OCR (SOTA para placas de matrícula)
        if self._fast_alpr is not None:
            try:
                fast_results = self._fast_alpr.read_text(image)
                if fast_results:
                    for res in fast_results:
                        clean_str = re.sub(r"[^A-Z0-9]", "", res.text)
                        # Si encontramos placa completa (5-7 caracteres con letras y números) con alta confianza
                        if len(clean_str) >= 5 and any(c.isdigit() for c in clean_str) and any(c.isalpha() for c in clean_str):
                            if res.confidence >= 0.70:
                                return fast_results
                    all_results.extend(fast_results)
            except Exception as e:
                logger.debug("Error en FastPlateOcrEngine dentro de Hybrid: %s", e)

        # 2. Intentar con RapidOCR PP-OCRv4
        if self._paddle is not None:
            try:
                paddle_results = self._paddle.read_text(image)
                if paddle_results:
                    for res in paddle_results:
                        clean_str = re.sub(r"[^A-Z0-9]", "", res.text)
                        if len(clean_str) >= 5 and any(c.isdigit() for c in clean_str) and any(c.isalpha() for c in clean_str):
                            if res.confidence >= 0.75:
                                all_results.extend(paddle_results)
                                all_results.sort(key=lambda r: (len(re.sub(r"[^A-Z0-9]", "", r.text)) >= 5, r.confidence), reverse=True)
                                return all_results
                    all_results.extend(paddle_results)
            except Exception as e:
                logger.debug("Error en PaddleOcrEngine dentro de Hybrid: %s", e)

        # 3. Si no se obtuvo una matrícula completa con alta confianza, consultar EasyOCR
        has_good_plate = any(
            len(re.sub(r"[^A-Z0-9]", "", r.text)) >= 5 and r.confidence >= 0.65
            for r in all_results
        )

        if not has_good_plate:
            try:
                easy_results = self._get_easy_engine().read_text(image)
                if easy_results:
                    all_results.extend(easy_results)
            except Exception as e:
                logger.warning("Fallo en fallback de EasyOCR: %s", e)

        all_results.sort(key=lambda r: (len(re.sub(r"[^A-Z0-9]", "", r.text)) >= 5, r.confidence), reverse=True)
        return all_results

    @property
    def engine_name(self) -> str:
        return "hybrid"


# =============================================================================
# Factory
# =============================================================================


def create_ocr_engine() -> OcrEngine:
    """Factory que crea el motor OCR según OCR_ENGINE en .env."""
    engine_type = OCR_ENGINE.lower().strip()

    # OCR especializado de placas sin respaldos (recomendado según scripts/benchmark_ocr.py:
    # los respaldos RapidOCR/EasyOCR y el preprocesado bajaban la exactitud).
    if engine_type in ("plate", "fast-plate-ocr", "cct"):
        return FastPlateOcrEngine()

    if engine_type in ("fastalpr", "fastplateocr", "fast-alpr"):
        try:
            return FastPlateOcrEngine()
        except Exception as e:
            logger.warning("Fallo al crear FastPlateOcrEngine (%s). Usando HybridOcrEngine.", e)
            return HybridOcrEngine()

    if engine_type == "easyocr":
        return EasyOcrEngine(gpu=False)

    if engine_type in ("hybrid", "ensamble", "ensemble"):
        return HybridOcrEngine()

    if engine_type in ("paddleocr", "rapidocr"):
        return PaddleOcrEngine()

    # Por defecto motor Híbrido SOTA para máxima precisión y velocidad
    return HybridOcrEngine()

