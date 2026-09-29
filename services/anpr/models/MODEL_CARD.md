# Ficha del modelo: `license_plate_detector.pt`

## Modelo en producción (restaurado el 2026-09-22)

| Campo | Valor |
|---|---|
| Origen | Hugging Face `Koushim/yolov8-license-plate-detection` (snapshot `9aaa5cd490abe0c165882ba87f4f62658ab54d01`, archivo `best.pt`) |
| Arquitectura base | YOLOv8n (Ultralytics 8.3.144), 1 clase: `license_plate` |
| Entrenamiento del autor | 50 épocas, imgsz 640, batch 16, fecha 2025-05-25 |
| Métricas del autor (su conjunto de validación, no placas ecuatorianas) | Precisión 0.950 · Recall 0.900 · mAP50 0.936 · mAP50-95 0.745 |
| SHA-256 | `2d95861825bb4184404344c9cf809f40fd31dba785fe54e8ba5b9a3583789822` |

Estas métricas **no** representan el desempeño en el ECU 911. Deben medirse sobre un
conjunto de prueba propio, dividido por vehículo, con etiquetas revisadas manualmente.

## Versión retirada

`archive/license_plate_detector_ft_1epoca_2imgs_20260908.pt`
(SHA-256 `a65fff25a303b500f8667cfcef12841cd8ef8c617de9e10f6f21ccab164aa955`)

El 2026-09-08 `scripts/train_plate_detector.py` ajustó el modelo anterior con **1 época,
batch 2, sobre 2 imágenes** y sobrescribió los pesos de producción. La diferencia media de
pesos respecto al original es ~0.0024 y en 37 capturas reales ambos detectan placa en el
mismo número de imágenes (28/37). No se perdió precisión, pero el modelo no tenía una
procedencia reproducible. Se retiró por ese motivo.

## Piloto de afinamiento con placas ecuatorianas (2026-09-22)

**Advertencia:** piloto para validar el procedimiento, NO resultado de tesis. Dataset: 101 fotos
de interiores con solo 2 placas reales (PSY-589 y TDH-398), etiquetadas con
`scripts/annotate_plates.py` (anclaje en texto PP-OCRv6) y partidas por día de captura:
train = 80 (08, 09, 10 y 15 sep), val = 11 (14 sep), test = 10 (16, 17 y 21 sep).

### Detector (`scripts/evaluate_detectors.py`, split test, conf 0.35)

| Modelo | Precisión | Recall | F1 | AP50 | IoU medio | Detector+OCR |
|---|---|---|---|---|---|---|
| Koushim YOLOv8n (producción) | 42.9 % | 33.3 % | 0.375 | 0.393 | 0.76 | 44.4 % |
| YOLO26n afinado (`yolo26n_ecuador_candidato.pt`, 27 épocas, parada temprana) | 88.9 % | 88.9 % | 0.889 | 0.978 | 0.87 | 77.8 % |
| RF-DETR-nano afinado (`rfdetr_nano_ecuador_candidato.pth`, 15 de 30 épocas, mejor EMA) | 90.0 % | 100.0 % | 0.947 | 0.956 | 0.88 | 77.8 % |

Latencia por imagen en CPU (i9-13900H, 640 px, CPU libre):

| Modelo | PyTorch | OpenVINO |
|---|---|---|
| Koushim YOLOv8n | 80 ms | 72 ms |
| YOLO26n afinado | 88 ms | **55 ms** |
| RF-DETR-nano afinado | 308 ms | — |

Lectura: RF-DETR-nano obtiene el mejor recall/F1 pero es ~5,6 veces más lento que YOLO26n
con OpenVINO; con 9 placas de prueba la diferencia de F1 (0.947 vs 0.889) es de una sola
detección y no es concluyente. Ningún candidato se promovió a producción: 9 placas de prueba
de una sola persona y habitación no bastan. Repetir con el dataset de la Fase 1.

### OCR (`models/ocr/cct_s_v2_ecuador_candidato.onnx`, `scripts/train_ocr.py`)

Afinado desde `cct_s_v2_global.keras` con 6 000 placas sintéticas + 78 recortes reales (x20),
8 épocas, lr 3e-4, backend TensorFlow en CPU. Validación (10 reales + 1 000 sintéticas):
93.7 % placa completa, 98.6 % por carácter.

| Conjunto | cct-s-v2 global | cct-s-v2 afinado |
|---|---|---|
| 77 recortes etiquetados a mano (incluye días de entrenamiento) | 89.6 % | 96.1 % |
| Solo días nunca vistos (9 recortes) | 77.8 % | 77.8 % |

La mejora global se debe sobre todo a que PSY-589 estaba en entrenamiento; en días no vistos
no hay diferencia y ambos fallan TDH-398. Por eso queda como candidato y NO se promovió:
el servicio sigue usando el cct-s-v2 global.

### Verificador PP-OCRv6 (RapidOCR 3.9 + OpenVINO 2026.4, 77 recortes etiquetados a mano)

| Variante | Exactitud | Media | p95 | Máximo |
|---|---|---|---|---|
| tiny | 87.0 % | 19 ms | 50 ms | 65 ms |
| small | 94.8 % | 34 ms | 80 ms | 103 ms |
| **medium (por defecto)** | **96.1 %** | **85 ms** | **194 ms** | **253 ms** |

Referencia: PP-OCRv6 medium en PaddleOCR nativo (sin OpenVINO) 98.7 % y ~3 000 ms.
Requisito < 2 s cumplido con amplio margen. Claves para lograrlo: parámetros de detección de
PaddleOCR (lado mínimo 64 px, no 736) y unir fragmentos de la misma fila sin mezclar la cabecera.

### Rectificador de esquinas (`plate_rectifier_candidato.pt`, YOLO26n-pose)

Entrenado 12 épocas (256 px, 50 % del dataset por época, 1.1 h en CPU) con 8 000 recortes
sintéticos con esquinas exactas. Validación sintética: pose mAP50-95 **0.897**.

| Prueba con placas REALES | Resultado |
|---|---|
| Recortes guardados sin margen (`media/placa_*`) | esquinas confiables en 20/108 |
| Recortes con el margen del agente (18 % / 12 %) | esquinas confiables en 41/97; varias cortan caracteres |
| Ablación `con_rectificador` (21 eventos) | 95.2 % = sistema completo (sin diferencia) |

**No se activó en producción** (`models/plate_rectifier.pt` no existe; el agente usa la
heurística). Brecha sintético→real: el modelo no vio manos/dedos sobre el borde ni placas
reales. Siguiente paso: anotar esquinas reales (~200) para afinar y agregar oclusiones al
generador; activar solo si la ablación mejora de forma significativa.

### Atributos del vehículo (YOLO26n COCO + CLIP ViT-B/32 laion2b, zero-shot)

Imagen real (Ambato, Haval H6 plateada): tipo SUV 0.91 ✔, color plateado ✔, marca Haval
0.93 ✔, modelo "Jolion" 0.87 ✘. Latencia 0.5–1.3 s en CPU (una vez por vehículo, fase
asíncrona). Por eso el segundo factor compara solo marca y color. Falta medir su exactitud
con un conjunto etiquetado de vehículos ecuatorianos.

## Reglas para reemplazar este modelo

1. Al menos 200 imágenes de entrenamiento (el script lo exige salvo `--force`).
2. El script guarda un **candidato** (`<arquitectura>_ecuador_candidato.pt`) y solo
   reemplaza producción con `--promote` si su mAP50-95 en validación es mayor.
3. Al promover, se respalda el modelo anterior en `archive/` y se actualiza esta ficha
   con el dataset, la partición y las métricas.
