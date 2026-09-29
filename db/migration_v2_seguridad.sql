-- =============================================================================
-- MIGRACIÓN v2: seguridad de cuentas y trazabilidad (bases existentes)
--
-- Idempotente: se ejecuta en cada arranque del backend y solo actúa si falta algo.
-- No borra datos: la tabla de usuarios v1 (username/rol en texto) se RENOMBRA a
-- Usuarios_v1_legacy. La limpieza de datos de prueba es un paso aparte y manual:
-- db/scripts/limpiar_datos_de_prueba.sql
-- =============================================================================

USE ANPR_ECU911;
GO

-- 1. Retirar la tabla de usuarios v1 (sin columna email) conservándola como legacy
IF OBJECT_ID('dbo.Usuarios') IS NOT NULL AND COL_LENGTH('dbo.Usuarios', 'email') IS NULL
BEGIN
    DECLARE @sql NVARCHAR(MAX) = N'';
    SELECT @sql += N'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(fk.parent_object_id)) + N'.'
                 + QUOTENAME(OBJECT_NAME(fk.parent_object_id)) + N' DROP CONSTRAINT ' + QUOTENAME(fk.name) + N'; '
    FROM sys.foreign_keys fk
    WHERE fk.referenced_object_id = OBJECT_ID('dbo.Usuarios');
    IF LEN(@sql) > 0 EXEC sp_executesql @sql;

    IF OBJECT_ID('dbo.Usuarios_v1_legacy') IS NULL
        EXEC sp_rename 'dbo.Usuarios', 'Usuarios_v1_legacy';
    PRINT '[DB v2] Tabla Usuarios v1 renombrada a Usuarios_v1_legacy.';
END
GO

-- 2. Catálogo de roles
IF OBJECT_ID('dbo.Roles') IS NULL
BEGIN
    CREATE TABLE Roles (
        id           INT IDENTITY(1,1) PRIMARY KEY,
        codigo       VARCHAR(20)   NOT NULL UNIQUE CHECK (codigo IN ('ADMIN', 'SUPERVISOR', 'OPERADOR')),
        nombre       NVARCHAR(50)  NOT NULL,
        descripcion  NVARCHAR(255) NULL
    );
END
GO
IF NOT EXISTS (SELECT 1 FROM Roles WHERE codigo = 'ADMIN')
    INSERT INTO Roles (codigo, nombre, descripcion) VALUES ('ADMIN', N'Administrador', N'Gestión total: usuarios, cámaras, listas, configuración y auditoría.');
IF NOT EXISTS (SELECT 1 FROM Roles WHERE codigo = 'SUPERVISOR')
    INSERT INTO Roles (codigo, nombre, descripcion) VALUES ('SUPERVISOR', N'Supervisor', N'Gestión de listas, reportes, evaluación del sistema y validación de ingresos.');
IF NOT EXISTS (SELECT 1 FROM Roles WHERE codigo = 'OPERADOR')
    INSERT INTO Roles (codigo, nombre, descripcion) VALUES ('OPERADOR', N'Operador', N'Monitoreo en vivo y validación de ingresos vehiculares.');
GO

-- 3. Usuarios v2
IF OBJECT_ID('dbo.Usuarios') IS NULL
BEGIN
    CREATE TABLE Usuarios (
        id                      INT IDENTITY(1,1) PRIMARY KEY,
        email                   NVARCHAR(150) NOT NULL UNIQUE,
        nombre_completo         NVARCHAR(150) NOT NULL,
        cargo                   NVARCHAR(100) NULL,
        password_hash           VARCHAR(100)  NOT NULL,
        rol_id                  INT           NOT NULL REFERENCES Roles(id),
        estado                  VARCHAR(20)   NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'activo', 'inactivo')),
        email_verificado        BIT           NOT NULL DEFAULT 0,
        bloqueado               BIT           NOT NULL DEFAULT 0,
        bloqueado_hasta         DATETIME2     NULL,
        intentos_fallidos       INT           NOT NULL DEFAULT 0,
        fecha_ultimo_acceso     DATETIME2     NULL,
        fecha_cambio_password   DATETIME2     NULL,
        creado_por              INT           NULL REFERENCES Usuarios(id),
        fecha_creacion          DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
        fecha_actualizacion     DATETIME2     NULL
    );
    CREATE INDEX IX_Usuarios_Rol_Estado ON Usuarios (rol_id, estado);
    PRINT '[DB v2] Tabla Usuarios v2 creada.';
END
GO

-- 4. Tablas de seguridad
IF OBJECT_ID('dbo.VerificacionEmail') IS NULL
BEGIN
    CREATE TABLE VerificacionEmail (
        id                INT IDENTITY(1,1) PRIMARY KEY,
        usuario_id        INT       NOT NULL REFERENCES Usuarios(id) ON DELETE CASCADE,
        token_hash        CHAR(64)  NOT NULL,
        fecha_creacion    DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        fecha_expiracion  DATETIME2 NOT NULL,
        usado             BIT       NOT NULL DEFAULT 0,
        fecha_uso         DATETIME2 NULL
    );
    CREATE INDEX IX_VerificacionEmail_Token ON VerificacionEmail (token_hash);
END
GO

