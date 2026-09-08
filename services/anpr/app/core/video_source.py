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

# Configuración global de cero latencia para OpenCV FFmpeg (RTSP / IP Cameras)
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (
    "rtsp_transport;tcp"
    "|fflags;nobuffer"
    "|flags;low_delay"
    "|max_delay;0"
    "|reorder_queue_size;0"
    "|stimeout;2000000"
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

        # Configurar resolución solicitada y Buffer cero con manejo seguro de excepciones
        try:
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
            self._grab_thread.join(timeout=0.5)
        if self._cap is not None:
            self._cap.release()
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

    Implementa reconexión con backoff exponencial para resiliencia
    en entornos de infraestructura crítica (ECU 911) y Zero-Buffer Grabber
    para evitar acumulación de fotogramas decodificados en el socket RTSP.
    """

    def __init__(self, url: str = RTSP_URL) -> None:
        self._url = url
        self._cap: Optional[cv2.VideoCapture] = None
        self._consecutive_failures = 0
        self._max_consecutive_read_failures = 30  # frames perdidos antes de reconectar
        self._last_disconnect_time: Optional[float] = None
        self._lock = threading.Lock()
        self._latest_frame: Optional[np.ndarray] = None
        self._grab_running = False
        self._grab_thread: Optional[threading.Thread] = None
        self._new_frame_event = threading.Event()
        self._frame_seq = 0

    def connect(self) -> bool:
        # Enmascarar credenciales en logs
        safe_url = self._mask_credentials(self._url)
        logger.info("Intentando conexión RTSP (Modo Cero Latencia): %s", safe_url)

        # Pre-verificar por socket TCP para no congelar el proceso si el host está offline
        if not _is_host_reachable(self._url, timeout_sec=0.6):
            logger.warning("Host RTSP %s no responde en socket TCP (offline o puerto cerrado).", safe_url)
            return False

        # Enviar TEARDOWN preventivo para liberar sesiones zombies de la app de celular
        _send_rtsp_teardown(self._url)

        # Configurar opciones de cero latencia para FFmpeg (sin forzar transporte rígido)
        import os
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (
            "rtsp_transport;tcp"
            "|fflags;nobuffer"
            "|flags;low_delay"
            "|max_delay;0"
            "|reorder_queue_size;0"
            "|stimeout;2000000"
        )

        self._last_frame_time = 0.0
        self._cap = cv2.VideoCapture(self._url, cv2.CAP_FFMPEG)
        if self._cap.isOpened():
            self._cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        if not self._cap or not self._cap.isOpened():
            logger.error("No se pudo conectar al stream RTSP de la cámara (%s).", safe_url)
            if self._cap:
                self._cap.release()
            self._cap = None
            return False

        actual_w = int(self._cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        actual_h = int(self._cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        actual_fps = self._cap.get(cv2.CAP_PROP_FPS)

        # Iniciar Hilo Grabber de Cero-Buffer RTSP
        self._grab_running = True
        self._grab_thread = threading.Thread(target=self._grab_loop, daemon=True, name="RTSPGrabber")
        self._grab_thread.start()

        logger.info(
            "Conexión RTSP establecida con Zero-Buffer. Resolución: %dx%d @ %.1f FPS — %s",
            actual_w, actual_h, actual_fps, safe_url,
        )

        self._consecutive_failures = 0
        if self._last_disconnect_time is not None:
            downtime = time.time() - self._last_disconnect_time
            logger.info("Reconexión exitosa. Tiempo de inactividad: %.1f segundos", downtime)
            self._last_disconnect_time = None

        return True

    def _grab_loop(self) -> None:
        """
        Hilo grabber de cero latencia:
        Drena activamente el socket RTSP con grab() y retrieve() para asegurar que
        _latest_frame sea SIEMPRE el fotograma más fresco del sensor (< 20ms).
        Protegido contra excepciones de OpenCV y desconexiones de red.
        """
        last_reconnect = 0.0
        while self._grab_running:
            cap = self._cap
            if not cap or not cap.isOpened():
                now = time.time()
                if now - last_reconnect > 2.0:
                    last_reconnect = now
                    if _is_host_reachable(self._url, timeout_sec=0.5):
                        try:
                            new_cap = cv2.VideoCapture(self._url, cv2.CAP_FFMPEG)
                            if new_cap.isOpened():
                                new_cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                                self._cap = new_cap
                        except Exception:
                            pass
                time.sleep(0.05)
                continue

            try:
                ret = cap.grab()
                if ret:
                    ret, frame = cap.retrieve()
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
            except Exception:
                self._consecutive_failures += 1
                time.sleep(0.01)

            if not self._grab_running:
                break

            if self._consecutive_failures >= 60:
                time.sleep(0.04)
            else:
                time.sleep(0.001)

    def read_frame(self, timeout: float = 0.04) -> tuple[bool, Optional[np.ndarray]]:
        if self._cap is None or not self._cap.isOpened():
            return False, None
        if self._new_frame_event.wait(timeout=timeout):
            self._new_frame_event.clear()
        with self._lock:
            if self._latest_frame is None or (time.time() - getattr(self, "_last_frame_time", 0.0) > 2.5):
                return False, None
            return True, self._latest_frame.copy()

    def release(self) -> None:
        self._grab_running = False
        self._new_frame_event.set()  # Despertar cualquier hilo en espera
        if self._grab_thread and self._grab_thread.is_alive() and threading.current_thread() != self._grab_thread:
            self._grab_thread.join(timeout=1.0)
        with self._lock:
            if self._cap is not None:
                try:
                    self._cap.release()
                except Exception:
                    pass
                self._cap = None
                _send_rtsp_teardown(self._url)
                logger.info("Conexión RTSP liberada limpiamente.")

    def reconnect_with_backoff(self) -> bool:
        """
        Intenta reconectar al stream RTSP con backoff exponencial.
        """
        safe_url = self._mask_credentials(self._url)
        self.release()
        self._last_disconnect_time = time.time()
        delay = 1.0

        for attempt in range(1, RTSP_MAX_RETRIES + 1):
            logger.warning(
                "Reintento de conexión RTSP %d/%d en %.1f segundos... (%s)",
                attempt, RTSP_MAX_RETRIES, delay, safe_url,
            )
            time.sleep(delay)

            if self.connect():
                return True

            # Backoff exponencial con cap
            delay = min(delay * 1.5, 5.0)

        logger.error(
            "Se agotaron los %d reintentos de conexión RTSP a %s. "
            "La cámara no es alcanzable.",
            RTSP_MAX_RETRIES, safe_url,
        )
        return False

    @property
    def is_connected(self) -> bool:
        return (
            self._cap is not None
            and self._cap.isOpened()
            and self._consecutive_failures < self._max_consecutive_read_failures
            and (time.time() - getattr(self, "_last_frame_time", 0.0) <= 2.0)
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
# Implementación: Simulación de Tráfico en Vivo (30 FPS Autónomo)
# =============================================================================


class SimulatedTrafficSource(VideoSource):
    """
    Fuente de video sintética de alta fidelidad que simula el flujo de una cámara del ECU 911.
    Genera tráfico vehicular continuo a 30 FPS con matrículas ecuatorianas reales
    (incluyendo placas de Lista Negra y Lista Blanca) para pruebas autónomas e integrales
    en entornos Docker o cuando no hay cámaras físicas conectadas.
    """

    def __init__(self, fps: float = 30.0, width: int = FRAME_WIDTH, height: int = FRAME_HEIGHT) -> None:
        self._fps = fps
        self._width = width
        self._height = height
        self._is_connected = False
        self._frame_count = 0
        self._last_time = time.time()

        # Catálogo de vehículos simulados con placas y detalles
        self._vehicles = [
            {"placa": "PBA-1234", "color": (35, 45, 185), "tipo": "SEDAN", "modelo": "Chevrolet Aveo (Lista Negra)"},
            {"placa": "PBA-5678", "color": (220, 220, 220), "tipo": "SUV", "modelo": "Grand Vitara (Institucional)"},
            {"placa": "TBG-987",  "color": (25, 25, 30),   "tipo": "PICKUP", "modelo": "D-Max (Sospechoso - Alerta)"},
            {"placa": "TCA-9012", "color": (160, 160, 165), "tipo": "SEDAN", "modelo": "Toyota Corolla (Funcionario)"},
            {"placa": "PCX-4512", "color": (130, 40, 30),  "tipo": "SUV", "modelo": "Kia Sportage (Particular)"},
            {"placa": "ABC-1234", "color": (40, 120, 50),  "tipo": "SEDAN", "modelo": "Hyundai Accent (Prueba)"},
        ]
        self._cycle_duration_frames = int(fps * 7.5)  # Cada vehículo pasa durante ~7.5 segundos

    def connect(self) -> bool:
        self._is_connected = True
        self._frame_count = 0
        self._last_time = time.time()
        logger.info(
            "SimulatedTrafficSource: Generador de Tráfico y Placas ANPR activo a %.1f FPS (%dx%d)",
            self._fps, self._width, self._height,
        )
        return True

    def read_frame(self) -> tuple[bool, Optional[np.ndarray]]:
        if not self._is_connected:
            return False, None

        # Control de tiempo a 30 FPS exactos
        t_now = time.time()
        elapsed = t_now - self._last_time
        target_interval = 1.0 / self._fps
        if elapsed < target_interval:
            time.sleep(target_interval - elapsed)
        self._last_time = time.time()

        self._frame_count += 1
        frame = self._render_synthetic_scene(self._frame_count)
        return True, frame

    def _render_synthetic_scene(self, frame_num: int) -> np.ndarray:
        w, h = self._width, self._height
        frame = np.zeros((h, w, 3), dtype=np.uint8)

        # 1. Fondo: Cielo / Iluminación exterior
        frame[:int(h * 0.40), :] = (70, 60, 50)

        # 2. Asfalto / Carretera de Acceso
        road_pts = np.array([
            [int(w * 0.10), h],
            [int(w * 0.90), h],
            [int(w * 0.65), int(h * 0.38)],
            [int(w * 0.35), int(h * 0.38)]
        ], np.int32)
        cv2.fillPoly(frame, [road_pts], (45, 45, 48))

        # Líneas de carril y bordillos
        cv2.line(frame, (int(w * 0.50), int(h * 0.40)), (int(w * 0.50), h), (200, 200, 200), 2)
        cv2.line(frame, (int(w * 0.10), h), (int(w * 0.35), int(h * 0.38)), (80, 180, 220), 4)
        cv2.line(frame, (int(w * 0.90), h), (int(w * 0.65), int(h * 0.38)), (80, 180, 220), 4)

        # 3. Garita / Infraestructura
        cv2.rectangle(frame, (0, int(h * 0.20)), (int(w * 0.25), int(h * 0.65)), (40, 35, 30), -1)
        cv2.rectangle(frame, (int(w * 0.02), int(h * 0.25)), (int(w * 0.23), int(h * 0.45)), (120, 150, 160), -1)
        cv2.putText(frame, "GARITA 01 - AMBATO", (int(w * 0.03), int(h * 0.23)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 220, 255), 1, cv2.LINE_AA)

        # 4. Cálculo del Ciclo de Vehículo (Animación de acercamiento)
        progress = (frame_num % self._cycle_duration_frames) / float(self._cycle_duration_frames)
        veh_idx = (frame_num // self._cycle_duration_frames) % len(self._vehicles)
        veh = self._vehicles[veh_idx]

        if 0.08 <= progress <= 0.88:
            t = (progress - 0.08) / 0.80
            ease_t = t * t * (3.0 - 2.0 * t)

            scale = 0.25 + 0.75 * ease_t
            car_w = int(w * 0.42 * scale)
            car_h = int(h * 0.40 * scale)

            cx = int(w * 0.50 + (w * 0.02) * (1.0 - ease_t))
            cy = int(h * 0.42 + (h * 0.38) * ease_t)

            x1 = cx - car_w // 2
            y1 = cy - car_h // 2
            x2 = cx + car_w // 2
            y2 = cy + car_h // 2

            # Carrocería
            body_color = veh["color"]
            cv2.rectangle(frame, (x1, int(y1 + car_h * 0.25)), (x2, y2), body_color, -1)
            cv2.rectangle(frame, (x1, int(y1 + car_h * 0.25)), (x2, y2), (20, 20, 20), max(1, int(2 * scale)))

            # Techo / Parabrisas
            roof_w = int(car_w * 0.75)
            roof_x1 = cx - roof_w // 2
            roof_x2 = cx + roof_w // 2
            glass_pts = np.array([
                [x1 + int(car_w * 0.08), int(y1 + car_h * 0.35)],
                [x2 - int(car_w * 0.08), int(y1 + car_h * 0.35)],
                [roof_x2, y1],
                [roof_x1, y1]
            ], np.int32)
            cv2.fillPoly(frame, [glass_pts], (140, 160, 175))
            cv2.polylines(frame, [glass_pts], True, (30, 30, 30), max(1, int(2 * scale)))

            # Faros delanteros
            headlight_w = int(car_w * 0.14)
            headlight_h = int(car_h * 0.12)
            cv2.rectangle(frame, (x1 + int(car_w * 0.05), int(y2 - car_h * 0.45)), (x1 + int(car_w * 0.05) + headlight_w, int(y2 - car_h * 0.45) + headlight_h), (220, 240, 255), -1)
            cv2.rectangle(frame, (x2 - int(car_w * 0.05) - headlight_w, int(y2 - car_h * 0.45)), (x2 - int(car_w * 0.05), int(y2 - car_h * 0.45) + headlight_h), (220, 240, 255), -1)

            # Parrilla delantera
            grille_x1 = x1 + int(car_w * 0.25)
            grille_x2 = x2 - int(car_w * 0.25)
            grille_y1 = int(y2 - car_h * 0.42)
            grille_y2 = int(y2 - car_h * 0.10)
            cv2.rectangle(frame, (grille_x1, grille_y1), (grille_x2, grille_y2), (25, 25, 25), -1)

            # Placa Vehicular Ecuatoriana
            plate_w = max(40, int(car_w * 0.42))
            plate_h = max(18, int(plate_w * 0.48))
            px1 = cx - plate_w // 2
            px2 = cx + plate_w // 2
            py1 = int(y2 - car_h * 0.26)
            py2 = py1 + plate_h

            cv2.rectangle(frame, (px1, py1), (px2, py2), (250, 250, 250), -1)
            cv2.rectangle(frame, (px1, py1), (px2, py2), (10, 10, 10), max(1, int(2 * scale)))

            if scale > 0.45:
                cv2.putText(frame, "ECUADOR", (px1 + int(plate_w * 0.26), py1 + int(plate_h * 0.28)), cv2.FONT_HERSHEY_SIMPLEX, 0.32 * scale, (15, 15, 15), max(1, int(1 * scale)), cv2.LINE_AA)

            font_scale = 0.88 * scale
            thickness = max(1, int(2 * scale))
            (tw, th), _ = cv2.getTextSize(veh["placa"], cv2.FONT_HERSHEY_SIMPLEX, font_scale, thickness)
            cv2.putText(frame, veh["placa"], (cx - tw // 2, py2 - int(plate_h * 0.18)), cv2.FONT_HERSHEY_SIMPLEX, font_scale, (10, 10, 10), thickness, cv2.LINE_AA)

        # 5. Timestamp y Marca de Agua
        timestamp_str = time.strftime("%Y-%m-%d %H:%M:%S")
        cv2.putText(frame, f"CAM-01 [ACCESO PRINCIPAL ZONAL 3] {timestamp_str} (SIMULACION EN VIVO)", (20, h - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (240, 240, 240), 2, cv2.LINE_AA)
        cv2.putText(frame, f"CAM-01 [ACCESO PRINCIPAL ZONAL 3] {timestamp_str} (SIMULACION EN VIVO)", (20, h - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 220, 255), 1, cv2.LINE_AA)

        return frame

    def release(self) -> None:
        self._is_connected = False
        logger.info("SimulatedTrafficSource liberado.")

    @property
    def is_connected(self) -> bool:
        return self._is_connected

    @property
    def source_info(self) -> dict:
        return {
            "type": "simulated",
            "width": self._width,
            "height": self._height,
            "fps": self._fps,
            "mode": "Autónomo 30 FPS"
        }


# =============================================================================
# Implementación: Fuente Resiliente con Auto-Fallback
# =============================================================================


class ResilientVideoSource(VideoSource):
    """
    Fuente de video híbrida y autorreparable.
    Intenta conectarse a la fuente primaria (RTSP o Webcam). Si no responde tras
    los reintentos iniciales, conmuta automáticamente a SimulatedTrafficSource sin
    cortar el stream a 30 FPS, mientras verifica en segundo plano la reconexión.
    """

    def __init__(self, primary_source: VideoSource) -> None:
        self._primary = primary_source
        self._fallback = SimulatedTrafficSource()
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
            "Activando modo de contingencia: Tráfico Simulado en Tiempo Real a 30 FPS..."
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
                    "Pérdida de señal en cámara física (%d cuadros). Conmutando a stream simulado...",
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

    url = RTSP_URL or "rtsp://localhost:8554/camara_raw"
    logger.info("Fuente de video seleccionada: RTSP -> %s", url)
    return RTSPSource(url=url)
