-- =============================================================================
-- Migración v6 · Tres roles: Administrador, Guardia y Gestor de permisos (idempotente)
--
--   OPERADOR        → GUARDIA          (se renombra: conserva id y usuarios)
--   GESTOR_ACCESOS  → GESTOR_PERMISOS  (se renombra: conserva id y usuarios)
--   SUPERVISOR      → se elimina; sus cuentas pasan a GUARDIA (mínimo privilegio: el
--                     administrador puede promoverlas después desde Usuarios)
--
-- La matriz rol → permiso vive en backend/src/dominio/permisos.ts.
-- =============================================================================

-- 1. Guardia: renombra OPERADOR si GUARDIA aún no existe; si ya existen ambos, GUARDIA se conserva
IF NOT EXISTS (SELECT 1 FROM Roles WHERE codigo = 'GUARDIA')
    UPDATE Roles SET codigo = 'GUARDIA', nombre = N'Guardia',
        descripcion = N'Monitoreo en vivo del punto de control, validación de ingresos y consulta de la lista blanca.'
    WHERE codigo = 'OPERADOR';
IF NOT EXISTS (SELECT 1 FROM Roles WHERE codigo = 'GUARDIA')
    INSERT INTO Roles (codigo, nombre, descripcion)
    VALUES ('GUARDIA', N'Guardia', N'Monitoreo en vivo del punto de control, validación de ingresos y consulta de la lista blanca.');
GO

-- 2. Gestor de permisos
IF NOT EXISTS (SELECT 1 FROM Roles WHERE codigo = 'GESTOR_PERMISOS')
    UPDATE Roles SET codigo = 'GESTOR_PERMISOS', nombre = N'Gestor de permisos',
        descripcion = N'Otorga los permisos de placa (lista blanca) y resuelve las solicitudes de acceso.'
    WHERE codigo = 'GESTOR_ACCESOS';
IF NOT EXISTS (SELECT 1 FROM Roles WHERE codigo = 'GESTOR_PERMISOS')
    INSERT INTO Roles (codigo, nombre, descripcion)
    VALUES ('GESTOR_PERMISOS', N'Gestor de permisos', N'Otorga los permisos de placa (lista blanca) y resuelve las solicitudes de acceso.');
GO

-- 3. Reasignación de cuentas de los roles retirados
UPDATE u SET rol_id = (SELECT id FROM Roles WHERE codigo = 'GUARDIA')
FROM Usuarios u JOIN Roles r ON r.id = u.rol_id
WHERE r.codigo IN ('OPERADOR', 'SUPERVISOR');

UPDATE u SET rol_id = (SELECT id FROM Roles WHERE codigo = 'GESTOR_PERMISOS')
FROM Usuarios u JOIN Roles r ON r.id = u.rol_id
WHERE r.codigo = 'GESTOR_ACCESOS';
GO

-- 4. Solo quedan los tres roles
DELETE FROM Roles WHERE codigo IN ('OPERADOR', 'SUPERVISOR', 'GESTOR_ACCESOS');
GO
