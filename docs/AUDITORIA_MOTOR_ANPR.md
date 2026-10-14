# Auditoría del motor ANPR (2026-10-12)

Revisión del flujo real de reconocimiento (cámara → detección → seguimiento → OCR → validez →
registro) con el objetivo de operar en tiempo real con vehículos en movimiento. Cada hallazgo se
verificó en el código, se reprodujo con una prueba automática que falla sin la corrección y, cuando
cambia el comportamiento del motor, se midió con un A/B pareado en el portátil de desarrollo (CPU,
sin GPU).

**Lo que esta auditoría no pudo validar:** no hubo una cámara real de la garita ni secuencias
reales etiquetadas; la escena de video es sintética (cámara Hikvision simulada con placas reales
recortadas) y el conjunto de recortes reales tiene 77 imágenes de 2 placas. No existe una
comparación medida con productos comerciales de ANPR, por lo que este documento no afirma que el
sistema los supere. El protocolo para obtener esas cifras está en
[PROTOCOLO_EVALUACION_SECUENCIAS.md](PROTOCOLO_EVALUACION_SECUENCIAS.md).

## 1. Flujo real del motor

| Etapa | Implementación | Resolución / frecuencia | Configuración |
|---|---|---|---|
| Captura | RTSP desde MediaMTX (flujo principal de la cámara, credenciales del servicio). Cola de un solo cuadro: el análisis toma siempre el más reciente y los intermedios se descartan contados | Flujo nativo (1080p 25 fps en la prueba) | — |
| Movimiento | MOG2 sobre el cuadro reducido a 320 px, con la máscara de zonas (área de detección menos exclusiones). Sin movimiento no se ejecuta el detector | Cada cuadro analizado | `MOTION_GATE_ENABLED`, `MOTION_GATE_MIN_FRACTION`=0,002, `MOTION_GATE_MAX_SKIP`=5 |
| Detección de placas | YOLO26n `models/license_plate_detector.pt`; inferencia sobre el recorte del área de detección | 512 px; umbral alto 0,22 y bajo ≈0,055 para el seguimiento | `PLATE_CONFIDENCE_THRESHOLD`, `ROI_CROP_INFERENCE`=true |
| Filtro geométrico | Una detección con el centro fuera del área o dentro de una exclusión se descarta | — | Zonas por cámara (Cámaras › Zonas) |
| Seguimiento | Asociación en dos fases al estilo ByteTrack con filtro de Kalman | Pista viva hasta 4 cuadros analizados sin detección | — |
| OCR rápido | fast-plate-ocr `cct-s-v2-global` (ONNX) por pista, en un hilo aparte | Enfriamiento 0,25 s por pista | `OCR_ENGINE=plate`, `OCR_THREADS`=2 |
| Consenso por pista | Votos ponderados por confianza y nitidez; solo votan lecturas con formato ANT y recortes nítidos | Toda la vida de la pista | — |
| Foto del paso | Selector del mejor cuadro (nitidez, tamaño, distancia) | Hasta 3 fotos por paso si una no se lee | `MAX_INTENTOS_CAPTURA`=3 |
| Registro (asíncrono) | En paralelo sobre la foto: OCR profundo (rectificación + realce), verificador PP-OCRv6 medium (OpenVINO) y atributos del vehículo (YOLO26n + CLIP ViT-B-32). El paso se registra en menos de 1 s desde la foto; el verificador y el vehículo que lleguen después se envían como reevaluación y el backend decide de nuevo | Una vez por paso | `REGISTRO_MAX_MS`=1000, `OCR_VERIFIER_MAX_MS`=2000, `OCR_VERIFIER_THREADS`=4, `TORCH_THREADS`=4 |
| Validez (E1–E5) | Formato ANT, placa completa, fila de caracteres, confirmación (≥ 2 lecturas o verificador coincidente) y lectura directa de cada carácter | — | [METODO_VERIFICACION_LECTURA.md §2.2](METODO_VERIFICACION_LECTURA.md) |
| Deduplicación | Motor: pista resuelta y ventana por placa de 35 s renovada mientras el vehículo siga a la vista. Backend: misma placa (o, sin placa, mismo tracking) en la misma cámara dentro de 35 000 ms | — | `PLATE_DEBOUNCE_SECONDS`, `VENTANA_MISMO_PASO_S` |
| Decisión | Backend: las alertas nunca se rebajan; autorización automática solo con lectura válida y confianza ≥ mínimo | — | Configuración › Criterio de autorización |

