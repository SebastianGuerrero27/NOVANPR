-- =============================================================================
-- SISTEMA ANPR - CONTROL DE INGRESO VEHICULAR · ECU 911 COORDINACIÓN ZONAL 3
-- ESQUEMA v2 (SQL Server 2022) — instalación nueva
--
-- Principios:
--   * Sin datos de prueba ni usuarios predefinidos: el primer administrador se crea
--     desde la pantalla de configuración inicial (POST /api/auth/configuracion-inicial).
--   * Solo se precarga el catálogo de roles, sin el cual el sistema no funciona.
--   * Trazabilidad: quién registró / validó cada dato y auditoría de accesos.
--
-- Las bases existentes se actualizan con las migraciones db/migration_*.sql (idempotentes), que el
-- backend aplica al arrancar en el orden de backend/src/config/db.ts (MIGRACIONES) y registra en
-- SchemaMigraciones. La v5 agrega el rol Gestor de accesos, los permisos de placa con horario, las
-- solicitudes de acceso y el centro de notificaciones.
-- =============================================================================

IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = 'ANPR_ECU911')
BEGIN
    CREATE DATABASE ANPR_ECU911;
END
GO

USE ANPR_ECU911;
GO

-- =============================================================================
-- 1. SEGURIDAD
-- =============================================================================

-- Catálogo de roles (datos de sistema, no de prueba)
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Roles')
BEGIN
    CREATE TABLE Roles (
        id           INT IDENTITY(1,1) PRIMARY KEY,
        -- Códigos válidos: los de backend/src/dominio/permisos.ts (ROL_POR_CODIGO)
        codigo       VARCHAR(20)   NOT NULL UNIQUE,
        nombre       NVARCHAR(50)  NOT NULL,
        descripcion  NVARCHAR(255) NULL
    );
END
GO
IF NOT EXISTS (SELECT 1 FROM Roles WHERE codigo = 'ADMIN')
    INSERT INTO Roles (codigo, nombre, descripcion) VALUES ('ADMIN', N'Administrador', N'Gestión total: usuarios, cámaras, listas, configuración y auditoría.');
-- Tres roles: Administrador, Guardia y Gestor de permisos. Las bases anteriores (SUPERVISOR,
-- OPERADOR, GESTOR_ACCESOS) se consolidan en migration_v6_tres_roles.sql
IF NOT EXISTS (SELECT 1 FROM Roles WHERE codigo = 'GUARDIA') AND NOT EXISTS (SELECT 1 FROM Roles WHERE codigo = 'OPERADOR')
    INSERT INTO Roles (codigo, nombre, descripcion) VALUES ('GUARDIA', N'Guardia', N'Monitoreo en vivo del punto de control, validación de ingresos y consulta de la lista blanca.');
IF NOT EXISTS (SELECT 1 FROM Roles WHERE codigo = 'GESTOR_PERMISOS') AND NOT EXISTS (SELECT 1 FROM Roles WHERE codigo = 'GESTOR_ACCESOS')
    INSERT INTO Roles (codigo, nombre, descripcion) VALUES ('GESTOR_PERMISOS', N'Gestor de permisos', N'Otorga los permisos de placa (lista blanca) y resuelve las solicitudes de acceso.');
GO


IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Usuarios')
BEGIN
    CREATE TABLE Usuarios (
        id                      INT IDENTITY(1,1) PRIMARY KEY,
        email                   NVARCHAR(150) NOT NULL UNIQUE,
        nombre_completo         NVARCHAR(150) NOT NULL,
        cargo                   NVARCHAR(100) NULL,
        password_hash           VARCHAR(100)  NOT NULL,
        rol_id                  INT           NOT NULL REFERENCES Roles(id),
        -- pendiente: correo sin verificar · activo · inactivo: dado de baja por un administrador
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
END
GO

-- Tokens de un solo uso (se guarda solo el hash SHA-256, nunca el token)
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'VerificacionEmail') AND COL_LENGTH('Usuarios', 'email') IS NOT NULL
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

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'RestablecimientoPassword') AND COL_LENGTH('Usuarios', 'email') IS NOT NULL
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

