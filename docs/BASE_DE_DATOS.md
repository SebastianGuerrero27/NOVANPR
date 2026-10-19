# Base de datos · esquema v13

PostgreSQL 17, base `ANPR_ECU911`. En una instalación nueva el backend aplica
[`db/postgresql/esquema.sql`](../db/postgresql/esquema.sql) al arrancar. Las migraciones SQL Server
históricas (`db/migration_*.sql`) no se ejecutan en PostgreSQL.

La copia disponible de `db/esquema_completo.sql` contiene estructura, no registros. Al no existir
un respaldo de la base anterior, la instancia PostgreSQL inicia vacía; las placas, cámaras, cuentas
y detecciones deben registrarse nuevamente. El esquema SQL Server por sí solo no permite reconstruir esos datos.

## Principios

- **Sin datos de prueba ni usuarios predefinidos.** El primer administrador se crea en la
  pantalla de configuración inicial (`POST /api/auth/configuracion-inicial`), que solo
  funciona mientras no exista ningún administrador (transacción serializable).
- **Solo se precarga el catálogo de roles** (ADMIN, GUARDIA, GESTOR_PERMISOS; las bases anteriores
  con SUPERVISOR, OPERADOR y GESTOR_ACCESOS se consolidan en la migración v6). La matriz
  rol → permiso vive en el código (`backend/src/dominio/permisos.ts`, ver [ROLES_Y_PERMISOS.md](ROLES_Y_PERMISOS.md)).
- **Sin cámaras predefinidas:** las cámaras existen solo como filas de `Camaras` creadas por el
  administrador; no hay URL, IP ni credenciales en el código ni en la configuración.
- **Trazabilidad:** quién registró cada placa y cámara, quién validó cada ingreso,
  auditoría de acciones administrativas y de cada intento de inicio de sesión.
- **Secretos protegidos:** las contraseñas se guardan con bcrypt (12 rondas, `BCRYPT_ROUNDS`), los
  enlaces de verificación / restablecimiento solo como hash SHA-256 de un token aleatorio y la
  contraseña RTSP de cada cámara cifrada con AES-256-GCM dentro de la URL (clave
  `CAMARAS_CLAVE_CIFRADO`, fuera de la base y del repositorio).

## Tablas

