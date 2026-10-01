"""
ECU 911 ANPR Microservice — Arquitectura de Dos Fases (Captura Fotográfica + OCR Asíncrono).

Hilos Concurrentes:
  1. Hilo Productor (Captura & Display): 30 FPS fluidos directos de OpenCV hacia /debug/stream sin bloqueos.
  2. Hilo Consumidor (Detector Liviano & Selector de Mejor Frame): Localiza ROI con YOLO en ~8ms y evalúa nitidez.
  3. Worker Asíncrono de OCR: Procesa la foto en segundo plano con PaddleOCR y actualiza la base de datos.
"""

from __future__ import annotations

import asyncio
import os
import queue
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from functools import partial

import cv2
import httpx
import numpy as np
from fastapi import FastAPI, File, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel
import base64

from app.config import (
    BACKEND_HEADERS,
    BACKEND_URL,
    CAMERA_ID,
    CAMERA_SOURCE,
    DEBUG_SHOW_WINDOW,
    DEBUG_VISUAL,
    FRAME_SKIP,
    INFERENCE_THROTTLE_MS,
    MEDIA_DIR,
    OCR_VERIFIER_VOTE_WEIGHT,
    RUNNING_IN_DOCKER,
    WEBCAM_INDEX,
    RTSP_URL,
)
from app.core.detector import _ESTADOS_FINALES, DetectionPipeline, compute_crop_sharpness, create_detection_pipeline
from app.core.verificacion_placa import (
    MIN_CARACTERES,
    analizar_caracteres,
    cuadrilatero_placa,
    evaluar_lectura,
    recorte_con_margen,
)
from app.core.frame_selector import BestFrameSelector
from app.core.ocr_engine import create_ocr_engine
from app.core.ocr_verifier import get_verifier
from app.core.vehicle_attributes import get_vehicle_recognizer
from app.core.video_source import RTSPSource, VideoSource, WebcamSource, create_video_source
from app.services.debug_stream import (
    DebugFrameBuffer,
    _get_standby_jpeg,
    mjpeg_generator,
    rtsp_direct_preview_generator,
    try_imshow,
)
from app.core.ecuador_plate_validator import validate_ecuadorian_plate
from app.services.ocr_worker import AsyncOcrWorker, OcrTask
from app.services.acceso import ticket_valido, token_servicio_valido
from app.services.metrics import (
    update_fps,
    record_detection,
    record_plate_recognized,
    update_tracking_active,
    record_detection_confidence,
    record_ocr_confidence,
    get_metrics,
)
from app.utils.logger import get_logger
from app.utils.memoria import purgar_expirados

logger = get_logger("main")


# =============================================================================
# Estado Global del Servicio
# =============================================================================

_video_source: VideoSource | None = None
_pipeline: DetectionPipeline | None = None
_frame_selector: BestFrameSelector | None = None
_ocr_worker: AsyncOcrWorker | None = None
_debug_buffer: DebugFrameBuffer = DebugFrameBuffer()

_capture_thread: threading.Thread | None = None
_disk_executor: ThreadPoolExecutor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="DiskIO")
_async_ocr_pool: ThreadPoolExecutor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="AsyncOCR")
# Executor dedicado para detección YOLO de frames del navegador (aislado del OCR y del I/O)
_browser_executor: ThreadPoolExecutor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="BrowserYOLO")
_ocr_in_flight: set[int] = set()
_ocr_lock: threading.Lock = threading.Lock()
_ocr_last_attempt: dict[int, float] = {}
_captured_commit_ids: dict[int, float] = {}
_recent_plates_committed: dict[str, float] = {}
PLATE_DEBOUNCE_SECONDS = 35.0
_http_client: httpx.Client = httpx.Client(timeout=5.0, headers=BACKEND_HEADERS)

_running = False
_capture_fps: float = 0.0
# Tamaño del último cuadro de la fuente (las cajas del pipeline están en esas coordenadas)
_tamano_fuente: dict[str, int] = {"w": 0, "h": 0}


def _bbox_sharpness(frame: np.ndarray, plate_bbox: list[int]) -> Optional[float]:
    """Nitidez (varianza del Laplaciano) del recorte de placa, en la misma escala que el filtro del tracker."""
    try:
        x1, y1, x2, y2 = [int(v) for v in plate_bbox]
        h, w = frame.shape[:2]
        return compute_crop_sharpness(frame[max(0, y1):min(h, y2), max(0, x1):min(w, x2)])
    except Exception:
        return None


def _padded_crop(frame: np.ndarray, plate_bbox: list[int], pad_x: float = 0.10, pad_y: float = 0.15) -> np.ndarray:
    """Recorte de la placa con margen, para que el OCR no pierda caracteres en los bordes."""
    x1, y1, x2, y2 = [int(v) for v in plate_bbox]
    h, w = frame.shape[:2]
    px, py = int((x2 - x1) * pad_x), int((y2 - y1) * pad_y)
    crop = frame[max(0, y1 - py):min(h, y2 + py), max(0, x1 - px):min(w, x2 + px)]
    return crop if crop.size else frame


def _enqueue_async_ocr(tracking_id: int, frame_copy: np.ndarray, plate_bbox: list[int]) -> None:
    """
    Ejecuta el OCR en un pool asíncrono desacoplado con cooldown por track.
    Garantiza que el bucle de tracking y video NUNCA se congele y mantenga 30+ FPS fluidos en tiempo real.
    """
    now = time.time()
    with _ocr_lock:
        if tracking_id in _ocr_in_flight:
            return
        if now - _ocr_last_attempt.get(tracking_id, 0.0) < 0.6:
            return
        _ocr_in_flight.add(tracking_id)
        _ocr_last_attempt[tracking_id] = now

    def _worker():
        try:
            worker = _ocr_worker
            pipeline = _pipeline
            if worker and getattr(worker, "_agent", None) and pipeline:
                res = worker._agent.process_image(frame_copy, plate_bbox, fast_mode=True)
                if res.placa:
                    status = "leida" if res.estado == "procesado" else "escaneando"
                    pipeline.update_track_plate(
                        tracking_id,
                        res.placa,
                        res.confianza,
                        status,
                        quality=_bbox_sharpness(frame_copy, plate_bbox),
                    )
        except Exception as e:
            logger.warning("Aviso en OCR asíncrono para track #%d: %s", tracking_id, e)
        finally:
            with _ocr_lock:
                _ocr_in_flight.discard(tracking_id)

    _async_ocr_pool.submit(_worker)