**Observación frente a evento de paso.** Una *observación* es cada lectura de la placa en un cuadro
(OCR rápido, sin registro); el *paso* es el evento que se registra una sola vez. En el motor el paso
se identifica por la pista; en el backend, por placa y cámara dentro de 35 s.

## 2. Hallazgos y correcciones

### 2.1 Zonas y tiempo real

| Hallazgo | Corrección | Evidencia |
|---|---|---|
| El área de interés solo se dibujaba en la imagen; no existían zonas de exclusión y el follaje o las sombras disparaban el detector | El administrador dibuja el área de detección y hasta 8 zonas de exclusión. El motor las aplica a la compuerta de movimiento, a MOG2, al filtro de detecciones y al recorte de inferencia | `tests/test_zonas.py`; A/B de exclusiones: pistas falsas en los árboles 427 → 0, inferencias 77,4 % → 56,3 % de los cuadros, placas reales del carril 320 frente a 319 (§3.3 del método) |
| No se medía la latencia real | Edad del cuadro, captura → lectura en vivo y captura → registro (p50/p95/máx.), cuadros descartados y tiempo por etapa en `/status` y Prometheus | Pruebas de contrato del motor; §4 de este documento |
| Cola de cuadros | Un solo cuadro pendiente: el análisis nunca trabaja sobre video atrasado; los descartes se cuentan | `cuadros_descartados_pct` en el estado del motor |

### 2.2 Deduplicación (regla de 35 s)

| # | Hallazgo | Efecto | Corrección |
|---|---|---|---|
| H1 | Un vehículo detenido más de 35 s (control de documentos) volvía a registrarse con la misma pista | Paso duplicado | La pista con el paso resuelto no vuelve a dispararse; la ventana de su placa se renueva mientras siga a la vista |
| H2 | Si la foto era ilegible y el vehículo ya había salido, el reintento esperaba un cuadro que nunca llegaría | Paso perdido sin auditoría | Sin la pista a la vista, el descarte se audita en el acto |
| H3 | Una caída del backend dejaba la placa "registrada" en memoria 35 s sin haberse guardado | Paso perdido y siguiente vehículo con esa placa bloqueado | Reintentos ante fallos transitorios (0; 0,5; 1,5 s); si no se acepta, se revierte la reserva, se cuenta el error y se audita |
| H4 | El paso tomaba la cámara vigente al terminar el OCR, no la del disparo; la ventana por placa sobrevivía al cambio de cámara; el backend deduplicaba entre cámaras distintas | Paso atribuido a otra cámara o suprimido | Cámara fijada al disparar; ventana reiniciada al cambiar de cámara; en el backend la misma placa solo es el mismo paso en la misma cámara |
| H5 | Una sola lectura rápida que coincidía con una placa recién registrada omitía al vehículo antes del OCR profundo | Otro vehículo (confusión 8→3) sin registrar | El antiduplicado temprano exige 2 lecturas concordantes |
| H6 | En el backend el mismo `tracking_id` bastaba para reutilizar un ingreso, aunque la placa fuera otra; los ids reinician con el motor | Paso de otro vehículo perdido tras un reinicio | El tracking solo cuenta cuando el ingreso no trae placa |
| H7 | Ventana del backend con `DATEDIFF(SECOND)` (cuenta cambios de segundo: hasta 1 s de error); fotos huérfanas cuando el backend deduplicaba | Bordes de la ventana imprecisos; disco | Ventana exacta en milisegundos (`DATEADD(MILLISECOND, -35000, GETDATE())`); las fotos del intento deduplicado se borran |
| H8 | Una pista descartada se volvía a auditar cada 35 s mientras siguiera a la vista | Auditoría inflada | La pista descartada queda resuelta |
| H9 | El historial descontaba del total cualquier ingreso eliminado, incluso uno nunca mostrado (consolidado) | Total y aviso de "ingresos nuevos" incorrectos | Solo se descuenta la fila visible; el aviso retira la anunciada |

