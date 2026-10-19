-- =============================================================================
-- Sistema ANPR · ECU 911 Coordinación Zonal 3 · Esquema completo de la base de datos
-- SQL Server 2022 · equivale a db/init.sql + todas las migraciones hasta la v12
-- Generado el 2026-10-15 desde el catálogo de una base con todas las migraciones aplicadas.
--
-- Crea la base (si no existe), 23 tablas, sus valores por omisión, restricciones CHECK,
-- claves primarias y únicas, claves foráneas e índices, y el catálogo de roles. Es idempotente: lo
-- que ya existe no se vuelve a crear. No crea usuarios, cámaras ni datos de prueba: el primer
-- administrador se crea en la pantalla de configuración inicial del sistema.
--
-- Ejecución: sqlcmd -S <servidor> -U sa -P "<contraseña>" -C -i esquema_completo.sql
-- (o en SQL Server Management Studio / Azure Data Studio, que entienden los separadores GO).
-- Al arrancar, el backend vuelve a recorrer las migraciones; todas son idempotentes y solo registran
-- su suma SHA-256 en SchemaMigraciones.
-- =============================================================================

IF DB_ID(N'ANPR_ECU911') IS NULL
    CREATE DATABASE [ANPR_ECU911];
GO
USE [ANPR_ECU911];
GO
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- ─────────────────────────────── Tablas ───────────────────────────────

IF OBJECT_ID(N'dbo.Roles', N'U') IS NULL
CREATE TABLE dbo.[Roles] (
    [id] INT IDENTITY(1, 1) NOT NULL,
    [codigo] VARCHAR(20) NOT NULL,
    [nombre] NVARCHAR(50) NOT NULL,
    [descripcion] NVARCHAR(255) NULL,
    PRIMARY KEY CLUSTERED ([id]),
    UNIQUE NONCLUSTERED ([codigo])
);
GO

IF OBJECT_ID(N'dbo.Usuarios', N'U') IS NULL
CREATE TABLE dbo.[Usuarios] (
    [id] INT IDENTITY(1, 1) NOT NULL,
    [email] NVARCHAR(150) NOT NULL,
    [nombre_completo] NVARCHAR(150) NOT NULL,
    [cargo] NVARCHAR(100) NULL,
    [password_hash] VARCHAR(100) NOT NULL,
    [rol_id] INT NOT NULL,
    [estado] VARCHAR(20) NOT NULL DEFAULT ('pendiente'),
    [email_verificado] BIT NOT NULL DEFAULT ((0)),
    [bloqueado] BIT NOT NULL DEFAULT ((0)),
    [bloqueado_hasta] DATETIME2(7) NULL,
    [intentos_fallidos] INT NOT NULL DEFAULT ((0)),
    [fecha_ultimo_acceso] DATETIME2(7) NULL,
    [fecha_cambio_password] DATETIME2(7) NULL,
    [creado_por] INT NULL,
    [fecha_creacion] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    [fecha_actualizacion] DATETIME2(7) NULL,
    PRIMARY KEY CLUSTERED ([id]),
    UNIQUE NONCLUSTERED ([email]),
    CHECK ([estado]='inactivo' OR [estado]='activo' OR [estado]='pendiente')
);
GO

IF OBJECT_ID(N'dbo.AuditoriaAccesos', N'U') IS NULL
CREATE TABLE dbo.[AuditoriaAccesos] (
    [id] BIGINT IDENTITY(1, 1) NOT NULL,
    [fecha] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    [email] NVARCHAR(150) NOT NULL,
    [usuario_id] INT NULL,
    [exito] BIT NOT NULL,
    [motivo] VARCHAR(50) NULL,
    [ip] VARCHAR(45) NULL,
    [user_agent] NVARCHAR(255) NULL,
    PRIMARY KEY CLUSTERED ([id])
);
GO

IF OBJECT_ID(N'dbo.AuditoriaAccesosArchivo', N'U') IS NULL
CREATE TABLE dbo.[AuditoriaAccesosArchivo] (
    [id] BIGINT NOT NULL,
    [fecha] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    [email] NVARCHAR(150) NOT NULL,
    [usuario_id] INT NULL,
    [exito] BIT NOT NULL,
    [motivo] VARCHAR(50) NULL,
    [ip] VARCHAR(45) NULL,
    [user_agent] NVARCHAR(255) NULL,
    [fecha_archivado] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    PRIMARY KEY CLUSTERED ([id])
);
GO

IF OBJECT_ID(N'dbo.AuditoriaConsultaPropietario', N'U') IS NULL
CREATE TABLE dbo.[AuditoriaConsultaPropietario] (
    [id] INT IDENTITY(1, 1) NOT NULL,
    [usuario_id] INT NOT NULL,
    [usuario_nombre] VARCHAR(100) NULL,
    [placa] VARCHAR(20) NOT NULL,
    [motivo] VARCHAR(255) NOT NULL,
    [deteccion_id] INT NULL,
    [proveedor] VARCHAR(50) NOT NULL,
    [resultado] VARCHAR(20) NOT NULL,
    [fecha] DATETIME NULL DEFAULT (getdate()),
    PRIMARY KEY CLUSTERED ([id])
);
GO

