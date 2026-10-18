-- Dirección de movimiento asociada a cada cámara. Los registros existentes conservan
-- compatibilidad y se clasifican como ingresos; la dirección queda copiada en cada evento
-- para que editar la cámara no altere el historial.
IF COL_LENGTH('dbo.Camaras', 'direccion') IS NULL
BEGIN
    ALTER TABLE dbo.Camaras
        ADD direccion VARCHAR(10) NOT NULL
            CONSTRAINT DF_Camaras_direccion DEFAULT ('ingreso');
END
GO

IF COL_LENGTH('dbo.DeteccionVehiculo', 'tipo_movimiento') IS NULL
BEGIN
    ALTER TABLE dbo.DeteccionVehiculo
        ADD tipo_movimiento VARCHAR(10) NOT NULL
            CONSTRAINT DF_DeteccionVehiculo_tipo_movimiento DEFAULT ('ingreso');
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Camaras_direccion')
    ALTER TABLE dbo.Camaras
        ADD CONSTRAINT CK_Camaras_direccion CHECK (direccion IN ('ingreso', 'salida'));
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_DeteccionVehiculo_tipo_movimiento')
    ALTER TABLE dbo.DeteccionVehiculo
        ADD CONSTRAINT CK_DeteccionVehiculo_tipo_movimiento CHECK (tipo_movimiento IN ('ingreso', 'salida'));
GO
