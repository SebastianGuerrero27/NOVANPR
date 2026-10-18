# Cámara Hikvision DS-2CD1123G0E-I en el sistema ANPR · integración y paso a producción

Guía para conectar una cámara IP Hikvision (H.265+/H.265/H.264) al sistema y operarla como un
sistema ANPR profesional: estado del arte en el que se apoya cada decisión, arquitectura
implementada, configuración recomendada de la cámara, validación de punta a punta y lista de
verificación para el despliegue en el ECU 911.

## 1. Resumen

| Problema | Causa | Solución implementada |
|---|---|---|
| El navegador no muestra una cámara en H.265 | WebRTC solo reproduce H.265 en algunos navegadores y con decodificación por hardware (§2.5); MediaMTX 1.6 no lo servía | **Doble flujo**: el motor analiza el principal (101, 1080p, H.265 o H.264) y el navegador muestra el secundario (102, H.264 640×360). MediaMTX actualizado a 1.21.1 |
| Contraseñas RTSP en claro en la base | Se guardaba la URL completa | **AES-256-GCM** de la contraseña dentro de la URL, con rotación de clave (§3.3) |
| Una contraseña con `@ : / #` rompía la URL | Sin codificación | El formulario codifica usuario y contraseña (`encodeURIComponent`) y la sonda, MediaMTX y el motor los decodifican |
| La sonda decía «contraseña incorrecta» con la contraseña correcta | Hikvision anuncia Digest y Basic y se respondía al último (Basic); además la respuesta Digest iba por otra conexión TCP y el nonce de MediaMTX y de muchas cámaras solo vale en la suya | La sonda conserva todos los desafíos, prefiere Digest (con `qop=auth` y `opaque`, RFC 2617) y responde por la misma conexión; espera hasta 6 s el 401 demorado de una contraseña incorrecta |
| El motor podía quedar bloqueado si la cámara dejaba de enviar sin cerrar la sesión | La opción `stimeout` de FFmpeg ya no existe (§2.8) y se ignoraba | Límites de espera de OpenCV al abrir y leer, vigilante de estancamiento y reconexión con espera creciente |
| No se veía la salud del enlace | — | El motor informa códec, resolución, cuadros recibidos y reconexiones; se muestra en Monitoreo |
| Con la cámara caída, Monitoreo seguía diciendo «conectada» y mostraba ~100–190 fps | Los cuadros por segundo se medían con el último intervalo, contaban cuadros repetidos y quedaban congelados al dejar de llegar | Ventana deslizante de 2 s solo con cuadros nuevos (`TasaCuadros`): baja a 0 y el estado pasa a desconectado a los 2–3 s |

## 2. Estado del arte

### 2.1 Calidad del video comprimido y reconocimiento de placas

Ukhanova et al. (2014) midieron el efecto de la compresión H.264/AVC y H.265/HEVC sobre un
sistema ANPR: la tasa de reconocimiento depende de la calidad del video según una **función
logística**, igual que el reconocimiento humano. Por debajo de un umbral de tasa de bits la
lectura cae bruscamente; por encima, más tasa de bits casi no mejora. Para el mismo nivel de
reconocimiento, HEVC necesita menos tasa de bits que AVC. Consecuencia práctica: la tasa del flujo
que analiza el motor debe quedar en la meseta de la curva (CBR suficiente, §4), y el flujo del
navegador puede ser mucho más liviano, porque nadie lee placas sobre él.

### 2.2 Redundancia temporal

Laroca et al. (2018) muestran que en video la lectura final debe combinar todos los cuadros del
mismo vehículo (voto por mayoría por posición de carácter): sube la tasa de acierto de forma
notable frente a la lectura de un solo cuadro. El motor sigue cada placa con un *tracker*, lee
varias veces por pista y confirma con un verificador (ver
[METODO_VERIFICACION_LECTURA.md](METODO_VERIFICACION_LECTURA.md)). Por eso importa más recibir
**todos los cuadros sin pérdidas ni atrasos** (transporte TCP, último cuadro siempre disponible)
que una resolución mayor a 1080p.

### 2.3 Estándares operativos de ANPR

El Reino Unido mantiene el estándar público más detallado para ANPR policial, NASPLE (National
ANPR Standards for Policing and Law Enforcement). Sirve como referencia de aceptación:

