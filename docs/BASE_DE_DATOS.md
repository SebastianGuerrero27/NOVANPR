# Base de datos · esquema v3

SQL Server 2022, base `ANPR_ECU911`. Instalación nueva: `db/init.sql`. Bases existentes:
`db/migration_v2_seguridad.sql` y `db/migration_v3_operacion.sql` (idempotentes, se ejecutan en
cada arranque del backend).

## Principios

- **Sin datos de prueba ni usuarios predefinidos.** El primer administrador se crea en la
  pantalla de configuración inicial (`POST /api/auth/configuracion-inicial`), que solo
  funciona mientras no exista ningún administrador (transacción serializable).
- **Solo se precarga el catálogo de roles** (ADMIN, SUPERVISOR, OPERADOR).
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
| | `VehiculosAutorizados` | Padrón institucional con marca/modelo/color, **fecha de vencimiento** (visitas y proveedores) y observaciones; `registrado_por` |
| Operación | `DeteccionVehiculo` | Cada paso vehicular: captura, OCR, decisión, validación del operador (`usuario_validador_id`), lectura y decisión automáticas originales, metadatos de evaluación y atributos del vehículo |
| | `AuditoriaDescartes` | Detecciones descartadas por la segunda verificación OCR |
| | `AuditoriaConsultaPropietario` | Consultas de datos del propietario (solo con convenio oficial) |

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
- Una autorización con `fecha_vencimiento` pasada ya no concede acceso automático; una alerta
  vencida deja de alertar. "Hoy" se calcula en hora de Ecuador (la base guarda UTC).
- Bloquear, desactivar o cambiar el rol de una cuenta surte efecto en segundos: cada solicitud
  verifica el estado vigente de la cuenta (caché de 20 s), no solo el token.
- Las listas se retiran con baja lógica y motivo; una cámara con historial no se elimina (se
  deshabilita). Eliminar una detección exige motivo y rol Administrador.
- Las rutas del servicio ANPR (`/detecciones/ingreso`, `/completar-ocr`, `/descarte`) exigen
  el encabezado `X-Servicio-Token` (`ANPR_SERVICE_TOKEN`); el resto exige sesión y rol.

## Cambios de la versión 3

- Se retiraron de `DeteccionVehiculo` las columnas de compatibilidad `placa`, `fecha_hora`,
  `imagen_vehiculo_path` e `imagen_placa_path`. La placa vigente es
  `COALESCE(placa_validada, placa_reconocida)`; una lectura ilegible guarda `placa_reconocida = NULL`.
- Índices nuevos: `IX_Deteccion_Camara_Fecha`, `IX_Deteccion_PlacaValidada`.

## Limpieza de datos de prueba

`db/scripts/limpiar_datos_de_prueba.sql` (manual, un solo uso, requiere cambiar la confirmación
a `SI_BORRAR_TODO` y un respaldo previo). Ejecutado el 2026-09-23 tras respaldar la base en
`backups/ANPR_ECU911_antes_v2_*.bak`.