IF OBJECT_ID(N'dbo.AuditoriaDescartes', N'U') IS NULL
CREATE TABLE dbo.[AuditoriaDescartes] (
    [id] INT IDENTITY(1, 1) NOT NULL,
    [tracking_id] INT NULL,
    [motivo] VARCHAR(100) NOT NULL,
    [texto_candidato] VARCHAR(50) NULL,
    [confianza] FLOAT NULL,
    [fuente] VARCHAR(255) NULL,
    [camara_id] INT NULL,
    [fecha_registro] DATETIME NULL DEFAULT (getdate()),
    PRIMARY KEY CLUSTERED ([id])
);
GO

IF OBJECT_ID(N'dbo.AuditoriaOperaciones', N'U') IS NULL
CREATE TABLE dbo.[AuditoriaOperaciones] (
    [id] BIGINT IDENTITY(1, 1) NOT NULL,
    [fecha] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    [usuario_id] INT NULL,
    [usuario_email] NVARCHAR(150) NULL,
    [accion] VARCHAR(50) NOT NULL,
    [entidad] VARCHAR(40) NOT NULL,
    [entidad_id] INT NULL,
    [detalle] NVARCHAR(500) NULL,
    [ip] VARCHAR(45) NULL,
    PRIMARY KEY CLUSTERED ([id])
);
GO

IF OBJECT_ID(N'dbo.AuditoriaOperacionesArchivo', N'U') IS NULL
CREATE TABLE dbo.[AuditoriaOperacionesArchivo] (
    [id] BIGINT NOT NULL,
    [fecha] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    [usuario_id] INT NULL,
    [usuario_email] NVARCHAR(150) NULL,
    [accion] VARCHAR(50) NOT NULL,
    [entidad] VARCHAR(40) NOT NULL,
    [entidad_id] INT NULL,
    [detalle] NVARCHAR(500) NULL,
    [ip] VARCHAR(45) NULL,
    [fecha_archivado] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    PRIMARY KEY CLUSTERED ([id])
);
GO

IF OBJECT_ID(N'dbo.AuditoriaUsuarios', N'U') IS NULL
CREATE TABLE dbo.[AuditoriaUsuarios] (
    [id] BIGINT IDENTITY(1, 1) NOT NULL,
    [fecha] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    [accion] VARCHAR(50) NOT NULL,
    [actor_id] INT NULL,
    [actor_email] NVARCHAR(150) NULL,
    [objetivo_id] INT NULL,
    [objetivo_email] NVARCHAR(150) NULL,
    [detalle] NVARCHAR(500) NULL,
    [ip] VARCHAR(45) NULL,
    PRIMARY KEY CLUSTERED ([id])
);
GO

IF OBJECT_ID(N'dbo.AuditoriaUsuariosArchivo', N'U') IS NULL
CREATE TABLE dbo.[AuditoriaUsuariosArchivo] (
    [id] BIGINT NOT NULL,
    [fecha] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    [accion] VARCHAR(50) NOT NULL,
    [actor_id] INT NULL,
    [actor_email] NVARCHAR(150) NULL,
    [objetivo_id] INT NULL,
    [objetivo_email] NVARCHAR(150) NULL,
    [detalle] NVARCHAR(500) NULL,
    [ip] VARCHAR(45) NULL,
    [fecha_archivado] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    PRIMARY KEY CLUSTERED ([id])
);
GO

IF OBJECT_ID(N'dbo.Camaras', N'U') IS NULL
CREATE TABLE dbo.[Camaras] (
    [id] INT IDENTITY(1, 1) NOT NULL,
    [nombre] VARCHAR(100) NOT NULL,
    [ip] VARCHAR(45) NOT NULL,
    [rtsp_url] VARCHAR(512) NOT NULL,
    [ubicacion] VARCHAR(150) NOT NULL,
    [activa] BIT NULL DEFAULT ((1)),
    [created_at] DATETIME NULL DEFAULT (getdate()),
    [estado] VARCHAR(20) NULL DEFAULT ('ACTIVA'),
    [ultimo_ping] DATETIME NULL,
    [tiempo_respuesta_ms] INT NULL,
    [mensaje_ping] VARCHAR(255) NULL,
    [registrado_por] INT NULL,
    [fecha_actualizacion] DATETIME2(7) NULL,
    [roi] NVARCHAR(1000) NULL,
    [rtsp_url_vista] VARCHAR(512) NULL,
    [exclusiones] NVARCHAR(MAX) NULL,
    PRIMARY KEY CLUSTERED ([id])
);
GO

IF OBJECT_ID(N'dbo.ClavesServicio', N'U') IS NULL
CREATE TABLE dbo.[ClavesServicio] (
    [clave] VARCHAR(60) NOT NULL,
    [valor] NVARCHAR(1000) NOT NULL,
    [fecha_creacion] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    PRIMARY KEY CLUSTERED ([clave])
);
GO

