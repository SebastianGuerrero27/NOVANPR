# Experimento de modelos: detector y OCR de placas ecuatorianas

Procedimiento reproducible para el capítulo de resultados de la tesis. Todos los comandos
se ejecutan desde `services/anpr`.

## Entornos

| Entorno | Uso | Paquetes clave |
|---|---|---|
| `.venv` | Servicio en ejecución y etiquetado | ultralytics 8.4 (YOLO26), fast-plate-ocr, rapidocr 3.9 + OpenVINO (PP-OCRv6) |
| `.venv-train` | Entrenamiento y evaluación | PyTorch CPU, ultralytics, rfdetr, fast-plate-ocr[train] + Keras 3 |

## 1. Datos

1. **Fotos reales.** Coloque fotos completas (no recortadas) en `dataset/raw/<grupo>/`.
   Un grupo es una sesión de captura (fecha o lugar). Varíe la distancia (1–10 m), el ángulo,
   la iluminación (día, noche, contraluz) y, sobre todo, **la cantidad de vehículos distintos**.
   Objetivo mínimo: 300 vehículos distintos y 2 000 fotos.
2. **Etiquetado anclado en texto** (detector y OCR a la vez, sin usar el detector que se va a entrenar):
   ```
   .venv/Scripts/python scripts/annotate_plates.py --src ../../dataset/raw --out ../../dataset \
       --test-groups <grupos de prueba> --val-groups <grupos de validación>
   ```
   Revise `dataset/preview_annotate/` y corrija en `dataset/revision_anotaciones.csv` los casos
   `revisar` y `sin_placa_detectada`. La partición es **por grupo**, nunca por foto, para evitar
   fotos casi idénticas del mismo vehículo en entrenamiento y prueba (Laroca et al., 2023).
3. **Placas sintéticas** para adaptar el OCR al formato ANT (cabecera "ECUADOR", 3 letras + 3/4 dígitos):
   ```
   .venv/Scripts/python scripts/generate_synthetic_plates.py --n 20000
   ```
   Los datos sintéticos solo se usan para entrenar; **la evaluación se hace únicamente con placas reales**.

## 2. Detector: YOLO26n frente a RF-DETR-nano

### 2.1 Etapa A (hecha): preentrenamiento en un dataset público

Open Images V7, clase *Vehicle registration plate*, particiones oficiales (5 362 / 719 / 2 048
imágenes). El YOLO26n resultante es el detector de producción desde el 2026-10-01.

```
python scripts/prepare_openimages_plates.py --max-train 0
python scripts/train_plate_detector.py --arch yolo26n --data ../../dataset/openimages_plates/data.yaml \
    --nombre openimages --epochs 25 --imgsz 512 --batch 16
python scripts/evaluate_detectors.py --data-dir ../../dataset/openimages_plates --split test --imgsz 512 \
    --models yolov8n=models/baseline_yolov8n_koushim.pt yolo26n=models/license_plate_detector.pt
```

| Prueba (2 048 imágenes, 2 816 placas) | P | R | F1 | AP50 | mAP50-95 | ms OpenVINO |
|---|---|---|---|---|---|---|
| YOLOv8n Koushim (línea base) | 90.5 % | 46.2 % | 0.611 | 0.600 | 0.380 | 25.3 |
| YOLO26n Open Images | 93.8 % | 81.5 % | 0.873 | 0.862 | 0.546 | 24.0 |

McNemar por placa p ≈ 1.7 × 10⁻²¹³; diferencia de F1 +0.261 (IC 95 % 0.245–0.277). Detalle y
limitaciones en `models/MODEL_CARD.md` y `docs/resultados/detector_yolo26n_vs_yolov8n_openimages.json`.

**Pendiente para una comparación de arquitecturas en igualdad de condiciones:** entrenar YOLOv8n,
YOLO11n (y opcionalmente YOLO26s y RF-DETR-nano) con el mismo dataset y configuración, 3 semillas cada
uno.

### 2.2 Etapa B: afinamiento con placas ecuatorianas

Partir de `models/license_plate_detector.pt` (YOLO26n Open Images) en lugar de `yolo26n.pt` COCO, y
comparar ambas inicializaciones (ablación "COCO → Ecuador" frente a "COCO → Open Images → Ecuador").

