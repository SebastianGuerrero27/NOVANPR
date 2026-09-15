-- =============================================================================
-- MIGRACIÓN: Tabla de Auditoría de Falsos Positivos y Descartes ANPR
-- Registra detecciones descartadas durante la segunda verificación OCR
-- con auto-purga para no saturar la tabla principal DeteccionVehiculo.
-- =============================================================================

USE ANPR_ECU911;
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AuditoriaDescartes')
BEGIN
    CREATE TABLE AuditoriaDescartes (
        id                  INT IDENTITY(1,1) PRIMARY KEY,
        tracking_id         INT NULL,
        motivo              VARCHAR(100) NOT NULL,
        texto_candidato     VARCHAR(50) NULL,
        confianza           FLOAT NULL,
        fuente              VARCHAR(255) NULL,
        camara_id           INT NULL,
        fecha_registro      DATETIME DEFAULT GETDATE()
    );

    CREATE INDEX IX_AuditoriaDescartes_Fecha ON AuditoriaDescartes(fecha_registro);
    PRINT '[DB] Tabla AuditoriaDescartes creada exitosamente.';
END
ELSE
BEGIN
    PRINT '[DB] Tabla AuditoriaDescartes ya existe.';
END
GO

-- Auto-purga de registros de auditoría más antiguos a 3 días o límite de 5000 filas
DELETE FROM AuditoriaDescartes WHERE fecha_registro < DATEADD(DAY, -3, GETDATE());
GO
