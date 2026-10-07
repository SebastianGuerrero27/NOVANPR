-- =============================================================================
-- MIGRACIÓN: Datos para evaluación científica del sistema (artículo / tesis)
--
-- 1. Conserva la lectura ORIGINAL del OCR y la decisión AUTOMÁTICA. La validación
--    manual del operador sobrescribe placa_reconocida y estado_validacion; sin estas
--    columnas no se puede medir la exactitud del sistema con datos de operación.
-- 2. Metadatos de cada captura para reportar resultados por condición
--    (luz, distancia, nitidez, velocidad, clima) y versión de los modelos usados.
-- =============================================================================

USE ANPR_ECU911;
GO

IF COL_LENGTH('DeteccionVehiculo', 'placa_ocr_original') IS NULL
    ALTER TABLE DeteccionVehiculo ADD placa_ocr_original VARCHAR(20) NULL;
GO
IF COL_LENGTH('DeteccionVehiculo', 'confianza_ocr_original') IS NULL
    ALTER TABLE DeteccionVehiculo ADD confianza_ocr_original FLOAT NULL;
GO
IF COL_LENGTH('DeteccionVehiculo', 'decision_automatica') IS NULL
    ALTER TABLE DeteccionVehiculo ADD decision_automatica VARCHAR(30) NULL;
GO
IF COL_LENGTH('DeteccionVehiculo', 'lectura_verificador') IS NULL
    ALTER TABLE DeteccionVehiculo ADD lectura_verificador VARCHAR(20) NULL;
GO
IF COL_LENGTH('DeteccionVehiculo', 'latencia_ms') IS NULL
    ALTER TABLE DeteccionVehiculo ADD latencia_ms INT NULL;
GO
IF COL_LENGTH('DeteccionVehiculo', 'luminancia_media') IS NULL
    ALTER TABLE DeteccionVehiculo ADD luminancia_media FLOAT NULL;
GO
IF COL_LENGTH('DeteccionVehiculo', 'distancia_estimada_m') IS NULL
    ALTER TABLE DeteccionVehiculo ADD distancia_estimada_m FLOAT NULL;
GO
IF COL_LENGTH('DeteccionVehiculo', 'ancho_placa_px') IS NULL
    ALTER TABLE DeteccionVehiculo ADD ancho_placa_px INT NULL;
GO
IF COL_LENGTH('DeteccionVehiculo', 'nitidez') IS NULL
    ALTER TABLE DeteccionVehiculo ADD nitidez FLOAT NULL;
GO
IF COL_LENGTH('DeteccionVehiculo', 'velocidad_px_s') IS NULL
    ALTER TABLE DeteccionVehiculo ADD velocidad_px_s FLOAT NULL;
GO
IF COL_LENGTH('DeteccionVehiculo', 'condicion_clima') IS NULL
    ALTER TABLE DeteccionVehiculo ADD condicion_clima VARCHAR(20) NULL;  -- anotación manual opcional
GO
IF COL_LENGTH('DeteccionVehiculo', 'modelo_detector') IS NULL
    ALTER TABLE DeteccionVehiculo ADD modelo_detector VARCHAR(100) NULL;
GO
IF COL_LENGTH('DeteccionVehiculo', 'modelo_ocr') IS NULL
    ALTER TABLE DeteccionVehiculo ADD modelo_ocr VARCHAR(100) NULL;
GO
IF COL_LENGTH('DeteccionVehiculo', 'fecha_validacion') IS NULL
    ALTER TABLE DeteccionVehiculo ADD fecha_validacion DATETIME NULL;
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_Deteccion_Validacion_Fecha')
    CREATE NONCLUSTERED INDEX IX_Deteccion_Validacion_Fecha
        ON DeteccionVehiculo (validado_manualmente, fecha_hora_ingreso);
GO

PRINT '[DB] Migración de evaluación aplicada.';
GO
