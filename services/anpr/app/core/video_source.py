"""
Capa de abstracción de fuente de video.

Proporciona una interfaz común (VideoSource) con implementaciones intercambiables:
  - WebcamSource: cámara local (USB / integrada)
  - RTSPSource: cámara IP vía protocolo RTSP (Hikvision, Dahua, etc.)

La selección se hace vía CAMERA_SOURCE en .env, nunca en código.
"""

from __future__ import annotations

import threading
import time
from abc import ABC, abstractmethod
from typing import Optional

import cv2
import numpy as np

import os

# Configuración global robusta para OpenCV FFmpeg (RTSP / IP Cameras)
# Usa TCP para cero pérdida de paquetes y buffer cero para latencia mínima sin congelamiento
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (
    "rtsp_transport;tcp"
    "|fflags;nobuffer"
    "|flags;low_delay"
    "|max_delay;100000"
    "|stimeout;5000000"
)

from app.config import (
    CAMERA_SOURCE,
    FRAME_HEIGHT,
    FRAME_WIDTH,
    RTSP_CONNECTION_TIMEOUT_SEC,
    RTSP_MAX_RECONNECT_DELAY_SEC,
    RTSP_MAX_RETRIES,
    RTSP_RECONNECT_DELAY_SEC,
    RTSP_URL,
    WEBCAM_INDEX,
)
from app.utils.logger import get_logger

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


def _is_host_reachable(url: str, timeout_sec: float = 0.5) -> bool:
    """Verifica rápidamente por socket TCP si el host y puerto son alcanzables antes de llamar a OpenCV."""
    try:
        import urllib.parse
        import socket
        parsed = urllib.parse.urlparse(url)
        host = parsed.hostname
        port = parsed.port or 554
        if not host:
            return True
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout_sec)
            return s.connect_ex((host, port)) == 0
    except Exception:
        return False


def _send_rtsp_teardown(url: str) -> None:
    """Envía un comando TEARDOWN rápido por TCP para cerrar sesiones zombies en servidores RTSP de celulares."""
    try:
        import urllib.parse
        import socket
        parsed = urllib.parse.urlparse(url)
        host = parsed.hostname
        port = parsed.port or 554
        if not host:
            return
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.4)
            s.connect((host, port))
            msg = f"TEARDOWN {url} RTSP/1.0\r\nCSeq: 99\r\nUser-Agent: ANPR-ECU911\r\n\r\n".encode()
            s.sendall(msg)
            s.recv(256)
    except Exception:
        pass


