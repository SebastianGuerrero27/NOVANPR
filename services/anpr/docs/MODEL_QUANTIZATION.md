# Guía de optimización de los modelos YOLO mediante cuantización

## Resumen

El detector de placas en producción es `models/license_plate_detector.pt` (YOLO26n afinado en Open
Images V7, una clase `license_plate`; ficha en [`models/MODEL_CARD.md`](../models/MODEL_CARD.md)). El
detector de vehículos para los atributos es `yolo26n.pt` (`VEHICLE_DETECTOR_PATH`). Ambos corren en
CPU; la forma de desplegarlos en CPU es OpenVINO, que ya está medida. La cuantización FP16, INT8 o
TensorRT es una **opción no adoptada**: el script existe, pero no se ha medido su efecto en la
exactitud ni en la latencia de este sistema.

## Lo que está medido (ficha del modelo)

Conjunto de prueba de Open Images (2 048 imágenes, 2 816 placas), imgsz 512, IoU ≥ 0,5, Xeon de 4 vCPU
en contenedor, 300 imágenes para la latencia (`docs/resultados/detector_yolo26n_vs_yolov8n_openimages.json`):

| Modelo | F1 (IC 95 %) | ms CPU PyTorch (p95) | ms CPU OpenVINO (p95) |
|---|---|---|---|
| YOLOv8n Koushim (anterior producción) | 0,611 (0,593–0,630) | 30,2 (43,2) | 25,3 (32,3) |
| **YOLO26n Open Images (producción)** | **0,873 (0,860–0,884)** | 38,6 (54,3) | **24,0 (31,9)** |

En el portátil de desarrollo, con el motor completo, el detector tarda una mediana de ≈ 99 ms aislado
y más cuando el OCR profundo, el verificador y CLIP compiten por la CPU
([`docs/AUDITORIA_MOTOR_ANPR.md`](../../../docs/AUDITORIA_MOTOR_ANPR.md) §3–4).

## Tipos de cuantización disponibles en el script

| Tipo | Qué hace | Hardware |
|---|---|---|
| FP16 | Pesos en media precisión | GPU con FP16 o CPU que lo soporte |
| INT8 | Pesos y activaciones en 8 bits (requiere calibración) | CPU con AVX/AVX2 o GPU |
| TensorRT | Motor optimizado para NVIDIA | GPU NVIDIA con TensorRT |

Lo habitual es que FP16 e INT8 reduzcan el tamaño y el tiempo a costa de algo de exactitud, pero la
magnitud depende del modelo y del equipo: en este sistema hay que medirla antes de usarla.

## Instrucciones

### 1. Dependencias adicionales

```bash
cd services/anpr
pip install onnx onnxruntime        # versiones compatibles con requirements.txt
pip install tensorrt                # opcional, solo con GPU NVIDIA
```

### 2. Generar el modelo cuantizado

```bash
# Detector de placas de producción
python scripts/quantize_yolo.py --model models/license_plate_detector.pt --type fp16 --benchmark
python scripts/quantize_yolo.py --model models/license_plate_detector.pt --type int8 --benchmark
python scripts/quantize_yolo.py --model models/license_plate_detector.pt --type all --output ./models
```

`--benchmark` mide el tiempo de inferencia (`--iterations`, 100 por omisión); no mide la exactitud.

### 3. Evaluar antes de adoptar

Compare la exactitud con `scripts/evaluate_detectors.py` sobre el mismo conjunto de prueba
([`docs/EXPERIMENTO_MODELOS.md`](../../../docs/EXPERIMENTO_MODELOS.md)) y la latencia con el motor
completo (`scripts/evaluar_secuencias.py`). La cuantización solo se adopta si no degrada la detección
de placas (prueba de McNemar por placa, como en la ficha del modelo) y si mejora el tiempo por cuadro
en el equipo de la garita.

### 4. Usar el modelo cuantizado

El servicio usa exactamente los archivos indicados en el entorno; no hay carga automática ni respaldo
(si el archivo no existe, el servicio no arranca y lo informa en el registro):

```bash
PLATE_MODEL_PATH=models/license_plate_detector_fp16.pt
VEHICLE_DETECTOR_PATH=models/yolo26n_fp16.pt
```

`/status` informa la arquitectura cargada; el arranque verifica que el detector de placas tenga la
clase `license_plate`.

## Recomendaciones por escenario

- **CPU sin GPU (situación actual):** OpenVINO en FP32 (medido). INT8 solo tras evaluarlo.
- **GPU NVIDIA:** probar TensorRT o FP16 y evaluarlos; la ficha del modelo no tiene mediciones en GPU.
- **Desarrollo:** modelo original FP32.

## Problemas frecuentes

| Problema | Solución |
|---|---|
| «CUDA not available» | No use TensorRT; pruebe FP16 o INT8 en CPU |
| Modelo cuantizado no encontrado | Genere primero el archivo (paso 2) y revise la ruta en `.env` |
| Menos placas detectadas | Vuelva al modelo FP32 o pruebe FP16 en lugar de INT8 |
| Inferencia más lenta | Verifique que la CPU tenga las instrucciones que exige el tipo elegido |

## Referencias

- [Ultralytics YOLO: exportación e integración con OpenVINO](https://docs.ultralytics.com/)
- [PyTorch Quantization](https://pytorch.org/docs/stable/quantization.html)
- [ONNX Runtime Quantization](https://onnxruntime.ai/docs/performance/quantization.html)
- [NVIDIA TensorRT](https://developer.nvidia.com/tensorrt)
