"""
Movimiento (MOG2), compuerta de inferencia y qué se dibuja (docs/METODO_VERIFICACION_LECTURA.md §2.1 y §2.4).

Escena sintética de 640×480: fondo uniforme y un objeto claro en la caja de la placa; el
detector de prueba cuenta cuántas veces se ejecuta.
"""
import numpy as np

from app.aplicacion.detector import _COLOR_ESCANEANDO, DetectionPipeline
from app.aplicacion.movimiento import CompuertaInferencia, DetectorMovimiento
from app.dominio.models import Detection
from app.infraestructura.detectors import MockDetector

CAJA = [100, 150, 220, 190]


class DetectorContado(MockDetector):
    def __init__(self):
        super().__init__([])
        self.llamadas = 0

    def predict(self, frame):
        self.llamadas += 1
        return super().predict(frame)


def fondo():
    return np.full((480, 640, 3), 128, np.uint8)


def con_objeto(caja=CAJA):
    f = fondo()
    x1, y1, x2, y2 = caja
    f[y1:y2, x1:x2] = 240
    return f


def placa(caja=CAJA):
    return [Detection(bbox=[float(v) for v in caja], confidence=0.88, class_name="plate")]


def pipeline(compuerta=None):
    det = DetectorContado()
    return det, DetectionPipeline(detector=det, compuerta=compuerta)


# ─── Detector de movimiento ──────────────────────────────────────────────────

def test_movimiento_detecta_el_cambio_y_su_ubicacion():
    m = DetectorMovimiento()
    for _ in range(3):
        m.analizar(fondo())  # el primer cuadro inicializa el fondo
    quieto = m.analizar(fondo())
    assert quieto.fraccion == 0.0 and quieto.caja is None

    mov = m.analizar(con_objeto())
    assert mov.fraccion > 0.0 and mov.caja is not None
    x1, y1, x2, y2 = mov.caja
    assert x1 <= CAJA[0] and y1 <= CAJA[1] and x2 >= CAJA[2] and y2 >= CAJA[3]
    assert mov.fraccion_en(CAJA) > 0.5
    assert mov.fraccion_en([400, 300, 500, 400]) == 0.0


def test_movimiento_fuera_de_la_region_de_interes_no_cuenta():
    m = DetectorMovimiento()
    cuadrante_inferior_derecho = [[0.5, 0.5], [1.0, 0.5], [1.0, 1.0], [0.5, 1.0]]
    for _ in range(3):
        m.analizar(fondo(), cuadrante_inferior_derecho)
    assert m.analizar(con_objeto(), cuadrante_inferior_derecho).fraccion == 0.0


def test_cada_fuente_tiene_su_propio_fondo():
    """La webcam del navegador no altera el fondo aprendido de la cámara RTSP (y viceversa)."""
    _, p = pipeline()
    for _ in range(3):
        p.detect_and_track(fondo())
    for _ in range(3):
        p.detect_fast(con_objeto([300, 300, 500, 400]))  # otra escena en el navegador
    p.detect_and_track(fondo())
    assert p.get_motion_info("rtsp")[1] == 0


# ─── Compuerta de inferencia ─────────────────────────────────────────────────

def test_sin_compuerta_el_detector_se_ejecuta_en_cada_cuadro():
    det, p = pipeline()
    for _ in range(5):
        p.detect_and_track(fondo())
    assert det.llamadas == 5 and p.proporcion_omitida("rtsp") == 0.0


def test_compuerta_omite_el_detector_con_la_escena_quieta_y_hace_inferencias_de_control():
    det, p = pipeline(CompuertaInferencia(umbral=0.002, max_omitidos=3))
    p.detect_and_track(fondo())  # primer cuadro: todo es cambio para MOG2
    assert det.llamadas == 1
    for _ in range(3):
        p.detect_and_track(fondo())
        assert p.inferencia_omitida("rtsp")
    assert det.llamadas == 1
    p.detect_and_track(fondo())  # inferencia de control tras 3 omitidos
    assert det.llamadas == 2 and not p.inferencia_omitida("rtsp")

    det.set_detections(placa())
    p.detect_and_track(con_objeto())  # la escena cambia: se ejecuta de inmediato
    assert det.llamadas == 3
    assert p.inferencias["rtsp"] == {"ejecutadas": 3, "omitidas": 3}
    assert p.proporcion_omitida("rtsp") == 0.5


