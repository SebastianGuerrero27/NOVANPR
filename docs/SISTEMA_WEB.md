# Sistema web · pantallas, roles y arquitectura

Frontend React 18 + Vite (sin frameworks de UI), backend Express/TypeScript y motor ANPR
FastAPI. Todos los datos que se muestran provienen de la base: no existen datos simulados ni
valores de relleno (un indicador sin registros vale cero y cada pantalla tiene su estado vacío).

## Roles

| Rol | Puede |
|---|---|
| **Operador** | Inicio operativo, monitoreo en vivo, registro de ingresos, validar/corregir lecturas, registro manual, consultar listas |
| **Supervisor** | Todo lo del operador + alta/edición/retiro en las listas, reportes, evaluación del sistema, cambiar la cámara que procesa el motor |
| **Administrador** | Todo + usuarios, auditoría, cámaras, configuración, eliminar ingresos, consulta de propietario (convenio) y webcam de prueba |

El menú lateral se arma por rol (`frontend/src/layout/navegacion.tsx`) y la API aplica el mismo
control en cada endpoint (`authMiddleware`, `adminOSupervisor`, `soloAdmin`).

## Pantallas

| Ruta | Pantalla |
|---|---|
| `/login`, `/registro`, `/configuracion-inicial`, `/verificar-email`, `/restablecer-password` | Acceso y ciclo de vida de la cuenta |
| `/` | Inicio: panel del operador (su turno, cola de validación, alertas) o panel de gestión (indicadores, ingresos por hora, 7 días, distribución, listas, exactitud de lectura, cámaras; el administrador ve además cuentas, accesos fallidos, actividad y servicios) |
| `/monitoreo` | Video en vivo, último paso destacado, feed en tiempo real, aviso de alerta con sonido, consulta de placa, ingreso manual |
| `/detecciones` | Registro de ingresos paginado con filtros en la URL, exportación CSV |
| `/detecciones/:id` | Detalle: evidencia, lectura automática vs. confirmada, validez de la lectura (evidencias del motor), condiciones de captura, pasos anteriores, trazabilidad, acciones |
| `/listas/autorizados`, `/listas/alertas` | Listas de control con vigencia (vigentes / por vencer / vencidas) y observaciones |
| `/reportes` | Reporte por período y cámara, impresión y exportación |
| `/evaluacion` | Métricas científicas del reconocimiento |
| `/usuarios`, `/auditoria`, `/camaras`, `/configuracion` | Administración (en Cámaras, **Área** dibuja la región de interés sobre el video) |
| `/perfil` | Datos propios y cambio de contraseña |

## Reconocimiento: cuadro de la placa y autorización automática

El motor dibuja solo las regiones comprobadas como placa, con el cuadrilátero ajustado a sus
bordes y el color del estado; cada lectura lleva un veredicto de validez (formato, placa
completa, fila de caracteres, consenso) que decide si una placa del padrón se autoriza sola.
Método, regla de decisión y protocolo de evaluación: [METODO_VERIFICACION_LECTURA.md](METODO_VERIFICACION_LECTURA.md).

## Consumo de recursos

- **Carga diferida:** cada pantalla es un módulo aparte (2–8 kB gzip); el acceso no descarga el
  panel ni el video. Base común ≈ 93 kB gzip (React, router, axios, socket.io).
- **Tiempo real sin sondeo:** una sola conexión Socket.IO autenticada por sesión. Eventos:
  `deteccion:nueva | actualizada | alerta | eliminada`, `camara:estado | actualizada | eliminada`,
  `listas:actualizadas`, `monitoreo:camara`. Los paneles agrupan recargas (5 s) y, con la pestaña
  oculta, esperan a que vuelva a ser visible.
- **Video en vivo (WebRTC):** cámara → MediaMTX → navegador por WebRTC (WHEP), sin
  transcodificar: el H.264 de la cámara llega tal cual y el navegador lo decodifica por hardware,
  con búfer de reproducción mínimo. Retardo típico en red local: 0,2–0,5 s (se muestra en el
  visor). Las cajas de detección llegan aparte, como JSON (`/ws/pistas` del motor, ~10 envíos/s),
  y se dibujan sobre el video. El video se cierra al pausar u ocultar la pestaña.
- **Una sola conexión por cámara:** MediaMTX abre la cámara bajo demanda y la reparte al motor
  ANPR (RTSP interno) y a todos los visores; útil para celulares y cámaras con límite de clientes.
- **Modo compatibilidad:** si WebRTC no está disponible (UDP bloqueado, cámara en H.265), el
  visor cambia a JPEG por WebSocket desde el motor (480–960 px, 5–15 fps).
- **Imágenes:** carga diferida (`loading="lazy"`) y caché de 6 h gracias a URLs firmadas estables.

## Seguridad

- Sesión JWT en `sessionStorage` (se cierra con el navegador), cierre automático al vencer,
  contador visible en el encabezado; el estado de la cuenta se verifica en cada solicitud.
- Evidencia fotográfica solo con enlace firmado HMAC con vencimiento (`/media/...?exp&firma`).
- El navegador no llama a los endpoints de control del motor: el backend cambia la cámara con el
  token de servicio y entrega un **ticket de 60 s** para abrir el WebSocket de video.
- Credenciales RTSP enmascaradas en la API, el video y los registros del motor.
- Diagnóstico de cámaras: **Ping** (ICMP con `execFile`, host validado, sin consola) y DESCRIBE
  RTSP con autenticación Basic/Digest; **Play** reproduce el flujo real y muestra si el servidor de
  video lo está recibiendo, lectores conectados, resolución, fps, códec y retardo.
- MediaMTX autoriza cada lectura contra el backend (`/api/medios/autorizar`): WebRTC con ticket de
  60 s y RTSP solo para el motor (token de servicio). Sus rutas se crean por API desde la tabla
  Camaras: no hay credenciales de cámaras en `mediamtx.yml`, y la API no se publica fuera de Docker.
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
| `ZONA_HORARIA` | Zona para "hoy" y vencimientos | `America/Guayaquil` |
| `UNIDAD_INSTITUCIONAL` | Unidad mostrada en la pantalla de acceso (también editable en Configuración) | `Coordinación Zonal 3 · Ambato` |
