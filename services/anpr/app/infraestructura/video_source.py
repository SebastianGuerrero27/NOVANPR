"""
Capa de abstracción de fuente de video.

La única fuente del motor es RTSPSource: la cámara IP asignada por el backend, leída desde su ruta
en MediaMTX (que mantiene la conexión con la cámara). El motor no usa cámaras locales.
"""

from __future__ import annotations

import os
import threading
import time
from abc import ABC, abstractmethod
from typing import Any, Callable, Optional

import cv2
import numpy as np

# Opciones de FFmpeg para RTSP (OpenCV 4.10–4.11 incluye FFmpeg 5.1): transporte TCP (sin pérdida
# de paquetes ni artefactos), sin búfer de entrada ni espera de reordenamiento (latencia mínima) y
# límite de E/S del socket en microsegundos. En FFmpeg >= 5 esa opción se llama "timeout": la
# antigua "stimeout" se ignoraba en silencio y una conexión estancada bloqueaba la lectura.
OPCIONES_FFMPEG_RTSP = (
    "rtsp_transport;tcp"
    "|fflags;nobuffer"
    "|flags;low_delay"
    "|max_delay;100000"
    "|timeout;5000000"
)
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = OPCIONES_FFMPEG_RTSP

from app.infraestructura.config import RTSP_URL
from app.dominio.tasa_cuadros import TasaCuadros
from app.infraestructura.logger import get_logger

logger = get_logger("video_source")


# =============================================================================
# Interfaz Abstracta
# =============================================================================


class VideoSource(ABC):
    """
    Interfaz abstracta para fuentes de video.

    Todas las implementaciones deben proveer:
      - connect(): abre la fuente de video
      - read_frame(): lee un frame (blocking)
      - release(): libera los recursos
      - is_connected: estado de conexión
      - source_info: metadatos de la fuente
    """

    @abstractmethod
    def connect(self) -> bool:
        """
        Abre la conexión con la fuente de video.

        Returns:
            True si la conexión fue exitosa, False en caso contrario.
        """
        ...

    @abstractmethod
    def read_frame(self) -> tuple[bool, Optional[np.ndarray]]:
        """
        Lee un frame de la fuente de video.

        Returns:
            Tupla (success, frame). Si success es False, frame es None.
        """
        ...

    @abstractmethod
    def release(self) -> None:
        """Libera los recursos de captura."""
        ...

    @property
    @abstractmethod
    def is_connected(self) -> bool:
        """Indica si la fuente de video está activa y entregando frames."""
        ...

    @property
    @abstractmethod
    def source_info(self) -> dict:
        """Retorna metadatos de la fuente (tipo, resolución, fps nativo, etc.)."""
        ...


# =============================================================================
# Implementación: RTSP (Cámara IP)
# =============================================================================


def _abrir_rtsp(url: str, abrir_ms: int, leer_ms: int) -> Optional[Any]:
    """VideoCapture de FFmpeg con límites de espera propios de OpenCV al abrir y al leer: no dependen
    del nombre de la opción en cada versión de FFmpeg y cortan una conexión estancada."""
    try:
        cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG,
                               [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, abrir_ms, cv2.CAP_PROP_READ_TIMEOUT_MSEC, leer_ms])
        if cap.isOpened():
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            return cap
        cap.release()
    except Exception as e:
        logger.debug("Excepción al abrir VideoCapture RTSP: %s", e)
    return None


def _codec(cap: Any) -> Optional[str]:
    """Códec del flujo (h264, hevc…) según el FOURCC que informa FFmpeg."""
    try:
        valor = int(cap.get(cv2.CAP_PROP_FOURCC))
        texto = "".join(chr((valor >> (8 * i)) & 0xFF) for i in range(4)).strip("\x00 ")
        return texto.lower() or None
    except Exception:
        return None


