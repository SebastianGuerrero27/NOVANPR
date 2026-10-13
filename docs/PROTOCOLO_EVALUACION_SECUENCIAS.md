# Protocolo de evaluación con secuencias etiquetadas

Este protocolo mide el motor ANPR de punta a punta con video real de las cámaras, de forma
reproducible. Complementa la evaluación con la validación del operador
([METODO_VERIFICACION_LECTURA.md §4](METODO_VERIFICACION_LECTURA.md)) y las pruebas A/B de
componentes (§3). Ninguna cifra de este documento es un resultado. Los resultados se publican en
`docs/resultados/` con su tamaño de muestra.

## 1. Conjunto de datos

### 1.1 Qué grabar

Las secuencias se graban **sin recodificar**, con el flujo principal de cada cámara tal como lo
recibe el motor:

```bash
# Desde el equipo del sistema (MediaMTX publica el RTSP solo en 127.0.0.1; usuario anpr + ANPR_SERVICE_TOKEN)
ffmpeg -rtsp_transport tcp -i "rtsp://anpr:${ANPR_SERVICE_TOKEN}@127.0.0.1:8554/cam_<id>" -c copy -t 900 garita_<fecha>_<hora>.mkv
```

Cobertura mínima por cámara. Cada celda es un bloque de al menos 30 minutos o 100 pasos:

| Condición | Qué incluir |
|---|---|
| Día | Luz normal, sombras de mediodía, contraluz de mañana y tarde |
| Noche | Iluminación IR de la cámara y faros de frente |
| Lluvia o neblina | Gotas en la carcasa y calzada mojada con reflejos |
| Distancia y tamaño | Placas de distinto ancho en el punto de lectura (< 80 px, 80–130 px, > 130 px) |
| Ángulo y velocidad | Vehículos que entran en diagonal, frenan o no se detienen; motos |
| Oclusión | Placas tapadas en parte (ganchos, suciedad, otro vehículo) |
| Zonas | Con el área de detección y las exclusiones configuradas, y un bloque sin zonas |

### 1.2 Etiquetado

Cada secuencia tiene un JSON en `services/anpr/scripts/secuencias/`. El formato es el de
`escena_hikvision_simulada.json`:

- `pasos`: un elemento por vehículo que cruza.
  - `placa`: el texto oficial sin guion.
  - `legible`: si una persona puede leer la placa en algún cuadro.
  - `inicio_s` y `fin_s`: el intervalo en que la placa está completa en el cuadro.
- `condiciones`: etiquetas de la tabla anterior.
- `zonas`: las zonas que tenía la cámara.
- `particion`: `calibracion` o `prueba`.

Una placa que nadie puede leer (lejana, borrosa u ocluida) se etiqueta `legible: false`. Para esa
placa lo correcto es que el sistema registre una lectura incierta o no legible, no que acierte.

### 1.3 Particiones

- La unidad es la **secuencia completa**, nunca el cuadro. Los cuadros consecutivos de un mismo
  paso son casi idénticos, y repartirlos entre calibración y prueba inflaría los resultados.
- **Calibración** (≈ 40 %): sirve para ajustar los umbrales y elegir variantes:
  - `PLATE_CONFIDENCE_THRESHOLD`;
  - la compuerta de movimiento (`MOTION_GATE_*`);
  - el enfriamiento del OCR;
  - las zonas de cada cámara.
- **Prueba final** (≈ 60 %): se evalúa una sola vez, con la configuración congelada.
- Si hay datos de entrenamiento (para afinar el detector o el OCR), se toman de días distintos de
  los de prueba.
- Las secuencias de calibración y de prueba de una misma cámara se graban en días distintos.

## 2. Ejecución

```bash
# Dentro del contenedor del motor (allí están los modelos); los videos se copian a /tmp/secuencias
docker exec -w /app anpr-service python scripts/evaluar_secuencias.py scripts/secuencias/*.json \
    --videos /tmp/secuencias --salida /tmp/evaluacion.json
```

`scripts/evaluar_secuencias.py` ejecuta el motor de producción completo y reproduce cada video a
su velocidad real. Así, los cuadros que el motor no alcanza a analizar se descartan como con la
cámara en vivo. El backend se sustituye por un registrador: no se escribe en la base.

## 3. Métricas

