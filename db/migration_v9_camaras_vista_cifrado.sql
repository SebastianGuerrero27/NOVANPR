-- =============================================================================
-- Migración v9 · Flujo de vista y credenciales cifradas de las cámaras (idempotente)
--
-- rtsp_url_vista: flujo secundario de la cámara (p. ej. Hikvision /Streaming/Channels/102,
-- H.264 640×360) para la vista en vivo del navegador; el flujo principal (101) queda para el
-- reconocimiento. Así la vista funciona en cualquier navegador aunque el principal sea H.265.
--
-- La contraseña RTSP se guarda cifrada (AES-256-GCM) dentro de la URL; el texto cifrado ocupa
-- más que la contraseña, por eso las columnas pasan a 512 caracteres. El backend cifra al
-- arrancar las URL que aún tengan la contraseña en claro.
-- =============================================================================

IF COL_LENGTH('dbo.Camaras', 'rtsp_url') < 512
    ALTER TABLE Camaras ALTER COLUMN rtsp_url VARCHAR(512) NOT NULL;
GO

IF COL_LENGTH('dbo.Camaras', 'rtsp_url_vista') IS NULL
    ALTER TABLE Camaras ADD rtsp_url_vista VARCHAR(512) NULL;
GO
