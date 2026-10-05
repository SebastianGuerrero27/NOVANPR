"""
Logging estructurado centralizado para el microservicio ANPR.

Formato: [TIMESTAMP] [LEVEL] [COMPONENTE] mensaje
Todos los módulos deben usar get_logger("nombre_componente") en vez de print().
"""

import logging
import sys
from app.infraestructura.config import LOG_LEVEL


# Formato estructurado: timestamp ISO, nivel, componente, mensaje
_LOG_FORMAT = "[%(asctime)s] [%(levelname)-8s] [%(name)-18s] %(message)s"
_DATE_FORMAT = "%Y-%m-%dT%H:%M:%S"

# Configurar handler raíz una sola vez
_root_configured = False


def _configure_root() -> None:
    """Configura el handler raíz de logging una sola vez."""
    global _root_configured
    if _root_configured:
        return

    root = logging.getLogger()
    root.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))

    # Handler a stdout con formato estructurado
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))
    handler.setFormatter(logging.Formatter(_LOG_FORMAT, datefmt=_DATE_FORMAT))

    # Limpiar handlers previos (evita duplicados en recarga)
    root.handlers.clear()
    root.addHandler(handler)

    # Silenciar loggers ruidosos de terceros
    logging.getLogger("ultralytics").setLevel(logging.WARNING)
    logging.getLogger("easyocr").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    _root_configured = True


def get_logger(component: str) -> logging.Logger:
    """
    Obtiene un logger con nombre de componente para logging estructurado.

    Args:
        component: Nombre del componente (ej: "video_source", "detector", "ocr")

    Returns:
        Logger configurado con el formato del microservicio.

    Ejemplo:
        >>> logger = get_logger("detector")
        >>> logger.info("Modelo cargado: %s", model_path)
        [2026-08-12T04:30:00] [INFO    ] [detector          ] Modelo cargado: yolo11n.pt
    """
    _configure_root()
    return logging.getLogger(component)
