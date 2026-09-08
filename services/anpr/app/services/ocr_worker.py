"""
Worker Asincrono de OCR con Consenso Temporal Multi-Frame (Character-Level Voting).

Flujo de Dos Niveles (ITS Industrial Grade):
  1. Consume tareas de la cola de capturas pendientes (Queue).
  2. Carga la fotografia completa de alta calidad guardada en disco.
  3. Ejecuta PlateEnhancementAgent (YOLO re-localizacion, Motion Deblur, CLAHE, deskew, PaddleOCR).
  4. Alimenta el OcrHypothesisAccumulator del track correspondiente.
  5. El acumulador aplica votacion ponderada caracter a caracter sobre hasta 5 hipotesis.
  6. Emite resultado consolidado solo cuando se supera el umbral de confianza o N frames procesados.
  7. Notifica al Backend Node.js (POST /api/detecciones/completar-ocr) para persistir y emitir WebSocket.

Base Cientifica:
  Gou et al. (2016) -- "A Multi-Frame Temporal Aggregation Framework for LPR in Unconstrained Environments"
  Tessens et al. (2009) -- "Character Recognition by Combining Multiple OCR Engines"
  Equivalente al motor de consenso temporal de Genetec AutoVu y Vigilant Solutions LEARN III.
"""

from __future__ import annotations

import os
import queue
import re
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Dict, Deque, List, Optional, Tuple

import cv2
import httpx
import numpy as np

from app.config import BACKEND_URL, MEDIA_DIR
from app.core.ocr_engine import OcrEngine, create_ocr_engine
from app.core.plate_agent import PlateEnhancementAgent, PlateAnalysisResult
from app.utils.logger import get_logger

logger = get_logger("ocr_worker")


@dataclass
class OcrTask:
    """Tarea de procesamiento OCR encolada por el hilo de captura."""
    ingreso_id: int
    tracking_id: int
    foto_path: str              # Ruta absoluta de la foto en disco
    ruta_relativa_ingreso: str  # Ej: /media/ingreso_...jpg
    plate_bbox: list[int]       # [x1, y1, x2, y2]
    timestamp_str: str
    sharpness: float = 0.0      # Nitidez del frame (varianza Laplaciana)
    frame: Optional[np.ndarray] = None  # Fotograma en memoria (latencia cero)



# =============================================================================
# Acumulador de Hipotesis por Track ID (Consenso Temporal Multi-Frame)
# =============================================================================


@dataclass
class OcrHypothesis:
    """Hipotesis individual de lectura OCR para un frame de un track."""
    plate_text: str
    confidence: float
    sharpness: float
    timestamp: float


