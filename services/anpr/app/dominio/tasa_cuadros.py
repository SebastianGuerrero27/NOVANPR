"""
Cuadros por segundo de una fuente de video.

Cuenta solo los cuadros nuevos dentro de una ventana deslizante (2 s), dividiendo por al menos
1 s: una ráfaga, como el vaciado del búfer al conectar, no produce picos como el inverso del
último intervalo, y el valor baja a 0 cuando dejan de llegar cuadros (un valor congelado haría
creer que la cámara sigue enviando).
"""
from __future__ import annotations

import threading
import time
from collections import deque
from typing import Callable, Optional


class TasaCuadros:
    def __init__(self, ventana_s: float = 2.0, reloj: Callable[[], float] = time.monotonic) -> None:
        self._ventana = ventana_s
        self._reloj = reloj
        self._marcas: deque[float] = deque()
        self._candado = threading.Lock()

    def registrar(self, instante: Optional[float] = None) -> None:
        """Un cuadro nuevo (en `instante`, o ahora)."""
        t = self._reloj() if instante is None else instante
        with self._candado:
            self._marcas.append(t)
            self._podar(t)

    def _podar(self, ahora: float) -> None:
        while self._marcas and ahora - self._marcas[0] > self._ventana:
            self._marcas.popleft()

    @property
    def valor(self) -> float:
        """Cuadros por segundo en la ventana; 0 si no llegó ninguno en ella."""
        ahora = self._reloj()
        with self._candado:
            self._podar(ahora)
            if len(self._marcas) < 2:
                return 0.0
            return (len(self._marcas) - 1) / max(ahora - self._marcas[0], 1.0)
