-- =============================================================================
-- Migración v5 · Rol Gestor de accesos, permisos de placa con restricciones temporales,
--                solicitudes de acceso y centro de notificaciones (idempotente)
--
--  1. Roles: se retira el CHECK fijo de códigos y se agrega GESTOR_ACCESOS. La matriz
--     rol → permiso vive en backend/src/dominio/permisos.ts (RBAC, NIST/ANSI INCITS 359).
--  2. VehiculosAutorizados (padrón = "permisos" de placa): categoría, inicio de vigencia y
--     franjas horarias (JSON). Equivale a los "time profiles" / "access schedules" de los
--     sistemas ANPR de control de acceso (Nedap ANPR Access, Genetec AutoVu, Hikvision).
--  3. DeteccionVehiculo.restriccion_acceso: por qué un permiso existente no concedió el paso
--     (fuera_horario | no_iniciada | vencida).
--  4. SolicitudesAcceso: el personal de garita pide autorizar una placa y el gestor la
--     aprueba o rechaza (separación de funciones: quien solicita no resuelve).
--  5. Notificaciones / NotificacionUsuario / SuscripcionesPush / ClavesServicio: bandeja
--     persistente con lectura, reconocimiento (ACK) y escalamiento (ciclo de vida de
--     alarmas ISA-18.2 / IEC 62682), y suscripciones Web Push (RFC 8030 / 8291 / 8292).
-- =============================================================================

-- ─── 1. Catálogo de roles ────────────────────────────────────────────────────
DECLARE @ck NVARCHAR(256);
SELECT @ck = cc.name
FROM sys.check_constraints cc
JOIN sys.columns c ON c.object_id = cc.parent_object_id AND c.column_id = cc.parent_column_id
WHERE cc.parent_object_id = OBJECT_ID('Roles') AND c.name = 'codigo';
IF @ck IS NOT NULL
    EXEC('ALTER TABLE Roles DROP CONSTRAINT [' + @ck + ']');
GO

IF NOT EXISTS (SELECT 1 FROM Roles WHERE codigo = 'GESTOR_ACCESOS')
    INSERT INTO Roles (codigo, nombre, descripcion)
    VALUES ('GESTOR_ACCESOS', N'Gestor de accesos',
            N'Administra los permisos de ingreso de placas (padrón, vigencias y horarios) y resuelve las solicitudes de acceso.');
GO

-- ─── 2. Permisos de placa (padrón de autorizados) ────────────────────────────
IF COL_LENGTH('VehiculosAutorizados', 'categoria') IS NULL
    ALTER TABLE VehiculosAutorizados ADD categoria VARCHAR(20) NOT NULL
        CONSTRAINT DF_VehiculosAutorizados_Categoria DEFAULT 'FUNCIONARIO'
        CONSTRAINT CK_VehiculosAutorizados_Categoria
            CHECK (categoria IN ('FUNCIONARIO', 'VISITANTE', 'PROVEEDOR', 'CONTRATISTA', 'OFICIAL', 'EMERGENCIA'));
GO
IF COL_LENGTH('VehiculosAutorizados', 'fecha_inicio') IS NULL
    ALTER TABLE VehiculosAutorizados ADD fecha_inicio DATE NULL;
GO
-- Franjas horarias: [{"dias":[1,2,3,4,5],"desde":"07:00","hasta":"19:00"}] (ISO 8601: 1 = lunes).
-- NULL = sin restricción horaria (24/7).
IF COL_LENGTH('VehiculosAutorizados', 'horario') IS NULL
    ALTER TABLE VehiculosAutorizados ADD horario NVARCHAR(600) NULL;
GO
IF COL_LENGTH('VehiculosAutorizados', 'solicitud_id') IS NULL
    ALTER TABLE VehiculosAutorizados ADD solicitud_id INT NULL;
GO

-- ─── 3. Detecciones: restricción del permiso ─────────────────────────────────
IF COL_LENGTH('DeteccionVehiculo', 'restriccion_acceso') IS NULL
    ALTER TABLE DeteccionVehiculo ADD restriccion_acceso VARCHAR(30) NULL;
GO

