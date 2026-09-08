-- =============================================================================
-- MIGRACIÓN: Soporte de Estado Dinámico y Monitoreo Ping para Cámaras
-- Proyecto ANPR ECU 911 (Hikvision / Integración Vigilance)
-- =============================================================================

USE [ANPR_ECU911];
GO

-- 1. Columna ESTADO ('ACTIVA', 'INACTIVA', 'MANTENIMIENTO')
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Camaras') AND name = 'estado')
BEGIN
    ALTER TABLE Camaras ADD estado VARCHAR(20) DEFAULT 'ACTIVA';
    PRINT 'Columna [estado] agregada a la tabla Camaras.';
END
GO

-- 2. Columna ULTIMO_PING (Registro temporal del último chequeo ICMP / RTSP)
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Camaras') AND name = 'ultimo_ping')
BEGIN
    ALTER TABLE Camaras ADD ultimo_ping DATETIME NULL;
    PRINT 'Columna [ultimo_ping] agregada a la tabla Camaras.';
END
GO

-- 3. Columna TIEMPO_RESPUESTA_MS (Latencia en milisegundos devuelta por el Ping)
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Camaras') AND name = 'tiempo_respuesta_ms')
BEGIN
    ALTER TABLE Camaras ADD tiempo_respuesta_ms INT NULL;
    PRINT 'Columna [tiempo_respuesta_ms] agregada a la tabla Camaras.';
END
GO

-- 4. Columna MENSAJE_PING (Detalle de diagnóstico: TTL, Timeout, Fallo General, etc.)
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Camaras') AND name = 'mensaje_ping')
BEGIN
    ALTER TABLE Camaras ADD mensaje_ping VARCHAR(255) NULL;
    PRINT 'Columna [mensaje_ping] agregada a la tabla Camaras.';
END
GO

-- 5. Normalizar registros preexistentes
UPDATE Camaras 
SET estado = CASE WHEN activa = 1 THEN 'ACTIVA' ELSE 'INACTIVA' END 
WHERE estado IS NULL;
GO

PRINT 'Migración de Cámaras completada exitosamente.';
GO