- Cámara fija: capturar el **98 %** de las placas que cumplen la norma de reflectividad y leer
  correctamente el **95 %** de las capturadas (§9.7). Integrada a CCTV (cámara de vigilancia
  general, como esta): 85 % de captura y 95 % de lectura correcta.
- Sincronización horaria al menos **cada 10 minutos** (§8.3).
- De la lectura a la alarma, **4 s o menos** (§9.11).
- Recorte de la placa obligatorio como evidencia; la imagen general es opcional (§8.4.5).

### 2.4 Transporte desde la cámara

- RTSP 1.0 (RFC 2326) con RTP sobre TCP intercalado: sin pérdida de paquetes y sin artefactos
  (un paquete perdido en UDP corrompe hasta el siguiente cuadro clave, justo lo que el OCR no
  tolera). Cargas útiles RTP: H.264 (RFC 6184) y H.265 (RFC 7798).
- Autenticación Digest (RFC 2617; RFC 7616 la actualiza). Las Hikvision traen por omisión
  «autenticación RTSP: digest» y rechazan Basic aunque lo anuncien.
- **Una sola sesión por flujo** contra la cámara: las cámaras de gama básica admiten pocas
  conexiones simultáneas. MediaMTX abre la cámara una vez y reparte el flujo al motor y a todos
  los visores.

### 2.5 Del servidor al navegador: WebRTC y WHEP

- WebRTC entrega el video con retardo de cientos de milisegundos, sin complementos. La
  señalización estándar para reproducir es **WHEP** (draft-ietf-wish-whep-04, junio de 2026, en
  *last call* del grupo de trabajo; aún no es RFC). Su par para publicar, WHIP, ya es RFC 9725.
  MediaMTX, Cloudflare, Janus, LiveKit y otros implementan WHEP en producción.
- **H.265 en WebRTC depende del navegador:** Chrome 136 o posterior lo recibe solo con
  decodificación por hardware (no trae decodificador por software); Safari lo reproduce; Edge
  retiró el anuncio; Firefox no lo soporta. La documentación de MediaMTX lo advierte y recomienda
  H.264 para compatibilidad amplia.
- WebRTC no admite B-frames: ningún navegador los reproduce. Las cámaras de vigilancia
  normalmente no los usan; en la cámara, el perfil Baseline o Main sin B-frames es seguro.

### 2.6 Doble flujo: análisis en el principal, vista en el secundario

Los NVR y los sistemas de gestión de video separan grabación y análisis (flujo principal) de la
vista en vivo (flujo secundario). Para ANPR la separación es todavía más valiosa:

- El motor recibe la máxima resolución y calidad (§2.1) sin depender de qué decodifica el
  navegador; puede ser H.265, que reduce la tasa de bits en la red de cámaras.
- El navegador recibe H.264 de 640×360 (~0,5 Mb/s): funciona en cualquier navegador, en
  computadoras sin GPU y en enlaces lentos de un centro de monitoreo.
- Las cajas de detección viajan aparte (JSON por WebSocket) en coordenadas normalizadas (0–1):
  se dibujan igual sobre cualquiera de los dos flujos. Si el secundario tiene otra proporción
  (640×480 de un sensor 16:9), la cámara lo escala sin recortar y el visor lo muestra con la
  proporción del principal.

### 2.7 Códecs «inteligentes» (H.265+ / H.264+)

H.265+ y H.264+ son variantes propietarias que bajan la tasa de bits con un intervalo de cuadros
clave muy largo y variable (la cámara lo administra; la opción queda deshabilitada). Para un
receptor de terceros esto significa que, tras conectarse o reconectarse, no hay imagen
decodificable hasta el siguiente cuadro clave, que puede tardar varios segundos. Además aparecen
artefactos durante el movimiento, justo cuando pasa el vehículo. La práctica recomendada en
integraciones es usar **H.265 o H.264 estándar** con un intervalo de cuadros clave fijo.

### 2.8 Lectura RTSP robusta en el motor

- FFmpeg renombró en abril de 2021 la opción RTSP `stimeout` a `timeout` (límite de E/S del
  socket en microsegundos) y eliminó la antigua. OpenCV 4.11 trae FFmpeg 5.1: la opción vieja se
  ignoraba en silencio y una cámara que deja de enviar sin cerrar la sesión bloqueaba la lectura
  para siempre.
