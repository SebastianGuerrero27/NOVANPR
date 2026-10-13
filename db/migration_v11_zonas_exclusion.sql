-- =============================================================================
-- Migración v11 · Zonas de exclusión de las cámaras (idempotente)
--
-- Polígonos que dibuja el administrador sobre el video donde el motor ANPR no cuenta el movimiento
-- ni busca placas (árboles, banderas, reflejos, la vereda, la hora sobreimpresa): evitan que el
-- detector se dispare por movimiento falso. JSON [[[x, y], ...], ...] con vértices normalizados
-- 0–1; NULL = ninguna. Solo agrega la columna: no modifica registros.
-- =============================================================================

IF COL_LENGTH('dbo.Camaras', 'exclusiones') IS NULL
    ALTER TABLE Camaras ADD exclusiones NVARCHAR(MAX) NULL;
GO
