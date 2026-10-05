"""
Rectificación aprendida de la placa: YOLO26n-pose predice sus 4 esquinas y una homografía
la deja frontal, con la proporción ANT (404 x 154 mm), antes del OCR.

Reemplaza a la rectificación heurística por contornos (plate_agent._rectify_quadrilateral),
que falla con reflejos, marcos oscuros o placas parcialmente tapadas. Si el modelo no existe
o sus esquinas no son confiables, se devuelve None y el agente usa la heurística.

Modelo: scripts/train_plate_rectifier.py -> PLATE_RECTIFIER_PATH.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np

from app.infraestructura.config import PLATE_RECTIFIER_MIN_KPT_CONF, PLATE_RECTIFIER_PATH
from app.infraestructura.logger import get_logger

logger = get_logger("plate_rectifier")

PLATE_ASPECT = 404.0 / 154.0  # ancho / alto de la placa ANT de auto
_SERVICE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@dataclass
class RectificationResult:
    image: np.ndarray
    corners: np.ndarray      # (4, 2) en píxeles del recorte: sup-izq, sup-der, inf-der, inf-izq
    confidence: float        # confianza mínima de las 4 esquinas


def order_corners(pts: np.ndarray) -> np.ndarray:
    """Ordena 4 puntos como sup-izq, sup-der, inf-der, inf-izq (robusto a la salida del modelo)."""
    pts = np.asarray(pts, dtype=np.float32)
    s, d = pts.sum(axis=1), np.diff(pts, axis=1).ravel()
    return np.float32([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]])


def is_valid_quad(corners: np.ndarray, crop_shape: tuple[int, int], min_area_frac: float = 0.15) -> bool:
    """Cuadrilátero convexo, sin esquinas repetidas y con área razonable respecto al recorte."""
    if len({(round(float(x)), round(float(y))) for x, y in corners}) < 4:
        return False
    if not cv2.isContourConvex(corners.reshape(-1, 1, 2).astype(np.float32)):
        return False
    area = cv2.contourArea(corners.astype(np.float32))
    h, w = crop_shape[:2]
    return area >= min_area_frac * w * h


def warp_to_plate(crop: np.ndarray, corners: np.ndarray, min_width: int = 120) -> np.ndarray:
    """Homografía a un rectángulo con la proporción de la placa ANT."""
    top = np.linalg.norm(corners[1] - corners[0])
    bottom = np.linalg.norm(corners[2] - corners[3])
    width = int(max(min_width, top, bottom))
    height = int(round(width / PLATE_ASPECT))
    dst = np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])
    M = cv2.getPerspectiveTransform(corners.astype(np.float32), dst)
    return cv2.warpPerspective(crop, M, (width, height), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


class PlateRectifier:
    def __init__(self, model_path: str, min_kpt_conf: float = PLATE_RECTIFIER_MIN_KPT_CONF, imgsz: int = 256) -> None:
        from ultralytics import YOLO

        self.model = YOLO(model_path)
        self.min_kpt_conf = min_kpt_conf
        self.imgsz = imgsz
        self._lock = threading.Lock()
        self.model_id = os.path.basename(model_path)
        logger.info("Rectificador aprendido cargado: %s", model_path)

    def rectify(self, crop: np.ndarray) -> Optional[RectificationResult]:
        if crop is None or crop.size == 0:
            return None
        with self._lock:
            res = self.model.predict(crop, imgsz=self.imgsz, conf=0.25, verbose=False, device="cpu")[0]
        kp = getattr(res, "keypoints", None)
        if kp is None or kp.xy is None or len(kp.xy) == 0:
            return None
        best = int(res.boxes.conf.argmax()) if res.boxes is not None and len(res.boxes) else 0
        pts = kp.xy[best].cpu().numpy()
        confs = kp.conf[best].cpu().numpy() if kp.conf is not None else np.ones(4)
        min_conf = float(confs.min())
        if min_conf < self.min_kpt_conf:
            return None
        # El modelo se entrenó con el orden sup-izq, sup-der, inf-der, inf-izq; solo se reordena
        # si su salida no forma un cuadrilátero válido.
        corners = pts.astype(np.float32)
        if not is_valid_quad(corners, crop.shape):
            corners = order_corners(pts)
            if not is_valid_quad(corners, crop.shape):
                return None
        return RectificationResult(warp_to_plate(crop, corners), corners, min_conf)


_instance: Optional[PlateRectifier] = None
_loaded = False
_lock = threading.Lock()


def get_rectifier() -> Optional[PlateRectifier]:
    """Instancia única si existe el modelo configurado; si no, None (se usa la heurística)."""
    global _instance, _loaded
    if _loaded:
        return _instance
    with _lock:
        if not _loaded:
            path = PLATE_RECTIFIER_PATH if os.path.isabs(PLATE_RECTIFIER_PATH) else os.path.join(_SERVICE_DIR, PLATE_RECTIFIER_PATH)
            if PLATE_RECTIFIER_PATH and os.path.exists(path):
                try:
                    _instance = PlateRectifier(path)
                except Exception as e:
                    logger.warning("No se pudo cargar el rectificador aprendido (%s); se usa la heurística.", e)
            _loaded = True
    return _instance