Pruebas: 9 de contrato en el motor, 1 de aplicación en el backend y `frontend/tests/historialEnVivo.test.tsx`.
Las consultas nuevas se ejecutaron en el SQL Server de desarrollo dentro de una transacción
revertida, con estos resultados (antes → después):

- Misma placa en otra cámara: antes se reutilizaba el paso; ahora es un paso nuevo.
- Tracking repetido con otra placa (motor reiniciado): antes se reutilizaba; ahora es un paso nuevo.
- Sin placa: sigue deduplicando por tracking.
- Ventana: un ingreso de hace 34,5 s cuenta como el mismo paso; uno de hace 35,5 s, no.

### 2.3 OCR e interpretación de la placa

| # | Hallazgo | Corrección |
|---|---|---|
| O1 | Tres tablas de sustitución posicional (agente, verificador y validador del motor) aplicadas a ciegas: se probaba primero el formato de auto y se forzaba. Una moto leída bien se convertía en otra placa (PB1234 → PBI-234, AB123A → ABI-234), marcada como válida | Interpretación única (`app/dominio/interpretacion_placa.py`): el formato que explica el texto con menos sustituciones; cada módulo conserva su tabla |
| O2 | El texto crudo de cada lector se perdía: la evidencia guardaba la lectura ya "corregida" | El agente y el verificador devuelven el texto leído; la evidencia guarda `lectura_ocr_cruda`, `lectura_verificador_cruda` y `lecturas_rapidas_crudas`, visibles en el detalle |
| O3 | Dos lectores que coinciden gracias a la misma sustitución contaban como confirmación (los dos leen "S" y el formato pone "5") | E5 · lectura directa: cada carácter debe haberlo leído tal cual algún lector; si no, la lectura queda para el personal con los caracteres inferidos señalados |
| O4 | Sustituciones forzadas sin rastro (D → P en la provincia, U → 0, P → 9…) | Se mantienen como hipótesis registradas (posición, leído, interpretado); no confirman la lectura por sí solas |
| O5 | Texto sin formato devuelto alterado (TRANS1 → TR-4N51); diplomática de 7 caracteres truncada (CC12345 → CC-1234) | Nunca se agregan ni quitan caracteres; sin formato posible se devuelve el texto leído |
| O7 | Texto que no es una placa (teclado y pantalla del portátil, 2026-10-13) se registraba como paso: el recorte del área de detección agranda el texto pequeño y el formato de moto (2 letras + dígitos) admite casi cualquier texto | Solo placas: una lectura con formato de moto en un recuadro de placa de auto no se registra (otro cuadro, el verificador o descarte auditado). En los 10 pasos de esa prueba elimina los 4 falsos y las 4 lecturas incompletas de una placa real; en los 77 recortes etiquetados no rechaza ninguna lectura correcta |
| O6 | La evidencia se cortaba a 1 500 caracteres: si se excedía quedaba un JSON inválido y el detalle perdía las evidencias | Se omiten campos prescindibles (tiempos por etapa primero); nunca se guarda un JSON cortado |

Medición: en 77 recortes reales, las reglas posicionales aportan 0 puntos de exactitud
(89,6 % frente a 89,6 % con el OCR de producción; 98,7 % frente a 98,7 % con PP-OCRv6). El A/B
pareado de la interpretación no cambia ninguna decisión: placa correcta 74/77 en ambas,
confirmada y errónea 1/77 en ambas, McNemar 0 frente a 0 (§3.4 del método). La corrección de las
motos se demuestra con pruebas unitarias, porque el conjunto real no tiene motos.

**Estados de una lectura** (lo que ve el operador):

