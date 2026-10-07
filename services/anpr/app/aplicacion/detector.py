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
  5. Validación por Configuración de País (patrón OpenALPR "country config"):
     cada lectura OCR se valida contra el formato oficial de placas ANT Ecuador
     antes de aceptarse, descartando ruido de OCR que no es una placa posible.
  6. Consenso Temporal de Placa ("Plate Groups", patrón OpenALPR / motores LPR
     comerciales tipo Hikvision-Dahua que usan las cámaras que distribuye Syscom):
     un mismo track acumula varias lecturas OCR a lo largo de su vida y se
     reporta la de mayor consenso ponderado, no la última leída — evita el
     parpadeo de texto entre frames y corrige errores de un solo caracter.
  7. Filtro de Nitidez (Laplaciano) pre-OCR: descarta recortes borrosos por
     desenfoque de movimiento antes de que cuenten como evidencia, igual que
     hacen los DVR/NVR LPR que disparan el OCR solo en el frame "sweet spot".
"""

from __future__ import annotations

import os
import re
import time
import threading
from collections import Counter
from dataclasses import dataclass, field
from typing import Optional, List, Tuple

import cv2
import numpy as np

from app.infraestructura.config import (
    CAR_PLATE_AR_MAX,
    CAR_PLATE_AR_MIN,
    MOTO_PLATE_AR_MAX,
    MOTO_PLATE_AR_MIN,
    PLATE_CONFIDENCE_THRESHOLD,
    YOLO_CONFIDENCE_THRESHOLD,
)
from app.dominio.models import Detection
from app.infraestructura.detectors import BaseDetector, create_detector
from app.infraestructura.ocr_engine import create_ocr_engine
from app.aplicacion.verificacion_placa import (
    MIN_CARACTERES,
    AnalisisCaracteres,
    analizar_caracteres,
    cuadrilatero_placa,
    punto_en_roi,
    recorte_con_margen,
)
from app.infraestructura.logger import get_logger

from concurrent.futures import ThreadPoolExecutor

logger = get_logger("detector")

# Dimensiones oficiales ANT Ecuador para estimación óptica de distancia
_CAR_PLATE_WIDTH_M = 0.404   # Autos/Camionetas: 40.4 cm de ancho (AR ≈ 2.89 o 2.00)
_MOTO_PLATE_WIDTH_M = 0.200  # Motocicletas:     20.0 cm de ancho (placa ANT cuadrada, AR ≈ 1.25)
_MOTO_AR_THRESHOLD = 1.45     # AR <= 1.45 -> placa cuadrada de motocicleta bajo perspectiva (evita falsos positivos con autos)

# Patrones oficiales ANT Ecuador (equivalente al "country config" / pattern.conf
# de OpenALPR): una lectura OCR solo se acepta como voto válido si calza con uno
# de estos formatos. Esto filtra ruido de OCR (ej. "SY-589" en vez de "PSY-589")
# antes de que contamine el consenso de placa del track.
_PLATE_PATTERN_CAR = re.compile(r"^[A-Z]{3}\d{3,4}$")            # Ej. PBA1234, PSY589
_PLATE_PATTERN_MOTO = re.compile(r"^[A-Z]{2}\d{3,4}[A-Z]?$")     # Ej. AB123C, PB1234

# Umbral de nitidez (varianza del Laplaciano). Por debajo de este valor el
# recorte se considera borroso por desenfoque de movimiento o desenfoque óptico
# y no debería alimentar el consenso de placa ni el pipeline de OCR.
_MIN_SHARPNESS_VARIANCE = 35.0

# Verificación geométrica por track: el análisis de caracteres (≈3–5 ms) se repite como
# máximo 4 veces por segundo por track; entre análisis se reutiliza el cuadrilátero.
_INTERVALO_ANALISIS_S = 0.25

# Estados que decide el backend (o la confirmación del registro): una lectura OCR posterior
# ("leida"/"escaneando") no debe sobrescribirlos.
_ESTADOS_FINALES = {"confirmada", "autorizado", "alerta", "no_reconocido", "pendiente_revision"}

# Colores de estado (BGR) iguales a los del sistema web: autorizado #15803d,
# pendiente #2563eb, no registrado #d97706, alerta #b91c1c. Mientras el OCR escanea,
# ámbar #f59e0b; con la placa leída y sin decisión del backend, verde #22c55e.
_COLOR_ESTADO = {
    "autorizado": (61, 128, 21),
    "pendiente_revision": (235, 99, 37),
    "no_reconocido": (6, 119, 217),
    "alerta": (28, 28, 185),
}
_COLOR_ESCANEANDO = (11, 158, 245)
_COLOR_LEIDA = (94, 197, 34)
_TEXTO_ESTADO = {
    "autorizado": "AUTORIZADO",
    "pendiente_revision": "POR CONFIRMAR",
    "no_reconocido": "NO REGISTRADO",
    "alerta": "ALERTA",
}


def placa_con_guion(placa: str) -> str:
    """PSY589 -> PSY-589 (formato de presentación ANT)."""
    return re.sub(r"^([A-Z]{2,3})(\d)", r"\1-\2", placa or "")


def normalize_plate_text(raw_text: str) -> str:
    """Normaliza un texto OCR crudo a mayúsculas alfanuméricas sin separadores."""
    if not raw_text:
        return ""
    return re.sub(r"[^A-Z0-9]", "", raw_text.strip().upper())


def is_valid_ecuador_plate(raw_text: str) -> bool:
    """
    Valida una lectura OCR contra el formato oficial de placas ANT Ecuador.
    Equivalente al "country config" de OpenALPR: una placa candidata que no
    calza con ningún patrón conocido se descarta como ruido de OCR y no debe
    contarse como voto válido en el consenso del track.
    """
    clean = normalize_plate_text(raw_text)
    if len(clean) < 5 or len(clean) > 7:
        return False
    return bool(_PLATE_PATTERN_CAR.match(clean) or _PLATE_PATTERN_MOTO.match(clean))


def byte_track_thresholds() -> tuple[float, float]:
    """
    Umbrales de ByteTrack derivados de PLATE_CONFIDENCE_THRESHOLD (.env):
      - alto: detecciones que crean y actualizan tracks (fase 1).
      - bajo: detecciones débiles que solo rescatan tracks existentes (fase 2).
    Antes el valor configurado se forzaba al rango [0.12, 0.20] y se ignoraba.
    """
    high = float(PLATE_CONFIDENCE_THRESHOLD)
    low = min(high, max(0.05, high * 0.25))
    return high, low


def compute_crop_sharpness(crop: np.ndarray) -> float:
    """
    Calcula la nitidez de un recorte mediante la varianza del Laplaciano
    (Pech-Pacheco et al., 2000) — técnica estándar en pipelines LPR comerciales
    para descartar frames con desenfoque de movimiento antes de invertir
    cómputo de OCR en ellos o de dejarlos votar por una placa.
    """
    if crop is None or crop.size == 0:
        return 0.0
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if len(crop.shape) == 3 else crop
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())





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
    # Hora en que nació cada track (id -> time.time()). Sobrevive a la eliminación del track
    # para poder medir la latencia de principio a fin cuando el vehículo ya salió de escena.
    birth_times: dict[int, float] = {}

    # Ganancia base del término de velocidad del proceso (v_cx, v_cy, v_s).
    # Se usa como punto de partida y luego se escala dinámicamente en predict()
    # según la rapidez real observada en la trayectoria del track.
    _BASE_VELOCITY_NOISE = 300.0

    def __init__(self, bbox: list[float], confidence: float = 1.0) -> None:
        KalmanBoxTracker.count += 1
        self.id = KalmanBoxTracker.count
        now = time.time()
        KalmanBoxTracker.birth_times[self.id] = now
        if len(KalmanBoxTracker.birth_times) > 2000:  # poda: conservar solo los últimos 10 minutos
            KalmanBoxTracker.birth_times = {k: v for k, v in KalmanBoxTracker.birth_times.items() if now - v < 600}

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

        # Covarianza de medición (R) y de proceso (Q) optimizadas para respuesta inmediata.
        # R se reduce (0.1 -> 0.06) para que la caja se ajuste con más firmeza a la
        # posición real detectada por YOLO en cada frame (menos inercia / menos "arrastre"
        # cuando la placa se mueve), sin perder la suavidad entre detecciones.
        self.kf.measurementNoiseCov = np.eye(4, dtype=np.float32) * 0.06
        self.kf.measurementNoiseCov[2:, 2:] *= 1.0

        self.kf.processNoiseCov = np.eye(7, dtype=np.float32) * 1.0
        self.kf.processNoiseCov[4:, 4:] *= self._BASE_VELOCITY_NOISE  # Adaptación instantánea a la velocidad de movimiento
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

        # Refuerzo adaptativo de velocidad: se mide la rapidez real reciente del track
        # (a partir de su propia trayectoria ya registrada, sin crear atributos nuevos)
        # y se incrementa temporalmente la confianza del filtro en el término de
        # velocidad (v_cx, v_cy, v_s). Así la caja reacciona de inmediato cuando la
        # placa acelera o cambia de dirección, y se mantiene estable cuando está casi
        # quieta (boost -> 1.0).
        if len(self.trajectory) >= 2:
            dx = self.trajectory[-1][0] - self.trajectory[-2][0]
            dy = self.trajectory[-1][1] - self.trajectory[-2][1]
            speed_px = (dx * dx + dy * dy) ** 0.5
            boost = 1.0 + min(3.0, speed_px / 40.0)
            self.kf.processNoiseCov[4:, 4:] = np.eye(3, dtype=np.float32) * (self._BASE_VELOCITY_NOISE * boost)

        pred = self.kf.predict()
        self.age += 1
        if self.time_since_update > 0:
            self.hit_streak = 0
        self.time_since_update += 1

        box = self._x_to_bbox(pred)
        self.history.append(np.array(box))
        return box

    def update(self, bbox: list[float], confidence: float) -> None:
        """Paso de corrección cuando YOLO detecta la placa."""
        self.time_since_update = 0
        self.history.clear()
        self.hits += 1
        self.hit_streak += 1
        self.confidence = confidence
        self.last_bbox = [float(b) for b in bbox]

        # Corrección Kalman primero
        z = self._bbox_to_z(bbox).reshape((4, 1))
        self.kf.correct(z)

        # Agregar posición de detección a la trayectoria (no sobrescribir)
        cx = int((bbox[0] + bbox[2]) / 2)
        cy = int((bbox[1] + bbox[3]) / 2)
        self.trajectory.append((cx, cy))
        if len(self.trajectory) > 20:
            self.trajectory.pop(0)

    def get_state(self) -> list[float]:
        """
        Retorna la estimación actual de la caja [x1, y1, x2, y2] del Filtro de Kalman.
        Siempre retorna el estado corregido/predicho del Kalman, lo que garantiza
        un seguimiento suave y continuo de la placa en movimiento.
        """
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

    # 4. Compuerta de consistencia de escala: una placa real no cambia de tamaño
    # bruscamente de un frame a otro. Si el área de la detección candidata difiere
    # más de 2.5x del área predicha por el track, se descarta el emparejamiento
    # aunque el DIoU sea alto (evita que el track "salte" hacia un objeto grande
    # y estático como una mochila, una mochila o cualquier textura fija cercana).
    area_ratio = np.maximum(area1[:, None] / area2[None, :], area2[None, :] / area1[:, None])
    diou = np.where(area_ratio > 2.5, -1.0, diou)

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
    # Nitidez del recorte actual (varianza del Laplaciano). Permite que el consumidor
    # (worker de OCR) decida si vale la pena procesar este frame o esperar a uno más nítido —
    # patrón "best frame selector" usado en LPR comerciales para no gastar OCR en frames borrosos.
    quality: float = 0.0
    # Polígono orientado de 4 vértices [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] estilo Rekor Scout / OpenALPR
    oriented_box: list[list[int]] = field(default_factory=list)


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
    oriented_box: list[list[int]] = field(default_factory=list)
    placa: str = ""
    estado: str = ""
    # Lectura cruda del OCR que aún no forma una placa ANT (se muestra mientras escanea)
    parcial: str = ""
    # Confianza del detector y de la placa por consenso (0–1)
    confianza: float = 0.0
    confianza_placa: float = 0.0
    # Velocidad del centro (px/s, estado Kalman) para extrapolar la caja entre envíos
    velocidad: tuple[float, float] = (0.0, 0.0)
    # Región comprobada como placa (fila de caracteres) o con dos lecturas ANT
    verificada: bool = False


# =============================================================================
# 4. Pipeline Principal de Detección Liviana y Tracking Científico
# =============================================================================


class DetectionPipeline:
    """
    Pipeline Científico de Detección Liviana y Tracking ByteTrack + Kalman.
    Garantiza retención de caja sin temblores, predictibilidad a 30 FPS y ultra-baja latencia.
    Incorpora Inyección de Dependencias (DI) para admitir cualquier backend (YOLO, ONNX, Mock).
    """

    def __init__(
        self,
        detector: BaseDetector,
        browser_detector: Optional[BaseDetector] = None,
    ) -> None:
        self.detector = detector
        self.browser_detector = browser_detector or detector

        logger.info("Inicializando DetectionPipeline con detectores inyectados (DI).")

        # 1. Rastreadores Kalman Activos para loop RTSP
        self._trackers: list[KalmanBoxTracker] = []
        self._trackers_lock = threading.Lock()
        # _max_age: tiempo que un track sobrevive sin una detección real antes de
        # eliminarse. Se reduce a 4 frames (~130ms a 30 FPS) para eliminar inmediatamente
        # tracks fantasma cuando el vehículo sale de la escena.
        self._max_age = 4
        self._min_hits = 1

        # 2. Buffer de Overlays Visuales y Registro de Placas por Track
        self._overlays_lock = threading.Lock()
        self._current_overlays: list[VisualOverlayBox] = []
        # _track_plates: consenso de placas del loop RTSP (hilo principal)
        self._track_plates: dict[int, dict] = {}
        # _browser_track_plates: consenso de placas EXCLUSIVO del flujo WebSocket del navegador.
        self._browser_track_plates: dict[int, dict] = {}

        # 3. Rastreadores Kalman Activos para flujo Browser WebSocket
        self._browser_trackers: list[KalmanBoxTracker] = []
        self._browser_lock = threading.Lock()

        # 4. OpenALPR Motion Detector (MOG2) para Zonas de Interés
        self._bg_subtractor = cv2.createBackgroundSubtractorMOG2(history=120, varThreshold=25, detectShadows=False)
        self._last_motion_bbox: Optional[list[int]] = None
        self._last_motion_pct: int = 0
        # True solo cuando la zona de movimiento contiene una detección YOLO de placa/vehículo
        self._last_motion_vehicle_detected: bool = False

        # 5. Verificación geométrica por track (análisis de caracteres estilo OpenALPR):
        #    id -> {"t", "mejor": AnalisisCaracteres, "quad_rel", "es_placa"}
        self._analisis: dict[int, dict] = {}
        # 6. Región de interés de la cámara (polígono normalizado 0–1). Equivale a la
        #    "detection mask" de OpenALPR: fuera de ella no se buscan placas.
        self._roi_norm: Optional[list[list[float]]] = None
        # Evidencias de tracks recién terminados: id -> (hora, consenso, análisis)
        self._retirados: dict[int, tuple[float, Optional[dict], Optional[dict]]] = {}

        # Métricas de FPS
        self._fps_window: list[float] = []
        self._last_fps_calc = time.time()
        self._fps: float = 0.0

    @property
    def fps(self) -> float:
        return self._fps

    # ------------------------------------------------------------------
    # Región de interés y verificación geométrica
    # ------------------------------------------------------------------

    def set_roi(self, puntos: Optional[list]) -> Optional[list[list[float]]]:
        """Fija la región de interés (≥ 3 vértices normalizados 0–1) o la quita con None/[]."""
        roi = None
        if puntos:
            try:
                roi = [[max(0.0, min(1.0, float(p[0]))), max(0.0, min(1.0, float(p[1])))] for p in puntos]
            except (TypeError, ValueError, IndexError):
                roi = None
            if roi is not None and len(roi) < 3:
                roi = None
        self._roi_norm = roi
        logger.info("Región de interés: %s", f"{len(roi)} vértices" if roi else "cuadro completo")
        return roi

    @property
    def roi(self) -> Optional[list[list[float]]]:
        return [list(p) for p in self._roi_norm] if self._roi_norm else None

    def _roi_px(self, w: int, h: int) -> Optional[np.ndarray]:
        roi = self._roi_norm
        if not roi:
            return None
        return np.array([[p[0] * w, p[1] * h] for p in roi], dtype=np.float32)

    def mejor_analisis(self, tracking_id: int) -> Optional[AnalisisCaracteres]:
        """Mejor análisis de caracteres observado en la vida del track (para la validez de la lectura)."""
        with self._overlays_lock:
            reg = self._analisis.get(tracking_id) or (self._retirados.get(tracking_id, (0, None, None))[2])
            return reg["mejor"] if reg else None

    def conteo_lecturas(self, tracking_id: int) -> Counter:
        """
        Lecturas OCR con formato ANT registradas para el track, por texto de placa (una por
        cuadro leído). Se toma el mayor conteo entre el flujo RTSP, el del navegador y el
        track recién terminado.
        """
        with self._overlays_lock:
            total: Counter = Counter()
            retirado = self._retirados.get(tracking_id, (0, None, None))[1] or {}
            for entry in (self._track_plates.get(tracking_id, {}), self._browser_track_plates.get(tracking_id, {}), retirado):
                for placa, n in (entry.get("conteo") or {}).items():
                    total[placa] = max(total[placa], n)
            return total

    def _verificar_track(self, frame: np.ndarray, tid: int, bbox: list[int], es_moto: bool) -> dict:
        """
        Análisis de caracteres del track (a lo sumo cada _INTERVALO_ANALISIS_S). Devuelve el
        registro con el mejor análisis, el cuadrilátero relativo a la caja y si ya se
        comprobó que la región es una placa (se mantiene una vez comprobado).
        """
        ahora = time.time()
        with self._overlays_lock:
            reg = self._analisis.get(tid)
        if reg is not None and ahora - reg["t"] < _INTERVALO_ANALISIS_S:
            return reg
        h, w = frame.shape[:2]
        x1, y1, x2, y2 = bbox
        bw, bh = max(1, x2 - x1), max(1, y2 - y1)
        recorte, origen = recorte_con_margen(frame, bbox)
        an = analizar_caracteres(recorte, min_caracteres=2 if es_moto else MIN_CARACTERES)
        quad = None if es_moto else cuadrilatero_placa(bbox, an, w, h, origen)
        mejor = reg["mejor"] if reg else None
        if mejor is None or (an.valida, an.caracteres, an.puntaje) > (mejor.valida, mejor.caracteres, mejor.puntaje):
            mejor = an
        quad_rel = [[(px - x1) / bw, (py - y1) / bh] for px, py in quad] if quad else (reg["quad_rel"] if reg else None)
        nuevo = {"t": ahora, "mejor": mejor, "quad_rel": quad_rel, "es_placa": bool((reg and reg["es_placa"]) or an.valida)}
        with self._overlays_lock:
            self._analisis[tid] = nuevo
        return nuevo

    def get_motion_info(self) -> tuple[Optional[list[int]], int, bool]:
        """
        Retorna (motion_bbox, motion_pct, vehicle_detected) detectado por MOG2.
        vehicle_detected=True SOLO si la zona de movimiento se superpone con una
        detección YOLO válida (placa de vehículo), eliminando falsos positivos por
        personas, sombras o cambios de iluminación.
        """
        return self._last_motion_bbox, self._last_motion_pct, self._last_motion_vehicle_detected

    @staticmethod
    def _is_vehicle_motion(
        motion_bbox: Optional[list[int]],
        det_boxes: list[list[float]],
        iou_threshold: float = 0.04,
    ) -> bool:
        """
        Valida si la zona de movimiento MOG2 contiene al menos una detección YOLO
        de placa/vehículo (IoU > iou_threshold). Umbral bajo (0.04) porque la placa
        puede estar en el borde de la zona de movimiento cuando el vehículo entra
        o sale del encuadre — no se requiere superposición total.
        """
        if not motion_bbox or not det_boxes:
            return False
        mx1, my1, mx2, my2 = motion_bbox
        for box in det_boxes:
            bx1, by1, bx2, by2 = box[0], box[1], box[2], box[3]
            ix1 = max(mx1, bx1)
            iy1 = max(my1, by1)
            ix2 = min(mx2, bx2)
            iy2 = min(my2, by2)
            inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
            if inter <= 0:
                continue
            area_motion = max(1.0, (mx2 - mx1) * (my2 - my1))
            area_box = max(1.0, (bx2 - bx1) * (by2 - by1))
            union = area_motion + area_box - inter
            if union > 0 and (inter / union) >= iou_threshold:
                return True
        return False

    def update_track_plate(
        self,
        tracking_id: int,
        plate: str,
        confidence: float = 0.0,
        status: str = "",
        quality: Optional[float] = None,
    ) -> None:
        """
        Registra una lectura OCR como un voto más del track (patrón "Plate Groups" de
        OpenALPR / motores LPR comerciales): en vez de sobrescribir con la última lectura,
        cada lectura válida suma su confianza a un contador por texto de placa. La placa
        reportada (self._track_plates[id]["plate"]) es la de mayor consenso ponderado, no
        la más reciente — esto corrige errores de un solo caracter y evita que el texto
        "parpadee" entre frames cuando el OCR se equivoca puntualmente.
        Las lecturas que no calzan con el formato oficial ANT Ecuador (ruido de OCR, texto
        parcial, falsos positivos) no se cuentan como voto, pero sí actualizan el estado
        (alerta/autorizado) y el timestamp de "visto por última vez".
        `quality` es opcional (varianza del Laplaciano del recorte usado para OCR, ver
        TrackedPlateROI.quality); si se provee y el recorte estaba demasiado borroso
        (< _MIN_SHARPNESS_VARIANCE), la lectura no se cuenta como voto — evita que un
        frame con desenfoque de movimiento corrompa el consenso de placa del track.
        """
        clean_plate = normalize_plate_text(plate) if plate else ""
        is_sharp_enough = quality is None or quality >= _MIN_SHARPNESS_VARIANCE
        with self._overlays_lock:
            entry = self._track_plates.get(tracking_id)
            if entry is None:
                entry = {"plate": "", "confidence": 0.0, "status": status.lower(), "time": time.time(), "votes": Counter()}
                self._track_plates[tracking_id] = entry

            self._fijar_estado(entry, status)
            entry["time"] = time.time()

            if clean_plate and is_valid_ecuador_plate(clean_plate) and is_sharp_enough:
                votes: Counter = entry.setdefault("votes", Counter())
                votes[clean_plate] += max(0.05, confidence)
                entry.setdefault("conteo", Counter())[clean_plate] += 1

                # Ventana de consenso acotada: si un track lleva mucho tiempo vivo, se
                # reduce el peso de votos antiguos a la mitad en vez de descartarlos de
                # golpe, para que una placa mal leída al inicio no quede "congelada" como
                # ganadora permanente si luego llegan lecturas correctas y consistentes.
                if sum(votes.values()) > 6.0:
                    for k in list(votes.keys()):
                        votes[k] *= 0.5
                        if votes[k] < 0.02:
                            del votes[k]

                best_plate, best_score = votes.most_common(1)[0]
                entry["plate"] = best_plate
                entry["confidence"] = min(0.99, best_score / max(1.0, sum(votes.values())) * 0.85 + 0.15)
                entry["lecturas"] = entry["conteo"].get(best_plate, 0)
            elif not entry.get("plate"):
                # Sin voto válido todavía: mantener la mejor estimación cruda disponible
                # (por ejemplo mientras el OCR aún no da una lectura completa) sin que
                # cuente como consenso definitivo.
                entry["plate"] = clean_plate
                entry["confidence"] = confidence

    @staticmethod
    def _fijar_estado(entry: dict, status: str) -> None:
        """Actualiza el estado del track sin que una lectura OCR pise la decisión del backend."""
        nuevo = (status or "").lower()
        if nuevo and (nuevo in _ESTADOS_FINALES or entry.get("status") not in _ESTADOS_FINALES):
            entry["status"] = nuevo

    def fijar_estado_backend(self, tracking_id: int, estado: str) -> None:
        """Estado decidido por el backend (autorizado, alerta, ...) para colorear la caja del track."""
        with self._overlays_lock:
            for tabla in (self._track_plates, self._browser_track_plates):
                if tracking_id in tabla:
                    self._fijar_estado(tabla[tracking_id], estado)

    def track_eval_info(self, tracking_id: int) -> tuple[Optional[float], Optional[float]]:
        """(hora de nacimiento del track, rapidez en píxeles/s) para los metadatos de evaluación."""
        born = KalmanBoxTracker.birth_times.get(tracking_id)
        speed = None
        for trk in list(self._trackers) + list(self._browser_trackers):
            if trk.id == tracking_id:
                vx, vy = float(trk.kf.statePost[4, 0]), float(trk.kf.statePost[5, 0])
                speed = round(((vx * vx + vy * vy) ** 0.5) * 30.0, 1)  # px/frame -> px/s a 30 FPS nominales
                break
        return born, speed

    def get_track_info(self, tracking_id: int) -> dict:
        """Obtiene la información de matrícula (por consenso) y estado asociada a un track RTSP."""
        with self._overlays_lock:
            entry = self._track_plates.get(tracking_id, {})
            return {k: v for k, v in entry.items() if k not in ("votes", "conteo")}

    def update_browser_track_plate(
        self,
        tracking_id: int,
        plate: str,
        confidence: float = 0.0,
        status: str = "",
        quality: Optional[float] = None,
    ) -> None:
        """
        Registra una lectura OCR en el namespace EXCLUSIVO del navegador.
        Idéntico al patrón "Plate Groups" de update_track_plate pero escribe en
        _browser_track_plates, garantizando cero contaminación cruzada con el
        loop RTSP incluso cuando los IDs de KalmanBoxTracker colisionan entre
        los dos pools de trackers.
        """
        clean_plate = normalize_plate_text(plate) if plate else ""
        is_sharp_enough = quality is None or quality >= _MIN_SHARPNESS_VARIANCE
        with self._overlays_lock:
            entry = self._browser_track_plates.get(tracking_id)
            if entry is None:
                entry = {"plate": "", "confidence": 0.0, "status": status.lower(), "time": time.time(), "votes": Counter()}
                self._browser_track_plates[tracking_id] = entry
            self._fijar_estado(entry, status)
            entry["time"] = time.time()
            if clean_plate and is_valid_ecuador_plate(clean_plate) and is_sharp_enough:
                votes: Counter = entry.setdefault("votes", Counter())
                votes[clean_plate] += max(0.05, confidence)
                entry.setdefault("conteo", Counter())[clean_plate] += 1
                if sum(votes.values()) > 6.0:
                    for k in list(votes.keys()):
                        votes[k] *= 0.5
                        if votes[k] < 0.02:
                            del votes[k]
                best_plate, best_score = votes.most_common(1)[0]
                entry["plate"] = best_plate
                entry["confidence"] = min(0.99, best_score / max(1.0, sum(votes.values())) * 0.85 + 0.15)
                entry["lecturas"] = entry["conteo"].get(best_plate, 0)
            elif not entry.get("plate"):
                entry["plate"] = clean_plate
                entry["confidence"] = confidence

    def get_browser_track_info(self, tracking_id: int) -> dict:
        """Obtiene la info de placa exclusiva del flujo WebSocket del navegador."""
        with self._overlays_lock:
            entry = self._browser_track_plates.get(tracking_id, {})
            return {k: v for k, v in entry.items() if k not in ("votes", "conteo")}

    def clear_all_tracks(self) -> None:
        """Limpia completamente la memoria de seguimiento, consenso de placas y overlays visuales."""
        with self._trackers_lock:
            self._trackers.clear()
        with self._browser_lock:
            self._browser_trackers.clear()
        with self._overlays_lock:
            self._track_plates.clear()
            self._browser_track_plates.clear()
            self._current_overlays.clear()
            self._analisis.clear()
            self._retirados.clear()
        logger.info("Pipeline ANPR: Memoria de tracking y overlays reiniciada por completo.")

    def detect_fast(self, frame: np.ndarray) -> list[TrackedPlateROI]:
        """
        Detección ultra-rápida y directa para frames del navegador.
        - Umbral de confianza tomado de PLATE_CONFIDENCE_THRESHOLD (.env).
        - Filtro geométrico amplio para permitir placas inclinadas y de cerca (0.55 <= AR <= 6.5).
        - Mantiene la identidad del tracker estable mediante asociación por distancia adaptativa e IoU.
        - Retorna las matrículas detectadas en el fotograma actual.
        """
        orig_h, orig_w = frame.shape[:2]

        # OpenALPR Motion Detection (MOG2) para Zonas de Interés
        # NOTA: La zona de movimiento se valida DESPUÉS de la inferencia YOLO
        # para que solo se active cuando hay una detección de placa/vehículo real.
        _raw_motion_bbox: Optional[list[int]] = None
        try:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            fg_mask = self._bg_subtractor.apply(gray)
            _, fg_thresh = cv2.threshold(fg_mask, 128, 255, cv2.THRESH_BINARY)
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
            fg_clean = cv2.morphologyEx(fg_thresh, cv2.MORPH_OPEN, kernel)
            fg_clean = cv2.dilate(fg_clean, kernel, iterations=2)
            motion_pixels = cv2.countNonZero(fg_clean)
            self._last_motion_pct = int(min(100, (motion_pixels / float(orig_w * orig_h)) * 100 * 6))
            contours, _ = cv2.findContours(fg_clean, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if contours:
                valid_cnts = [c for c in contours if cv2.contourArea(c) > 1200]
                if valid_cnts:
                    all_pts = np.vstack(valid_cnts)
                    mx, my, mw, mh = cv2.boundingRect(all_pts)
                    mx = max(0, mx - int(mw * 0.10))
                    my = max(0, my - int(mh * 0.10))
                    mw = min(orig_w - mx, int(mw * 1.20))
                    mh = min(orig_h - my, int(mh * 1.20))
                    _raw_motion_bbox = [mx, my, mx + mw, my + mh]
        except Exception:
            self._last_motion_bbox = None
            self._last_motion_pct = 0

        conf_thresh, _ = byte_track_thresholds()
        det_boxes: list[list[float]] = []
        det_confs: list[float] = []

        try:
            raw_detections = self.browser_detector.predict(frame)
            raw_all = []
            raw_all_c = []
            for d in raw_detections:
                box = d.bbox
                conf = d.confidence
                bw = box[2] - box[0]
                bh = box[3] - box[1]
                ar = bw / max(1.0, float(bh))
                # Filtro geométrico permisivo para placas cerca, lejos e inclinadas:
                if (0.55 <= ar <= 6.5) and bw >= 12 and bh >= 6 and conf >= conf_thresh:
                    raw_all.append([float(b) for b in box])
                    raw_all_c.append(float(conf))

            if raw_all:
                nms_boxes = [[int(b[0]), int(b[1]), int(b[2] - b[0]), int(b[3] - b[1])] for b in raw_all]
                indices = cv2.dnn.NMSBoxes(nms_boxes, raw_all_c, score_threshold=conf_thresh, nms_threshold=0.35)
                if len(indices) > 0:
                    cand_boxes = [raw_all[idx] for idx in np.array(indices).flatten()]
                    cand_confs = [raw_all_c[idx] for idx in np.array(indices).flatten()]

                    # Supresión de sub-cajas (OpenALPR): si una caja está contenida en otra mayor
                    # (ej. grupo interno de letras vs placa completa), se conserva la placa externa completa.
                    areas = [(b[2] - b[0]) * (b[3] - b[1]) for b in cand_boxes]
                    order = sorted(range(len(cand_boxes)), key=lambda i: areas[i], reverse=True)
                    keep = []
                    for i in order:
                        bi = cand_boxes[i]
                        ai = areas[i]
                        is_sub = False
                        for k in keep:
                            bk = cand_boxes[k]
                            ak = areas[k]
                            x1 = max(bi[0], bk[0])
                            y1 = max(bi[1], bk[1])
                            x2 = min(bi[2], bk[2])
                            y2 = min(bi[3], bk[3])
                            inter = max(0, x2 - x1) * max(0, y2 - y1)
                            min_a = min(ai, ak)
                            if min_a > 0 and (inter / min_a) > 0.60:
                                is_sub = True
                                break
                        if not is_sub:
                            keep.append(i)

                    for i in keep:
                        det_boxes.append(cand_boxes[i])
                        det_confs.append(cand_confs[i])
        except Exception as e:
            logger.debug("Error en detect_fast: %s", e)

        # Validación inteligente de movimiento: solo activar si hay un vehículo/placa
        # dentro de la zona de movimiento MOG2. Elimina falsos positivos por personas,
        # sombras, cambios de luz o cualquier objeto que no sea un auto.
        if _raw_motion_bbox is not None:
            vehicle_in_motion = self._is_vehicle_motion(_raw_motion_bbox, det_boxes)
            self._last_motion_bbox = _raw_motion_bbox if vehicle_in_motion else None
            self._last_motion_vehicle_detected = vehicle_in_motion
        else:
            self._last_motion_bbox = None
            self._last_motion_vehicle_detected = False

        # Si no hay detecciones en este cuadro, avanzar Kalman y no destruir los tracks de golpe
        if not det_boxes:
            with self._browser_lock:
                surviving = []
                rois_lost = []
                for trk in self._browser_trackers:
                    trk.predict()
                    if trk.time_since_update <= 2:
                        surviving.append(trk)
                        if trk.hits >= 1:
                            st = trk.get_state()
                            bx1 = max(0, min(orig_w - 5, int(st[0])))
                            by1 = max(0, min(orig_h - 5, int(st[1])))
                            bx2 = max(bx1 + 5, min(orig_w, int(st[2])))
                            by2 = max(by1 + 5, min(orig_h, int(st[3])))
                            rois_lost.append(TrackedPlateROI(
                                tracking_id=trk.id,
                                plate_bbox=[bx1, by1, bx2, by2],
                                vehicle_bbox=[0, 0, orig_w, orig_h],
                                confidence=round(trk.confidence, 3),
                                velocity=[float(trk.kf.statePost[4, 0]), float(trk.kf.statePost[5, 0])],
                                quality=0.0,
                                oriented_box=[[bx1, by1], [bx2, by1], [bx2, by2], [bx1, by2]],
                            ))
                self._browser_trackers = surviving
            return rois_lost

        # Asociación ligera con tracking ID estable y predicción Kalman
        tracked_rois: list[TrackedPlateROI] = []
        with self._browser_lock:
            # 1. Avanzar estado temporal de Kalman para todos los trackers activos
            for trk in self._browser_trackers:
                trk.predict()

            new_trackers: list[KalmanBoxTracker] = []
            matched_tracker_ids = set()

            for d_idx, (box, conf) in enumerate(zip(det_boxes, det_confs)):
                bx1 = max(0, min(orig_w - 5, int(box[0])))
                by1 = max(0, min(orig_h - 5, int(box[1])))
                bx2 = max(bx1 + 5, min(orig_w, int(box[2])))
                by2 = max(by1 + 5, min(orig_h, int(box[3])))
                bw = float(bx2 - bx1)
                bh = float(by2 - by1)

                cx = (bx1 + bx2) / 2.0
                cy = (by1 + by2) / 2.0
                max_match_dist = max(140.0, max(bw, bh) * 1.4)

                best_trk = None
                best_dist = float("inf")

                for trk in self._browser_trackers:
                    if trk.id in matched_tracker_ids:
                        continue
                    st = trk.get_state()
                    tcx = (st[0] + st[2]) / 2.0
                    tcy = (st[1] + st[3]) / 2.0
                    dist = float(np.hypot(cx - tcx, cy - tcy))
                    if dist < max_match_dist and dist < best_dist:
                        best_dist = dist
                        best_trk = trk

                if best_trk is not None:
                    best_trk.update([bx1, by1, bx2, by2], conf)
                    new_trackers.append(best_trk)
                    matched_tracker_ids.add(best_trk.id)
                    tid = best_trk.id
                    vx = float(best_trk.kf.statePost[4, 0])
                    vy = float(best_trk.kf.statePost[5, 0])
                else:
                    new_trk = KalmanBoxTracker([bx1, by1, bx2, by2], conf)
                    new_trackers.append(new_trk)
                    matched_tracker_ids.add(new_trk.id)
                    tid = new_trk.id
                    vx = 0.0
                    vy = 0.0

                # 4 vértices orientados estilo Rekor Scout / OpenALPR plate_points
                oriented_box = [[bx1, by1], [bx2, by1], [bx2, by2], [bx1, by2]]
                plate_crop = frame[by1:by2, bx1:bx2]
                if plate_crop.size > 0:
                    try:
                        c_gray = cv2.cvtColor(plate_crop, cv2.COLOR_BGR2GRAY)
                        edges = cv2.Canny(c_gray, 40, 140)
                        kernel_c = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
                        edges_dil = cv2.dilate(edges, kernel_c, iterations=1)
                        c_cnts, _ = cv2.findContours(edges_dil, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                        if not c_cnts:
                            _, c_thresh = cv2.threshold(c_gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
                            c_cnts, _ = cv2.findContours(c_thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                        if c_cnts:
                            c_largest = max(c_cnts, key=cv2.contourArea)
                            if cv2.contourArea(c_largest) > 0.15 * (bw * bh):
                                rect = cv2.minAreaRect(c_largest)
                                box_pts = cv2.boxPoints(rect)
                                box_pts[:, 0] += bx1
                                box_pts[:, 1] += by1
                                oriented_box = [[int(pt[0]), int(pt[1])] for pt in box_pts]
                    except Exception:
                        pass

                sharpness = compute_crop_sharpness(plate_crop)
                tracked_rois.append(TrackedPlateROI(
                    tracking_id=tid,
                    plate_bbox=[bx1, by1, bx2, by2],
                    vehicle_bbox=[0, 0, orig_w, orig_h],
                    confidence=round(conf, 3),
                    velocity=[vx, vy],
                    quality=round(sharpness, 1),
                    oriented_box=oriented_box,
                ))

            # Mantener en memoria trackers previos con poca edad que no fueron emparejados en este frame
            for trk in self._browser_trackers:
                if trk.id not in matched_tracker_ids:
                    trk.time_since_update += 1
                    if trk.time_since_update <= 2:
                        new_trackers.append(trk)
                        if trk.hits >= 1:
                            st = trk.get_state()
                            bx1 = max(0, min(orig_w - 5, int(st[0])))
                            by1 = max(0, min(orig_h - 5, int(st[1])))
                            bx2 = max(bx1 + 5, min(orig_w, int(st[2])))
                            by2 = max(by1 + 5, min(orig_h, int(st[3])))
                            tracked_rois.append(TrackedPlateROI(
                                tracking_id=trk.id,
                                plate_bbox=[bx1, by1, bx2, by2],
                                vehicle_bbox=[0, 0, orig_w, orig_h],
                                confidence=round(trk.confidence, 3),
                                velocity=[float(trk.kf.statePost[4, 0]), float(trk.kf.statePost[5, 0])],
                                quality=0.0,
                                oriented_box=[[bx1, by1], [bx2, by1], [bx2, by2], [bx1, by2]],
                            ))

            self._browser_trackers = new_trackers

        return tracked_rois

    def detect_and_track(self, frame: np.ndarray, imgsz: int = 512) -> list[TrackedPlateROI]:
        """
        Ejecuta detección liviana y seguimiento científico ByteTrack en dos fases.
        Optimizado para rangos largos (> 2m hasta 15m).
        Args:
            frame:  Fotograma BGR de entrada.
            imgsz:  Resolución de inferencia YOLO (512 para alta precisión y 130ms de inferencia).
        """

        t0 = time.perf_counter()
        orig_h, orig_w = frame.shape[:2]

        # OpenALPR Motion Detection (MOG2) para Zonas de Interés Dinámicas
        # La validación contra YOLO se aplica DESPUÉS de la inferencia para filtrar
        # movimiento que no corresponde a vehículos (personas, sombras, etc.).
        _raw_motion_bbox_rtsp: Optional[list[int]] = None
        try:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            fg_mask = self._bg_subtractor.apply(gray)
            _, fg_thresh = cv2.threshold(fg_mask, 128, 255, cv2.THRESH_BINARY)
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
            fg_clean = cv2.morphologyEx(fg_thresh, cv2.MORPH_OPEN, kernel)
            fg_clean = cv2.dilate(fg_clean, kernel, iterations=2)
            motion_pixels = cv2.countNonZero(fg_clean)
            self._last_motion_pct = int(min(100, (motion_pixels / float(orig_w * orig_h)) * 100 * 6))
            contours, _ = cv2.findContours(fg_clean, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if contours:
                valid_cnts = [c for c in contours if cv2.contourArea(c) > 1200]
                if valid_cnts:
                    all_pts = np.vstack(valid_cnts)
                    mx, my, mw, mh = cv2.boundingRect(all_pts)
                    mx = max(0, mx - int(mw * 0.10))
                    my = max(0, my - int(mh * 0.10))
                    mw = min(orig_w - mx, int(mw * 1.20))
                    mh = min(orig_h - my, int(mh * 1.20))
                    _raw_motion_bbox_rtsp = [mx, my, mx + mw, my + mh]
        except Exception:
            pass

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

        # 2. Inferencia YOLO de Alta Precisión (@ 640px nativo)
        det_high_boxes: list[list[float]] = []
        det_high_conf: list[float] = []
        det_low_boxes: list[list[float]] = []
        det_low_conf: list[float] = []

        all_raw_boxes: list[list[float]] = []
        all_raw_confs: list[float] = []

        conf_thresh, raw_pred_thresh = byte_track_thresholds()
        roi_px = self._roi_px(orig_w, orig_h)
        try:
            raw_detections = self.detector.predict(frame)
            for d in raw_detections:
                box = d.bbox
                conf = d.confidence
                bw = box[2] - box[0]
                bh = box[3] - box[1]
                ar = bw / max(1.0, float(bh))
                # Región de interés: se descartan las placas cuyo centro queda fuera
                if not punto_en_roi((box[0] + box[2]) / 2, (box[1] + box[3]) / 2, roi_px):
                    continue
                if (0.55 <= ar <= 6.5) and bw >= 10 and bh >= 5:
                    all_raw_boxes.append([float(box[0]), float(box[1]), float(box[2]), float(box[3])])
                    all_raw_confs.append(float(conf))

            # Non-Maximum Suppression (NMS) + Supresión por Contención (OpenALPR style)
            if len(all_raw_boxes) > 0:
                nms_boxes = [[int(b[0]), int(b[1]), int(b[2] - b[0]), int(b[3] - b[1])] for b in all_raw_boxes]
                indices = cv2.dnn.NMSBoxes(nms_boxes, all_raw_confs, score_threshold=raw_pred_thresh, nms_threshold=0.35)
                if len(indices) > 0:
                    cand_boxes = [all_raw_boxes[idx] for idx in np.array(indices).flatten()]
                    cand_confs = [all_raw_confs[idx] for idx in np.array(indices).flatten()]

                    # Supresión de sub-cajas por contención (elimina recortes parciales de letras internas)
                    areas = [(b[2] - b[0]) * (b[3] - b[1]) for b in cand_boxes]
                    order = sorted(range(len(cand_boxes)), key=lambda i: areas[i], reverse=True)
                    keep = []
                    for i in order:
                        bi = cand_boxes[i]
                        ai = areas[i]
                        is_sub = False
                        for k in keep:
                            bk = cand_boxes[k]
                            ak = areas[k]
                            x1 = max(bi[0], bk[0])
                            y1 = max(bi[1], bk[1])
                            x2 = min(bi[2], bk[2])
                            y2 = min(bi[3], bk[3])
                            inter = max(0, x2 - x1) * max(0, y2 - y1)
                            min_a = min(ai, ak)
                            if min_a > 0 and (inter / min_a) > 0.60:
                                is_sub = True
                                break
                        if not is_sub:
                            keep.append(i)

                    for idx in keep:
                        b = cand_boxes[idx]
                        c = cand_confs[idx]
                        if c >= conf_thresh:
                            det_high_boxes.append(b)
                            det_high_conf.append(c)
                        else:
                            det_low_boxes.append(b)
                            det_low_conf.append(c)
        except Exception as e:
            logger.error("Error en inferencia de matrículas: %s", e)

        # Validación inteligente de movimiento para stream RTSP: activar zona de movimiento
        # SOLO cuando hay una detección YOLO de placa/vehículo en esa zona.
        _all_det_boxes_rtsp = det_high_boxes + det_low_boxes
        if _raw_motion_bbox_rtsp is not None:
            _vehicle_in_motion_rtsp = self._is_vehicle_motion(_raw_motion_bbox_rtsp, _all_det_boxes_rtsp)
            self._last_motion_bbox = _raw_motion_bbox_rtsp if _vehicle_in_motion_rtsp else None
            self._last_motion_vehicle_detected = _vehicle_in_motion_rtsp
        else:
            self._last_motion_bbox = None
            self._last_motion_vehicle_detected = False

        # 3. Asociación ByteTrack FASE 1: Detecciones con DIoU (tolerante a movimiento rápido).
        # Umbral -0.25: ahora que compute_diou_matrix descarta por escala inconsistente
        # (ver compuerta de área), no hace falta relajar más este valor — así se evita
        # que un track se "pegue" a un objeto distinto que solo coincide en posición.
        matched, unmatched_dets, unmatched_trks = associate_detections_to_trackers(
            det_high_boxes, predicted_boxes, diou_threshold=-0.25
        )

        for d_idx, t_idx in matched:
            self._trackers[t_idx].update(det_high_boxes[d_idx], det_high_conf[d_idx])

        # 4. Asociación ByteTrack FASE 2: Detecciones de Baja Confianza.
        # Umbral -0.35 (valor original): la compuerta de escala en compute_diou_matrix
        # ya protege contra emparejamientos con objetos de tamaño incompatible.
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
            with self._overlays_lock:
                # La captura del vehículo que sale de cuadro se confirma después de que su
                # track muere: se conservan sus evidencias unos segundos para esa decisión.
                self._retirados[t_id] = (time.time(), self._track_plates.pop(t_id, None), self._analisis.pop(t_id, None))
                for k in [k for k, v in self._retirados.items() if time.time() - v[0] > 20.0]:
                    del self._retirados[k]

        # 7. Construcción de ROIs y Overlays Visuales Tácticos (Respuesta Inmediata al Movimiento)
        tracked_rois: list[TrackedPlateROI] = []
        new_overlays: list[VisualOverlayBox] = []

        for trk in self._trackers:
            # Seguimiento inteligente ITS profesional: usar predicción Kalman cuando no hay detección reciente
            # Permitir hasta 4 frames de predicción (~130ms a 30 FPS) para seguimiento fluido sin parpadeos
            if (trk.hits >= 1 and trk.confidence >= raw_pred_thresh) and trk.time_since_update <= 4:
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

                # Rango de Operación Inteligente Extendido (hasta 15.0 metros)
                in_sweet_spot = (0.5 <= dist_m <= 15.0) or (pw >= 16)

                # Extraer velocidad del centro en píxeles/frame desde el vector de estado Kalman
                # Estado: [cx, cy, s, r, v_cx, v_cy, v_s]
                # Multiplicar por FPS nominal (30) para obtener píxeles/segundo
                _FPS = 30.0
                vx_px_s = float(trk.kf.statePost[4, 0]) * _FPS
                vy_px_s = float(trk.kf.statePost[5, 0]) * _FPS

                # 7.2. Verificación estilo OpenALPR: ¿la región contiene la fila de caracteres
                # de una placa? El cuadrilátero se ajusta a esa fila y a su inclinación, en vez
                # de al contorno más grande del recorte (que suele ser el parachoques).
                verif = self._verificar_track(frame, trk.id, [x1, y1, x2, y2], is_moto)
                oriented_box = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
                if verif["quad_rel"]:
                    oriented_box = [
                        [int(max(0, min(orig_w - 1, x1 + rx * pw))), int(max(0, min(orig_h - 1, y1 + ry * ph)))]
                        for rx, ry in verif["quad_rel"]
                    ]
                plate_crop = frame[y1:y2, x1:x2]
                sharpness = compute_crop_sharpness(plate_crop)

                roi = TrackedPlateROI(
                    tracking_id=trk.id,
                    plate_bbox=[x1, y1, x2, y2],
                    vehicle_bbox=[0, 0, orig_w, orig_h],
                    confidence=trk.confidence,
                    trajectory=list(trk.trajectory),
                    velocity=[round(vx_px_s, 2), round(vy_px_s, 2)],
                    quality=round(sharpness, 1),
                    oriented_box=oriented_box,
                )
                tracked_rois.append(roi)

                # 7.3. Cada pista se dibuja desde el primer cuadro: la caja sigue a la placa en
                # movimiento mientras el OCR la lee. Sin lectura muestra "ESCANEANDO OCR" (o el
                # texto parcial) con la confianza del detector; con lectura ANT, la placa por
                # consenso; con la decisión del backend, su estado. Qué se registra lo sigue
                # decidiendo la verificación en dos fases, no este dibujo.
                lecturas = int(plate_info.get("lecturas", 0)) if plate_info else 0
                texto_ocr = plate_info.get("plate", "") if plate_info else ""
                placa = texto_ocr if lecturas >= 1 else ""
                parcial = "" if placa else texto_ocr[:8]
                confianza_placa = float(plate_info.get("confidence", 0.0)) if placa else 0.0
                estado = plate_info.get("status", "") if plate_info else ""
                if estado in _COLOR_ESTADO:
                    box_color = _COLOR_ESTADO[estado]
                    box_label = f"{placa_con_guion(placa)}  {_TEXTO_ESTADO[estado]}" if placa else _TEXTO_ESTADO[estado]
                elif placa:
                    box_color = _COLOR_LEIDA
                    box_label = f"{placa_con_guion(placa)}  {int(confianza_placa * 100)}%"
                else:
                    box_color = _COLOR_ESCANEANDO
                    box_label = f"{parcial or 'ESCANEANDO OCR'}...  {int(trk.confidence * 100)}%"

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
                    oriented_box=oriented_box,
                    placa=placa,
                    estado=estado,
                    parcial=parcial,
                    confianza=float(trk.confidence),
                    confianza_placa=confianza_placa,
                    velocidad=(round(vx_px_s, 2), round(vy_px_s, 2)),
                    verificada=bool(verif["es_placa"] or lecturas >= 2),
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
        Dibuja el bounding box en formato industrial Rekor Scout / OpenALPR:
        - Zona de movimiento MOG2 en verde translúcido
        - Caja orientada de 4 vértices para inclinación de placa
        - Badge Glassmorphism oscuro con borde de estado y texto en alta legibilidad
        NUNCA muta el fotograma original en memoria (usa frame.copy()).
        """
        out_frame = frame.copy()
        h, w = out_frame.shape[:2]

        # 0. Zona de Movimiento MOG2 translúcida — SOLO si hay un vehículo/placa
        # detectado por YOLO en esa zona (vehicle_detected=True). Elimina el cuadro
        # verde que aparecía con personas, sombras o cualquier movimiento que no sea un auto.
        if self._last_motion_bbox and self._last_motion_pct > 3 and self._last_motion_vehicle_detected:
            mx1, my1, mx2, my2 = self._last_motion_bbox
            overlay = out_frame.copy()
            cv2.rectangle(overlay, (mx1, my1), (mx2, my2), (40, 190, 70), -1)
            cv2.addWeighted(overlay, 0.18, out_frame, 0.82, 0, out_frame)
            cv2.rectangle(out_frame, (mx1, my1), (mx2, my2), (40, 200, 70), 1)
            # Etiqueta táctica con el porcentaje de movimiento de la zona
            cv2.putText(
                out_frame,
                f"VEHICULO - MOV {self._last_motion_pct}%",
                (mx1 + 4, my1 + 14),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.40,
                (60, 230, 80),
                1,
                cv2.LINE_AA,
            )

        # Región de interés: contorno discontinuo (fuera de ella no se buscan placas)
        roi_px = self._roi_px(w, h)
        if roi_px is not None:
            pts = roi_px.astype(np.int32)
            for i in range(len(pts)):
                a, b = pts[i], pts[(i + 1) % len(pts)]
                largo = max(1, int(np.hypot(*(b - a))))
                for t in range(0, largo, 18):
                    p1 = a + (b - a) * (t / largo)
                    p2 = a + (b - a) * (min(largo, t + 10) / largo)
                    cv2.line(out_frame, tuple(int(v) for v in p1), tuple(int(v) for v in p2), (235, 206, 135), 2, cv2.LINE_AA)

        with self._overlays_lock:
            overlays = list(self._current_overlays)

        for ov in overlays:
            x1, y1, x2, y2 = ov.x1, ov.y1, ov.x2, ov.y2
            color = ov.color

            # 1. Bounding Box orientado de 4 puntos si existe inclinación, o rectángulo
            if ov.oriented_box and len(ov.oriented_box) == 4:
                pts = np.int32(ov.oriented_box)
                cv2.polylines(out_frame, [pts], isClosed=True, color=color, thickness=2, lineType=cv2.LINE_AA)
            else:
                cv2.rectangle(out_frame, (x1, y1), (x2, y2), color, 2)

            # 2. Insignia flotante oscura con borde del color del track (solo con texto)
            if not ov.label:
                continue
            badge_text = f" {ov.label} "
            (tw, th), baseline = cv2.getTextSize(badge_text, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
            badge_x = max(10, min(w - tw - 10, x1))
            badge_y = max(th + 10, y1 - 8)

            cv2.rectangle(
                out_frame,
                (badge_x - 4, badge_y - th - 4),
                (badge_x + tw + 4, badge_y + baseline + 2),
                (25, 25, 25),
                -1,
            )
            cv2.rectangle(
                out_frame,
                (badge_x - 4, badge_y - th - 4),
                (badge_x + tw + 4, badge_y + baseline + 2),
                color,
                1,
            )
            cv2.putText(
                out_frame,
                badge_text,
                (badge_x, badge_y),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (255, 255, 255),
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


def create_detection_pipeline(
    detector: Optional[BaseDetector] = None,
    browser_detector: Optional[BaseDetector] = None,
) -> DetectionPipeline:
    """
    Factory unificada que resuelve la configuración del entorno y devuelve un
    DetectionPipeline listo para producción.
    
    Punto de acoplamiento único entre el entorno (variables de configuración,
    pesos de modelos, dispositivo GPU/CPU) y el pipeline desacoplado.
    Permite además inyectar detectores mock o personalizados para testing.
    """
    if detector is not None:
        return DetectionPipeline(detector=detector, browser_detector=browser_detector)

    from app.infraestructura.config import (
        DETECTOR_BACKEND,
        PLATE_DETECTOR_ARCH,
        PLATE_MODEL_PATH,
        PLATE_CONFIDENCE_THRESHOLD,
    )
    import torch

    device = "cuda" if torch.cuda.is_available() else "cpu"
    num_threads = min(4, max(2, (os.cpu_count() or 4) // 2))
    try:
        torch.set_num_threads(num_threads)
    except Exception:
        pass

    # Búsqueda robusta del modelo específico de placas (evitar fallback a modelo genérico COCO)
    core_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        PLATE_MODEL_PATH,
        os.path.join("services", "anpr", PLATE_MODEL_PATH),
        os.path.normpath(os.path.join(core_dir, "..", "..", PLATE_MODEL_PATH)),
        os.path.normpath(os.path.join(core_dir, "..", "..", "models", "license_plate_detector.pt")),
        os.path.join("/app", PLATE_MODEL_PATH),
        os.path.join("/app", "models", "license_plate_detector.pt"),
    ]
    model_path = next((p for p in candidates if p and os.path.exists(p)), None)
    if not model_path:
        # Sin respaldo a un modelo COCO genérico: no tiene la clase placa y "detectaría" vehículos,
        # personas, etc. como placas sin que nadie lo note.
        raise FileNotFoundError(
            f"No se encontró el detector de placas ({PLATE_MODEL_PATH}). "
            "Restaure models/license_plate_detector.pt (ver models/MODEL_CARD.md)."
        )
    logger.info("Modelo de placas detectado correctamente en: %s", model_path)

    _, raw_thresh = byte_track_thresholds()
    browser_conf = raw_thresh

    # Detector principal (loop RTSP @ 512px)
    # "yolo" cubre YOLOv8/YOLO11/YOLO26; "rfdetr" o "rfdetr-<variante>" usa RF-DETR
    model_type = "rfdetr-nano" if DETECTOR_BACKEND == "rfdetr" else DETECTOR_BACKEND
    rtsp_det = create_detector(
        model_path, model_type=model_type, confidence=raw_thresh, device=device, imgsz=512
    )
    rtsp_det.warmup()
    arquitectura = getattr(rtsp_det, "arquitectura", None)
    if arquitectura and arquitectura != PLATE_DETECTOR_ARCH:
        logger.error(
            "El detector de placas cargado es %s, pero se esperaba %s (PLATE_DETECTOR_ARCH). "
            "Revise PLATE_MODEL_PATH y models/MODEL_CARD.md.", arquitectura, PLATE_DETECTOR_ARCH,
        )

    # Detector browser (@ 512px para máxima agudeza visual a distancias largas)
    browser_det = rtsp_det if model_type.startswith("rfdetr") else create_detector(
        model_path, model_type=model_type, confidence=browser_conf, device=device, imgsz=512
    )
    browser_det.warmup()

    logger.info("Detectores YOLO creados [RTSP=512px / Browser=512px (Distancia)] en device=%s", device)
    return DetectionPipeline(detector=rtsp_det, browser_detector=browser_det)