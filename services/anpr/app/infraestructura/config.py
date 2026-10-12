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
LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO").upper()

# =============================================================================
# Fuente de Video
# =============================================================================
RTSP_URL: str = os.getenv("RTSP_URL", os.getenv("RTSP_STREAM_URL", ""))
DEBUG_SHOW_WINDOW: bool = os.getenv("DEBUG_SHOW_WINDOW", "false").lower() in ("true", "1", "yes")

# =============================================================================
# Modelo YOLO
# =============================================================================
PLATE_MODEL_PATH: str = os.getenv("PLATE_MODEL_PATH", "models/license_plate_detector.pt")
YOLO_CONFIDENCE_THRESHOLD: float = float(os.getenv("YOLO_CONFIDENCE_THRESHOLD", "0.45"))
PLATE_CONFIDENCE_THRESHOLD: float = float(os.getenv("PLATE_CONFIDENCE_THRESHOLD", "0.22"))

# =============================================================================
# Proporción de la placa (ANT Ecuador)
# =============================================================================
# Rangos normativos de Relación de Aspecto (Aspect Ratio) - ANT Ecuador
# Autos/Camionetas: 404x140mm (AR ~ 2.89) o Mercosur/Latam (AR ~ 2.0)
CAR_PLATE_AR_MIN: float = float(os.getenv("CAR_PLATE_AR_MIN", "1.75"))
CAR_PLATE_AR_MAX: float = float(os.getenv("CAR_PLATE_AR_MAX", "3.80"))
# Motocicletas: 200x160mm (AR ~ 1.25)
MOTO_PLATE_AR_MIN: float = float(os.getenv("MOTO_PLATE_AR_MIN", "1.05"))
MOTO_PLATE_AR_MAX: float = float(os.getenv("MOTO_PLATE_AR_MAX", "1.55"))

# =============================================================================
# Motor OCR & ALPR
# =============================================================================
OCR_ENGINE: str = os.getenv("OCR_ENGINE", "hybrid").lower()  # "fastalpr" | "hybrid" | "paddleocr" | "easyocr"
OCR_CONFIDENCE_THRESHOLD: float = float(os.getenv("OCR_CONFIDENCE_THRESHOLD", "0.30"))
TESSERACT_CMD: str = os.getenv("TESSERACT_CMD", "")  # Ruta al ejecutable en Windows
FASTALPR_DET_MODEL: str = os.getenv("FASTALPR_DET_MODEL", "yolo-v9-t-384-license-plate-end2end")
FASTALPR_OCR_MODEL: str = os.getenv("FASTALPR_OCR_MODEL", "global-plates-mobile-vit-v2-model")
OPENCV_CLAHE_ENABLED: bool = os.getenv("OPENCV_CLAHE_ENABLED", "true").lower() in ("true", "1", "yes")
OPENCV_UNSHARP_ENABLED: bool = os.getenv("OPENCV_UNSHARP_ENABLED", "true").lower() in ("true", "1", "yes")

# OCR especializado de placas (fast-plate-ocr). Si existe un modelo afinado con placas
# ecuatorianas (scripts/train_ocr.py), se usa ese ONNX + su plate config; si no, el modelo
# global del hub. El preprocesado OpenCV se desactiva por defecto: el modelo se entrenó con
# imágenes sin realzar y el benchmark mostró que CLAHE/bilateral/unsharp lo empeoran.
PLATE_OCR_HUB_MODEL: str = os.getenv("PLATE_OCR_HUB_MODEL", "cct-s-v2-global-model")
PLATE_OCR_ONNX_PATH: str = os.getenv("PLATE_OCR_ONNX_PATH", "models/ocr/cct_s_v2_ecuador.onnx")
PLATE_OCR_CONFIG_PATH: str = os.getenv("PLATE_OCR_CONFIG_PATH", "models/ocr/cct_s_v2_ecuador_plate_config.yaml")
PLATE_OCR_PREPROCESS: bool = os.getenv("PLATE_OCR_PREPROCESS", "false").lower() in ("true", "1", "yes")

# Segunda lectura con PP-OCRv6 (RapidOCR + OpenVINO) sobre la mejor foto, en la fase
# asíncrona de verificación. Si excede OCR_VERIFIER_MAX_MS se descarta su resultado.
OCR_VERIFIER_ENABLED: bool = os.getenv("OCR_VERIFIER_ENABLED", "true").lower() in ("true", "1", "yes")
OCR_VERIFIER_MODEL: str = os.getenv("OCR_VERIFIER_MODEL", "medium").lower()  # tiny | small | medium
OCR_VERIFIER_ENGINE: str = os.getenv("OCR_VERIFIER_ENGINE", "openvino").lower()  # openvino | onnxruntime
OCR_VERIFIER_MAX_MS: float = float(os.getenv("OCR_VERIFIER_MAX_MS", "2000"))
# Peso del voto del verificador en el consenso temporal (una lectura normal pesa su confianza ≤ 1)
OCR_VERIFIER_VOTE_WEIGHT: float = float(os.getenv("OCR_VERIFIER_VOTE_WEIGHT", "2.0"))

