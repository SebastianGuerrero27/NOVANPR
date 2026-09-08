"""
Configuración centralizada del microservicio ANPR.

Todos los parámetros se cargan desde variables de entorno (archivo .env).
Ningún valor sensible debe estar hardcodeado aquí.
"""

import os
from dotenv import load_dotenv

load_dotenv()

# =============================================================================
# Servidor FastAPI
# =============================================================================
PORT: int = int(os.getenv("PORT", "8000"))
LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO").upper()

# =============================================================================
# Fuente de Video
# =============================================================================
CAMERA_SOURCE: str = os.getenv("CAMERA_SOURCE", "webcam").lower()  # "webcam" | "rtsp"
WEBCAM_INDEX: int = int(os.getenv("WEBCAM_INDEX", "0"))
RTSP_URL: str = os.getenv("RTSP_URL", os.getenv("RTSP_STREAM_URL", ""))
DEBUG_SHOW_WINDOW: bool = os.getenv("DEBUG_SHOW_WINDOW", "false").lower() in ("true", "1", "yes")

# Resiliencia RTSP
RTSP_RECONNECT_DELAY_SEC: float = float(os.getenv("RTSP_RECONNECT_DELAY_SEC", "5"))
RTSP_MAX_RECONNECT_DELAY_SEC: float = float(os.getenv("RTSP_MAX_RECONNECT_DELAY_SEC", "120"))
RTSP_CONNECTION_TIMEOUT_SEC: float = float(os.getenv("RTSP_CONNECTION_TIMEOUT_SEC", "10"))
RTSP_MAX_RETRIES: int = int(os.getenv("RTSP_MAX_RETRIES", "5"))

# Resolución de captura
FRAME_WIDTH: int = int(os.getenv("FRAME_WIDTH", "1280"))
FRAME_HEIGHT: int = int(os.getenv("FRAME_HEIGHT", "720"))

# =============================================================================
# Modelo YOLO
# =============================================================================
YOLO_MODEL_PATH: str = os.getenv("YOLO_MODEL_PATH", "yolo11n.pt")
PLATE_MODEL_PATH: str = os.getenv("PLATE_MODEL_PATH", "models/license_plate_detector.pt")
YOLO_CONFIDENCE_THRESHOLD: float = float(os.getenv("YOLO_CONFIDENCE_THRESHOLD", "0.35"))
PLATE_CONFIDENCE_THRESHOLD: float = float(os.getenv("PLATE_CONFIDENCE_THRESHOLD", "0.35"))

# Clases COCO de vehículos (para modelo genérico)
_vehicle_classes_str = os.getenv("YOLO_VEHICLE_CLASSES", "2,3,5,7")
YOLO_VEHICLE_CLASSES: list[int] = [int(c.strip()) for c in _vehicle_classes_str.split(",") if c.strip()]

# =============================================================================
# Motor OCR
# =============================================================================
OCR_ENGINE: str = os.getenv("OCR_ENGINE", "easyocr").lower()  # "easyocr" | "tesseract"
OCR_CONFIDENCE_THRESHOLD: float = float(os.getenv("OCR_CONFIDENCE_THRESHOLD", "0.30"))
TESSERACT_CMD: str = os.getenv("TESSERACT_CMD", "")  # Ruta al ejecutable en Windows

# =============================================================================
# Tracking y Deduplicación
# =============================================================================
DETECTION_COOLDOWN_SEC: int = int(os.getenv("DETECTION_COOLDOWN_SEC", "15"))
FRAME_SKIP: int = int(os.getenv("FRAME_SKIP", "1"))

# --- Optimización de Inferencia (Arquitectura Productor-Consumidor) ---
# Resolución interna para inferencia YOLO (640x480 es ~18x más rápido en CPU que 1280x720)
INFERENCE_WIDTH: int = int(os.getenv("INFERENCE_WIDTH", "640"))
INFERENCE_HEIGHT: int = int(os.getenv("INFERENCE_HEIGHT", "480"))
# Throttle mínimo entre inferencias sucesivas (milisegundos) para evitar saturación de CPU
INFERENCE_THROTTLE_MS: int = int(os.getenv("INFERENCE_THROTTLE_MS", "0"))
# Guardado asíncrono de imágenes de evidencia (ThreadPoolExecutor)
ASYNC_DISK_IO: bool = os.getenv("ASYNC_DISK_IO", "true").lower() in ("true", "1", "yes")

# =============================================================================
# Modo de Depuración Visual
# =============================================================================
DEBUG_VISUAL: bool = os.getenv("DEBUG_VISUAL", "true").lower() in ("true", "1", "yes")

# Detección de entorno Docker (para desactivar cv2.imshow automáticamente)
RUNNING_IN_DOCKER: bool = (
    os.getenv("RUNNING_IN_DOCKER", "false").lower() in ("true", "1", "yes")
    or os.path.exists("/.dockerenv")
)

# =============================================================================
# Comunicación con Backend
# =============================================================================
BACKEND_URL: str = os.getenv("BACKEND_URL", "http://localhost:5000")
BACKEND_SOCKETIO_URL: str = os.getenv("BACKEND_SOCKETIO_URL", "http://localhost:5000")

# Endpoint de sincronización (nuevo modelo OpenALPR Scout)
SYNC_ENDPOINT: str = os.getenv("SYNC_ENDPOINT", "/api/detecciones/sync")

# Habilitar sincronización legacy (/api/eventos/sync → EventosIngreso) en paralelo
LEGACY_SYNC_ENABLED: bool = os.getenv("LEGACY_SYNC_ENABLED", "true").lower() in ("true", "1", "yes")

# =============================================================================
# Base de Datos / Cámara
# =============================================================================
CAMERA_ID: int = int(os.getenv("CAMERA_ID", "1"))

# =============================================================================
# Almacenamiento de Imágenes
# =============================================================================
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEDIA_DIR: str = os.path.abspath(os.getenv("MEDIA_DIR", os.path.join(_BASE_DIR, "media")))
os.makedirs(MEDIA_DIR, exist_ok=True)