- OpenCV (≥ 4.5) ofrece `CAP_PROP_OPEN_TIMEOUT_MSEC` y `CAP_PROP_READ_TIMEOUT_MSEC` para el
  backend FFmpeg. No dependen del nombre de la opción en cada versión de FFmpeg.
- Patrón de último cuadro: un hilo drena el flujo y conserva solo el cuadro más reciente; el
  análisis nunca procesa cuadros atrasados, aunque una inferencia tarde más que un intervalo
  entre cuadros.

## 3. Arquitectura implementada

```
                    RTSP/TCP + Digest (una sesión por flujo, bajo demanda)
 Cámara Hikvision ───────────────────────────────────────────▶ MediaMTX 1.21
   101 principal H.265/H.264 1080p                               │
   102 secundario H.264 640×360                                  │
                                                                 ├─ cam_<id> ──RTSP interno (token de servicio)──▶ Motor ANPR
                                                                 │                 (detección + tracker + OCR sobre 1080p)
                                                                 │
                                                                 └─ cam_<id>_vista ──WebRTC/WHEP (ticket 60 s)──▶ Navegador
                                                                                     + cajas JSON por WebSocket del motor
 Backend: guarda las URL con la contraseña cifrada, crea las rutas de MediaMTX por su API
          (URL descifrada solo en memoria) y autoriza cada lectura (/api/medios/autorizar).
```

 Cada cámara tiene una dirección (`ingreso` o `salida`, migración v13), copiada en el evento al
 registrarse. Una salida se almacena como movimiento independiente: no consulta las listas de
 autorización ni altera el ingreso del mismo vehículo.

 **Límite de procesamiento vigente:** el servicio ANPR compone una sola instancia `MotorAnpr` y
 `camaraMotor` asigna una cámara activa a ese motor. La Vista cuadrícula de 1, 2 o 4 celdas reproduce
 flujos, pero no equivale a varios procesos ANPR; solo la cámara activa genera pistas, OCR y
 decisiones. Por ello el HUD se conecta únicamente al flujo de esa cámara. No se debe anunciar
 procesamiento simultáneo ni capacidad para cientos de cámaras hasta desplegar workers aislados
 por cámara y superar pruebas de carga en el hardware objetivo.

 ### 3.1 Flujo de vista

- Columna `Camaras.rtsp_url_vista` (migración v9). Vacía: la vista usa el principal (cámaras
  sin secundario, celulares).
- El formulario de Hikvision y Dahua arma el enlace del secundario con el mismo equipo y las
  mismas credenciales: `/Streaming/Channels/<canal>01` → `<canal>02` y `subtype=0` → `subtype=1`.
  Viene activado en las cámaras nuevas.
- **Ping** prueba los dos flujos; **Play** reproduce cualquiera de los dos. Monitoreo, el editor
  del área de interés y la reproducción de prueba usan el secundario si existe.
- MediaMTX abre el secundario solo mientras alguien lo mira (`sourceOnDemand`); el principal
  queda abierto porque el motor siempre lo lee.

### 3.2 Lectura en el motor

`RTSPSource` (`services/anpr/app/infraestructura/video_source.py`):

- límite de 8 s para abrir y de 5 s para leer;
- vigilante que reconecta si pasan 5 s sin cuadros;
- reconexión con espera creciente (1,5 s, 3 s, 6 s… hasta 10 s);
- nunca entrega un cuadro anterior a la caída;
- informa códec, resolución, cuadros recibidos por segundo, reconexiones y antigüedad del último
  cuadro (`/status` → `enlace_video`, visible en Monitoreo).

### 3.3 Custodia de credenciales

- La contraseña se cifra con AES-256-GCM (IV aleatorio de 96 bits y etiqueta de autenticación)
  dentro de la propia URL: `rtsp://admin:enc.v1.<iv>.<cifrado+etiqueta>@host/ruta`. Usuario, host
  y ruta quedan legibles para la auditoría; la API sigue enmascarando la contraseña.
- Se descifra solo en memoria: para crear las rutas de MediaMTX, para la sonda de diagnóstico y
  para el monitor de conectividad. MediaMTX nunca recibe la contraseña por archivo
  (`mediamtx.yml` no tiene credenciales de cámaras).
- Clave vigente: `CAMARAS_CLAVE_CIFRADO` (32 bytes en base64, `openssl rand -base64 32`). Sin
  ella se deriva de `JWT_SECRET` con HKDF-SHA256 y el backend lo avisa en el registro.
