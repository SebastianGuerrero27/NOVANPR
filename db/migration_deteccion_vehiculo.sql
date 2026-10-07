USE ANPR_ECU911;
GO

-- 1. Whitelist de vehículos autorizados
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'VehiculosAutorizados')
BEGIN
    CREATE TABLE VehiculosAutorizados (
        id              INT IDENTITY(1,1) PRIMARY KEY,
        placa           VARCHAR(10)  NOT NULL UNIQUE,
        propietario     VARCHAR(150) NOT NULL,
        departamento    VARCHAR(100) NULL,
        tipo_vehiculo   VARCHAR(50)  NULL,
        activo          BIT DEFAULT 1,
        fecha_registro  DATETIME DEFAULT GETDATE()
    );
END
GO

-- 2. Tabla de Ingresos y Detecciones Vehiculares
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'DeteccionVehiculo')
BEGIN
    CREATE TABLE DeteccionVehiculo (
        id                          INT IDENTITY(1,1) PRIMARY KEY,
        tracking_id                 INT           NULL DEFAULT -1,
        ruta_imagen_ingreso         VARCHAR(255)  NULL,
        ruta_imagen_placa           VARCHAR(255)  NULL,
        fecha_hora_ingreso          DATETIME      DEFAULT GETDATE(),
        estado_procesamiento        VARCHAR(30)   NULL DEFAULT 'pendiente_ocr',
        placa_reconocida            VARCHAR(10)   NULL,
        confianza_deteccion         FLOAT         NULL,
        confianza_ocr               FLOAT         NULL,
        fecha_hora_procesamiento    DATETIME      NULL,
        estado_validacion           VARCHAR(30)   NULL DEFAULT 'pendiente_revision',
        fuente                      VARCHAR(20)   NULL DEFAULT 'webcam',
        camara_id                   INT           NULL FOREIGN KEY REFERENCES Camaras(id),
        alerta_id                   INT           NULL FOREIGN KEY REFERENCES ListaNegra(id),
        vehiculo_autorizado_id      INT           NULL FOREIGN KEY REFERENCES VehiculosAutorizados(id),
        validado_manualmente        BIT           DEFAULT 0,
        placa_validada              VARCHAR(10)   NULL,
        usuario_validador_id        INT           NULL FOREIGN KEY REFERENCES Usuarios(id)
    );
END
ELSE
BEGIN
    -- Migración en caso de que la tabla ya exista: añadir columnas si faltan
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('DeteccionVehiculo') AND name = 'validado_manualmente')
    BEGIN
        ALTER TABLE DeteccionVehiculo ADD validado_manualmente BIT DEFAULT 0;
    END
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('DeteccionVehiculo') AND name = 'placa_validada')
    BEGIN
        ALTER TABLE DeteccionVehiculo ADD placa_validada VARCHAR(10) NULL;
    END
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('DeteccionVehiculo') AND name = 'usuario_validador_id')
    BEGIN
        ALTER TABLE DeteccionVehiculo ADD usuario_validador_id INT NULL FOREIGN KEY REFERENCES Usuarios(id);
    END
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('DeteccionVehiculo') AND name = 'estado_procesamiento')
    BEGIN
        ALTER TABLE DeteccionVehiculo ADD estado_procesamiento VARCHAR(30) NULL DEFAULT 'pendiente_ocr';
    END
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('DeteccionVehiculo') AND name = 'ruta_imagen_ingreso')
    BEGIN
        ALTER TABLE DeteccionVehiculo ADD ruta_imagen_ingreso VARCHAR(255) NULL;
    END
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('DeteccionVehiculo') AND name = 'ruta_imagen_placa')
    BEGIN
        ALTER TABLE DeteccionVehiculo ADD ruta_imagen_placa VARCHAR(255) NULL;
    END
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('DeteccionVehiculo') AND name = 'placa_reconocida')
    BEGIN
        ALTER TABLE DeteccionVehiculo ADD placa_reconocida VARCHAR(10) NULL;
    END
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('DeteccionVehiculo') AND name = 'fecha_hora_procesamiento')
    BEGIN
        ALTER TABLE DeteccionVehiculo ADD fecha_hora_procesamiento DATETIME NULL;
    END
END
GO

-- (Se eliminó la siembra de vehículos de prueba: el sistema no precarga datos ficticios.)

-- 4. Fin de migración (cámaras registradas dinámicamente por el usuario)
GO

