"""
Capa de detectores de visión artificial con interfaces abstractas para ANPR.
Soporta modelos YOLO (Ultralytics), ONNX Runtime y Mocks para pruebas unitarias.
"""

from __future__ import annotations

import os
import threading
from abc import ABC, abstractmethod
from typing import Any, List, Optional, Union
import numpy as np

from app.core.models import Detection
from app.utils.logger import get_logger

logger = get_logger("detectors")


class BaseDetector(ABC):
    """Interfaz base para cualquier detector de objetos (vehículos, matrículas, etc.)."""

    @abstractmethod
    def predict(self, frame: np.ndarray) -> list[Detection]:
        """Ejecuta inferencia sobre una imagen y retorna la lista de detecciones."""
        pass

    def warmup(self, dummy_frame: Optional[np.ndarray] = None) -> None:
        """Precalienta el modelo si aplica."""
        pass


class YoloDetector(BaseDetector):
    """Detector de objetos basado en Ultralytics YOLO (v8, v11, etc.)."""

    def __init__(
        self,
        model_path: str,
        confidence: float = 0.35,
        device: str = "cpu",
        imgsz: int = 640,
        iou: float = 0.45,
        max_det: int = 50,
        classes: Optional[list[Union[int, str]]] = None,
        half: bool = False,
    ) -> None:
        self.model_path = model_path
        self.confidence = confidence
        self.device = device
        self.imgsz = imgsz
        self.iou = iou
        self.max_det = max_det
        self.classes = classes
        self.half = half
        self._lock = threading.Lock()

        logger.info("Cargando modelo YOLO desde: %s (device=%s, conf=%.2f)", model_path, device, confidence)
        try:
            from ultralytics import YOLO
            self.model = YOLO(model_path)
            # Mapear nombres de clases a IDs si se pasaron strings
            self.class_filter_ids = self._resolve_class_ids()
        except Exception as e:
            logger.error("Error al cargar modelo YOLO %s: %s", model_path, e)
            raise RuntimeError(f"No se pudo inicializar el detector YOLO '{model_path}': {e}") from e

    def _resolve_class_ids(self) -> Optional[list[int]]:
        if not self.classes:
            return None
        names = getattr(self.model, "names", {})
        if not names:
            return None
        # Invertir nombres a indices
        name_to_id = {str(v).lower(): k for k, v in names.items()}
        resolved: list[int] = []
        for c in self.classes:
            if isinstance(c, int):
                resolved.append(c)
            elif isinstance(c, str):
                c_low = c.strip().lower()
                if c_low in name_to_id:
                    resolved.append(name_to_id[c_low])
        return resolved if resolved else None

    def predict(self, frame: np.ndarray) -> list[Detection]:
        if frame is None or frame.size == 0:
            return []

        try:
            with self._lock:
                results = self.model.predict(
                    source=frame,
                    conf=self.confidence,
                    iou=self.iou,
                    imgsz=self.imgsz,
                    device=self.device,
                    max_det=self.max_det,
                    classes=self.class_filter_ids,
                    half=self.half,
                    verbose=False,
                )

            detections: list[Detection] = []
            if not results or len(results) == 0:
                return detections

            res = results[0]
            if res.boxes is None or len(res.boxes) == 0:
                return detections

            boxes_xyxy = res.boxes.xyxy.cpu().numpy()
            confs = res.boxes.conf.cpu().numpy()
            class_ids = res.boxes.cls.cpu().numpy().astype(int)
            names = res.names or {}

            for bbox, conf, cls_id in zip(boxes_xyxy, confs, class_ids):
                cls_name = str(names.get(cls_id, f"cls_{cls_id}"))
                detections.append(
                    Detection(
                        bbox=[float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])],
                        confidence=float(conf),
                        class_id=int(cls_id),
                        class_name=cls_name,
                    )
                )

            return detections
        except Exception as e:
            logger.error("Error durante la inferencia YOLO: %s", e)
            return []

    def warmup(self, dummy_frame: Optional[np.ndarray] = None) -> None:
        """Precalienta el modelo con un frame dummy para evitar latencia en la primera predicción."""
        try:
            if dummy_frame is None:
                dummy_frame = np.zeros((self.imgsz, self.imgsz, 3), dtype=np.uint8)
            self.predict(dummy_frame)
            logger.info("Warmup completado para YoloDetector (imgsz=%d)", self.imgsz)
        except Exception as e:
            logger.warning("Fallo al precalentar YoloDetector: %s", e)