- **Rotación:** copie la clave actual a `CAMARAS_CLAVE_CIFRADO_ANTERIOR` (admite varias,
  separadas por coma), ponga una nueva en `CAMARAS_CLAVE_CIFRADO` y reinicie. Al arrancar, el
  backend vuelve a cifrar todas las contraseñas con la nueva y en el siguiente despliegue ya se
  puede quitar la anterior. Pasar de la clave derivada a una propia no requiere nada más: la
  derivada se sigue aceptando para descifrar.
- Una contraseña que ninguna clave descifra no impide el arranque: se avisa en el registro y hay
  que volver a escribirla en el formulario.

## 4. Configuración recomendada de la cámara

Menú web de la cámara (Configuración › …). Los valores salen de §2 y de las mediciones del
proyecto (METODO §3.2).

| Parámetro | Principal (101) · motor | Secundario (102) · navegador |
|---|---|---|
| Códec | **H.265** o H.264, **sin «+»** (§2.7) | **H.264** |
| Perfil | Main | Main o Baseline (sin B-frames) |
| Resolución | 1920×1080 | **640×360** (misma proporción 16:9) |
| Cuadros por segundo | 30 (ver «Frecuencia de red») | 15–25 |
| Intervalo de cuadro clave (I-frame) | igual a los fps (1 s), máximo el doble | igual a los fps |
| Tasa de bits | **CBR** 4 096 kb/s en H.265 (6 144 kb/s en H.264), calidad máxima | CBR 512–768 kb/s |
| SVC | Desactivado | Desactivado |

**Imagen (Configuración › Imagen):**

- **Frecuencia de red: 60 Hz.** Ecuador usa 60 Hz: evita el parpadeo con la iluminación
  artificial de la garita y fija 30 fps.
- **Exposición manual con obturación rápida.** El desenfoque horizontal que el OCR tolera es de
  3–6 px (METODO §3.2: por encima de ~6 px la lectura se degrada y ningún paso posterior la
  recupera). Con la placa a ~180 px de ancho (450 px por metro para una placa de ~40 cm), un
  vehículo a 10 km/h recorre ~1 250 px/s en la imagen: se necesita **1/500 s** o menos. A 20 km/h,
  **1/1000 s**. Esta cámara admite hasta 1/100 000 s; la ganancia sube de noche, así que conviene
  iluminación IR o luz blanca dirigida.
- **Contraluz (BLC/HLC):** HLC atenúa los faros de noche; la placa retrorreflectiva con IR
  puede saturar, así que se ajusta el IR inteligente o la ganancia. La DS-2CD1123G0E-I tiene WDR
  solo digital: evite encuadres con cielo o sol de frente.
- **Hora:** NTP (servidor del ECU 911), intervalo de 10 minutos o menos (NASPLE §8.3).

**Instalación: píxeles sobre la placa.** Las mediciones del motor se hicieron con placas de
~180 px de ancho; con menos no se ha medido. Ancho de escena que cubre la cámara a la distancia
de la placa: `1920 px × 0,40 m / 180 px ≈ 4,3 m`. Distancia máxima cámara–placa:
`d = 4,3 m / (2·tan(FOVh/2))`.

| Lente | FOV horizontal (ficha) | Distancia máxima para ~180 px de placa |
|---|---|---|
| 2,8 mm | 114,8° | ≈ 1,4 m |
| 4 mm | 86° | ≈ 2,3 m |

La DS-2CD1123G0E-I es una cámara de vigilancia gran angular, no una cámara ANPR: sirve para un
acceso controlado donde el vehículo se detiene o pasa despacio cerca de la cámara (garita, plumilla).
Para carriles a 5–15 m o vehículos a velocidad de vía se necesita un lente varifocal o
teleobjetivo (o una cámara ANPR dedicada con obturación de 1/1000 s o menos e IR sincronizado).

**Seguridad de la cámara:**

- Usuario propio para el sistema, con permiso solo de vista en vivo; nunca `admin`.
- **Verifique la contraseña con Ping antes de guardar.** Con una contraseña incorrecta, MediaMTX
  reintenta cada vez que el motor pide el video y el monitor de conectividad prueba cada
  `CAMARAS_INTERVALO_S`; el bloqueo de Hikvision por inicios de sesión ilegales (Configuración ›
  Sistema › Seguridad; número de intentos y duración configurables) puede bloquear la IP del
  servidor, y con ella también la conexión buena.
