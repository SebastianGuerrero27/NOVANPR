# Sistema web · pantallas, roles y arquitectura

Frontend React 18 + Vite (sin frameworks de UI), backend Express/TypeScript y motor ANPR
FastAPI. Todos los datos que se muestran provienen de la base: no existen datos simulados ni
valores de relleno (un indicador sin registros vale cero y cada pantalla tiene su estado vacío).

## Roles

Tres roles desde la migración v6 (`OPERADOR` → `GUARDIA`, `GESTOR_ACCESOS` → `GESTOR_PERMISOS`; las
cuentas `SUPERVISOR` pasaron a Guardia por mínimo privilegio):

| Rol | Puede |
|---|---|
| **Guardia** | Inicio de su turno, monitoreo en vivo, registro de ingresos, validar/corregir lecturas, registro manual, consultar las listas y **solicitar autorizaciones**. Recibe el aviso de garita con protocolo y la notificación de cada permiso otorgado |
| **Gestor de permisos** | Una sola vista (*Gestión de permisos*): permisos de placa (categoría, vigencia, **franjas horarias**) y **resolución de solicitudes de acceso**. Sin monitoreo; solo se le notifica la llegada de los vehículos a los que dio permiso, las solicitudes nuevas y los permisos por vencer |
| **Administrador** | Todo: usuarios, cámaras y zonas, configuración, auditoría, lista negra, excepciones, reportes, evaluación, estado del sistema, eliminar ingresos, consulta de propietario (convenio) y alarmas escaladas |

La autorización es **por permisos** (matriz única en `backend/src/dominio/permisos.ts`, detalle en
[ROLES_Y_PERMISOS.md](ROLES_Y_PERMISOS.md)): la API exige `requierePermiso(...)` en cada endpoint y el
frontend arma el menú, las rutas y las acciones con `puede(...)` a partir de los permisos de la sesión.

## Pantallas

| Ruta | Pantalla |
|---|---|
| `/login`, `/registro`, `/configuracion-inicial`, `/verificar-email`, `/restablecer-password` | Acceso y ciclo de vida de la cuenta |
| `/` | Según el rol: **Dashboard** del administrador (tarjetas de estado del día, dona con la distribución de hoy, barras de los últimos 7 días y tabla de los **50 ingresos recientes** actualizada en tiempo real), *Gestión de permisos* del gestor (solicitudes, permisos de placa y accesos denegados recientes) o panel del guardia (su turno, ingresos por hora, cola de validación, últimas alertas, cámaras) |
| `/sistema` | **Estado del sistema** (Administrador): servicios, cuentas, accesos, listas de control, tendencia y exactitud de lectura (lo que antes ocupaba el inicio como "Administración del sistema") |
| `/monitoreo` | Video en vivo de las cámaras registradas (sin cámaras habilitadas: estado vacío con acceso al registro), último paso destacado, feed en tiempo real, aviso de alerta con sonido, consulta de placa, ingreso manual |
| `/detecciones` | Registro de ingresos paginado con filtros en la URL, exportación CSV |
| `/detecciones/:id` | Detalle: evidencia (foto del vehículo y recorte de la placa), lectura automática vs. confirmada, validez de la lectura (evidencias del motor, incluida la lectura directa de cada carácter y el texto leído por cada lector sin interpretar), condiciones de captura, pasos anteriores, trazabilidad, acciones |
| `/listas/autorizados`, `/listas/alertas` | Permisos de placa (categoría, vigencia desde/hasta, horario) y lista de alertas, con filtro de vigencia |
| `/solicitudes` | Solicitudes de acceso: crear, aprobar con ajustes de vigencia/horario, rechazar, cancelar |
| `/notificaciones` | Bandeja de alarmas (sin leer / pendientes de atención), activación de Web Push en el equipo y avisos que recibe el rol |
| `/reportes` | Reporte por período y cámara, impresión y exportación |
| `/evaluacion` | Métricas científicas del reconocimiento |
| `/usuarios`, `/auditoria`, `/camaras`, `/configuracion` | Administración (en Cámaras, **Zonas** dibuja sobre el video el área de detección y las zonas de exclusión) |
| `/perfil` | Datos propios y cambio de contraseña |