| Grupo | Tabla | Propósito |
|---|---|---|
| Seguridad | `Roles` | Catálogo de roles |
| | `Usuarios` | Correo (usuario de acceso), nombre, cargo, rol, estado (`pendiente` / `activo` / `inactivo`), verificación de correo, bloqueo administrativo y temporal por intentos, último acceso |
| | `VerificacionEmail` | Tokens de activación de cuenta (24 h, un solo uso) |
| | `RestablecimientoPassword` | Tokens de restablecimiento (30 min) o de definición de contraseña en cuentas creadas por un administrador (48 h) |
| | `AuditoriaUsuarios` | Acciones sobre cuentas: registro, verificación, creación, cambios de rol/estado, bloqueos, cambios de contraseña |
| | `AuditoriaAccesos` | Cada intento de inicio de sesión con resultado, motivo, IP y navegador |
| | `AuditoriaOperaciones` | Acciones operativas: validaciones, registros manuales, eliminaciones, altas/ediciones/retiros en listas, cámaras, cambio de cámara del motor, exportaciones y configuración |
| | `AuditoriaOperacionesArchivo`, `AuditoriaUsuariosArchivo`, `AuditoriaAccesosArchivo` | Archivo de la auditoría (v7): la retención traslada aquí los registros antiguos en una sola transacción; la auditoría nunca se edita ni se borra |
| Sistema | `ConfiguracionSistema` | Parámetros editables desde la pantalla de configuración (sin filas iniciales: rige la variable de entorno o el valor por omisión) |
| Infraestructura | `Camaras` | Canales RTSP: `rtsp_url` (flujo principal para el motor, con la contraseña cifrada AES-256-GCM), `rtsp_url_vista` (flujo secundario para el navegador, v9), `direccion` (`ingreso` o `salida`, v13), `roi` (área de detección) y `exclusiones` (hasta 8 polígonos donde no se buscan placas, v11); `activa` = habilitación administrativa, `estado` = conectividad observada (EN_LINEA, SIN_CONEXION, SIN_VERIFICAR); `registrado_por` |
| Listas | `ListaNegra` | Placas con alerta (nivel CRÍTICA/ALTA/MEDIA), marca/modelo/color registrados, **fecha de vencimiento** y observaciones; `registrado_por` |
| | `VehiculosAutorizados` | Permisos de placa: categoría, **vigencia desde/hasta**, **franjas horarias** (JSON), marca/modelo/color, observaciones, `registrado_por` y `solicitud_id` de origen |
| | `SolicitudesAcceso` | Solicitudes de autorización (pendiente / aprobada / rechazada / cancelada) con solicitante, resolutor, vigencia y horario pedidos, ingreso de origen, permiso creado y `version` para la concurrencia optimista (v8) |
| Operación | `DeteccionVehiculo` | Cada movimiento: `tipo_movimiento` (`ingreso` o `salida`, v13; los registros preexistentes quedan como ingreso), captura (fotos del vehículo y del recorte de la placa), OCR, decisión, validez de la lectura (`lectura_valida`, `evidencia_lectura` en JSON con las evidencias E1–E5 y el texto crudo de cada lector), validación del guardia (`usuario_validador_id`), lectura y decisión automáticas originales, metadatos de evaluación, atributos del vehículo y fuente (`rtsp` o `manual`, nunca la URL). Las salidas son eventos independientes y no ejecutan la decisión de autorización de ingreso. |
| | `AuditoriaDescartes` | Pasos descartados por el motor con su motivo (p. ej. `region_sin_caracteres`, `formato_no_corresponde_a_la_placa`, foto ilegible tras los reintentos) |
| | `AuditoriaConsultaPropietario` | Consultas de datos del propietario (solo con convenio oficial) |
| Notificaciones | `Notificaciones` | Alarmas y avisos: tipo, prioridad, mensaje, enlace, clave de supresión y repeticiones, reconocimiento (quién y cuándo), resolución y escalamiento |
| | `NotificacionUsuario` | Bandeja por usuario (destinatarios resueltos por permiso), fecha de lectura y `fecha_eliminacion` (v12: la persona quitó de su bandeja una notificación revisada; la notificación se conserva) |
| | `SuscripcionesPush` | Suscripciones Web Push de los navegadores (endpoint, claves p256dh/auth) |
| | `ClavesServicio` | Claves generadas por el sistema (par VAPID si no se define en el entorno) |
| Esquema | `SchemaMigraciones` | Migraciones aplicadas y su suma SHA-256 |

## Relaciones principales

```
Roles 1───* Usuarios ──* AuditoriaUsuarios / AuditoriaAccesos / VerificacionEmail / RestablecimientoPassword
Usuarios 1───* Camaras · ListaNegra · VehiculosAutorizados   (registrado_por)
Usuarios 1───* DeteccionVehiculo                              (usuario_validador_id)
Camaras 1───* DeteccionVehiculo
ListaNegra 1───* DeteccionVehiculo (alerta_id) · VehiculosAutorizados 1───* DeteccionVehiculo
```

## Reglas de negocio en la base y el backend

- Inicio de sesión con correo; tras `LOGIN_MAX_INTENTOS` (5) fallos la cuenta se bloquea
  `LOGIN_MINUTOS_BLOQUEO` (15) minutos y se notifica por correo.
- Registro público (`REGISTRO_PUBLICO_HABILITADO`) solo con dominios de `ALLOWED_EMAIL_DOMAINS`;
  la cuenta queda `pendiente` hasta verificar el correo y luego `activo` con rol Guardia.
- No se puede quitar el rol ni desactivar al último administrador activo.
- Un permiso de placa solo concede el paso dentro de su vigencia (desde/hasta) y de sus franjas
  horarias; fuera de ellas el paso queda `no_reconocido` con `DeteccionVehiculo.restriccion_acceso`
  (`fuera_horario`, `no_iniciada`, `vencida`) y solo `accesos:excepcion` puede concederlo. Una alerta
  vencida deja de alertar. "Hoy" y el horario se calculan en hora de Ecuador (la base guarda UTC).
