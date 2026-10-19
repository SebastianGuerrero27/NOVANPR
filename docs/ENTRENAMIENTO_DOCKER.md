# Afinar el detector de placas dentro de Docker

El entrenamiento se ejecuta en un contenedor independiente del motor de video. Puede
usar los mismos pesos y guardar candidatos mientras el servicio sigue atendiendo;
ambos procesos comparten CPU y memoria, por lo que conviene programar las corridas
largas fuera del horario de uso. El nuevo modelo solo se activa tras evaluarlo y
reiniciar el motor.

Los comandos siguientes se ejecutan en PowerShell, desde la raiz del repositorio.
Requieren Docker Desktop iniciado con contenedores Linux. La imagen incluida instala
PyTorch **CPU**, Ultralytics y ONNX con las versiones fijadas por el motor; la primera
construccion necesita Internet. No incluye entrenamiento RF-DETR ni CUDA.

## 1. Preparar las imagenes entregadas

`dataset/openimages_plates_ecuatorianas` ya tiene etiquetas de pose. Su `data.yaml`
original apunta a otra carpeta del equipo; no debe pasarse directamente al detector.
La conversion conserva las fuentes, extrae las cajas YOLO de las etiquetas y prepara
un dataset de deteccion separado:

```powershell
.\services\anpr\.venv\Scripts\python services/anpr/scripts/prepare_plate_dataset.py --source dataset/openimages_plates_ecuatorianas --output dataset/detector_ecuatorianas
```

Tambien puede preparar los datos dentro del contenedor una vez construida la imagen:

```powershell
docker compose -f docker-compose.train.yml run --rm --entrypoint python train scripts/prepare_plate_dataset.py --source /workspace/dataset/openimages_plates_ecuatorianas --output /workspace/dataset/detector_ecuatorianas
```

Revise el informe y los previews producidos por la preparacion antes de entrenar.
Este conjunto contiene 8000 recortes sinteticos de placas (7200 de entrenamiento y
800 de validacion): no acredita por si
solo deteccion a 1, 5 u 8 metros, de noche o sobre escenas completas de camaras. Para
medir ese comportamiento necesita fotos reales completas, etiquetas revisadas y
prueba separada por vehiculo y captura. La particion del conjunto entregado no debe
presentarse como una evaluacion independiente de vehiculos reales.

## 2. Construir y validar

```powershell
docker compose -f docker-compose.train.yml config --quiet
docker compose -f docker-compose.train.yml build train
docker compose -f docker-compose.train.yml run --rm train --data /workspace/dataset/detector_ecuatorianas/data.yaml --validate-only
```

Si ya existe la imagen del motor en este equipo, puede reutilizarla sin descargar
dependencias: `$env:TRAIN_IMAGE = "anpr-anpr:latest"` y ejecutar los comandos `run`
con `--pull never` despues de `--rm`, sin agregar `--build`. La entrada del contenedor y los scripts se
configuran en Compose. Use `Remove-Item Env:TRAIN_IMAGE` para volver a la imagen de
entrenamiento antes de volver a ejecutar `build`: Compose etiqueta el resultado con
el nombre indicado por esa variable. `--validate-only` comprueba los datos; no entrena.

### Copia en un volumen Linux para acelerar las lecturas en Windows

En este equipo se preparo el volumen `anpr_ecuatorianas_20261018` con una copia del
dataset de deteccion. La copia mediante `docker cp` tardo **14,24 segundos**. Se
verificaron 7200 imagenes y etiquetas de entrenamiento, 800 de validacion y hashes
del YAML y `provenance.json` coincidentes con los originales. El manifiesto esta en
`dataset/runs/staging_ecuatorianas_2026-10-18.json`.

Las 100 primeras imagenes de entrenamiento (1,16 MB) se leyeron desde ese volumen en
0,014 segundos, incluyendo sus hashes y sin cargar Torch. Es una muestra pequena
con cache probablemente caliente tras la copia, no una medicion del tiempo total
por epoca. Evita las numerosas aperturas de archivos a traves del montaje Windows.

Para usar la copia existente, agregue el montaje al comando de entrenamiento:

```powershell
docker compose -f docker-compose.train.yml run --rm --pull never -v anpr_ecuatorianas_20261018:/workspace/dataset/detector_ecuatorianas train
```

Puede agregar las opciones de entrenamiento despues de `train` como en los ejemplos
siguientes. El montaje adicional cubre solo el dataset preparado: los originales
siguen en Windows y `dataset/runs` y `services/anpr/models` conservan su persistencia
en el equipo. El volumen conserva sus propias caches de etiquetas entre corridas.

Si cambia las imagenes, etiquetas, particiones o procedencia, prepare una **nueva
version del volumen** y vuelva a copiar antes de entrenar. No mezcle una fuente
nueva sobre el volumen existente, porque podrian quedar archivos antiguos. Ejemplo
para una nueva version, usando la imagen local sin descargas:

```powershell
docker create --name anpr-stage-ecuatorianas-v2 --mount type=volume,source=anpr_ecuatorianas_v2,target=/cache --entrypoint /bin/true anpr-train:local
docker cp ./dataset/detector_ecuatorianas/. anpr-stage-ecuatorianas-v2:/cache/
docker rm anpr-stage-ecuatorianas-v2
```

Use entonces `-v anpr_ecuatorianas_v2:/workspace/dataset/detector_ecuatorianas` en
la siguiente corrida. Se retira solo el contenedor auxiliar; la copia del volumen
permanece. No cambie los montajes ni detenga una corrida activa para crear esta copia.

