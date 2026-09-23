"""
Gestor Multi-Cámara para el Sistema ANPR

Este módulo permite gestionar múltiples cámaras simultáneamente,
cada una con su propio pipeline de detección y tracking.
"""

import asyncio
import threading
import time
from typing import Dict, List, Optional
from dataclasses import dataclass
from enum import Enum

import cv2
import numpy as np

from app.core.video_source import VideoSource, create_video_source
from app.core.detector import DetectionPipeline, create_detection_pipeline
from app.core.frame_selector import BestFrameSelector
from app.services.ocr_worker import AsyncOcrWorker
from app.utils.logger import get_logger

logger = get_logger("multi_camera_manager")


class CameraStatus(Enum):
    """Estado de una cámara"""
    OFFLINE = "offline"
    STARTING = "starting"
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    ERROR = "error"


@dataclass
class CameraConfig:
    """Configuración de una cámara"""
    camera_id: int
    name: str
    source_type: str  # 'rtsp', 'http', 'webcam'
    source_url: str
    priority: int = 1
    enabled: bool = True
    region: str = "default"


@dataclass
class CameraStats:
    """Estadísticas de una cámara"""
    camera_id: int
    fps: float
    detection_count: int
    plate_recognized_count: int
    last_detection_time: float
    confidence_avg: float
    status: CameraStatus
    error_message: Optional[str] = None


class CameraProcessor:
    """Procesador individual para una cámara"""
    
    def __init__(
        self,
        config: CameraConfig,
        pipeline: DetectionPipeline,
        frame_selector: BestFrameSelector,
        ocr_worker: AsyncOcrWorker
    ):
        self.config = config
        self.pipeline = pipeline
        self.frame_selector = frame_selector
        self.ocr_worker = ocr_worker
        
        self.video_source: Optional[VideoSource] = None
        self.running = False
        self.thread: Optional[threading.Thread] = None
        
        self.stats = CameraStats(
            camera_id=config.camera_id,
            fps=0.0,
            detection_count=0,
            plate_recognized_count=0,
            last_detection_time=0.0,
            confidence_avg=0.0,
            status=CameraStatus.OFFLINE
        )
        
        self._fps_window: List[float] = []
        self._last_fps_calc = time.time()
    
    def start(self):
        """Iniciar el procesamiento de la cámara"""
        if self.running:
            logger.warning(f"Cámara {self.config.camera_id} ya está corriendo")
            return
        
        self.running = True
        self.stats.status = CameraStatus.STARTING
        
        self.thread = threading.Thread(
            target=self._process_loop,
            daemon=True,
            name=f"Camera-{self.config.camera_id}"
        )
        self.thread.start()
        
        logger.info(f"Cámara {self.config.camera_id} iniciada")
    
    def stop(self):
        """Detener el procesamiento de la cámara"""
        self.running = False
        
        if self.video_source:
            self.video_source.release()
        
        if self.thread:
            self.thread.join(timeout=5.0)
        
        self.stats.status = CameraStatus.OFFLINE
        logger.info(f"Cámara {self.config.camera_id} detenida")
    
    def _process_loop(self):
        """Bucle principal de procesamiento"""
        try:
            # Crear fuente de video
            self.video_source = create_video_source(
                source_type=self.config.source_type,
                source_url=self.config.source_url
            )
            
            if not self.video_source.connect():
                self.stats.status = CameraStatus.ERROR
                self.stats.error_message = "No se pudo conectar a la fuente de video"
                logger.error(f"Error conectando a cámara {self.config.camera_id}")
                return
            
            self.stats.status = CameraStatus.HEALTHY
            logger.info(f"Conectado a cámara {self.config.camera_id}")
            
            frame_count = 0
            fps_start = time.time()
            
            while self.running:
                ret, frame = self.video_source.read_frame()
                
                if not ret or frame is None:
                    logger.warning(f"Frame inválido de cámara {self.config.camera_id}")
                    time.sleep(0.1)
                    continue
                
                frame_count += 1
                
                # Calcular FPS
                if frame_count % 30 == 0:
                    elapsed = time.time() - fps_start
                    if elapsed > 0:
                        fps = 30.0 / elapsed
                        self._fps_window.append(fps)
                        if len(self._fps_window) > 10:
                            self._fps_window.pop(0)
                        self.stats.fps = sum(self._fps_window) / len(self._fps_window)
                    fps_start = time.time()
                
                # Procesar frame con pipeline
                try:
                    tracked_rois = self.pipeline.detect_and_track(frame)
                    
                    if tracked_rois:
                        self.stats.detection_count += len(tracked_rois)
                        self.stats.last_detection_time = time.time()
                        
                        # Calcular confianza promedio
                        confidences = [roi.confidence for roi in tracked_rois]
                        if confidences:
                            self.stats.confidence_avg = sum(confidences) / len(confidences)
                        
                        # Contar placas reconocidas
                        for roi in tracked_rois:
                            track_info = self.pipeline.get_track_info(roi.tracking_id)
                            if track_info and track_info.get('plate'):
                                self.stats.plate_recognized_count += 1
                                
                                # Evaluar frame selector
                                selected = self.frame_selector.evaluate_and_select(
                                    tracking_id=roi.tracking_id,
                                    frame=frame,
                                    plate_bbox=roi.plate_bbox,
                                    confidence=roi.confidence,
                                    frame_idx=frame_count
                                )
                                if selected:
                                    # Aquí se dispararía el OCR y envío al backend
                                    pass
                
                except Exception as e:
                    logger.error(f"Error procesando frame de cámara {self.config.camera_id}: {e}")
                    self.stats.status = CameraStatus.DEGRADED
                
                # Control de FPS
                time.sleep(0.01)
            
        except Exception as e:
            logger.error(f"Error en bucle de cámara {self.config.camera_id}: {e}")
            self.stats.status = CameraStatus.ERROR
            self.stats.error_message = str(e)
        
        finally:
            if self.video_source:
                self.video_source.release()