- Quien registra una solicitud de acceso no puede resolverla (separación de funciones).
- Bloquear, desactivar o cambiar el rol de una cuenta surte efecto en segundos: cada solicitud
  verifica el estado vigente de la cuenta (caché de 20 s), no solo el token.
- Las listas se retiran con baja lógica y motivo; una cámara con historial no se elimina (se
  deshabilita). Eliminar una detección exige motivo y rol Administrador.
- Las rutas del servicio ANPR (`/detecciones/ingreso`, `/completar-ocr`, `/reevaluar`, `/descarte`) exigen
  el encabezado `X-Servicio-Token` (`ANPR_SERVICE_TOKEN`); el resto exige sesión y rol.
- **Un paso, un registro:** la misma placa en la misma cámara dentro de 35 000 ms es el mismo paso
  (ventana exacta en milisegundos); sin placa, el mismo `tracking_id` en la misma cámara. Una placa
  en otra cámara, o un tracking repetido con otra placa tras reiniciar el motor, es un paso nuevo.
- **Reevaluación tardía:** el motor registra el paso en menos de 1 s; si después llegan la lectura
  del verificador o los atributos del vehículo, `POST /detecciones/reevaluar` recalcula la decisión
  con las mismas reglas. Lo validado por el personal y las alertas no se modifican.
- Una notificación revisada puede quitarse de la bandeja propia; una alarma pendiente de atención no.

## Cambios de las versiones 6 a 12

| Migración | Cambio |
|---|---|
| v6 `tres_roles` | `OPERADOR` → `GUARDIA` y `GESTOR_ACCESOS` → `GESTOR_PERMISOS` (conservan id y usuarios); `SUPERVISOR` se elimina y sus cuentas pasan a Guardia (mínimo privilegio) |
| v7 `auditoria_retencion` | Tablas de archivo de la auditoría; la retención copia y luego borra solo lo copiado, en una transacción |
| v8 `solicitudes_version` | `SolicitudesAcceso.version`: la aprobación indica la versión revisada; si cambió, el reclamo atómico no procede (409) |
| v9 `camaras_vista_cifrado` | `Camaras.rtsp_url_vista` (flujo secundario) y contraseña RTSP cifrada con AES-256-GCM |
| v10 `fuente_rtsp` | Fuente por omisión de las detecciones: `rtsp` (se retiró la webcam de pruebas) |
| v11 `zonas_exclusion` | `Camaras.exclusiones`: polígonos normalizados donde el motor no cuenta movimiento ni busca placas |
| v12 `eliminar_notificaciones` | `NotificacionUsuario.fecha_eliminacion`: quitar de la bandeja propia las notificaciones revisadas |

## Cambios de la versión 5 (`migration_v5_accesos_notificaciones.sql`)

- Se retira el `CHECK` fijo de `Roles.codigo` y se agrega `GESTOR_ACCESOS`.
- `VehiculosAutorizados`: `categoria`, `fecha_inicio`, `horario`, `solicitud_id`.
- `DeteccionVehiculo.restriccion_acceso`.
- Tablas nuevas: `SolicitudesAcceso`, `Notificaciones`, `NotificacionUsuario`, `SuscripcionesPush`,
  `ClavesServicio` (y `SchemaMigraciones`, creada por el backend).

## Cambios de la versión 3

- Se retiraron de `DeteccionVehiculo` las columnas de compatibilidad `placa`, `fecha_hora`,
  `imagen_vehiculo_path` e `imagen_placa_path`. La placa vigente es
  `COALESCE(placa_validada, placa_reconocida)`; una lectura ilegible guarda `placa_reconocida = NULL`.
- Índices nuevos: `IX_Deteccion_Camara_Fecha`, `IX_Deteccion_PlacaValidada`.

## Limpieza de datos de prueba

`db/scripts/limpiar_datos_de_prueba.sql` (manual, un solo uso, requiere cambiar la confirmación
a `SI_BORRAR_TODO` y un respaldo previo). Ejecutado el 2026-09-23 tras respaldar la base en
`backups/ANPR_ECU911_antes_v2_*.bak`.