## 3. Entrenar y conservar resultados

```powershell
docker compose -f docker-compose.train.yml run --rm train
```

La configuracion predeterminada afina `models/license_plate_detector.pt` durante
30 epocas, con imagenes de 512 px, batch 8 y CPU. No descarga pesos COCO ni reemplaza
el detector activo. Por ejemplo, para cambiar la duracion y el batch:

```powershell
docker compose -f docker-compose.train.yml run --rm train --data /workspace/dataset/detector_ecuatorianas/data.yaml --weights /workspace/services/anpr/models/license_plate_detector.pt --epochs 80 --imgsz 512 --batch 4 --device cpu --workers 0 --nombre ecuatorianas --export-onnx
```

Al especificar argumentos despues de `train` se reemplaza toda la lista
predeterminada; incluya `--data`, `--weights` y el resto de opciones que necesite.
`TRAIN_THREADS` controla los hilos OpenMP/MKL y la opcion `--threads` predeterminada
(4 por defecto); no habilita GPU. Al reemplazar los argumentos especifique tambien
`--threads 4` si desea mantener ese limite en PyTorch.

Las carpetas son persistentes aunque se elimine el contenedor:

| En el equipo | Dentro del contenedor | Contenido |
|---|---|---|
| `dataset/` | `/workspace/dataset/` | Fotos, etiquetas, previews y corridas en `runs/` |
| `services/anpr/models/` | `/workspace/services/anpr/models/` | Candidatos PT/ONNX y respaldos de promociones |
| `services/anpr/scripts/` | `/workspace/services/anpr/scripts/` | Scripts actuales, montados de solo lectura |
| `services/anpr/app/` | `/workspace/services/anpr/app/` | Modulos actuales, montados de solo lectura |

Para reanudar una corrida interrumpida, use su `last.pt` persistido:

```powershell
docker compose -f docker-compose.train.yml run --rm train --data /workspace/dataset/detector_ecuatorianas/data.yaml --resume /workspace/dataset/runs/<corrida>/weights/last.pt --device cpu --workers 0 --threads 4 --export-onnx
```

Sustituya `<corrida>` por el nombre real de la carpeta creada, que incluye una marca
de tiempo. No copie los signos `<` y `>` en el comando ejecutado.

Para afinar con un conjunto nuevo, prepare otro `data.yaml` y use `--weights` con
el candidato anterior. `--resume` continua la misma corrida; `--weights` inicia un
nuevo afinamiento.

## 4. Evaluar y activar el candidato

`--export-onnx` exporta el candidato y comprueba que ONNX Runtime pueda ejecutarlo.
El archivo ONNX no se selecciona automaticamente en el microservicio. La exportacion
tampoco garantiza inferencia inferior a 10 ms: mida la latencia con su equipo,
resolucion y flujo de video.

El exportador registra `anpr_architecture` a partir de la estructura real del PT y
`anpr_source_pt_sha256` para identificar su origen, conservando la metadata existente.
El motor reconoce esa familia en ONNX solo si contiene uno de los valores admitidos
(`yolo26`, `yolo11`, `yolov8`). Un ONNX antiguo sin esa metadata conserva arquitectura
desconocida; el nombre del archivo no se usa para deducirla.

Si el entrenamiento ya estaba en marcha cuando se actualizo el exportador, su
proceso conserva la funcion antigua en memoria. Al finalizar, vuelva a exportar el
PT candidato con la funcion actual, sustituyendo la ruta y resolucion por las de su
corrida:

```powershell
docker compose -f docker-compose.train.yml run --rm --pull never --entrypoint python train -c "from pathlib import Path; from scripts.train_plate_detector import export_onnx; export_onnx(Path('/workspace/services/anpr/models/<candidato>.pt'), 512)"
```

La opcion `--promote` compara el candidato con el detector actual en validacion y
respalda el anterior antes de sustituir el PT canonico cuando mejora. **La promocion
esta bloqueada para este dataset sintetico** mediante su procedencia registrada:
su validacion no demuestra mejora sobre escenas reales. Para promocionar otro
afinamiento se requiere un conjunto real independiente, etiquetas revisadas y
metricas finitas favorables. Agregue `--promote` al comando de esa corrida solo
cuando esos requisitos se cumplan.

El override incluido para YOLO26 monta los modelos en el motor con solo lectura y fija
`PLATE_MODEL_PATH=/app/models/license_plate_detector.pt`, evitando que un `.env`
anterior siga seleccionando otro candidato. Tras una promocion aceptada de un
afinamiento con datos reales:

```powershell
# Desarrollo (el resto del sistema debe estar iniciado).
docker compose -f docker-compose.yml -f docker-compose.models.yml up -d --no-deps --force-recreate anpr

# Alternativa: despliegue de produccion.
docker compose -f docker-compose.prod.yml -f docker-compose.models.yml up -d --no-deps --force-recreate anpr
```

Use el comando del despliegue que utiliza; no ejecute ambos. El reinicio interrumpe
brevemente la deteccion. Compruebe `/status` y el detector informado antes de retomar
las pruebas de video. Incluya el mismo override en futuros comandos de despliegue.
Sin el montaje, produccion conserva los modelos empaquetados y requiere reconstruir
su imagen para incorporar pesos nuevos.

El motor trabaja con `.pt` por defecto. ONNX u OpenVINO requieren seleccionar
explicitamente su ruta mediante `PLATE_MODEL_PATH`, disponer de la exportacion y
validar compatibilidad y rendimiento; este flujo no cambia el backend activo.