IF OBJECT_ID(N'dbo.ConfiguracionSistema', N'U') IS NULL
CREATE TABLE dbo.[ConfiguracionSistema] (
    [clave] VARCHAR(60) NOT NULL,
    [valor] NVARCHAR(500) NOT NULL,
    [actualizado_por] INT NULL,
    [fecha_actualizacion] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    PRIMARY KEY CLUSTERED ([clave])
);
GO

IF OBJECT_ID(N'dbo.ListaNegra', N'U') IS NULL
CREATE TABLE dbo.[ListaNegra] (
    [id] INT IDENTITY(1, 1) NOT NULL,
    [placa] VARCHAR(10) NOT NULL,
    [motivo] VARCHAR(255) NOT NULL,
    [nivel_alerta] VARCHAR(20) NULL DEFAULT ('ALTA'),
    [fecha_registro] DATETIME NULL DEFAULT (getdate()),
    [activo] BIT NULL DEFAULT ((1)),
    [marca] VARCHAR(50) NULL,
    [modelo] VARCHAR(50) NULL,
    [color] VARCHAR(30) NULL,
    [registrado_por] INT NULL,
    [fecha_actualizacion] DATETIME2(7) NULL,
    [fecha_vencimiento] DATE NULL,
    [observaciones] NVARCHAR(255) NULL,
    PRIMARY KEY CLUSTERED ([id]),
    UNIQUE NONCLUSTERED ([placa]),
    CHECK ([nivel_alerta]='MEDIA' OR [nivel_alerta]='ALTA' OR [nivel_alerta]='CRITICA')
);
GO

IF OBJECT_ID(N'dbo.VehiculosAutorizados', N'U') IS NULL
CREATE TABLE dbo.[VehiculosAutorizados] (
    [id] INT IDENTITY(1, 1) NOT NULL,
    [placa] VARCHAR(10) NOT NULL,
    [propietario] VARCHAR(150) NOT NULL,
    [departamento] VARCHAR(100) NULL,
    [tipo_vehiculo] VARCHAR(50) NULL,
    [activo] BIT NULL DEFAULT ((1)),
    [fecha_registro] DATETIME NULL DEFAULT (getdate()),
    [marca] VARCHAR(50) NULL,
    [modelo] VARCHAR(50) NULL,
    [color] VARCHAR(30) NULL,
    [registrado_por] INT NULL,
    [fecha_actualizacion] DATETIME2(7) NULL,
    [fecha_vencimiento] DATE NULL,
    [observaciones] NVARCHAR(255) NULL,
    [categoria] VARCHAR(20) NOT NULL CONSTRAINT [DF_VehiculosAutorizados_Categoria] DEFAULT ('FUNCIONARIO'),
    [fecha_inicio] DATE NULL,
    [horario] NVARCHAR(600) NULL,
    [solicitud_id] INT NULL,
    PRIMARY KEY CLUSTERED ([id]),
    UNIQUE NONCLUSTERED ([placa]),
    CONSTRAINT [CK_VehiculosAutorizados_Categoria] CHECK ([categoria]='EMERGENCIA' OR [categoria]='OFICIAL' OR [categoria]='CONTRATISTA' OR [categoria]='PROVEEDOR' OR [categoria]='VISITANTE' OR [categoria]='FUNCIONARIO')
);
GO

IF OBJECT_ID(N'dbo.DeteccionVehiculo', N'U') IS NULL
CREATE TABLE dbo.[DeteccionVehiculo] (
    [id] INT IDENTITY(1, 1) NOT NULL,
    [confianza_deteccion] FLOAT NULL,
    [confianza_ocr] FLOAT NULL,
    [tracking_id] INT NULL DEFAULT ((-1)),
    [fuente] VARCHAR(255) NULL CONSTRAINT [DF_DeteccionVehiculo_fuente] DEFAULT ('rtsp'),
    [estado_validacion] VARCHAR(30) NULL DEFAULT ('no_reconocido'),
    [camara_id] INT NULL,
    [alerta_id] INT NULL,
    [vehiculo_autorizado_id] INT NULL,
    [estado_procesamiento] VARCHAR(30) NULL DEFAULT ('pendiente_ocr'),
    [ruta_imagen_ingreso] VARCHAR(255) NULL,
    [ruta_imagen_placa] VARCHAR(255) NULL,
    [fecha_hora_ingreso] DATETIME NULL DEFAULT (getdate()),
    [placa_reconocida] VARCHAR(20) NULL,
    [fecha_hora_procesamiento] DATETIME NULL,
    [validado_manualmente] BIT NULL DEFAULT ((0)),
    [placa_validada] VARCHAR(20) NULL,
    [usuario_validador_id] INT NULL,
    [tipo_vehiculo] VARCHAR(50) NULL,
    [placa_ocr_original] VARCHAR(20) NULL,
    [confianza_ocr_original] FLOAT NULL,
    [decision_automatica] VARCHAR(30) NULL,
    [lectura_verificador] VARCHAR(20) NULL,
    [latencia_ms] INT NULL,
    [luminancia_media] FLOAT NULL,
    [distancia_estimada_m] FLOAT NULL,
    [ancho_placa_px] INT NULL,
    [nitidez] FLOAT NULL,
    [velocidad_px_s] FLOAT NULL,
    [condicion_clima] VARCHAR(20) NULL,
    [modelo_detector] VARCHAR(100) NULL,
    [modelo_ocr] VARCHAR(100) NULL,
    [fecha_validacion] DATETIME NULL,
    [vehiculo_tipo] VARCHAR(30) NULL,
    [vehiculo_color] VARCHAR(30) NULL,
    [vehiculo_marca] VARCHAR(50) NULL,
    [vehiculo_modelo] VARCHAR(50) NULL,
    [vehiculo_atributos_json] NVARCHAR(500) NULL,
    [verificacion_vehiculo] VARCHAR(20) NULL,
    [verificacion_detalle] VARCHAR(255) NULL,
    [lectura_valida] BIT NULL,
    [evidencia_lectura] NVARCHAR(1500) NULL,
    [restriccion_acceso] VARCHAR(30) NULL,
    PRIMARY KEY CLUSTERED ([id])
);
GO

