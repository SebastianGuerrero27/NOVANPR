-- =============================================================================
-- Migración v8 · Versión de las solicitudes de acceso (idempotente)
--
-- Control de concurrencia optimista: cada edición de una solicitud pendiente (PUT) incrementa
-- su versión, y la aprobación indica la versión que revisó el gestor. Si la solicitud cambió
-- mientras la revisaba, el reclamo atómico no procede (409) y el permiso nunca se concede a
-- datos que el gestor no vio (revisión de cuatro ojos y separación de funciones).
-- =============================================================================

IF COL_LENGTH('dbo.SolicitudesAcceso', 'version') IS NULL
    ALTER TABLE SolicitudesAcceso ADD version INT NOT NULL CONSTRAINT DF_SolicitudesAcceso_version DEFAULT 1;
GO