# --- Hilos por motor de inferencia (CPU) ---
# PyTorch (detector de placas y atributos del vehículo), ONNX Runtime (OCR rápido) y OpenVINO
# (verificador) usan por omisión todos los núcleos. Como corren a la vez (detección continua, OCR
# asíncrono, verificación del registro), se sobresuscribe la CPU y cada etapa tarda varias veces
# más. Se reparte un número fijo de hilos por motor (docs/METODO_VERIFICACION_LECTURA.md §3.2).
TORCH_THREADS: int = int(os.getenv("TORCH_THREADS", "4"))
OCR_THREADS: int = int(os.getenv("OCR_THREADS", "2"))
OCR_VERIFIER_THREADS: int = int(os.getenv("OCR_VERIFIER_THREADS", "4"))

# Rectificador aprendido (YOLO26n-pose, 4 esquinas). Si el archivo no existe se usa la
# rectificación heurística por contornos. Entrenar con scripts/train_plate_rectifier.py.
PLATE_RECTIFIER_PATH: str = os.getenv("PLATE_RECTIFIER_PATH", "models/plate_rectifier.pt")
PLATE_RECTIFIER_MIN_KPT_CONF: float = float(os.getenv("PLATE_RECTIFIER_MIN_KPT_CONF", "0.5"))

# Atributos del vehículo (tipo, color, marca, modelo) como segundo factor para las listas.
# YOLO26n COCO ubica el vehículo y CLIP (zero-shot) clasifica contra el catálogo ecuatoriano.
VEHICLE_ATTR_ENABLED: bool = os.getenv("VEHICLE_ATTR_ENABLED", "true").lower() in ("true", "1", "yes")
VEHICLE_DETECTOR_PATH: str = os.getenv("VEHICLE_DETECTOR_PATH", "yolo26n.pt")
VEHICLE_CLIP_MODEL: str = os.getenv("VEHICLE_CLIP_MODEL", "ViT-B-32")
VEHICLE_CLIP_PRETRAINED: str = os.getenv("VEHICLE_CLIP_PRETRAINED", "laion2b_s34b_b79k")
# Probabilidad mínima para aceptar un atributo; por debajo se reporta como desconocido
VEHICLE_ATTR_MIN_CONF: float = float(os.getenv("VEHICLE_ATTR_MIN_CONF", "0.35"))

# Detector de placas: "yolo" (YOLO26 vía Ultralytics) o "rfdetr" (RF-DETR, experimental)
DETECTOR_BACKEND: str = os.getenv("DETECTOR_BACKEND", "yolo").lower()
# Arquitectura que debe tener el detector de placas cargado (se verifica al arrancar y se
# publica en /status). Ver models/MODEL_CARD.md.
PLATE_DETECTOR_ARCH: str = os.getenv("PLATE_DETECTOR_ARCH", "yolo26").lower()

# =============================================================================
# Compuerta de movimiento (docs/METODO_VERIFICACION_LECTURA.md §2.4)
# =============================================================================
# El detector de placas solo se ejecuta si desde la última inferencia cambió al menos
# MOTION_GATE_MIN_FRACTION del área (o de la región de interés); si no, la última detección
# sigue valiendo, con una inferencia de control cada MOTION_GATE_MAX_SKIP cuadros. "false" la
# desactiva (cada cuadro pasa por el detector), p. ej. para medir su efecto.
MOTION_GATE_ENABLED: bool = os.getenv("MOTION_GATE_ENABLED", "true").lower() in ("true", "1", "yes")
MOTION_GATE_MIN_FRACTION: float = float(os.getenv("MOTION_GATE_MIN_FRACTION", "0.002"))
MOTION_GATE_MAX_SKIP: int = int(os.getenv("MOTION_GATE_MAX_SKIP", "5"))

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

# Token compartido con el backend para las rutas máquina a máquina (/api/detecciones/ingreso,
# /completar-ocr, /descarte). Debe coincidir con ANPR_SERVICE_TOKEN del backend.
ANPR_SERVICE_TOKEN: str = os.getenv("ANPR_SERVICE_TOKEN", "")
BACKEND_HEADERS: dict[str, str] = {"X-Servicio-Token": ANPR_SERVICE_TOKEN} if ANPR_SERVICE_TOKEN else {}

# =============================================================================
# Base de Datos / Cámara
# =============================================================================
CAMERA_ID: int = int(os.getenv("CAMERA_ID", "1"))

# =============================================================================
# Almacenamiento de Imágenes
# =============================================================================
# Carpeta del servicio (services/anpr): app/infraestructura/config.py está tres niveles abajo
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MEDIA_DIR: str = os.path.abspath(os.getenv("MEDIA_DIR", os.path.join(_BASE_DIR, "media")))
os.makedirs(MEDIA_DIR, exist_ok=True)