## Diseño de la interfaz

- **Colores institucionales del Centro de Control:** rojo ECU 911 (`#cc1925`), barra lateral carbón
  (`#23252a`) con el elemento activo en rojo oscuro (`#760e15`), fondo gris claro, esquinas casi
  rectas (4–8 px), encabezados de tabla en mayúsculas espaciadas y botones rojos con degradado. Los
  colores son variables CSS en `frontend/src/index.css`.
- **Densidad compacta por omisión:** texto base de 13 px (12,5 px en portátiles de 901–1400 px de
  ancho) sin `zoom` de CSS, que rompería la barra lateral de altura completa y la alineación de las
  cajas sobre el video.
- **Encabezado:** «SISTEMA ANPR · título de la pantalla», píldora de conexión en tiempo real, reloj
  de la sesión, sonido, campana de notificaciones, nombre del usuario y botón del rol con su menú.
  El botón de menú (☰) solo aparece en pantallas de hasta 900 px.
- **Barra de pestañas estilo IDE** bajo el encabezado (Dashboard, Monitoreo, Ingresos, Lista blanca,
  Lista negra, Solicitudes, Reportes, Cámaras, Usuarios), filtrada por los permisos de la sesión
  (`pestanasPara` en `plantilla/navegacion.tsx`); se oculta si el rol tiene una sola vista.
- **La placa se muestra con la foto real del recorte**, nunca dibujada: el componente `PlacaFoto`
  (`componentes/deteccion.tsx`) presenta el recorte que guardó el motor y, junto a él, la lectura del
  sistema en texto. Se usa en el dashboard, el detalle del ingreso, la alarma de acceso no
  autorizado, los avisos de acceso autorizado, los accesos denegados recientes y la confirmación de
  eliminación. Si el motor no pudo recortar la placa, la API repite en `imagen_placa` la foto del
  vehículo; `recortePlaca` lo detecta y la interfaz muestra «Sin recorte de la placa» en lugar de
  presentar la foto del vehículo como si fuera la placa. Donde no existe fotografía (listas,
  solicitudes, reportes) la placa aparece solo como texto.
- **Ventanas modales en el `<body>`** (`createPortal`): un ancestro con `backdrop-filter` (el
  encabezado) recortaba las ventanas de confirmación.

## Reconocimiento: cuadro de la placa y autorización automática

Cada placa en movimiento se dibuja desde que aparece y sigue al vehículo: ámbar con
"ESCANEANDO OCR" mientras se lee, verde con la placa al leerla y el color del estado cuando
el backend decide, con el cuadrilátero ajustado a sus bordes y la zona de movimiento (MOG2);
un objeto quieto solo se enmarca si hay evidencia de placa. Con la escena quieta el detector
descansa (compuerta de movimiento) y el OCR solo lee placas completas, no cortadas por el
borde. El administrador dibuja sobre el video de cada cámara el **área de detección** (el carril:
fuera de ella no se buscan placas, y el detector analiza solo ese recorte, con más detalle para las
placas lejanas) y las **zonas de exclusión** (árboles, banderas, reflejos, la vereda o la hora
sobreimpresa: ahí no cuenta el movimiento ni se buscan placas), de modo que el motor solo se activa
cuando entra un vehículo; el HUD las muestra. El HUD se dibuja sobre el video WebRTC con las coordenadas normalizadas del motor, dentro
del área visible de la imagen, de modo que sigue alineado al cambiar el tamaño del reproductor o
la proporción del flujo; en el modo compatibilidad las cajas llegan dibujadas en el JPEG. Cada lectura
lleva un veredicto de validez (formato, placa completa, fila de caracteres, consenso) que
decide si una placa del padrón se autoriza sola.
Método, regla de decisión y protocolo de evaluación: [METODO_VERIFICACION_LECTURA.md](METODO_VERIFICACION_LECTURA.md).

## Consumo de recursos

- **Carga diferida:** cada pantalla es un módulo aparte (2–8 kB gzip); el acceso no descarga el
  panel ni el video. Base común ≈ 93 kB gzip (React, router, axios, socket.io).