class RTSPSource(VideoSource):
    """
    Fuente de video desde cámara IP vía RTSP.

    Implementa reconexión continua y Zero-Buffer Grabber para evitar
    acumulación de fotogramas decodificados en el socket RTSP y garantizar
    flujo ininterrumpido en el monitor en vivo ANPR.
    """

    def __init__(self, url: str = RTSP_URL) -> None:
        self._url = url
        self._cap: Optional[cv2.VideoCapture] = None
        self._consecutive_failures = 0
        self._max_consecutive_read_failures = 60
        self._last_disconnect_time: Optional[float] = None
        self._lock = threading.Lock()
        self._latest_frame: Optional[np.ndarray] = None
        self._grab_running = False
        self._grab_thread: Optional[threading.Thread] = None
        self._new_frame_event = threading.Event()
        self._frame_seq = 0
        self._last_frame_time = 0.0

    def connect(self) -> bool:
        safe_url = self._mask_credentials(self._url)
        logger.info("Iniciando conexión RTSP y hilo grabber continuo: %s", safe_url)

        # Configurar opciones optimizadas de captura FFmpeg para RTSP sin retrasos
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (
            "rtsp_transport;tcp"
            "|fflags;nobuffer"
            "|flags;low_delay"
            "|max_delay;100000"
            "|stimeout;5000000"
        )

        self._grab_running = True
        if self._grab_thread is None or not self._grab_thread.is_alive():
            self._grab_thread = threading.Thread(target=self._grab_loop, daemon=True, name="RTSPGrabber")
            self._grab_thread.start()

        return True

    def _open_capture(self) -> Optional[cv2.VideoCapture]:
        if not self._url:
            return None  # sin cámara asignada: el backend la asigna al arrancar
        try:
            cap = cv2.VideoCapture(self._url, cv2.CAP_FFMPEG)
            if cap.isOpened():
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                return cap
            else:
                cap.release()
                return None
        except Exception as e:
            logger.debug("Excepción al abrir VideoCapture RTSP: %s", e)
            return None

    def _grab_loop(self) -> None:
        """
        Hilo grabber autónomo y continuo:
        Mantiene la conexión abierta y drena activamente el socket RTSP con grab() y retrieve()
        para que _latest_frame sea siempre el fotograma más fresco del sensor.
        Se auto-reconecta automáticamente si la red o cámara se interrumpe.
        """
        last_connect_try = 0.0
        safe_url = self._mask_credentials(self._url)

        while self._grab_running:
            if self._cap is None or not self._cap.isOpened():
                now = time.time()
                if now - last_connect_try >= 1.5:
                    last_connect_try = now
                    new_cap = self._open_capture()
                    if new_cap is not None:
                        self._cap = new_cap
                        logger.info("Stream RTSP conectado exitosamente a %s", safe_url)
                        self._consecutive_failures = 0
                time.sleep(0.04)
                continue

            try:
                ret = self._cap.grab()
                if ret:
                    ret, frame = self._cap.retrieve()
                    if ret and frame is not None:
                        with self._lock:
                            self._latest_frame = frame
                            self._last_frame_time = time.time()
                            self._frame_seq += 1
                        self._new_frame_event.set()
                        self._consecutive_failures = 0
                    else:
                        self._consecutive_failures += 1
                else:
                    self._consecutive_failures += 1
            except Exception as e:
                logger.debug("Error en grab RTSP: %s", e)
                self._consecutive_failures += 1

            if not self._grab_running:
                break

            if self._consecutive_failures >= 30:
                # Si fallan 30 lecturas consecutivas, liberar y forzar reconexión limpia
                if self._cap is not None:
                    try:
                        self._cap.release()
                    except Exception:
                        pass
                    self._cap = None
                time.sleep(0.1)
            else:
                time.sleep(0.001)

    def read_frame(self, timeout: float = 0.01) -> tuple[bool, Optional[np.ndarray]]:
        if self._new_frame_event.wait(timeout=timeout):
            self._new_frame_event.clear()

        with self._lock:
            if self._latest_frame is None:
                return False, None
            # Permitir que el último cuadro sea válido hasta por 3.0s antes de declarar frame muerto
            if time.time() - self._last_frame_time > 3.0:
                return False, None
            return True, self._latest_frame.copy()

    def release(self) -> None:
        self._grab_running = False
        self._new_frame_event.set()
        if self._grab_thread and self._grab_thread.is_alive() and threading.current_thread() != self._grab_thread:
            self._grab_thread.join(timeout=0.8)
        with self._lock:
            if self._cap is not None:
                try:
                    self._cap.release()
                except Exception:
                    pass
                self._cap = None
                self._latest_frame = None
                logger.info("Conexión RTSP liberada.")

    def reconnect_with_backoff(self) -> bool:
        self.release()
        return self.connect()

    @property
    def is_connected(self) -> bool:
        return (
            self._cap is not None
            and self._cap.isOpened()
            and (time.time() - getattr(self, "_last_frame_time", 0.0) <= 3.0)
        )

    @property
    def source_info(self) -> dict:
        info = {
            "type": "rtsp",
            "url": self._mask_credentials(self._url),
            "consecutive_failures": self._consecutive_failures,
        }
        if self._cap and self._cap.isOpened():
            info["width"] = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            info["height"] = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            info["fps"] = round(self._cap.get(cv2.CAP_PROP_FPS), 1)
        return info

    @staticmethod
    def _mask_credentials(url: str) -> str:
        """Enmascara usuario:contraseña en la URL RTSP para logging seguro."""
        import re
        return re.sub(r"://([^:]+):([^@]+)@", r"://****:****@", url)


# =============================================================================
# Implementación: Pantalla de Espera Táctica (Cero Simulación)
# =============================================================================