class RfDetrDetector(BaseDetector):
    """
    Detector RF-DETR (Robinson et al., ICLR 2026): transformer en tiempo real con backbone
    DINOv2. Se usa como alternativa experimental a YOLO26 (DETECTOR_BACKEND=rfdetr).
    Requiere `pip install rfdetr` y pesos afinados (scripts/train_detector.py --arch rfdetr-nano).
    """

    _VARIANTS = {"nano": "RFDETRNano", "small": "RFDETRSmall", "medium": "RFDETRMedium", "base": "RFDETRBase"}

    def __init__(self, weights_path: str, confidence: float = 0.35, variant: str = "nano") -> None:
        try:
            import rfdetr
        except ImportError as e:
            raise RuntimeError("DETECTOR_BACKEND=rfdetr requiere el paquete 'rfdetr' (pip install rfdetr).") from e
        cls = getattr(rfdetr, self._VARIANTS.get(variant, "RFDETRNano"))
        self.model = cls(pretrain_weights=weights_path)
        try:
            self.model.optimize_for_inference()
        except Exception as e:  # la optimización es opcional
            logger.debug("RF-DETR sin optimize_for_inference: %s", e)
        self.confidence = confidence
        self._lock = threading.Lock()
        logger.info("RF-DETR %s cargado desde %s (conf=%.2f)", variant, weights_path, confidence)

    def predict(self, frame: np.ndarray) -> list[Detection]:
        if frame is None or frame.size == 0:
            return []
        try:
            rgb = frame[:, :, ::-1].copy()  # RF-DETR espera RGB
            with self._lock:
                dets = self.model.predict(rgb, threshold=self.confidence)
            return [
                Detection(bbox=[float(v) for v in box], confidence=float(conf), class_id=0, class_name="license_plate")
                for box, conf in zip(dets.xyxy, dets.confidence)
            ]
        except Exception as e:
            logger.error("Error durante la inferencia RF-DETR: %s", e)
            return []

    def warmup(self, dummy_frame: Optional[np.ndarray] = None) -> None:
        self.predict(dummy_frame if dummy_frame is not None else np.zeros((384, 384, 3), dtype=np.uint8))


class MockDetector(BaseDetector):
    """Detector mock para pruebas unitarias sin requerir pesos pesados ni GPUs."""

    def __init__(self, predefined_detections: Optional[list[Detection]] = None) -> None:
        self.predefined_detections = predefined_detections or []

    def set_detections(self, detections: list[Detection]) -> None:
        self.predefined_detections = detections

    def predict(self, frame: np.ndarray) -> list[Detection]:
        return list(self.predefined_detections)


def create_detector(
    model_path: str,
    *,
    model_type: str = "yolo",
    confidence: float = 0.35,
    device: str = "cpu",
    imgsz: int = 640,
    iou: float = 0.45,
    max_det: int = 50,
    classes: Optional[list[Union[int, str]]] = None,
    half: bool = False,
    mock_detections: Optional[list[Detection]] = None,
) -> BaseDetector:
    """Factory unificada para instanciar detectores."""
    model_type_norm = model_type.lower()

    if model_type_norm in {"mock", "test"}:
        return MockDetector(mock_detections)

    if model_type_norm.startswith("rfdetr"):
        variant = model_type_norm.split("-", 1)[1] if "-" in model_type_norm else "nano"
        return RfDetrDetector(model_path, confidence=confidence, variant=variant)

    if model_type_norm in {"yolo", "yolov8", "yolo11", "yolo26", "ultralytics"}:
        return YoloDetector(
            model_path=model_path,
            confidence=confidence,
            device=device,
            imgsz=imgsz,
            iou=iou,
            max_det=max_det,
            classes=classes,
            half=half,
        )

    raise ValueError(f"Tipo de detector '{model_type}' no soportado. Opciones válidas: 'yolo', 'mock'.")
