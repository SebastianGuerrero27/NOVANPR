"""
Detector Liviano y Rastreador Científico de Matrículas (ByteTrack + Filtro de Kalman 2D).
Diseñado para Sistemas Inteligentes de Transporte (ITS / ECU 911).

Fundamentos Científicos:
  1. ByteTrack (Zhang et al., ECCV 2022): Asociación en 2 etapas para conservar
     detecciones ante deslumbramiento, desenfoque de movimiento o sombras.
  2. Filtro de Kalman 2D (SORT / BoT-SORT / Bewley et al.):
     Vector de estado continuo x = [cx, cy, s, r, v_cx, v_cy, v_s]^T
     Garantiza predicción fluida a 30 FPS y elimina parpadeos.
  3. Estimación Geométrica Óptica ANT Ecuador:
     Cálculo de distancia óptica con pinhole camera model.
  4. HUD Táctico Industrial: Brackets angulares de fijación y estela de trayectoria.
"""

from __future__ import annotations

import os
import re
import time
import threading
from dataclasses import dataclass, field
from typing import Optional, List, Tuple

import cv2
import numpy as np
import torch
from ultralytics import YOLO

from app.config import (
    INFERENCE_HEIGHT,
    INFERENCE_WIDTH,
    PLATE_CONFIDENCE_THRESHOLD,
    PLATE_MODEL_PATH,
    YOLO_CONFIDENCE_THRESHOLD,
    YOLO_MODEL_PATH,
)
from app.core.ocr_engine import create_ocr_engine
from app.utils.logger import get_logger

from concurrent.futures import ThreadPoolExecutor

logger = get_logger("detector")

# Dimensiones oficiales ANT Ecuador para estimación óptica de distancia
_CAR_PLATE_WIDTH_M = 0.404   # Autos/Camionetas: 40.4 cm de ancho (AR ≈ 2.89 o 2.00)
_MOTO_PLATE_WIDTH_M = 0.200  # Motocicletas:     20.0 cm de ancho (placa ANT cuadrada, AR ≈ 1.25)
_MOTO_AR_THRESHOLD = 1.12     # AR <= 1.12 -> placa cuadrada de motocicleta bajo perspectiva (evita falsos positivos con autos)


# =============================================================================
# 1. Filtro de Kalman 2D para Cajas Delimitadoras (SORT / BoT-SORT Architecture)
# =============================================================================


