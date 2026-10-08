"""
Selector del mejor cuadro: no captura placas cortadas por el borde lateral y vuelve a elegir
cuadros de un track liberado tras una foto ilegible (docs/METODO_VERIFICACION_LECTURA.md §2.4–2.5).
"""
import numpy as np

from app.aplicacion.frame_selector import BestFrameSelector


def cuadro_con_placa(caja, ancho=640, alto=360):
    """Cuadro con una "placa" de alto contraste (nítida) en la caja."""
    f = np.full((alto, ancho, 3), 90, np.uint8)
    x1, y1, x2, y2 = caja
    f[y1:y2, x1:x2] = 230
    f[y1 + 8:y2 - 8, x1 + 10:x2 - 10:12] = 20  # trazos verticales como caracteres
    return f


def elegir(selector, caja, tid=1, veces=3):
    elegido = None
    for i in range(veces):
        elegido = selector.evaluate_and_select(tid, cuadro_con_placa(caja), caja, 0.9, i) or elegido
    return elegido


def test_placa_junto_al_borde_lateral_no_se_captura():
    """A 8 px del borde izquierdo (dentro del margen del 2 % de 640 px) la placa puede estar
    cortada: antes se capturaba (margen de 3 px) y el OCR leía "YS889" en vez de "PSY889"."""
    assert elegir(BestFrameSelector(), [8, 150, 188, 210]) is None
    assert elegir(BestFrameSelector(), [452, 150, 632, 210]) is None


def test_placa_completa_o_cortada_solo_arriba_se_captura():
    assert elegir(BestFrameSelector(), [230, 150, 410, 210]) is not None
    # Arriba o abajo el corte quita primero la franja "ECUADOR" o el margen inferior
    assert elegir(BestFrameSelector(), [230, 4, 410, 64]) is not None


def test_track_liberado_vuelve_a_ser_elegible():
    selector = BestFrameSelector()
    caja = [230, 150, 410, 210]
    assert elegir(selector, caja) is not None
    assert elegir(selector, caja) is None  # ventana anti-rebote
    selector.liberar(1)
    assert elegir(selector, caja) is not None
