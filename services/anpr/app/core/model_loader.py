"""
Cargador de Modelos YOLO con Soporte de Cuantización

Este módulo proporciona una interfaz unificada para cargar modelos YOLO
con diferentes tipos de cuantización (INT8, FP16, TensorRT) para optimizar
el rendimiento de inferencia en producción.
"""

import os
import logging
from pathlib import Path
from typing import Optional, Literal
import torch

from ultralytics import YOLO
from app.config import (
    ENABLE_MODEL_QUANTIZATION,
    QUANTIZATION_TYPE,
    QUANTIZED_MODEL_PATH,
    QUANTIZED_PLATE_MODEL_PATH,
    YOLO_MODEL_PATH,
    PLATE_MODEL_PATH,
)

logger = logging.getLogger(__name__)


class ModelLoader:
    """
    Cargador de modelos YOLO con soporte para cuantización.
    
    Maneja automáticamente la selección del modelo apropiado según
    la configuración y el hardware disponible.
    """
    
    def __init__(self):
        self._model_cache = {}
        self._hw_support = self._check_hardware_support()
    
    def _check_hardware_support(self) -> dict:
        """Verifica el soporte de hardware para diferentes tipos de cuantización."""
        cuda_available = torch.cuda.is_available()
        
        support = {
            'cuda': cuda_available,
            'int8': hasattr(torch, 'quantization'),
            'fp16': cuda_available or hasattr(torch, 'half'),
            'tensorrt': cuda_available
        }
        
        logger.info(f"Soporte de hardware detectado: {support}")
        return support
    
    def _select_model_path(
        self,
        model_type: Literal['yolo', 'plate'],
        quantization: Optional[str] = None
    ) -> str:
        """
        Selecciona la ruta del modelo apropiada según la configuración.
        
        Args:
            model_type: Tipo de modelo ('yolo' o 'plate')
            quantization: Tipo de cuantización forzado (opcional)
        
        Returns:
            Ruta al modelo seleccionado
        """
        # Determinar si usar cuantización
        use_quantization = quantization or (
            ENABLE_MODEL_QUANTIZATION and self._is_quantization_supported()
        )
        
        if not use_quantization:
            # Usar modelo original
            base_path = YOLO_MODEL_PATH if model_type == 'yolo' else PLATE_MODEL_PATH
            logger.info(f"Usando modelo original: {base_path}")
            return base_path
        
        # Determinar tipo de cuantización
        quant_type = quantization or QUANTIZATION_TYPE
        
        # Seleccionar ruta del modelo cuantizado
        if model_type == 'yolo':
            quantized_path = QUANTIZED_MODEL_PATH
        else:
            quantized_path = QUANTIZED_PLATE_MODEL_PATH
        
        # Verificar si el modelo cuantizado existe
        if os.path.exists(quantized_path):
            logger.info(f"Usando modelo cuantizado ({quant_type}): {quantized_path}")
            return quantized_path
        else:
            logger.warning(
                f"Modelo cuantizado no encontrado: {quantized_path}. "
                f"Usando modelo original como fallback."
            )
            base_path = YOLO_MODEL_PATH if model_type == 'yolo' else PLATE_MODEL_PATH
            return base_path
    
    def _is_quantization_supported(self) -> bool:
        """Verifica si el tipo de cuantización configurado es soportado."""
        if QUANTIZATION_TYPE == 'int8':
            return self._hw_support['int8']
        elif QUANTIZATION_TYPE == 'fp16':
            return self._hw_support['fp16']
        elif QUANTIZATION_TYPE == 'tensorrt':
            return self._hw_support['tensorrt']
        return False
    
    def load_model(
        self,
        model_type: Literal['yolo', 'plate'] = 'yolo',
        quantization: Optional[str] = None,
        force_reload: bool = False
    ) -> YOLO:
        """
        Carga un modelo YOLO con cuantización si está configurado.
        
        Args:
            model_type: Tipo de modelo ('yolo' o 'plate')
            quantization: Tipo de cuantización forzado (opcional)
            force_reload: Forzar recarga del modelo
        
        Returns:
            Instancia del modelo YOLO cargado
        """
        cache_key = f"{model_type}_{quantization or QUANTIZATION_TYPE}"
        
        # Retornar modelo cacheado si existe
        if not force_reload and cache_key in self._model_cache:
            logger.info(f"Retornando modelo cacheado: {cache_key}")
            return self._model_cache[cache_key]
        
        # Seleccionar ruta del modelo
        model_path = self._select_model_path(model_type, quantization)
        
        if not os.path.exists(model_path):
            raise FileNotFoundError(f"Modelo no encontrado: {model_path}")
        
        try:
            # Cargar modelo
            logger.info(f"Cargando modelo desde: {model_path}")
            model = YOLO(model_path)
            
            # Aplicar optimizaciones según el tipo
            if quantization == 'fp16' or (ENABLE_MODEL_QUANTIZATION and QUANTIZATION_TYPE == 'fp16'):
                if self._hw_support['fp16']:
                    logger.info("Aplicando FP16 (half precision)...")
                    model.model.half()
                    if torch.cuda.is_available():
                        model.model.cuda()
            
            elif quantization == 'int8' or (ENABLE_MODEL_QUANTIZATION and QUANTIZATION_TYPE == 'int8'):
                if self._hw_support['int8']:
                    logger.info("Aplicando INT8 quantization...")
                    # La cuantización INT8 se aplica durante la exportación ONNX
                    # El modelo ya viene cuantizado en el archivo
            
            # Cachear modelo
            self._model_cache[cache_key] = model
            
            logger.info(f"Modelo cargado exitosamente: {cache_key}")
            return model
            
        except Exception as e:
            logger.error(f"Error cargando modelo {model_path}: {e}")
            # Intentar fallback al modelo original
            if quantization or ENABLE_MODEL_QUANTIZATION:
                logger.info("Intentando fallback al modelo original...")
                original_path = YOLO_MODEL_PATH if model_type == 'yolo' else PLATE_MODEL_PATH
                if os.path.exists(original_path):
                    model = YOLO(original_path)
                    self._model_cache[cache_key] = model
                    return model
            raise
    
    def get_model_info(self, model: YOLO) -> dict:
        """
        Obtiene información detallada sobre el modelo cargado.
        
        Args:
            model: Instancia del modelo YOLO
        
        Returns:
            Diccionario con información del modelo
        """
        info = {
            'type': type(model).__name__,
            'task': getattr(model, 'task', 'unknown'),
            'names': getattr(model, 'names', {}),
            'device': str(next(model.model.parameters()).device) if hasattr(model.model, 'parameters') else 'unknown',
            'precision': 'fp16' if hasattr(model.model, 'half') else 'fp32',
        }
        
        # Obtener tamaño del modelo
        if hasattr(model, 'model') and hasattr(model.model, 'parameters'):
            param_count = sum(p.numel() for p in model.model.parameters())
            info['parameters'] = param_count
            info['parameters_millions'] = param_count / 1e6
        
        return info
    
    def clear_cache(self):
        """Limpia el cache de modelos."""
        self._model_cache.clear()
        logger.info("Cache de modelos limpiado")


# Instancia global del cargador
_model_loader = ModelLoader()


def load_yolo_model(
    model_type: Literal['yolo', 'plate'] = 'yolo',
    quantization: Optional[str] = None,
    force_reload: bool = False
) -> YOLO:
    """
    Función conveniente para cargar modelos YOLO.
    
    Args:
        model_type: Tipo de modelo ('yolo' o 'plate')
        quantization: Tipo de cuantización forzado (opcional)
        force_reload: Forzar recarga del modelo
    
    Returns:
        Instancia del modelo YOLO cargado
    """
    return _model_loader.load_model(model_type, quantization, force_reload)


def get_model_info(model: YOLO) -> dict:
    """
    Función conveniente para obtener información del modelo.
    
    Args:
        model: Instancia del modelo YOLO
    
    Returns:
        Diccionario con información del modelo
    """
    return _model_loader.get_model_info(model)


def clear_model_cache():
    """Función conveniente para limpiar el cache de modelos."""
    _model_loader.clear_cache()