IF OBJECT_ID(N'dbo.Notificaciones', N'U') IS NULL
CREATE TABLE dbo.[Notificaciones] (
    [id] BIGINT IDENTITY(1, 1) NOT NULL,
    [tipo] VARCHAR(40) NOT NULL,
    [severidad] VARCHAR(10) NOT NULL,
    [titulo] NVARCHAR(150) NOT NULL,
    [mensaje] NVARCHAR(500) NOT NULL,
    [enlace] VARCHAR(200) NULL,
    [datos] NVARCHAR(1000) NULL,
    [clave_dedup] VARCHAR(120) NULL,
    [repeticiones] INT NOT NULL DEFAULT ((1)),
    [requiere_ack] BIT NOT NULL DEFAULT ((0)),
    [deteccion_id] INT NULL,
    [fecha_creacion] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    [fecha_ultima] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    [atendida_por] INT NULL,
    [fecha_atencion] DATETIME2(7) NULL,
    [fecha_resolucion] DATETIME2(7) NULL,
    [escalada] BIT NOT NULL DEFAULT ((0)),
    [fecha_escalamiento] DATETIME2(7) NULL,
    PRIMARY KEY CLUSTERED ([id]),
    CHECK ([severidad]='baja' OR [severidad]='media' OR [severidad]='alta' OR [severidad]='critica')
);
GO

IF OBJECT_ID(N'dbo.NotificacionUsuario', N'U') IS NULL
CREATE TABLE dbo.[NotificacionUsuario] (
    [notificacion_id] BIGINT NOT NULL,
    [usuario_id] INT NOT NULL,
    [fecha_lectura] DATETIME2(7) NULL,
    [fecha_eliminacion] DATETIME2(7) NULL,
    CONSTRAINT [PK_NotificacionUsuario] PRIMARY KEY CLUSTERED ([notificacion_id], [usuario_id])
);
GO

IF OBJECT_ID(N'dbo.RestablecimientoPassword', N'U') IS NULL
CREATE TABLE dbo.[RestablecimientoPassword] (
    [id] INT IDENTITY(1, 1) NOT NULL,
    [usuario_id] INT NOT NULL,
    [token_hash] CHAR(64) NOT NULL,
    [fecha_creacion] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    [fecha_expiracion] DATETIME2(7) NOT NULL,
    [usado] BIT NOT NULL DEFAULT ((0)),
    [fecha_uso] DATETIME2(7) NULL,
    PRIMARY KEY CLUSTERED ([id])
);
GO

IF OBJECT_ID(N'dbo.SchemaMigraciones', N'U') IS NULL
CREATE TABLE dbo.[SchemaMigraciones] (
    [nombre] VARCHAR(120) NOT NULL,
    [suma_sha256] CHAR(64) NOT NULL,
    [fecha_aplicada] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    PRIMARY KEY CLUSTERED ([nombre])
);
GO

IF OBJECT_ID(N'dbo.SolicitudesAcceso', N'U') IS NULL
CREATE TABLE dbo.[SolicitudesAcceso] (
    [id] INT IDENTITY(1, 1) NOT NULL,
    [placa] VARCHAR(10) NOT NULL,
    [propietario] NVARCHAR(150) NOT NULL,
    [departamento] NVARCHAR(100) NULL,
    [categoria] VARCHAR(20) NOT NULL DEFAULT ('VISITANTE'),
    [motivo] NVARCHAR(300) NOT NULL,
    [tipo_vehiculo] VARCHAR(50) NULL,
    [marca] VARCHAR(50) NULL,
    [modelo] VARCHAR(50) NULL,
    [color] VARCHAR(30) NULL,
    [fecha_inicio] DATE NULL,
    [fecha_fin] DATE NULL,
    [horario] NVARCHAR(600) NULL,
    [deteccion_id] INT NULL,
    [estado] VARCHAR(20) NOT NULL DEFAULT ('pendiente'),
    [solicitado_por] INT NOT NULL,
    [fecha_solicitud] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    [resuelto_por] INT NULL,
    [fecha_resolucion] DATETIME2(7) NULL,
    [comentario_resolucion] NVARCHAR(300) NULL,
    [vehiculo_autorizado_id] INT NULL,
    [version] INT NOT NULL CONSTRAINT [DF_SolicitudesAcceso_version] DEFAULT ((1)),
    PRIMARY KEY CLUSTERED ([id]),
    CHECK ([estado]='cancelada' OR [estado]='rechazada' OR [estado]='aprobada' OR [estado]='pendiente')
);
GO

