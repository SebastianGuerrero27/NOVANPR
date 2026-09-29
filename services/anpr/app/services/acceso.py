"""
Control de acceso a los endpoints del microservicio ANPR.

- Endpoints de control (cambio de cámara, previsualización RTSP, MJPEG de depuración):
  encabezado X-Servicio-Token igual a ANPR_SERVICE_TOKEN (solo el backend lo conoce).
- WebSockets de video y webcam: ticket de 60 s emitido por el backend a un usuario con
  sesión válida (HMAC-SHA256 con ANPR_SERVICE_TOKEN sobre {u, a, exp}).

Sin ANPR_SERVICE_TOKEN (desarrollo local) se permite el acceso con una advertencia.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

from app.config import ANPR_SERVICE_TOKEN
from app.utils.logger import get_logger

logger = get_logger("acceso")
_aviso_emitido = False


def _sin_token() -> bool:
    global _aviso_emitido
    if not ANPR_SERVICE_TOKEN:
        if not _aviso_emitido:
            logger.warning("ANPR_SERVICE_TOKEN no definido: endpoints de control y video sin protección (solo desarrollo).")
            _aviso_emitido = True
        return True
    return False


def token_servicio_valido(valor: str | None) -> bool:
    if _sin_token():
        return True
    return bool(valor) and hmac.compare_digest(valor.encode(), ANPR_SERVICE_TOKEN.encode())


def _b64decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def ticket_valido(ticket: str | None, alcance: str) -> bool:
    """Verifica firma, vencimiento y alcance ('stream' o 'webcam') del ticket del backend."""
    if _sin_token():
        return True
    if not ticket or "." not in ticket:
        return False
    payload, firma = ticket.rsplit(".", 1)
    esperada = base64.urlsafe_b64encode(
        hmac.new(ANPR_SERVICE_TOKEN.encode(), payload.encode(), hashlib.sha256).digest()
    ).decode().rstrip("=")
    if not hmac.compare_digest(esperada, firma):
        return False
    try:
        datos = json.loads(_b64decode(payload))
    except (ValueError, json.JSONDecodeError):
        return False
    if int(datos.get("exp", 0)) < time.time():
        return False
    # Un ticket de webcam (administrador) también permite ver el video
    return datos.get("a") == alcance or (alcance == "stream" and datos.get("a") == "webcam")
