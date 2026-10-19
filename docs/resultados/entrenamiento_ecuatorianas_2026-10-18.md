# Afinamiento con el conjunto ecuatoriano entregado

Estado: entrenamiento en curso. Fecha local: 18 de octubre de 2026 (Ecuador).

## Datos comprobados

El origen `dataset/openimages_plates_ecuatorianas` contiene 8.000 recortes
sintéticos de placas ecuatorianas. No son fotografías reales de vehículos de
Open Images. Sus etiquetas originales tienen 17 columnas: caja y cuatro
esquinas. El YAML original apunta a `dataset/pose`.

Se conservaron los originales y se creó `dataset/detector_ecuatorianas` con
etiquetas YOLO de detección (cinco columnas), rutas portables, manifiesto de
procedencia y vistas previas. Se preservaron 7.200 imágenes de entrenamiento y
800 de validación, sin inventar un conjunto de prueba. Todas tienen una caja
clase 0; no se encontraron pares incompletos, coordenadas inválidas ni duplicados
exactos entre particiones. Este control no detecta imágenes casi idénticas ni
demuestra independencia por vehículo.

La caja ocupa una mediana del 66,2 % de la imagen. Estos recortes no permiten
demostrar detección en vehículos completos, placas pequeñas o distancias de
1–10 metros. La validación sintética no es una medición de la precisión del
motor ANPR completo.

## Ejecución

- Punto de partida: `services/anpr/models/license_plate_detector.pt`, YOLO26n
  afinado previamente en Open Images; no se parte de pesos COCO genéricos.
- SHA-256 de producción antes de entrenar:
  `3667d8168e8a5a62fddf0992546efa0dc60f37578c9e95e8c0cbc92d4ed74c5c`.
- Docker: imagen `anpr-train:local`, Python 3.12.15, Torch 2.14.1+cpu,
  Ultralytics 8.4.174. Hardware: Intel Core i9-13900H; no hay GPU NVIDIA
  disponible para Docker.
- Configuración: máximo 10 épocas, 256 px, batch 16, CPU, cuatro hilos, semilla
  0, primeras diez capas congeladas, AdamW con tasa inicial 0,0001, variación
  multiescala 0,25 y aumentaciones geométricas y de iluminación sin volteos.
- Corrida: `dataset/runs/yolo26n_ecuatorianas_inicial_s0_20261018_225206`.
- Contenedor: `anpr-train-ecuatorianas-volumen`.
- Los datos se leen del volumen `anpr_ecuatorianas_20261018`; resultados y
  modelos se escriben en las carpetas persistentes de Windows.

El primer arranque encontró permisos restrictivos en la carpeta temporal de
Windows. El preparador ahora hereda permisos normales. El acceso al dataset
desde el montaje de Windows también resultó lento: se copió a un volumen de
Docker en 14,237 segundos y se verificaron YAML/procedencia y conteos. La
ejecución anterior se detuvo antes de producir una época o un checkpoint.

Un microbenchmark de CPU respaldó mantener cuatro hilos: medianas de 1,132,
1,615 y 3,346 segundos por lote para 4, 8 y 12 hilos, respectivamente. Fue una
medición breve con datos sintéticos en memoria; no una comparación del motor
completo. La pausa de diagnóstico duró 36,718 segundos y se reanudó la corrida.

## Evaluación y despliegue

Al finalizar se comprobará la exportación ONNX dinámica mediante ONNX Runtime.
El benchmark de la red excluye captura, preprocesamiento y OCR: no garantiza
latencia del sistema inferior a 10 milisegundos.

Se compararán producción y candidato en las 2.048 imágenes reales y 2.816 placas
de la prueba de Open Images disponible. Es una evaluación internacional,
no una prueba exclusiva de Ecuador. Se usa una configuración de evaluación
separada con rutas Linux y `split=test`; el YAML original de ese conjunto no se
usa como datos de entrenamiento.

El candidato no sustituye automáticamente producción. Para medir mejora en el
caso de uso ecuatoriano siguen haciendo falta fotografías reales completas,
con etiquetas revisadas y separación por vehículo/secuencia/día.

## Verificación del flujo

22 pruebas y 24 subpruebas aprobadas para preparación, validación, exportación
y protección de promociones. La imagen Docker se construyó, `pip check` pasó
y se verificaron imports reales. Las configuraciones de Compose de
entrenamiento y de montaje de modelos en desarrollo/producción son válidas.

Instrucciones: `dataset/LEEME_INSTRUCCIONES.txt` y
`docs/ENTRENAMIENTO_DOCKER.md`.
