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
- **E5 · Lectura directa:** cada carácter de la placa lo leyó tal cual algún lector (OCR profundo, verificador u OCR rápido en otro cuadro del track). Un carácter que solo existe porque el formato lo sustituyó (S→5, D→P…) es una hipótesis: la lectura se registra con la salida cruda de cada lector, pero queda para el personal (`caracteres_inferidos` en la evidencia). E4 sola no basta: dos lectores que leen "PSYS89" coinciden en "PSY589" gracias a la misma sustitución, sin que ninguno haya visto el "5".

**Solo placas: formato coherente con la forma.** Las placas de auto son alargadas y de una fila
(3 letras + 3 o 4 dígitos, o diplomáticas); las de moto, casi cuadradas y de dos filas. Una lectura
con formato de moto dentro de un recuadro de auto no se registra: es texto que no es una placa
(teclado, pantalla, rótulo) o una placa de auto mal leída a la que le falta un carácter. Se trata
como foto ilegible (otro cuadro del paso o, sin más intentos, descarte auditado con motivo
`formato_no_corresponde_a_la_placa`) y, si el OCR rápido leyó así, el registro espera al
verificador, cuya lectura puede ser la correcta.

**Interpretación de la lectura** (`app/dominio/interpretacion_placa.py`). El texto del OCR se
interpreta como el formato ANT (particular, moto, diplomático) que lo explica con **menos**
sustituciones de la tabla de confusiones; cada sustitución queda registrada y nunca se agregan ni
quitan caracteres. Antes se probaba primero el formato de automóvil y se forzaba: una moto leída
bien se convertía en otra placa (PB1234 → PBI-234, AB123A → ABI-234) en los tres lectores; un texto
sin formato salía alterado (TRANS1 → TR-4N51) y una diplomática de 7 caracteres perdía el último.
La salida cruda de cada lector se guarda en la evidencia (`lectura_ocr_cruda`,
`lectura_verificador_cruda`, `lecturas_rapidas_crudas`) y se muestra en el detalle del paso.

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
que su costo no depende de la resolución de la cámara; solo cuenta lo que ocurre dentro de la
región de interés (si la hay) y fuera de las zonas de exclusión. El estado corresponde a la
cámara RTSP activa y se reinicia al cambiar de cámara.

- **Zonas de la cámara (las dibuja el administrador sobre el video).** El *área de detección*
  (región de interés, la "detection mask" de OpenALPR) delimita dónde se buscan placas. Las
  *zonas de exclusión* (hasta 8 polígonos) son lo contrario: se marcan donde hay movimiento
  falso y no pasan vehículos (árboles, banderas, reflejos, la vereda, la hora sobreimpresa).
  Ambas forman una sola máscara (región menos exclusiones) que se aplica a la compuerta, a MOG2,
  a la zona de movimiento del HUD y a la decisión de si una pista se movió; además se descartan
  las placas cuyo centro queda fuera de la región o dentro de una exclusión. Un árbol que se
  mece deja así de disparar el detector en cada cuadro: el motor solo trabaja cuando entra un
  vehículo, y el HUD de Monitoreo muestra las zonas (rojo translúcido).
- **Recorte de la región de interés para la inferencia** (`ROI_CROP_INFERENCE`, activo por
  omisión). El detector se ejecuta sobre el rectángulo envolvente de la región con un margen
  (8 % del ancho y 6 % del alto, porque una placa con el centro dentro puede sobresalir del
  polígono) en lugar del cuadro completo; las cajas vuelven a coordenadas del cuadro. Como el
  detector lleva la imagen a 512 px en su lado mayor, una región más pequeña que el cuadro
  entrega más píxeles por placa. Si el recorte no ahorra al menos un 20 % del área se usa el
  cuadro completo. Resultado en §3.3.

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

**Registro en menos de 1 s y reevaluación** (`REGISTRO_MAX_MS`, 1000 por omisión). Con una placa
ya leída por el OCR y una fila de caracteres plausible (E3), el paso se registra dentro de 1 s desde
la captura de su foto: no espera al análisis del vehículo y espera al verificador solo hasta ese
plazo. Lo que llega después se envía al backend como **reevaluación** (`POST
/detecciones/reevaluar`): la lectura se recalcula con las mismas reglas que si hubiera llegado a
tiempo (la placa del verificador prevalece si lee una placa ANT; E4 y E5 con su lectura) y el
backend decide de nuevo con R1–R7, incluido el segundo factor (R4). Una lectura así puede pasar de
POR CONFIRMAR a AUTORIZADO cuando el segundo OCR la confirma, o de AUTORIZADO a POR CONFIRMAR si el
vehículo observado no coincide; una alerta no se rebaja y lo validado por el personal se conserva.
Sin placa o con una foto dudosa (sin fila de caracteres) el registro espera al verificador como
antes, porque es quien puede leerla o descartarla.

**Tope del verificador.** Antes el registro esperaba al verificador hasta el final aunque pasara de
su presupuesto (`OCR_VERIFIER_MAX_MS`, 2 s) y luego descartaba su lectura por tardía: en la prueba
con la cámara simulada esperó 4,0 s y el registro tardó 4,9 s. Ahora deja de esperar cuando la
lectura ya supera el presupuesto, contado desde que el verificador empieza a leer (como su propio
presupuesto), así que nunca se pierde una lectura que habría llegado a tiempo; el paso se registra
sin la confirmación del segundo OCR y queda para el personal si no tiene otra.

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

