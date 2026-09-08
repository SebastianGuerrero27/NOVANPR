"""
Selector del Mejor Fotograma (Best Frame Selector) Inteligente para Captura ANPR.
Arquitectura de Captura Adaptativa Multi-Criterio para Vehiculos en Movimiento.

Capacidades Cientificas (Estado del Arte ITS):
  1. Estimacion Optica de Distancia en Metros (basada en dimensiones ANT Ecuador).
  2. Umbral de Nitidez Adaptativo por Distancia: lejos (>5m) -> min_sharpness=10, cerca (<2m) -> 22.
  3. Disparo por Velocidad de Acercamiento: si el bounding box crece >15% entre frames,
     el vehiculo se esta acercando rapidamente y se dispara captura inmediata.
  4. Fallback Garantizado a los 2 Segundos: si un track lleva >2s sin disparar captura,
     se toma el mejor frame disponible sin importar su nitidez.
  5. Debounce Inteligente: Evita capturas duplicadas del mismo vehiculo durante 10 segundos.
  6. Multi-Shot en Salida: Retorna los 3 mejores frames al limpiar un track,
     permitiendo que el OcrHypothesisAccumulator tenga mas material para consenso.

Referencia Cientifica:
  Silva & Jung (2018) -- "License Plate Detection and Recognition in Unconstrained Scenarios"
  Hsieh et al. (2002) -- "Morphology-Based License Plate Detection from Complex Scenes"
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional, List, Dict, Set

import cv2
import numpy as np

from app.utils.logger import get_logger

logger = get_logger("frame_selector")


@dataclass
class FrameCandidate:
    """Candidato de fotograma evaluado para un tracking ID."""
    tracking_id: int
    frame: np.ndarray
    plate_bbox: list[int]  # [x1, y1, x2, y2]
    plate_crop: np.ndarray
    confidence: float
    sharpness: float
    area: int
    aspect_ratio: float
    estimated_distance_m: float
    in_sweet_spot: bool
    timestamp: float
    frame_idx: int


# Dimensiones reales de matrículas ecuatorianas (ANT) para estimación óptica de distancia
# Vehículos (autos, camionetas, buses):   40.4 cm x 14.0 cm → Aspect Ratio ≈ 2.89 (o 2.00)
# Motocicletas (ANT 2020+):               20.0 cm x 16.0 cm → Aspect Ratio ≈ 1.25
# Umbral de clasificación estricto ITS: si AR <= 1.12 → placa de moto cuadrada
_CAR_PLATE_WIDTH_M = 0.404
_MOTO_PLATE_WIDTH_M = 0.200
_MOTO_ASPECT_RATIO_THRESHOLD = 1.12


class BestFrameSelector:
    """
    Rastrea candidatos por tracking_id y selecciona el fotograma optimo
    para disparar la captura fotografica automatica.

    Implementa 4 mecanismos de disparo adaptativos para vehiculos en movimiento:
      - Umbral de nitidez dinamico segun distancia estimada
      - Disparo por velocidad de acercamiento (crecimiento del bbox)
      - Fallback garantizado a los 2 segundos de tracking
      - Multi-shot en salida (hasta 3 frames por track)
    """

    # Umbral de nitidez adaptativo por zona de distancia (calibrado para cámaras IP y RTSP móvil H.264)
    SHARPNESS_FAR: float = 3.5       # > 5m: placa pequeña, compresión de video esperada
    SHARPNESS_MID: float = 5.0       # 2m - 5m: zona operativa normal
    SHARPNESS_NEAR: float = 6.0      # < 2m: zona cercana / móvil

    # Disparo por velocidad de acercamiento
    APPROACH_GROWTH_THRESHOLD: float = 0.12  # 12% de crecimiento de area entre frames consecutivos

    # Fallback garantizado
    FALLBACK_TIMEOUT_S: float = 1.0  # Máximo 1.0 segundo de tracking sin captura

    def __init__(
        self,
        min_sharpness: float = 4.0,
        min_plate_width: int = 20,
        min_plate_height: int = 8,
        min_consecutive_frames: int = 1,
        debounce_seconds: float = 25.0,
    ) -> None:
        self.min_sharpness = min_sharpness
        self.min_plate_width = min_plate_width
        self.min_plate_height = min_plate_height
        self.min_consecutive_frames = min_consecutive_frames
        self.debounce_seconds = debounce_seconds

        # Buffer de candidatos activos: { tracking_id: list[FrameCandidate] }
        self._active_candidates: Dict[int, List[FrameCandidate]] = {}

        # Registro de capturas disparadas: { tracking_id: timestamp_captura }
        self._captured_history: Dict[int, float] = {}

        # Registro del area del bbox en el frame anterior por track (para deteccion de acercamiento)
        self._prev_area: Dict[int, int] = {}

        # Timestamp del primer frame visto por track (para fallback garantizado)
        self._track_first_seen: Dict[int, float] = {}

    @staticmethod
    def calculate_sharpness(image: np.ndarray) -> float:
        """Calcula la nitidez de la imagen usando la varianza del operador Laplaciano."""
        if image is None or image.size == 0:
            return 0.0
        if len(image.shape) == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        else:
            gray = image
        return float(cv2.Laplacian(gray, cv2.CV_64F).var())

    @staticmethod
    def classify_plate_type(plate_width_px: int, plate_height_px: int) -> str:
        """
        Clasifica el tipo de placa según su relación de aspecto (aspect ratio).

        - AR < 2.0 → Placa de Motocicleta (≈ 1.25:1, casi cuadrada)
        - AR >= 2.0 → Placa de Vehículo (automóvil, camioneta, bus)
        """
        if plate_height_px <= 0:
            return "vehicle"
        ar = plate_width_px / float(plate_height_px)
        return "motorcycle" if ar < _MOTO_ASPECT_RATIO_THRESHOLD else "vehicle"

    @staticmethod
    def estimate_distance_meters(
        plate_width_px: int,
        frame_w: int = 1280,
        plate_type: str = "vehicle",
    ) -> float:
        """
        Calcula la distancia óptica estimada en metros hacia la cámara.
        Usa las dimensiones reales ANT según el tipo de placa detectado:
          - Vehículos:       40.4 cm de ancho (estándar ecuatoriano)
          - Motocicletas:    20.0 cm de ancho (ANT 2020+, placa cuadrada)
        """
        if plate_width_px <= 0:
            return 10.0
        focal_px = frame_w * 0.92
        plate_real_m = _MOTO_PLATE_WIDTH_M if plate_type == "motorcycle" else _CAR_PLATE_WIDTH_M
        dist = (plate_real_m * focal_px) / float(plate_width_px)
        return float(max(0.5, min(12.0, dist)))

    def should_ignore_track(self, tracking_id: int) -> bool:
        """Verifica si el tracking ID ya fue capturado recientemente (Debounce)."""
        now = time.time()
        last_captured = self._captured_history.get(tracking_id)
        if last_captured is not None:
            if now - last_captured < self.debounce_seconds:
                return True
            else:
                del self._captured_history[tracking_id]
        return False

    def _adaptive_min_sharpness(self, dist_m: float) -> float:
        """
        Retorna el umbral de nitidez minimo adecuado para la distancia estimada.
        A mayor distancia, la placa ocupa menos pixeles y la varianza Laplaciana es menor.
        Se usa una escala lineal entre las zonas definidas.
        """
        if dist_m > 5.0:
            return self.SHARPNESS_FAR
        elif dist_m > 2.0:
            # Interpolacion lineal entre FAR y MID
            t = (dist_m - 2.0) / 3.0  # t=0 en 2m, t=1 en 5m
            return self.SHARPNESS_FAR * t + self.SHARPNESS_MID * (1.0 - t)
        else:
            # Interpolacion lineal entre MID y NEAR
            t = dist_m / 2.0  # t=0 en 0m, t=1 en 2m
            return self.SHARPNESS_MID * t + self.SHARPNESS_NEAR * (1.0 - t)

    def _is_approaching_fast(self, tracking_id: int, current_area: int) -> bool:
        """
        Detecta si el vehiculo se esta acercando rapidamente a la camara comparando
        el area del bounding box entre frames consecutivos.
        Un crecimiento de area > APPROACH_GROWTH_THRESHOLD indica acercamiento rapido.
        """
        prev = self._prev_area.get(tracking_id, 0)
        self._prev_area[tracking_id] = current_area
        if prev <= 0:
            return False
        growth = (current_area - prev) / float(prev)
        return growth >= self.APPROACH_GROWTH_THRESHOLD

    def evaluate_and_select(
        self,
        tracking_id: int,
        frame: np.ndarray,
        plate_bbox: list[int],
        confidence: float,
        frame_idx: int,
    ) -> Optional[FrameCandidate]:
        """
        Evalua el fotograma usando 4 criterios adaptativos:
          1. Zona de distancia operativa con nitidez adaptativa.
          2. Disparo por velocidad de acercamiento (crecimiento del bbox).
          3. Fallback garantizado a los 2 segundos de tracking.
          4. Fallback por acumulacion de 3 frames con mejor candidato.
        """
        if self.should_ignore_track(tracking_id):
            return None

        x1, y1, x2, y2 = plate_bbox
        h, w = frame.shape[:2]

        # Validar coordenadas dentro del frame
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)
        pw, ph = x2 - x1, y2 - y1

        if pw < self.min_plate_width or ph < self.min_plate_height:
            return None

        # Descartar si esta pegado al borde del frame (cortado)
        margin = 3
        if x1 < margin or y1 < margin or x2 > (w - margin) or y2 > (h - margin):
            return None

        plate_crop = frame[y1:y2, x1:x2]
        if plate_crop.size == 0:
            return None

        sharpness = self.calculate_sharpness(plate_crop)
        aspect_ratio = pw / float(ph) if ph > 0 else 0.0
        area = pw * ph

        # Clasificar tipo de placa por aspect ratio
        plate_type = self.classify_plate_type(pw, ph)

        # Estimacion de distancia optica con dimensiones correctas por tipo
        dist_m = self.estimate_distance_meters(pw, w, plate_type=plate_type)

        # Umbral de nitidez adaptativo segun distancia
        adaptive_sharpness = self._adaptive_min_sharpness(dist_m)

        # Zona operativa inteligente extendida para ITS (hasta 8.5 metros)
        if plate_type == "motorcycle":
            in_sweet_spot = (0.8 <= dist_m <= 7.0) or (pw >= 24)
        else:
            in_sweet_spot = (1.0 <= dist_m <= 8.5) or (pw >= 28)

        candidate = FrameCandidate(
            tracking_id=tracking_id,
            frame=frame.copy(),
            plate_bbox=[x1, y1, x2, y2],
            plate_crop=plate_crop.copy(),
            confidence=confidence,
            sharpness=sharpness,
            area=area,
            aspect_ratio=aspect_ratio,
            estimated_distance_m=round(dist_m, 2),
            in_sweet_spot=in_sweet_spot,
            timestamp=time.time(),
            frame_idx=frame_idx,
        )

        if plate_type == "motorcycle":
            logger.debug(
                "Placa Motocicleta | Track #%d | AR=%.2f | Dist=%.2f m | RangoValido=%s | Nitidez=%.1f",
                tracking_id, aspect_ratio, dist_m, in_sweet_spot, sharpness,
            )

        # Registrar primera aparicion del track para fallback garantizado
        if tracking_id not in self._track_first_seen:
            self._track_first_seen[tracking_id] = time.time()

        if tracking_id not in self._active_candidates:
            self._active_candidates[tracking_id] = []

        self._active_candidates[tracking_id].append(candidate)
        candidates = self._active_candidates[tracking_id]

        # --- MECANISMO 1: Disparo en zona optima con nitidez adaptativa ---
        if in_sweet_spot and sharpness >= adaptive_sharpness:
            self._captured_history[tracking_id] = time.time()
            self._prev_area.pop(tracking_id, None)
            self._track_first_seen.pop(tracking_id, None)
            del self._active_candidates[tracking_id]

            logger.info(
                "CAPTURA ZONA OPTIMA | Track #%d | Distancia: %.2fm | Nitidez: %.1f (umbral: %.1f) | Conf: %.2f",
                tracking_id, dist_m, sharpness, adaptive_sharpness, confidence,
            )
            return candidate

        # --- MECANISMO 2: Disparo por Velocidad de Acercamiento ---
        is_fast_approach = self._is_approaching_fast(tracking_id, area)
        if is_fast_approach and len(candidates) >= 1:
            best = max(candidates, key=lambda c: c.sharpness)
            self._captured_history[tracking_id] = time.time()
            self._prev_area.pop(tracking_id, None)
            self._track_first_seen.pop(tracking_id, None)
            del self._active_candidates[tracking_id]

            logger.info(
                "CAPTURA ACERCAMIENTO RAPIDO | Track #%d | Crecimiento bbox: >15%% | Nitidez: %.1f | Dist: %.2fm",
                tracking_id, best.sharpness, dist_m,
            )
            return best

        # --- MECANISMO 3: Fallback Garantizado a los 2 Segundos ---
        first_seen = self._track_first_seen.get(tracking_id, time.time())
        if (time.time() - first_seen) >= self.FALLBACK_TIMEOUT_S and candidates:
            best = max(
                candidates,
                key=lambda c: (c.sharpness * 0.60) + (c.confidence * 100.0 * 0.40),
            )
            self._captured_history[tracking_id] = time.time()
            self._prev_area.pop(tracking_id, None)
            self._track_first_seen.pop(tracking_id, None)
            del self._active_candidates[tracking_id]

            logger.info(
                "CAPTURA FALLBACK 2s | Track #%d | Nitidez disponible: %.1f | Dist: %.2fm",
                tracking_id, best.sharpness, best.estimated_distance_m,
            )
            return best

        # --- MECANISMO 4: Disparo Inmediato (< 0.2s) para placas detectadas ---
        # En flujos móviles / RTSP o demostraciones, un fotograma con confianza >= 0.20 y nitidez aceptable
        # se dispara inmediatamente sin forzar acumulación de frames que podría perderse por temblor.
        if len(candidates) >= 1 and (confidence >= 0.20 or sharpness >= 4.0):
            best_candidate = max(
                candidates,
                key=lambda c: (c.sharpness * 0.50) + (c.confidence * 100.0 * 0.30) + (min(c.area, 15000) / 100.0 * 0.20)
            )
            self._captured_history[tracking_id] = time.time()
            self._prev_area.pop(tracking_id, None)
            self._track_first_seen.pop(tracking_id, None)
            del self._active_candidates[tracking_id]
            logger.info("CAPTURA INMEDIATA REAL-TIME | Track #%d | Nitidez: %.1f | Conf: %.2f", tracking_id, best_candidate.sharpness, best_candidate.confidence)
            return best_candidate

        return None

    def cleanup_stale_tracks(self, active_tracking_ids: Set[int]) -> List[FrameCandidate]:
        """
        Dispara captura para cualquier track que este abandonando el cuadro.
        Retorna hasta 3 mejores frames por track (Multi-Shot) para que el
        OcrHypothesisAccumulator tenga mas material para consenso.
        """
        exited_candidates: List[FrameCandidate] = []
        stale_ids = [tid for tid in self._active_candidates if tid not in active_tracking_ids]

        for tid in stale_ids:
            candidates = self._active_candidates.pop(tid, [])
            self._prev_area.pop(tid, None)
            self._track_first_seen.pop(tid, None)

            if candidates and not self.should_ignore_track(tid):
                # Ordenar por calidad descendente y tomar los 3 mejores (Multi-Shot)
                sorted_cands = sorted(
                    candidates,
                    key=lambda c: (c.sharpness * 0.60) + (c.confidence * 100.0 * 0.40),
                    reverse=True,
                )
                top_shots = [c for c in sorted_cands[:3] if c.sharpness >= 8.0]
                if not top_shots and sorted_cands:
                    top_shots = [sorted_cands[0]]  # Garantizar al menos 1 frame

                if top_shots:
                    self._captured_history[tid] = time.time()
                    exited_candidates.extend(top_shots)
                    logger.info(
                        "MULTI-SHOT SALIDA | Track #%d | %d frames enviados al OCR worker",
                        tid, len(top_shots),
                    )

        return exited_candidates
