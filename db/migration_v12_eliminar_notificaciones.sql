-- =============================================================================
-- Migración v12 · Quitar notificaciones de la bandeja (idempotente)
--
-- Cada persona puede quitar de su bandeja las notificaciones que ya revisó (leídas y sin alarma
-- pendiente de atención). Se marca su fila de NotificacionUsuario con la fecha: la notificación no
-- se borra, así se conservan la trazabilidad de la alarma (quién la atendió y cuándo) y las
-- métricas ISA-18.2 de la evaluación, y las demás personas la siguen viendo. Si el mismo evento se
-- repite, vuelve a aparecer. Solo agrega la columna: no modifica registros.
-- =============================================================================

IF COL_LENGTH('dbo.NotificacionUsuario', 'fecha_eliminacion') IS NULL
    ALTER TABLE NotificacionUsuario ADD fecha_eliminacion DATETIME2 NULL;
GO