def _enqueue_browser_ocr(tracking_id: int, frame_copy: np.ndarray, plate_bbox: list[int]) -> None:
    """
    OCR asíncrono exclusivo para el flujo WebSocket del navegador.
    Escribe el resultado en _browser_track_plates (namespace aislado) en vez del
    pool RTSP, evitando que una lectura RTSP previa se muestre sobre un bbox del
    browser que puede estar en una posición completamente distinta del frame.
    """
    now = time.time()
    # Usar claves negativas en _ocr_last_attempt para el namespace browser (sin colisión con RTSP)
    browser_key = -(tracking_id + 1)
    with _ocr_lock:
        if browser_key in _ocr_in_flight:
            return
        # Re-escaneo continuo a 0.5s: refresca el consenso conforme el auto avanza
        # y la placa cambia de ángulo, distancia o nitidez (no bloquear si ya hay placa).
        if now - _ocr_last_attempt.get(browser_key, 0.0) < 0.50:
            return
        _ocr_in_flight.add(browser_key)
        _ocr_last_attempt[browser_key] = now

    def _worker():
        try:
            worker = _ocr_worker
            pipeline = _pipeline
            if worker and getattr(worker, "_agent", None) and pipeline:
                res = worker._agent.process_image(frame_copy, plate_bbox, fast_mode=True)
                if res.placa:
                    status = "leida" if res.estado == "procesado" else "escaneando"
                    pipeline.update_browser_track_plate(
                        tracking_id,
                        res.placa,
                        res.confianza,
                        status,
                        quality=_bbox_sharpness(frame_copy, plate_bbox),
                    )
        except Exception as e:
            logger.warning("Aviso en OCR browser asíncrono para track #%d: %s", tracking_id, e)
        finally:
            with _ocr_lock:
                _ocr_in_flight.discard(browser_key)

    _async_ocr_pool.submit(_worker)


# =============================================================================
# 1. Hilo Productor: Captura & Display a 30 FPS Nativos (Zero Lag / Zero Freeze)
# =============================================================================

_frame_lock = threading.Lock()
_shared_frame: Optional[np.ndarray] = None
_shared_frame_idx: int = 0
_new_frame_event = threading.Event()


def _detection_worker(
    pipeline: DetectionPipeline,
    frame_selector: BestFrameSelector,
    ocr_worker: AsyncOcrWorker,
) -> None:
    """
    Hilo consumidor de detección YOLO y seguimiento ByteTrack.
    Completamente desacoplado del bucle de captura y streaming para eliminar congelamiento.
    """
    global _running, _shared_frame, _shared_frame_idx
    last_processed_idx = -1
    logger.info("Hilo de inferencia y tracking desacoplado iniciado.")

    while _running:
        signaled = _new_frame_event.wait(timeout=0.03)
        if not _running:
            break
        if not signaled:
            continue
        _new_frame_event.clear()

        with _frame_lock:
            if _shared_frame is None or _shared_frame_idx == last_processed_idx:
                continue
            frame = _shared_frame.copy()
            idx = _shared_frame_idx
            last_processed_idx = idx

        try:
            # 1. Detección YOLO y Seguimiento ByteTrack (actualiza overlays en pipeline de forma segura @ 512px)
            tracked_rois = pipeline.detect_and_track(frame, imgsz=512)
            active_ids = {roi.tracking_id for roi in tracked_rois}

            # 2. Inferencia OCR desacoplada asíncrona (no bloquea el tracking a 30+ FPS)
            # Se sigue leyendo cada track (con el enfriamiento de _enqueue_async_ocr) hasta
            # reunir 3 lecturas concordantes: son la evidencia de consenso multi-cuadro que
            # exige la validez de la lectura.
            for roi in tracked_rois:
                info = pipeline.get_track_info(roi.tracking_id)
                if info.get("lecturas", 0) < 3 and info.get("status") not in _ESTADOS_FINALES:
                    bx1, by1, bx2, by2 = roi.plate_bbox
                    if (bx2 - bx1) >= 16 and (by2 - by1) >= 6:
                        _enqueue_async_ocr(roi.tracking_id, frame.copy(), roi.plate_bbox)

            # 3. Evaluación de calidad y disparo de captura fotográfica
            for roi in tracked_rois:
                selected = frame_selector.evaluate_and_select(
                    tracking_id=roi.tracking_id,
                    frame=frame,
                    plate_bbox=roi.plate_bbox,
                    confidence=roi.confidence,
                    frame_idx=idx,
                )
                if selected is not None:
                    _trigger_photo_capture(selected, ocr_worker)

            # Verificar si algún track salió de cuadro
            exited_candidates = frame_selector.cleanup_stale_tracks(active_ids)
            for exited in exited_candidates:
                _trigger_photo_capture(exited, ocr_worker)

        except Exception as e:
            logger.error("Error en hilo de detección desacoplado: %s", e)


def _sin_credenciales(url: str | None) -> str | None:
    """Oculta usuario:contraseña de una URL RTSP antes de exponerla en respuestas o registros."""
    return re.sub(r"//([^:/@]+):[^@]+@", r"//\1:******@", url) if url else url


