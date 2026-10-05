# Base de datos · esquema v5

SQL Server 2022, base `ANPR_ECU911`. Instalación nueva: `db/init.sql` seguido de las migraciones
`db/migration_*.sql` (idempotentes). El backend las aplica al arrancar en el orden de
`MIGRACIONES` (`backend/src/infraestructura/db.ts`) y registra cada una en `SchemaMigraciones` con su suma
SHA-256: una migración ya aplicada no se vuelve a ejecutar salvo que su archivo cambie.

## Principios

- **Sin datos de prueba ni usuarios predefinidos.** El primer administrador se crea en la
  pantalla de configuración inicial (`POST /api/auth/configuracion-inicial`), que solo
  funciona mientras no exista ningún administrador (transacción serializable).
- **Solo se precarga el catálogo de roles** (ADMIN, SUPERVISOR, OPERADOR, GESTOR_ACCESOS). La matriz
  rol → permiso vive en el código (`backend/src/dominio/permisos.ts`, ver [ROLES_Y_PERMISOS.md](ROLES_Y_PERMISOS.md)).
- **Trazabilidad:** quién registró cada placa y cámara, quién validó cada ingreso,
  auditoría de acciones administrativas y de cada intento de inicio de sesión.
- **Secretos fuera de la base:** las contraseñas se guardan con bcrypt (12 rondas) y los
  enlaces de verificación / restablecimiento solo como hash SHA-256 de un token aleatorio.

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
| Sistema | `ConfiguracionSistema` | Parámetros editables desde la pantalla de configuración (sin filas iniciales: rige la variable de entorno o el valor por omisión) |
| Infraestructura | `Camaras` | Canales RTSP; `activa` = habilitación administrativa, `estado` = conectividad observada (EN_LINEA, SIN_CONEXION, SIN_VERIFICAR); `registrado_por` |
| Listas | `ListaNegra` | Placas con alerta (nivel CRÍTICA/ALTA/MEDIA), marca/modelo/color registrados, **fecha de vencimiento** y observaciones; `registrado_por` |
| | `VehiculosAutorizados` | Permisos de placa: categoría, **vigencia desde/hasta**, **franjas horarias** (JSON), marca/modelo/color, observaciones, `registrado_por` y `solicitud_id` de origen |
| | `SolicitudesAcceso` | Solicitudes de autorización (pendiente / aprobada / rechazada / cancelada) con solicitante, resolutor, vigencia y horario pedidos, ingreso de origen y permiso creado |
| Operación | `DeteccionVehiculo` | Cada paso vehicular: captura, OCR, decisión, validación del operador (`usuario_validador_id`), lectura y decisión automáticas originales, metadatos de evaluación y atributos del vehículo |
| | `AuditoriaDescartes` | Detecciones descartadas por la segunda verificación OCR |
| | `AuditoriaConsultaPropietario` | Consultas de datos del propietario (solo con convenio oficial) |
| Notificaciones | `Notificaciones` | Alarmas y avisos: tipo, prioridad, mensaje, enlace, clave de supresión y repeticiones, reconocimiento (quién y cuándo), resolución y escalamiento |
| | `NotificacionUsuario` | Bandeja por usuario (destinatarios resueltos por permiso) y fecha de lectura |
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
  la cuenta queda `pendiente` hasta verificar el correo y luego `activo` con rol Operador.
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
- Las rutas del servicio ANPR (`/detecciones/ingreso`, `/completar-ocr`, `/descarte`) exigen
  el encabezado `X-Servicio-Token` (`ANPR_SERVICE_TOKEN`); el resto exige sesión y rol.

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
