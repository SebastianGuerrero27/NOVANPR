-- =============================================================================
-- LIMPIEZA DE DATOS DE PRUEBA (ejecución MANUAL y de UN SOLO USO)
--
-- Borra detecciones, listas, cámaras y auditorías operativas, elimina la tabla de
-- usuarios v1 (Usuarios_v1_legacy) y reinicia los contadores de identidad.
-- NO toca el catálogo de roles ni el esquema.
--
-- ANTES: respaldar la base (BACKUP DATABASE ...). Para ejecutarlo, cambie la línea
--   DECLARE @confirmar VARCHAR(30) = 'NO';
-- por
--   DECLARE @confirmar VARCHAR(30) = 'SI_BORRAR_TODO';
-- =============================================================================

USE ANPR_ECU911;

DECLARE @confirmar VARCHAR(30) = 'NO';

IF @confirmar <> 'SI_BORRAR_TODO'
BEGIN
    RAISERROR('Limpieza cancelada: falta la confirmación explícita (@confirmar = ''SI_BORRAR_TODO'').', 16, 1);
    RETURN;
END

BEGIN TRANSACTION;

DELETE FROM DeteccionVehiculo;
DELETE FROM AuditoriaDescartes;
IF OBJECT_ID('dbo.AuditoriaConsultaPropietario') IS NOT NULL DELETE FROM AuditoriaConsultaPropietario;
DELETE FROM ListaNegra;
DELETE FROM VehiculosAutorizados;
DELETE FROM Camaras;
IF OBJECT_ID('dbo.EventosIngreso') IS NOT NULL DROP TABLE EventosIngreso;
IF OBJECT_ID('dbo.Usuarios_v1_legacy') IS NOT NULL DROP TABLE Usuarios_v1_legacy;

DBCC CHECKIDENT ('DeteccionVehiculo', RESEED, 0);
DBCC CHECKIDENT ('AuditoriaDescartes', RESEED, 0);
DBCC CHECKIDENT ('ListaNegra', RESEED, 0);
DBCC CHECKIDENT ('VehiculosAutorizados', RESEED, 0);
DBCC CHECKIDENT ('Camaras', RESEED, 0);

COMMIT TRANSACTION;

SELECT 'DeteccionVehiculo' AS tabla, COUNT(*) AS filas FROM DeteccionVehiculo
UNION ALL SELECT 'ListaNegra', COUNT(*) FROM ListaNegra
UNION ALL SELECT 'VehiculosAutorizados', COUNT(*) FROM VehiculosAutorizados
UNION ALL SELECT 'Camaras', COUNT(*) FROM Camaras
UNION ALL SELECT 'Usuarios', COUNT(*) FROM Usuarios
UNION ALL SELECT 'Roles', COUNT(*) FROM Roles;
