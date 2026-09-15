"""
Utilidades geométricas, ópticas y de procesamiento espacial para ALPR.
"""

from __future__ import annotations

import math
from typing import Any, List, Optional, Tuple, Union
import cv2
import numpy as np

from app.core.models import Detection


def crop_bbox(
    frame: np.ndarray,
    bbox: list[float] | tuple[float, float, float, float],
    padding: float = 0.0,
) -> tuple[np.ndarray, list[int]]:
    """
    Recorta una región rectangular con padding proporcional de seguridad.
    Retorna (recorte_np, [x1, y1, x2, y2]_clamped).
    """
    if frame is None or frame.size == 0:
        return np.zeros((10, 10, 3), dtype=np.uint8), [0, 0, 10, 10]

    h, w = frame.shape[:2]
    x1, y1, x2, y2 = bbox

    bw = x2 - x1
    bh = y2 - y1

    pad_x = bw * padding
    pad_y = bh * padding

    cx1 = max(0, int(round(x1 - pad_x)))
    cy1 = max(0, int(round(y1 - pad_y)))
    cx2 = min(w, int(round(x2 + pad_x)))
    cy2 = min(h, int(round(y2 + pad_y)))

    if cx2 <= cx1 or cy2 <= cy1:
        return np.zeros((10, 10, 3), dtype=np.uint8), [0, 0, 10, 10]

    crop = frame[cy1:cy2, cx1:cx2].copy()
    return crop, [cx1, cy1, cx2, cy2]


def bbox_cache_key(
    bbox: list[float] | tuple[float, float, float, float],
    precision: int = 1,
) -> tuple[float, float, float, float]:
    """Genera una clave hashable para diccionarios a partir de coordenadas redondeadas."""
    return (
        round(float(bbox[0]), precision),
        round(float(bbox[1]), precision),
        round(float(bbox[2]), precision),
        round(float(bbox[3]), precision),
    )


def parse_points(raw: Any) -> list[tuple[int, int]]:
    """Parsea representaciones diversas de puntos a lista de tuplas (x, y)."""
    if not raw:
        return []
    if isinstance(raw, list):
        pts = []
        for p in raw:
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                pts.append((int(round(p[0])), int(round(p[1]))))
            elif isinstance(p, dict) and "x" in p and "y" in p:
                pts.append((int(round(p["x"])), int(round(p["y"]))))
        return pts
    return []


def parse_line(raw: Any) -> tuple[tuple[int, int], tuple[int, int]]:
    """Parsea una línea definida por dos puntos."""
    pts = parse_points(raw)
    if len(pts) >= 2:
        return (pts[0], pts[1])
    return ((0, 0), (100, 100))


def dedupe_consecutive_points(pts: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Elimina puntos consecutivos idénticos en polígonos."""
    if not pts:
        return []
    deduped = [pts[0]]
    for p in pts[1:]:
        if p != deduped[-1]:
            deduped.append(p)
    return deduped


def movement_vector_from_line(
    start: tuple[int, int],
    end: tuple[int, int],
) -> tuple[float, float]:
    """Calcula el vector director normalizado de avance."""
    dx = float(end[0] - start[0])
    dy = float(end[1] - start[1])
    dist = math.hypot(dx, dy)
    if dist < 1e-6:
        return (0.0, 0.0)
    return (dx / dist, dy / dist)


def optional_panel_height(val: Any) -> Optional[int]:
    """Parsea altura opcional de panel."""
    if val is None:
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


def is_point_in_polygon(point: tuple[float, float], polygon: list[tuple[int, int]]) -> bool:
    """Verifica si un punto (x, y) se encuentra dentro de un polígono cerrado."""
    if not polygon or len(polygon) < 3:
        return True
    poly_np = np.array(polygon, dtype=np.int32)
    dist = cv2.pointPolygonTest(poly_np, (float(point[0]), float(point[1])), False)
    return dist >= 0


def filter_detections_in_zone(
    detections: list[Detection],
    zone: Optional[list[tuple[int, int]]],
    anchor: str = "center",
) -> list[Detection]:
    """Filtra detecciones verificando si su punto ancla se encuentra dentro de la zona."""
    if not zone or len(zone) < 3:
        return detections

    filtered: list[Detection] = []
    for det in detections:
        pt = det.bottom_center if anchor == "bottom_center" else det.center
        if is_point_in_polygon(pt, zone):
            filtered.append(det)
    return filtered


def detect_plates_for_vehicles(
    frame: np.ndarray,
    vehicles: list[Detection],
    plate_detector: Any,
    crop_padding: float = 0.08,
    plate_color: tuple[int, int, int] = (0, 255, 0),
) -> list[Detection]:
    """
    Detecta matrículas recortando primero cada ROI de vehículo (jerarquía vehículo -> placa).
    Asegura máxima velocidad y precisión al reducir el espacio de búsqueda.
    """
    if plate_detector is None or not vehicles:
        return []

    all_plates: list[Detection] = []
    for veh in vehicles:
        crop, [cx1, cy1, cx2, cy2] = crop_bbox(frame, veh.bbox, padding=crop_padding)
        if crop.size == 0:
            continue

        raw_plates: list[Detection] = plate_detector.predict(crop)
        for p in raw_plates:
            # Traducir coordenadas locales de recorte a coordenadas absolutas de imagen
            px1 = p.bbox[0] + cx1
            py1 = p.bbox[1] + cy1
            px2 = p.bbox[2] + cx1
            py2 = p.bbox[3] + cy1

            all_plates.append(
                Detection(
                    bbox=[px1, py1, px2, py2],
                    confidence=p.confidence,
                    class_id=p.class_id,
                    class_name="plate",
                    track_id=veh.track_id,
                    color=plate_color,
                    metadata={"parent_vehicle_bbox": veh.bbox},
                )
            )

    return all_plates


def detect_plates_full_frame(
    frame: np.ndarray,
    plate_detector: Any,
    plate_color: tuple[int, int, int] = (0, 255, 0),
) -> list[Detection]:
    """Detecta matrículas buscando directamente en toda la imagen (full frame)."""
    if plate_detector is None or frame is None or frame.size == 0:
        return []

    plates = plate_detector.predict(frame)
    for p in plates:
        p.class_name = "plate"
        p.color = plate_color
    return plates