class KalmanBoxTracker:
    """
    Rastreador individual basado en Filtro de Kalman para una caja delimitadora.
    Estado x: [cx, cy, s, r, v_cx, v_cy, v_s]^T
      - (cx, cy): Centro de la placa
      - s: Escala / Área (ancho * alto)
      - r: Relación de aspecto (ancho / alto)
      - (v_cx, v_cy, v_s): Velocidades de traslación y cambio de escala
    """
    count = 0

    def __init__(self, bbox: list[float], confidence: float = 1.0) -> None:
        KalmanBoxTracker.count += 1
        self.id = KalmanBoxTracker.count

        # Inicialización de matrices de Kalman
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

        # Covarianza de medición (R) y de proceso (Q) optimizadas para respuesta inmediata
        self.kf.measurementNoiseCov = np.eye(4, dtype=np.float32) * 0.1
        self.kf.measurementNoiseCov[2:, 2:] *= 1.0

        self.kf.processNoiseCov = np.eye(7, dtype=np.float32) * 1.0
        self.kf.processNoiseCov[4:, 4:] *= 250.0  # Adaptación instantánea a la velocidad de movimiento
        self.kf.processNoiseCov[2, 2] *= 0.01

        self.kf.errorCovPost = np.eye(7, dtype=np.float32) * 1.0

        # Inicializar estado con la primera detección
        z = self._bbox_to_z(bbox)
        self.kf.statePost = np.array([z[0], z[1], z[2], z[3], 0, 0, 0], dtype=np.float32).reshape((7, 1))

        self.last_bbox = [float(b) for b in bbox]
        self.confidence = confidence
        self.time_since_update = 0
        self.history: list[np.ndarray] = []
        self.hits = 1
        self.hit_streak = 1
        self.age = 0
        self.trajectory: list[tuple[int, int]] = []
        cx = int((bbox[0] + bbox[2]) / 2)
        cy = int((bbox[1] + bbox[3]) / 2)
        self.trajectory.append((cx, cy))

    def _bbox_to_z(self, bbox: list[float]) -> np.ndarray:
        """Convierte [x1, y1, x2, y2] a [cx, cy, s, r]."""
        w = max(1.0, bbox[2] - bbox[0])
        h = max(1.0, bbox[3] - bbox[1])
        cx = bbox[0] + w / 2.0
        cy = bbox[1] + h / 2.0
        s = w * h
        r = w / float(h)
        return np.array([cx, cy, s, r], dtype=np.float32)

    def _x_to_bbox(self, state: np.ndarray) -> list[float]:
        """Convierte [cx, cy, s, r] a [x1, y1, x2, y2]."""
        cx = float(state[0, 0])
        cy = float(state[1, 0])
        s = max(1.0, float(state[2, 0]))
        r = max(0.1, float(state[3, 0]))

        w = np.sqrt(s * r)
        h = s / w if w > 0 else 1.0

        x1 = cx - w / 2.0
        y1 = cy - h / 2.0
        x2 = cx + w / 2.0
        y2 = cy + h / 2.0
        return [x1, y1, x2, y2]

    def predict(self) -> list[float]:
        """Paso de predicción temporal del Filtro de Kalman (30 FPS)."""
        if self.kf.statePost[6, 0] + self.kf.statePost[2, 0] <= 0:
            self.kf.statePost[6, 0] = 0.0

        pred = self.kf.predict()
        self.age += 1
        if self.time_since_update > 0:
            self.hit_streak = 0
        self.time_since_update += 1

        box = self._x_to_bbox(pred)
        self.history.append(np.array(box))
        cx = int((box[0] + box[2]) / 2)
        cy = int((box[1] + box[3]) / 2)
        self.trajectory.append((cx, cy))
        if len(self.trajectory) > 20:
            self.trajectory.pop(0)

        return box

    def update(self, bbox: list[float], confidence: float) -> None:
        """Paso de corrección cuando YOLO detecta la placa."""
        self.time_since_update = 0
        self.history.clear()
        self.hits += 1
        self.hit_streak += 1
        self.confidence = confidence
        self.last_bbox = [float(b) for b in bbox]

        cx = int((bbox[0] + bbox[2]) / 2)
        cy = int((bbox[1] + bbox[3]) / 2)
        if self.trajectory:
            self.trajectory[-1] = (cx, cy)
        else:
            self.trajectory.append((cx, cy))

        z = self._bbox_to_z(bbox).reshape((4, 1))
        self.kf.correct(z)

    def get_state(self) -> list[float]:
        """
        Retorna la estimación actual de la caja [x1, y1, x2, y2] en tiempo real.
        Si la placa fue detectada en el fotograma actual (time_since_update == 0),
        retorna directamente las coordenadas exactas de YOLO con 0 inercia/latencia.
        Si hubo pérdida momentánea de detección (time_since_update > 0),
        retorna la extrapolación temporal suave del Filtro de Kalman.
        """
        if self.time_since_update == 0 and hasattr(self, "last_bbox") and self.last_bbox:
            return self.last_bbox
        return self._x_to_bbox(self.kf.statePost)


# =============================================================================
# 2. Algoritmo de Asociación Científica ByteTrack (IoU 2-Stage Matching)
# =============================================================================