class RTSPSource(VideoSource):
    """
    Cámara IP por RTSP (en el sistema, la ruta cam_<id> de MediaMTX, que mantiene la conexión con
    la cámara).

    - Un hilo lector drena el flujo y conserva solo el cuadro más reciente: el consumidor nunca
      procesa cuadros atrasados ni acumula latencia.
    - Límites de espera de OpenCV al abrir (8 s) y al leer (5 s): si la cámara o la red dejan de
      enviar sin cerrar la sesión, la lectura no se bloquea; además un vigilante reconecta cuando
      pasan `estancamiento_s` sin cuadros nuevos.
    - Reconexión con espera creciente (1,5 s, 3 s, 6 s… hasta 10 s) mientras la fuente no responde.
    - Salud del enlace en source_info: códec, resolución, cuadros por segundo recibidos,
      reconexiones y antigüedad del último cuadro.
    """

    def __init__(self, url: str = RTSP_URL, abrir_ms: int = 8000, leer_ms: int = 5000, estancamiento_s: float = 5.0,
                 abrir: Optional[Callable[[str, int, int], Any]] = None) -> None:
        self._url = url
        self._abrir_ms, self._leer_ms, self._estancamiento_s = abrir_ms, leer_ms, estancamiento_s
        self._abrir = abrir or _abrir_rtsp
        self._cap: Optional[Any] = None
        self._lock = threading.Lock()
        self._latest_frame: Optional[np.ndarray] = None
        self._grab_running = False
        self._grab_thread: Optional[threading.Thread] = None
        self._new_frame_event = threading.Event()
        self._frame_seq = 0
        #: Último cuadro recibido (estado del enlace y cuadros por segundo)
        self._last_frame_time = 0.0
        #: Inicio de la conexión vigente (el vigilante cuenta desde aquí si aún no llegó un cuadro)
        self._conectado_en = 0.0
        self._consecutive_failures = 0
        self._tasa = TasaCuadros()
        self._codec: Optional[str] = None
        self._conectada_antes = False
        #: Reconexiones tras la primera conexión (pérdidas del enlace recuperadas)
        self.reconexiones = 0

    def connect(self) -> bool:
        logger.info("Iniciando conexión RTSP y hilo lector continuo: %s", self._mask_credentials(self._url))
        self._grab_running = True
        if self._grab_thread is None or not self._grab_thread.is_alive():
            self._grab_thread = threading.Thread(target=self._grab_loop, daemon=True, name="RTSPGrabber")
            self._grab_thread.start()
        return True

    def _open_capture(self) -> Optional[Any]:
        if not self._url:
            return None  # sin cámara asignada: el backend la asigna al arrancar
        return self._abrir(self._url, self._abrir_ms, self._leer_ms)

    def _cerrar_captura(self) -> None:
        cap, self._cap = self._cap, None
        with self._lock:
            self._latest_frame = None  # un cuadro de antes de la caída no debe parecer reciente
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass

    def _grab_loop(self) -> None:
        """Hilo lector: conecta, drena el flujo, vigila el estancamiento y reconecta."""
        safe_url = self._mask_credentials(self._url)
        intentos = 0
        proximo_intento = 0.0
        while self._grab_running:
            if self._cap is None:
                if time.time() < proximo_intento or not self._url:
                    time.sleep(0.05)
                    continue
                cap = self._open_capture()
                if cap is None:
                    intentos += 1
                    proximo_intento = time.time() + min(10.0, 1.5 * 2 ** (intentos - 1))
                    continue
                intentos = 0
                self._cap = cap
                self._codec = _codec(cap)
                self._conectado_en = time.time()
                if self._conectada_antes:
                    self.reconexiones += 1
                self._conectada_antes = True
                logger.info("Flujo RTSP conectado (%s): %s", self._codec or "códec desconocido", safe_url)
                continue

            try:
                ok = self._cap.grab()
                frame = self._cap.retrieve()[1] if ok else None
            except Exception as e:
                logger.debug("Error en la lectura RTSP: %s", e)
                ok, frame = False, None
            ahora = time.time()
            # Un cuadro corrupto (decodificación fallida o vacío) cuenta como falla, no se entrega
            if ok and frame is not None and frame.size > 0:
                self._tasa.registrar()
                with self._lock:
                    self._latest_frame = frame
                    self._last_frame_time = ahora
                    self._frame_seq += 1
                self._new_frame_event.set()
                self._consecutive_failures = 0
                continue

            self._consecutive_failures += 1
            sin_cuadros = ahora - max(self._last_frame_time, self._conectado_en)
            if sin_cuadros >= self._estancamiento_s:
                logger.warning("Flujo RTSP sin cuadros hace %.1f s: reconectando %s", sin_cuadros, safe_url)
                self._cerrar_captura()
            else:
                time.sleep(0.01)
        self._cerrar_captura()

    def read_frame(self, timeout: float = 0.01) -> tuple[bool, Optional[np.ndarray]]:
        if self._new_frame_event.wait(timeout=timeout):
            self._new_frame_event.clear()
        with self._lock:
            if self._latest_frame is None or time.time() - self._last_frame_time > 3.0:
                return False, None
            # Hora en que el lector recibió este cuadro (base de la latencia de punta a punta)
            self.hora_entregada = self._last_frame_time
            return True, self._latest_frame.copy()

    def release(self) -> None:
        self._grab_running = False
        self._new_frame_event.set()
        if self._grab_thread and self._grab_thread.is_alive() and threading.current_thread() != self._grab_thread:
            self._grab_thread.join(timeout=self._leer_ms / 1000.0 + 1.0)
        self._cerrar_captura()
        logger.info("Conexión RTSP liberada.")

    def reconnect_with_backoff(self) -> bool:
        self.release()
        return self.connect()

    @property
    def frame_seq(self) -> int:
        """Número del último cuadro recibido: el consumidor distingue un cuadro nuevo de uno repetido."""
        return self._frame_seq

    @property
    def is_connected(self) -> bool:
        """Recibe cuadros por la conexión vigente (los de una conexión anterior no cuentan)."""
        return (self._cap is not None and self._last_frame_time >= self._conectado_en
                and time.time() - self._last_frame_time <= 3.0)

    @property
    def source_info(self) -> dict:
        info = {
            "type": "rtsp",
            "url": self._mask_credentials(self._url),
            "codec": self._codec,
            "fps_recibidos": round(self._tasa.valor, 1),
            "reconexiones": self.reconexiones,
            "ultimo_cuadro_hace_s": round(time.time() - self._last_frame_time, 1) if self._last_frame_time else None,
            "consecutive_failures": self._consecutive_failures,
        }
        cap = self._cap
        if cap is not None:
            try:
                info["width"] = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                info["height"] = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            except Exception:
                pass
        return info

    @staticmethod
    def _mask_credentials(url: str) -> str:
        """Enmascara usuario:contraseña en la URL RTSP para logging seguro."""
        import re
        return re.sub(r"://([^:]+):([^@]+)@", r"://****:****@", url)


# =============================================================================
# Factory
# =============================================================================


def create_video_source() -> VideoSource:
    """Fuente inicial del motor: RTSP_URL si está definida o, sin ella, una fuente vacía a la espera
    de la cámara que asigne el backend."""
    url = RTSP_URL or ""
    if url:
        logger.info("Fuente de video inicial: RTSP -> %s", RTSPSource._mask_credentials(url))
    else:
        logger.info("Sin fuente RTSP inicial: se espera la cámara que asigne el backend.")
    return RTSPSource(url=url)
