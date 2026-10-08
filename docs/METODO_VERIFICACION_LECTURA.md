# Verificación geométrica y validez de la lectura (método para la publicación)

Este documento describe la etapa de verificación que se agregó entre el detector de placas
y la decisión de acceso, inspirada en la arquitectura de OpenALPR
(<https://github.com/openalpr/openalpr>) y en el comportamiento de su producto comercial
Rekor Scout. Incluye el protocolo para evaluarla (ablación) con los datos que el sistema ya
registra.

Código: `services/anpr/app/aplicacion/verificacion_placa.py` (análisis y veredicto),
`services/anpr/app/aplicacion/detector.py` (integración en el seguimiento),
`services/anpr/app/main.py` (`_verify_and_commit`) y
`backend/src/aplicacion/detecciones.ts` (`completarOcr`, fase 2) y `backend/src/dominio/decisionAcceso.ts`
(regla de decisión R1–R7).

## 1. Problema

Un detector de una sola etapa (YOLO26n afinado para placas, sin NMS; ver
`services/anpr/models/MODEL_CARD.md`) propone regiones con
confianza, pero:

1. propone también regiones que no son placas o que son solo parte de una (la franja
   "ECUADOR", rótulos, parachoques), y el OCR produce sobre ellas textos con formato
   plausible (caso real: la franja leída como `ECU406`);
2. la caja alineada con los ejes no describe una placa inclinada o vista en perspectiva;
3. la confianza del OCR no está calibrada: una lectura borrosa (`BSI3111`, confianza de
   detección 0,39) obtuvo confianza OCR 1,00; y una placa cortada por el borde del cuadro
   (`SY589` en lugar de `PSY589`) generó una alarma de "no registrado".

Un umbral de confianza único no distingue estos casos. OpenALPR no confía en el detector:
cada región pasa por análisis de caracteres, búsqueda de bordes y consenso antes de
aceptarse.

## 2. Método

Correspondencia con OpenALPR:

| Etapa | OpenALPR | Implementación |
|---|---|---|
| Máscara de detección | `detection_mask` | Región de interés por cámara (`Camaras.roi`), polígono normalizado; se descartan las detecciones cuyo centro cae fuera (`punto_en_roi`). |
| Análisis de caracteres | `CharacterAnalysis` | `analizar_caracteres`: 4 binarizaciones (adaptativa 19/31 inversa, Otsu, adaptativa normal) × 2 aperturas morfológicas; componentes conexas con forma de caracter y búsqueda de la fila más numerosa de cajas alineadas y de altura similar (con variación lineal de la altura para admitir perspectiva). |
| Enderezado | deskew | Si la fila hallada está inclinada ≥ 6° y tiene menos de 6 caracteres, se rota el recorte para dejarla horizontal y se repite la búsqueda. |
| Bordes de la placa | `PlateLines` / `PlateCorners` | `_bordes_placa`: rectas de Hough sobre el mapa de bordes; superior e inferior casi paralelas a la fila (±14°) a la distancia que predice la geometría ANT; laterales casi perpendiculares justo fuera de la fila; bordes opuestos coherentes. Los bordes no hallados se sustituyen por el modelo geométrico. |
| Consenso | `plate groups` / n-best | Conteo de lecturas idénticas del mismo track en cuadros distintos + segundo OCR independiente (PP-OCRv6). |

Geometría de la placa ANT (auto, 404 × 154 mm) usada por el modelo: la fila de caracteres
ocupa ≈ 47 % del alto; sobre ella hay 0,70 alturas de caracter (franja "ECUADOR") y bajo
ella 0,43; proporción 2,62. Las motocicletas (placa cuadrada, dos filas) exigen 2
caracteres y usan la caja del detector.

### 2.1 Qué se dibuja

Una pista **en movimiento** (parte de su caja cambió según MOG2 en algún cuadro, ver §2.4)
se dibuja desde el primer cuadro en que aparece, para que el operador vea la placa seguida
mientras el OCR la lee. Una pista **quieta** solo se dibuja cuando hay evidencia de placa
(fila de caracteres o al menos una lectura con formato ANT): así no se enmarcan rótulos,
rejillas u otros objetos fijos que el detector confunde con placas.

| Situación | Color | Insignia |
|---|---|---|
| Sin lectura con formato ANT | ámbar | "ESCANEANDO OCR" o el texto parcial, con la confianza del detector |
| Placa leída por consenso | verde | placa y confianza del consenso |
| Estado decidido por el backend | el del estado (autorizado, por confirmar, no registrado, alerta) | placa y estado |

La figura es el cuadrilátero de `_bordes_placa` cuando se localizó la fila de caracteres, o
la caja del detector mientras tanto. Sobre el video se muestra además la zona de movimiento
(MOG2) cuando contiene una detección del detector de placas. Dibujar no implica registrar:
cada pista lleva el indicador `verificada` (fila de caracteres válida de 5–9 caracteres en
algún cuadro del track, o al menos dos lecturas OCR con formato ANT en cuadros distintos), y
qué lectura se guarda y si se autoriza sola lo decide la validez de la lectura (§2.2).

### 2.2 Validez de la lectura

`evaluar_lectura` declara **válida** una lectura cuando se cumplen todas las evidencias:

- **E1 · Formato:** la placa corresponde a un formato ANT vigente.
- **E2 · Placa completa:** la caja no toca el borde del cuadro, lo que descarta lecturas truncadas.
- **E3 · Geometría:** hay una fila de caracteres válida en el mejor cuadro del track. Un consenso fuerte (≥ 3 cuadros y ambos OCR de acuerdo) puede sustituir esta evidencia, porque con inclinación extrema los caracteres se funden con el marco.
- **E4 · Confirmación:** hay ≥ 2 lecturas OCR idénticas en cuadros distintos (lecturas rápidas del track y la lectura profunda de la foto), o el segundo OCR (PP-OCRv6) coincide exactamente con alguna de esas lecturas. El verificador nunca se confirma a sí mismo: si el OCR no leyó la placa que lee el verificador, la lectura queda sin confirmar.

**Placa registrada.** Cuando el verificador PP-OCRv6 lee una placa con formato ANT, esa es la
placa que se registra, porque es el lector más preciso (96,1 % frente a 89,6 % del OCR rápido en 77
recortes reales, `models/MODEL_CARD.md`; 12 de 12 frente a 10 de 12 en §3.2). Si no lee, se
registra la del OCR (consenso multi-cuadro, lectura profunda o preliminar). Así un error
sistemático del OCR rápido repetido en varios cuadros (p. ej. Y→V) no se impone al verificador; si
los dos discrepan, E4 no se cumple y el paso queda para revisión.

Además, una región sin fila de caracteres (< 3) y sin ninguna confirmación se descarta
como "no placa" (`AuditoriaDescartes.motivo = region_sin_caracteres`) y el track puede
reintentar con un cuadro mejor.

### 2.3 Regla de decisión (backend)

| Cruce con listas | Lectura válida | Resultado |
|---|---|---|
| Lista de alertas | cualquiera | `alerta` (nunca se rebaja) |
| Padrón | sí, y confianza ≥ mínimo | `autorizado` automático (aviso verde y sonido) |
| Padrón | no, o confianza < mínimo | `pendiente_revision` con motivo ("CONFIRME EL INGRESO") |
| Ninguna | sí | `no_reconocido` (alarma de no registrado) |
| Ninguna | no | `pendiente_revision` sin alarma: puede ser una placa autorizada mal leída |

El criterio es configurable en *Configuración › Criterio de autorización automática*:
`validez_y_confianza` (por omisión), `validez` o `confianza` (comportamiento anterior, línea
base). El veredicto y las evidencias se guardan en `DeteccionVehiculo.lectura_valida` y
`evidencia_lectura` (JSON), y se muestran en el detalle de cada detección.

### 2.4 Movimiento: compuerta de inferencia y lectura de placas completas

`aplicacion/movimiento.py` analiza una copia del cuadro reducida a 320 px de ancho, de modo
que su costo no depende de la resolución de la cámara; con región de interés solo cuenta lo
que ocurre dentro de ella. La cámara RTSP y la webcam del navegador tienen cada una su propio
estado.

- **Compuerta de inferencia.** El detector de placas se ejecuta solo si la escena cambió
  desde la última inferencia: diferencia absoluta (tras suavizado gaussiano 5×5) contra el
  cuadro de esa inferencia, con píxeles que difieren en más de 20 niveles en al menos
  `MOTION_GATE_MIN_FRACTION` del área (0,2 % por omisión). Si no cambió, la última detección
  sigue siendo válida por construcción: no se ejecuta YOLO y los tracks quedan congelados (sin
  predecir ni envejecer), mientras las pistas y su dibujo se reconstruyen en cada cuadro para
  que una lectura o una decisión del backend se vean al instante. Comparar contra la última
  inferencia, y no contra el fondo aprendido, acumula los cambios lentos y detecta también lo
  que desaparece: cuando un vehículo sale, la zona que deja libre vuelve a parecerse al fondo
  y la sustracción de fondo no la marca. El detector se ejecuta además mientras alguna pista
  no se haya encontrado en la última inferencia (hay que confirmarla o darla de baja) y, como
  control, tras `MOTION_GATE_MAX_SKIP` cuadros seguidos sin inferencia (5 por omisión). El
  primer cuadro siempre se analiza. `MOTION_GATE_ENABLED=false` desactiva la compuerta, lo que
  permite medir su efecto.
- **Movimiento (MOG2, historia 120 cuadros, umbral de varianza 25):** da la zona de
  movimiento del HUD y marca un track "en movimiento" (§2.1) cuando al menos 15 % de su caja
  difiere del fondo aprendido en algún cuadro. El primer cuadro (con el que MOG2 inicializa el
  fondo y que marca entero como cambio) no cuenta: lo que ya estaba en la escena al arrancar
  no es movimiento.
- **Lectura de placas completas.** El OCR del flujo en tiempo real no lee una placa cuya caja
  toca el borde izquierdo o derecho del cuadro (`toca_borde_lateral`, margen 1 %): en una placa
  horizontal la fila de caracteres ocupa casi todo el ancho, así que un vehículo que entra por
  un lado deja leer la placa truncada ("SY589" por "PSY589"), con formato ANT a veces, y ese
  texto votaría por una placa equivocada en el consenso del track. Un corte arriba o abajo
  quita primero la franja "ECUADOR" o el margen inferior, por lo que esas placas sí se leen. La
  validez (E2) sigue exigiendo que la placa no toque ningún borde.

Observabilidad: `GET /status` informa `inferencias_omitidas_pct` y Prometheus
`anpr_inferences_total{source, result}` (`executed` / `skipped`).

### 2.5 Registro del paso: etapas en paralelo, vehículo anticipado y reintento

Cuando el selector elige la foto de un track, el registro ejecuta **en paralelo** el OCR profundo,
el verificador PP-OCRv6 y los atributos del vehículo (antes iban uno tras otro y sumaban más de
1 s). El análisis del vehículo no depende de la foto de la placa, así que **empieza antes**: en
cuanto un track en movimiento tiene la placa completa dentro del cuadro. Si la foto elegida no
permite leer la placa (desenfoque, oclusión), el track queda libre para que el selector elija otro
cuadro del mismo paso, hasta 3 intentos (`MAX_INTENTOS_CAPTURA`); antes una sola foto ilegible
hacía perder el vehículo, porque el track quedaba bloqueado 35 s. El descarte se audita una sola
vez, al agotar los intentos. Cada motor de inferencia tiene un número fijo de hilos
(`TORCH_THREADS`, `OCR_THREADS`, `OCR_VERIFIER_THREADS`) para no sobresuscribir la CPU. La latencia
de cada paso se publica en Prometheus (`anpr_recognition_latency_seconds`) y la duración de cada
etapa queda en `evidencia_lectura.etapas_ms`.

## 3. Resultados preliminares (calibración)

Sobre los 115 recortes reales de placa guardados por el sistema (cámara de celular, placa
PSY-589 y otras), con un margen igual al de producción:

- 88 recortes con fila de caracteres válida. Los rechazados son, al inspeccionarlos,
  placas cortadas por el borde, ocluidas por la mano o recortes solo de la franja
  "ECUADOR".
- Casos de control: franja `ECU406` → rechazada (2 caracteres); borrosa `BSI3111` →
  rechazada (0); PSY-589 inclinada −19° → aceptada tras el enderezado (6 caracteres, 4 de 4
  bordes hallados); TBD-7724 → aceptada.
- Costo: ≈ 5 ms por recorte en CPU; en vivo se ejecuta como máximo 4 veces por segundo por
  track.

Estos números son de calibración (los mismos recortes guiaron los umbrales) y **no** deben
reportarse como resultado final: el protocolo de la sección 4 los mide sobre datos nuevos.

### 3.1 Compuerta de inferencia y lectura de placas completas (escena compuesta)

`scripts/evaluar_compuerta.py` compone, a partir de 12 capturas etiquetadas
(`scripts/escenas_compuerta.csv`: 11 con PSY-589, una con TBD-7724), una escena realista por
captura: la placa se borra con inpainting para obtener la escena vacía y luego entra por el
borde izquierdo, se detiene 30 cuadros y sale por el derecho (132 cuadros con 60 de escena
vacía; ruido σ = 2). Se comparan dos variantes con el mismo modelo y el mismo seguimiento:
**base** (detector en cada cuadro, OCR de cualquier caja) y **propuesta** (compuerta de §2.4 y
OCR solo de placas sin corte lateral). Resultado en `docs/resultados/compuerta_movimiento.json`
(CPU, contenedor Docker; los tiempos absolutos dependen de la carga del equipo):

| Métrica (12 secuencias) | Base | Propuesta |
|---|---|---|
| Inferencias del detector por secuencia (de 132 cuadros) | 132 | 57,4 (−56,5 %) |
| ms por cuadro, escena vacía | 59,4 | 14,1 (−76 %) |
| ms por cuadro, con placa en escena | 64,5 | 45,1 (−30 %) |
| Lecturas de placas cortadas por el borde lateral (margen del 2 %) | 31 | 0 |
| Intentos de OCR | 122 | 97 |
| Consenso correcto con la placa detenida | 9 de 12 | 9 de 12 |
| Cuadros de detección (entrada de la placa) | iguales en las 12 | iguales en las 12 |
| Mediana de cuadros entre detección y lectura visible | 7 | 10 |

La compuerta no retrasó ninguna detección ni cambió los aciertos; el costo de no leer placas
truncadas es una lectura visible unos 3 cuadros más tarde, a cambio de que ninguna lectura
truncada entre al consenso. Los 3 fallos son de reconocimiento y ocurren en ambas variantes:
"PSV589" por "PSY589" (OCR), una placa lejana e inclinada que el detector no encuentra y la
placa naranja TBD-7724. Limitaciones: escena sintética a partir de fotos fijas (movimiento
lineal, sin cambios de luz ni compresión de video), una sola cámara y tiempos absolutos que
dependen del equipo; debe repetirse con video real de la garita.

### 3.2 Desenfoque de movimiento y latencia del registro

**OCR frente al desenfoque** (`scripts/evaluar_desenfoque.py`, resultado en
`docs/resultados/ocr_desenfoque.json`): a las 12 capturas (placa de ~180 px de ancho) se les
aplica un desenfoque horizontal uniforme de L px, el que produce una placa que avanza L px durante
la exposición.

| Desenfoque (px) | 0 | 3 | 6 | 9 | 12 | 16 |
|---|---|---|---|---|---|---|
| OCR rápido correcto | 10/12 | 10/12 | 7/12 | 6/12 | 4/12 | 4/12 |
| Verificador PP-OCRv6 correcto | 12/12 | 12/12 | 11/12 | 8/12 | 5/12 | 4/12 |

Por encima de ~6 px (≈ 3 % del ancho de la placa) la lectura se degrada y ningún paso posterior
la recupera: es un límite de la captura, no del software. Requisito para la cámara de la garita:
L = velocidad de la placa en la imagen × tiempo de exposición ≤ 3–6 px. Por ejemplo, una placa
que cruza 640 px en 1,5 s (~430 px/s) exige una exposición de 1/150 s o menos para 3 px; con más
velocidad o resolución, 1/500 s o menos (obturación rápida con iluminación IR en la noche).

**Latencia de punta a punta** (`scripts/evaluar_latencia.py`, resultado en
`docs/resultados/latencia_movimiento.json`): el motor de producción completo (hilos de captura y
detección, OCR asíncrono, compuerta de captura, OCR profundo, verificador y vehículo) recibe la
escena compuesta a 15 cuadros/s desde una cámara simulada en tiempo real; la placa cruza el
cuadro en 1,5 s sin detenerse, con 3 px (obturación rápida) u 8 px (lenta) de desenfoque. La
latencia se mide desde el cuadro en que la placa queda completa hasta el envío del registro con
la lectura. Ablación **pareada**: cada escena se recorre con la variante base (etapas una tras
otra, vehículo al registrar, sin reintento, enfriamiento del OCR de 0,6 s) y con la optimizada
(§2.5), alternando el orden, porque en el equipo de prueba (portátil i9-13900H, núcleos de alto
rendimiento y de eficiencia, con escritorio remoto y servicios de desarrollo activos) la carga
de fondo varía de un minuto a otro. Ambas variantes incluyen las reglas de §2.2 (placa del
verificador, E4) y los márgenes de §2.4.

| Desenfoque 3 px (12 escenas) | Base | Optimizada |
|---|---|---|
| Pasos registrados / correctos | 10 / 10 | 10 / 10 |
| Latencia mediana (p90) | 1323 ms (1837) | 1109 ms (1531) |
| Diferencia pareada (10 pares) | — | −198 ms, IC 95 % [−367, −34]; 8 de 10 pares más rápidos; Wilcoxon p = 0,037 |

Con 8 px de desenfoque la optimizada registra 7 pasos (6 correctos) frente a 6 (5 correctos);
con solo 5 pares la diferencia de latencia no es concluyente. En una corrida anterior de la misma
ablación, con menos carga de fondo, la diferencia pareada fue de −316 ms (8 de 8 pares, Wilcoxon
p = 0,008). Frente al estado de partida (antes de las reglas de §2.2 y §2.4 y del registro de
§2.5), con 3 px de desenfoque se pasó de 7 placas correctas y 2 equivocadas registradas (una
truncada, "SY589", y una con el error Y→V del OCR rápido) a 10 correctas y ninguna equivocada.

Limitaciones: latencias absolutas de 0,6–1,3 s según la carga del portátil; en un equipo
dedicado (sin escritorio remoto ni servicios de desarrollo) deben ser menores, pero no se
midieron. La escena es sintética (movimiento lineal, sin video comprimido) y el desenfoque es
constante durante el paso; con una cámara real el vehículo frena al acercarse a la garita y los
últimos cuadros son más nítidos.

## 4. Protocolo de evaluación y ablación

1. Operar el sistema con el criterio que se quiera evaluar y validar cada paso en la
   pantalla de detecciones: `placa_validada` es la verdad de terreno.
2. Métricas por paso con lectura del motor (`evidencia_lectura IS NOT NULL`):
   - **Precisión de la decisión automática:** fracción de lecturas marcadas válidas cuya
     placa coincide con la validada. Es la métrica de seguridad: un error aquí es una
     autorización indebida.
   - **Cobertura:** fracción de pasos resueltos sin intervención.
   - **Falsas alarmas de "no registrado"** evitadas por E2–E4.
3. Ablación: como las evidencias se guardan por separado, cada variante se recalcula
   sin volver a grabar video, quitando una evidencia a la vez.

```sql
-- Evidencias por paso (SQL Server 2022)
WITH ev AS (
  SELECT d.id,
         REPLACE(d.placa_ocr_original, '-', '')                        AS lectura,
         REPLACE(COALESCE(d.placa_validada, d.placa_reconocida), '-', '') AS verdad,
         d.validado_manualmente,
         d.confianza_ocr_original                                       AS conf,
         CAST(JSON_VALUE(d.evidencia_lectura, '$.formato') AS BIT)              AS e1,
         CAST(JSON_VALUE(d.evidencia_lectura, '$.dentro_cuadro') AS BIT)        AS e2,
         CAST(JSON_VALUE(d.evidencia_lectura, '$.caracteres') AS INT)           AS caracteres,
         CAST(JSON_VALUE(d.evidencia_lectura, '$.lecturas') AS INT)             AS lecturas,
         CAST(JSON_VALUE(d.evidencia_lectura, '$.verificador_coincide') AS BIT) AS verif
  FROM DeteccionVehiculo d
  WHERE d.evidencia_lectura IS NOT NULL AND d.validado_manualmente = 1
), variantes AS (
  SELECT *,
    CASE WHEN conf >= 0.82 THEN 1 ELSE 0 END                                              AS solo_confianza,
    CASE WHEN e1 = 1 AND e2 = 1 AND caracteres >= 5 AND (lecturas >= 2 OR verif = 1) THEN 1 ELSE 0 END AS completa,
    CASE WHEN e1 = 1 AND caracteres >= 5 AND (lecturas >= 2 OR verif = 1) THEN 1 ELSE 0 END             AS sin_e2,
    CASE WHEN e1 = 1 AND e2 = 1 AND (lecturas >= 2 OR verif = 1) THEN 1 ELSE 0 END                      AS sin_e3,
    CASE WHEN e1 = 1 AND e2 = 1 AND caracteres >= 5 THEN 1 ELSE 0 END                                   AS sin_e4
  FROM ev
)
SELECT v.variante,
       COUNT(*)                                                         AS pasos,
       SUM(v.acepta)                                                    AS aceptados,
       CAST(SUM(v.acepta) AS FLOAT) / NULLIF(COUNT(*), 0)               AS cobertura,
       CAST(SUM(CASE WHEN v.acepta = 1 AND t.lectura = t.verdad THEN 1 ELSE 0 END) AS FLOAT)
         / NULLIF(SUM(v.acepta), 0)                                     AS precision_aceptados
FROM variantes t
CROSS APPLY (VALUES (N'solo confianza >= 82 %', t.solo_confianza), (N'completa', t.completa),
                    (N'sin E2 (borde)', t.sin_e2), (N'sin E3 (geometría)', t.sin_e3), (N'sin E4 (confirmación)', t.sin_e4))
            AS v(variante, acepta)
GROUP BY v.variante;
```

(La simplificación `caracteres >= 5` omite el caso de consenso fuerte que sustituye a E3;
para reproducir exactamente el veredicto use la columna `lectura_valida`.)

4. Reportar además la calidad del cuadrilátero: sobre una muestra etiquetada a mano con
   las cuatro esquinas, el IoU entre el polígono etiquetado y (a) la caja del detector y
   (b) el cuadrilátero de `_bordes_placa`. El número de bordes hallados (`bordes_hallados`,
   0–4) queda guardado por paso.

## 5. Limitaciones

- Los umbrales se calibraron con una sola cámara de celular en interiores; deben
  revalidarse con la cámara de la garita (distancia, ángulo y luz reales).
- La búsqueda de bordes puede tomar el borde de otro objeto claro contiguo a la placa;
  la coherencia entre bordes opuestos y con la geometría de la fila lo mitiga, y los
  bordes no hallados se sustituyen por el modelo.
- Las placas de motocicleta (dos filas) solo pasan por E3 en forma reducida.
- El veredicto no cubre placas clonadas: para eso existe el segundo factor
  (marca/color/tipo del vehículo).