- Autenticación RTSP **digest** (Configuración › Sistema › Seguridad › Autenticación).
- Desactive UPnP, Hik-Connect/P2P y los servicios que no use; firmware al día.
- Cámaras en una VLAN propia, con el puerto 554 accesible solo desde el servidor de MediaMTX.

## 5. Alta en el sistema

1. Administración › Cámaras › Registrar cámara › tipo **Cámara Hikvision**.
2. Elija la dirección de la cámara (**Ingreso** o **Salida**), luego IP, puerto 554 y ruta
   `/Streaming/Channels/101` (canal 1). Usuario y contraseña son opcionales si el equipo permite
   RTSP anónimo; cuando se requieren, la contraseña puede tener símbolos y se codifica sola.
3. Deje marcada **Vista en vivo por el flujo secundario**: se genera
   `/Streaming/Channels/102` con las mismas credenciales.
4. **Ping**: debe responder el principal (DESCRIBE con Digest) y el aviso del secundario debe
   decir «entrega video». **Play**: compruebe los dos flujos. Si el secundario llega en H.265,
   cámbielo a H.264 en la cámara.
5. Guardar. En Monitoreo, seleccione **Vista cuadrícula** y arrastre las cámaras desde el menú
   lateral a las celdas. Puede mostrar 1, 2 o 4 cámaras; las asignaciones y la cantidad elegida se
   conservan entre sesiones. Para asignar el análisis ANPR, use el selector **Cámara que procesa el
   motor** en la vista ANPR; la cuadrícula por sí sola solo visualiza video.

## 6. Validación de punta a punta

No se dispuso de la cámara física. La prueba usa una **cámara Hikvision simulada** que reproduce lo
que ve el sistema en la red: un servidor RTSP (MediaMTX 1.21 con FFmpeg) en el puerto 554, con
autenticación Digest, usuario `admin` con contraseña con símbolos (`Ecu911@Garita#26`) y las rutas
`/Streaming/Channels/101` (H.265 Main 1920×1080, 25 fps, GOP 25, sin B-frames, ~4 Mb/s) y `/102`
(H.264 Main 640×360, ~0,5 Mb/s). La escena son 4 capturas reales de ingresos que entran, se detienen
1,6 s y salen (18,4 s, en bucle).

```bash
bash backend/scripts/camara_hikvision_simulada/e2e.sh   # con el sistema en ejecución (Docker Compose)
```

Resultado (2026-10-08, portátil de desarrollo, motor en CPU), todas las verificaciones en verde:

| Verificación | Resultado |
|---|---|
| Alta con contraseña con `@` y `#` (codificada en la URL) | HTTP 201; la API devuelve ambas URL enmascaradas |
| Contraseña en la base | cifrada (`enc.v1…`) en el principal y en el secundario; nunca en claro |
| Diagnóstico Digest del principal y del secundario | «Flujo de video disponible» en 16–139 ms |
| Contraseña incorrecta / sin usuario | «credenciales inválidas» (0,7–3,3 s, por el 401 demorado) / «requiere credenciales» |
| Edición sin volver a escribir la contraseña | se conserva y la cámara sigue conectando |
| Flujos servidos por MediaMTX (leídos con `ffprobe`) | `cam_<id>`: HEVC Main 1920×1080; `cam_<id>_vista`: H.264 Main 640×360, sin B-frames |
| Motor asignado → primer cuadro | 1,3–8,7 s (6 corridas; incluye abrir la cámara bajo demanda) |
| Enlace del motor en régimen | H.265 1920×1080, **24,4–25,4 fps recibidos** (la cámara envía 25), sin reconexiones |
| Lecturas en ~95 s de escena | 3 registros de PSY589 con confianza 1,00 (la misma placa se repite en la escena y el sistema no la vuelve a registrar dentro de su ventana de repetición) |
| Autorización WebRTC (WHEP) con MediaMTX 1.21 | sin ticket → 401; ticket inválido → 401; ticket válido → autorizado |
| Corte de red de 15 s | estado «desconectada» y 0 fps a los 2–3 s del corte |
| Recuperación tras volver la red | mediana **7,3 s** (5,6 · 12,7 · 7,5 · 7,1 s; n = 4) |