- **Tiempo real sin sondeo:** una sola conexión Socket.IO autenticada por sesión (salas
  `usuario:{id}` y `rol:{rol}`, adaptador Redis para varias instancias). Eventos:
  `deteccion:nueva | actualizada | alerta | eliminada`, `camara:estado | actualizada | eliminada`,
  `listas:actualizadas`, `monitoreo:camara`, `solicitudes:actualizadas`,
  `notificacion:nueva | actualizada`. Los paneles agrupan recargas (5 s) y, con la pestaña
  oculta, esperan a que vuelva a ser visible.
- **Centro de notificaciones:** bandeja persistente con reconocimiento (ACK), escalamiento y Web Push
  para la pestaña cerrada ([NOTIFICACIONES.md](NOTIFICACIONES.md)).
- **Video en vivo (WebRTC):** cámara → MediaMTX → navegador por WebRTC (WHEP), sin
  transcodificar: el H.264 de la cámara llega tal cual y el navegador lo decodifica por hardware,
  con búfer de reproducción mínimo. **Doble flujo:** si la cámara tiene flujo secundario
  (`rtsp_url_vista`, ruta `cam_<id>_vista`), el navegador muestra ese (H.264 640×360, ~0,5 Mb/s)
  y el motor analiza el principal (1080p, H.265 o H.264); ver
  [CAMARA_HIKVISION_ANPR.md](CAMARA_HIKVISION_ANPR.md). Retardo típico en red local: 0,2–0,5 s (se muestra en el
  visor). Las cajas de detección llegan aparte, como JSON (`/ws/pistas` del motor, ~10 envíos/s),
  y se dibujan sobre el video. El video se cierra al pausar u ocultar la pestaña.
- **Una sola conexión por cámara:** MediaMTX abre la cámara bajo demanda y la reparte al motor
  ANPR (RTSP interno) y a todos los visores; útil con cámaras que admiten pocos clientes simultáneos.
- **Modo compatibilidad:** si WebRTC no está disponible (UDP bloqueado, cámara solo H.265 y sin flujo secundario), el
  visor cambia a JPEG por WebSocket desde el motor (480–960 px, 5–15 fps).
- **Imágenes:** carga diferida (`loading="lazy"`) y caché de 6 h gracias a URLs firmadas estables.

## Seguridad

- Sesión JWT en `sessionStorage` (se cierra con el navegador), cierre automático al vencer,
  contador visible en el encabezado; el estado de la cuenta se verifica en cada solicitud.
- Evidencia fotográfica solo con enlace firmado HMAC con vencimiento (`/media/...?exp&firma`).
- El navegador no llama a los endpoints de control del motor: el backend cambia la cámara con el
  token de servicio y entrega un **ticket de 60 s** para abrir el WebSocket de video.
- Credenciales RTSP enmascaradas en la API, el video y los registros del motor, y **cifradas en la
  base** (AES-256-GCM dentro de la URL, clave `CAMARAS_CLAVE_CIFRADO` con rotación); se descifran
  solo en memoria para MediaMTX y el diagnóstico.
- Al editar o probar una cámara, la contraseña guardada (que el formulario recibe enmascarada) solo
  se reutiliza para el mismo equipo: si cambian el host, el puerto o el esquema hay que escribirla de
  nuevo, de modo que nadie puede enviarla a un equipo propio para leerla. Los errores de MediaMTX se
  enmascaran antes de registrarse y las fuentes se le entregan en una forma que su lector acepta.
- Diagnóstico de cámaras: **Ping** (ICMP con `execFile`, host validado, sin consola) y DESCRIBE
  RTSP con autenticación Digest (con `qop`, preferida cuando la cámara también anuncia Basic) o
  Basic, de ambos flujos; **Play** reproduce el flujo real (principal o secundario) y muestra si el servidor de
  video lo está recibiendo, lectores conectados, resolución, fps, códec y retardo.