| Estado | Dónde se ve | Significado |
|---|---|---|
| Detectada | HUD ámbar "ESCANEANDO OCR" | Placa localizada y seguida, sin lectura todavía |
| Provisional | HUD ámbar con texto parcial o verde con porcentaje | Lecturas rápidas del consenso; aún no hay registro |
| Confirmada | Insignia AUTORIZADO / NO REGISTRADO / ALERTA | Registrada con lectura válida (E1–E5) y decidida por el backend |
| Incierta | Insignia POR CONFIRMAR; detalle con los motivos y el texto crudo | Registrada sin todas las evidencias (p. ej. caracteres inferidos o lectores en desacuerdo): la confirma el personal |
| Ilegible | Auditoría de descartes / pendiente de validación | Sin placa legible tras los reintentos |

## 3. Riesgos que permanecen

- **Umbral de confianza para registrar (no adoptado).** En Open Images, exigir más confianza del
  detector reduce las detecciones sin placa pero pierde placas reales (por foto): 0,30 → 82,3 % de
  las placas (−1,3 puntos) y −31 % de falsas; 0,40 → 80,5 % y −55 %; 0,50 → 77,0 % y −71 %. Exigir
  que la placa esté sobre un vehículo detectado cuesta 1 punto y solo quita el 6 % de las falsas
  (allí casi todas están sobre vehículos), e impediría las pruebas con placas en la mano. Queda como
  decisión de operación (`docs/resultados/evidencia_placa_openimages.json`).

- **Errores correlacionados de los dos lectores.** En 1 de 77 recortes ambos modelos leyeron
  "PSY585" por "PSY589" sin ninguna sustitución; E4 y E5 no lo detectan. Lo mitigan el consenso de
  varios cuadros (no simulado en el A/B por foto) y el segundo factor (marca, color y tipo del
  vehículo frente a los registrados).
- **Contención de CPU durante el registro.** Con el registro en curso, el detector pasa de una
  mediana de ≈ 99 ms aislado a 232 ms (p95 706 ms), porque el OCR profundo, el verificador y CLIP
  compiten por los núcleos; la frecuencia de análisis cae a 2–5 cuadros por segundo. Una GPU o un
  equipo con más núcleos es la mejora esperada, pero no se ha medido.
- **Un solo canal por motor.** El motor analiza una cámara a la vez; varias garitas requieren
  varias instancias.

## 4. Latencia medida (cámara simulada, CPU)

Escena de la cámara Hikvision simulada (H.265 1080p a 25 fps, cuatro pasos de PSY589), motor de
producción en el portátil de desarrollo, sin otra carga. Seis corridas de `scripts/evaluar_secuencias.py`
con la configuración de producción; la ventana anti-duplicados se redujo a 0,5 s solo para que cada
paso de la escena se registre (n = 20 pasos), lo que agrega registros repetidos y hace las cifras
algo pesimistas.

| Medida | Resultado |
|---|---|
| Edad del cuadro al analizarlo | p50 15–29 ms; p95 39–59 ms por corrida |
| Captura → lectura en el HUD | p50 0,50–1,14 s; p95 0,92–1,73 s por corrida |
| Captura → registro del paso | p50 1,90 s; p95 4,24 s; máx. 4,59 s (n = 20) |
| Cuadros analizados | 3,8 por segundo (mediana; 1,3–4,2); 84–95 % de los recibidos se descartan por diseño |
| Detector por cuadro | p50 240–304 ms; p95 679–902 ms (aislado ≈ 99 ms) |
| Pasos leídos exactamente de punta a punta | 20/24; lecturas válidas 29/31 |

Una corrida de las seis fue anómala (1,3 cuadros por segundo, detector p50 793 ms) y se incluye.
La cola del registro la fija el análisis del vehículo (CLIP), no el verificador: p50 1,2–2,5 s y
máximo 3,5 s, frente a 0,4–1,2 s del verificador.

**A/B de configuración** (`scripts/resumir_ab_tiempo_real.py`, tres réplicas por brazo en orden
alternado):