def compute_diou_matrix(boxes1: list[list[float]], boxes2: list[list[float]]) -> np.ndarray:
    """
    Calcula matriz DIoU (Distance-IoU) vectorizada para Sistemas Inteligentes de Transporte (ITS).
    DIoU = IoU - (d^2 / c^2)
    Permite emparejar vehículos en movimiento rápido incluso si la caja se desplazó
    y el IoU clásico cayó a 0, evitando que el track se rompa o se congele.
    """
    if not boxes1 or not boxes2:
        return np.zeros((len(boxes1), len(boxes2)), dtype=np.float32)

    b1 = np.array(boxes1, dtype=np.float32)
    b2 = np.array(boxes2, dtype=np.float32)

    # 1. IoU Estándar
    x1 = np.maximum(b1[:, 0:1], b2[:, 0:1].T)
    y1 = np.maximum(b1[:, 1:2], b2[:, 1:2].T)
    x2 = np.minimum(b1[:, 2:3], b2[:, 2:3].T)
    y2 = np.minimum(b1[:, 3:4], b2[:, 3:4].T)

    inter_w = np.maximum(0.0, x2 - x1)
    inter_h = np.maximum(0.0, y2 - y1)
    inter_area = inter_w * inter_h

    area1 = np.maximum(1.0, (b1[:, 2] - b1[:, 0]) * (b1[:, 3] - b1[:, 1]))
    area2 = np.maximum(1.0, (b2[:, 2] - b2[:, 0]) * (b2[:, 3] - b2[:, 1]))

    union_area = area1[:, None] + area2[None, :] - inter_area
    iou = np.where(union_area > 0, inter_area / union_area, 0.0)

    # 2. Distancia euclidiana al cuadrado entre centros (d^2)
    c1_x = (b1[:, 0:1] + b1[:, 2:3]) / 2.0
    c1_y = (b1[:, 1:2] + b1[:, 3:4]) / 2.0
    c2_x = (b2[:, 0:1] + b2[:, 2:3]).T / 2.0
    c2_y = (b2[:, 1:2] + b2[:, 3:4]).T / 2.0
    d2 = (c1_x - c2_x) ** 2 + (c1_y - c2_y) ** 2

    # 3. Diagonal de la caja envolvente mínima al cuadrado (c^2)
    enc_x1 = np.minimum(b1[:, 0:1], b2[:, 0:1].T)
    enc_y1 = np.minimum(b1[:, 1:2], b2[:, 1:2].T)
    enc_x2 = np.maximum(b1[:, 2:3], b2[:, 2:3].T)
    enc_y2 = np.maximum(b1[:, 3:4], b2[:, 3:4].T)
    c2 = np.maximum(1.0, (enc_x2 - enc_x1) ** 2 + (enc_y2 - enc_y1) ** 2)

    diou = iou - (d2 / c2)
    return diou.astype(np.float32)


def associate_detections_to_trackers(
    detections: list[list[float]],
    trackers: list[list[float]],
    diou_threshold: float = -0.25,
) -> tuple[list[tuple[int, int]], list[int], list[int]]:
    """
    Emparejamiento voraz óptimo de detecciones a rastreadores por matriz DIoU.
    Tolerante a movimientos rápidos de vehículos y vibración de cámara móvil.
    """
    if len(trackers) == 0:
        return [], list(range(len(detections))), []

    diou_matrix = compute_diou_matrix(detections, trackers)

    matched_indices: list[tuple[int, int]] = []
    unmatched_detections = list(range(len(detections)))
    unmatched_trackers = list(range(len(trackers)))

    if min(diou_matrix.shape) > 0:
        flat_indices = np.argsort(-diou_matrix.ravel())
        for idx in flat_indices:
            d_idx = idx // diou_matrix.shape[1]
            t_idx = idx % diou_matrix.shape[1]

            if d_idx in unmatched_detections and t_idx in unmatched_trackers:
                if diou_matrix[d_idx, t_idx] >= diou_threshold:
                    matched_indices.append((d_idx, t_idx))
                    unmatched_detections.remove(d_idx)
                    unmatched_trackers.remove(t_idx)

    return matched_indices, unmatched_detections, unmatched_trackers


# =============================================================================
# 3. Estructuras de Datos y Visualización
# =============================================================================


@dataclass
class TrackedPlateROI:
    """Región de interés detectada y rastreada en el frame actual."""
    tracking_id: int
    plate_bbox: list[int]           # [x1, y1, x2, y2]
    vehicle_bbox: list[int]         # [x1, y1, x2, y2]
    confidence: float
    trajectory: list[tuple[int, int]] = field(default_factory=list)
    timestamp: float = field(default_factory=time.time)
    # Velocidad del centro (píxeles/segundo en coordenadas de frame) extraída del filtro Kalman.
    # Permite extrapolar la posición del bbox en el cliente para tracking fluido entre actualizaciones.
    velocity: list[float] = field(default_factory=lambda: [0.0, 0.0])


