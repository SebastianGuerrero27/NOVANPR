"""
Registros en memoria con marca de tiempo (anti-duplicados y enfriamiento por track).

El servicio corre 24/7 y los tracking_id crecen sin fin: un diccionario que solo agrega
entradas es una fuga de memoria lenta. `purgar_expirados` elimina las entradas cuya marca
supera el horizonte; se invoca bajo el mismo candado que protege al diccionario.
"""

from __future__ import annotations

from typing import Hashable, MutableMapping


def purgar_expirados(registro: MutableMapping[Hashable, float], ahora: float, horizonte_s: float) -> int:
    """Elimina las entradas con (ahora - marca) > horizonte_s. Devuelve cuántas eliminó."""
    viejas = [k for k, marca in registro.items() if ahora - marca > horizonte_s]
    for k in viejas:
        registro.pop(k, None)
    return len(viejas)