```
.venv-train/Scripts/python scripts/train_plate_detector.py --arch yolo26n --epochs 80
.venv-train/Scripts/python scripts/train_plate_detector.py --arch rfdetr-nano --epochs 30
.venv-train/Scripts/python scripts/evaluate_detectors.py --models \
    actual=models/license_plate_detector.pt \
    yolo26n=models/yolo26n_ecuador_candidato.pt \
    rfdetr=models/rfdetr_nano_ecuador_candidato.pth
```

Métricas sobre el conjunto de prueba: precisión, recall, F1, AP50, IoU medio, **detector + OCR
exacto** (la que importa para el control de acceso) y latencia en CPU. Resultado en
`dataset/resultados_detectores.json`.

Para usar RF-DETR en el servicio: `DETECTOR_BACKEND=rfdetr` y `PLATE_MODEL_PATH=<ruta .pth>`
(requiere `pip install rfdetr` en el entorno del servicio). Para YOLO26 basta con promover el
candidato (`--promote`), que solo reemplaza producción si mejora el mAP50-95 en validación.

## 3. OCR: afinamiento de cct-s-v2 (contribución principal)

```
.venv-train/Scripts/python scripts/train_ocr.py --epochs 30
```

Parte de los pesos globales `cct_s_v2_global.keras` (release oficial de fast-plate-ocr), entrena
con sintético + real (reales sobremuestreadas) y exporta el candidato `models/ocr/cct_s_v2_ecuador_candidato.onnx`; con `--promote` pasa a
`models/ocr/cct_s_v2_ecuador.onnx` solo si supera al global en la prueba real.
El servicio carga `cct_s_v2_ecuador.onnx` si existe; si no, usa el modelo global.

Comparación en placas reales: `scripts/benchmark_ocr.py --labels <csv>` (exactitud, CER, latencia).

## 4. Verificador PP-OCRv6 (segunda lectura)

En la fase asíncrona (`main._verify_and_commit`) se lee la mejor foto del vehículo con
PP-OCRv6 (RapidOCR + OpenVINO). Su lectura se suma al consenso temporal con peso
`OCR_VERIFIER_VOTE_WEIGHT` y se descarta si supera `OCR_VERIFIER_MAX_MS` (2000 ms).
Variables: `OCR_VERIFIER_ENABLED`, `OCR_VERIFIER_MODEL` (tiny/small/medium), `OCR_VERIFIER_ENGINE`.

## 5. Evaluación con datos de operación (ECU 911)

El sistema guarda por cada paso vehicular la **lectura original del OCR**, la **decisión
automática** (antes de cualquier corrección del operador) y metadatos de la captura: luminancia,
distancia estimada, ancho de la placa en píxeles, nitidez, velocidad, latencia de principio a fin,
lectura del verificador y versión de los modelos (`db/migration_evaluacion.sql`).

**Protocolo:** durante el periodo de evaluación el operador valida **todos** los registros
(también los correctos, confirmando la misma placa). Si valida solo los dudosos, las métricas
quedan sesgadas; `cobertura_validacion` debe ser ≥ 95 %. El clima se anota en `condicion_clima`.

```
GET /api/evaluacion/resumen?desde=2026-10-01&hasta=2026-10-31   (JSON, requiere sesión)
GET /api/evaluacion/export.csv?desde=...&hasta=...               (una fila por paso vehicular)
```

Métricas: exactitud por placa, CER, tasa de no legibles, **falsa aceptación** (se autorizó un
vehículo no autorizado), **falso rechazo**, **lista negra no detectada**, falsas alertas y
latencia p50/p95, en total y por luz, distancia, tipo de placa, formato y clima.

## 6. Estadística

```
.venv/Scripts/python scripts/estadistica.py operacion --csv evaluacion_anpr.csv --out resultados.json
.venv/Scripts/python scripts/estadistica.py comparar --a preds_A.csv --b preds_B.csv
.venv/Scripts/python scripts/estadistica.py semillas --valores 0.91 0.93 0.92
```

- IC 95 % por bootstrap (10 000 remuestreos, semilla fija).
- Comparación de dos sistemas sobre las mismas muestras con **McNemar exacto**; la diferencia
  solo se reporta como mejora si p < 0.05. Con menos de 10 casos discordantes la prueba avisa
  que falta potencia.
