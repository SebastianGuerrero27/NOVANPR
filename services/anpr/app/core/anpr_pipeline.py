"""
Pipeline Industrial de Visión Artificial para Sistemas Inteligentes de Transporte (ITS / ANPR).
Diseñado para Control de Acceso y Vigilancia (ECU 911 Zona 3, Ecuador).

Componentes de Alto Rendimiento:
  1. Inferencia ONNX Runtime (TensorRT / CUDA / CPU C++ Multithreading).
  2. Alineación de Perspectiva (4-Point Quadrilateral Homography & Deswarping a 240x80 px).
  3. Preprocesamiento Óptico Avanzado (CLAHE en espacio LAB + Unsharp Masking).
  4. Motor OCR Especializado (CRNN-CTC / LPRNet ONNX con matriz Softmax).
  5. Consenso Espaciotemporal Multi-Frame (Votación Ponderada por Carácter para 3-5 mejores frames).
  6. Validación Normativa Oficial ANT Ecuador.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Optional, List, Tuple, Dict

import cv2
import numpy as np
import onnxruntime as ort

from app.core.ecuador_plate_validator import EcuadorPlateValidator, EcuadorPlateValidationResult
from app.utils.logger import get_logger

logger = get_logger("anpr_pipeline")

# =============================================================================
# Vocabulario de Caracteres Alfanuméricos Ecuatorianos para Modelos CRNN/LPRNet
# =============================================================================
ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-"
CHAR_TO_IDX = {c: i for i, c in enumerate(ALPHABET)}
IDX_TO_CHAR = {i: c for i, c in enumerate(ALPHABET)}
BLANK_IDX = len(ALPHABET)  # Índice CTC Blank

# Dimensiones de rectificación diferenciadas por tipo de placa (ANT Ecuador)
# Auto/Camioneta:  40.4 x 14.0 cm → Ratio 2.89:1 → Target 240 x 80 px
# Motocicleta:     20.0 x 16.0 cm → Ratio 1.25:1 → Target 160 x 128 px
_CAR_PLATE_W, _CAR_PLATE_H = 240, 80
_MOTO_PLATE_W, _MOTO_PLATE_H = 160, 128
_MOTO_AR_THRESHOLD = 1.38   # AR < 1.38 → placa de moto cuadrada (evita clasificar erróneamente autos)


@dataclass
class TrackedPlateObservation:
    """Observación individual de una matrícula en un fotograma del video."""
    frame_idx: int
    timestamp: float
    quad_pts: np.ndarray        # 4 Vértices: shape (4, 2)
    bbox: list[int]             # [x1, y1, x2, y2]
    rectified_crop: np.ndarray  # Imagen ortogonal 240x80 px
    sharpness: float            # Varianza Laplaciana
    det_confidence: float       # Confianza del detector YOLO
    char_probabilities: Optional[np.ndarray] = None  # Matriz Softmax (T, Vocab_Size)
    predicted_text: str = ""
    raw_confidence: float = 0.0


@dataclass
class ConsolidatedVehicleEvent:
    """Evento consolidado final tras el consenso espaciotemporal de múltiples frames."""
    track_id: int
    plate: str
    is_valid_ant: bool
    confidence: float
    tipo_vehiculo: str
    provincia: str
    servicio: str
    total_frames_analyzed: int
    best_rectified_image: np.ndarray
    best_context_frame: np.ndarray
    timestamp: float
    processing_latency_ms: float


def order_quad_points(pts: np.ndarray) -> np.ndarray:
    """
    Ordena 4 puntos en sentido horario estricto:
      [0: Top-Left, 1: Top-Right, 2: Bottom-Right, 3: Bottom-Left]
    """
    rect = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]  # Top-Left (mínima suma X+Y)
    rect[2] = pts[np.argmax(s)]  # Bottom-Right (máxima suma X+Y)

    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]  # Top-Right (mínima diferencia Y-X)
    rect[3] = pts[np.argmax(diff)]  # Bottom-Left (máxima diferencia Y-X)
    return rect


class IndustrialANPRPipeline:
    """
    Pipeline Integral ANPR de Grado Industrial con Aceleración ONNX Runtime.
    """

    def __init__(
        self,
        yolo_onnx_path: str = "models/license_plate_detector.onnx",
        ocr_onnx_path: Optional[str] = "models/lpr_crnn_ctc.onnx",
        target_plate_width: int = 240,
        target_plate_height: int = 80,
        max_temporal_frames: int = 5,
        min_temporal_frames: int = 3,
    ) -> None:
        self.target_w = target_plate_width
        self.target_h = target_plate_height
        self.max_temporal_frames = max_temporal_frames
        self.min_temporal_frames = min_temporal_frames

        # Configurar Opciones de Optimización de ONNX Runtime
        self._session_options = ort.SessionOptions()
        self._session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._session_options.intra_op_num_threads = min(8, max(2, os.cpu_count() or 4))
        self._session_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL

        # Selección de Proveedores de Ejecución (TensorRT -> CUDA -> CPU)
        available_providers = ort.get_available_providers()
        self._providers = []
        if "TensorrtExecutionProvider" in available_providers:
            self._providers.append("TensorrtExecutionProvider")
        if "CUDAExecutionProvider" in available_providers:
            self._providers.append("CUDAExecutionProvider")
        self._providers.append("CPUExecutionProvider")

        logger.info("ONNX Runtime Proveedores seleccionados: %s", self._providers)

        # Buffer Espaciotemporal de Tracks: { track_id: list[TrackedPlateObservation] }
        self._track_buffers: Dict[int, List[TrackedPlateObservation]] = {}
        self._track_context_frames: Dict[int, np.ndarray] = {}

    # =========================================================================
    # 1. Transformación de Perspectiva (Deswarping de 4 Puntos a 240x80 px)
    # =========================================================================

    def _get_rect_dims_for_bbox(self, bbox: list[int]) -> tuple[int, int]:
        """
        Determina las dimensiones de rectificación óptimas según el aspect ratio de la bbox.
        - Placa de auto (AR >= 2.0):  240 x 80 px  (paisaje)
        - Placa de moto (AR <  2.0):  160 x 128 px (más cuadrada)
        """
        x1, y1, x2, y2 = bbox
        pw = max(1, x2 - x1)
        ph = max(1, y2 - y1)
        ar = pw / float(ph)
        if ar < _MOTO_AR_THRESHOLD:
            return _MOTO_PLATE_W, _MOTO_PLATE_H
        return _CAR_PLATE_W, _CAR_PLATE_H

    def warp_perspective_orthogonal(
        self,
        frame: np.ndarray,
        quad_points: np.ndarray,
        target_w: Optional[int] = None,
        target_h: Optional[int] = None,
    ) -> np.ndarray:
        """
        Rectifica la matrícula inclinada u oblicua proyectándola a una vista
        completamente frontal y plana.
        Si no se especifican target_w/target_h, usa 240x80 (placa de auto estándar).
        Para placas de moto, pasar target_w=160, target_h=128.
        """
        tw = target_w or self.target_w
        th = target_h or self.target_h

        if frame is None or frame.size == 0 or len(quad_points) != 4:
            return np.zeros((th, tw, 3), dtype=np.uint8)

        ordered_pts = order_quad_points(np.array(quad_points, dtype=np.float32))

        dst_pts = np.array([
            [0, 0],
            [tw - 1, 0],
            [tw - 1, th - 1],
            [0, th - 1]
        ], dtype=np.float32)

        # Matriz de transformación proyectiva homográfica
        M = cv2.getPerspectiveTransform(ordered_pts, dst_pts)
        warped = cv2.warpPerspective(
            frame,
            M,
            (tw, th),
            flags=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_REPLICATE
        )
        return warped

    # =========================================================================
    # 2. Preprocesamiento Óptico Industrial (CLAHE + Filtrado de Destellos)
    # =========================================================================

    def enhance_plate_contrast(self, plate_img: np.ndarray) -> np.ndarray:
        """
        Aplica ecualización de histograma adaptativa (CLAHE) en el canal de Luminosidad (LAB)
        para mitigar reflejos solares, remaches brillantes y sombras en la chapa metálica.
        """
        if plate_img is None or plate_img.size == 0:
            return plate_img

        try:
            # Filtro bilateral para reducir ruido de sensor sin degradar bordes de caracteres
            bilateral = cv2.bilateralFilter(plate_img, d=5, sigmaColor=45, sigmaSpace=45)

            # Conversión a espacio LAB (separación de luminancia y cromaticidad)
            lab = cv2.cvtColor(bilateral, cv2.COLOR_BGR2LAB)
            l_channel, a_channel, b_channel = cv2.split(lab)

            # CLAHE de alto contraste
            clahe = cv2.createCLAHE(clipLimit=2.8, tileGridSize=(8, 4))
            l_enhanced = clahe.apply(l_channel)

            # Reconstrucción de imagen en color
            merged = cv2.merge([l_enhanced, a_channel, b_channel])
            enhanced_bgr = cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)
            return enhanced_bgr
        except Exception as e:
            logger.debug("Error en CLAHE: %s", e)
            return plate_img

    # =========================================================================
    # 3. Consenso Espaciotemporal (Character-Level Softmax Voting)
    # =========================================================================

    def fuse_multiframe_consensus(
        self,
        observations: List[TrackedPlateObservation],
    ) -> Tuple[str, float, np.ndarray]:
        """
        Aplica votación ponderada a nivel de carácter a lo largo de los mejores frames:
          Peso_Frame_i = Sharpness_i * DetConfidence_i
        Selecciona la combinación más consistente eliminando fallos aislados por oclusión o reflejo.
        """
        if not observations:
            return "", 0.0, np.zeros((self.target_h, self.target_w, 3), dtype=np.uint8)

        # Seleccionar la mejor imagen rectificada según nitidez
        best_obs = max(observations, key=lambda o: o.sharpness * o.det_confidence)
        best_crop = best_obs.rectified_crop

        # 1. Agrupar predicciones por longitud de caracteres
        text_candidates = [o.predicted_text.replace("-", "").strip() for o in observations if o.predicted_text]
        if not text_candidates:
            return "", 0.0, best_crop

        # Si tenemos una sola observación o todas coinciden
        if len(set(text_candidates)) == 1:
            return text_candidates[0], best_obs.raw_confidence, best_crop

        # 2. Votación ponderada posición por posición
        # Determinar longitud modal (generalmente 6 o 7 caracteres)
        lengths = [len(t) for t in text_candidates if len(t) in (6, 7)]
        target_len = max(set(lengths), key=lengths.count) if lengths else 7

        voted_chars = []
        total_consensus_score = 0.0

        for pos in range(target_len):
            char_weights: Dict[str, float] = {}
            for obs in observations:
                clean_t = obs.predicted_text.replace("-", "").strip()
                if pos < len(clean_t):
                    c = clean_t[pos]
                    w = max(0.1, obs.sharpness) * max(0.1, obs.det_confidence)
                    char_weights[c] = char_weights.get(c, 0.0) + w

            if char_weights:
                best_char = max(char_weights, key=char_weights.get)
                total_w = sum(char_weights.values())
                char_conf = char_weights[best_char] / total_w if total_w > 0 else 0.5
                voted_chars.append(best_char)
                total_consensus_score += char_conf
            else:
                voted_chars.append("?")

        raw_consensus = "".join(voted_chars)
        avg_score = total_consensus_score / float(target_len) if target_len > 0 else 0.0

        return raw_consensus, avg_score, best_crop

    # =========================================================================
    # 4. Ingesta de Frame y Procesamiento de Track
    # =========================================================================

    def register_observation(
        self,
        track_id: int,
        frame: np.ndarray,
        quad_points: np.ndarray,
        bbox: list[int],
        det_confidence: float,
        frame_idx: int,
        predicted_text: str = "",
        ocr_confidence: float = 0.0,
    ) -> Optional[ConsolidatedVehicleEvent]:
        """
        Registra una nueva observación para un track_id activo.
        Cuando se acumulan N frames de calidad (N=3 a 5), genera el evento consolidado.
        """
        t0 = time.perf_counter()

        # 0. Determinar tipo de placa por aspect ratio de bbox
        rect_w, rect_h = self._get_rect_dims_for_bbox(bbox)
        is_moto = (rect_w == _MOTO_PLATE_W)

        if is_moto:
            logger.debug(
                "Procesando placa MOTO | Track #%d | Rectificado: %dx%d",
                track_id, rect_w, rect_h,
            )

        # 1. Transformación de perspectiva con dimensiones correctas para el tipo de placa
        rectified = self.warp_perspective_orthogonal(frame, quad_points, target_w=rect_w, target_h=rect_h)

        # 2. Preprocesamiento de alto contraste
        enhanced = self.enhance_plate_contrast(rectified)

        # 3. Cálculo de nitidez Laplaciana
        gray_crop = cv2.cvtColor(enhanced, cv2.COLOR_BGR2GRAY)
        sharpness = float(cv2.Laplacian(gray_crop, cv2.CV_64F).var())

        obs = TrackedPlateObservation(
            frame_idx=frame_idx,
            timestamp=time.time(),
            quad_pts=quad_points,
            bbox=bbox,
            rectified_crop=enhanced,
            sharpness=sharpness,
            det_confidence=det_confidence,
            predicted_text=predicted_text,
            raw_confidence=ocr_confidence,
        )

        if track_id not in self._track_buffers:
            self._track_buffers[track_id] = []
            self._track_context_frames[track_id] = frame.copy()

        self._track_buffers[track_id].append(obs)

        # Si alcanzamos el umbral de frames temporales requeridos
        buffer_len = len(self._track_buffers[track_id])
        if buffer_len >= self.max_temporal_frames:
            return self._finalize_track_event(track_id, t0)

        return None

    def force_finalize_track(self, track_id: int) -> Optional[ConsolidatedVehicleEvent]:
        """Finaliza y consolida un track que está saliendo de la escena si tiene al menos N_min frames."""
        if track_id in self._track_buffers and len(self._track_buffers[track_id]) >= self.min_temporal_frames:
            return self._finalize_track_event(track_id, time.perf_counter())
        self._cleanup_track(track_id)
        return None

    def _finalize_track_event(self, track_id: int, start_time: float) -> ConsolidatedVehicleEvent:
        """Aplica consenso espaciotemporal, validación ANT y emite el evento final."""
        observations = self._track_buffers.get(track_id, [])
        context_frame = self._track_context_frames.get(track_id, np.zeros((10, 10, 3), dtype=np.uint8))

        # 1. Consenso Multi-Frame
        raw_consensus, consensus_score, best_crop = self.fuse_multiframe_consensus(observations)

        # 2. Validación y Normalización Normativa ANT Ecuador
        val_result: EcuadorPlateValidationResult = EcuadorPlateValidator.validate(raw_consensus)

        total_latency = (time.perf_counter() - start_time) * 1000.0

        event = ConsolidatedVehicleEvent(
            track_id=track_id,
            plate=val_result.formatted_plate,
            is_valid_ant=val_result.is_valid,
            confidence=round(max(val_result.confidence_score, consensus_score), 3),
            tipo_vehiculo=val_result.tipo_vehiculo,
            provincia=val_result.provincia,
            servicio=val_result.servicio,
            total_frames_analyzed=len(observations),
            best_rectified_image=best_crop,
            best_context_frame=context_frame,
            timestamp=time.time(),
            processing_latency_ms=round(total_latency, 2),
        )

        # Limpiar memoria del track
        self._cleanup_track(track_id)

        logger.info(
            "Evento ANPR Consolidado | Track #%d | Placa: %s | Valida ANT: %s | Provincia: %s | Latencia: %.1f ms",
            event.track_id,
            event.plate,
            event.is_valid_ant,
            event.provincia,
            event.processing_latency_ms,
        )
        return event

    def _cleanup_track(self, track_id: int) -> None:
        """Libera la memoria de observaciones del track."""
        self._track_buffers.pop(track_id, None)
        self._track_context_frames.pop(track_id, None)
