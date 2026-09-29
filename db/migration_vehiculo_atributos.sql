-- =============================================================================
-- MIGRACIÓN: Atributos del vehículo como segundo factor (marca, modelo, color, tipo)
--
-- DeteccionVehiculo guarda lo OBSERVADO por la cámara (YOLO26n + CLIP zero-shot).
-- ListaNegra y VehiculosAutorizados guardan lo REGISTRADO por el administrador.
-- Si ambos existen y no coinciden, se marca verificacion_vehiculo = 'no_coincide'
-- (posible placa clonada o error de lectura) para que el operador revise.
-- =============================================================================

USE ANPR_ECU911;
GO

IF COL_LENGTH('DeteccionVehiculo', 'vehiculo_tipo') IS NULL
    ALTER TABLE DeteccionVehiculo ADD vehiculo_tipo VARCHAR(30) NULL;
GO
IF COL_LENGTH('DeteccionVehiculo', 'vehiculo_color') IS NULL
    ALTER TABLE DeteccionVehiculo ADD vehiculo_color VARCHAR(30) NULL;
GO
IF COL_LENGTH('DeteccionVehiculo', 'vehiculo_marca') IS NULL
    ALTER TABLE DeteccionVehiculo ADD vehiculo_marca VARCHAR(50) NULL;
GO
IF COL_LENGTH('DeteccionVehiculo', 'vehiculo_modelo') IS NULL
    ALTER TABLE DeteccionVehiculo ADD vehiculo_modelo VARCHAR(50) NULL;
GO
IF COL_LENGTH('DeteccionVehiculo', 'vehiculo_atributos_json') IS NULL
    ALTER TABLE DeteccionVehiculo ADD vehiculo_atributos_json NVARCHAR(500) NULL;  -- confianzas y fuente de la caja
GO
IF COL_LENGTH('DeteccionVehiculo', 'verificacion_vehiculo') IS NULL
    ALTER TABLE DeteccionVehiculo ADD verificacion_vehiculo VARCHAR(20) NULL;     -- coincide | no_coincide | sin_datos
GO
IF COL_LENGTH('DeteccionVehiculo', 'verificacion_detalle') IS NULL
    ALTER TABLE DeteccionVehiculo ADD verificacion_detalle VARCHAR(255) NULL;
GO

IF COL_LENGTH('ListaNegra', 'marca') IS NULL
    ALTER TABLE ListaNegra ADD marca VARCHAR(50) NULL;
GO
IF COL_LENGTH('ListaNegra', 'modelo') IS NULL
    ALTER TABLE ListaNegra ADD modelo VARCHAR(50) NULL;
GO
IF COL_LENGTH('ListaNegra', 'color') IS NULL
    ALTER TABLE ListaNegra ADD color VARCHAR(30) NULL;
GO

IF COL_LENGTH('VehiculosAutorizados', 'marca') IS NULL
    ALTER TABLE VehiculosAutorizados ADD marca VARCHAR(50) NULL;
GO
IF COL_LENGTH('VehiculosAutorizados', 'modelo') IS NULL
    ALTER TABLE VehiculosAutorizados ADD modelo VARCHAR(50) NULL;
GO
IF COL_LENGTH('VehiculosAutorizados', 'color') IS NULL
    ALTER TABLE VehiculosAutorizados ADD color VARCHAR(30) NULL;
GO

PRINT '[DB] Migración de atributos del vehículo aplicada.';
GO
