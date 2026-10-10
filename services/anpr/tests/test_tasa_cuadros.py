"""Cuadros por segundo de la fuente: ventana deslizante, sin picos por ráfagas y 0 sin cuadros."""
from app.dominio.tasa_cuadros import TasaCuadros


class Reloj:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


def test_flujo_constante_de_25_fps():
    reloj = Reloj()
    tasa = TasaCuadros(reloj=reloj)
    for _ in range(100):
        reloj.t += 0.04
        tasa.registrar()
    assert 24.0 <= tasa.valor <= 25.5


def test_una_rafaga_al_conectar_no_dispara_el_valor_y_converge():
    """30 cuadros en 50 ms (vaciado del búfer): con 1/intervalo se informarían ~600 fps."""
    reloj = Reloj()
    tasa = TasaCuadros(reloj=reloj)
    for _ in range(30):
        reloj.t += 0.0017
        tasa.registrar()
    assert tasa.valor <= 30  # recién conectado: sin el pico de ~600 fps
    for _ in range(25):
        reloj.t += 0.04
        tasa.registrar()
    assert tasa.valor < 60  # 55 cuadros en ~1 s: lo realmente recibido, sin picos
    for _ in range(60):
        reloj.t += 0.04
        tasa.registrar()
    assert 24.0 <= tasa.valor <= 25.5  # pasada la ventana, solo cuenta el flujo constante


def test_sin_cuadros_baja_hasta_cero():
    reloj = Reloj()
    tasa = TasaCuadros(reloj=reloj)
    for _ in range(50):
        reloj.t += 0.04
        tasa.registrar()
    antes = tasa.valor
    reloj.t += 1.0
    assert tasa.valor < antes  # baja mientras no llegan cuadros
    reloj.t += 1.5
    assert tasa.valor == 0.0