-- Acciones administrativas sobre cuentas (crear, cambiar rol, bloquear, etc.)
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AuditoriaUsuarios') AND COL_LENGTH('Usuarios', 'email') IS NOT NULL
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

-- Intentos de inicio de sesión (exitosos y fallidos)
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AuditoriaAccesos') AND COL_LENGTH('Usuarios', 'email') IS NOT NULL
BEGIN
    CREATE TABLE AuditoriaAccesos (
        id          BIGINT IDENTITY(1,1) PRIMARY KEY,
        fecha       DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
        email       NVARCHAR(150) NOT NULL,
        usuario_id  INT           NULL REFERENCES Usuarios(id),
        exito       BIT           NOT NULL,
        motivo      VARCHAR(50)   NULL,   -- ok, credenciales, bloqueado, no_verificado, inactivo
        ip          VARCHAR(45)   NULL,
        user_agent  NVARCHAR(255) NULL
    );
    CREATE INDEX IX_AuditoriaAccesos_Fecha ON AuditoriaAccesos (fecha DESC);
    CREATE INDEX IX_AuditoriaAccesos_Email ON AuditoriaAccesos (email, fecha DESC);
END
GO

-- =============================================================================
-- 2. INFRAESTRUCTURA Y LISTAS
-- =============================================================================

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Camaras')
BEGIN
    CREATE TABLE Camaras (
        id                   INT IDENTITY(1,1) PRIMARY KEY,
        nombre               NVARCHAR(100) NOT NULL,
        ip                   VARCHAR(45)   NOT NULL,
        rtsp_url             VARCHAR(255)  NOT NULL,
        ubicacion            NVARCHAR(150) NOT NULL,
        activa               BIT           NOT NULL DEFAULT 1,
        estado               VARCHAR(20)   NULL DEFAULT 'SIN_VERIFICAR',   -- EN_LINEA | SIN_CONEXION | SIN_VERIFICAR
        ultimo_ping          DATETIME      NULL,
        tiempo_respuesta_ms  INT           NULL,
        mensaje_ping         VARCHAR(255)  NULL,
        roi                  NVARCHAR(1000) NULL,  -- región de interés: JSON [[x,y],...] normalizado 0–1
        registrado_por       INT           NULL REFERENCES Usuarios(id),
        created_at           DATETIME      NOT NULL DEFAULT GETDATE(),
        fecha_actualizacion  DATETIME2     NULL
    );
END
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ListaNegra')
BEGIN
    CREATE TABLE ListaNegra (
        id                   INT IDENTITY(1,1) PRIMARY KEY,
        placa                VARCHAR(10)   NOT NULL UNIQUE,
        motivo               NVARCHAR(255) NOT NULL,
        nivel_alerta         VARCHAR(20)   NOT NULL DEFAULT 'ALTA' CHECK (nivel_alerta IN ('CRITICA', 'ALTA', 'MEDIA')),
        marca                VARCHAR(50)   NULL,
        modelo               VARCHAR(50)   NULL,
        color                VARCHAR(30)   NULL,
        -- Alertas temporales: NULL = vigente hasta que se retire
        fecha_vencimiento    DATE          NULL,
        observaciones        NVARCHAR(255) NULL,
        activo               BIT           NOT NULL DEFAULT 1,
        registrado_por       INT           NULL REFERENCES Usuarios(id),
        fecha_registro       DATETIME      NOT NULL DEFAULT GETDATE(),
        fecha_actualizacion  DATETIME2     NULL
    );
    CREATE NONCLUSTERED INDEX IX_ListaNegra_PlacaActivo ON ListaNegra (placa, activo);