| # | Métrica | Definición | Estadística |
|---|---|---|---|
| 1 | Recall de detección | Pasos con alguna pista de placa durante su intervalo / pasos | Wilson 95 % |
| 2 | Precisión de los registros | Registros asignados a un paso / registros | Wilson 95 % |
| 3 | Falsas detecciones por hora | Registros que no corresponden a ningún paso, por hora de video | Poisson exacto 95 % |
| 4 | Transcripción exacta | Pasos registrados cuyo primer registro coincide con la etiqueta / pasos registrados | Wilson 95 % |
| 5 | Reconocimiento exacto de punta a punta | Pasos legibles con un registro correcto / pasos legibles | Wilson 95 % |
| 6 | Pasos sin lectura correcta | 1 − (5) | Wilson 95 % |
| 7 | Duplicados por paso | Registros de más por cada paso registrado | Media |
| 8 | Latencia captura → lectura en vivo | Desde la captura del cuadro leído hasta que la lectura está en el HUD | p50, p95, p99 y n |
| 9 | Latencia captura → registro | Desde la captura del mejor cuadro hasta que el backend confirma el registro | p50, p95, p99 y n |
| 10 | Cuadros | FPS recibidos, FPS analizados, % descartados | — |

Las métricas se informan por partición, por condición y por cámara, y siempre con el número de
pasos. Una diferencia entre dos variantes se afirma con una prueba pareada sobre los mismos pasos:
McNemar para aciertos y Wilcoxon o bootstrap pareado para latencias.

## 4. Criterios de aceptación propuestos

Estas cifras son **objetivos por validar**, no resultados. Se consideran cumplidos solo si el
**límite inferior** del IC 95 % los alcanza en la partición de prueba. Para una proporción cercana
al 95 %:

- con unos 300 pasos por condición, la mitad del intervalo de Wilson es de ±2,5 puntos;
- con 1 000 pasos, es de ±1,4 puntos.

| Condición | Recall de detección | Reconocimiento exacto de punta a punta | Lecturas incorrectas confirmadas | Falsas detecciones | Latencia captura → lectura (p95) |
|---|---|---|---|---|---|
| Controlada: placa ≥ 130 px, ángulo ≤ 30°, de día | ≥ 98 % | ≥ 95 % | ≤ 1 % de los pasos | ≤ 1 por hora | ≤ 1,5 s |
| Diurna real | ≥ 96 % | ≥ 90 % | ≤ 2 % | ≤ 1 por hora | ≤ 2 s |
| Nocturna real (con IR) | ≥ 92 % | ≥ 85 % | ≤ 3 % | ≤ 1 por hora | ≤ 2 s |
| Placas lejanas (< 80 px) | Informativo | Sin objetivo: debe marcarse incierta o no legible | ≤ 2 % | ≤ 1 por hora | — |
| Vehículos que no se detienen | ≥ 92 % | ≥ 85 % | ≤ 2 % | ≤ 1 por hora | ≤ 2 s |
| Adversa: lluvia, contraluz, oclusión | Informativo | Informativo | ≤ 3 % | ≤ 1 por hora | — |

Prioridades:

- **Primero, la seguridad:** una lectura incorrecta confirmada puede abrir la barrera a otra placa.
- **Después, la cobertura:** pocos pasos sin lectura correcta.
- **Siempre**, un tope a las falsas alarmas.

Bajar las falsas alarmas con filtros que dejen pasos sin leer no cuenta como mejora si cae el
reconocimiento de punta a punta.

## 5. Calibración de cada cámara

1. **Instalación:**
   - la placa debe medir al menos 130 px de ancho en el punto de lectura (unos 25–30 px de alto
     por carácter);
   - ángulo horizontal y vertical de 30° como máximo;
   - la cámara, de 1,5 a 3 m antes de la barrera.
2. **Exposición:**
   - obturador de 1/1000 s o más rápido en garita y de 1/2000 s si los vehículos no se detienen,
     porque el desenfoque de movimiento es la principal causa de lecturas perdidas
     (METODO §3.2);
   - WDR ante contraluz e IR de noche;
   - principal H.264/H.265 de al menos 4 Mb/s en 1080p y secundario solo para la vista.
3. **Zonas:**
   - área de detección sobre el carril donde la placa es legible;
   - exclusiones solo donde no pasan vehículos (árboles, banderas, reflejos, la hora
     sobreimpresa);
   - comprobar en el HUD de Monitoreo que ninguna placa real queda en una exclusión ni fuera del
     área.
4. **Umbrales, con la partición de calibración de esa cámara:** `PLATE_CONFIDENCE_THRESHOLD`
   (0,22 por omisión, calibrado con Open Images y el piloto) y la compuerta de movimiento. Se
   recalibran si cambia la instalación.
5. **Latencia:** revisar en Monitoreo la lectura p95 y el porcentaje de cuadros descartados. Si el
   análisis no alcanza 5 fps con vehículos a la vista, conviene más CPU, una GPU o un área de
   detección más pequeña.