class MultiCameraManager:
    """Gestor de múltiples cámaras"""
    
    def __init__(self):
        self.cameras: Dict[int, CameraProcessor] = {}
        self.camera_configs: Dict[int, CameraConfig] = {}
        self.lock = threading.Lock()
        
        # Pipeline compartido (opcional, puede ser individual por cámara)
        self._shared_pipeline: Optional[DetectionPipeline] = None
        self._shared_frame_selector: Optional[BestFrameSelector] = None
        self._shared_ocr_worker: Optional[AsyncOcrWorker] = None
    
    def initialize_shared_pipeline(self):
        """Inicializar pipeline compartido"""
        try:
            self._shared_pipeline = create_detection_pipeline()
            self._shared_frame_selector = BestFrameSelector()
            self._shared_ocr_worker = AsyncOcrWorker()
            logger.info("Pipeline compartido inicializado")
        except Exception as e:
            logger.error(f"Error inicializando pipeline compartido: {e}")
    
    def add_camera(self, config: CameraConfig):
        """Agregar una cámara al sistema"""
        with self.lock:
            if config.camera_id in self.cameras:
                logger.warning(f"Cámara {config.camera_id} ya existe")
                return False
            
            if not config.enabled:
                logger.info(f"Cámara {config.camera_id} deshabilitada, no se inicia")
                return False
            
            # Crear procesador de cámara
            processor = CameraProcessor(
                config=config,
                pipeline=self._shared_pipeline,
                frame_selector=self._shared_frame_selector,
                ocr_worker=self._shared_ocr_worker
            )
            
            self.cameras[config.camera_id] = processor
            self.camera_configs[config.camera_id] = config
            
            # Iniciar procesamiento
            processor.start()
            
            logger.info(f"Cámara {config.camera_id} agregada al sistema")
            return True
    
    def remove_camera(self, camera_id: int):
        """Remover una cámara del sistema"""
        with self.lock:
            if camera_id not in self.cameras:
                logger.warning(f"Cámara {camera_id} no existe")
                return False
            
            # Detener procesador
            self.cameras[camera_id].stop()
            
            # Remover de diccionarios
            del self.cameras[camera_id]
            del self.camera_configs[camera_id]
            
            logger.info(f"Cámara {camera_id} removida del sistema")
            return True
    
    def get_camera_stats(self, camera_id: int) -> Optional[CameraStats]:
        """Obtener estadísticas de una cámara específica"""
        with self.lock:
            processor = self.cameras.get(camera_id)
            if processor:
                return processor.stats
            return None
    
    def get_all_stats(self) -> Dict[int, CameraStats]:
        """Obtener estadísticas de todas las cámaras"""
        with self.lock:
            return {
                camera_id: processor.stats 
                for camera_id, processor in self.cameras.items()
            }
    
    def get_health_summary(self) -> Dict:
        """Obtener resumen de health de todas las cámaras"""
        with self.lock:
            total = len(self.cameras)
            healthy = sum(1 for p in self.cameras.values() if p.stats.status == CameraStatus.HEALTHY)
            degraded = sum(1 for p in self.cameras.values() if p.stats.status == CameraStatus.DEGRADED)
            offline = sum(1 for p in self.cameras.values() if p.stats.status == CameraStatus.OFFLINE)
            error = sum(1 for p in self.cameras.values() if p.stats.status == CameraStatus.ERROR)
            
            avg_fps = 0.0
            if self.cameras:
                fps_values = [p.stats.fps for p in self.cameras.values() if p.stats.fps > 0]
                if fps_values:
                    avg_fps = sum(fps_values) / len(fps_values)
            
            total_detections = sum(p.stats.detection_count for p in self.cameras.values())
            
            return {
                'total_cameras': total,
                'healthy_cameras': healthy,
                'degraded_cameras': degraded,
                'offline_cameras': offline,
                'error_cameras': error,
                'avg_fps': avg_fps,
                'total_detections': total_detections
            }
    
    def update_camera_config(self, camera_id: int, config: CameraConfig):
        """Actualizar configuración de una cámara"""
        with self.lock:
            if camera_id not in self.cameras:
                logger.warning(f"Cámara {camera_id} no existe")
                return False
            
            # Si cambió enabled status
            old_config = self.camera_configs[camera_id]
            if old_config.enabled != config.enabled:
                if config.enabled:
                    # Reactivar cámara
                    self.cameras[camera_id].start()
                else:
                    # Desactivar cámara
                    self.cameras[camera_id].stop()
            
            # Actualizar configuración
            self.camera_configs[camera_id] = config
            
            logger.info(f"Configuración de cámara {camera_id} actualizada")
            return True
    
    def shutdown(self):
        """Apagar todas las cámaras"""
        with self.lock:
            for camera_id, processor in self.cameras.items():
                logger.info(f"Deteniendo cámara {camera_id}")
                processor.stop()
            
            self.cameras.clear()
            self.camera_configs.clear()
            
            logger.info("Multi-camera manager apagado")


# Instancia global
_multi_camera_manager: Optional[MultiCameraManager] = None


def get_multi_camera_manager() -> MultiCameraManager:
    """Obtener instancia global del gestor multi-cámara"""
    global _multi_camera_manager
    if _multi_camera_manager is None:
        _multi_camera_manager = MultiCameraManager()
        _multi_camera_manager.initialize_shared_pipeline()
    return _multi_camera_manager