- MediaMTX autoriza cada lectura contra el backend (`/api/medios/autorizar`): WebRTC con ticket de
  60 s y RTSP solo para el motor (token de servicio). Sus rutas se crean por API desde la tabla
  Camaras: no hay credenciales de cámaras en `mediamtx.yml`, y la API no se publica fuera de Docker.
- Las cámaras existen solo como registros de la base (no hay URLs, IP ni credenciales en el código o
  la configuración) y el motor procesa únicamente la ruta RTSP de MediaMTX que le asigna el backend;
  no tiene entradas de webcam ni previsualización de URLs arbitrarias. La fuente de cada detección se
  guarda como tipo (`rtsp`), nunca como URL.
- **Destinos de red restringidos (SSRF):** antes de guardar, probar, diagnosticar o publicar una
  cámara en MediaMTX, el backend resuelve su nombre y cada dirección debe pertenecer a
  `CAMARAS_REDES_PERMITIDAS` (por omisión, redes privadas; en producción, la VLAN de cámaras).
  Enlace local (169.254/16, metadatos de la nube), multidifusión y 0.0.0.0 se rechazan siempre.
- Cabeceras de seguridad (helmet) y límite de solicitudes por IP: general para la API
  (`LIMITE_API_POR_MINUTO`) y estricto para inicio de sesión (solo intentos fallidos), registro y
  recuperación (`LIMITE_ACCESO_POR_15_MIN`), además del bloqueo por cuenta. El motor (token de servicio) y la
  autorización de MediaMTX no cuentan. Detrás de un proxy, `TRUST_PROXY` (número de saltos).
- Salud: `/health` (proceso vivo) y `/health/ready` (SQL Server responde; Redis se informa sin
  bloquear). Docker Compose y Kubernetes los usan como healthcheck y sonda de disponibilidad.
- CORS restringido a `CORS_ORIGINS` / `FRONTEND_URL`.
- Auditoría de operaciones, cuentas e inicios de sesión, consultable (no editable) en `/auditoria`.

## Variables de entorno nuevas (backend)

| Variable | Uso | Por omisión |
|---|---|---|
| `ANPR_PUBLIC_URL` | URL del motor vista por el navegador (pistas y modo compatibilidad) | `http://localhost:8000` |
| `WEBRTC_PUBLIC_URL` | URL de MediaMTX (WebRTC) vista por el navegador | `http://localhost:8889` |
| `WEBRTC_HOSTS` | IP del equipo anunciadas para WebRTC (agregar la IP de la LAN para verlo desde otros equipos) | `127.0.0.1` |
| `MEDIAMTX_API_URL` / `MEDIAMTX_RTSP_URL` | API y RTSP internos de MediaMTX | `http://mediamtx:9997` / `rtsp://mediamtx:8554` |
| `CORS_ORIGINS` | Orígenes permitidos, separados por coma | `FRONTEND_URL` |
| `MEDIA_SECRET` | Clave de firma de las imágenes | `JWT_SECRET` |
| `CAMARAS_INTERVALO_S` | Intervalo del monitor de conectividad (0 = desactivado) | `60` |
| `CAMARAS_CLAVE_CIFRADO` | Clave AES-256 (base64 de 32 bytes) de las contraseñas RTSP | derivada de `JWT_SECRET` (con aviso) |
| `CAMARAS_CLAVE_CIFRADO_ANTERIOR` | Claves anteriores, solo durante una rotación (separadas por coma) | — |
| `CAMARAS_REDES_PERMITIDAS` | Redes (CIDR separados por coma) donde pueden estar las cámaras | redes privadas |
| `TRUST_PROXY` | Saltos de proxy inverso delante del backend (IP real del cliente) | sin proxy |
| `LIMITE_API_POR_MINUTO` | Solicitudes por minuto e IP a la API | `600` |
| `LIMITE_ACCESO_POR_15_MIN` | Intentos de acceso por IP cada 15 minutos | `20` |
| `ZONA_HORARIA` | Zona para "hoy" y vencimientos | `America/Guayaquil` |
| `UNIDAD_INSTITUCIONAL` | Unidad mostrada en la pantalla de acceso (también editable en Configuración) | `Coordinación Zonal 3 · Ambato` |
