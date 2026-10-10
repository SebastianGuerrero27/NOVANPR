"""
Capa de abstracción de fuente de video.

Proporciona una interfaz común (VideoSource) con implementaciones intercambiables:
  - WebcamSource: cámara local (USB / integrada)
  - RTSPSource: cámara IP vía protocolo RTSP (Hikvision, Dahua, etc.)

La selección se hace vía CAMERA_SOURCE en .env, nunca en código.
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

from app.infraestructura.config import (
    CAMERA_SOURCE,
    FRAME_HEIGHT,
    FRAME_WIDTH,
    RTSP_URL,
    WEBCAM_INDEX,
)
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
# Implementación: Webcam Local
# =============================================================================


class WebcamSource(VideoSource):
    """
    Fuente de video desde webcam local (USB o integrada).
    Implementa lectura con buffer cero (Zero-Buffer Grabber) para eliminar
    cualquier latencia de acumulación de fotogramas en memoria.
    """

    def __init__(self, index: int = WEBCAM_INDEX) -> None:
        self._index = index
        self._cap: Optional[cv2.VideoCapture] = None
        self._width = FRAME_WIDTH
        self._height = FRAME_HEIGHT
        self._lock = threading.Lock()
        self._latest_frame: Optional[np.ndarray] = None
        self._grab_running = False
        self._grab_thread: Optional[threading.Thread] = None
        self._new_frame_event = threading.Event()

    def connect(self) -> bool:
        import os
        logger.info(
            "Intentando abrir webcam en índice %d (resolución objetivo: %dx%d)...",
            self._index, self._width, self._height,
        )

        # En Windows, usar cv2.CAP_DSHOW (DirectShow) para evitar fallos de MSMF
        if os.name == "nt":
            self._cap = cv2.VideoCapture(self._index, cv2.CAP_DSHOW)
            if not self._cap.isOpened():
                logger.warning("Fallo con CAP_DSHOW en índice %d, intentando backend por defecto...", self._index)
                self._cap = cv2.VideoCapture(self._index)
        else:
            self._cap = cv2.VideoCapture(self._index)

        if not self._cap.isOpened():
            # Intentar con índice 1 si el índice 0 falla
            if self._index == 0:
                logger.warning("No se pudo abrir webcam en índice 0, intentando índice 1...")
                if os.name == "nt":
                    self._cap = cv2.VideoCapture(1, cv2.CAP_DSHOW)
                else:
                    self._cap = cv2.VideoCapture(1)

        if not self._cap or not self._cap.isOpened():
            logger.error(
                "No se pudo abrir la webcam. "
                "Verifica que la cámara esté conectada y no en uso por otra aplicación.",
            )
            self._cap = None
            return False

        # Configurar resolución solicitada, compresión MJPG y Buffer con manejo seguro de excepciones
        try:
            self._cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))
            self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._width)
            self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._height)
            self._cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception as prop_err:
            logger.warning("Aviso al configurar propiedades webcam: %s", prop_err)

        # Verificar lectura del primer frame
        ret, frame = self._cap.read()
        if not ret or frame is None:
            logger.warning("Webcam abierta pero no devolvió el primer frame, reintentando lectura...")
            time.sleep(0.3)
            ret, frame = self._cap.read()
            if not ret or frame is None:
                logger.error("Webcam no pudo entregar cuadros de video válidos.")
                self._cap.release()
                self._cap = None
                return False

        with self._lock:
            self._latest_frame = frame
        self._new_frame_event.set()

        actual_w = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        actual_h = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        actual_fps = self._cap.get(cv2.CAP_PROP_FPS)

        # Iniciar Hilo Grabber de Cero-Buffer
        self._grab_running = True
        self._grab_thread = threading.Thread(target=self._grab_loop, daemon=True, name="WebcamGrabber")
        self._grab_thread.start()

        logger.info(
            "Webcam abierta exitosamente con Zero-Buffer Grabber. Resolución real: %dx%d @ %.1f FPS",
            actual_w, actual_h, actual_fps,
        )
        return True

    def _grab_loop(self) -> None:
        """Lee continuamente de la cámara descartando cuadros obsoletos."""
        while self._grab_running and self._cap and self._cap.isOpened():
            try:
                ret = self._cap.grab()
                if ret:
                    ret, frame = self._cap.retrieve()
                    if ret and frame is not None:
                        with self._lock:
                            self._latest_frame = frame
                        self._new_frame_event.set()
                    else:
                        time.sleep(0.005)
                else:
                    time.sleep(0.01)
            except Exception:
                break

    def read_frame(self, timeout: float = 0.05) -> tuple[bool, Optional[np.ndarray]]:
        if self._cap is None or not self._cap.isOpened():
            return False, None
        if not self._new_frame_event.wait(timeout=timeout):
            return False, None
        self._new_frame_event.clear()
        with self._lock:
            if self._latest_frame is None:
                return False, None
            return True, self._latest_frame.copy()

    def release(self) -> None:
        self._grab_running = False
        if self._grab_thread and self._grab_thread.is_alive():
            self._grab_thread.join(timeout=0.6)
        if self._cap is not None:
            try:
                self._cap.release()
            except Exception:
                pass
            self._cap = None
            logger.info("Webcam liberada.")

    @property
    def is_connected(self) -> bool:
        return self._cap is not None and self._cap.isOpened()

    @property
    def source_info(self) -> dict:
        info = {"type": "webcam", "index": self._index}
        if self._cap and self._cap.isOpened():
            info["width"] = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            info["height"] = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            info["fps"] = round(self._cap.get(cv2.CAP_PROP_FPS), 1)
        return info


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
            if ok and frame is not None:
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
    """
    Factory que crea la fuente de video real según CAMERA_SOURCE en .env.
    Conecta directamente a la cámara física sin simulación sintética de garita.

    Returns:
        Instancia de VideoSource conectada directamente a la cámara real.
    """
    mode = CAMERA_SOURCE.lower().strip()

    if mode == "webcam":
        logger.info("Fuente de video seleccionada: WEBCAM FÍSICA (índice=%d)", WEBCAM_INDEX)
        return WebcamSource(index=WEBCAM_INDEX)

    url = RTSP_URL or ""
    if url:
        logger.info("Fuente de video seleccionada: RTSP -> %s", RTSPSource._mask_credentials(url))
    else:
        logger.info("Sin fuente RTSP inicial: se espera la cámara que asigne el backend.")
    return RTSPSource(url=url)
