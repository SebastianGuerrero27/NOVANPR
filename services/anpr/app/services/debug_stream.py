"""
Servicio de depuración visual del pipeline ANPR.

Proporciona:
  1. DebugFrameBuffer: buffer thread-safe del último frame anotado
  2. mjpeg_generator: generador async de frames para endpoint MJPEG
  3. Soporte para cv2.imshow() en entorno local (no Docker)

El endpoint MJPEG permite ver los bounding boxes, tracking IDs y texto OCR
desde cualquier navegador, incluso cuando el servicio corre en Docker.
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import AsyncGenerator, Optional

import cv2
import numpy as np

from app.utils.logger import get_logger

logger = get_logger("debug_stream")


class DebugFrameBuffer:
    """
    Buffer thread-safe para el último frame anotado del pipeline.
    Pre-codifica en JPEG en el momento de actualización para entrega en 0ms.
    """

    def __init__(self) -> None:
        self._frame: Optional[np.ndarray] = None
        self._latest_jpeg: Optional[bytes] = None
        self._lock = threading.Lock()
        self._jpeg_quality = 65  # Balance óptimo calidad visual y compresión ultra-rápida (~5ms)
        self._frame_available = threading.Event()
        self._frame_counter: int = 0
        self._target_height: int = 540

    def update(self, frame: np.ndarray) -> None:
        """
        Actualiza el frame actual, aplica downscale optimizado para visualización web
        y pre-codifica el JPEG inmediatamente en ~5ms en lugar de 40ms.
        """
        if frame is None or frame.size == 0:
            return

        h, w = frame.shape[:2]
        if h > self._target_height:
            new_h = self._target_height
            new_w = max(2, int(w * (self._target_height / float(h))))
            new_w = new_w if new_w % 2 == 0 else new_w + 1
            display_frame = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
        else:
            display_frame = frame

        # Codificación JPEG rápida en el hilo de captura
        encode_params = [cv2.IMWRITE_JPEG_QUALITY, self._jpeg_quality]
        success, buffer = cv2.imencode(".jpg", display_frame, encode_params)
        jpeg_bytes = buffer.tobytes() if success else None

        with self._lock:
            self._frame = display_frame
            self._latest_jpeg = jpeg_bytes
            self._frame_counter += 1

        self._frame_available.set()

    def get_latest(self) -> Optional[np.ndarray]:
        with self._lock:
            if self._frame is None:
                return None
            return self._frame.copy()

    def get_latest_jpeg(self) -> Optional[bytes]:
        """Retorna los bytes JPEG pre-codificados instantáneamente en 0ms."""
        with self._lock:
            return self._latest_jpeg

    def get_latest_jpeg_and_counter(self) -> tuple[Optional[bytes], int]:
        """Retorna el JPEG pre-codificado y el contador secuencial para deduplicación exacta."""
        with self._lock:
            return self._latest_jpeg, self._frame_counter

    @property
    def has_frame(self) -> bool:
        with self._lock:
            return self._latest_jpeg is not None

    def clear(self) -> None:
        """Limpia el buffer para que el endpoint sirva el gráfico de standby."""
        with self._lock:
            self._frame = None
            self._latest_jpeg = None

    def wait_for_frame(self, timeout: float = 5.0) -> bool:
        return self._frame_available.wait(timeout=timeout)


_standby_jpeg_cache: Optional[bytes] = None

def _get_standby_jpeg(width: int = 960, height: int = 540) -> bytes:
    global _standby_jpeg_cache
    if _standby_jpeg_cache is not None:
        return _standby_jpeg_cache

    frame = np.zeros((height, width, 3), dtype=np.uint8)
    frame[:] = (24, 15, 11)  # Navy dark background #0b0f18

    # Líneas de cuadrícula tenue
    for y in range(0, height, 40):
        cv2.line(frame, (0, y), (width, y), (35, 25, 18), 1)
    for x in range(0, width, 40):
        cv2.line(frame, (x, 0), (x, height), (35, 25, 18), 1)

    # Cabecera
    cv2.rectangle(frame, (0, 0), (width, 46), (30, 20, 15), -1)
    cv2.putText(frame, "ECU 911 ZONA 3 | MONITOR DE CONTROL DE ACCESO", (25, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (240, 240, 240), 2, cv2.LINE_AA)

    # Cuadro de Estado Central
    cx, cy = width // 2, height // 2
    cv2.rectangle(frame, (cx - 310, cy - 70), (cx + 310, cy + 70), (35, 20, 15), -1)
    cv2.rectangle(frame, (cx - 310, cy - 70), (cx + 310, cy + 70), (70, 130, 180), 2)

    cv2.putText(frame, "CAMARA HIKVISION APAGADA / EN ESPERA", (cx - 280, cy - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.70, (0, 215, 255), 2, cv2.LINE_AA)
    cv2.putText(frame, "IP Objetivo: rtsp://10.126.9.104:554/Streaming/Channels/101", (cx - 260, cy + 15), cv2.FONT_HERSHEY_SIMPLEX, 0.50, (200, 200, 200), 1, cv2.LINE_AA)
    cv2.putText(frame, "El video iniciara automaticamente al conectar la camara", (cx - 230, cy + 45), cv2.FONT_HERSHEY_SIMPLEX, 0.46, (140, 180, 220), 1, cv2.LINE_AA)

    # Pie
    cv2.putText(frame, "Estado: Camara Fisica en Standby (Sin simulacion activa)", (25, height - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (130, 130, 130), 1, cv2.LINE_AA)

    _, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 60])
    _standby_jpeg_cache = buffer.tobytes()
    return _standby_jpeg_cache


async def mjpeg_generator(
    buffer: DebugFrameBuffer,
    target_fps: float = 30.0,
) -> AsyncGenerator[bytes, None]:
    """
    Generador async de alta velocidad para stream MJPEG a 30 FPS en vivo.
    Sincronizado por fotograma nuevo para no saturar el socket del navegador ni acumular latencia.
    """
    frame_interval = 1.0 / max(1.0, target_fps)
    logger.info("Stream MJPEG iniciado en vivo (target: %.1f FPS)", target_fps)
    last_counter = -1

    while True:
        t0 = asyncio.get_event_loop().time()
        jpeg, counter = buffer.get_latest_jpeg_and_counter()

        if jpeg is None:
            jpeg = _get_standby_jpeg()
            last_counter = -1
        elif counter == last_counter:
            # Si aún no hay nuevo fotograma producido, pausa breve para no quemar ciclos
            await asyncio.sleep(0.005)
            continue
        else:
            last_counter = counter

        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n"
            b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n"
            b"\r\n" + jpeg + b"\r\n"
        )

        # Ceder control al bucle de eventos sin agregar retardo artificial
        await asyncio.sleep(0.002)


async def rtsp_direct_preview_generator(
    rtsp_url: str,
    target_fps: float = 25.0,
) -> AsyncGenerator[bytes, None]:
    """
    Genera un stream MJPEG directo desde una URL RTSP específica para pruebas y previsualización.
    Muestra un banner institucional y pantalla táctica de espera si el canal está conectando.
    """
    frame_interval = 1.0 / max(1.0, target_fps)
    loop = asyncio.get_event_loop()

    import os
    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (
        "stimeout;2500000"
        "|timeout;2500000"
        "|rtsp_transport;tcp"
        "|fflags;nobuffer"
        "|flags;low_delay"
        "|max_delay;200000"
    )

    cap: Optional[cv2.VideoCapture] = None
    last_connect_try = 0.0

    def _open_cap():
        c = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
        if c.isOpened():
            c.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return c

    def _read_frame(c):
        if c and c.isOpened():
            return c.read()
        return False, None

    try:
        while True:
            t0 = loop.time()
            now = time.time()
            frame = None

            if cap is None or not cap.isOpened():
                if now - last_connect_try >= 2.0:
                    last_connect_try = now
                    try:
                        cap = await loop.run_in_executor(None, _open_cap)
                    except Exception as e:
                        logger.debug("Error abriendo RTSP: %s", e)
                        cap = None

            if cap is not None and cap.isOpened():
                ret, frame = await loop.run_in_executor(None, _read_frame, cap)
                if not ret or frame is None:
                    try:
                        cap.release()
                    except Exception:
                        pass
                    cap = None

            if frame is not None:
                h, w = frame.shape[:2]
                cv2.rectangle(frame, (0, 0), (w, 34), (11, 19, 41), -1)
                cv2.putText(
                    frame,
                    f"PREVISUALIZACION RTSP EN VIVO | {rtsp_url}",
                    (14, 22),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.50,
                    (0, 240, 255),
                    1,
                    cv2.LINE_AA,
                )
                _, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                jpeg_bytes = buffer.tobytes()
            else:
                canvas = np.zeros((480, 720, 3), dtype=np.uint8)
                canvas[:] = (18, 16, 15)

                cv2.rectangle(canvas, (0, 0), (720, 42), (30, 24, 20), -1)
                cv2.putText(canvas, "ECU 911 VIGS | PREVISUALIZACION DE CANAL RTSP", (20, 27), cv2.FONT_HERSHEY_SIMPLEX, 0.60, (240, 240, 240), 2, cv2.LINE_AA)

                cx, cy = 360, 240
                cv2.rectangle(canvas, (cx - 320, cy - 80), (cx + 320, cy + 80), (32, 22, 18), -1)
                cv2.rectangle(canvas, (cx - 320, cy - 80), (cx + 320, cy + 80), (0, 165, 255), 2)

                cv2.putText(canvas, "EN ESPERA DE TRANSMISION RTSP", (cx - 260, cy - 30), cv2.FONT_HERSHEY_SIMPLEX, 0.70, (0, 215, 255), 2, cv2.LINE_AA)
                cv2.putText(canvas, f"URL: {rtsp_url}", (cx - 300, cy + 10), cv2.FONT_HERSHEY_SIMPLEX, 0.46, (200, 200, 200), 1, cv2.LINE_AA)
                cv2.putText(canvas, "Inicie la transmision en su aplicacion movil o valide la IP y puerto.", (cx - 300, cy + 45), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (140, 180, 220), 1, cv2.LINE_AA)

                cv2.putText(canvas, "Estado: Reintentando conexion automaticamente cada 2s...", (20, 460), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (130, 130, 130), 1, cv2.LINE_AA)

                _, buffer = cv2.imencode(".jpg", canvas, [cv2.IMWRITE_JPEG_QUALITY, 60])
                jpeg_bytes = buffer.tobytes()

            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n"
                b"Content-Length: " + str(len(jpeg_bytes)).encode() + b"\r\n\r\n" +
                jpeg_bytes + b"\r\n"
            )

            elapsed = loop.time() - t0
            remaining = frame_interval - elapsed
            if remaining > 0.001:
                await asyncio.sleep(remaining)
            else:
                await asyncio.sleep(0.001)

    finally:
        if cap is not None:
            try:
                cap.release()
                logger.info("Stream RTSP de prueba finalizado para: %s", rtsp_url)
            except Exception:
                pass



def try_imshow(window_name: str, frame: np.ndarray) -> bool:
    """
    Intenta mostrar un frame con cv2.imshow().

    Retorna False silenciosamente si no hay display disponible
    (Docker, SSH, servidor headless). Esto permite que el mismo código
    funcione en local (con ventana) y en Docker (sin ventana).

    Args:
        window_name: Nombre de la ventana.
        frame: Frame BGR a mostrar.

    Returns:
        True si se mostró exitosamente, False si no hay display.
    """
    try:
        cv2.imshow(window_name, frame)
        key = cv2.waitKey(1) & 0xFF
        # 'q' para cerrar la ventana de debug
        if key == ord("q"):
            cv2.destroyAllWindows()
            logger.info("Ventana de debug cerrada por el usuario (tecla 'q').")
            return False
        return True
    except cv2.error:
        # No hay display disponible (Docker, headless, etc.)
        return False
