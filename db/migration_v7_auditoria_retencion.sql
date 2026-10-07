-- =============================================================================
-- Migración v7 · Retención de la auditoría: tablas de archivo (idempotente)
--
-- La auditoría es de solo inserción (ISO/IEC 27001 A.8.15, OWASP ASVS V7, NIST SP 800-92):
-- ninguna operación edita ni borra un registro. Para que las tablas de consulta diaria no
-- crezcan sin límite, la retención (POST /api/auditoria/retencion) traslada los registros más
-- antiguos que el plazo indicado a estas tablas, en una sola transacción (INSERT…SELECT y
-- después DELETE solo de lo copiado): la evidencia se conserva completa.
--
--   AuditoriaOperaciones  →  AuditoriaOperacionesArchivo
--   AuditoriaUsuarios     →  AuditoriaUsuariosArchivo
--   AuditoriaAccesos      →  AuditoriaAccesosArchivo
--
-- Mismas columnas que la tabla de origen (init.sql; migraciones v2 y v3) más fecha_archivado.
-- El id no es IDENTITY: conserva el valor original, de modo que el registro archivado sigue
-- siendo el mismo que se consultó o exportó antes de archivarlo.
-- =============================================================================

IF OBJECT_ID('dbo.AuditoriaOperacionesArchivo', 'U') IS NULL
BEGIN
    CREATE TABLE AuditoriaOperacionesArchivo (
        id               BIGINT        NOT NULL PRIMARY KEY,
        fecha            DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
        usuario_id       INT           NULL REFERENCES Usuarios(id),
        usuario_email    NVARCHAR(150) NULL,
        accion           VARCHAR(50)   NOT NULL,
        entidad          VARCHAR(40)   NOT NULL,
        entidad_id       INT           NULL,
        detalle          NVARCHAR(500) NULL,
        ip               VARCHAR(45)   NULL,
        fecha_archivado  DATETIME2     NOT NULL DEFAULT SYSDATETIME()
    );
    CREATE INDEX IX_AuditoriaOperacionesArchivo_Fecha ON AuditoriaOperacionesArchivo (fecha DESC);
END
GO

IF OBJECT_ID('dbo.AuditoriaUsuariosArchivo', 'U') IS NULL
BEGIN
    CREATE TABLE AuditoriaUsuariosArchivo (
        id               BIGINT        NOT NULL PRIMARY KEY,
        fecha            DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
        accion           VARCHAR(50)   NOT NULL,
        actor_id         INT           NULL REFERENCES Usuarios(id),
        actor_email      NVARCHAR(150) NULL,
        objetivo_id      INT           NULL,
        objetivo_email   NVARCHAR(150) NULL,
        detalle          NVARCHAR(500) NULL,
        ip               VARCHAR(45)   NULL,
        fecha_archivado  DATETIME2     NOT NULL DEFAULT SYSDATETIME()
    );
    CREATE INDEX IX_AuditoriaUsuariosArchivo_Fecha ON AuditoriaUsuariosArchivo (fecha DESC);
END
GO

IF OBJECT_ID('dbo.AuditoriaAccesosArchivo', 'U') IS NULL
BEGIN
    CREATE TABLE AuditoriaAccesosArchivo (
        id               BIGINT        NOT NULL PRIMARY KEY,
        fecha            DATETIME2     NOT NULL DEFAULT SYSDATETIME(),
        email            NVARCHAR(150) NOT NULL,
        usuario_id       INT           NULL REFERENCES Usuarios(id),
        exito            BIT           NOT NULL,
        motivo           VARCHAR(50)   NULL,   -- ok, credenciales, bloqueado, no_verificado, inactivo
        ip               VARCHAR(45)   NULL,
        user_agent       NVARCHAR(255) NULL,
        fecha_archivado  DATETIME2     NOT NULL DEFAULT SYSDATETIME()
    );
    CREATE INDEX IX_AuditoriaAccesosArchivo_Fecha ON AuditoriaAccesosArchivo (fecha DESC);
END
GO