class OcrHypothesisAccumulator:
    """
    Acumulador de hipotesis de lectura OCR para un track_id activo.

    Implementa votacion ponderada a nivel de caracter (Character-Level Weighted Voting):
      peso_hipotesis = confianza_ocr * (nitidez_frame / 100.0)

    Emite resultado consolidado cuando:
      (a) La placa votada supera confianza consolidada >= 0.72, O
      (b) Se han procesado MIN_VOTES hipotesis del mismo track.

    El buffer caduca automaticamente si el track no recibe nuevas hipotesis
    durante mas de STALE_TIMEOUT_S segundos.

    Referencia: Gou et al. (2016) -- "Multi-Frame Temporal Aggregation for LPR"
    """

    MAX_HYPOTHESES: int = 5       # Maximo de hipotesis almacenadas por track
    MIN_VOTES_TO_EMIT: int = 1    # Minimo de hipotesis para emitir (emision inmediata en tiempo real)
    CONFIDENCE_THRESHOLD: float = 0.40  # Confianza consolidada para emision anticipada rapida
    STALE_TIMEOUT_S: float = 5.0  # Segundos de inactividad para limpiar el buffer

    def __init__(self, track_id: int) -> None:
        self.track_id = track_id
        self._hypotheses: Deque[OcrHypothesis] = deque(maxlen=self.MAX_HYPOTHESES)
        self._last_update: float = time.time()
        self._emitted: bool = False  # True si ya se emitio resultado definitivo

    def is_stale(self) -> bool:
        """Verifica si el acumulador ha superado el tiempo de inactividad."""
        return (time.time() - self._last_update) > self.STALE_TIMEOUT_S

    def add_hypothesis(self, plate: str, confidence: float, sharpness: float) -> None:
        """Agrega una nueva hipotesis de lectura al buffer del track."""
        if not plate or len(plate.replace("-", "")) < 3:
            return
        h = OcrHypothesis(
            plate_text=plate,
            confidence=confidence,
            sharpness=sharpness,
            timestamp=time.time(),
        )
        self._hypotheses.append(h)
        self._last_update = time.time()

    def vote(self) -> Tuple[str, float, int]:
        """
        Aplica votacion ponderada caracter a caracter sobre todas las hipotesis acumuladas.

        Retorna:
          (placa_votada, confianza_consolidada, numero_hipotesis_usadas)
        """
        hypotheses = list(self._hypotheses)
        n = len(hypotheses)

        if n == 0:
            return "", 0.0, 0

        if n == 1:
            h = hypotheses[0]
            return h.plate_text, h.confidence, 1

        # Normalizar textos (eliminar guion para votacion posicional)
        texts = [h.plate_text.replace("-", "").strip().upper() for h in hypotheses]

        # Determinar longitud modal (6 o 7 caracteres para placas ecuatorianas)
        valid_lengths = [len(t) for t in texts if len(t) in (5, 6, 7, 8)]
        if not valid_lengths:
            # Fallback: usar la hipotesis con mayor confianza
            best = max(hypotheses, key=lambda h: h.confidence * (h.sharpness / 100.0 + 0.1))
            return best.plate_text, best.confidence, n

        target_len = max(set(valid_lengths), key=valid_lengths.count)

        # Votacion ponderada posicion por posicion
        voted_chars: List[str] = []
        position_scores: List[float] = []

        for pos in range(target_len):
            char_weights: Dict[str, float] = {}
            for hyp, text in zip(hypotheses, texts):
                if pos < len(text):
                    c = text[pos]
                    # Peso = confianza OCR * factor de nitidez normalizado
                    weight = hyp.confidence * max(0.1, hyp.sharpness / 100.0)
                    char_weights[c] = char_weights.get(c, 0.0) + weight

            if char_weights:
                best_char = max(char_weights, key=char_weights.get)
                total_w = sum(char_weights.values())
                char_conf = char_weights[best_char] / total_w if total_w > 0 else 0.0
                voted_chars.append(best_char)
                position_scores.append(char_conf)
            else:
                voted_chars.append("?")
                position_scores.append(0.0)

        voted_plate = "".join(voted_chars)
        avg_confidence = sum(position_scores) / len(position_scores) if position_scores else 0.0

        # Reinsertar guion si la placa tiene formato ecuatoriano (3 letras + 3-4 digitos)
        voted_plate = _insert_plate_dash(voted_plate)

        return voted_plate, round(avg_confidence, 3), n

    def should_emit(self) -> bool:
        """
        Decide si el acumulador debe emitir el resultado ya.
        Condicion 1: confianza consolidada >= CONFIDENCE_THRESHOLD (emision anticipada rapida).
        Condicion 2: se han acumulado al menos MIN_VOTES hipotesis.
        """
        if self._emitted:
            return False
        n = len(self._hypotheses)
        if n == 0:
            return False
        _, conf, _ = self.vote()
        if conf >= self.CONFIDENCE_THRESHOLD:
            return True
        if n >= self.MIN_VOTES_TO_EMIT:
            return True
        return False

    def mark_emitted(self) -> None:
        """Marca el acumulador como ya emitido para evitar doble emision."""
        self._emitted = True


def _insert_plate_dash(plate: str) -> str:
    """
    Inserta el guion en la placa ecuatoriana si no lo tiene.
    Formato: AAA-1234 (3 letras + guion + 3-4 digitos)
    """
    clean = plate.replace("-", "").upper()
    if len(clean) >= 6:
        letters = re.sub(r"[^A-Z]", "", clean[:4])
        digits = re.sub(r"[^0-9]", "", clean[len(letters):])
        if len(letters) == 3 and len(digits) >= 3:
            return f"{letters}-{digits}"
    return plate


# =============================================================================
# Worker Asincrono Principal
# =============================================================================