@dataclass
class VisualOverlayBox:
    """Caja visual táctica para renderizado industrial (30 FPS)."""
    x1: int
    y1: int
    x2: int
    y2: int
    tracking_id: int
    label: str
    color: tuple[int, int, int]
    trajectory: list[tuple[int, int]] = field(default_factory=list)
    in_sweet_spot: bool = False
    timestamp: float = field(default_factory=time.time)


# =============================================================================
# 4. Pipeline Principal de Detección Liviana y Tracking Científico
# =============================================================================


class DetectionPipeline:
    """
    Pipeline Científico de Detección Liviana y Tracking ByteTrack + Kalman.
    Garantiza retención de caja sin temblores, predictibilidad a 30 FPS y ultra-baja latencia.
    """

    def __init__(self) -> None:
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        num_threads = min(8, max(2, os.cpu_count() or 4))
        try:
            torch.set_num_threads(num_threads)
        except Exception:
            pass

        logger.info("Inicializando Detector Científico ByteTrack en %s (CPU Threads: %d)", self.device, num_threads)

        # 1. Cargar Detector de Placas (loop RTSP principal @ 384px)
        model_path = PLATE_MODEL_PATH if os.path.exists(PLATE_MODEL_PATH) else YOLO_MODEL_PATH
        logger.info("Cargando modelo principal de placas: %s", model_path)
        self._plate_model = YOLO(model_path)

        # 1b. Segunda instancia de YOLO para frames del navegador (@ 256px, sin lock compartido)
        # Cargar el mismo archivo de pesos pero como objeto distinto para paralelismo real.
        logger.info("Cargando modelo browser (256px, instancia independiente): %s", model_path)
        self._browser_model = YOLO(model_path)

        # Precalentamiento de ambos modelos
        try:
            dummy = np.zeros((INFERENCE_HEIGHT, INFERENCE_WIDTH, 3), dtype=np.uint8)
            self._plate_model.predict(dummy, device=self.device, verbose=False)
            self._browser_model.predict(dummy, device=self.device, imgsz=256, verbose=False)
            logger.info("Detectores YOLO pre-calentados exitosamente (principal + browser).")
        except Exception as e:
            logger.warning("Fallo en precalentamiento YOLO: %s", e)

        # 2. Rastreadores Kalman Activos (compartidos entre loops — usar _overlays_lock)
        self._trackers: list[KalmanBoxTracker] = []
        self._max_age = 18
        self._min_hits = 1

        # 3. Buffer de Overlays Visuales y Registro de Placas por Track
        self._overlays_lock = threading.Lock()
        # _model_lock protege _plate_model (solo para el loop RTSP — _browser_model no lo necesita)
        self._model_lock = threading.Lock()
        self._current_overlays: list[VisualOverlayBox] = []
        self._track_plates: dict[int, dict] = {}

        # Métricas de FPS
        self._fps_window: list[float] = []
        self._last_fps_calc = time.time()
        self._fps: float = 0.0

    @property
    def fps(self) -> float:
        return self._fps

    def update_track_plate(self, tracking_id: int, plate: str, confidence: float = 0.0, status: str = "") -> None:
        """Asocia la matrícula reconocida por OCR en tiempo real al tracking ID para renderizado."""
        with self._overlays_lock:
            self._track_plates[tracking_id] = {
                "plate": plate.strip().upper() if plate else "",
                "confidence": confidence,
                "status": status.lower(),
                "time": time.time(),
            }

    def get_track_info(self, tracking_id: int) -> dict:
        """Obtiene la información de matrícula y estado asociada a un track."""
        with self._overlays_lock:
            return self._track_plates.get(tracking_id, {}).copy()

    def detect_fast(self, frame: np.ndarray) -> list[TrackedPlateROI]:
        """
        Detección ultra-rápida para frames del navegador usando la instancia de modelo dedicada.
        - Usa _browser_model (instancia independiente) @ 256px: sin contención con el loop RTSP.
        - Usa _browser_trackers: lista de trackers aislada para el flujo del navegador.
        - No requiere _model_lock: los dos modelos corren en paralelo sin conflictos.
        Resultado: ~15ms de inferencia sin esperar al loop RTSP (~30ms @ 384px).
        """
        if not hasattr(self, '_browser_trackers'):
            self._browser_trackers: list[KalmanBoxTracker] = []
            self._browser_lock = threading.Lock()

        orig_h, orig_w = frame.shape[:2]

        # Predicción Kalman de trackers del browser
        predicted_boxes: list[list[float]] = []
        to_del: list[int] = []
        with self._browser_lock:
            for i, trk in enumerate(self._browser_trackers):
                pos = trk.predict()
                if np.any(np.isnan(pos)):
                    to_del.append(i)
                else:
                    predicted_boxes.append(pos)
            for i in reversed(to_del):
                self._browser_trackers.pop(i)

        # Inferencia YOLO @ 256px — sin lock, modelo independiente
        det_boxes: list[list[float]] = []
        det_confs: list[float] = []
        try:
            results = self._browser_model.predict(
                frame,
                conf=0.36,
                verbose=False,
                device=self.device,
                imgsz=256,
            )[0]
            raw_boxes = results.boxes.xyxy.cpu().numpy()
            raw_confs = results.boxes.conf.cpu().numpy()
            raw_all = []
            raw_all_c = []
            for box, conf in zip(raw_boxes, raw_confs):
                bw = box[2] - box[0]
                bh = box[3] - box[1]
                ar = bw / max(1.0, float(bh))
                # Filtro geométrico vehicular: las matrículas tienen aspecto rectangular (1.3 a 5.0)
                if 1.30 <= ar <= 5.0 and bw >= 30 and bh >= 10:
                    raw_all.append([float(b) for b in box])
                    raw_all_c.append(float(conf))
            if raw_all:
                nms_boxes = [[int(b[0]), int(b[1]), int(b[2] - b[0]), int(b[3] - b[1])] for b in raw_all]
                indices = cv2.dnn.NMSBoxes(nms_boxes, raw_all_c, score_threshold=0.36, nms_threshold=0.35)
                if len(indices) > 0:
                    for idx in np.array(indices).flatten():
                        det_boxes.append(raw_all[idx])
                        det_confs.append(raw_all_c[idx])
        except Exception as e:
            logger.debug("Error en detect_fast YOLO: %s", e)

        # Asociación ByteTrack y actualización de trackers del browser
        matched, unmatched_dets, _ = associate_detections_to_trackers(det_boxes, predicted_boxes)
        with self._browser_lock:
            for d_idx, t_idx in matched:
                self._browser_trackers[t_idx].update(det_boxes[d_idx], det_confs[d_idx])
            for d_idx in unmatched_dets:
                self._browser_trackers.append(KalmanBoxTracker(det_boxes[d_idx], det_confs[d_idx]))
            # Poda de tracks muertos
            self._browser_trackers = [
                t for t in self._browser_trackers if t.time_since_update <= 8
            ]

        # Construir ROIs
        tracked_rois: list[TrackedPlateROI] = []
        _FPS = 30.0
        for trk in self._browser_trackers:
            if trk.hits >= 1 and trk.confidence >= 0.35 and trk.time_since_update <= 2:
                state = trk.get_state()
                x1 = max(0, int(state[0]))
                y1 = max(0, int(state[1]))
                x2 = min(orig_w, int(state[2]))
                y2 = min(orig_h, int(state[3]))
                if x2 <= x1 or y2 <= y1:
                    continue
                vx = float(trk.kf.statePost[4, 0]) * _FPS
                vy = float(trk.kf.statePost[5, 0]) * _FPS
                tracked_rois.append(TrackedPlateROI(
                    tracking_id=trk.id,
                    plate_bbox=[x1, y1, x2, y2],
                    vehicle_bbox=[0, 0, orig_w, orig_h],
                    confidence=trk.confidence,
                    velocity=[round(vx, 2), round(vy, 2)],
                ))
        return tracked_rois

    def detect_and_track(self, frame: np.ndarray, imgsz: int = 384) -> list[TrackedPlateROI]:
        """
        Ejecuta detección liviana y seguimiento científico ByteTrack en dos fases.
        Optimizado para rangos largos (> 2m hasta 10m).
        Args:
            frame:  Fotograma BGR de entrada.
            imgsz:  Resolución de inferencia YOLO. Usar 256 para máxima velocidad en modo navegador,
                    384 (defecto) para máxima precisión en modo RTSP.
        """

        t0 = time.perf_counter()
        orig_h, orig_w = frame.shape[:2]

        # 1. Paso de Predicción del Filtro de Kalman para todos los tracks activos
        predicted_boxes: list[list[float]] = []
        to_del: list[int] = []
        for i, trk in enumerate(self._trackers):
            pos = trk.predict()
            if np.any(np.isnan(pos)):
                to_del.append(i)
            else:
                predicted_boxes.append(pos)

        for i in reversed(to_del):
            self._trackers.pop(i)

        # 2. Inferencia YOLO de Alta Velocidad (Single-Pass Unificado a 384px, ~28ms en CPU)
        det_high_boxes: list[list[float]] = []
        det_high_conf: list[float] = []
        det_low_boxes: list[list[float]] = []
        det_low_conf: list[float] = []

        all_raw_boxes: list[list[float]] = []
        all_raw_confs: list[float] = []

        try:
            with self._model_lock:
                results = self._plate_model.predict(
                    frame,
                    conf=0.35,
                    verbose=False,
                    device=self.device,
                    imgsz=imgsz,  # 256 para browser (2x más rápido), 384 para RTSP (mayor precisión)
                )[0]
            boxes_c = results.boxes.xyxy.cpu().numpy()
            confs_c = results.boxes.conf.cpu().numpy()

            for box, conf in zip(boxes_c, confs_c):
                bw = box[2] - box[0]
                bh = box[3] - box[1]
                ar = bw / max(1.0, float(bh))
                # Filtro geométrico vehicular: las matrículas tienen aspecto rectangular (1.3 a 5.0)
                if 1.30 <= ar <= 5.0 and bw >= 30 and bh >= 10:
                    all_raw_boxes.append([float(box[0]), float(box[1]), float(box[2]), float(box[3])])
                    all_raw_confs.append(float(conf))

            # Non-Maximum Suppression (NMS) para colapsar sub-cajas y mantener una sola caja por matrícula
            if len(all_raw_boxes) > 0:
                nms_boxes = [[int(b[0]), int(b[1]), int(b[2] - b[0]), int(b[3] - b[1])] for b in all_raw_boxes]
                indices = cv2.dnn.NMSBoxes(nms_boxes, all_raw_confs, score_threshold=0.35, nms_threshold=0.35)
                if len(indices) > 0:
                    for idx in np.array(indices).flatten():
                        b = all_raw_boxes[idx]
                        c = all_raw_confs[idx]
                        if c >= 0.45:
                            det_high_boxes.append(b)
                            det_high_conf.append(c)
                        else:
                            det_low_boxes.append(b)
                            det_low_conf.append(c)
        except Exception as e:
            logger.error("Error en inferencia YOLO de matrículas: %s", e)

        # 3. Asociación ByteTrack FASE 1: Detecciones con DIoU (tolerante a movimiento rápido)
        matched, unmatched_dets, unmatched_trks = associate_detections_to_trackers(
            det_high_boxes, predicted_boxes, diou_threshold=-0.25
        )

        for d_idx, t_idx in matched:
            self._trackers[t_idx].update(det_high_boxes[d_idx], det_high_conf[d_idx])

        # 4. Asociación ByteTrack FASE 2: Detecciones de Baja Confianza
        remaining_trk_boxes = [predicted_boxes[i] for i in unmatched_trks]
        matched_2, unmatched_dets_2, unmatched_trks_2 = associate_detections_to_trackers(
            det_low_boxes, remaining_trk_boxes, diou_threshold=-0.35
        )

        for d_idx, t_rel_idx in matched_2:
            real_t_idx = unmatched_trks[t_rel_idx]
            self._trackers[real_t_idx].update(det_low_boxes[d_idx], det_low_conf[d_idx])

        # 5. Crear nuevos rastreadores para detecciones no emparejadas
        for d_idx in unmatched_dets:
            new_trk = KalmanBoxTracker(det_high_boxes[d_idx], det_high_conf[d_idx])
            self._trackers.append(new_trk)

        # 6. Poda de tracks muertos
        dead_tracks = []
        for i, trk in enumerate(self._trackers):
            if trk.time_since_update > self._max_age:
                dead_tracks.append(i)

        for i in reversed(dead_tracks):
            t_id = self._trackers[i].id
            self._trackers.pop(i)
            self._track_plates.pop(t_id, None)

        # 7. Construcción de ROIs y Overlays Visuales Tácticos (Respuesta Inmediata al Movimiento)
        tracked_rois: list[TrackedPlateROI] = []
        new_overlays: list[VisualOverlayBox] = []

        for trk in self._trackers:
            # Seguimiento instantáneo sin requerir que la placa esté inmóvil
            if (trk.hits >= 1 and trk.confidence >= 0.28) and trk.time_since_update <= 3:
                state_box = trk.get_state()
                x1 = max(0, min(orig_w - 5, int(state_box[0])))
                y1 = max(0, min(orig_h - 5, int(state_box[1])))
                x2 = max(x1 + 5, min(orig_w, int(state_box[2])))
                y2 = max(y1 + 5, min(orig_h, int(state_box[3])))

                pw = max(10, x2 - x1)
                ph = max(5, y2 - y1)
                aspect_ratio = pw / float(ph)

                # Clasificación Robusta ANT Ecuador (Sistemas Inteligentes de Transporte - ITS):
                # 1. Los vehículos (autos, camionetas, buses) tienen placas rectangulares (AR >= 1.20) y 3 letras (ej. PBA-1234, PSY-589).
                # 2. Las motocicletas tienen placas cuadradas ANT (AR ≈ 1.25 nominal, pero en perspectiva AR <= 1.12) y 2 letras (ej. AB-123C o PB-1234).
                # 3. Principio ITS: Hipótesis nula y probabilidad a priori = VEHÍCULO.
                has_car_syntax = False
                is_explicit_moto = False
                plate_info = self._track_plates.get(trk.id)
                if plate_info and plate_info.get("plate"):
                    clean_p = re.sub(r"[^A-Z0-9]", "", plate_info["plate"])
                    if len(clean_p) >= 3 and clean_p[:3].isalpha():
                        has_car_syntax = True
                    elif re.match(r"^[A-Z]{2}\d{3,4}[A-Z]?$", clean_p):
                        if aspect_ratio <= _MOTO_AR_THRESHOLD:
                            is_explicit_moto = True
                        else:
                            has_car_syntax = True

                # Condición estricta ITS: Prioridad = VEHÍCULO
                is_moto = is_explicit_moto or (
                    (aspect_ratio <= _MOTO_AR_THRESHOLD) and (pw < orig_w * 0.14) and not has_car_syntax
                )

                # Geometría Óptica ANT Ecuador
                focal_px = orig_w * 0.92
                plate_real_m = _MOTO_PLATE_WIDTH_M if is_moto else _CAR_PLATE_WIDTH_M
                dist_m = (plate_real_m * focal_px) / float(pw)
                dist_m = float(max(0.5, min(15.0, dist_m)))

                # Rango de Operación Inteligente Extendido (hasta 8.5 metros)
                in_sweet_spot = (1.0 <= dist_m <= 8.5) or (pw >= 28)

                # 7.2. Etiquetas del Bounding Box (Estilo idéntico a la imagen solicitada)
                if plate_info and plate_info.get("plate"):
                    plate_str = plate_info["plate"]
                    status_str = plate_info.get("status", "")
                    plate_conf = int(plate_info.get("confidence", 0.95) * 100)

                    if status_str == "alerta":
                        box_color = (0, 0, 255)  # Rojo vivo para alerta
                        box_label = f"ALERTA: {plate_str} ({plate_conf}%)"
                    else:
                        box_color = (0, 255, 0)  # Verde brillante idéntico a la imagen
                        box_label = f"{plate_str} ({plate_conf}%)"
                else:
                    box_color = (0, 255, 0)  # Verde brillante idéntico a la imagen
                    conf_pct = int(trk.confidence * 100)
                    box_label = f"Detectando OCR... ({conf_pct}%)"

                # Extraer velocidad del centro en píxeles/frame desde el vector de estado Kalman
                # Estado: [cx, cy, s, r, v_cx, v_cy, v_s]
                # Multiplicar por FPS nominal (30) para obtener píxeles/segundo
                _FPS = 30.0
                vx_px_s = float(trk.kf.statePost[4, 0]) * _FPS
                vy_px_s = float(trk.kf.statePost[5, 0]) * _FPS

                roi = TrackedPlateROI(
                    tracking_id=trk.id,
                    plate_bbox=[x1, y1, x2, y2],
                    vehicle_bbox=[0, 0, orig_w, orig_h],
                    confidence=trk.confidence,
                    trajectory=list(trk.trajectory),
                    velocity=[round(vx_px_s, 2), round(vy_px_s, 2)],
                )
                tracked_rois.append(roi)

                new_overlays.append(VisualOverlayBox(
                    x1=x1,
                    y1=y1,
                    x2=x2,
                    y2=y2,
                    tracking_id=trk.id,
                    label=box_label,
                    color=box_color,
                    trajectory=list(trk.trajectory),
                    in_sweet_spot=in_sweet_spot,
                ))

        with self._overlays_lock:
            self._current_overlays = new_overlays

        # Medición de FPS
        t_elapsed = time.perf_counter() - t0
        self._fps_window.append(t_elapsed)
        if len(self._fps_window) > 20:
            self._fps_window.pop(0)

        if time.time() - self._last_fps_calc >= 1.0:
            avg_time = sum(self._fps_window) / max(1, len(self._fps_window))
            self._fps = 1.0 / avg_time if avg_time > 0 else 0.0
            self._last_fps_calc = time.time()

        return tracked_rois

    def draw_overlays(
        self,
        frame: np.ndarray,
        capture_fps: float = 0.0,
        inference_fps: float = 0.0,
    ) -> np.ndarray:
        """
        Dibuja el bounding box exactamente en el formato solicitado:
        Rectángulo verde brillante (grosor 3) y texto verde nítido directamente encima del borde superior.
        NUNCA muta el fotograma original en memoria (usa frame.copy()).
        """
        out_frame = frame.copy()
        h, w = out_frame.shape[:2]

        with self._overlays_lock:
            overlays = list(self._current_overlays)

        for ov in overlays:
            x1, y1, x2, y2 = ov.x1, ov.y1, ov.x2, ov.y2
            color = ov.color  # (0, 255, 0)

            # 1. Bounding Box principal idéntico a la imagen (verde brillante, grosor 3)
            cv2.rectangle(out_frame, (x1, y1), (x2, y2), color, 3)

            # 2. Etiqueta de texto verde directamente arriba del borde superior izquierdo
            cv2.putText(
                out_frame,
                ov.label,
                (x1, max(24, y1 - 10)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.72,
                color,
                2,
                cv2.LINE_AA,
            )

        # 5. Barra Superior de Estado Institucional (HUD ECU 911 ITS)
        cv2.rectangle(out_frame, (0, 0), (w, 32), (11, 19, 41), -1)
        status_text = (
            f"ECU 911 ZONA 3 | STREAM: {capture_fps:.1f} FPS | "
            f"BYTE-TRACK KALMAN: {inference_fps:.1f} FPS | TRACKS ACTIVOS: {len(overlays)}"
        )
        cv2.putText(
            out_frame,
            status_text,
            (12, 21),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.46,
            (0, 240, 255),
            1,
            cv2.LINE_AA,
        )

        return out_frame
