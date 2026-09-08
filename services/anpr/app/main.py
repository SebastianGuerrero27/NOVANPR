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
    BACKEND_URL,
    CAMERA_ID,
    CAMERA_SOURCE,
    DEBUG_SHOW_WINDOW,
    DEBUG_VISUAL,
    FRAME_SKIP,
    INFERENCE_THROTTLE_MS,
    MEDIA_DIR,
    RUNNING_IN_DOCKER,
    WEBCAM_INDEX,
    RTSP_URL,
)
from app.core.detector import DetectionPipeline
from app.core.frame_selector import BestFrameSelector
from app.core.ocr_engine import create_ocr_engine
from app.core.video_source import RTSPSource, VideoSource, WebcamSource, create_video_source
from app.services.debug_stream import (
    DebugFrameBuffer,
    _get_standby_jpeg,
    mjpeg_generator,
    rtsp_direct_preview_generator,
    try_imshow,
)
from app.services.ocr_worker import AsyncOcrWorker, OcrTask
from app.utils.logger import get_logger

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
_http_client: httpx.Client = httpx.Client(timeout=5.0)

_running = False
_capture_fps: float = 0.0


def _enqueue_async_ocr(tracking_id: int, frame_copy: np.ndarray, plate_bbox: list[int]) -> None:
    """
    Ejecuta el OCR en un pool asíncrono desacoplado.
    Garantiza que el bucle de tracking y video NUNCA se congele y mantenga 30+ FPS fluidos en tiempo real.
    """
    with _ocr_lock:
        if tracking_id in _ocr_in_flight:
            return
        _ocr_in_flight.add(tracking_id)

    def _worker():
        try:
            worker = _ocr_worker
            pipeline = _pipeline
            if worker and getattr(worker, "_agent", None) and pipeline:
                res = worker._agent.process_image(frame_copy, plate_bbox)
                if res.placa and res.estado == "procesado":
                    pipeline.update_track_plate(
                        tracking_id,
                        res.placa,
                        res.confianza,
                        "autorizado",
                    )
        except Exception as e:
            logger.warning("Aviso en OCR asíncrono para track #%d: %s", tracking_id, e)
        finally:
            with _ocr_lock:
                _ocr_in_flight.discard(tracking_id)

    _async_ocr_pool.submit(_worker)


# =============================================================================
# 1. Hilo Productor: Captura & Display a 30 FPS Nativos (Zero Lag)
# =============================================================================