IF OBJECT_ID(N'dbo.SuscripcionesPush', N'U') IS NULL
CREATE TABLE dbo.[SuscripcionesPush] (
    [id] INT IDENTITY(1, 1) NOT NULL,
    [usuario_id] INT NOT NULL,
    [endpoint] NVARCHAR(600) NOT NULL,
    [endpoint_hash] CHAR(64) NOT NULL,
    [p256dh] VARCHAR(200) NOT NULL,
    [auth] VARCHAR(100) NOT NULL,
    [user_agent] NVARCHAR(255) NULL,
    [fecha_creacion] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    [fecha_ultimo_uso] DATETIME2(7) NULL,
    [fallos] INT NOT NULL DEFAULT ((0)),
    PRIMARY KEY CLUSTERED ([id]),
    UNIQUE NONCLUSTERED ([endpoint_hash])
);
GO

IF OBJECT_ID(N'dbo.VerificacionEmail', N'U') IS NULL
CREATE TABLE dbo.[VerificacionEmail] (
    [id] INT IDENTITY(1, 1) NOT NULL,
    [usuario_id] INT NOT NULL,
    [token_hash] CHAR(64) NOT NULL,
    [fecha_creacion] DATETIME2(7) NOT NULL DEFAULT (sysdatetime()),
    [fecha_expiracion] DATETIME2(7) NOT NULL,
    [usado] BIT NOT NULL DEFAULT ((0)),
    [fecha_uso] DATETIME2(7) NULL,
    PRIMARY KEY CLUSTERED ([id])
);
GO

-- ─────────────────────────────── Claves foráneas ───────────────────────────────
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.Usuarios') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Usuarios') AND c.name = N'creado_por')
    ALTER TABLE dbo.[Usuarios] ADD FOREIGN KEY ([creado_por])
        REFERENCES dbo.[Usuarios] ([id]);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.Usuarios') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Roles') AND c.name = N'rol_id')
    ALTER TABLE dbo.[Usuarios] ADD FOREIGN KEY ([rol_id])
        REFERENCES dbo.[Roles] ([id]);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.AuditoriaAccesos') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Usuarios') AND c.name = N'usuario_id')
    ALTER TABLE dbo.[AuditoriaAccesos] ADD FOREIGN KEY ([usuario_id])
        REFERENCES dbo.[Usuarios] ([id]);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.AuditoriaAccesosArchivo') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Usuarios') AND c.name = N'usuario_id')
    ALTER TABLE dbo.[AuditoriaAccesosArchivo] ADD FOREIGN KEY ([usuario_id])
        REFERENCES dbo.[Usuarios] ([id]);
IF OBJECT_ID(N'dbo.FK_AuditoriaPropietario_Usuario', N'F') IS NULL
    ALTER TABLE dbo.[AuditoriaConsultaPropietario] ADD CONSTRAINT [FK_AuditoriaPropietario_Usuario] FOREIGN KEY ([usuario_id])
        REFERENCES dbo.[Usuarios] ([id]);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.AuditoriaOperaciones') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Usuarios') AND c.name = N'usuario_id')
    ALTER TABLE dbo.[AuditoriaOperaciones] ADD FOREIGN KEY ([usuario_id])
        REFERENCES dbo.[Usuarios] ([id]);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.AuditoriaOperacionesArchivo') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Usuarios') AND c.name = N'usuario_id')
    ALTER TABLE dbo.[AuditoriaOperacionesArchivo] ADD FOREIGN KEY ([usuario_id])
        REFERENCES dbo.[Usuarios] ([id]);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.AuditoriaUsuarios') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Usuarios') AND c.name = N'actor_id')
    ALTER TABLE dbo.[AuditoriaUsuarios] ADD FOREIGN KEY ([actor_id])
        REFERENCES dbo.[Usuarios] ([id]);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.AuditoriaUsuariosArchivo') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Usuarios') AND c.name = N'actor_id')
    ALTER TABLE dbo.[AuditoriaUsuariosArchivo] ADD FOREIGN KEY ([actor_id])
        REFERENCES dbo.[Usuarios] ([id]);
IF OBJECT_ID(N'dbo.FK_Camaras_RegistradoPor', N'F') IS NULL
    ALTER TABLE dbo.[Camaras] ADD CONSTRAINT [FK_Camaras_RegistradoPor] FOREIGN KEY ([registrado_por])
        REFERENCES dbo.[Usuarios] ([id]);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.ConfiguracionSistema') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Usuarios') AND c.name = N'actualizado_por')
    ALTER TABLE dbo.[ConfiguracionSistema] ADD FOREIGN KEY ([actualizado_por])
        REFERENCES dbo.[Usuarios] ([id]);
