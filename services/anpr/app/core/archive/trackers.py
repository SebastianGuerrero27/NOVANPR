"""
Módulo de Seguimiento Espaciotemporal Multiobjeto (MOT) para Vehículos y Matrículas.
Implementa ByteTrack con Filtro de Kalman 2D y asignación por IoU.
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from typing import Any, List, Optional, Tuple
import cv2
import numpy as np

from app.core.models import Detection, Track
from app.utils.logger import get_logger

logger = get_logger("trackers")


def bbox_iou(boxA: list[float] | tuple[float, float, float, float],
             boxB: list[float] | tuple[float, float, float, float]) -> float:
    """Calcula la Intersección sobre Unión (IoU) entre dos cajas [x1, y1, x2, y2]."""
    xA = max(boxA[0], boxB[0])
    yA = max(boxA[1], boxB[1])
    xB = min(boxA[2], boxB[2])
    yB = min(boxA[3], boxB[3])

    interW = max(0.0, xB - xA)
    interH = max(0.0, yB - yA)
    interArea = interW * interH

    boxAArea = max(1e-6, (boxA[2] - boxA[0]) * (boxA[3] - boxA[1]))
    boxBArea = max(1e-6, (boxB[2] - boxB[0]) * (boxB[3] - boxB[1]))

    return interArea / float(boxAArea + boxBArea - interArea)


class KalmanBoxTracker:
    """Filtro de Kalman 2D para estimación de trayectoria de una caja delimitadora."""
    count = 0

    def __init__(self, bbox: list[float] | tuple[float, float, float, float]) -> None:
        KalmanBoxTracker.count += 1
        self.id = KalmanBoxTracker.count

        # Estado: [cx, cy, s, r, v_cx, v_cy, v_s]^T
        self.kf = cv2.KalmanFilter(7, 4)
        self.kf.transitionMatrix = np.array([
            [1, 0, 0, 0, 1, 0, 0],
            [0, 1, 0, 0, 0, 1, 0],
            [0, 0, 1, 0, 0, 0, 1],
            [0, 0, 0, 1, 0, 0, 0],
            [0, 0, 0, 0, 1, 0, 0],
            [0, 0, 0, 0, 0, 1, 0],
            [0, 0, 0, 0, 0, 0, 1],
        ], dtype=np.float32)

        self.kf.measurementMatrix = np.array([
            [1, 0, 0, 0, 0, 0, 0],
            [0, 1, 0, 0, 0, 0, 0],
            [0, 0, 1, 0, 0, 0, 0],
            [0, 0, 0, 1, 0, 0, 0],
        ], dtype=np.float32)

        self.kf.processNoiseCov = np.eye(7, dtype=np.float32) * 1e-2
        self.kf.measurementNoiseCov = np.eye(4, dtype=np.float32) * 1e-1
        self.kf.errorCovPost = np.eye(7, dtype=np.float32) * 1.0

        # Inicializar estado con la primera caja
        z = self._bbox_to_z(bbox)
        self.kf.statePost = np.array([z[0], z[1], z[2], z[3], 0, 0, 0], dtype=np.float32).reshape((7, 1))

        self.time_since_update = 0
        self.hits = 1
        self.age = 1
        self.history: list[tuple[float, float]] = [(z[0], z[1])]
        self.last_bbox: list[float] = list(bbox)

    def _bbox_to_z(self, bbox: list[float] | tuple[float, float, float, float]) -> np.ndarray:
        w = max(1.0, bbox[2] - bbox[0])
        h = max(1.0, bbox[3] - bbox[1])
        cx = bbox[0] + w / 2.0
        cy = bbox[1] + h / 2.0
        s = w * h
        r = w / float(h)
        return np.array([cx, cy, s, r], dtype=np.float32)

    def _x_to_bbox(self, state: np.ndarray) -> list[float]:
        st = state.flatten()
        cx = float(st[0])
        cy = float(st[1])
        s = max(1.0, float(st[2]))
        r = max(0.1, min(10.0, float(st[3])))
        w = math.sqrt(s * r)
        h = s / float(w)
        return [cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0]

    def predict(self) -> list[float]:
        self.kf.predict()
        self.age += 1
        self.time_since_update += 1
        pred_box = self._x_to_bbox(self.kf.statePost)
        self.last_bbox = pred_box
        return pred_box

    def update(self, bbox: list[float] | tuple[float, float, float, float]) -> None:
        self.time_since_update = 0
        self.hits += 1
        z = self._bbox_to_z(bbox)
        self.kf.correct(z.reshape((4, 1)))
        zf = z.flatten()
        cx, cy = float(zf[0]), float(zf[1])
        self.history.append((cx, cy))
        if len(self.history) > 30:
            self.history.pop(0)
        self.last_bbox = list(bbox)


class BaseTracker(ABC):
    """Interfaz abstracta para algoritmos de seguimiento de objetos."""

    @abstractmethod
    def update(self, detections: list[Detection], frame: Optional[np.ndarray] = None) -> list[Track]:
        """Actualiza el rastreador con las nuevas detecciones y retorna tracks confirmados."""
        pass

    @abstractmethod
    def reset(self) -> None:
        """Reinicia el estado interno del rastreador."""
        pass


class TeachingTracker(BaseTracker):
    """
    Rastreador ByteTrack multiobjeto adaptado para vehículos y matrículas.
    Asocia detecciones de alta y baja confianza mediante dos etapas de IoU.
    """

    def __init__(
        self,
        max_age: int = 30,
        min_hits: int = 2,
        lost_buffer: int = 3,
        high_thresh: float = 0.5,
        low_thresh: float = 0.1,
        match_thresh: float = 0.8,
        low_match_thresh: float = 0.5,
        same_class: bool = True,
        trail_length: int = 15,
    ) -> None:
        self.max_age = max_age
        self.min_hits = min_hits
        self.lost_buffer = lost_buffer
        self.high_thresh = high_thresh
        self.low_thresh = low_thresh
        self.match_thresh = match_thresh
        self.low_match_thresh = low_match_thresh
        self.same_class = same_class
        self.trail_length = trail_length

        self.trackers: list[KalmanBoxTracker] = []
        self.track_classes: dict[int, str] = {}
        self.track_confidences: dict[int, float] = {}

    def reset(self) -> None:
        self.trackers.clear()
        self.track_classes.clear()
        self.track_confidences.clear()
        KalmanBoxTracker.count = 0

    def update(self, detections: list[Detection], frame: Optional[np.ndarray] = None) -> list[Track]:
        # 1. Predecir nuevas posiciones de los tracks existentes
        for t in self.trackers:
            t.predict()

        # Separar detecciones en alta y baja confianza
        high_dets = [d for d in detections if d.confidence >= self.high_thresh]
        low_dets = [d for d in detections if self.low_thresh <= d.confidence < self.high_thresh]

        unmatched_trackers = list(range(len(self.trackers)))
        matched_tracks: list[Tuple[int, int]] = []

        # 2. Primera etapa: Asociar detecciones de alta confianza
        if self.trackers and high_dets:
            iou_matrix = np.zeros((len(self.trackers), len(high_dets)), dtype=np.float32)
            for i, trk in enumerate(self.trackers):
                for j, det in enumerate(high_dets):
                    iou_matrix[i, j] = bbox_iou(trk.last_bbox, det.bbox)

            # Emparejamiento Greedy / Hungarian
            used_tracks = set()
            used_dets = set()

            # Ordenar por mayor IoU
            pairs = []
            for i in range(len(self.trackers)):
                for j in range(len(high_dets)):
                    if iou_matrix[i, j] >= (1.0 - self.match_thresh):
                        pairs.append((iou_matrix[i, j], i, j))
            pairs.sort(key=lambda x: x[0], reverse=True)

            for iou_val, t_idx, d_idx in pairs:
                if t_idx not in used_tracks and d_idx not in used_dets:
                    used_tracks.add(t_idx)
                    used_dets.add(d_idx)
                    matched_tracks.append((t_idx, d_idx))
                    self.trackers[t_idx].update(high_dets[d_idx].bbox)
                    self.track_classes[self.trackers[t_idx].id] = high_dets[d_idx].class_name
                    self.track_confidences[self.trackers[t_idx].id] = high_dets[d_idx].confidence

            unmatched_trackers = [i for i in range(len(self.trackers)) if i not in used_tracks]
            unmatched_high_dets = [j for j in range(len(high_dets)) if j not in used_dets]
        else:
            unmatched_high_dets = list(range(len(high_dets)))

        # 3. Segunda etapa: Asociar tracks restantes con detecciones de baja confianza
        if unmatched_trackers and low_dets:
            used_low_dets = set()
            for t_idx in list(unmatched_trackers):
                best_iou = -1.0
                best_d_idx = -1
                for d_idx, det in enumerate(low_dets):
                    if d_idx in used_low_dets:
                        continue
                    iou = bbox_iou(self.trackers[t_idx].last_bbox, det.bbox)
                    if iou > best_iou:
                        best_iou = iou
                        best_d_idx = d_idx

                if best_iou >= (1.0 - self.low_match_thresh) and best_d_idx >= 0:
                    used_low_dets.add(best_d_idx)
                    unmatched_trackers.remove(t_idx)
                    self.trackers[t_idx].update(low_dets[best_d_idx].bbox)

        # 4. Crear nuevos tracks para detecciones de alta confianza no emparejadas
        for d_idx in unmatched_high_dets:
            det = high_dets[d_idx]
            trk = KalmanBoxTracker(det.bbox)
            self.trackers.append(trk)
            self.track_classes[trk.id] = det.class_name
            self.track_confidences[trk.id] = det.confidence

        # 5. Filtrar tracks muertos o perdidos
        active_trackers = []
        for trk in self.trackers:
            if trk.time_since_update <= self.max_age:
                active_trackers.append(trk)
            else:
                self.track_classes.pop(trk.id, None)
                self.track_confidences.pop(trk.id, None)
        self.trackers = active_trackers

        # 6. Construir lista de resultados de tracks confirmados
        confirmed_tracks: list[Track] = []
        for trk in self.trackers:
            if trk.hits >= self.min_hits or trk.age <= self.min_hits:
                confirmed_tracks.append(
                    Track(
                        track_id=trk.id,
                        bbox=trk.last_bbox,
                        class_name=self.track_classes.get(trk.id, "vehicle"),
                        confidence=self.track_confidences.get(trk.id, 1.0),
                        hits=trk.hits,
                        age=trk.age,
                        time_since_update=trk.time_since_update,
                        history=list(trk.history[-self.trail_length:]),
                    )
                )

        return confirmed_tracks


def update_tracks(
    tracker: BaseTracker | object,
    detections: list[Detection],
    frame: Optional[np.ndarray] = None,
) -> list[Track]:
    """Helper unificado para actualizar cualquier tracker compatible."""
    if tracker is None:
        return []
    if hasattr(tracker, "update"):
        return tracker.update(detections, frame)
    return []


def create_teaching_tracker(
    tracker_type: str = "bytetrack",
    *,
    max_age: int = 30,
    min_hits: int = 2,
    lost_buffer: int = 3,
    high_thresh: float = 0.5,
    low_thresh: float = 0.1,
    match_thresh: float = 0.8,
    low_match_thresh: float = 0.5,
    same_class: bool = True,
    trail_length: int = 15,
) -> BaseTracker:
    """Factory para instanciar algoritmos de tracking."""
    return TeachingTracker(
        max_age=max_age,
        min_hits=min_hits,
        lost_buffer=lost_buffer,
        high_thresh=high_thresh,
        low_thresh=low_thresh,
        match_thresh=match_thresh,
        low_match_thresh=low_match_thresh,
        same_class=same_class,
        trail_length=trail_length,
    )
