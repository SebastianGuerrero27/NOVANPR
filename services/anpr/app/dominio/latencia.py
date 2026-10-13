"""
Latencia de tiempo real del motor, medida desde la captura de cada cuadro (hora en que el lector
RTSP lo recibió) y no solo como fluidez del video:

  edad del cuadro    captura → inicio de su análisis (cuánto atraso lleva el motor).
  lectura en vivo    captura del cuadro leído → lectura disponible para el HUD (de ahí llega al
                     navegador por /ws/pistas en ≤ 0,1 s).
  registro           captura del mejor cuadro del paso → el backend confirma la lectura (y la
                     difunde por Socket.IO).
  descartados        cuadros de la cámara que nunca se analizaron porque llegó uno más nuevo.

Política de colas: entre la captura y la detección hay un solo lugar (el cuadro más reciente).
Si la inferencia no alcanza la tasa de la cámara, el motor no acumula retraso: analiza siempre
el último cuadro y descarta los intermedios, y esa proporción se informa. El OCR tiene a lo sumo
una lectura en curso por pista (con enfriamiento y un máximo de 3 por pista), así que su cola
está acotada por el número de vehículos a la vista.
"""

from __future__ import annotations

import threading
from collections import deque
from typing import Optional


class VentanaLatencia:
    """Últimas N mediciones (segundos) con percentiles para /status."""

    def __init__(self, n: int = 200) -> None:
        self._valores: deque[float] = deque(maxlen=n)
        self._candado = threading.Lock()

    def registrar(self, segundos: float) -> None:
        if segundos >= 0:
            with self._candado:
                self._valores.append(segundos)

    def resumen(self) -> Optional[dict]:
        with self._candado:
            datos = sorted(self._valores)
        if not datos:
            return None

        def percentil(q: float) -> int:
            return round(datos[min(len(datos) - 1, int(round(q * (len(datos) - 1))))] * 1000)

        return {"p50_ms": percentil(0.5), "p95_ms": percentil(0.95), "max_ms": round(datos[-1] * 1000), "muestras": len(datos)}


class Cronometros:
    """Duración de cada etapa del procesamiento (últimas N mediciones por etapa), para /status:
    dónde se va el tiempo de un cuadro y de un registro."""

    def __init__(self, n: int = 200) -> None:
        self._n = n
        self._etapas: dict[str, VentanaLatencia] = {}
        self._candado = threading.Lock()

    def registrar(self, etapa: str, segundos: float) -> None:
        with self._candado:
            ventana = self._etapas.get(etapa)
            if ventana is None:
                ventana = self._etapas[etapa] = VentanaLatencia(self._n)
        ventana.registrar(segundos)

    def resumen(self) -> dict:
        with self._candado:
            etapas = dict(self._etapas)
        return {nombre: ventana.resumen() for nombre, ventana in sorted(etapas.items())}


class VentanaDescartes:
    """Proporción de cuadros de la cámara descartados en los últimos N análisis."""

    def __init__(self, n: int = 300) -> None:
        self._perdidos: deque[int] = deque(maxlen=n)
        self._candado = threading.Lock()

    def registrar(self, perdidos: int) -> None:
        with self._candado:
            self._perdidos.append(max(0, perdidos))

    def porcentaje(self) -> Optional[float]:
        with self._candado:
            analizados, perdidos = len(self._perdidos), sum(self._perdidos)
        total = analizados + perdidos
        return round(100.0 * perdidos / total, 1) if total else None
