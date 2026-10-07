-- =============================================================================
-- Migración v4 · Validez de la lectura y región de interés (idempotente)
--
--  1. Camaras.roi: polígono de la región de interés (JSON con vértices normalizados 0–1).
--     Equivale a la "detection mask" de OpenALPR: fuera de ella el motor no busca placas.
--  2. DeteccionVehiculo.lectura_valida / evidencia_lectura: veredicto del motor sobre la
--     lectura (formato ANT, placa completa en cuadro, fila de caracteres, consenso
--     multi-cuadro o segundo OCR) y sus evidencias en JSON. Solo una lectura válida puede
--     autorizarse sin intervención del personal.
-- =============================================================================

IF COL_LENGTH('Camaras', 'roi') IS NULL
    ALTER TABLE Camaras ADD roi NVARCHAR(1000) NULL;
GO

IF COL_LENGTH('DeteccionVehiculo', 'lectura_valida') IS NULL
    ALTER TABLE DeteccionVehiculo ADD lectura_valida BIT NULL;
GO

IF COL_LENGTH('DeteccionVehiculo', 'evidencia_lectura') IS NULL
    ALTER TABLE DeteccionVehiculo ADD evidencia_lectura NVARCHAR(1500) NULL;
GO
