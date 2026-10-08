"""
Cambios en la escena para dos decisiones del pipeline:

  1. Compuerta de inferencia: el detector de placas (YOLO) solo se ejecuta si la escena cambió
     desde la última vez que se ejecutó (diferencia contra ese cuadro de referencia). Si no
     cambió, la última detección sigue siendo válida por construcción. La diferencia acumula
     los cambios lentos y también detecta lo que desaparece (un vehículo que sale), que la
     sustracción de fondo no siempre marca porque la zona que deja libre vuelve a parecerse al
     fondo aprendido. Cada `max_omitidos` cuadros hay además una inferencia de control.
  2. Movimiento (MOG2, al estilo de la detección de movimiento de OpenALPR): la zona de
     movimiento del HUD y qué pistas se han movido. Una pista que se movió es un vehículo; un
     objeto quieto que el detector confunde con una placa (rótulo, rejilla) no se dibuja
     mientras no haya evidencia de placa.

El análisis se hace sobre una copia reducida del cuadro (≤ 320 px de ancho), así que su costo
no depende de la resolución de la cámara. Con región de interés, solo cuenta lo que ocurre
dentro de ella.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np

_ANCHO_ANALISIS = 320
# Contornos menores que esta fracción del cuadro no forman zona de movimiento (ruido, hojas)
_AREA_MIN_CONTORNO = 0.002
# Escala del porcentaje mostrado en el HUD: con ~17 % del cuadro en movimiento se llega a 100 %
_GANANCIA_PORCENTAJE = 6.0
# Diferencia de gris (0–255, tras suavizado) a partir de la cual un píxel cambió respecto de la
# referencia: por encima del ruido del sensor y de la compresión de video
_UMBRAL_DIFERENCIA = 20


@dataclass(frozen=True)
class CompuertaInferencia:
    """Parámetros de la compuerta de inferencia (ver docs/METODO_VERIFICACION_LECTURA.md §2.4)."""
    activa: bool = True
    # Fracción del área analizada que debe cambiar desde la última inferencia para ejecutar el detector
    umbral: float = 0.002
    # Cuadros seguidos sin inferencia antes de una inferencia de control
    max_omitidos: int = 5


@dataclass(frozen=True)
class Movimiento:
    """Resultado del análisis de un cuadro."""
    caja: Optional[list[int]]      # zona de movimiento (MOG2) en px del cuadro original, o None
    porcentaje: int                # intensidad para el HUD (0–100)
    fraccion: float                # fracción del área analizada en movimiento (MOG2)
    cambio: float                  # fracción del área que cambió desde la última inferencia
    mascara: Optional[np.ndarray]  # máscara reducida de movimiento (255 = movimiento)
    escala: float                  # px de la máscara por px del cuadro original

    def fraccion_en(self, caja: list[int]) -> float:
        """Fracción de la caja (px del cuadro original) en movimiento en este cuadro."""
        if self.mascara is None:
            return 0.0
        alto, ancho = self.mascara.shape[:2]
        x1, y1, x2, y2 = (int(round(v * self.escala)) for v in caja)
        x1, y1 = max(0, min(ancho - 1, x1)), max(0, min(alto - 1, y1))
        x2, y2 = max(x1 + 1, min(ancho, x2)), max(y1 + 1, min(alto, y2))
        return cv2.countNonZero(self.mascara[y1:y2, x1:x2]) / float((x2 - x1) * (y2 - y1))


# Si el análisis falla se trata como cambio total: ante la duda, se ejecuta el detector
CAMBIO_DESCONOCIDO = Movimiento(caja=None, porcentaje=0, fraccion=0.0, cambio=1.0, mascara=None, escala=1.0)


class DetectorMovimiento:
    """Análisis de cambios de una fuente de video (cada fuente necesita el suyo)."""

    def __init__(self) -> None:
        self._mog2 = self._nuevo_sustractor()
        self._kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        self._roi_clave: Optional[tuple] = None
        self._roi_mascara: Optional[np.ndarray] = None
        self._gris: Optional[np.ndarray] = None        # último cuadro analizado (reducido y suavizado)
        self._referencia: Optional[np.ndarray] = None  # cuadro de la última inferencia
        self._fondo_iniciado = False

    @staticmethod
    def _nuevo_sustractor():
        return cv2.createBackgroundSubtractorMOG2(history=120, varThreshold=25, detectShadows=False)

    def reiniciar(self) -> None:
        """Olvida el fondo aprendido y la referencia (p. ej. al cambiar de cámara)."""
        self._mog2 = self._nuevo_sustractor()
        self._gris = self._referencia = None
        self._fondo_iniciado = False

    def fijar_referencia(self) -> None:
        """El último cuadro analizado pasa a ser la referencia: el detector acaba de ejecutarse sobre él."""
        self._referencia = self._gris

    def _mascara_roi(self, roi: Optional[list[list[float]]], ancho: int, alto: int) -> Optional[np.ndarray]:
        if not roi:
            return None
        clave = (tuple(map(tuple, roi)), ancho, alto)
        if clave != self._roi_clave:
            mascara = np.zeros((alto, ancho), np.uint8)
            puntos = np.array([[p[0] * ancho, p[1] * alto] for p in roi], np.int32)
            cv2.fillPoly(mascara, [puntos], 255)
            self._roi_clave, self._roi_mascara = clave, mascara
        return self._roi_mascara

    def _cambio(self, gris: np.ndarray, mascara_roi: Optional[np.ndarray], area: float) -> float:
        """Fracción del área que cambió respecto de la referencia (1.0 si no hay referencia)."""
        if self._referencia is None or self._referencia.shape != gris.shape:
            return 1.0
        _, dif = cv2.threshold(cv2.absdiff(gris, self._referencia), _UMBRAL_DIFERENCIA, 255, cv2.THRESH_BINARY)
        dif = cv2.morphologyEx(dif, cv2.MORPH_OPEN, self._kernel)
        if mascara_roi is not None:
            dif = cv2.bitwise_and(dif, mascara_roi)
        return cv2.countNonZero(dif) / area

    def analizar(self, frame: np.ndarray, roi: Optional[list[list[float]]] = None) -> Movimiento:
        try:
            alto_o, ancho_o = frame.shape[:2]
            escala = min(1.0, _ANCHO_ANALISIS / float(ancho_o))
            ancho, alto = max(1, int(ancho_o * escala)), max(1, int(alto_o * escala))
            gris = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if escala < 1.0:
                gris = cv2.resize(gris, (ancho, alto), interpolation=cv2.INTER_AREA)
            mascara_roi = self._mascara_roi(roi, ancho, alto)
            area = max(1.0, float(cv2.countNonZero(mascara_roi))) if mascara_roi is not None else float(ancho * alto)

            # Cambio desde la última inferencia (compuerta)
            suave = cv2.GaussianBlur(gris, (5, 5), 0)
            cambio = self._cambio(suave, mascara_roi, area)
            self._gris = suave

            # Movimiento respecto del fondo aprendido (zona del HUD y pistas en movimiento)
            _, mascara = cv2.threshold(self._mog2.apply(gris), 128, 255, cv2.THRESH_BINARY)
            if not self._fondo_iniciado:
                # El primer cuadro inicializa el fondo y MOG2 lo marca entero como cambio: no es
                # movimiento (si no, todo lo que ya estaba en la escena contaría como "en movimiento")
                mascara[:] = 0
                self._fondo_iniciado = True
            mascara = cv2.morphologyEx(mascara, cv2.MORPH_OPEN, self._kernel)
            mascara = cv2.dilate(mascara, self._kernel, iterations=2)
            if mascara_roi is not None:
                mascara = cv2.bitwise_and(mascara, mascara_roi)
            fraccion = cv2.countNonZero(mascara) / area

            caja = None
            contornos, _ = cv2.findContours(mascara, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            validos = [c for c in contornos if cv2.contourArea(c) > _AREA_MIN_CONTORNO * ancho * alto]
            if validos:
                mx, my, mw, mh = cv2.boundingRect(np.vstack(validos))
                # Margen del 10 % y vuelta a px del cuadro original
                mx, my = max(0, mx - int(mw * 0.10)), max(0, my - int(mh * 0.10))
                mw, mh = min(ancho - mx, int(mw * 1.20)), min(alto - my, int(mh * 1.20))
                caja = [int(mx / escala), int(my / escala), int((mx + mw) / escala), int((my + mh) / escala)]
            return Movimiento(caja=caja, porcentaje=int(min(100, fraccion * 100 * _GANANCIA_PORCENTAJE)),
                              fraccion=fraccion, cambio=cambio, mascara=mascara, escala=escala)
        except cv2.error:
            return CAMBIO_DESCONOCIDO