**Recuperación tras un corte.** El tiempo lo dominan MediaMTX y la cámara, no el motor:

- MediaMTX detecta la caída cuando vence su límite de lectura (~10 s).
- Al volver la red, la conexión de la fuente tarda ~4 s en la cámara simulada (también al conectar
  por primera vez).
- Justo después de la reconexión, el DNS de Docker puede fallar una vez y sumar unos 5 s (el ciclo
  de 12,7 s).

Se probó acortar la espera entre reintentos del motor (de 1,5→10 s a 1→2 s): mediana 6,3 s
(5,4 · 11,3 · 7,0 · 5,5 s). La diferencia (~1 s) queda dentro de la variación entre ciclos, así que no
se adoptó. Una Hikvision real responde la autenticación sin la demora de la simulada; la cifra de
campo debe medirse con la cámara física.

**Imagen definitiva del motor (PyTorch solo CPU, dependencias bloqueadas).** Se comparó con la
imagen anterior (rueda CUDA, 16,9 GB → 8,8 GB) con el mismo código y modelos
(`services/anpr/scripts/equivalencia_imagen.py`; resultado en
`docs/resultados/imagen_cpu_equivalencia.json`):

- Salidas en las 107 capturas reales: **idénticas** (mismas cajas, IoU 1,0; mismos textos y
  confianzas del OCR, del verificador y de los atributos del vehículo).
- Tiempos del detector y de CLIP, 8 rondas pareadas alternando el orden: sin diferencia
  significativa (Wilcoxon W = 12 y 13, crítico 3).
- Motor completo (`scripts/evaluar_latencia.py`, 2 rondas pareadas): misma exactitud (10/12
  registradas, 10 correctas) y misma latencia mediana (1254 / 1353 ms frente a 1300 / 1214 ms).
- La prueba de punta a punta repetida con las imágenes definitivas pasó completa: primer cuadro a
  1,9 s, 25 fps recibidos y recuperación en 6 s tras el corte.

Los tiempos absolutos de este portátil cambian hasta 2× a lo largo del día (el detector midió
52 ms en la mañana y 78–117 ms en la noche con la misma imagen): toda comparación de velocidad debe
ser pareada.

**Limitaciones de esta validación.**

- No sustituye la prueba de campo: compresión, iluminación, distancia y velocidad reales cambian la
  tasa de lectura.
- La reproducción en el navegador (WebRTC) se verificó hasta la autorización y el códec servido, no
  con un navegador automatizado.
- Las lecturas confirman que el motor reconoce sobre H.265 1080p, no son una medida de exactitud
  (para eso, METODO §3).

## 7. Lista de verificación para producción (ECU 911)

**Secretos y configuración**

- [ ] `CAMARAS_CLAVE_CIFRADO` propia en el secreto `anpr-secrets` (y en el gestor de secretos
      institucional, con respaldo: si se pierde hay que volver a escribir las contraseñas). En el
      entorno local ya está en `.env` (2026-10-08); producción necesita la suya.
- [x] Ningún `.env` dentro de las imágenes: `.dockerignore` del motor y del backend los excluyen
      (el `Dockerfile.prod` del backend ya usaba lista blanca).
- [ ] `JWT_SECRET`, `ANPR_SERVICE_TOKEN` y `MEDIA_SECRET` largos y distintos por entorno.
- [ ] `WEBRTC_PUBLIC_URL` y `WEBRTC_HOSTS` con la dirección que ven los puestos de monitoreo
      (o un servidor TURN si hay NAT entre el centro y el servidor).

**Cámara**

- [ ] Principal H.265 o H.264 sin «+», 1080p, I-frame = fps, CBR (§4).
- [ ] Secundario H.264 640×360 sin B-frames.
- [ ] 60 Hz, obturación de 1/500 s o menos, NTP.
- [ ] Usuario de solo vista, autenticación digest, UPnP y P2P desactivados, VLAN de cámaras.
- [ ] Encuadre con la placa de ~180 px de ancho o más (§4).

**Plataforma**

- [ ] MediaMTX 1.21.1 (imagen fijada, no `latest`), API y RTSP sin publicar fuera del clúster.
- [x] Motor sin `--reload`: el `CMD` de la imagen es de producción y solo `docker-compose.yml`
      (desarrollo) agrega la recarga.
