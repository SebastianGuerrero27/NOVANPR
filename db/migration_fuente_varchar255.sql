-- Migración: Ampliar columna fuente a VARCHAR(255) para soportar URLs RTSP completas
IF EXISTS (
    SELECT 1 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_NAME = 'DeteccionVehiculo' 
      AND COLUMN_NAME = 'fuente'
)
BEGIN
    ALTER TABLE DeteccionVehiculo ALTER COLUMN fuente VARCHAR(255) NULL;
    PRINT 'Columna fuente ampliada a VARCHAR(255) en DeteccionVehiculo.';
END
GO
