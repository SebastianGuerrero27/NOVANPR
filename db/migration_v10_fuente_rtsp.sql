-- =============================================================================
-- Migración v10 · Fuente por omisión de las detecciones: 'rtsp' (idempotente)
--
-- La webcam de pruebas del navegador se retiró: la única entrada del motor ANPR es la cámara RTSP
-- registrada (su ruta en MediaMTX). Solo cambia el valor por omisión de la columna; no modifica
-- ningún registro (el historial y la auditoría se conservan tal como se guardaron).
--
-- SQL Server nombra automáticamente la restricción DEFAULT creada en init.sql, así que se busca en
-- el catálogo y se reemplaza solo si todavía no es 'rtsp'.
-- =============================================================================

DECLARE @restriccion SYSNAME, @definicion NVARCHAR(MAX), @sql NVARCHAR(400);
SELECT @restriccion = dc.name, @definicion = dc.definition
FROM sys.default_constraints dc
JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
WHERE dc.parent_object_id = OBJECT_ID('dbo.DeteccionVehiculo') AND c.name = 'fuente';

IF @restriccion IS NOT NULL AND @definicion <> N'(''rtsp'')'
BEGIN
    SET @sql = N'ALTER TABLE dbo.DeteccionVehiculo DROP CONSTRAINT ' + QUOTENAME(@restriccion);
    EXEC sp_executesql @sql;
    SET @restriccion = NULL;
END

IF @restriccion IS NULL
    ALTER TABLE dbo.DeteccionVehiculo ADD CONSTRAINT DF_DeteccionVehiculo_fuente DEFAULT 'rtsp' FOR fuente;
GO
