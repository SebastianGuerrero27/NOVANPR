# Ficha del modelo: `license_plate_detector.pt`

## Modelo en producción: YOLO26n afinado en Open Images V7 (2026-10-01)

| Campo | Valor |
|---|---|
| Arquitectura | **YOLO26n** (Ultralytics 8.4.171): bloques C3k2 + C2PSA, cabeza sin NMS ni DFL (`reg_max = 1`). 1 clase: `license_plate` |
| Punto de partida | `yolo26n.pt` oficial (COCO) |
| Datos | Open Images V7, clase *Vehicle registration plate* (`/m/01jfm_`), particiones oficiales: train 5 362 imágenes / 7 843 placas; val 719 / 978; test 2 048 / 2 816. Se excluyen las imágenes con cajas `IsGroupOf` o `IsDepiction`. Imágenes reducidas a 640 px (lado mayor). Generado con `scripts/prepare_openimages_plates.py` |
| Entrenamiento | 25 épocas, imgsz 512 (la del servicio), batch 16, optimizador automático (AdamW, lr 0.002), semilla 0, determinista. Aumentaciones: sin volteos (invierten los caracteres), rotación ±8°, escala 0.6, mosaico (se apaga en las 5 últimas épocas), brillo 0.5. CPU, ~14 min/época. Curva en `docs/resultados/yolo26n_openimages_entrenamiento.csv` |
| Comando | `python scripts/train_plate_detector.py --arch yolo26n --data ../../dataset/openimages_plates/data.yaml --nombre openimages --epochs 25 --imgsz 512 --batch 16` |
| Mejor época (val) | 25: P 0.928 · R 0.821 · mAP50 0.877 · mAP50-95 0.547 |
| SHA-256 | `3667d8168e8a5a62fddf0992546efa0dc60f37578c9e95e8c0cbc92d4ed74c5c` |
| Licencias | Anotaciones Open Images CC BY 4.0; imágenes CC BY 2.0 de sus autores; Ultralytics AGPL-3.0 |

El servicio verifica la arquitectura al arrancar (`PLATE_DETECTOR_ARCH=yolo26`, publicada en
`/status` como `detector_arquitectura`) y `tests/test_detector_arquitectura.py` falla si el archivo
deja de ser YOLO26.

### Evaluación en el conjunto de PRUEBA de Open Images (2 048 imágenes, 2 816 placas)

Ambos modelos con el mismo protocolo (`scripts/evaluate_detectors.py`, imgsz 512, IoU ≥ 0.5). Detalle
completo en `docs/resultados/detector_yolo26n_vs_yolov8n_openimages.json`.

| Modelo | P | R | F1 (IC 95 %) | AP50 | mAP50-95 (Ultralytics) | ms CPU PyTorch (p95) | ms CPU OpenVINO (p95) |
|---|---|---|---|---|---|---|---|
| YOLOv8n Koushim (línea base, anterior producción) | 90.5 % | 46.2 % | 0.611 (0.593–0.630) | 0.600 | 0.380 | 30.2 (43.2) | 25.3 (32.3) |
| **YOLO26n Open Images (producción)** | **93.8 %** | **81.5 %** | **0.873 (0.860–0.884)** | **0.862** | **0.546** | 38.6 (54.3) | **24.0 (31.9)** |

P/R/F1 con confianza ≥ 0.35. Latencias en un Xeon de 4 vCPU (contenedor), 300 imágenes.

- **Prueba de McNemar por placa** (detectada / no detectada): YOLO26n detecta 1 007 placas que
  YOLOv8n pierde; YOLOv8n detecta 11 que YOLO26n pierde (χ² = 972.5, p ≈ 1.7 × 10⁻²¹³).
- **Diferencia de F1 por bootstrap** (2 000 remuestreos por imagen): +0.261, IC 95 % [0.245, 0.277].
- **Umbral:** en validación, YOLO26n alcanza F1 0.861 con el umbral del servicio
  (`PLATE_CONFIDENCE_THRESHOLD=0.22`) y su máximo 0.872 con 0.37; se mantiene 0.22 porque ByteTrack
  necesita recall.
- **Latencia:** en PyTorch YOLO26n es ~8 ms más lento; con OpenVINO, que es como debe desplegarse en
  CPU, es igual o algo más rápido que YOLOv8n.

### Limitaciones (declararlas en la tesis y el artículo)

1. **Ventaja de dominio a favor de YOLO26n:** se entrenó con imágenes de Open Images y YOLOv8n no. La
   comparación muestra que el nuevo modelo es mejor *en Open Images*, no que la arquitectura YOLO26
   sea mejor que YOLOv8 en igualdad de condiciones. Para eso hay que entrenar YOLOv8n (y YOLO11n)
   con el mismo dataset, la misma configuración y varias semillas.
2. **No hay placas ecuatorianas en el entrenamiento.** En las 4 capturas etiquetadas del repositorio
   ambos detectan las 4 placas, pero YOLO26n con menor confianza (0.38–0.74 frente a 0.70–0.93) y
   cajas algo menos ajustadas (IoU 0.67–0.89 frente a 0.69–0.90). Todas superan el umbral del
   servicio, pero 4 imágenes no permiten concluir nada.
3. **Siguiente paso obligatorio:** afinar este modelo con el conjunto ecuatoriano (≥ 200 imágenes,
   partición por vehículo y día; reglas al final de esta ficha) y repetir la evaluación sobre la
   prueba ecuatoriana. Si en ese conjunto no supera a la línea base, volver a
   `baseline_yolov8n_koushim.pt`.

## Línea base: `baseline_yolov8n_koushim.pt` (producción hasta el 2026-10-01)

| Campo | Valor |
|---|---|
| Origen | Hugging Face `Koushim/yolov8-license-plate-detection` (snapshot `9aaa5cd490abe0c165882ba87f4f62658ab54d01`, archivo `best.pt`) |
| Arquitectura base | YOLOv8n (Ultralytics 8.3.144), 1 clase: `license_plate` |
| Entrenamiento del autor | 50 épocas, imgsz 640, batch 16, fecha 2025-05-25 |
| Métricas del autor (su conjunto de validación, no placas ecuatorianas) | Precisión 0.950 · Recall 0.900 · mAP50 0.936 · mAP50-95 0.745 |
| SHA-256 | `2d95861825bb4184404344c9cf809f40fd31dba785fe54e8ba5b9a3583789822` |

Se conserva versionado como línea base reproducible de los experimentos. Para volver a él:
`PLATE_MODEL_PATH=models/baseline_yolov8n_koushim.pt PLATE_DETECTOR_ARCH=yolov8`.

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
| Koushim YOLOv8n (entonces en producción) | 42.9 % | 33.3 % | 0.375 | 0.393 | 0.76 | 44.4 % |
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
