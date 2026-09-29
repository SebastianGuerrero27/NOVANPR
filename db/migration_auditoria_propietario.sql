-- =============================================================================
-- MIGRACIÓN: Auditoría de consultas de datos del propietario de un vehículo
--
-- Los datos del propietario son datos personales (LOPDP, Ecuador 2021). Solo pueden
-- obtenerse por un canal oficial autorizado (convenio con DINARDAP / ANT) y cada
-- consulta debe quedar registrada: quién, qué placa, con qué motivo y cuándo.
-- =============================================================================

USE ANPR_ECU911;
GO

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AuditoriaConsultaPropietario')
BEGIN
    CREATE TABLE AuditoriaConsultaPropietario (
        id              INT IDENTITY(1,1) PRIMARY KEY,
        usuario_id      INT          NOT NULL,
        usuario_nombre  VARCHAR(100) NULL,
        placa           VARCHAR(20)  NOT NULL,
        motivo          VARCHAR(255) NOT NULL,
        deteccion_id    INT          NULL,
        proveedor       VARCHAR(50)  NOT NULL,
        resultado       VARCHAR(20)  NOT NULL,   -- ok | no_encontrado | error | deshabilitado | limite
        fecha           DATETIME     DEFAULT GETDATE()
    );
    CREATE INDEX IX_AuditoriaPropietario_Fecha ON AuditoriaConsultaPropietario (fecha);
    CREATE INDEX IX_AuditoriaPropietario_Usuario ON AuditoriaConsultaPropietario (usuario_id, fecha);
    PRINT '[DB] Tabla AuditoriaConsultaPropietario creada.';
END
GO
