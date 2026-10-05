"""Credenciales en URLs RTSP (dominio puro)."""
import re

# La contraseña se lee como la conexión (FFmpeg, MediaMTX, WHATWG): llega hasta la última «@» de la
# autoridad y el usuario puede estar vacío (backend/src/dominio/camaras.ts → RE_CREDENCIALES).
_RE_CREDENCIALES = re.compile(r"//([^:/?#]*):[^/?#]+@")


def sin_credenciales(url: str | None) -> str | None:
    """Oculta la contraseña de una URL RTSP antes de exponerla en respuestas o registros."""
    return _RE_CREDENCIALES.sub(r"//\1:******@", url) if url else url