END
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'VehiculosAutorizados')
BEGIN
    CREATE TABLE VehiculosAutorizados (
        id                   INT IDENTITY(1,1) PRIMARY KEY,
        placa                VARCHAR(10)   NOT NULL UNIQUE,
        propietario          NVARCHAR(150) NOT NULL,
        departamento         NVARCHAR(100) NULL,
        tipo_vehiculo        VARCHAR(50)   NULL,
        marca                VARCHAR(50)   NULL,
        modelo               VARCHAR(50)   NULL,
        color                VARCHAR(30)   NULL,
        -- Autorizaciones temporales (visitas, proveedores): NULL = sin vencimiento
        fecha_vencimiento    DATE          NULL,
        observaciones        NVARCHAR(255) NULL,
        activo               BIT           NOT NULL DEFAULT 1,
        registrado_por       INT           NULL REFERENCES Usuarios(id),
        fecha_registro       DATETIME      NOT NULL DEFAULT GETDATE(),
        fecha_actualizacion  DATETIME2     NULL
    );
    CREATE NONCLUSTERED INDEX IX_VehiculosAutorizados_PlacaActivo ON VehiculosAutorizados (placa, activo);
END
GO

-- =============================================================================
-- 3. OPERACIÓN: DETECCIONES Y AUDITORÍAS
-- =============================================================================

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'DeteccionVehiculo')
BEGIN
    CREATE TABLE DeteccionVehiculo (
        id                          INT IDENTITY(1,1) PRIMARY KEY,
        tracking_id                 INT           NULL DEFAULT -1,
        camara_id                   INT           NULL REFERENCES Camaras(id),
        fuente                      VARCHAR(255)  NULL DEFAULT 'webcam',
        -- Fase 1: captura
        fecha_hora_ingreso          DATETIME      NOT NULL DEFAULT GETDATE(),
        ruta_imagen_ingreso         VARCHAR(255)  NULL,
        ruta_imagen_placa           VARCHAR(255)  NULL,
        confianza_deteccion         FLOAT         NULL,
        -- Fase 2: OCR
        estado_procesamiento        VARCHAR(30)   NULL DEFAULT 'pendiente_ocr',   -- pendiente_ocr | procesado | no_legible
        placa_reconocida            VARCHAR(20)   NULL,
        confianza_ocr               FLOAT         NULL,
        fecha_hora_procesamiento    DATETIME      NULL,
        estado_validacion           VARCHAR(30)   NULL DEFAULT 'pendiente_revision', -- autorizado | alerta | no_reconocido | pendiente_revision
        tipo_vehiculo               VARCHAR(50)   NULL,
        alerta_id                   INT           NULL REFERENCES ListaNegra(id),
        vehiculo_autorizado_id      INT           NULL REFERENCES VehiculosAutorizados(id),
        -- Validación del operador
        validado_manualmente        BIT           NOT NULL DEFAULT 0,
        placa_validada              VARCHAR(20)   NULL,
        usuario_validador_id        INT           NULL REFERENCES Usuarios(id),
        fecha_validacion            DATETIME      NULL,
        -- Evaluación científica (lectura y decisión automáticas originales + metadatos)
        placa_ocr_original          VARCHAR(20)   NULL,
        confianza_ocr_original      FLOAT         NULL,
        decision_automatica         VARCHAR(30)   NULL,
        lectura_verificador         VARCHAR(20)   NULL,
        latencia_ms                 INT           NULL,
        luminancia_media            FLOAT         NULL,
        distancia_estimada_m        FLOAT         NULL,
        ancho_placa_px              INT           NULL,
        nitidez                     FLOAT         NULL,
        velocidad_px_s              FLOAT         NULL,
        condicion_clima             VARCHAR(20)   NULL,
        modelo_detector             VARCHAR(100)  NULL,
        modelo_ocr                  VARCHAR(100)  NULL,
        -- Segundo factor: atributos observados del vehículo
        vehiculo_tipo               VARCHAR(30)   NULL,
        vehiculo_color              VARCHAR(30)   NULL,
        vehiculo_marca              VARCHAR(50)   NULL,
        vehiculo_modelo             VARCHAR(50)   NULL,
        vehiculo_atributos_json     NVARCHAR(500) NULL,
        verificacion_vehiculo       VARCHAR(20)   NULL,   -- coincide | no_coincide | sin_datos
        verificacion_detalle        VARCHAR(255)  NULL,
        -- Validez de la lectura (evidencias independientes del motor, ver verificacion_placa.py)
        lectura_valida              BIT           NULL,
        evidencia_lectura           NVARCHAR(1500) NULL
    );
    CREATE NONCLUSTERED INDEX IX_Deteccion_FechaHora ON DeteccionVehiculo (fecha_hora_ingreso DESC);
    CREATE NONCLUSTERED INDEX IX_Deteccion_Placa ON DeteccionVehiculo (placa_reconocida);
    CREATE NONCLUSTERED INDEX IX_Deteccion_Estado ON DeteccionVehiculo (estado_validacion, estado_procesamiento);
    CREATE NONCLUSTERED INDEX IX_Deteccion_Validacion_Fecha ON DeteccionVehiculo (validado_manualmente, fecha_hora_ingreso);
    CREATE NONCLUSTERED INDEX IX_Deteccion_Camara_Fecha ON DeteccionVehiculo (camara_id, fecha_hora_ingreso DESC);
    CREATE NONCLUSTERED INDEX IX_Deteccion_PlacaValidada ON DeteccionVehiculo (placa_validada);