IF OBJECT_ID(N'dbo.FK_ListaNegra_RegistradoPor', N'F') IS NULL
    ALTER TABLE dbo.[ListaNegra] ADD CONSTRAINT [FK_ListaNegra_RegistradoPor] FOREIGN KEY ([registrado_por])
        REFERENCES dbo.[Usuarios] ([id]);
IF OBJECT_ID(N'dbo.FK_Autorizados_RegistradoPor', N'F') IS NULL
    ALTER TABLE dbo.[VehiculosAutorizados] ADD CONSTRAINT [FK_Autorizados_RegistradoPor] FOREIGN KEY ([registrado_por])
        REFERENCES dbo.[Usuarios] ([id]);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.DeteccionVehiculo') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.ListaNegra') AND c.name = N'alerta_id')
    ALTER TABLE dbo.[DeteccionVehiculo] ADD FOREIGN KEY ([alerta_id])
        REFERENCES dbo.[ListaNegra] ([id]);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.DeteccionVehiculo') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Camaras') AND c.name = N'camara_id')
    ALTER TABLE dbo.[DeteccionVehiculo] ADD FOREIGN KEY ([camara_id])
        REFERENCES dbo.[Camaras] ([id]);
IF OBJECT_ID(N'dbo.FK_Deteccion_UsuarioValidador', N'F') IS NULL
    ALTER TABLE dbo.[DeteccionVehiculo] ADD CONSTRAINT [FK_Deteccion_UsuarioValidador] FOREIGN KEY ([usuario_validador_id])
        REFERENCES dbo.[Usuarios] ([id]);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.DeteccionVehiculo') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.VehiculosAutorizados') AND c.name = N'vehiculo_autorizado_id')
    ALTER TABLE dbo.[DeteccionVehiculo] ADD FOREIGN KEY ([vehiculo_autorizado_id])
        REFERENCES dbo.[VehiculosAutorizados] ([id]);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.Notificaciones') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Usuarios') AND c.name = N'atendida_por')
    ALTER TABLE dbo.[Notificaciones] ADD FOREIGN KEY ([atendida_por])
        REFERENCES dbo.[Usuarios] ([id]);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.NotificacionUsuario') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Notificaciones') AND c.name = N'notificacion_id')
    ALTER TABLE dbo.[NotificacionUsuario] ADD FOREIGN KEY ([notificacion_id])
        REFERENCES dbo.[Notificaciones] ([id]) ON DELETE CASCADE;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.NotificacionUsuario') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Usuarios') AND c.name = N'usuario_id')
    ALTER TABLE dbo.[NotificacionUsuario] ADD FOREIGN KEY ([usuario_id])
        REFERENCES dbo.[Usuarios] ([id]) ON DELETE CASCADE;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.RestablecimientoPassword') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Usuarios') AND c.name = N'usuario_id')
    ALTER TABLE dbo.[RestablecimientoPassword] ADD FOREIGN KEY ([usuario_id])
        REFERENCES dbo.[Usuarios] ([id]) ON DELETE CASCADE;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.SolicitudesAcceso') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.DeteccionVehiculo') AND c.name = N'deteccion_id')
    ALTER TABLE dbo.[SolicitudesAcceso] ADD FOREIGN KEY ([deteccion_id])
        REFERENCES dbo.[DeteccionVehiculo] ([id]) ON DELETE SET NULL;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.SolicitudesAcceso') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Usuarios') AND c.name = N'resuelto_por')
    ALTER TABLE dbo.[SolicitudesAcceso] ADD FOREIGN KEY ([resuelto_por])
        REFERENCES dbo.[Usuarios] ([id]);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.SolicitudesAcceso') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Usuarios') AND c.name = N'solicitado_por')
    ALTER TABLE dbo.[SolicitudesAcceso] ADD FOREIGN KEY ([solicitado_por])
        REFERENCES dbo.[Usuarios] ([id]);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.SolicitudesAcceso') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.VehiculosAutorizados') AND c.name = N'vehiculo_autorizado_id')
    ALTER TABLE dbo.[SolicitudesAcceso] ADD FOREIGN KEY ([vehiculo_autorizado_id])
        REFERENCES dbo.[VehiculosAutorizados] ([id]);
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.SuscripcionesPush') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Usuarios') AND c.name = N'usuario_id')
    ALTER TABLE dbo.[SuscripcionesPush] ADD FOREIGN KEY ([usuario_id])
        REFERENCES dbo.[Usuarios] ([id]) ON DELETE CASCADE;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
               WHERE fkc.parent_object_id = OBJECT_ID(N'dbo.VerificacionEmail') AND fkc.referenced_object_id = OBJECT_ID(N'dbo.Usuarios') AND c.name = N'usuario_id')
    ALTER TABLE dbo.[VerificacionEmail] ADD FOREIGN KEY ([usuario_id])
        REFERENCES dbo.[Usuarios] ([id]) ON DELETE CASCADE;
GO