def test_con_la_escena_quieta_la_pista_se_conserva_sin_ejecutar_el_detector():
    det, p = pipeline(CompuertaInferencia(max_omitidos=8))
    escena = con_objeto()  # la placa ya estaba en la escena: MOG2 la aprende como fondo
    for _ in range(9):
        p.detect_and_track(escena)
    det.set_detections(placa())
    rois = p.detect_and_track(escena)  # inferencia de control: nace la pista
    assert det.llamadas == 2 and len(rois) == 1
    tid = rois[0].tracking_id
    for _ in range(8):  # más cuadros que la edad máxima de un track sin detección (4)
        assert [r.tracking_id for r in p.detect_and_track(escena)] == [tid]
    assert det.llamadas == 2
    assert [r.tracking_id for r in p.detect_and_track(escena)] == [tid]  # control: misma pista
    assert det.llamadas == 3


def test_al_irse_la_placa_la_pista_se_da_de_baja_sin_quedar_congelada():
    """Lo que desaparece también es un cambio: la pista no queda como recuadro fantasma esperando
    una inferencia de control (aunque la zona que deja libre vuelva a parecerse al fondo)."""
    det, p = pipeline(CompuertaInferencia(max_omitidos=50))
    for _ in range(3):
        p.detect_and_track(fondo())
    det.set_detections(placa())
    assert len(p.detect_and_track(con_objeto())) == 1
    det.set_detections([])
    for _ in range(6):  # la placa ya no está; 6 cuadros > edad máxima de un track sin detección
        p.detect_and_track(fondo())
    assert p.detect_and_track(fondo()) == [] and p._current_overlays == []


def test_un_desplazamiento_lento_se_acumula_hasta_ejecutar_el_detector():
    """Cada cuadro cambia menos que el umbral, pero la diferencia se mide contra la última
    inferencia: el desplazamiento acumulado acaba ejecutando el detector."""
    det, p = pipeline(CompuertaInferencia(umbral=0.002, max_omitidos=50))
    escena = lambda dx: con_objeto([CAJA[0] + dx, CAJA[1], CAJA[2] + dx, CAJA[3]])  # noqa: E731
    for _ in range(3):
        p.detect_and_track(escena(0))
    llamadas = det.llamadas
    assert p.detect_and_track(escena(1)) == [] and det.llamadas == llamadas  # 1 px: no alcanza
    for dx in range(2, 30):
        p.detect_and_track(escena(dx))
        if det.llamadas > llamadas:
            break
    assert det.llamadas > llamadas and dx < 30


# ─── Qué se dibuja ───────────────────────────────────────────────────────────

def test_placa_quieta_sin_evidencia_no_se_dibuja_hasta_que_se_lee():
    """Un objeto quieto que el detector confunde con una placa no se enmarca; si el OCR lo lee
    como placa ANT, se dibuja aunque la escena siga quieta (sin esperar a otra inferencia)."""
    det, p = pipeline(CompuertaInferencia(max_omitidos=8))
    escena = con_objeto()
    for _ in range(9):
        p.detect_and_track(escena)
    det.set_detections(placa())
    tid = p.detect_and_track(escena)[0].tracking_id
    assert p._current_overlays == []

    p.update_track_plate(tid, "PBA1234", 0.95, "leida")
    llamadas = det.llamadas
    p.detect_and_track(escena)
    assert det.llamadas == llamadas  # cuadro sin inferencia
    assert [o.label for o in p._current_overlays] == ["PBA-1234  95%"]


def test_lo_que_ya_estaba_en_la_escena_al_arrancar_no_cuenta_como_movimiento():
    """MOG2 marca entero el primer cuadro (inicializa el fondo): eso no es movimiento, así que un
    rótulo fijo detectado al arrancar no se enmarca."""
    det, p = pipeline(CompuertaInferencia())
    det.set_detections(placa())
    rois = p.detect_and_track(con_objeto())
    assert det.llamadas == 1 and len(rois) == 1 and not rois[0].en_movimiento
    assert p._current_overlays == []


def test_placa_en_movimiento_se_dibuja_desde_su_primer_cuadro():
    det, p = pipeline(CompuertaInferencia())
    for _ in range(3):
        p.detect_and_track(fondo())
    det.set_detections(placa())
    rois = p.detect_and_track(con_objeto())  # aparece un objeto en la caja de la placa
    assert rois[0].en_movimiento
    ov = p._current_overlays[0]
    assert ov.label.startswith("ESCANEANDO OCR") and ov.color == _COLOR_ESCANEANDO and not ov.verificada
    caja, porcentaje, vehiculo = p.get_motion_info("rtsp")
    assert vehiculo and caja is not None and porcentaje > 0