### 3.3 Zonas de la cámara: exclusiones y recorte de la región (A/B pareados, 2026-10-12)

**Recorte de la región de interés** (`scripts/ab_recorte_roi.py`,
`docs/resultados/recorte_roi_2026-10-12.json`). Prueba oficial de Open Images (2 048 imágenes,
2 816 placas), detector de producción, umbral 0,22, 512 px. Cada imagen simula una cámara con el
área de detección dibujada alrededor del carril (un rectángulo que contiene las placas, de al
menos la mitad del cuadro por lado); en ambas condiciones se descartan las detecciones con el
centro fuera del área, como en el motor, y el orden A/B se alterna por imagen.

| Placas | Cuadro completo | Recorte del área | McNemar (discordantes) |
|---|---|---|---|
| Todas (2 816) | 83,6 % | 85,7 % | χ² = 21,1; p = 4·10⁻⁶ (48 frente a 106) |
| Pequeñas, < 3 % del ancho (560) | 37,9 % | 47,5 % | χ² = 38,0; p < 10⁻⁸ (10 frente a 64) |
| Medianas, 3–8 % (681) | 90,6 % | 92,4 % | χ² = 3,8; p = 0,052 |
| Grandes, ≥ 8 % (1 575) | 96,8 % | 96,3 % | χ² = 1,0; p = 0,31 |

El recorte mejora sobre todo las placas lejanas, que a cuadro completo quedan con pocos píxeles,
sin cambiar el tiempo de inferencia (mediana 99,6 frente a 98,6 ms). Costo: las detecciones sin
placa real dentro del área pasan de 139 a 153 (+10 %); las filtran después el análisis de
caracteres, el consenso y la validez de la lectura (§2.2). Limitación: el área se ubica a partir
de las placas etiquetadas (simula a un administrador que conoce el carril); con un área que
ocupe casi todo el cuadro no hay recorte y el resultado es el del cuadro completo.

**Zonas de exclusión** (`scripts/ab_exclusiones.py`, `docs/resultados/exclusiones_video_2026-10-12.json`).
Escena de la cámara Hikvision simulada (460 cuadros de 1920×1080, cuatro vehículos con placa
real) con una hilera de árboles que se mece en la franja superior, por donde no pasan vehículos;
pipeline completo con compuerta y recorte activos, mismos cuadros en cada condición.

| | A · sin zonas | B · exclusión sobre los árboles | C · carril + exclusión |
|---|---|---|---|
| Inferencias del detector | 356 (77,4 % de los cuadros) | 259 (56,3 %) | 259 (56,3 %) |
| Tiempo por cuadro | 69,8 ms | 53,3 ms | 49,7 ms |
| Cuadros con placa real en el carril | 320 | 319 | 319 |
| Cuadros con una pista falsa en los árboles | 427 | 0 | 0 |

Sin zonas, el follaje hacía correr el detector en casi cada cuadro y producía pistas de "placa"
falsas en el 93 % de ellos; con la exclusión desaparecen, el motor procesa un 24 % menos tiempo por
cuadro y las placas reales se siguen detectando igual. Limitaciones: escena sintética y un solo
tipo de distractor; los tiempos son de una corrida en el portátil de desarrollo (las cuentas de
inferencias y pistas son deterministas).

### 3.4 Interpretación de las lecturas OCR (A/B pareado, 2026-10-12)

**Aporte de las reglas posicionales** (`scripts/benchmark_ocr.py`, 77 recortes reales
etiquetados): exactitud sin reglas frente a con reglas, 89,6 % frente a 89,6 % con el OCR de
producción (cct-s-v2-global) y 98,7 % frente a 98,7 % con PP-OCRv6. En estos recortes las
sustituciones no corrigen ninguna lectura: los errores restantes son confusiones letra↔letra o
dígito↔dígito (RSY589, PSY585, TDH309…), que ninguna regla de posición puede resolver.

**A/B de la interpretación** (`scripts/ab_correcciones.py`,
`docs/resultados/correcciones_ocr_2026-10-12.json`). Mismos 77 recortes y mismos modelos de
producción; A = reglas anteriores (versión en git), B = interpretación actual con E5. Decisión por
foto como en el motor (sin el consenso de varios cuadros, que una foto no tiene).

| | A · reglas anteriores | B · mínimo de sustituciones + E5 |
|---|---|---|
| Placa registrada correcta | 74/77 (96,1 %; IC95 89,2–98,7 %) | 74/77 (96,1 %; IC95 89,2–98,7 %) |
| Confirmada y correcta | 69/77 (89,6 %) | 69/77 (89,6 %) |
| Confirmada y errónea | 1/77 (1,3 %; IC95 0,2–7,0 %) | 1/77 (1,3 %; IC95 0,2–7,0 %) |
| Pares discordantes (McNemar) | — | 0 frente a 0; p = 1,0 |

Sin pérdidas en lecturas reales: el cambio no altera ninguna decisión de estos recortes. Una foto
tuvo un carácter inferido (los dos lectores leyeron una "D" inicial y la regla D→P produjo
"PCV589", también errónea): ahora queda señalada. La lectura confirmada y errónea es un error
correlacionado sin sustitución (los dos modelos leyeron "PSY585" por "PSY589"); E5 no la cubre y
en el motor la mitigan el consenso de varios cuadros y el segundo factor del vehículo.
Limitaciones: 77 recortes de solo 2 placas (75 de PSY589) de una cámara; la corrección de las
motos y de los textos sin formato se demuestra con pruebas unitarias, porque el conjunto no tiene
motos.

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
