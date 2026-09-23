-- =============================================================================
-- Migración: Soporte Multi-Cámara
-- ECU 911 ANPR System
-- =============================================================================

USE ANPR_ECU911;
GO

-- 1. Actualizar tabla Camaras para soportar múltiples cámaras activas
IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('Camaras') AND name = 'priority')
BEGIN
    ALTER TABLE Camaras
    ADD 
        priority INT DEFAULT 1,
        is_active BIT DEFAULT 1,
        last_frame_timestamp DATETIME NULL,
        current_fps FLOAT NULL,
        detection_count INT DEFAULT 0,
        region VARCHAR(100) NULL;
END
GO

-- 2. Crear tabla para tracking de streams activos
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'CameraStreams')
BEGIN
    CREATE TABLE CameraStreams (
        id INT IDENTITY(1,1) PRIMARY KEY,
        camera_id INT NOT NULL FOREIGN KEY REFERENCES Camaras(id),
        stream_url VARCHAR(500) NOT NULL,
        stream_type VARCHAR(50) DEFAULT 'rtsp', -- rtsp, http, webcam
        is_active BIT DEFAULT 1,
        last_heartbeat DATETIME DEFAULT GETDATE(),
        health_status VARCHAR(50) DEFAULT 'healthy', -- healthy, degraded, offline
        error_message VARCHAR(500) NULL,
        created_at DATETIME DEFAULT GETDATE(),
        updated_at DATETIME DEFAULT GETDATE()
    );
END
GO

-- 3. Crear índices para optimizar consultas multi-cámara
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_CameraStreams_CameraActive' AND object_id = OBJECT_ID('CameraStreams'))
BEGIN
    CREATE NONCLUSTERED INDEX IX_CameraStreams_CameraActive 
    ON CameraStreams (camera_id, is_active);
END
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_CameraStreams_Health' AND object_id = OBJECT_ID('CameraStreams'))
BEGIN
    CREATE NONCLUSTERED INDEX IX_CameraStreams_Health 
    ON CameraStreams (health_status, is_active);
END
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_Camaras_PriorityActive' AND object_id = OBJECT_ID('Camaras'))
BEGIN
    CREATE NONCLUSTERED INDEX IX_Camaras_PriorityActive 
    ON Camaras (priority, is_active);
END
GO

-- 4. Crear tabla para detecciones por cámara
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'CameraDetectionStats')
BEGIN
    CREATE TABLE CameraDetectionStats (
        id INT IDENTITY(1,1) PRIMARY KEY,
        camera_id INT NOT NULL FOREIGN KEY REFERENCES Camaras(id),
        date DATE NOT NULL,
        hour INT NOT NULL,
        detection_count INT DEFAULT 0,
        plate_recognized_count INT DEFAULT 0,
        blacklist_match_count INT DEFAULT 0,
        avg_confidence FLOAT NULL,
        avg_fps FLOAT NULL,
        created_at DATETIME DEFAULT GETDATE(),
        UNIQUE (camera_id, date, hour)
    );
END
GO

-- 5. Actualizar datos de ejemplo para múltiples cámaras
-- Insertar cámaras de ejemplo si no existen
IF NOT EXISTS (SELECT * FROM Camaras WHERE nombre = 'Entrada Principal')
BEGIN
    INSERT INTO Camaras (nombre, ip, rtsp_url, ubicacion, priority, is_active, region)
    VALUES 
        ('Entrada Principal', '10.126.9.104', 'rtsp://admin:password@10.126.9.104:554/Streaming/Channels/101', 'Acceso Principal - Zona 3', 1, 1, 'Ambato'),
        ('Entrada Secundaria', '10.126.9.105', 'rtsp://admin:password@10.126.9.105:554/Streaming/Channels/101', 'Acceso Secundario - Zona 3', 2, 1, 'Ambato'),
        ('Salida Personal', '10.126.9.106', 'rtsp://admin:password@10.126.9.106:554/Streaming/Channels/101', 'Salida Personal - Zona 3', 3, 0, 'Ambato');
END
GO

-- 6. Crear streams para las cámaras
DECLARE @camera_id INT;
DECLARE @camera_rtsp_url VARCHAR(255);

-- Cursor para insertar streams
DECLARE camera_cursor CURSOR FOR
SELECT id, rtsp_url FROM Camaras WHERE is_active = 1;

OPEN camera_cursor;
FETCH NEXT FROM camera_cursor INTO @camera_id, @camera_rtsp_url;

WHILE @@FETCH_STATUS = 0
BEGIN
    IF NOT EXISTS (SELECT * FROM CameraStreams WHERE camera_id = @camera_id)
    BEGIN
        INSERT INTO CameraStreams (camera_id, stream_url, stream_type, is_active)
        VALUES (@camera_id, @camera_rtsp_url, 'rtsp', 1);
    END
    
    FETCH NEXT FROM camera_cursor INTO @camera_id, @camera_rtsp_url;
END

CLOSE camera_cursor;
DEALLOCATE camera_cursor;
GO

PRINT 'Migración multi-cámara completada exitosamente.';