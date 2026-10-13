"""
Zonas de la cámara: región de interés (dónde se buscan placas) y zonas de exclusión que dibuja el
administrador (dónde nada cuenta: árboles, banderas, reflejos, la vereda, la hora sobreimpresa), y
el recorte de la región para la inferencia (docs/METODO_VERIFICACION_LECTURA.md §2.4).

Escena sintética de 640×480 con fondo uniforme; los detectores de prueba devuelven cajas fijas.
"""
import numpy as np

from app.aplicacion.detector import MAX_EXCLUSIONES, DetectionPipeline, ventana_inferencia
from app.aplicacion.movimiento import CompuertaInferencia, DetectorMovimiento
from app.aplicacion.verificacion_placa import punto_permitido
from app.dominio.models import Detection
from app.infraestructura.detectors import MockDetector

CAJA = [100, 150, 220, 190]
# Rectángulo normalizado que contiene la caja de la placa (centro en 0.25, 0.354)
SOBRE_LA_PLACA = [[0.10, 0.20], [0.40, 0.20], [0.40, 0.50], [0.10, 0.50]]
# Esquina superior derecha: una bandera que flamea
ZONA_BANDERA = [[0.75, 0.0], [1.0, 0.0], [1.0, 0.30], [0.75, 0.30]]


def fondo():
    return np.full((480, 640, 3), 128, np.uint8)


def con_objeto(caja=CAJA):
    f = fondo()
    x1, y1, x2, y2 = caja
    f[y1:y2, x1:x2] = 240
    return f


def con_bandera(i: int):
    """Fondo quieto con una bandera que flamea: una franja clara que oscila en la esquina superior
    derecha (movimiento coherente, como una bandera o una rama; el ruido píxel a píxel lo absorbe
    el suavizado del análisis)."""
    f = fondo()
    x0 = 500 + int(40 * (1 + np.sin(i * 1.3)))
    f[20:120, x0:x0 + 40] = 240
    return f


def placa(caja=CAJA, confianza=0.88):
    return [Detection(bbox=[float(v) for v in caja], confidence=confianza, class_name="plate")]


class DetectorContado(MockDetector):
    def __init__(self, detecciones=None):
        super().__init__(detecciones or [])
        self.llamadas = 0
        self.formas: list[tuple] = []

    def predict(self, frame):
        self.llamadas += 1
        self.formas.append(frame.shape[:2])
        return super().predict(frame)


# ─── Movimiento ──────────────────────────────────────────────────────────────

def test_el_movimiento_dentro_de_una_zona_de_exclusion_no_cuenta():
    con, sin = DetectorMovimiento(), DetectorMovimiento()
    for m in (con, sin):
        for _ in range(3):
            m.analizar(fondo(), None, [SOBRE_LA_PLACA])
        m.fijar_referencia()
    excluido = con.analizar(con_objeto(), None, [SOBRE_LA_PLACA])
    assert excluido.fraccion == 0.0 and excluido.caja is None and excluido.cambio == 0.0
    visible = sin.analizar(con_objeto(), None, [])
    assert visible.fraccion > 0.0 and visible.caja is not None and visible.cambio > 0.0


def test_la_region_de_interes_y_las_exclusiones_se_combinan():
    m = DetectorMovimiento()
    mitad_izquierda = [[0.0, 0.0], [0.5, 0.0], [0.5, 1.0], [0.0, 1.0]]
    for _ in range(3):
        m.analizar(fondo(), mitad_izquierda, [SOBRE_LA_PLACA])
    # Dentro de la región pero en la exclusión: no cuenta; dentro de la región y fuera de la exclusión: cuenta
    assert m.analizar(con_objeto(), mitad_izquierda, [SOBRE_LA_PLACA]).fraccion == 0.0
    otra = [40, 380, 160, 420]
    assert m.analizar(con_objeto(otra), mitad_izquierda, [SOBRE_LA_PLACA]).fraccion > 0.0


def test_una_bandera_en_una_zona_excluida_no_dispara_el_detector():
    """Sin la exclusión, la bandera hace correr el detector en cada cuadro; con ella, solo corren
    las inferencias de control (la escena, fuera de la zona, está quieta)."""
    def corridas(exclusiones):
        det = DetectorContado()
        p = DetectionPipeline(detector=det, compuerta=CompuertaInferencia(activa=True, umbral=0.002, max_omitidos=5))
        p.set_exclusiones(exclusiones)
        for i in range(30):
            p.detect_and_track(con_bandera(i))
        return det.llamadas

    sin_exclusion, con_exclusion = corridas([]), corridas([ZONA_BANDERA])
    assert sin_exclusion >= 28
    assert con_exclusion <= 7


