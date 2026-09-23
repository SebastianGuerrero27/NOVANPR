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

## Resultados

Ver `services/anpr/models/MODEL_CARD.md` (se actualiza con cada modelo promovido).
