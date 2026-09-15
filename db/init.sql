-- =============================================================================
-- PROYECTO DE TITULACIÓN: SISTEMA ANPR - ECU 911 ZONA 3
-- BASE DE DATOS TRANSACCIONAL MAESTRA (SQL SERVER 2022)
-- =============================================================================

-- 1. Crear Base de Datos si no existe
IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = 'ANPR_ECU911')
BEGIN
    CREATE DATABASE ANPR_ECU911;
END
GO

USE ANPR_ECU911;
GO

-- =============================================================================
-- 2. TABLA: Usuarios (Gestión de Cuentas, Login JWT y Control de Roles)
-- =============================================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Usuarios')
BEGIN
    CREATE TABLE Usuarios (
        id             INT IDENTITY(1,1) PRIMARY KEY,
        username       VARCHAR(50)  NOT NULL UNIQUE,
        password_hash  VARCHAR(255) NOT NULL,
        nombre         VARCHAR(100) NOT NULL,
        rol            VARCHAR(20)  NOT NULL CHECK (rol IN ('Admin', 'Operador')),
        activo         BIT DEFAULT 1,
        created_at     DATETIME DEFAULT GETDATE()
    );
END
GO

-- =============================================================================
-- 3. TABLA: Camaras (Canales de Video, Streaming RTSP / HTTP y Ubicaciones)
-- =============================================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Camaras')
BEGIN
    CREATE TABLE Camaras (
        id          INT IDENTITY(1,1) PRIMARY KEY,
        nombre      VARCHAR(100) NOT NULL,
        ip          VARCHAR(45)  NOT NULL,
        rtsp_url    VARCHAR(255) NOT NULL,
        ubicacion   VARCHAR(150) NOT NULL,
        activa      BIT DEFAULT 1,
        created_at  DATETIME DEFAULT GETDATE()
    );
END
GO

-- =============================================================================
-- 4. TABLA: ListaNegra (Vehículos Sospechosos / Encargo Judicial / Alertas)
-- =============================================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ListaNegra')
BEGIN
    CREATE TABLE ListaNegra (
        id              INT IDENTITY(1,1) PRIMARY KEY,
        placa           VARCHAR(10)  NOT NULL UNIQUE,
        motivo          VARCHAR(255) NOT NULL,
        nivel_alerta    VARCHAR(20)  DEFAULT 'ALTA' CHECK (nivel_alerta IN ('CRITICA', 'ALTA', 'MEDIA')),
        fecha_registro  DATETIME     DEFAULT GETDATE(),
        activo          BIT          DEFAULT 1
    );
END
GO

-- =============================================================================
-- 5. TABLA: VehiculosAutorizados (Lista Blanca / Padrón Vehicular Institucional)
-- =============================================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'VehiculosAutorizados')
BEGIN
    CREATE TABLE VehiculosAutorizados (
        id              INT IDENTITY(1,1) PRIMARY KEY,
        placa           VARCHAR(10)  NOT NULL UNIQUE,
        propietario     VARCHAR(150) NOT NULL,
        departamento    VARCHAR(100) NULL,
        tipo_vehiculo   VARCHAR(50)  NULL,
        activo          BIT          DEFAULT 1,
        fecha_registro  DATETIME     DEFAULT GETDATE()
    );
END
GO

-- =============================================================================
-- 6. TABLA: DeteccionVehiculo (Registro Central de Ingresos en 2 Fases YOLO+OCR)
-- =============================================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'DeteccionVehiculo')
BEGIN
    CREATE TABLE DeteccionVehiculo (
        id                          INT IDENTITY(1,1) PRIMARY KEY,
        tracking_id                 INT           NULL DEFAULT -1,
        ruta_imagen_ingreso         VARCHAR(255)  NULL,
        ruta_imagen_placa           VARCHAR(255)  NULL,
        fecha_hora_ingreso          DATETIME      DEFAULT GETDATE(),
        estado_procesamiento        VARCHAR(30)   NULL DEFAULT 'pendiente_ocr',  -- pendiente_ocr, procesado, no_legible
        placa_reconocida            VARCHAR(10)   NULL,
        confianza_deteccion         FLOAT         NULL,
        confianza_ocr               FLOAT         NULL,
        fecha_hora_procesamiento    DATETIME      NULL,
        estado_validacion           VARCHAR(30)   NULL DEFAULT 'pendiente_revision', -- autorizado, alerta, no_reconocido, pendiente_revision
        fuente                      VARCHAR(20)   NULL DEFAULT 'webcam',
        camara_id                   INT           NULL FOREIGN KEY REFERENCES Camaras(id),
        alerta_id                   INT           NULL FOREIGN KEY REFERENCES ListaNegra(id),
        vehiculo_autorizado_id      INT           NULL FOREIGN KEY REFERENCES VehiculosAutorizados(id),
        validado_manualmente        BIT           DEFAULT 0,
        placa_validada              VARCHAR(10)   NULL,
        usuario_validador_id        INT           NULL FOREIGN KEY REFERENCES Usuarios(id),
        -- Columnas de compatibilidad histórica
        placa                       VARCHAR(10)   NULL,
        fecha_hora                  DATETIME      DEFAULT GETDATE(),
        imagen_vehiculo_path        VARCHAR(255)  NULL,
        imagen_placa_path           VARCHAR(255)  NULL
    );