- [x] Dependencias del motor fijadas en `services/anpr/requirements.txt` (versiones exactas de la
      imagen validada, que instalan la imagen y el CI y analiza Trivy; las directas, con rangos, en
      `requirements.in`). PyTorch solo CPU, un solo OpenCV
      (4.11.0.86 en `opencv-python` y `opencv-python-headless`), base `python:3.12.15-slim-trixie`
      y `YOLO_AUTOINSTALL=false` (Ultralytics no instala paquetes en ejecución).
- [x] Sin telemetría de terceros: Ultralytics envía por omisión un evento de uso anónimo al terminar
      cada predicción; la imagen lo desactiva con `YOLO_OFFLINE=true` (tampoco comprueba versiones
      ni descarga pesos: todos van en la imagen).
- [ ] Migración v9 aplicada (el backend la aplica al arrancar) y registro sin el aviso «se deriva
      de JWT_SECRET».
- [ ] Monitoreo › enlace del motor: códec y resolución esperados, sin reconexiones en aumento.

**Aceptación (NASPLE §9.7 como referencia)**

- [ ] Prueba de campo con video real de la garita: captura ≥ 85 % (cámara de vigilancia
      integrada) o ≥ 98 % (cámara ANPR fija) y lectura correcta ≥ 95 % de lo capturado, de día y
      de noche.
- [ ] De la lectura a la alarma ≤ 4 s.

## 8. Limitaciones

- El servicio ANPR procesa una sola cámara activa; la Vista cuadrícula de hasta cuatro streams es
  solo de visualización. Cientos de cámaras requieren workers distribuidos, aislamiento de trackers
  y pruebas de capacidad (CPU/GPU) todavía no implementados.
- No se ha probado con la cámara física: la validación de §6 usa una cámara simulada que
  reproduce su comportamiento en la red (Digest, rutas, códecs, GOP). La prueba de campo de §7 es
  obligatoria antes de producción.
- Los números de tolerancia al desenfoque y de píxeles sobre la placa vienen de capturas fijas
  con desenfoque sintético (METODO §3.2), no de video comprimido real.
- La vista H.265 directa en el navegador depende del equipo del puesto de monitoreo (§2.5); con
  el secundario H.264 no hay esa dependencia.

## 9. Referencias

1. A. Ukhanova, J. Støttrup-Andersen, S. Forchhammer, J. Madsen. «Quality Assessment of
   Compressed Video for Automatic License Plate Recognition». VISAPP 2014, pp. 306–313.
   doi:10.5220/0004671203060313.
2. R. Laroca et al. «A Robust Real-Time Automatic License Plate Recognition Based on the YOLO
   Detector». IJCNN 2018. arXiv:1802.09567.
3. Home Office (Reino Unido). *National ANPR Standards for Policing and Law Enforcement (NASPLE)*,
   versión accesible en gov.uk (§8.3, §8.4.5, §9.7, §9.11).
4. IETF. *WebRTC-HTTP Egress Protocol (WHEP)*, draft-ietf-wish-whep-04 (junio de 2026).
   *WebRTC-HTTP Ingestion Protocol (WHIP)*, RFC 9725.
5. IETF. RFC 2326 (RTSP 1.0), RFC 7826 (RTSP 2.0), RFC 6184 (RTP H.264), RFC 7798 (RTP HEVC),
   RFC 2617 y RFC 7616 (autenticación Digest).
6. MediaMTX. Documentación: lectura por WebRTC y «Codec support in browsers» (H.265 solo con
   condiciones; sin B-frames). https://mediamtx.org/docs/
7. Chromium / discusión de MediaMTX #4396: H.265 en WebRTC desde Chrome 136, solo recepción con
   decodificación por hardware.
8. FFmpeg. «avformat/rtsp: Remove deprecated old options, rename stimeout->timeout», commit
   6f34f03 (abril de 2021).
9. OpenCV. *Flags for video I/O*: `CAP_PROP_OPEN_TIMEOUT_MSEC`, `CAP_PROP_READ_TIMEOUT_MSEC`.
10. Hikvision. Ficha técnica DS-2CD1123G0E-I: obturación 1/3–1/100 000 s; principal 1920×1080
    a 25/30 fps; secundario 640×480, 640×360 o 320×240; FOV horizontal 114,8° (2,8 mm) y 86° (4 mm).