| Cambio | Resultado | Decisión |
|---|---|---|
| Tope de espera del verificador (sin tope frente a 2 s, contado desde la cola) | Registro p50 1,95 → 1,81 s, p95 3,38 → 2,83 s; mediana pareada −0,15 s, prueba de signos p = 0,75 (10 pares); el tope casi no se activó porque el verificador no pasó de 2 s en esta escena | Se adopta, contado desde el inicio de la lectura: por construcción solo deja de esperar lecturas que se descartarían; acota el peor caso observado (4,0 s) |
| `TORCH_THREADS` 4 frente a 8 | Detector p50 240–297 frente a 241–255 ms; registro p50 2,37 frente a 2,11 s, mediana pareada −0,14 s, p = 0,73 (8 pares); cuadros analizados sin diferencia | Se mantiene 4: sin mejora demostrada |

**Registro en menos de 1 s (2026-10-13).** A pedido del responsable del sistema, el registro ya
no espera al análisis del vehículo y espera al verificador solo hasta 1 s desde la foto; lo que
llega después se reevalúa con las mismas reglas (método §2.5). A/B pareado del mismo día, tres
réplicas por brazo en orden alternado (`docs/resultados/registro_rapido_2026-10-13.json`; el equipo
analizaba 8–9 cuadros por segundo, más que en las mediciones del día anterior, así que solo se
comparan entre sí):

| | A · el registro espera a todo | B · registro en 1 s y reevaluación |
|---|---|---|
| Captura → registro: p50 / p95 / máx. | 0,73 / 1,43 / 1,43 s | 0,77 / 0,89 / 0,89 s |
| Pasos registrados en menos de 1 s | 7/12 (58 %; IC95 32–81 %) | 12/12 (100 %; IC95 76–100 %) |
| Captura → decisión final: p50 / p95 | 0,73 / 1,43 s | 0,77 / 1,58 s (7 pasos reevaluados) |
| Lecturas válidas · pasos exactos | 13/13 · 12/12 | 12/12 · 12/12 |
| Cuadros analizados por segundo | 9,3 · 8,4 · 9,1 | 8,4 · 7,9 · 8,4 |

El registro queda siempre por debajo de 1 s y la decisión final llega como antes; la mediana casi
no cambia porque los pasos que ya eran rápidos siguen igual (mediana pareada −0,13 s, prueba de
signos p = 0,39, 12 pares). Costo observado: 0,5–0,9 cuadros por segundo menos en las tres réplicas
(detector p50 169–175 frente a 152–171 ms), sin efecto en la exactitud ni en la lectura en vivo (p50
303–354 frente a 245–347 ms). Riesgo aceptado: un paso autorizado en el primer segundo puede pasar
a POR CONFIRMAR si después el vehículo no coincide con el registrado (R4); se avisa del cambio.

## 5. Configuración y calibración por cámara

1. **Zonas:** dibujar el área de detección sobre el carril (más lejos de lo que se cree: el recorte
   mejora sobre todo las placas pequeñas, 37,9 % → 47,5 % en Open Images) y excluir árboles,
   banderas, reflejos y la vía contraria.
2. **Encuadre:** la placa debe ocupar al menos el 3 % del ancho del cuadro en el punto de lectura:
   por debajo, el detector encuentra solo el 38–48 % de las placas, frente al 91–92 % entre el 3 y
   el 8 % (Open Images, §3.3 del método).
3. **Obturación:** 1/500 s o más rápida a 10 km/h y 1/1000 s a 20 km/h; un desenfoque de más de
   ≈ 6 px degrada la lectura (§3.2 del método y CAMARA_HIKVISION_ANPR.md).
4. **Flujos:** principal para el motor (H.265 o H.264, 1080p, 25 fps, GOP ≤ 2 s, sin B-frames);
   secundario para la vista en vivo.
5. **Validación en sitio:** grabar 30–60 min por condición (día, noche, lluvia) con
   `ffmpeg -c copy`, etiquetar y evaluar con `scripts/evaluar_secuencias.py` según
   [PROTOCOLO_EVALUACION_SECUENCIAS.md](PROTOCOLO_EVALUACION_SECUENCIAS.md) antes de activar la
   autorización automática.