-- ─────────────────────────────── Índices ───────────────────────────────
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Usuarios_Rol_Estado' AND object_id = OBJECT_ID(N'dbo.Usuarios'))
    CREATE NONCLUSTERED INDEX [IX_Usuarios_Rol_Estado] ON dbo.[Usuarios] ([rol_id], [estado]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AuditoriaAccesos_Email' AND object_id = OBJECT_ID(N'dbo.AuditoriaAccesos'))
    CREATE NONCLUSTERED INDEX [IX_AuditoriaAccesos_Email] ON dbo.[AuditoriaAccesos] ([email], [fecha] DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AuditoriaAccesos_Fecha' AND object_id = OBJECT_ID(N'dbo.AuditoriaAccesos'))
    CREATE NONCLUSTERED INDEX [IX_AuditoriaAccesos_Fecha] ON dbo.[AuditoriaAccesos] ([fecha] DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AuditoriaAccesosArchivo_Fecha' AND object_id = OBJECT_ID(N'dbo.AuditoriaAccesosArchivo'))
    CREATE NONCLUSTERED INDEX [IX_AuditoriaAccesosArchivo_Fecha] ON dbo.[AuditoriaAccesosArchivo] ([fecha] DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AuditoriaPropietario_Fecha' AND object_id = OBJECT_ID(N'dbo.AuditoriaConsultaPropietario'))
    CREATE NONCLUSTERED INDEX [IX_AuditoriaPropietario_Fecha] ON dbo.[AuditoriaConsultaPropietario] ([fecha]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AuditoriaPropietario_Usuario' AND object_id = OBJECT_ID(N'dbo.AuditoriaConsultaPropietario'))
    CREATE NONCLUSTERED INDEX [IX_AuditoriaPropietario_Usuario] ON dbo.[AuditoriaConsultaPropietario] ([usuario_id], [fecha]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AuditoriaDescartes_Fecha' AND object_id = OBJECT_ID(N'dbo.AuditoriaDescartes'))
    CREATE NONCLUSTERED INDEX [IX_AuditoriaDescartes_Fecha] ON dbo.[AuditoriaDescartes] ([fecha_registro]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AuditoriaOperaciones_Entidad' AND object_id = OBJECT_ID(N'dbo.AuditoriaOperaciones'))
    CREATE NONCLUSTERED INDEX [IX_AuditoriaOperaciones_Entidad] ON dbo.[AuditoriaOperaciones] ([entidad], [entidad_id]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AuditoriaOperaciones_Fecha' AND object_id = OBJECT_ID(N'dbo.AuditoriaOperaciones'))
    CREATE NONCLUSTERED INDEX [IX_AuditoriaOperaciones_Fecha] ON dbo.[AuditoriaOperaciones] ([fecha] DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AuditoriaOperacionesArchivo_Fecha' AND object_id = OBJECT_ID(N'dbo.AuditoriaOperacionesArchivo'))
    CREATE NONCLUSTERED INDEX [IX_AuditoriaOperacionesArchivo_Fecha] ON dbo.[AuditoriaOperacionesArchivo] ([fecha] DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AuditoriaUsuarios_Fecha' AND object_id = OBJECT_ID(N'dbo.AuditoriaUsuarios'))
    CREATE NONCLUSTERED INDEX [IX_AuditoriaUsuarios_Fecha] ON dbo.[AuditoriaUsuarios] ([fecha] DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_AuditoriaUsuariosArchivo_Fecha' AND object_id = OBJECT_ID(N'dbo.AuditoriaUsuariosArchivo'))
    CREATE NONCLUSTERED INDEX [IX_AuditoriaUsuariosArchivo_Fecha] ON dbo.[AuditoriaUsuariosArchivo] ([fecha] DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_ListaNegra_PlacaActivo' AND object_id = OBJECT_ID(N'dbo.ListaNegra'))
    CREATE NONCLUSTERED INDEX [IX_ListaNegra_PlacaActivo] ON dbo.[ListaNegra] ([placa], [activo]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_VehiculosAutorizados_PlacaActivo' AND object_id = OBJECT_ID(N'dbo.VehiculosAutorizados'))
    CREATE NONCLUSTERED INDEX [IX_VehiculosAutorizados_PlacaActivo] ON dbo.[VehiculosAutorizados] ([placa], [activo]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Deteccion_Camara_Fecha' AND object_id = OBJECT_ID(N'dbo.DeteccionVehiculo'))
    CREATE NONCLUSTERED INDEX [IX_Deteccion_Camara_Fecha] ON dbo.[DeteccionVehiculo] ([camara_id], [fecha_hora_ingreso] DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Deteccion_Estado' AND object_id = OBJECT_ID(N'dbo.DeteccionVehiculo'))
    CREATE NONCLUSTERED INDEX [IX_Deteccion_Estado] ON dbo.[DeteccionVehiculo] ([estado_validacion], [estado_procesamiento]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Deteccion_FechaHora' AND object_id = OBJECT_ID(N'dbo.DeteccionVehiculo'))
    CREATE NONCLUSTERED INDEX [IX_Deteccion_FechaHora] ON dbo.[DeteccionVehiculo] ([fecha_hora_ingreso] DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Deteccion_Placa' AND object_id = OBJECT_ID(N'dbo.DeteccionVehiculo'))
    CREATE NONCLUSTERED INDEX [IX_Deteccion_Placa] ON dbo.[DeteccionVehiculo] ([placa_reconocida]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Deteccion_PlacaValidada' AND object_id = OBJECT_ID(N'dbo.DeteccionVehiculo'))
    CREATE NONCLUSTERED INDEX [IX_Deteccion_PlacaValidada] ON dbo.[DeteccionVehiculo] ([placa_validada]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Deteccion_Validacion_Fecha' AND object_id = OBJECT_ID(N'dbo.DeteccionVehiculo'))
    CREATE NONCLUSTERED INDEX [IX_Deteccion_Validacion_Fecha] ON dbo.[DeteccionVehiculo] ([validado_manualmente], [fecha_hora_ingreso]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Notificaciones_Dedup' AND object_id = OBJECT_ID(N'dbo.Notificaciones'))
    CREATE NONCLUSTERED INDEX [IX_Notificaciones_Dedup] ON dbo.[Notificaciones] ([clave_dedup], [fecha_creacion] DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Notificaciones_Deteccion' AND object_id = OBJECT_ID(N'dbo.Notificaciones'))
    CREATE NONCLUSTERED INDEX [IX_Notificaciones_Deteccion] ON dbo.[Notificaciones] ([deteccion_id]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Notificaciones_Fecha' AND object_id = OBJECT_ID(N'dbo.Notificaciones'))
    CREATE NONCLUSTERED INDEX [IX_Notificaciones_Fecha] ON dbo.[Notificaciones] ([fecha_creacion] DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_Notificaciones_Pendientes' AND object_id = OBJECT_ID(N'dbo.Notificaciones'))
    CREATE NONCLUSTERED INDEX [IX_Notificaciones_Pendientes] ON dbo.[Notificaciones] ([requiere_ack], [fecha_atencion], [escalada], [fecha_creacion]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_NotificacionUsuario_Bandeja' AND object_id = OBJECT_ID(N'dbo.NotificacionUsuario'))
    CREATE NONCLUSTERED INDEX [IX_NotificacionUsuario_Bandeja] ON dbo.[NotificacionUsuario] ([usuario_id], [notificacion_id] DESC) INCLUDE ([fecha_lectura]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_RestablecimientoPassword_Token' AND object_id = OBJECT_ID(N'dbo.RestablecimientoPassword'))
    CREATE NONCLUSTERED INDEX [IX_RestablecimientoPassword_Token] ON dbo.[RestablecimientoPassword] ([token_hash]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SolicitudesAcceso_Estado' AND object_id = OBJECT_ID(N'dbo.SolicitudesAcceso'))
    CREATE NONCLUSTERED INDEX [IX_SolicitudesAcceso_Estado] ON dbo.[SolicitudesAcceso] ([estado], [fecha_solicitud] DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SolicitudesAcceso_Placa' AND object_id = OBJECT_ID(N'dbo.SolicitudesAcceso'))
    CREATE NONCLUSTERED INDEX [IX_SolicitudesAcceso_Placa] ON dbo.[SolicitudesAcceso] ([placa], [estado]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_SuscripcionesPush_Usuario' AND object_id = OBJECT_ID(N'dbo.SuscripcionesPush'))
    CREATE NONCLUSTERED INDEX [IX_SuscripcionesPush_Usuario] ON dbo.[SuscripcionesPush] ([usuario_id]);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_VerificacionEmail_Token' AND object_id = OBJECT_ID(N'dbo.VerificacionEmail'))
    CREATE NONCLUSTERED INDEX [IX_VerificacionEmail_Token] ON dbo.[VerificacionEmail] ([token_hash]);
GO

-- ─────────────────────────────── Catálogo de roles ───────────────────────────────
-- Tres roles: Administrador, Guardia y Gestor de permisos (matriz de permisos en el código del backend).
IF NOT EXISTS (SELECT 1 FROM dbo.Roles WHERE codigo = N'ADMIN')
    INSERT INTO dbo.Roles ([codigo], [nombre], [descripcion]) VALUES (N'ADMIN', N'Administrador', N'Gestión total: usuarios, cámaras, listas, configuración y auditoría.');
IF NOT EXISTS (SELECT 1 FROM dbo.Roles WHERE codigo = N'GUARDIA')
    INSERT INTO dbo.Roles ([codigo], [nombre], [descripcion]) VALUES (N'GUARDIA', N'Guardia', N'Monitoreo en vivo del punto de control, validación de ingresos y consulta de la lista blanca.');
IF NOT EXISTS (SELECT 1 FROM dbo.Roles WHERE codigo = N'GESTOR_PERMISOS')
    INSERT INTO dbo.Roles ([codigo], [nombre], [descripcion]) VALUES (N'GESTOR_PERMISOS', N'Gestor de permisos', N'Otorga los permisos de placa (lista blanca) y resuelve las solicitudes de acceso.');
GO