END
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AuditoriaDescartes')
BEGIN
    CREATE TABLE AuditoriaDescartes (
        id               INT IDENTITY(1,1) PRIMARY KEY,
        tracking_id      INT           NULL,
        motivo           VARCHAR(100)  NOT NULL,
        texto_candidato  VARCHAR(50)   NULL,
        confianza        FLOAT         NULL,
        fuente           VARCHAR(255)  NULL,
        camara_id        INT           NULL,
        fecha_registro   DATETIME      DEFAULT GETDATE()
    );
    CREATE INDEX IX_AuditoriaDescartes_Fecha ON AuditoriaDescartes (fecha_registro);
END
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AuditoriaConsultaPropietario') AND COL_LENGTH('Usuarios', 'email') IS NOT NULL
BEGIN
    CREATE TABLE AuditoriaConsultaPropietario (
        id              INT IDENTITY(1,1) PRIMARY KEY,
        usuario_id      INT           NOT NULL REFERENCES Usuarios(id),
        usuario_nombre  NVARCHAR(150) NULL,
        placa           VARCHAR(20)   NOT NULL,
        motivo          NVARCHAR(255) NOT NULL,
        deteccion_id    INT           NULL,
        proveedor       VARCHAR(50)   NOT NULL,
        resultado       VARCHAR(20)   NOT NULL,
        fecha           DATETIME      DEFAULT GETDATE()
    );
    CREATE INDEX IX_AuditoriaPropietario_Fecha ON AuditoriaConsultaPropietario (fecha);
    CREATE INDEX IX_AuditoriaPropietario_Usuario ON AuditoriaConsultaPropietario (usuario_id, fecha);
END
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AuditoriaOperaciones') AND COL_LENGTH('Usuarios', 'email') IS NOT NULL
BEGIN
    -- Quién hizo qué sobre detecciones, listas, cámaras y configuración
    CREATE TABLE AuditoriaOperaciones (
        id             BIGINT IDENTITY(1,1) PRIMARY KEY,
        fecha          DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
        usuario_id     INT           NULL REFERENCES Usuarios(id),
        usuario_email  NVARCHAR(150) NULL,
        accion         VARCHAR(50)   NOT NULL,
        entidad        VARCHAR(40)   NOT NULL,
        entidad_id     INT           NULL,
        detalle        NVARCHAR(500) NULL,
        ip             VARCHAR(45)   NULL
    );
    CREATE INDEX IX_AuditoriaOperaciones_Fecha ON AuditoriaOperaciones (fecha DESC);
    CREATE INDEX IX_AuditoriaOperaciones_Entidad ON AuditoriaOperaciones (entidad, entidad_id);
END
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ConfiguracionSistema') AND COL_LENGTH('Usuarios', 'email') IS NOT NULL
BEGIN
    -- Parámetros editables desde la pantalla de configuración (sin filas iniciales:
    -- mientras una clave no exista rige el valor de la variable de entorno)
    CREATE TABLE ConfiguracionSistema (
        clave                VARCHAR(60)   NOT NULL PRIMARY KEY,
        valor                NVARCHAR(500) NOT NULL,
        actualizado_por      INT           NULL REFERENCES Usuarios(id),
        fecha_actualizacion  DATETIME2     NOT NULL DEFAULT SYSDATETIME()
    );
END
GO
