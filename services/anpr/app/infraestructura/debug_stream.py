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
from typing import AsyncGenerator, Optional

import cv2
import numpy as np

from app.infraestructura.logger import get_logger

logger = get_logger("debug_stream")


class DebugFrameBuffer:
    """
    Buffer thread-safe del último frame anotado del pipeline.

    Codificación bajo demanda: el JPEG se genera solo cuando un cliente lo pide y se
    reutiliza entre clientes con los mismos parámetros (ancho máximo y calidad). Con
    `viewers` en cero el bucle de captura ni siquiera dibuja el HUD: ver video no tiene
    costo cuando nadie lo está mirando.
    """

    def __init__(self) -> None:
        self._frame: Optional[np.ndarray] = None
        self._lock = threading.Lock()
        self._jpeg_quality = 75
        self._frame_available = threading.Event()
        self._frame_counter: int = 0
        self._target_height: int = 540
        # (ancho_max, calidad) -> (contador del frame, bytes)
        self._variantes: dict[tuple[int, int], tuple[int, bytes]] = {}
        self._viewers = 0

    # --- Espectadores -------------------------------------------------------
    @property
    def viewers(self) -> int:
        return self._viewers

    def add_viewer(self) -> None:
        with self._lock:
            self._viewers += 1

    def remove_viewer(self) -> None:
        with self._lock:
            self._viewers = max(0, self._viewers - 1)

    # --- Frames -------------------------------------------------------------
    def update(self, frame: np.ndarray) -> None:
        """Guarda el frame (reducido a 540 px de alto como máximo) sin codificarlo."""
        if frame is None or frame.size == 0:
            return
        h, w = frame.shape[:2]
        if h > self._target_height:
            new_w = max(2, int(w * (self._target_height / float(h))))
            frame = cv2.resize(frame, (new_w + (new_w % 2), self._target_height), interpolation=cv2.INTER_AREA)
        with self._lock:
            self._frame = frame
            self._frame_counter += 1
        self._frame_available.set()

    def get_latest(self) -> Optional[np.ndarray]:
        with self._lock:
            return None if self._frame is None else self._frame.copy()

    def get_jpeg(self, max_width: int = 0, quality: int = 0) -> tuple[Optional[bytes], int]:
        """JPEG del último frame con el ancho máximo y la calidad pedidos (con caché por frame)."""
        quality = quality or self._jpeg_quality
        with self._lock:
            frame, counter = self._frame, self._frame_counter
            key = (max_width, quality)
            cached = self._variantes.get(key)
        if frame is None:
            return None, counter
        if cached and cached[0] == counter:
            return cached[1], counter
        h, w = frame.shape[:2]
        img = frame
        if max_width and w > max_width:
            img = cv2.resize(frame, (max_width, max(2, int(h * max_width / float(w)))), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if not ok:
            return None, counter
        data = buf.tobytes()
        with self._lock:
            self._variantes[key] = (counter, data)
            if len(self._variantes) > 8:
                self._variantes = {k: v for k, v in self._variantes.items() if v[0] == counter}
        return data, counter

    def get_latest_jpeg(self) -> Optional[bytes]:
        return self.get_jpeg()[0]

    def get_latest_jpeg_and_counter(self) -> tuple[Optional[bytes], int]:
        return self.get_jpeg()

    @property
    def has_frame(self) -> bool:
        with self._lock:
            return self._frame is not None

    def clear(self) -> None:
        """Limpia el buffer para que los clientes reciban la pantalla de espera."""
        with self._lock:
            self._frame = None
            self._variantes.clear()

    def wait_for_frame(self, timeout: float = 5.0) -> bool:
        return self._frame_available.wait(timeout=timeout)


_standby_jpeg_cache: Optional[bytes] = None

def _get_standby_jpeg(width: int = 960, height: int = 540) -> bytes:
    """Pantalla neutra de espera (sin datos de ninguna cámara concreta)."""
    global _standby_jpeg_cache
    if _standby_jpeg_cache is not None:
        return _standby_jpeg_cache

    frame = np.zeros((height, width, 3), dtype=np.uint8)
    frame[:] = (48, 23, 7)  # azul institucional #071730 (BGR)
    cx, cy = width // 2, height // 2
    cv2.putText(frame, "SIN SENAL DE VIDEO", (cx - 175, cy - 10), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (235, 235, 235), 2, cv2.LINE_AA)
    cv2.putText(frame, "Esperando la conexion con la camara", (cx - 190, cy + 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (180, 190, 205), 1, cv2.LINE_AA)
    cv2.rectangle(frame, (0, height - 6), (width, height), (28, 28, 185), -1)  # franja roja #b91c1c

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
    buffer.add_viewer()
    try:
        async for chunk in _mjpeg_loop(buffer, frame_interval):
            yield chunk
    finally:
        buffer.remove_viewer()


async def _mjpeg_loop(buffer: DebugFrameBuffer, frame_interval: float) -> AsyncGenerator[bytes, None]:
    last_counter = -1
    while True:
        t0 = asyncio.get_event_loop().time()
        jpeg, counter = buffer.get_latest_jpeg_and_counter()

        espera = frame_interval
        if jpeg is None:
            jpeg = _get_standby_jpeg()
            last_counter = -1
            espera = 1.0  # pantalla de espera: un cuadro por segundo basta
        elif counter == last_counter:
            await asyncio.sleep(0.01)
            continue
        else:
            last_counter = counter

        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n"
            b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n"
            b"\r\n" + jpeg + b"\r\n"
        )

        # Limita la cadencia al objetivo de FPS
        await asyncio.sleep(max(0.002, espera - (asyncio.get_event_loop().time() - t0)))


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


def cuadro_espera(nombre: str, width: int = 960, height: int = 540) -> np.ndarray:
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
