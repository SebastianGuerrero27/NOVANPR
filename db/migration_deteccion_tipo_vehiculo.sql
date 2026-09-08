USE ANPR_ECU911;
GO

IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('DeteccionVehiculo') AND name = 'tipo_vehiculo')
BEGIN
    ALTER TABLE DeteccionVehiculo ADD tipo_vehiculo VARCHAR(50) NULL;
    PRINT 'Columna tipo_vehiculo añadida a DeteccionVehiculo.';
END
GO