- Entrenamientos repetidos con `--seed 1 2 3` y reportados como media ± DE con IC t de Student.
- `benchmark_ocr.py`, `evaluate_detectors.py` y `run_ablations.py` aceptan `--save-preds`.

## 7. Ablaciones

```
.venv/Scripts/python scripts/run_ablations.py --save-preds ../../dataset/preds
.venv/Scripts/python scripts/run_ablations.py --plan-entrenamiento
```

Sin reentrenar (unidad = evento vehicular, comparadas contra el sistema completo con McNemar):
sin verificador, sin consenso entre frames, con preprocesado, sin reglas ANT y solo verificador.
Con reentrenamiento: sin datos sintéticos (`train_ocr.py --synth-max 0`), etiquetado circular
frente a anclado en texto (`annotate_plates.py --circular-model`) y arquitectura del detector.

## 8. Rectificación aprendida (YOLO26n-pose, 4 esquinas)

```
.venv/Scripts/python scripts/generate_synthetic_plates.py --n 8000 --pose-out ../../dataset/pose
.venv/Scripts/python scripts/train_plate_rectifier.py --epochs 12 --fraction 0.5
.venv/Scripts/python scripts/run_ablations.py --rectifier models/plate_rectifier_candidato.pt
```

El generador sintético conoce la perspectiva exacta de cada placa, así que las 4 esquinas
(sup-izq, sup-der, inf-der, inf-izq) son etiquetas perfectas sin anotación manual. En el
servicio (`app/infraestructura/plate_rectifier.py`) el modelo recibe el recorte del detector, predice
las esquinas y una homografía deja la placa frontal con la proporción ANT (404 × 154 mm).
Si las esquinas no son confiables (`PLATE_RECTIFIER_MIN_KPT_CONF`) se usa la heurística por
contornos. Se activa copiando el candidato a `models/plate_rectifier.pt` (o `PLATE_RECTIFIER_PATH`)
solo si la ablación `con_rectificador` mejora frente a `completo`.

## 9. Atributos del vehículo como segundo factor

`app/infraestructura/vehicle_attributes.py`: YOLO26n (COCO) ubica el vehículo que contiene la placa y
CLIP ViT-B/32 (zero-shot) estima tipo, color, marca y modelo contra el catálogo editable
`app/data/catalogo_vehiculos_ecuador.json`. Por debajo de `VEHICLE_ATTR_MIN_CONF` el atributo
queda como desconocido. En la lista negra y en autorizados se pueden registrar marca, modelo y
color; el backend (`dominio/vehiculoAtributos.ts`) compara **marca y color** (no el modelo, cuyo
reconocimiento zero-shot es poco fiable):

- Lista negra + vehículo que no coincide → se mantiene la alerta con la marca
  "posible placa clonada o error de lectura".
- Autorizado + vehículo que no coincide → pasa a revisión del operador en lugar de autorizarse
  (desactivable con `VERIFICAR_VEHICULO_AUTORIZADOS=false`).

Prueba en una imagen real de Ambato (Haval H6 plateada): tipo SUV (0.91), color plateado,
marca Haval (0.93) correctos; modelo "Jolion" (0.87) incorrecto. Para el artículo, medir la
exactitud de marca y color con un conjunto etiquetado de vehículos ecuatorianos.

## 10. Datos del propietario (solo mediante convenio)

No existe una API pública que se pueda usar legalmente para obtener el propietario a partir
de la placa: los portales del SRI y la ANT están hechos para consultas individuales (con
CAPTCHA) y su extracción automatizada no está permitida; además son datos personales (LOPDP).
El canal legítimo es un convenio del ECU 911 con DINARDAP / ANT. El sistema deja listo el punto
de integración (`infraestructura/servicios/consultaPropietario.ts`, `POST /api/propietario/consulta`): solo
Admin, motivo obligatorio, límite por hora y auditoría de cada consulta
(`AuditoriaConsultaPropietario`). Está deshabilitado hasta implementar el adaptador oficial.

## Resultados

Ver `services/anpr/models/MODEL_CARD.md` (se actualiza con cada modelo promovido).