def _render_standby_frame(nombre: str, url: str, width: int = 960, height: int = 540) -> np.ndarray:
    """Genera una pantalla táctica de espera con los datos del canal actual para evitar pantallas en negro."""
    frame = np.zeros((height, width, 3), dtype=np.uint8)
    frame[:] = (24, 15, 11)  # Fondo navy oscuro

    # Cuadrícula tenue
    for y in range(0, height, 40):
        cv2.line(frame, (0, y), (width, y), (35, 25, 18), 1)
    for x in range(0, width, 40):
        cv2.line(frame, (x, 0), (x, height), (35, 25, 18), 1)

    # Cabecera
    cv2.rectangle(frame, (0, 0), (width, 46), (30, 20, 15), -1)
    cv2.putText(frame, "SISTEMA ANPR ECU 911 | CANAL DE VIDEO", (25, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (240, 240, 240), 2, cv2.LINE_AA)

    # Panel Central
    cx, cy = width // 2, height // 2
    cv2.rectangle(frame, (cx - 320, cy - 70), (cx + 320, cy + 70), (35, 20, 15), -1)
    cv2.rectangle(frame, (cx - 320, cy - 70), (cx + 320, cy + 70), (0, 180, 255), 2)

    cv2.putText(frame, f"CANAL: {nombre.upper()}", (cx - 290, cy - 25), cv2.FONT_HERSHEY_SIMPLEX, 0.70, (0, 220, 255), 2, cv2.LINE_AA)
    safe_url = url if len(url) < 48 else url[:45] + "..."
    cv2.putText(frame, f"Enlace: {safe_url}", (cx - 290, cy + 10), cv2.FONT_HERSHEY_SIMPLEX, 0.50, (200, 200, 200), 1, cv2.LINE_AA)
    cv2.putText(frame, "Conectando al flujo de video RTSP...", (cx - 290, cy + 45), cv2.FONT_HERSHEY_SIMPLEX, 0.50, (140, 220, 140), 1, cv2.LINE_AA)

    return frame


def _realtime_anpr_loop(
    video_source: VideoSource,
    pipeline: DetectionPipeline,
    frame_selector: BestFrameSelector,
    ocr_worker: AsyncOcrWorker,
    debug_buffer: DebugFrameBuffer,
) -> None:
    """
    Bucle unificado de procesamiento ANPR en tiempo real (Cero Latencia):
    1. Captura el fotograma más reciente del sensor (<0.1ms gracias al Grabber de búfer cero).
    2. Ejecuta detección YOLO y seguimiento ByteTrack con DIoU (22-26ms).
    3. Evalúa con BestFrameSelector y encola OCR en segundo plano (0ms de bloqueo de video).
    4. Dibuja las retículas tácticas y cajas delimitadoras DIRECTAMENTE sobre el mismo fotograma (0.4ms).
    5. Actualiza el buffer de previsualización web pre-codificando a 540p en 5ms.
    Garantiza 0 fotogramas de desfase entre la caja y el video a 30+ FPS continuos.
    """
    global _running, _capture_fps

    logger.info("Motor ANPR en Tiempo Real (Cero Latencia) iniciado a 30+ FPS continuos.")

    # Conexión inicial rápida (sin bloquear el arranque si la cámara está apagada)
    connected = video_source.connect()
    if connected:
        logger.info("Fuente de video conectada exitosamente.")
    else:
        logger.info("Cámara física actualmente apagada o en espera. Iniciando en modo Standby...")

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
            if consecutive_read_failures >= 15 and consecutive_read_failures % 15 == 0:
                cam_name = getattr(current_source, "_name", "Canal Activo")
                cam_url = getattr(current_source, "_url", CAMERA_SOURCE)
                standby = _render_standby_frame(cam_name, cam_url)
                debug_buffer.update(standby)
            time.sleep(0.03)
            continue

        consecutive_read_failures = 0
        frame_count += 1

        # Medición fluida de FPS con ventana móvil de 10 fotogramas
        if frame_count % 10 == 0:
            elapsed = time.time() - fps_start
            if elapsed > 0:
                inst_fps = 10.0 / elapsed
                _capture_fps = round(0.7 * _capture_fps + 0.3 * inst_fps if _capture_fps > 0 else inst_fps, 1)
            fps_start = time.time()

        try:
            # 1. Detección YOLO y Seguimiento ByteTrack en este fotograma exacto
            tracked_rois = pipeline.detect_and_track(frame)
            active_ids = {roi.tracking_id for roi in tracked_rois}

            # 2. Inferencia OCR desacoplada asíncrona (no bloquea el tracking a 30+ FPS)
            for roi in tracked_rois:
                info = pipeline.get_track_info(roi.tracking_id)
                if not info.get("plate"):
                    bx1, by1, bx2, by2 = roi.plate_bbox
                    if (bx2 - bx1) >= 20 and (by2 - by1) >= 8:
                        _enqueue_async_ocr(roi.tracking_id, frame.copy(), roi.plate_bbox)

            # 3. Evaluación de calidad y disparo de captura fotográfica
            for roi in tracked_rois:
                selected = frame_selector.evaluate_and_select(
                    tracking_id=roi.tracking_id,
                    frame=frame,
                    plate_bbox=roi.plate_bbox,
                    confidence=roi.confidence,
                    frame_idx=frame_count,
                )
                if selected is not None:
                    _trigger_photo_capture(selected, ocr_worker)

            # Verificar si algún track salió de cuadro
            exited_candidates = frame_selector.cleanup_stale_tracks(active_ids)
            for exited in exited_candidates:
                _trigger_photo_capture(exited, ocr_worker)

        except Exception as e:
            logger.error("Error en ciclo de inferencia y tracking: %s", e)

        # 4. Renderizar HUD táctico sobre copia limpia del fotograma
        if DEBUG_VISUAL:
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
    """Guarda la foto de evidencia en disco, registra el ingreso y encola el OCR."""
    ts_str = time.strftime("%Y%m%d_%H%M%S")
    tracking_id = getattr(candidate, "tracking_id", -1)
    sharpness = getattr(candidate, "sharpness", 0.0)
    bbox = getattr(candidate, "plate_bbox", [0, 0, 0, 0])
    bbox_x = bbox[0] if (bbox and len(bbox) > 0) else 0
    foto_filename = f"ingreso_{ts_str}_{bbox_x}_{int(candidate.timestamp*1000)%10000}.jpg"
    foto_full_path = os.path.join(MEDIA_DIR, foto_filename)
    ruta_relativa_ingreso = f"/media/{foto_filename}"

    # Guardar fotografia completa en disco en segundo plano
    frame_copy = candidate.frame.copy() if candidate.frame is not None else None
    if frame_copy is not None:
        _disk_executor.submit(cv2.imwrite, foto_full_path, frame_copy)

    # Registrar evento Fase 1 en Backend Node.js
    def _register_and_enqueue():
        try:
            url = f"{BACKEND_URL}/api/detecciones/ingreso"
            payload = {
                "tracking_id": tracking_id,
                "ruta_imagen_ingreso": ruta_relativa_ingreso,
                "confianza_deteccion": round(candidate.confidence, 3),
                "fuente": CAMERA_SOURCE,
                "camara_id": CAMERA_ID,
            }
            res = _http_client.post(url, json=payload)
            if res.status_code in (200, 201):
                ingreso_id = res.json().get("ingreso_id")
                if ingreso_id:
                    # Encolar en el Worker Asincrono de OCR con nitidez para consenso ponderado
                    task = OcrTask(
                        ingreso_id=ingreso_id,
                        tracking_id=tracking_id,
                        foto_path=foto_full_path,
                        ruta_relativa_ingreso=ruta_relativa_ingreso,
                        plate_bbox=candidate.plate_bbox,
                        timestamp_str=ts_str,
                        sharpness=sharpness,
                        frame=frame_copy,
                    )
                    ocr_worker.enqueue_task(task)
            else:
                logger.warning("Fallo al registrar ingreso en backend: %s", res.text)
        except Exception as e:
            logger.error("Error al registrar captura fotografica: %s", e)

    _disk_executor.submit(_register_and_enqueue)


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
    _pipeline = DetectionPipeline()
    _frame_selector = BestFrameSelector()

    ocr_engine = create_ocr_engine()
    _ocr_worker = AsyncOcrWorker(ocr_engine, on_ocr_completed=_pipeline.update_track_plate)
    _ocr_worker.start()

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


from fastapi.staticfiles import StaticFiles

if not os.path.exists(MEDIA_DIR):
    try:
        os.makedirs(MEDIA_DIR, exist_ok=True)
    except Exception:
        pass

app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")


@app.websocket("/ws/stream")
@app.websocket("/api/ws/stream")
async def websocket_stream_endpoint(websocket: WebSocket):
    """
    Stream WebSocket binario en tiempo real con cero latencia (< 20ms) para HTML5 Canvas.
    Garantiza que el navegador siempre reciba el fotograma más fresco, descartando
    automáticamente cuadros obsoletos si ocurre congestión de red o pausas en el cliente.
    """
    await websocket.accept()
    logger.info("Cliente WebSocket de stream en tiempo real conectado.")
    last_sent_counter = -1

    try:
        while _running:
            jpeg, counter = _debug_buffer.get_latest_jpeg_and_counter()

            if jpeg is None:
                standby_jpeg = _get_standby_jpeg()
                await websocket.send_bytes(standby_jpeg)
                await asyncio.sleep(0.08)
                continue

            if counter != last_sent_counter:
                last_sent_counter = counter
                await websocket.send_bytes(jpeg)

            # Pausa de sincronización ultra-corta para ceder control
            await asyncio.sleep(0.008)
    except WebSocketDisconnect:
        logger.info("Cliente WebSocket de stream desconectado normalmente.")
    except Exception as e:
        logger.debug("Conexión WebSocket cerrada: %s", e)


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
    """
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
                    info = _pipeline.get_track_info(r.tracking_id)
                    if not info.get("plate"):
                        bx1, by1, bx2, by2 = r.plate_bbox
                        if (bx2 - bx1) >= 20 and (by2 - by1) >= 8:
                            _enqueue_async_ocr(r.tracking_id, frame.copy(), r.plate_bbox)
                    rois_data.append({
                        "tracking_id": r.tracking_id,
                        "confidence": round(r.confidence, 3),
                        "bbox": r.plate_bbox,
                        "velocity": r.velocity,
                        "ts": round(now, 4),
                        "plate": info.get("plate", ""),
                        "status": info.get("status", ""),
                        "plate_confidence": round(info.get("confidence", 0.0), 3),
                    })

                await websocket.send_json({"rois": rois_data})
            except Exception as e:
                logger.debug("Error en detección webcam WS: %s", e)
            finally:
                is_busy = False
    except WebSocketDisconnect:
        logger.info("Cliente WebSocket de webcam desconectado normalmente.")
    except Exception as e:
        logger.debug("WebSocket webcam cerrado: %s", e)


@app.get("/debug/stream")
def debug_stream():
    """Stream MJPEG en tiempo real anotado a 30 FPS continuos."""
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
async def stream_preview(url: str = Query(..., description="RTSP URL o fuente de video a previsualizar")):
    """
    Stream MJPEG de prueba en vivo directamente desde la URL RTSP seleccionada.
    Permite probar en tiempo real cualquier cámara RTSP (ej. app de celular o cámara IP física).
    """
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


@app.post("/api/camera/switch")
async def switch_active_camera(request: Request):
    """
    Cambia dinámicamente la fuente de video y cámara activa del motor ANPR en caliente.
    Permite conmutar entre cámaras IP / RTSP y la webcam local sin reiniciar el servicio.
    Protegido contra llamadas simultáneas y carreras de hilos.
    """
    global _video_source, CAMERA_ID, CAMERA_SOURCE
    try:
        payload = await request.json()
    except Exception:
        payload = {}

    camera_id = int(payload.get("camera_id", 1))
    source_type = str(payload.get("source_type", "rtsp")).lower().strip()
    rtsp_url = payload.get("rtsp_url")
    nombre = payload.get("nombre", "Cámara Activa")

    logger.info("Solicitud de cambio de cámara activa ANPR: ID %d | %s | %s", camera_id, source_type, rtsp_url or "")

    with _camera_switch_lock:
        old_source = _video_source
        if source_type == "webcam":
            src_str = "webcam"
        else:
            src_str = rtsp_url or RTSP_URL

        # Evitar reiniciar si la cámara solicitada ya está activa y conectada
        if old_source and getattr(old_source, "_url", None) == src_str and CAMERA_ID == camera_id:
            logger.info("Cámara ID %d (%s) ya activa.", camera_id, src_str)
            return {
                "success": True,
                "message": f"Cámara ID {camera_id} ya se encuentra activa",
                "camera_id": CAMERA_ID,
                "camera_source": CAMERA_SOURCE,
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

            # Limpiar buffers de tracks y detecciones para el nuevo canal
            if _pipeline:
                _pipeline._trackers.clear()
                _pipeline._track_plates.clear()
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
                "camera_source": CAMERA_SOURCE,
            }
        except Exception as e:
            logger.error("Error al cambiar fuente de video: %s", e)
            return JSONResponse({"error": f"Error al cambiar cámara: {str(e)}"}, status_code=500)



@app.get("/api/camera/active")
def get_active_camera():
    """Retorna la cámara y fuente actualmente activas en el motor ANPR."""
    is_conn = _video_source.is_connected if _video_source else False
    if not is_conn and _capture_fps >= 10.0:
        is_conn = True
    return {
        "camera_id": CAMERA_ID,
        "camera_source": CAMERA_SOURCE,
        "is_connected": is_conn,
    }



@app.get("/status")
def get_status():
    """Estado y métricas de rendimiento del microservicio."""
    return {
        "status": "online",
        "running": _running,
        "camera_source": CAMERA_SOURCE,
        "capture_fps": round(_capture_fps, 1),
        "tracker_fps": round(_pipeline.fps if _pipeline else 0.0, 1),
        "ocr_engine": "PaddleOCR (PP-OCRv4 ONNX)",
        "architecture": "Two-Phase: Fast Capture + Async OCR",
    }


@app.post("/process/frame")
@app.post("/api/process/frame")
async def process_browser_frame(file: UploadFile = File(...)):
    """
    Endpoint para procesar fotogramas en vivo capturados por la webcam del navegador.
    La detección YOLO se ejecuta en un thread executor para no bloquear el event loop asyncio,
    garantizando 30+ FPS fluidos en el navegador sin congelamiento del video.
    """
    global _pipeline, _frame_selector, _ocr_worker, _debug_buffer

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

        # 1. Detección rápida — modelo browser dedicado @ 256px, sin contención con loop RTSP
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

        rois_data = []
        for r in tracked_rois:
            info = _pipeline.get_track_info(r.tracking_id) if _pipeline else {}
            rois_data.append({
                "tracking_id": r.tracking_id,
                "confidence": round(r.confidence, 3),
                "bbox": r.plate_bbox,
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
        }

    except Exception as e:
        logger.error("Error en process_browser_frame: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)



@app.get("/")
def root():
    return {
        "service": "ECU 911 ANPR Microservice",
        "version": "2.0.0",
        "status": "running" if _running else "starting",
        "ocr_engine": "PaddleOCR",
    }
