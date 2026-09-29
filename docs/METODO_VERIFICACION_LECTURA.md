# Verificación geométrica y validez de la lectura (método para la publicación)

Este documento describe la etapa de verificación que se agregó entre el detector de placas
y la decisión de acceso, inspirada en la arquitectura de OpenALPR
(<https://github.com/openalpr/openalpr>) y en el comportamiento de su producto comercial
Rekor Scout. Incluye el protocolo para evaluarla (ablación) con los datos que el sistema ya
registra.

Código: `services/anpr/app/core/verificacion_placa.py` (análisis y veredicto),
`services/anpr/app/core/detector.py` (integración en el seguimiento),
`services/anpr/app/main.py` (`_verify_and_commit`) y
`backend/src/routes/detecciones.ts` (`/completar-ocr`, regla de decisión).

## 1. Problema

Un detector de una sola etapa (YOLOv8n entrenado para placas) propone regiones con
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

Solo se dibuja una región cuando se comprobó que es una placa: fila de caracteres válida
(5–9 caracteres) en algún cuadro del track, o al menos dos lecturas OCR con formato ANT en
cuadros distintos. El resto de candidatos se sigue rastreando y leyendo, pero no se
muestra. La figura es el cuadrilátero de `_bordes_placa` (no la caja del detector) y su
color es el estado decidido por el backend (autorizado, por confirmar, no registrado,
alerta).

### 2.2 Validez de la lectura

`evaluar_lectura` declara **válida** una lectura cuando se cumplen todas las evidencias:

- **E1 · Formato:** la placa corresponde a un formato ANT vigente.
- **E2 · Placa completa:** la caja no toca el borde del cuadro, lo que descarta lecturas truncadas.
- **E3 · Geometría:** hay una fila de caracteres válida en el mejor cuadro del track. Un consenso fuerte (≥ 3 cuadros y ambos OCR de acuerdo) puede sustituir esta evidencia, porque con inclinación extrema los caracteres se funden con el marco.
- **E4 · Confirmación:** hay ≥ 2 lecturas idénticas en cuadros distintos, o el segundo OCR coincide exactamente. La lectura profunda y el verificador sobre el mismo cuadro cuentan como un solo cuadro.

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