IF OBJECT_ID('dbo.RestablecimientoPassword') IS NULL
BEGIN
    CREATE TABLE RestablecimientoPassword (
        id                INT IDENTITY(1,1) PRIMARY KEY,
        usuario_id        INT       NOT NULL REFERENCES Usuarios(id) ON DELETE CASCADE,
        token_hash        CHAR(64)  NOT NULL,
        fecha_creacion    DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        fecha_expiracion  DATETIME2 NOT NULL,
        usado             BIT       NOT NULL DEFAULT 0,
        fecha_uso         DATETIME2 NULL
    );
    CREATE INDEX IX_RestablecimientoPassword_Token ON RestablecimientoPassword (token_hash);
END
GO

IF OBJECT_ID('dbo.AuditoriaUsuarios') IS NULL
BEGIN
    CREATE TABLE AuditoriaUsuarios (
        id              BIGINT IDENTITY(1,1) PRIMARY KEY,
        fecha           DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
        accion          VARCHAR(50)   NOT NULL,
        actor_id        INT           NULL REFERENCES Usuarios(id),
        actor_email     NVARCHAR(150) NULL,
        objetivo_id     INT           NULL,
        objetivo_email  NVARCHAR(150) NULL,
        detalle         NVARCHAR(500) NULL,
        ip              VARCHAR(45)   NULL
    );
    CREATE INDEX IX_AuditoriaUsuarios_Fecha ON AuditoriaUsuarios (fecha DESC);
END
GO

IF OBJECT_ID('dbo.AuditoriaAccesos') IS NULL
BEGIN
    CREATE TABLE AuditoriaAccesos (
        id          BIGINT IDENTITY(1,1) PRIMARY KEY,
        fecha       DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
        email       NVARCHAR(150) NOT NULL,
        usuario_id  INT           NULL REFERENCES Usuarios(id),
        exito       BIT           NOT NULL,
        motivo      VARCHAR(50)   NULL,
        ip          VARCHAR(45)   NULL,
        user_agent  NVARCHAR(255) NULL
    );
    CREATE INDEX IX_AuditoriaAccesos_Fecha ON AuditoriaAccesos (fecha DESC);
    CREATE INDEX IX_AuditoriaAccesos_Email ON AuditoriaAccesos (email, fecha DESC);
END
GO

-- 5. Trazabilidad en cámaras y listas
IF COL_LENGTH('dbo.Camaras', 'registrado_por') IS NULL
    ALTER TABLE Camaras ADD registrado_por INT NULL, fecha_actualizacion DATETIME2 NULL;
GO
IF COL_LENGTH('dbo.ListaNegra', 'registrado_por') IS NULL
    ALTER TABLE ListaNegra ADD registrado_por INT NULL, fecha_actualizacion DATETIME2 NULL;
GO
IF COL_LENGTH('dbo.VehiculosAutorizados', 'registrado_por') IS NULL
    ALTER TABLE VehiculosAutorizados ADD registrado_por INT NULL, fecha_actualizacion DATETIME2 NULL;
GO
IF COL_LENGTH('dbo.VehiculosAutorizados', 'fecha_vencimiento') IS NULL
    ALTER TABLE VehiculosAutorizados ADD fecha_vencimiento DATE NULL, observaciones NVARCHAR(255) NULL;
GO

-- 6. Claves foráneas hacia Usuarios v2. Las referencias a usuarios v1 no existen en la tabla
--    nueva: se anulan (validador) o se conservan sin verificar (auditoría histórica).
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Deteccion_UsuarioValidador')
BEGIN
    UPDATE DeteccionVehiculo SET usuario_validador_id = NULL
    WHERE usuario_validador_id IS NOT NULL AND usuario_validador_id NOT IN (SELECT id FROM Usuarios);
    ALTER TABLE DeteccionVehiculo ADD CONSTRAINT FK_Deteccion_UsuarioValidador
        FOREIGN KEY (usuario_validador_id) REFERENCES Usuarios(id);
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Camaras_RegistradoPor')
    ALTER TABLE Camaras ADD CONSTRAINT FK_Camaras_RegistradoPor FOREIGN KEY (registrado_por) REFERENCES Usuarios(id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_ListaNegra_RegistradoPor')
    ALTER TABLE ListaNegra ADD CONSTRAINT FK_ListaNegra_RegistradoPor FOREIGN KEY (registrado_por) REFERENCES Usuarios(id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Autorizados_RegistradoPor')
    ALTER TABLE VehiculosAutorizados ADD CONSTRAINT FK_Autorizados_RegistradoPor FOREIGN KEY (registrado_por) REFERENCES Usuarios(id);
GO
IF OBJECT_ID('dbo.AuditoriaConsultaPropietario') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_AuditoriaPropietario_Usuario')
    ALTER TABLE AuditoriaConsultaPropietario WITH NOCHECK
        ADD CONSTRAINT FK_AuditoriaPropietario_Usuario FOREIGN KEY (usuario_id) REFERENCES Usuarios(id);
GO

-- 7. Tabla heredada EventosIngreso (reemplazada por DeteccionVehiculo): se elimina si está vacía
-- (SQL dinámico: una referencia directa falla al compilar si la tabla ya no existe)
IF OBJECT_ID('dbo.EventosIngreso') IS NOT NULL
    EXEC(N'IF NOT EXISTS (SELECT 1 FROM dbo.EventosIngreso) DROP TABLE dbo.EventosIngreso;');
GO

PRINT '[DB v2] Migración de seguridad verificada.';
GO