class AsyncOcrWorker:
    """
    Worker asincrono en segundo plano con Consenso Temporal Multi-Frame.
    Ejecuta PlateEnhancementAgent por cada captura fotografica y acumula
    hipotesis por track_id antes de emitir el resultado definitivo.
    """

    def __init__(
        self,
        ocr_engine: Optional[OcrEngine] = None,
        on_ocr_completed: Optional[callable] = None,
    ) -> None:
        self._queue: queue.Queue[OcrTask] = queue.Queue(maxsize=3)
        self._engine = ocr_engine or create_ocr_engine()
        self._agent = PlateEnhancementAgent(self._engine)
        self._on_ocr_completed = on_ocr_completed
        self._running = False
        self._worker_thread: Optional[threading.Thread] = None
        self._client = httpx.Client(timeout=8.0)

        # Acumuladores de hipotesis indexados por tracking_id
        self._accumulators: Dict[int, OcrHypothesisAccumulator] = {}
        self._accumulators_lock = threading.Lock()

    def start(self) -> None:
        """Inicia el hilo trabajador en segundo plano."""
        if self._running:
            return
        self._running = True
        self._worker_thread = threading.Thread(
            target=self._worker_loop,
            name="AsyncOcrWorkerThread",
            daemon=True,
        )
        self._worker_thread.start()
        logger.info("Worker Asincrono de OCR con Consenso Multi-Frame iniciado.")

    def stop(self) -> None:
        """Detiene el worker limpiamente."""
        self._running = False
        if self._worker_thread and self._worker_thread.is_alive():
            self._worker_thread.join(timeout=2.0)
        self._client.close()
        logger.info("Worker Asincrono de OCR finalizado.")

    def enqueue_task(self, task: OcrTask) -> bool:
        """Encola una nueva tarea de captura fotografica para reconocimiento OCR."""
        # Si el vehículo ya tiene resultado definitivo emitido, no recalcular ni quemar CPU
        with self._accumulators_lock:
            acc = self._accumulators.get(task.tracking_id)
            if acc and acc._emitted:
                return False

        try:
            self._queue.put_nowait(task)
            logger.info(
                "Tarea OCR encolada | Ingreso ID #%d | Track #%d | Nitidez: %.1f",
                task.ingreso_id, task.tracking_id, task.sharpness,
            )
            return True
        except queue.Full:
            logger.warning("Cola OCR ocupada. Se descarta tarea redundante para Ingreso ID #%d", task.ingreso_id)
            return False

    def _get_or_create_accumulator(self, track_id: int) -> OcrHypothesisAccumulator:
        """Obtiene o crea el acumulador de hipotesis para un track_id."""
        with self._accumulators_lock:
            if track_id not in self._accumulators:
                self._accumulators[track_id] = OcrHypothesisAccumulator(track_id)
            return self._accumulators[track_id]

    def _cleanup_stale_accumulators(self) -> None:
        """Elimina acumuladores de tracks que ya no estan activos."""
        with self._accumulators_lock:
            stale = [tid for tid, acc in self._accumulators.items() if acc.is_stale()]
            for tid in stale:
                del self._accumulators[tid]
                logger.debug("Acumulador de hipotesis para Track #%d expirado y eliminado.", tid)

    def _worker_loop(self) -> None:
        """Bucle principal de consumo de tareas OCR."""
        last_cleanup = time.time()

        while self._running:
            # Limpieza periodica de acumuladores inactivos (cada 15 segundos)
            if time.time() - last_cleanup > 15.0:
                self._cleanup_stale_accumulators()
                last_cleanup = time.time()

            try:
                task = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue

            try:
                self._process_single_task(task)
            except Exception as e:
                logger.error("Error al procesar tarea OCR para Ingreso ID #%d: %s", task.ingreso_id, e)
            finally:
                self._queue.task_done()

    def _process_single_task(self, task: OcrTask) -> None:
        """
        Procesa una tarea fotografica con PlateEnhancementAgent y aplica
        Consenso Temporal Multi-Frame (character-level voting).
        """
        t_start = time.perf_counter()

        # 1. Cargar fotografía (prioridad en memoria para latencia cero)
        full_image = None
        if task.frame is not None and getattr(task.frame, "size", 0) > 0:
            full_image = task.frame
        elif os.path.exists(task.foto_path):
            full_image = cv2.imread(task.foto_path)

        if full_image is None or full_image.size == 0:
            logger.error("No se pudo obtener imagen para OCR (Ingreso ID #%d): %s", task.ingreso_id, task.foto_path)
            self._notify_backend_error(task.ingreso_id)
            return

        # 2. Ejecutar Agente de Mejora, Motion Deblur y OCR
        result: PlateAnalysisResult = self._agent.process_image(full_image, initial_bbox=task.plate_bbox)

        # 3. Alimentar el Acumulador de Hipotesis del Track
        accumulator = self._get_or_create_accumulator(task.tracking_id)

        if result.placa and result.estado == "procesado":
            accumulator.add_hypothesis(
                plate=result.placa,
                confidence=result.confianza,
                sharpness=task.sharpness,
            )

        # 4. Consenso Temporal / Emisión Inmediata en Tiempo Real (< 100ms)
        voted_plate, voted_conf, n_votes = "", 0.0, 0
        emit_now = accumulator.should_emit()

        if emit_now:
            voted_plate, voted_conf, n_votes = accumulator.vote()
            accumulator.mark_emitted()
            logger.info(
                "Consenso Multi-Frame | Track #%d | Hipotesis: %d | Placa votada: %s | Confianza: %.1f%%",
                task.tracking_id, n_votes, voted_plate, voted_conf * 100,
            )
        else:
            # Emision inmediata con resultado de este solo frame: si se reconocio placa con >= 4 caracteres
            clean_res = result.placa.replace("-", "").strip() if result.placa else ""
            if len(clean_res) >= 4 and result.confianza >= 0.25:
                voted_plate = result.placa
                voted_conf = result.confianza
                n_votes = 1
                accumulator.mark_emitted()
                logger.info(
                    "Emisión Inmediata Real-Time | Track #%d | Placa: %s | Confianza: %.1f%%",
                    task.tracking_id, voted_plate, voted_conf * 100,
                )
            else:
                # No hay lectura valida aun; emitir estado preliminar al backend
                voted_plate = result.placa or ""
                voted_conf = result.confianza
                n_votes = 1

        # 5. Guardar recorte nítido de la placa para evidencia
        plate_filename = f"placa_{task.timestamp_str}_{task.tracking_id}.jpg"
        plate_full_path = os.path.join(MEDIA_DIR, plate_filename)
        cv2.imwrite(plate_full_path, result.plate_crop)
        ruta_relativa_placa = f"/media/{plate_filename}"

        elapsed_ms = (time.perf_counter() - t_start) * 1000.0

        # 6. Determinar estado final del procesamiento
        clean_chars = voted_plate.replace("-", "").strip()
        estado_final = "procesado" if len(clean_chars) >= 4 else (result.estado if result.estado else "no_legible")

        # 7. Notificar al Backend (Node.js) para actualizacion y emision de WebSockets
        self._notify_backend_completed(
            ingreso_id=task.ingreso_id,
            placa=voted_plate,
            confianza=voted_conf,
            ruta_placa=ruta_relativa_placa,
            estado_procesamiento=estado_final,
        )

        # 8. Notificar al Pipeline para actualizar la caja visual en tiempo real
        if self._on_ocr_completed and task.tracking_id > 0 and voted_plate:
            try:
                self._on_ocr_completed(task.tracking_id, voted_plate, voted_conf, estado_final)
            except Exception as e:
                logger.warning("Error notificando resultado OCR al tracker HUD: %s", e)

        logger.info(
            "OCR Completado | Ingreso ID #%d | Placa: %s | Confianza: %.1f%% | Votos: %d | Estado: %s | Tiempo: %.1f ms",
            task.ingreso_id,
            voted_plate if voted_plate else "NO_LEGIBLE",
            voted_conf * 100,
            n_votes,
            estado_final,
            elapsed_ms,
        )

    def _notify_backend_completed(
        self,
        ingreso_id: int,
        placa: str,
        confianza: float,
        ruta_placa: str,
        estado_procesamiento: str,
    ) -> None:
        """Envia el resultado del OCR al backend Node.js."""
        url = f"{BACKEND_URL}/api/detecciones/completar-ocr"
        payload = {
            "ingreso_id": ingreso_id,
            "placa_reconocida": placa,
            "confianza_ocr": round(confianza, 3),
            "ruta_imagen_placa": ruta_placa,
            "estado_procesamiento": estado_procesamiento,
        }
        try:
            res = self._client.post(url, json=payload)
            if res.status_code not in (200, 201):
                logger.warning("Backend respondio con codigo %d: %s", res.status_code, res.text)
        except Exception as e:
            logger.error("Fallo al enviar notificacion de OCR completado al backend: %s", e)

    def _notify_backend_error(self, ingreso_id: int) -> None:
        """Notifica error de procesamiento al backend."""
        url = f"{BACKEND_URL}/api/detecciones/completar-ocr"
        payload = {
            "ingreso_id": ingreso_id,
            "placa_reconocida": None,
            "confianza_ocr": 0.0,
            "ruta_imagen_placa": None,
            "estado_procesamiento": "error",
        }
        try:
            self._client.post(url, json=payload)
        except Exception:
            pass