END
GO

-- =============================================================================
-- 7. TABLA: EventosIngreso (Tabla de Compatibilidad y Respaldo)
-- =============================================================================
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'EventosIngreso')
BEGIN
    CREATE TABLE EventosIngreso (
        id                      INT IDENTITY(1,1) PRIMARY KEY,
        placa                   VARCHAR(10)  NOT NULL,
        confianza_placa         FLOAT        NOT NULL,
        imagen_vehiculo_path    VARCHAR(255) NULL,
        imagen_placa_path       VARCHAR(255) NULL,
        fecha_hora              DATETIME     DEFAULT GETDATE(),
        camara_id               INT          FOREIGN KEY REFERENCES Camaras(id),
        usuario_validador_id    INT          FOREIGN KEY REFERENCES Usuarios(id) NULL,
        validado_manualmente    BIT          DEFAULT 0,
        placa_validada          VARCHAR(10)  NULL,
        alerta_detectada        BIT          DEFAULT 0,
        alerta_id               INT          FOREIGN KEY REFERENCES ListaNegra(id) NULL
    );
END
GO

-- =============================================================================
-- 8. ÍNDICES DE ALTO RENDIMIENTO (Consultas Instantáneas y Filtros en Tiempo Real)
-- =============================================================================
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_Deteccion_FechaHora' AND object_id = OBJECT_ID('DeteccionVehiculo'))
BEGIN
    CREATE NONCLUSTERED INDEX IX_Deteccion_FechaHora ON DeteccionVehiculo (fecha_hora_ingreso DESC);
END
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_Deteccion_Placa' AND object_id = OBJECT_ID('DeteccionVehiculo'))
BEGIN
    CREATE NONCLUSTERED INDEX IX_Deteccion_Placa ON DeteccionVehiculo (placa_reconocida);
END
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_Deteccion_Estado' AND object_id = OBJECT_ID('DeteccionVehiculo'))
BEGIN
    CREATE NONCLUSTERED INDEX IX_Deteccion_Estado ON DeteccionVehiculo (estado_validacion, estado_procesamiento);
END
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_ListaNegra_PlacaActivo' AND object_id = OBJECT_ID('ListaNegra'))
BEGIN
    CREATE NONCLUSTERED INDEX IX_ListaNegra_PlacaActivo ON ListaNegra (placa, activo);
END
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_VehiculosAutorizados_PlacaActivo' AND object_id = OBJECT_ID('VehiculosAutorizados'))
BEGIN
    CREATE NONCLUSTERED INDEX IX_VehiculosAutorizados_PlacaActivo ON VehiculosAutorizados (placa, activo);
END
GO

-- =============================================================================
-- 9. DATOS DE SIEMBRA INICIALES (Vehículos y Listas - Cámaras dinámicas del usuario)
-- =============================================================================


-- Sembrar vehículos autorizados institucionales de prueba
IF NOT EXISTS (SELECT * FROM VehiculosAutorizados WHERE placa = 'PBA5678')
BEGIN
    INSERT INTO VehiculosAutorizados (placa, propietario, departamento, tipo_vehiculo, activo)
    VALUES
        ('PBA5678', 'Coordinación Zonal 3 - ECU 911', 'Dirección', 'Institucional', 1),
        ('TCA9012', 'Ing. Carlos Medina', 'Operaciones', 'Funcionario', 1),
        ('ABC999',  'Prueba Sistema ANPR', 'Desarrollo / Tesis', 'Prueba', 1);
END
GO

-- Sembrar alertas en Lista Negra
IF NOT EXISTS (SELECT * FROM ListaNegra WHERE placa = 'PBA-1234')
BEGIN
    INSERT INTO ListaNegra (placa, motivo, nivel_alerta, activo, fecha_registro)
    VALUES
        ('PBA-1234', 'Vehículo reportado por robo en Ambato', 'CRITICA', 1, GETDATE()),
        ('TBG-987',  'Vehículo sospechoso involucrado en asalto', 'ALTA', 1, GETDATE());
END
GO
