-- =============================================================================
-- Migración v3 · Operación y pantallas (idempotente; se ejecuta en cada arranque)
--
--  1. AuditoriaOperaciones: quién hizo qué sobre detecciones, listas, cámaras y configuración.
--  2. ConfiguracionSistema: parámetros editables por el administrador (sin valores en código).
--  3. ListaNegra: vigencia (fecha_vencimiento) y observaciones, igual que VehiculosAutorizados.
--  4. Índices para el panel, el historial paginado y los reportes.
--  5. Retiro de las columnas de compatibilidad de DeteccionVehiculo (placa, fecha_hora,
--     imagen_vehiculo_path, imagen_placa_path): el backend usa placa_reconocida /
--     placa_validada, fecha_hora_ingreso y ruta_imagen_*.
-- =============================================================================

IF OBJECT_ID('AuditoriaOperaciones', 'U') IS NULL
BEGIN
    CREATE TABLE AuditoriaOperaciones (
        id             BIGINT IDENTITY(1,1) PRIMARY KEY,
        fecha          DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
        usuario_id     INT           NULL REFERENCES Usuarios(id),
        usuario_email  NVARCHAR(150) NULL,
        accion         VARCHAR(50)   NOT NULL,   -- VALIDACION, REGISTRO_MANUAL, DETECCION_ELIMINADA, LISTA_*, CAMARA_*, CONFIGURACION
        entidad        VARCHAR(40)   NOT NULL,   -- deteccion, lista_negra, autorizado, camara, configuracion
        entidad_id     INT           NULL,
        detalle        NVARCHAR(500) NULL,
        ip             VARCHAR(45)   NULL
    );
    CREATE INDEX IX_AuditoriaOperaciones_Fecha ON AuditoriaOperaciones (fecha DESC);
    CREATE INDEX IX_AuditoriaOperaciones_Entidad ON AuditoriaOperaciones (entidad, entidad_id);
END
GO

IF OBJECT_ID('ConfiguracionSistema', 'U') IS NULL
BEGIN
    CREATE TABLE ConfiguracionSistema (
        clave                VARCHAR(60)   NOT NULL PRIMARY KEY,
        valor                NVARCHAR(500) NOT NULL,
        actualizado_por      INT           NULL REFERENCES Usuarios(id),
        fecha_actualizacion  DATETIME2     NOT NULL DEFAULT SYSDATETIME()
    );
END
GO

IF COL_LENGTH('ListaNegra', 'fecha_vencimiento') IS NULL
    ALTER TABLE ListaNegra ADD fecha_vencimiento DATE NULL;
GO
IF COL_LENGTH('ListaNegra', 'observaciones') IS NULL
    ALTER TABLE ListaNegra ADD observaciones NVARCHAR(255) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Deteccion_Camara_Fecha')
    CREATE NONCLUSTERED INDEX IX_Deteccion_Camara_Fecha ON DeteccionVehiculo (camara_id, fecha_hora_ingreso DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Deteccion_PlacaValidada')
    CREATE NONCLUSTERED INDEX IX_Deteccion_PlacaValidada ON DeteccionVehiculo (placa_validada);
GO

-- Retiro de columnas heredadas (se eliminan primero sus restricciones DEFAULT)
DECLARE @col SYSNAME, @df SYSNAME, @sql NVARCHAR(400);
DECLARE cols CURSOR LOCAL FAST_FORWARD FOR
    SELECT name FROM sys.columns
    WHERE object_id = OBJECT_ID('DeteccionVehiculo')
      AND name IN ('placa', 'fecha_hora', 'imagen_vehiculo_path', 'imagen_placa_path');
OPEN cols;
FETCH NEXT FROM cols INTO @col;
WHILE @@FETCH_STATUS = 0
BEGIN
    SELECT @df = dc.name FROM sys.default_constraints dc
    JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID('DeteccionVehiculo') AND c.name = @col;
    IF @df IS NOT NULL
    BEGIN
        SET @sql = N'ALTER TABLE DeteccionVehiculo DROP CONSTRAINT ' + QUOTENAME(@df);
        EXEC sp_executesql @sql;
    END
    SET @sql = N'ALTER TABLE DeteccionVehiculo DROP COLUMN ' + QUOTENAME(@col);
    EXEC sp_executesql @sql;
    SET @df = NULL;
    FETCH NEXT FROM cols INTO @col;
END
CLOSE cols;
DEALLOCATE cols;
GO

-- Estado de cámara = conectividad observada (la habilitación está en `activa`)
UPDATE Camaras SET estado = 'SIN_VERIFICAR' WHERE estado IS NULL OR estado NOT IN ('EN_LINEA', 'SIN_CONEXION', 'SIN_VERIFICAR');
GO
