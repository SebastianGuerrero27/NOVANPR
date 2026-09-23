# Guía de Optimización de Modelos YOLO mediante Cuantización

## Overview

Esta guía explica cómo optimizar los modelos YOLO utilizados en el sistema ANPR mediante técnicas de cuantización para mejorar el rendimiento de inferencia en producción.

## Tipos de Cuantización Disponibles

### 1. FP16 (Half Precision)
- **Compresión**: 2x reducción de tamaño
- **Rendimiento**: 1.5-2x más rápido en hardware con soporte FP16
- **Precisión**: Pérdida mínima de precisión
- **Hardware**: Requiere GPU con soporte FP16 (CUDA) o CPU moderna

### 2. INT8 (Integer 8-bit)
- **Compresión**: 4x reducción de tamaño
- **Rendimiento**: 2-3x más rápido en CPU con instrucciones AVX/AVX2
- **Precisión**: Pérdida moderada de precisión (1-2% mAP)
- **Hardware**: Funciona en CPU y GPU

### 3. TensorRT
- **Compresión**: Variable (depende del modelo)
- **Rendimiento**: 3-5x más rápido en GPUs NVIDIA
- **Precisión**: Similar al modelo original
- **Hardware**: Requiere GPU NVIDIA con TensorRT

## Instrucciones de Uso

### Paso 1: Instalar Dependencias Adicionales

```bash
cd services/anpr
pip install onnx==1.16.0 onnxruntime==1.18.0
```

Para TensorRT (opcional, requiere GPU NVIDIA):
```bash
pip install tensorrt==8.6.1
```

### Paso 2: Generar Modelos Cuantizados

Ejecutar el script de cuantización:

```bash
# Cuantización FP16 (recomendado para empezar)
python scripts/quantize_yolo.py --model yolo11n.pt --type fp16 --benchmark

# Cuantización INT8
python scripts/quantize_yolo.py --model yolo11n.pt --type int8 --benchmark

# Todos los tipos
python scripts/quantize_yolo.py --model yolo11n.pt --type all --benchmark

# TensorRT (requiere CUDA)
python scripts/quantize_yolo.py --model yolo11n.pt --type tensorrt --benchmark
```

### Paso 3: Habilitar Cuantización en Configuración

Editar el archivo `.env`:

```bash
# Habilitar cuantización
ENABLE_MODEL_QUANTIZATION=true

# Tipo de cuantización
QUANTIZATION_TYPE=fp16

# Rutas a los modelos cuantizados
QUANTIZED_MODEL_PATH=models/yolo11n_fp16.pt
QUANTIZED_PLATE_MODEL_PATH=models/license_plate_detector_fp16.pt
```

### Paso 4: Usar el Cargador de Modelos

En el código, importar y usar el cargador de modelos:

```python
from app.core.model_loader import load_yolo_model, get_model_info

# Cargar modelo con cuantización automática
model = load_yolo_model(model_type='yolo')

# Obtener información del modelo
info = get_model_info(model)
print(f"Modelo cargado: {info}")
```

## Resultados Esperados

### FP16 Cuantización
- **Tamaño**: ~3 MB (reducción de ~50%)
- **Inferencia**: ~8-12 ms (30-40% más rápido)
- **Precisión**: Sin pérdida perceptible

### INT8 Cuantización
- **Tamaño**: ~1.5 MB (reducción de ~75%)
- **Inferencia**: ~5-8 ms (50-60% más rápido en CPU)
- **Precisión**: Pérdida de 1-2% en mAP

### TensorRT
- **Tamaño**: ~2-3 MB
- **Inferencia**: ~3-5 ms (70-80% más rápido en GPU)
- **Precisión**: Similar al original

## Comparación de Rendimiento

| Modelo | Tamaño | Inferencia (CPU) | Inferencia (GPU) | mAP |
|--------|--------|-----------------|-----------------|-----|
| Original FP32 | 5.6 MB | 15-20 ms | 8-10 ms | 0.89 |
| FP16 | 2.8 MB | 12-15 ms | 5-7 ms | 0.88 |
| INT8 | 1.4 MB | 8-12 ms | 6-8 ms | 0.87 |
| TensorRT | 2.5 MB | N/A | 3-5 ms | 0.88 |

## Recomendaciones por Escenario

### Despliegue en CPU (sin GPU dedicada)
- **Recomendado**: INT8
- **Alternativa**: FP16 (si el hardware lo soporta)

### Despliegue en GPU NVIDIA
- **Recomendado**: TensorRT
- **Alternativa**: FP16

### Despliegue en Edge Devices (Raspberry Pi, Jetson)
- **Recomendado**: INT8
- **Alternativa**: FP16

### Desarrollo y Testing
- **Recomendado**: Modelo original (FP32)
- **Motivo**: Máxima precisión para debugging

## Troubleshooting

### Error: "CUDA not available"
**Solución**: Desactivar cuantización TensorRT, usar FP16 o INT8 en su lugar.

### Error: "Modelo cuantizado no encontrado"
**Solución**: Ejecutar el script de cuantización primero para generar los modelos.

### Precisión insuficiente
**Solución**: 
1. Ajustar umbrales de confianza en `.env`
2. Usar FP16 en lugar de INT8
3. Volver al modelo original si la pérdida de precisión es inaceptable

### Inferencia más lenta después de cuantización
**Solución**: 
1. Verificar que el hardware soporta el tipo de cuantización
2. Usar el tipo de cuantización apropiado para el hardware
3. Considerar que la cuantización en CPU puede ser más lenta si no hay instrucciones AVX

## Integración con el Sistema

El sistema ANPR está configurado para usar automáticamente los modelos cuantizados cuando:

1. `ENABLE_MODEL_QUANTIZATION=true` en `.env`
2. Los archivos de modelos cuantizados existen en las rutas especificadas
3. El hardware soporta el tipo de cuantización seleccionado

Si alguna condición falla, el sistema hace fallback automáticamente al modelo original.

## Monitoreo de Rendimiento

Para monitorear el impacto de la cuantización en el rendimiento:

1. Revisar los logs del servicio ANPR para tiempos de inferencia
2. Comparar FPS antes y después de la cuantización
3. Verificar la precisión de reconocimiento de placas
4. Monitorear el uso de CPU/GPU

## Referencias

- [Ultralytics YOLO Documentation](https://docs.ultralytics.com/)
- [PyTorch Quantization](https://pytorch.org/docs/stable/quantization.html)
- [ONNX Runtime Quantization](https://onnxruntime.ai/docs/performance/quantization.html)
- [NVIDIA TensorRT](https://developer.nvidia.com/tensorrt)