def _render_standby_frame(nombre: str, url: str, width: int = 960, height: int = 540) -> np.ndarray:
    """Pantalla de espera mientras conecta el canal. Muestra solo el nombre del canal: la URL
    RTSP puede contener credenciales y no debe aparecer en el video."""
    frame = np.zeros((height, width, 3), dtype=np.uint8)
    frame[:] = (48, 23, 7)  # azul institucional #071730 (BGR)
    cx, cy = width // 2, height // 2
    titulo = (nombre or "Canal de video").upper()[:40]
    (tw, _), _ = cv2.getTextSize(titulo, cv2.FONT_HERSHEY_SIMPLEX, 0.9, 2)
    cv2.putText(frame, titulo, (cx - tw // 2, cy - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (235, 235, 235), 2, cv2.LINE_AA)
    sub = "Conectando con la camara..."
    (sw, _), _ = cv2.getTextSize(sub, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 1)
    cv2.putText(frame, sub, (cx - sw // 2, cy + 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (180, 190, 205), 1, cv2.LINE_AA)
    cv2.rectangle(frame, (0, height - 6), (width, height), (28, 28, 185), -1)  # franja roja #b91c1c
    return frame


def _realtime_anpr_loop(
    video_source: VideoSource,
    pipeline: DetectionPipeline,
    frame_selector: BestFrameSelector,
    ocr_worker: AsyncOcrWorker,
    debug_buffer: DebugFrameBuffer,
) -> None:
    """
    Bucle ultra-rápido de captura y streaming ANPR (Zero-Latency Producer):
    1. Captura fotogramas a 30+ FPS continuos sin retraso de inferencia.
    2. Envía cada nuevo cuadro al hilo consumidor de detección asíncrono.
    3. Dibuja overlays tácticos instantáneos (0.2ms) actualizados por el tracker.
    4. Mantiene el buffer de streaming a máxima tasa de refresco sin congelamiento.
    """
    global _running, _capture_fps, _shared_frame, _shared_frame_idx

    logger.info("Motor ANPR en Tiempo Real (Streaming Continuo 30+ FPS) iniciado.")

    # Conexión inicial rápida (sin bloquear el arranque si la cámara está apagada)
    connected = video_source.connect()
    if connected:
        logger.info("Fuente de video conectada exitosamente.")
    else:
        logger.info("Cámara física actualmente apagada o en espera. Iniciando en modo Standby...")

    # Iniciar hilo de detección y tracking desacoplado
    det_thread = threading.Thread(
        target=_detection_worker,
        args=(pipeline, frame_selector, ocr_worker),
        daemon=True,
        name="ANPR-Detection-Worker",
    )
    det_thread.start()

    frame_count = 0
    fps_start = time.time()
    show_window = DEBUG_SHOW_WINDOW and not RUNNING_IN_DOCKER
    consecutive_read_failures = 0
    os.makedirs(MEDIA_DIR, exist_ok=True)

    while _running:
        current_source = _video_source or video_source
        if current_source is None:
            time.sleep(0.04)
            continue

        ret, frame = current_source.read_frame()

        if not ret or frame is None:
            consecutive_read_failures += 1
            if consecutive_read_failures >= 40 and consecutive_read_failures % 30 == 0:
                cam_name = getattr(current_source, "_name", "Canal Activo")
                cam_url = getattr(current_source, "_url", CAMERA_SOURCE)
                standby = _render_standby_frame(cam_name, cam_url)
                debug_buffer.update(standby)
            time.sleep(0.02)
            continue

        consecutive_read_failures = 0
        frame_count += 1
        _tamano_fuente["h"], _tamano_fuente["w"] = frame.shape[:2]

        # Enviar frame al consumidor de detección sin demoras de bloqueo
        with _frame_lock:
            _shared_frame = frame
            _shared_frame_idx = frame_count
        _new_frame_event.set()

        # Medición fluida de FPS con ventana móvil de 10 fotogramas
        if frame_count % 10 == 0:
            elapsed = time.time() - fps_start
            if elapsed > 0:
                inst_fps = 10.0 / elapsed
                _capture_fps = round(0.7 * _capture_fps + 0.3 * inst_fps if _capture_fps > 0 else inst_fps, 1)
            fps_start = time.time()

        # HUD y buffer de video solo si alguien lo está mirando (ahorra CPU sin espectadores)
        if DEBUG_VISUAL and (show_window or debug_buffer.viewers > 0):
            annotated = pipeline.draw_overlays(
                frame.copy(),
                capture_fps=_capture_fps,
                inference_fps=pipeline.fps,
            )
            debug_buffer.update(annotated)

            if show_window:
                if not try_imshow("ANPR ECU 911 - Stream en Vivo (Scout)", annotated):
                    show_window = False

    video_source.release()
    if show_window:
        try:
            cv2.destroyAllWindows()
        except Exception:
            pass

    logger.info("Motor ANPR en Tiempo Real finalizado.")


def _trigger_photo_capture(candidate, ocr_worker: AsyncOcrWorker) -> None:
    """
    Compuerta de Cero Falsos Positivos (Zero False-Positive Gate para ITS / ECU 911).
    Garantiza que NUNCA se guarde una imagen en disco ni se cree un ingreso vehicular en BD
    a menos que la región contenga una matrícula vehicular comprobada (autos o motos).
    """
    tracking_id = getattr(candidate, "tracking_id", -1)
    now = time.time()
    with _ocr_lock:
        if tracking_id in _captured_commit_ids and (now - _captured_commit_ids[tracking_id] < PLATE_DEBOUNCE_SECONDS):
            return
        _captured_commit_ids[tracking_id] = now

    frame_copy = candidate.frame.copy() if candidate.frame is not None else None
    if frame_copy is None or frame_copy.size == 0:
        return

    def _verify_and_commit():
        try:
            pipeline = _pipeline
            # 1. Comprobar lecturas previas en ambos namespaces (RTSP y Browser)
            info_browser = pipeline.get_browser_track_info(tracking_id) if pipeline else {}
            info_rtsp = pipeline.get_track_info(tracking_id) if pipeline else {}
            preliminary_plate = info_browser.get("plate") or info_rtsp.get("plate", "")
            preliminary_conf = max(info_browser.get("confidence", 0.0), info_rtsp.get("confidence", 0.0))

            # Comprobación temprana de Anti-Duplicado preliminar antes de OCR profundo o I/O a disco
            if preliminary_plate:
                clean_prelim = preliminary_plate.replace("-", "").strip().upper()
                now_t = time.time()
                with _ocr_lock:
                    if clean_prelim in _recent_plates_committed and (now_t - _recent_plates_committed[clean_prelim] < PLATE_DEBOUNCE_SECONDS):
                        logger.info(
                            "[ANTI-DUPLICADO PRELIMINAR] Track #%d placa preliminar '%s' ya registrada hace %.1fs. Omitiendo captura.",
                            tracking_id, clean_prelim, now_t - _recent_plates_committed[clean_prelim]
                        )
                        return

            # Lecturas de OTROS cuadros del track, antes de sumar las de este (para no contar
            # dos veces el mismo cuadro con el OCR profundo y el verificador)
            conteo_previo = pipeline.conteo_lecturas(tracking_id) if pipeline else {}

            # 2. SEGUNDA VERIFICACIÓN OCR PROFUNDA POR DETRÁS (Fase 2 de Alta Fidelidad)
            # Evalúa el fotograma en alta resolución con homografía + Sauvola adaptativo + realce CLAHE
            verified_plate = ""
            verified_conf = 0.0
            deep_res = None

            if ocr_worker and getattr(ocr_worker, "_agent", None):
                deep_res = ocr_worker._agent.process_image(frame_copy, initial_bbox=candidate.plate_bbox, fast_mode=False)
                if deep_res.placa and deep_res.estado == "procesado":
                    verified_plate = deep_res.placa
                    verified_conf = deep_res.confianza
                elif deep_res.placa and len(deep_res.placa.replace("-", "").strip()) >= 4:
                    is_val, fmt_p, val_score = validate_ecuadorian_plate(deep_res.placa)
                    if is_val:
                        verified_plate = fmt_p
                        verified_conf = max(deep_res.confianza, val_score)

            # 2.1 Segunda lectura con PP-OCRv6 (OpenVINO) sobre la mejor foto. Solo aquí, una
            # vez por vehículo, porque es más precisa pero demasiado lenta para cada frame.
            verifier_plate = ""
            verifier_conf = 0.0
            verifier = get_verifier()
            if verifier is not None:
                ver = verifier.read(_padded_crop(frame_copy, candidate.plate_bbox))
                if ver.plate and ver.within_budget:
                    is_val, fmt_v, _ = validate_ecuadorian_plate(ver.plate)
                    if is_val:
                        verifier_plate, verifier_conf = fmt_v, ver.confidence
                        if not verified_plate:
                            verified_plate, verified_conf = fmt_v, ver.confidence
                logger.info(
                    "[VERIFICADOR %s] Track #%d | lectura '%s' (%.2f) en %.0f ms%s",
                    verifier.description, tracking_id, ver.plate or "-", ver.confidence, ver.elapsed_ms,
                    "" if ver.within_budget else " — descartada por exceder el presupuesto",
                )

            # Consenso temporal: la lectura profunda de este fotograma se suma como un voto
            # más al consenso del track (lecturas de varios frames), en lugar de reemplazarlo.
            # Así un único frame mal leído no decide la placa registrada.
            if pipeline and verified_plate:
                use_browser = bool(info_browser)
                add_vote = pipeline.update_browser_track_plate if use_browser else pipeline.update_track_plate
                get_info = pipeline.get_browser_track_info if use_browser else pipeline.get_track_info
                sharpness = _bbox_sharpness(frame_copy, candidate.plate_bbox)
                add_vote(tracking_id, verified_plate, verified_conf, "", quality=sharpness)
                if verifier_plate:
                    # El verificador pesa más que una lectura rápida (OCR_VERIFIER_VOTE_WEIGHT)
                    add_vote(tracking_id, verifier_plate, verifier_conf * OCR_VERIFIER_VOTE_WEIGHT, "", quality=sharpness)
                consensus = get_info(tracking_id)
                consensus_plate = consensus.get("plate", "")
                if consensus_plate and consensus_plate != verified_plate.replace("-", "").upper():
                    is_val, fmt_p, _ = validate_ecuadorian_plate(consensus_plate)
                    if is_val:
                        logger.info(
                            "[CONSENSO] Track #%d | lectura del frame '%s' reemplazada por consenso multi-frame '%s'",
                            tracking_id, verified_plate, fmt_p,
                        )
                        verified_plate = fmt_p
                        verified_conf = float(consensus.get("confidence", verified_conf))

            # Consenso con la lectura preliminar si deep_res no obtuvo certeza total
            if not verified_plate and preliminary_plate:
                is_val, fmt_p, val_score = validate_ecuadorian_plate(preliminary_plate)
                if is_val:
                    verified_plate = fmt_p
                    verified_conf = max(preliminary_conf, val_score)

            # 3. COMPUERTA ESTRICTA: Si no es una matrícula ANT válida, auditar descarte y NO contaminar BD
            clean_plate = verified_plate.replace("-", "").strip().upper() if verified_plate else ""
            if not clean_plate or len(clean_plate) < 4:
                cand_text = (deep_res.placa if deep_res else preliminary_plate) or ""
                logger.info(
                    "[SEGUNDA VERIFICACIÓN OCR] Falso positivo prevenido | Track #%d descartado (texto: '%s')",
                    tracking_id, cand_text,
                )
                try:
                    _http_client.post(
                        f"{BACKEND_URL}/api/detecciones/descarte",
                        json={
                            "tracking_id": tracking_id,
                            "motivo": "segunda_verificacion_ocr_no_valido",
                            "texto_candidato": cand_text or None,
                            "confianza": round(deep_res.confianza if deep_res else preliminary_conf, 3),
                            "fuente": CAMERA_SOURCE,
                            "camara_id": CAMERA_ID,
                        },
                        timeout=2.0,
                    )
                except Exception:
                    pass
                return

            # 3.0 VALIDEZ DE LA LECTURA (evidencias independientes, ver verificacion_placa.py):
            # formato ANT, placa completa dentro del cuadro, fila de caracteres plausible
            # (análisis estilo OpenALPR) y confirmación por consenso multi-cuadro o por el
            # segundo OCR. Solo una lectura válida puede autorizarse sin intervención.
            h_f, w_f = frame_copy.shape[:2]
            bbox_v = [int(v) for v in candidate.plate_bbox]
            es_moto = (bbox_v[2] - bbox_v[0]) / max(1.0, float(bbox_v[3] - bbox_v[1])) <= 1.45
            recorte_v, origen_v = recorte_con_margen(frame_copy, bbox_v)
            analisis = analizar_caracteres(recorte_v, min_caracteres=2 if es_moto else MIN_CARACTERES)
            previo = pipeline.mejor_analisis(tracking_id) if pipeline else None
            if previo and (previo.valida, previo.caracteres, previo.puntaje) > (analisis.valida, analisis.caracteres, analisis.puntaje):
                analisis = previo
            limpia_ver = verifier_plate.replace("-", "").upper() if verifier_plate else ""
            limpia_deep = (deep_res.placa or "").replace("-", "").upper() if deep_res else ""
            verificador_coincide = limpia_ver == clean_plate
            este_cuadro = 1 if clean_plate in (limpia_ver, limpia_deep) else 0
            lecturas = int(conteo_previo.get(clean_plate, 0)) + este_cuadro
            validez = evaluar_lectura(
                formato_valido=validate_ecuadorian_plate(verified_plate)[0],
                bbox=bbox_v, ancho_img=w_f, alto_img=h_f, analisis=analisis,
                lecturas_concordantes=lecturas, verificador_coincide=verificador_coincide,
            )
            logger.info(
                "[VALIDEZ] Track #%d | %s | válida=%s | caracteres=%d lecturas=%d verificador=%s | %s",
                tracking_id, verified_plate, validez.valido, analisis.caracteres, lecturas,
                verificador_coincide, "; ".join(validez.motivos) or "todas las evidencias",
            )

            # Compuerta "no es placa": sin fila de caracteres y sin ninguna confirmación de la
            # lectura (ruido del detector sobre rótulos, rejillas, franja "ECUADOR"...). Se libera
            # el track para que un cuadro posterior pueda volver a intentarlo.
            if analisis.caracteres < 3 and lecturas < 2 and not verificador_coincide:
                logger.info("[VALIDEZ] Track #%d descartado: región sin fila de caracteres ('%s')", tracking_id, verified_plate)
                with _ocr_lock:
                    _captured_commit_ids.pop(tracking_id, None)
                try:
                    _http_client.post(
                        f"{BACKEND_URL}/api/detecciones/descarte",
                        json={
                            "tracking_id": tracking_id,
                            "motivo": "region_sin_caracteres",
                            "texto_candidato": verified_plate,
                            "confianza": round(verified_conf, 3),
                            "fuente": CAMERA_SOURCE,
                            "camara_id": CAMERA_ID,
                        },
                        timeout=2.0,
                    )
                except Exception:
                    pass
                return
            cuadrilatero = cuadrilatero_placa(bbox_v, analisis, w_f, h_f, origen_v) if not es_moto else None
            evidencia = {
                **validez.to_dict(),
                "angulo": round(analisis.angulo, 1),
                "regularidad": analisis.puntaje,
                "bordes_hallados": analisis.bordes_hallados,
                "cuadrilatero": cuadrilatero,
                "lectura_ocr": limpia_deep or None,
                "lectura_verificador": limpia_ver or None,
            }

            # 3.1 ANTI-DUPLICADO DE PLACA CONFIRMADA ENTRE FASES:
            # Si la misma placa ya fue capturada y guardada en los últimos PLATE_DEBOUNCE_SECONDS, omitir duplicado.
            now_commit = time.time()
            with _ocr_lock:
                if clean_plate in _recent_plates_committed and (now_commit - _recent_plates_committed[clean_plate] < PLATE_DEBOUNCE_SECONDS):
                    logger.info(
                        "[ANTI-DUPLICADO OCR] Track #%d placa confirmada '%s' ya registrada hace %.1fs. Omitiendo duplicado.",
                        tracking_id, clean_plate, now_commit - _recent_plates_committed[clean_plate]
                    )
                    return
                _recent_plates_committed[clean_plate] = now_commit
                _captured_commit_ids[tracking_id] = now_commit
                # Purgar entradas expiradas de los tres registros en memoria (antes solo se purgaba
                # el de placas: los de tracks crecían sin límite en operación 24/7)
                horizonte = PLATE_DEBOUNCE_SECONDS * 2
                purgar_expirados(_recent_plates_committed, now_commit, horizonte)
                purgar_expirados(_captured_commit_ids, now_commit, horizonte)
                purgar_expirados(_ocr_last_attempt, now_commit, horizonte)

            # Marcar el track como confirmado (el estado autorizado/alerta lo decide el backend
            # al cruzar con las listas; aquí solo se indica que la placa ya fue registrada).
            if pipeline:
                pipeline.update_track_plate(tracking_id, "", 0.0, "confirmada")
                pipeline.update_browser_track_plate(tracking_id, "", 0.0, "confirmada")

            # 4. Confirmado como vehículo/motocicleta real: Guardar evidencia fotográfica
            ts_str = time.strftime("%Y%m%d_%H%M%S")
            bbox = getattr(candidate, "plate_bbox", [0, 0, 0, 0])
            bbox_x = bbox[0] if (bbox and len(bbox) > 0) else 0
            foto_filename = f"ingreso_{ts_str}_{bbox_x}_{int(candidate.timestamp * 1000) % 10000}.jpg"
            foto_full_path = os.path.join(MEDIA_DIR, foto_filename)
            ruta_relativa_ingreso = f"/media/{foto_filename}"

            cv2.imwrite(foto_full_path, frame_copy)

            # Guardar recorte de la matrícula
            x1, y1, x2, y2 = bbox
            h_f, w_f = frame_copy.shape[:2]
            crop_plate = frame_copy[max(0, y1):min(h_f, y2), max(0, x1):min(w_f, x2)]
            plate_filename = f"placa_{ts_str}_{tracking_id}.jpg"
            plate_full_path = os.path.join(MEDIA_DIR, plate_filename)
            ruta_relativa_placa = f"/media/{plate_filename}"
            if crop_plate.size > 0:
                cv2.imwrite(plate_full_path, crop_plate)
            else:
                ruta_relativa_placa = ruta_relativa_ingreso

            # 5. Registrar el evento en el Backend Node.js
            url_ingreso = f"{BACKEND_URL}/api/detecciones/ingreso"
            # Metadatos para evaluar el sistema por condición (luz, distancia, velocidad) y
            # registrar qué versión de los modelos produjo cada lectura (reproducibilidad).
            born_at, speed_px_s = pipeline.track_eval_info(tracking_id) if pipeline else (None, None)
            models = _model_info()
            # Segundo factor: tipo, color, marca y modelo del vehículo (una vez por vehículo)
            vehiculo = None
            recognizer = get_vehicle_recognizer()
            if recognizer is not None and bbox and len(bbox) == 4:
                try:
                    vehiculo = recognizer.analyze(frame_copy, list(bbox)).to_dict()
                    logger.info("[VEHÍCULO] Track #%d | %s", tracking_id, vehiculo)
                except Exception as e:
                    logger.warning("No se pudieron obtener atributos del vehículo (track #%d): %s", tracking_id, e)
            payload_ingreso = {
                "tracking_id": tracking_id,
                "placa": verified_plate,
                "ruta_imagen_ingreso": ruta_relativa_ingreso,
                "confianza_deteccion": round(candidate.confidence, 3),
                "fuente": CAMERA_SOURCE,
                "camara_id": CAMERA_ID,
                "metadatos": {
                    "luminancia_media": round(float(cv2.cvtColor(frame_copy, cv2.COLOR_BGR2GRAY).mean()), 1),
                    "distancia_estimada_m": getattr(candidate, "estimated_distance_m", None),
                    "ancho_placa_px": int(bbox[2] - bbox[0]) if bbox and len(bbox) == 4 else None,
                    "nitidez": round(float(getattr(candidate, "sharpness", 0.0)), 1),
                    "velocidad_px_s": speed_px_s,
                    "modelo_detector": models.get("detector"),
                    "modelo_ocr": " + ".join(m for m in (models.get("ocr_engine"), models.get("ocr_verifier")) if m) or None,
                    "vehiculo": vehiculo,
                },
            }
            res_ing = _http_client.post(url_ingreso, json=payload_ingreso)
            if res_ing.status_code in (200, 201):
                res_data = res_ing.json()
                ingreso_id = res_data.get("ingreso_id")
                es_duplicado = res_data.get("deduplicado", False)
                if ingreso_id and not es_duplicado:
                    # Notificar inmediatamente la compleción del OCR con la placa confirmada
                    url_ocr = f"{BACKEND_URL}/api/detecciones/completar-ocr"
                    # Latencia de principio a fin: desde que el vehículo apareció (nacimiento del
                    # track) hasta que su lectura queda registrada; si el track ya no existe, desde
                    # la captura del mejor frame.
                    t_inicio = born_at or getattr(candidate, "timestamp", None) or now
                    payload_ocr = {
                        "ingreso_id": ingreso_id,
                        "placa_reconocida": verified_plate,
                        "confianza_ocr": round(verified_conf, 3),
                        "ruta_imagen_placa": ruta_relativa_placa,
                        "estado_procesamiento": "procesado",
                        "lectura_verificador": verifier_plate or None,
                        "latencia_ms": int((time.time() - t_inicio) * 1000),
                        "lectura_valida": validez.valido,
                        "evidencia_lectura": evidencia,
                    }
                    res_ocr = _http_client.post(url_ocr, json=payload_ocr)
                    # El color de la caja en vivo refleja la decisión del backend
                    try:
                        estado_final = (res_ocr.json().get("deteccion") or {}).get("estado_validacion")
                        if estado_final and pipeline:
                            pipeline.fijar_estado_backend(tracking_id, estado_final)
                    except Exception:
                        pass
                    logger.info(
                        "CAPTURA REGISTRADA ECU 911 | Ingreso ID #%d | Track #%d | Placa: %s (%.1f%%)",
                        ingreso_id, tracking_id, verified_plate, verified_conf * 100,
                    )
                elif es_duplicado:
                    logger.info(
                        "[BACKEND DEDUPLICADO] Ingreso ID #%d consolidado para Track #%d | Placa: %s",
                        ingreso_id, tracking_id, verified_plate,
                    )
            else:
                logger.warning("Fallo al registrar ingreso confirmado en backend: %s", res_ing.text)

        except Exception as e:
            logger.error("Error en compuerta de captura para track #%d: %s", tracking_id, e)

    _disk_executor.submit(_verify_and_commit)


# =============================================================================
# FastAPI Lifespan
# =============================================================================


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _video_source, _pipeline, _frame_selector, _ocr_worker, _capture_thread, _running

    logger.info("=" * 60)
    logger.info("  ECU 911 ANPR Microservice — Motor Cero Latencia en Tiempo Real")
    logger.info("  Captura Sincronizada + PaddleOCR Asíncrono de Alta Fidelidad")
    logger.info("=" * 60)

    _video_source = create_video_source()
    _pipeline = create_detection_pipeline()
    _frame_selector = BestFrameSelector()

    ocr_engine = create_ocr_engine()
    _ocr_worker = AsyncOcrWorker(ocr_engine, on_ocr_completed=_pipeline.update_track_plate)
    _ocr_worker.start()
    # Precarga del verificador PP-OCRv6 (la compilación OpenVINO tarda unos segundos)
    threading.Thread(target=get_verifier, daemon=True, name="OcrVerifierInit").start()
    threading.Thread(target=get_vehicle_recognizer, daemon=True, name="VehicleAttrInit").start()

    _running = True

    # Iniciar Hilo Unificado de Cero Latencia (Captura, Detección, Tracking y Display HUD)
    _capture_thread = threading.Thread(
        target=_realtime_anpr_loop,
        args=(_video_source, _pipeline, _frame_selector, _ocr_worker, _debug_buffer),
        daemon=True,
        name="anpr-realtime-engine",
    )
    _capture_thread.start()

    yield

    logger.info("Cerrando servicio ANPR...")
    _running = False

    if _ocr_worker:
        _ocr_worker.stop()

    if _capture_thread and _capture_thread.is_alive():
        _capture_thread.join(timeout=2.0)

    _disk_executor.shutdown(wait=False)
    _async_ocr_pool.shutdown(wait=False)
    _browser_executor.shutdown(wait=False)
    _http_client.close()
    logger.info("Servicio ANPR cerrado limpiamente.")


# =============================================================================
# App FastAPI y Endpoints
# =============================================================================

app = FastAPI(
    title="ECU 911 ANPR Microservice",
    description="Microservicio de Reconocimiento de Placas — Arquitectura de Dos Fases",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# La evidencia fotográfica se sirve solo desde el backend, con enlaces firmados.


def _param_int(websocket: WebSocket, nombre: str, defecto: int, minimo: int, maximo: int) -> int:
    try:
        return max(minimo, min(maximo, int(websocket.query_params.get(nombre, defecto))))
    except (TypeError, ValueError):
        return defecto


@app.websocket("/ws/stream")
@app.websocket("/api/ws/stream")
async def websocket_stream_endpoint(websocket: WebSocket):
    """
    Video anotado en vivo para el panel de monitoreo (JPEG binario por WebSocket).

    Parámetros de consulta:
      ticket   credencial de 60 s emitida por el backend (obligatoria con ANPR_SERVICE_TOKEN)
      ancho    ancho máximo en px (320–1280, por omisión 640)
      fps      cuadros por segundo máximos (1–25, por omisión 10)
      calidad  calidad JPEG (30–90, por omisión 60)

    Solo se envía un cuadro nuevo cuando el pipeline produjo uno y dentro de la cadencia
    pedida; el cliente cierra la conexión cuando la pestaña deja de estar visible.
    """
    if not ticket_valido(websocket.query_params.get("ticket"), "stream"):
        await websocket.close(code=4401)
        return
    ancho = _param_int(websocket, "ancho", 640, 320, 1280)
    intervalo = 1.0 / _param_int(websocket, "fps", 10, 1, 25)
    calidad = _param_int(websocket, "calidad", 60, 30, 90)

    await websocket.accept()
    _debug_buffer.add_viewer()
    logger.info("Visor de video conectado (%dpx, %.0f fps, q%d). Espectadores: %d", ancho, 1 / intervalo, calidad, _debug_buffer.viewers)
    ultimo = -1
    loop = asyncio.get_event_loop()
    try:
        while _running:
            t0 = loop.time()
            jpeg, contador = await loop.run_in_executor(None, _debug_buffer.get_jpeg, ancho, calidad)
            if jpeg is None:
                if ultimo != -2:
                    await websocket.send_bytes(_get_standby_jpeg())
                    ultimo = -2
                await asyncio.sleep(1.0)
                continue
            if contador != ultimo:
                ultimo = contador
                await websocket.send_bytes(jpeg)
                await asyncio.sleep(max(0.005, intervalo - (loop.time() - t0)))
            else:
                await asyncio.sleep(0.01)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.debug("Conexión WebSocket de video cerrada: %s", e)
    finally:
        _debug_buffer.remove_viewer()
        logger.info("Visor de video desconectado. Espectadores: %d", _debug_buffer.viewers)


def _pistas_actuales() -> dict:
    """Cajas de detección vigentes, normalizadas a 0–1 respecto del cuadro de la fuente."""
    w, h = _tamano_fuente["w"], _tamano_fuente["h"]
    if not _pipeline or not w or not h:
        return {"pistas": [], "roi": _pipeline.roi if _pipeline else None}
    ahora = time.time()
    with _pipeline._overlays_lock:
        cajas = [ov for ov in _pipeline._current_overlays if ahora - ov.timestamp < 1.0]
    def n(x: float, total: int) -> float:
        return round(max(0.0, min(1.0, x / total)), 4)
    pistas = []
    for ov in cajas:
        b, g, r = ov.color
        pistas.append({
            "id": ov.tracking_id,
            "caja": [n(ov.x1, w), n(ov.y1, h), n(ov.x2, w), n(ov.y2, h)],
            "puntos": [[n(px, w), n(py, h)] for px, py in ov.oriented_box] if ov.oriented_box and len(ov.oriented_box) == 4 else None,
            "etiqueta": ov.label.strip(),
            "color": f"#{int(r):02x}{int(g):02x}{int(b):02x}",
            "placa": ov.placa or None,
            "estado": ov.estado or None,
        })
    return {"pistas": pistas, "roi": _pipeline.roi}


@app.websocket("/ws/pistas")
@app.websocket("/api/ws/pistas")
async def websocket_pistas_endpoint(websocket: WebSocket):
    """
    Metadatos de detección para dibujar sobre el video WebRTC del navegador: solo JSON con
    las cajas vigentes (≈10 envíos por segundo y únicamente cuando cambian). El video llega
    aparte por WebRTC desde MediaMTX sin re-codificar, así que el motor no dibuja ni
    comprime imágenes para los visores.
    """
    if not ticket_valido(websocket.query_params.get("ticket"), "stream"):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    ultimo = None
    try:
        while _running:
            datos = _pistas_actuales()
            if datos != ultimo:
                await websocket.send_json(datos)
                ultimo = datos
            await asyncio.sleep(0.1)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.debug("WebSocket de pistas cerrado: %s", e)


@app.websocket("/ws/webcam")
@app.websocket("/api/ws/webcam")
async def websocket_webcam_endpoint(websocket: WebSocket):
    """
    Endpoint WebSocket para streaming de frames binarios desde la webcam del navegador.
    Arquitectura: cliente envía JPEG binario → backend responde con JSON de detecciones.
    Ventajas sobre HTTP:
      - Sin overhead de TCP handshake (~10ms ahorrados por frame)
      - Sin headers HTTP (~1KB ahorrado por frame)
      - Conexión persistente: menor latencia total de red
      - YOLO a 256px (vs 384px para RTSP): ~40% más rápido en CPU
    Requiere un ticket de alcance "webcam" (solo administradores).
    """
    if not ticket_valido(websocket.query_params.get("ticket"), "webcam"):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    loop = asyncio.get_event_loop()
    is_busy = False
    logger.info("Cliente WebSocket de webcam conectado.")

    try:
        while _running:
            data = await websocket.receive_bytes()
            if is_busy:
                # Si el modelo aún procesa el frame previo, descartar este frame para cero latencia
                continue

            is_busy = True
            try:
                nparr = np.frombuffer(data, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if frame is None or _pipeline is None:
                    await websocket.send_json({"rois": []})
                    continue

                tracked_rois = await loop.run_in_executor(_browser_executor, _pipeline.detect_fast, frame)

                now = time.time()
                rois_data = []
                for r in tracked_rois:
                    # get_browser_track_info lee del namespace aislado del navegador,
                    # evitando que lecturas del loop RTSP contaminen los labels del browser.
                    info = _pipeline.get_browser_track_info(r.tracking_id)
                    bx1, by1, bx2, by2 = r.plate_bbox
                    if (bx2 - bx1) >= 16 and (by2 - by1) >= 6:
                        # OCR continuo en tiempo real: se re-escanea mientras la placa
                        # está activa para refinar el consenso conforme el auto avanza.
                        # La compuerta de cooldown (0.5s) está en _enqueue_browser_ocr.
                        _enqueue_browser_ocr(r.tracking_id, frame.copy(), r.plate_bbox)
                    rois_data.append({
                        "tracking_id": r.tracking_id,
                        "confidence": round(r.confidence, 3),
                        "bbox": r.plate_bbox,
                        "oriented_box": getattr(r, "oriented_box", []),
                        "velocity": r.velocity,
                        "ts": round(now, 4),
                        "plate": info.get("plate", ""),
                        "status": info.get("status", ""),
                        "plate_confidence": round(info.get("confidence", 0.0), 3),
                    })

                # Evaluación de nitidez y disparo de captura fotográfica automática para webcam
                if _frame_selector and _ocr_worker:
                    frame_idx = int(now * 30)
                    active_ids = {r.tracking_id for r in tracked_rois}
                    for r in tracked_rois:
                        selected = _frame_selector.evaluate_and_select(
                            tracking_id=r.tracking_id,
                            frame=frame,
                            plate_bbox=r.plate_bbox,
                            confidence=r.confidence,
                            frame_idx=frame_idx,
                        )
                        if selected is not None:
                            _trigger_photo_capture(selected, _ocr_worker)

                    exited = _frame_selector.cleanup_stale_tracks(active_ids)
                    for cand in exited:
                        _trigger_photo_capture(cand, _ocr_worker)

                motion_bbox, motion_pct, motion_vehicle = _pipeline.get_motion_info() if _pipeline else (None, 0, False)
                await websocket.send_json({
                    "rois": rois_data,
                    "motion_bbox": motion_bbox,
                    "motion_pct": motion_pct,
                    "motion_vehicle_detected": motion_vehicle,
                })
            except Exception as e:
                logger.debug("Error en detección webcam WS: %s", e)
            finally:
                is_busy = False
    except WebSocketDisconnect:
        logger.info("Cliente WebSocket de webcam desconectado normalmente.")
    except Exception as e:
        logger.debug("WebSocket webcam cerrado: %s", e)


def _denegado() -> JSONResponse:
    return JSONResponse({"error": "Token de servicio requerido"}, status_code=401)


@app.get("/debug/stream")
def debug_stream(request: Request):
    """Stream MJPEG anotado (diagnóstico; requiere X-Servicio-Token)."""
    if not token_servicio_valido(request.headers.get("X-Servicio-Token")):
        return _denegado()
    return StreamingResponse(
        mjpeg_generator(_debug_buffer, target_fps=30.0),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get("/stream/preview")
@app.get("/api/stream/preview")
async def stream_preview(request: Request, url: str = Query(..., description="RTSP URL o fuente de video a previsualizar")):
    """
    Stream MJPEG de prueba directamente desde una URL RTSP (requiere X-Servicio-Token:
    abre conexiones salientes a la URL indicada).
    """
    if not token_servicio_valido(request.headers.get("X-Servicio-Token")):
        return _denegado()
    return StreamingResponse(
        rtsp_direct_preview_generator(url, target_fps=25.0),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


_camera_switch_lock = threading.Lock()
_browser_busy_lock = threading.Lock()


@app.post("/api/camera/switch")
async def switch_active_camera(request: Request):
    """
    Cambia dinámicamente la fuente de video y cámara activa del motor ANPR en caliente.
    Permite conmutar entre cámaras IP / RTSP y la webcam local sin reiniciar el servicio.
    Protegido contra llamadas simultáneas y carreras de hilos.
    """
    global _video_source, CAMERA_ID, CAMERA_SOURCE
    if not token_servicio_valido(request.headers.get("X-Servicio-Token")):
        return _denegado()
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    camera_id = int(payload.get("camera_id", 1))
    source_type = str(payload.get("source_type", "rtsp")).lower().strip()
    rtsp_url = payload.get("rtsp_url")
    nombre = payload.get("nombre", "Cámara Activa")
    force = bool(payload.get("force", False))
    # Región de interés de la cámara (lista de vértices normalizados; ausente = sin cambio)
    if "roi" in payload and _pipeline:
        _pipeline.set_roi(payload.get("roi"))

    logger.info("Solicitud de cambio de cámara activa ANPR: ID %d | %s | %s | force=%s", camera_id, source_type, _sin_credenciales(rtsp_url) or "", force)

    with _camera_switch_lock:
        old_source = _video_source
        if source_type == "webcam":
            src_str = "webcam"
        else:
            src_str = rtsp_url or RTSP_URL

        # Evitar reiniciar si la cámara solicitada ya está activa, conectada y no se forzó reconexión
        is_running = old_source and getattr(old_source, "_grab_running", False) and getattr(old_source, "is_connected", False)
        if not force and is_running and getattr(old_source, "_url", None) == src_str and CAMERA_ID == camera_id:
            logger.info("Cámara ID %d (%s) ya activa y conectada.", camera_id, _sin_credenciales(src_str))
            return {
                "success": True,
                "message": f"Cámara ID {camera_id} ya se encuentra activa",
                "camera_id": CAMERA_ID,
                "camera_source": _sin_credenciales(CAMERA_SOURCE),
            }

        try:
            if source_type == "webcam":
                new_src = WebcamSource(index=WEBCAM_INDEX)
            else:
                new_src = RTSPSource(url=src_str)

            new_src._name = nombre
            new_src._url = src_str

            # Actualizar pantalla de transición de inmediato para no congelar ni mostrar canal previo
            standby = _render_standby_frame(nombre, src_str)
            _debug_buffer.update(standby)

            _video_source = new_src
            CAMERA_ID = camera_id
            CAMERA_SOURCE = src_str

            # Conectar en segundo plano
            threading.Thread(target=new_src.connect, daemon=True, name="CamConnect").start()

            # Limpiar buffers de tracks, consensos y detecciones para el nuevo canal
            if _pipeline:
                _pipeline.clear_all_tracks()
            if _frame_selector:
                _frame_selector._active_candidates.clear()
                _frame_selector._captured_history.clear()
                _frame_selector._prev_area.clear()
                _frame_selector._track_first_seen.clear()

            # Liberar la fuente anterior de forma segura
            if old_source:
                threading.Thread(target=old_source.release, daemon=True, name="CamRelease").start()

            return {
                "success": True,
                "message": f"Cámara cambiada exitosamente a ID {camera_id} ({nombre})",
                "camera_id": CAMERA_ID,
                "camera_source": _sin_credenciales(CAMERA_SOURCE),
            }
        except Exception as e:
            logger.error("Error al cambiar fuente de video: %s", e)
            return JSONResponse({"error": f"Error al cambiar cámara: {str(e)}"}, status_code=500)



@app.post("/api/camera/roi")
async def fijar_region_interes(request: Request):
    """
    Región de interés de la cámara activa (equivalente a la "detection mask" de OpenALPR):
    {"roi": [[x, y], ...]} con coordenadas normalizadas 0–1, o {"roi": null} para usar el
    cuadro completo. Solo se buscan placas cuyo centro cae dentro del polígono.
    """
    if not token_servicio_valido(request.headers.get("X-Servicio-Token")):
        return _denegado()
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "JSON inválido"}, status_code=400)
    if not _pipeline:
        return JSONResponse({"error": "Motor no iniciado"}, status_code=503)
    camara = payload.get("camara_id")
    if camara is not None and int(camara) != CAMERA_ID:
        # La región pertenece a otra cámara: se aplicará cuando esa cámara se active
        return {"success": True, "aplicada": False, "roi": _pipeline.roi}
    return {"success": True, "aplicada": True, "roi": _pipeline.set_roi(payload.get("roi"))}


@app.get("/api/camera/active")
def get_active_camera():
    """Retorna la cámara y fuente actualmente activas en el motor ANPR."""
    is_conn = _video_source.is_connected if _video_source else False
    if not is_conn and _capture_fps >= 10.0:
        is_conn = True
    return {
        "camera_id": CAMERA_ID,
        "camera_source": _sin_credenciales(CAMERA_SOURCE),
        "is_connected": is_conn,
        "roi": _pipeline.roi if _pipeline else None,
    }



def _model_info() -> dict:
    """Modelos realmente cargados (detector, OCR principal y verificador)."""
    ocr = getattr(getattr(_ocr_worker, "_agent", None), "_ocr", None)
    verifier = get_verifier() if _running else None
    return {
        "detector": os.path.basename(getattr(getattr(_pipeline, "detector", None), "model_path", "") or "") or None,
        "ocr_engine": f"{getattr(ocr, 'engine_name', '?')} ({getattr(ocr, 'model_id', '?')})" if ocr else None,
        "ocr_verifier": verifier.description if verifier else None,
    }


@app.get("/status")
def get_status():
    """Estado y métricas de rendimiento del microservicio."""
    return {
        "status": "online",
        "running": _running,
        "camera_source": _sin_credenciales(CAMERA_SOURCE),
        "capture_fps": round(_capture_fps, 1),
        "tracker_fps": round(_pipeline.fps if _pipeline else 0.0, 1),
        **_model_info(),
        "architecture": "Two-Phase: Fast Capture + Async OCR",
    }


@app.get("/metrics")
def get_prometheus_metrics():
    """Endpoint de métricas Prometheus."""
    from fastapi.responses import Response
    return Response(content=get_metrics(), media_type="text/plain")


@app.post("/process/frame")
@app.post("/api/process/frame")
async def process_browser_frame(file: UploadFile = File(...), ticket: str | None = Query(None)):
    """
    Endpoint para procesar fotogramas en vivo capturados por la webcam del navegador.
    Descarta fotogramas si el hilo previo sigue ocupado para garantizar cero retrasos (<30ms).
    Requiere un ticket de alcance "webcam".
    """
    global _pipeline, _frame_selector, _ocr_worker, _debug_buffer
    if not ticket_valido(ticket, "webcam"):
        return JSONResponse({"error": "Ticket inválido o vencido"}, status_code=401)

    # Descartar fotograma si la inferencia previa aún no finaliza (Zero Latency Drop)
    if not _browser_busy_lock.acquire(blocking=False):
        return {"success": True, "rois": [], "dropped": True}

    try:
        t_start = time.perf_counter()
        contents = await file.read()
        if not contents or len(contents) == 0:
            return JSONResponse({"error": "Fotograma vacío"}, status_code=400)
        nparr = np.frombuffer(contents, np.uint8)
        if nparr.size == 0:
            return JSONResponse({"error": "Buffer de imagen inválido"}, status_code=400)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if frame is None or frame.size == 0:
            return JSONResponse({"error": "No se pudo decodificar el fotograma"}, status_code=400)

        # 1. Detección rápida — modelo browser dedicado @ 384px, sin contención con loop RTSP
        loop = asyncio.get_event_loop()
        t0_det = time.perf_counter()
        tracked_rois = await loop.run_in_executor(
            _browser_executor,
            _pipeline.detect_fast,
            frame,
        ) if _pipeline else []
        t_det = (time.perf_counter() - t0_det) * 1000
        active_ids = {roi.tracking_id for roi in tracked_rois}

        # 2. Inferencia OCR desacoplada asíncrona (0ms bloqueo — fire-and-forget)
        for roi in tracked_rois:
            info = _pipeline.get_track_info(roi.tracking_id) if _pipeline else {}
            if not info.get("plate"):
                bx1, by1, bx2, by2 = roi.plate_bbox
                if (bx2 - bx1) >= 20 and (by2 - by1) >= 8:
                    _enqueue_async_ocr(roi.tracking_id, frame.copy(), roi.plate_bbox)

        # 3. Evaluación de nitidez y disparo de captura fotográfica (no bloqueante)
        if _frame_selector and _ocr_worker:
            frame_idx = int(time.time() * 30)
            for roi in tracked_rois:
                selected = _frame_selector.evaluate_and_select(
                    tracking_id=roi.tracking_id,
                    frame=frame,
                    plate_bbox=roi.plate_bbox,
                    confidence=roi.confidence,
                    frame_idx=frame_idx,
                )
                if selected is not None:
                    _trigger_photo_capture(selected, _ocr_worker)

            # Tracks que salieron de cuadro
            exited = _frame_selector.cleanup_stale_tracks(active_ids)
            for cand in exited:
                _trigger_photo_capture(cand, _ocr_worker)

        motion_bbox, motion_pct, motion_vehicle = _pipeline.get_motion_info() if _pipeline else (None, 0, False)
        rois_data = []
        for r in tracked_rois:
            info = _pipeline.get_browser_track_info(r.tracking_id) if _pipeline else {}
            rois_data.append({
                "tracking_id": r.tracking_id,
                "confidence": round(r.confidence, 3),
                "bbox": r.plate_bbox,
                "oriented_box": getattr(r, "oriented_box", []),
                "velocity": getattr(r, "velocity", [0.0, 0.0]),
                "plate": info.get("plate", ""),
                "status": info.get("status", ""),
                "plate_confidence": round(info.get("confidence", 0.0), 3),
            })

        # Actualizar buffer de debug en background (no bloquea la respuesta HTTP)
        if _pipeline:
            frame_for_debug = frame.copy()
            _disk_executor.submit(
                lambda f: _debug_buffer.update(_pipeline.draw_overlays(f, capture_fps=30.0, inference_fps=_pipeline.fps)),
                frame_for_debug,
            )

        t_total = (time.perf_counter() - t_start) * 1000
        if t_total > 50:
            logger.info("process_browser_frame en %.1f ms (detección: %.1f ms)", t_total, t_det)

        return {
            "success": True,
            "rois": rois_data,
            "motion_bbox": motion_bbox,
            "motion_pct": motion_pct,
            "motion_vehicle_detected": motion_vehicle,
        }

    except Exception as e:
        logger.error("Error en process_browser_frame: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)
    finally:
        _browser_busy_lock.release()



@app.get("/")
def root():
    return {
        "service": "ECU 911 ANPR Microservice",
        "version": "2.0.0",
        "status": "running" if _running else "starting",
        **_model_info(),
    }