class StandbyVideoSource(VideoSource):
    """
    Fuente de video estática de espera cuando la cámara física está desconectada.
    NO genera vehículos ni placas simuladas, solo un cuadro informativo sin detecciones.
    Garantiza CERO ingresos falsos en la base de datos.
    """

    def __init__(self, fps: float = 10.0, width: int = FRAME_WIDTH, height: int = FRAME_HEIGHT) -> None:
        self._fps = fps
        self._width = width
        self._height = height
        self._is_connected = False
        self._last_time = time.time()

    def connect(self) -> bool:
        self._is_connected = True
        logger.info("StandbyVideoSource: Modo espera táctico activo (Cero simulación).")
        return True

    def read_frame(self) -> tuple[bool, Optional[np.ndarray]]:
        if not self._is_connected:
            return False, None

        target_interval = 1.0 / self._fps
        t_now = time.time()
        elapsed = t_now - self._last_time
        if elapsed < target_interval:
            time.sleep(target_interval - elapsed)
        self._last_time = time.time()

        h, w = self._height, self._width
        frame = np.zeros((h, w, 3), dtype=np.uint8)
        frame[:] = (24, 18, 14)  # Fondo navy oscuro

        # Cuadrícula tenue de standby
        for y in range(0, h, 40):
            cv2.line(frame, (0, y), (w, y), (35, 25, 20), 1)
        for x in range(0, w, 40):
            cv2.line(frame, (x, 0), (x, h), (35, 25, 20), 1)

        cv2.rectangle(frame, (0, 0), (w, 36), (15, 12, 10), -1)
        cv2.putText(frame, "ECU 911 | CANAL EN ESPERA DE DISPOSITIVO FISICO", (20, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (0, 220, 255), 1, cv2.LINE_AA)

        cx, cy = w // 2, h // 2
        cv2.rectangle(frame, (cx - 280, cy - 50), (cx + 280, cy + 50), (32, 22, 18), -1)
        cv2.rectangle(frame, (cx - 280, cy - 50), (cx + 280, cy + 50), (0, 180, 255), 1)
        cv2.putText(frame, "SIN SENAL DE VIDEO RTSP / HARDWARE", (cx - 240, cy - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2, cv2.LINE_AA)
        cv2.putText(frame, "Modo simulacion desactivado. Esperando camara real...", (cx - 220, cy + 25), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (160, 200, 220), 1, cv2.LINE_AA)

        return True, frame

    def release(self) -> None:
        self._is_connected = False
        logger.info("StandbyVideoSource liberado.")

    @property
    def is_connected(self) -> bool:
        return self._is_connected

    @property
    def source_info(self) -> dict:
        return {
            "type": "standby",
            "width": self._width,
            "height": self._height,
            "fps": self._fps,
            "mode": "Sin señal (Cero simulación)"
        }


# =============================================================================
# Implementación: Fuente Resiliente con Auto-Fallback
# =============================================================================


class ResilientVideoSource(VideoSource):
    """
    Fuente de video híbrida y autorreparable.
    Intenta conectarse a la fuente primaria (RTSP o Webcam). Si no responde tras
    los reintentos iniciales, conmuta a StandbyVideoSource mostrando pantalla táctica
    de espera (CERO vehículos falsos ni simulación).
    """

    def __init__(self, primary_source: VideoSource) -> None:
        self._primary = primary_source
        self._fallback = StandbyVideoSource()
        self._using_fallback = False
        self._consecutive_read_failures = 0
        self._max_consecutive_failures = 15
        self._last_reconnect_attempt = 0.0

    def connect(self) -> bool:
        logger.info("ResilientVideoSource: Intentando conexión a fuente primaria...")
        if self._primary.connect():
            self._using_fallback = False
            self._consecutive_read_failures = 0
            logger.info("ResilientVideoSource: Fuente primaria conectada exitosamente.")
            return True

        logger.warning(
            "ResilientVideoSource: Fuente primaria no disponible. "
            "Activando modo de espera táctico (Cero simulación)..."
        )
        self._using_fallback = True
        return self._fallback.connect()

    def read_frame(self) -> tuple[bool, Optional[np.ndarray]]:
        if not self._using_fallback:
            ret, frame = self._primary.read_frame()
            if ret and frame is not None:
                self._consecutive_read_failures = 0
                return True, frame

            self._consecutive_read_failures += 1
            if self._consecutive_read_failures >= self._max_consecutive_failures:
                logger.warning(
                    "Pérdida de señal en cámara física (%d cuadros). Conmutando a pantalla de espera...",
                    self._consecutive_read_failures,
                )
                self._using_fallback = True
                self._fallback.connect()
                return self._fallback.read_frame()

            return False, None

        # Si estamos en modo fallback, intentar reconectar a la cámara física cada 15 segundos
        now = time.time()
        if now - self._last_reconnect_attempt >= 15.0:
            self._last_reconnect_attempt = now
            if self._primary.connect():
                ret, frame = self._primary.read_frame()
                if ret and frame is not None:
                    logger.info("Cámara física restablecida. Retornando a stream de hardware en vivo.")
                    self._using_fallback = False
                    self._consecutive_read_failures = 0
                    return True, frame

        return self._fallback.read_frame()

    def release(self) -> None:
        if self._primary:
            self._primary.release()
        if self._fallback:
            self._fallback.release()

    @property
    def is_connected(self) -> bool:
        if self._using_fallback:
            return self._fallback.is_connected
        return self._primary.is_connected

    @property
    def source_info(self) -> dict:
        if self._using_fallback:
            info = self._fallback.source_info
            info["status"] = "fallback_simulado"
            return info
        info = self._primary.source_info
        info["status"] = "hardware_online"
        return info


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