-- ─── 4. Solicitudes de acceso ────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'SolicitudesAcceso')
BEGIN
    CREATE TABLE SolicitudesAcceso (
        id                      INT IDENTITY(1,1) PRIMARY KEY,
        placa                   VARCHAR(10)   NOT NULL,
        propietario             NVARCHAR(150) NOT NULL,
        departamento            NVARCHAR(100) NULL,
        categoria               VARCHAR(20)   NOT NULL DEFAULT 'VISITANTE',
        motivo                  NVARCHAR(300) NOT NULL,
        tipo_vehiculo           VARCHAR(50)   NULL,
        marca                   VARCHAR(50)   NULL,
        modelo                  VARCHAR(50)   NULL,
        color                   VARCHAR(30)   NULL,
        fecha_inicio            DATE          NULL,
        fecha_fin               DATE          NULL,
        horario                 NVARCHAR(600) NULL,
        deteccion_id            INT           NULL REFERENCES DeteccionVehiculo(id) ON DELETE SET NULL,
        estado                  VARCHAR(20)   NOT NULL DEFAULT 'pendiente'
            CHECK (estado IN ('pendiente', 'aprobada', 'rechazada', 'cancelada')),
        solicitado_por          INT           NOT NULL REFERENCES Usuarios(id),
        fecha_solicitud         DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
        resuelto_por            INT           NULL REFERENCES Usuarios(id),
        fecha_resolucion        DATETIME2     NULL,
        comentario_resolucion   NVARCHAR(300) NULL,
        vehiculo_autorizado_id  INT           NULL REFERENCES VehiculosAutorizados(id)
    );
    CREATE INDEX IX_SolicitudesAcceso_Estado ON SolicitudesAcceso (estado, fecha_solicitud DESC);
    CREATE INDEX IX_SolicitudesAcceso_Placa ON SolicitudesAcceso (placa, estado);
END
GO

-- ─── 5. Centro de notificaciones ─────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Notificaciones')
BEGIN
    CREATE TABLE Notificaciones (
        id                BIGINT IDENTITY(1,1) PRIMARY KEY,
        tipo              VARCHAR(40)   NOT NULL,
        -- Prioridad de alarma (ISA-18.2): critica > alta > media > baja
        severidad         VARCHAR(10)   NOT NULL CHECK (severidad IN ('critica', 'alta', 'media', 'baja')),
        titulo            NVARCHAR(150) NOT NULL,
        mensaje           NVARCHAR(500) NOT NULL,
        enlace            VARCHAR(200)  NULL,
        datos             NVARCHAR(1000) NULL,
        -- Supresión de avalanchas: el mismo evento dentro de la ventana incrementa repeticiones
        clave_dedup       VARCHAR(120)  NULL,
        repeticiones      INT           NOT NULL DEFAULT 1,
        requiere_ack      BIT           NOT NULL DEFAULT 0,
        deteccion_id      INT           NULL,
        fecha_creacion    DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
        fecha_ultima      DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
        -- Reconocimiento global (la primera persona que atiende la alarma)
        atendida_por      INT           NULL REFERENCES Usuarios(id),
        fecha_atencion    DATETIME2     NULL,
        -- Resolución automática (p. ej. el ingreso se validó)
        fecha_resolucion  DATETIME2     NULL,
        escalada          BIT           NOT NULL DEFAULT 0,
        fecha_escalamiento DATETIME2    NULL
    );
    CREATE INDEX IX_Notificaciones_Fecha ON Notificaciones (fecha_creacion DESC);
    CREATE INDEX IX_Notificaciones_Dedup ON Notificaciones (clave_dedup, fecha_creacion DESC);
    CREATE INDEX IX_Notificaciones_Pendientes ON Notificaciones (requiere_ack, fecha_atencion, escalada, fecha_creacion);
    CREATE INDEX IX_Notificaciones_Deteccion ON Notificaciones (deteccion_id);
END
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'NotificacionUsuario')
BEGIN
    CREATE TABLE NotificacionUsuario (
        notificacion_id  BIGINT    NOT NULL REFERENCES Notificaciones(id) ON DELETE CASCADE,
        usuario_id       INT       NOT NULL REFERENCES Usuarios(id) ON DELETE CASCADE,
        fecha_lectura    DATETIME2 NULL,
        CONSTRAINT PK_NotificacionUsuario PRIMARY KEY (notificacion_id, usuario_id)
    );
    CREATE INDEX IX_NotificacionUsuario_Bandeja ON NotificacionUsuario (usuario_id, notificacion_id DESC) INCLUDE (fecha_lectura);
END
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'SuscripcionesPush')
BEGIN
    CREATE TABLE SuscripcionesPush (
        id               INT IDENTITY(1,1) PRIMARY KEY,
        usuario_id       INT           NOT NULL REFERENCES Usuarios(id) ON DELETE CASCADE,
        endpoint         NVARCHAR(600) NOT NULL,
        endpoint_hash    CHAR(64)      NOT NULL UNIQUE,
        p256dh           VARCHAR(200)  NOT NULL,
        auth             VARCHAR(100)  NOT NULL,
        user_agent       NVARCHAR(255) NULL,
        fecha_creacion   DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
        fecha_ultimo_uso DATETIME2     NULL,
        fallos           INT           NOT NULL DEFAULT 0
    );
    CREATE INDEX IX_SuscripcionesPush_Usuario ON SuscripcionesPush (usuario_id);
END
GO

-- Claves generadas por el propio sistema (p. ej. par VAPID si no se definió en el entorno)
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ClavesServicio')
BEGIN
    CREATE TABLE ClavesServicio (
        clave           VARCHAR(60)    NOT NULL PRIMARY KEY,
        valor           NVARCHAR(1000) NOT NULL,
        fecha_creacion  DATETIME2      NOT NULL DEFAULT SYSDATETIME()
    );
END
GO
