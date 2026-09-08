"""
Emisión dual de eventos de detección ANPR — Modelo OpenALPR Scout.

Canal 1 (Principal): HTTP POST → /api/detecciones/sync (tabla DeteccionVehiculo)
Canal 2 (Legacy):     HTTP POST → /api/eventos/sync    (tabla EventosIngreso) — opcional
Canal 3:              Socket.IO → Frontend (baja latencia en tiempo real)

Ambos canales HTTP operan de forma asíncrona y tolerante a fallos:
  - Si Socket.IO falla, HTTP sigue funcionando y viceversa.
  - Si el endpoint legacy falla, el principal no se ve afectado.
  - Ningún fallo de emisión bloquea el pipeline de detección.
"""

from __future__ import annotations

import asyncio
from typing import Optional

import httpx
import socketio

from app.config import (
    BACKEND_SOCKETIO_URL,
    BACKEND_URL,
    CAMERA_ID,
    LEGACY_SYNC_ENABLED,
    SYNC_ENDPOINT,
)
from app.core.detector import Detection
from app.utils.logger import get_logger

logger = get_logger("event_emitter")


class EventEmitter:
    """
    Emisor dual de eventos de detección — Modelo OpenALPR Scout.

    Envía cada detección por hasta tres canales independientes:
      1. HTTP POST al nuevo endpoint /api/detecciones/sync (DeteccionVehiculo)
      2. HTTP POST al endpoint legacy /api/eventos/sync (EventosIngreso) — si LEGACY_SYNC_ENABLED
      3. Socket.IO al frontend para visualización en tiempo real
    """

    def __init__(self) -> None:
        # --- HTTP Client (async) ---
        self._http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=5.0),
        )

        # Endpoint principal (nuevo modelo OpenALPR Scout)
        self._sync_url = f"{BACKEND_URL}{SYNC_ENDPOINT}"

        # Endpoint legacy (EventosIngreso — compatible con Dashboard existente)
        self._legacy_sync_url = f"{BACKEND_URL}/api/eventos/sync"
        self._legacy_enabled = LEGACY_SYNC_ENABLED

        # --- Socket.IO Client (async) ---
        self._sio: Optional[socketio.AsyncClient] = None
        self._sio_connected = False
        self._sio_url = BACKEND_SOCKETIO_URL

        logger.info(
            "EventEmitter inicializado. "
            "Principal: %s | Legacy: %s (habilitado: %s) | Socket.IO: %s",
            self._sync_url,
            self._legacy_sync_url,
            self._legacy_enabled,
            self._sio_url,
        )

    # -------------------------------------------------------------------------
    # Conexión Socket.IO
    # -------------------------------------------------------------------------

    async def connect_socketio(self) -> None:
        """
        Conecta el cliente Socket.IO al servidor del backend Node.js.

        El microservicio Python se conecta como CLIENTE al servidor Socket.IO
        del backend, y usa server_emit para que los eventos lleguen a todos
        los clientes del frontend sin que estos necesiten una segunda conexión.
        """
        if self._sio_connected:
            return

        try:
            self._sio = socketio.AsyncClient(
                reconnection=True,
                reconnection_attempts=0,  # Intentos infinitos
                reconnection_delay=2,
                reconnection_delay_max=30,
                logger=False,
            )

            @self._sio.event
            async def connect():
                self._sio_connected = True
                logger.info("Socket.IO conectado al backend: %s", self._sio_url)

            @self._sio.event
            async def disconnect():
                self._sio_connected = False
                logger.warning("Socket.IO desconectado del backend.")

            @self._sio.event
            async def connect_error(data):
                logger.warning("Error de conexión Socket.IO: %s", data)

            await self._sio.connect(
                self._sio_url,
                transports=["websocket", "polling"],
                wait_timeout=10,
            )

        except Exception as e:
            logger.warning(
                "No se pudo conectar Socket.IO al backend (%s). "
                "Las detecciones se enviarán solo por HTTP. Error: %s",
                self._sio_url, e,
            )
            self._sio_connected = False

    # -------------------------------------------------------------------------
    # Emisión de Eventos
    # -------------------------------------------------------------------------

    async def emit(self, detection: Detection) -> None:
        """
        Emite una detección por todos los canales activos.

        Canales (todos independientes — si uno falla, los otros continúan):
          1. HTTP POST → /api/detecciones/sync (principal)
          2. HTTP POST → /api/eventos/sync (legacy, si habilitado)
          3. Socket.IO → anpr:deteccion

        Args:
            detection: Detección validada y deduplicada.
        """
        tasks = [
            self._emit_http_principal(detection),
            self._emit_socketio(detection),
        ]

        if self._legacy_enabled:
            tasks.append(self._emit_http_legacy(detection))

        results = await asyncio.gather(*tasks, return_exceptions=True)

        channel_names = ["HTTP-Principal", "Socket.IO"]
        if self._legacy_enabled:
            channel_names.append("HTTP-Legacy")

        for i, result in enumerate(results):
            if isinstance(result, Exception):
                logger.error(
                    "Error en emisión %s para placa %s: %s",
                    channel_names[i], detection.placa, result,
                )

    async def _emit_http_principal(self, detection: Detection) -> None:
        """
        Envía la detección al nuevo endpoint /api/detecciones/sync.

        Payload extendido con confianzas separadas, tracking_id y fuente.
        Persiste en tabla DeteccionVehiculo con estado de validación.
        """
        payload = {
            "placa": detection.placa,
            "confianza_deteccion": detection.confianza_deteccion,
            "confianza_ocr": detection.confianza_ocr,
            "imagen_vehiculo_path": detection.imagen_vehiculo_path,
            "imagen_placa_path": detection.imagen_placa_path,
            "tracking_id": detection.tracking_id,
            "fuente": detection.fuente or "webcam",
            "camara_id": CAMERA_ID,
        }

        try:
            response = await self._http_client.post(
                self._sync_url,
                json=payload,
            )

            if response.status_code == 201:
                data = response.json()
                estado = data.get("estado_validacion", "?")
                logger.info(
                    "SYNC OK → placa %s | estado: %s | endpoint: %s",
                    detection.placa, estado.upper(), self._sync_url,
                )
            else:
                logger.warning(
                    "Respuesta inesperada de %s: %d — %s",
                    self._sync_url, response.status_code, response.text[:200],
                )

        except httpx.ConnectError:
            logger.warning(
                "Backend no alcanzable en %s. "
                "La detección de placa %s NO se persistió en DeteccionVehiculo.",
                self._sync_url, detection.placa,
            )
        except httpx.TimeoutException:
            logger.warning(
                "Timeout al sincronizar placa %s con %s.",
                detection.placa, self._sync_url,
            )
        except Exception as e:
            logger.error(
                "Error inesperado en emisión HTTP principal para placa %s: %s",
                detection.placa, e,
            )

    async def _emit_http_legacy(self, detection: Detection) -> None:
        """
        Envía la detección al endpoint legacy /api/eventos/sync.

        Mantiene el contrato original para compatibilidad con EventosIngreso
        y el Dashboard existente. Se puede desactivar con LEGACY_SYNC_ENABLED=false.
        """
        payload = {
            "placa": detection.placa,
            "confianza_placa": detection.confianza_ocr,
            "imagen_vehiculo_path": detection.imagen_vehiculo_path,
            "imagen_placa_path": detection.imagen_placa_path,
            "camara_id": CAMERA_ID,
        }

        try:
            response = await self._http_client.post(
                self._legacy_sync_url,
                json=payload,
            )

            if response.status_code == 201:
                logger.debug(
                    "SYNC Legacy OK → placa %s → EventosIngreso",
                    detection.placa,
                )
            else:
                logger.debug(
                    "Legacy sync respuesta: %d", response.status_code,
                )

        except Exception as e:
            logger.debug(
                "Error en sync legacy para placa %s: %s (no crítico)",
                detection.placa, e,
            )

    async def _emit_socketio(self, detection: Detection) -> None:
        """
        Emite la detección al frontend vía Socket.IO (a través del backend).

        Evento: 'anpr:deteccion'
        Payload extendido con información de tracking y fuente.
        """
        if not self._sio_connected or self._sio is None:
            logger.debug(
                "Socket.IO no conectado. Placa %s no emitida por WebSocket.",
                detection.placa,
            )
            return

        event_data = {
            "timestamp": detection.timestamp,
            "tracking_id": detection.tracking_id,
            "placa": detection.placa,
            "confianza_ocr": detection.confianza_ocr,
            "confianza_deteccion": detection.confianza_deteccion,
            "fuente": detection.fuente,
            "imagen_vehiculo_path": detection.imagen_vehiculo_path,
            "imagen_placa_path": detection.imagen_placa_path,
        }

        try:
            await self._sio.emit("anpr:deteccion", event_data)
            logger.debug(
                "Evento Socket.IO emitido: placa %s (track #%d)",
                detection.placa, detection.tracking_id,
            )
        except Exception as e:
            logger.warning(
                "Error al emitir Socket.IO para placa %s: %s",
                detection.placa, e,
            )

    # -------------------------------------------------------------------------
    # Ciclo de Vida
    # -------------------------------------------------------------------------

    async def close(self) -> None:
        """Cierra las conexiones HTTP y Socket.IO de forma limpia."""
        try:
            await self._http_client.aclose()
            logger.info("Cliente HTTP cerrado.")
        except Exception as e:
            logger.warning("Error al cerrar cliente HTTP: %s", e)

        if self._sio is not None:
            try:
                await self._sio.disconnect()
                logger.info("Cliente Socket.IO desconectado.")
            except Exception as e:
                logger.warning("Error al desconectar Socket.IO: %s", e)

    @property
    def socketio_connected(self) -> bool:
        """Indica si la conexión Socket.IO está activa."""
        return self._sio_connected
