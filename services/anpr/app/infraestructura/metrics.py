"""
Servicio de Métricas Prometheus para el Microservicio ANPR

Este módulo proporciona métricas detalladas del servicio ANPR
para monitoreo con Prometheus y visualización en Grafana.
"""

from prometheus_client import Counter, Histogram, Gauge, CollectorRegistry, generate_latest
import time
from typing import Optional
from functools import wraps

# Crear registro de métricas
registry = CollectorRegistry()

# =============================================================================
# Métricas HTTP
# =============================================================================

http_request_duration = Histogram(
    'anpr_http_request_duration_seconds',
    'Duración de solicitudes HTTP en segundos',
    ['method', 'endpoint', 'status'],
    registry=registry,
    buckets=(0.1, 0.5, 1, 2, 5, 10)
)

http_requests_total = Counter(
    'anpr_http_requests_total',
    'Total de solicitudes HTTP',
    ['method', 'endpoint', 'status'],
    registry=registry
)

# =============================================================================
# Métricas de Inferencia
# =============================================================================

inference_duration = Histogram(
    'anpr_inference_duration_seconds',
    'Duración de inferencia YOLO en segundos',
    ['model_type'],
    registry=registry,
    buckets=(0.01, 0.05, 0.1, 0.5, 1)
)

ocr_duration = Histogram(
    'anpr_ocr_duration_seconds',
    'Duración del proceso OCR en segundos',
    ['ocr_engine'],
    registry=registry,
    buckets=(0.1, 0.5, 1, 2, 5, 10)
)

frame_processing_duration = Histogram(
    'anpr_frame_processing_duration_seconds',
    'Duración de procesamiento de frame en segundos',
    ['stage'],
    registry=registry,
    buckets=(0.001, 0.005, 0.01, 0.05, 0.1)
)

# =============================================================================
# Métricas de Rendimiento
# =============================================================================

fps_gauge = Gauge(
    'anpr_fps',
    'FPS actual del servicio ANPR',
    ['camera_id'],
    registry=registry
)

detection_confidence = Histogram(
    'anpr_detection_confidence',
    'Confianza de detección de placas',
    registry=registry,
    buckets=(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0)
)

ocr_confidence = Histogram(
    'anpr_ocr_confidence',
    'Confianza de reconocimiento OCR',
    registry=registry,
    buckets=(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0)
)

# =============================================================================
# Métricas de Negocio
# =============================================================================

detections_total = Counter(
    'anpr_detections_total',
    'Total de detecciones de placas',
    ['status', 'camera_id'],
    registry=registry
)

plates_recognized = Counter(
    'anpr_plates_recognized_total',
    'Total de placas reconocidas exitosamente',
    ['validation_status'],
    registry=registry
)

tracking_active = Gauge(
    'anpr_tracking_active',
    'Número de tracks activos',
    registry=registry
)

recognition_latency = Histogram(
    'anpr_recognition_latency_seconds',
    'Tiempo desde que aparece la placa (nacimiento del track) hasta su registro con la lectura',
    buckets=(0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0),
    registry=registry
)

inferences_total = Counter(
    'anpr_inferences_total',
    'Cuadros analizados por fuente: el detector se ejecutó o la compuerta de movimiento lo omitió',
    ['source', 'result'],
    registry=registry
)

# =============================================================================
# Métricas de Errores
# =============================================================================

detection_errors = Counter(
    'anpr_detection_errors_total',
    'Total de errores en detección',
    ['error_type'],
    registry=registry
)

ocr_errors = Counter(
    'anpr_ocr_errors_total',
    'Total de errores en OCR',
    ['error_type'],
    registry=registry
)

# =============================================================================
# Decoradores para medir tiempo
# =============================================================================

def measure_http_request(method: str, endpoint: str):
    """Decorador para medir tiempo de solicitudes HTTP"""
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            start_time = time.time()
            status = '200'
            try:
                result = await func(*args, **kwargs)
                return result
            except Exception as e:
                status = '500'
                raise
            finally:
                duration = time.time() - start_time
                http_request_duration.labels(method=method, endpoint=endpoint, status=status).observe(duration)
                http_requests_total.labels(method=method, endpoint=endpoint, status=status).inc()
        return wrapper
    return decorator

def measure_inference(model_type: str = 'yolo'):
    """Decorador para medir tiempo de inferencia"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            start_time = time.time()
            try:
                result = func(*args, **kwargs)
                return result
            finally:
                duration = time.time() - start_time
                inference_duration.labels(model_type=model_type).observe(duration)
        return wrapper
    return decorator

def measure_ocr(ocr_engine: str = 'easyocr'):
    """Decorador para medir tiempo de OCR"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            start_time = time.time()
            try:
                result = func(*args, **kwargs)
                return result
            finally:
                duration = time.time() - start_time
                ocr_duration.labels(ocr_engine=ocr_engine).observe(duration)
        return wrapper
    return decorator

def measure_frame_processing(stage: str):
    """Decorador para medir tiempo de procesamiento de frame"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            start_time = time.time()
            try:
                result = func(*args, **kwargs)
                return result
            finally:
                duration = time.time() - start_time
                frame_processing_duration.labels(stage=stage).observe(duration)
        return wrapper
    return decorator

# =============================================================================
# Funciones Helper
# =============================================================================

def update_fps(fps: float, camera_id: str = 'default'):
    """Actualiza el FPS actual"""
    fps_gauge.labels(camera_id=camera_id).set(fps)

def record_detection(status: str, camera_id: str = 'default'):
    """Registra una detección"""
    detections_total.labels(status=status, camera_id=camera_id).inc()

def record_plate_recognized(validation_status: str):
    """Registra una placa reconocida"""
    plates_recognized.labels(validation_status=validation_status).inc()

def update_tracking_active(count: int):
    """Actualiza el número de tracks activos"""
    tracking_active.set(count)

def record_recognition_latency(seconds: float):
    """Registra la latencia de reconocimiento de punta a punta de un paso"""
    recognition_latency.observe(seconds)

def record_inference(source: str, skipped: bool):
    """Registra un cuadro analizado: detector ejecutado u omitido por la compuerta de movimiento"""
    inferences_total.labels(source=source, result='skipped' if skipped else 'executed').inc()

def record_detection_confidence(confidence: float):
    """Registra la confianza de detección"""
    detection_confidence.observe(confidence)

def record_ocr_confidence(confidence: float):
    """Registra la confianza de OCR"""
    ocr_confidence.observe(confidence)

def record_detection_error(error_type: str):
    """Registra un error de detección"""
    detection_errors.labels(error_type=error_type).inc()

def record_ocr_error(error_type: str):
    """Registra un error de OCR"""
    ocr_errors.labels(error_type=error_type).inc()

def get_metrics() -> bytes:
    """Retorna las métricas en formato Prometheus"""
    return generate_latest(registry)