# ─── Placas ──────────────────────────────────────────────────────────────────

def test_una_placa_con_el_centro_en_una_zona_de_exclusion_se_descarta():
    p = DetectionPipeline(detector=DetectorContado(placa()))
    p.set_exclusiones([SOBRE_LA_PLACA])
    assert p.detect_and_track(con_objeto()) == []
    p.set_exclusiones([])
    rois = p.detect_and_track(con_objeto())
    assert len(rois) == 1


def test_punto_permitido():
    roi = np.array([[0, 0], [100, 0], [100, 100], [0, 100]], np.float32)
    excl = [np.array([[10, 10], [30, 10], [30, 30], [10, 30]], np.float32)]
    assert punto_permitido(50, 50, roi, excl)
    assert not punto_permitido(20, 20, roi, excl)       # dentro de la exclusión
    assert not punto_permitido(10, 20, roi, excl)       # en su borde
    assert not punto_permitido(150, 50, roi, excl)      # fuera de la región
    assert punto_permitido(150, 50, None, excl)         # sin región: todo el cuadro
    assert punto_permitido(20, 20, None, [])


def test_zonas_de_exclusion_invalidas_se_ignoran_y_se_limitan():
    p = DetectionPipeline(detector=MockDetector())
    validas = p.set_exclusiones([
        [[0.1, 0.1], [0.2, 0.1]],                      # dos vértices
        [["x", 0.1], [0.2, 0.1], [0.2, 0.2]],          # no numérico
        [[-0.5, 0.0], [1.5, 0.0], [0.5, 2.0]],         # se recorta al cuadro
        "no es una zona",
    ])
    assert validas == [[[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]]]
    muchas = [[[0.0, 0.0], [0.1, 0.0], [0.1, 0.1]]] * (MAX_EXCLUSIONES + 3)
    assert len(p.set_exclusiones(muchas)) == MAX_EXCLUSIONES
    assert p.set_exclusiones(None) == [] and p.exclusiones == []


# ─── Recorte de la región de interés para la inferencia ──────────────────────

def test_ventana_de_inferencia():
    cuadrante = [[0.5, 0.5], [1.0, 0.5], [1.0, 1.0], [0.5, 1.0]]
    # Rectángulo envolvente con margen (8 % del ancho, 6 % del alto), recortado al cuadro
    assert ventana_inferencia(cuadrante, 640, 480) == (268, 211, 640, 480)
    assert ventana_inferencia(None, 640, 480) is None
    # Una región que ocupa casi todo el cuadro no se recorta (no ahorra al menos un 20 %)
    assert ventana_inferencia([[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]], 640, 480) is None
    # Una región diminuta tampoco (menos de 32 px por lado tras el margen)
    assert ventana_inferencia([[0.5, 0.5], [0.501, 0.5], [0.501, 0.501]], 100, 100) is None


def test_con_recorte_el_detector_recibe_solo_la_region_y_las_cajas_vuelven_al_cuadro():
    cuadrante = [[0.5, 0.5], [1.0, 0.5], [1.0, 1.0], [0.5, 1.0]]
    # El detector responde en coordenadas del recorte (268, 211)-(640, 480)
    det = DetectorContado(placa([100, 150, 220, 190]))
    p = DetectionPipeline(detector=det, recorte_roi=True)
    p.set_roi(cuadrante)
    rois = p.detect_and_track(fondo())
    assert det.formas == [(269, 372)]
    assert len(rois) == 1
    x1, y1, x2, y2 = rois[0].plate_bbox
    assert abs(x1 - 368) <= 2 and abs(y1 - 361) <= 2 and abs(x2 - 488) <= 2 and abs(y2 - 401) <= 2


def test_sin_recorte_o_sin_region_el_detector_ve_el_cuadro_completo():
    det = DetectorContado()
    p = DetectionPipeline(detector=det, recorte_roi=True)
    p.detect_and_track(fondo())                       # sin región
    p2 = DetectionPipeline(detector=det, recorte_roi=False)
    p2.set_roi([[0.5, 0.5], [1.0, 0.5], [1.0, 1.0], [0.5, 1.0]])
    p2.detect_and_track(fondo())                      # recorte desactivado
    assert det.formas == [(480, 640), (480, 640)]
