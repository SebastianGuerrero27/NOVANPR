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

## Reglas para reemplazar este modelo

1. Al menos 200 imágenes de entrenamiento (el script lo exige salvo `--force`).
2. El script guarda un **candidato** (`license_plate_detector_candidato.pt`) y solo
   reemplaza producción con `--promote` si su mAP50-95 en validación es mayor.
3. Al promover, se respalda el modelo anterior en `archive/` y se actualiza esta ficha
   con el dataset, la partición y las métricas.
