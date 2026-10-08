"""Contrato del servidor y del motor ANPR (pruebas de caracterización).

Fijan el comportamiento observable de las rutas HTTP/WebSocket y de la compuerta de captura:
autenticación, forma de las respuestas, anti-duplicados, verificación en dos fases y registro en
el backend. Se escribieron sobre el código anterior a la separación motor/API y se ejecutan sin
cambios sobre el código nuevo: solo el adaptador `Servicio` conoce dónde vive el estado.

No cargan modelos ni abren cámaras: el pipeline, el OCR, el cliente HTTP y los ejecutores se
reemplazan por dobles de prueba.
"""
from __future__ import annotations

import threading
import types

import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

TOKEN = "token-de-prueba"


# ─── Dobles de prueba ────────────────────────────────────────────────────────

class EjecutorInmediato:
    """Ejecuta en el acto lo que se le envía (las pruebas no dependen de hilos)."""

    def __init__(self):
        self.enviados = 0

    def submit(self, fn, *args, **kwargs):
        self.enviados += 1
        fn(*args, **kwargs)

    def shutdown(self, wait=False):
        pass


class Respuesta:
    def __init__(self, status_code=201, datos=None):
        self.status_code = status_code
        self._datos = datos or {}
        self.text = str(self._datos)

    def json(self):
        return self._datos


class ClienteHttp:
    """Registra cada POST al backend y responde como la API real."""

    def __init__(self):
        self.envios: list[tuple[str, dict]] = []

    def post(self, url, json=None, timeout=None):
        self.envios.append((url.rsplit("/api/", 1)[-1], json))
        if url.endswith("/detecciones/ingreso"):
            return Respuesta(201, {"ingreso_id": 77})
        if url.endswith("/detecciones/completar-ocr"):
            return Respuesta(200, {"deteccion": {"estado_validacion": "autorizado"}})
        return Respuesta(201, {"success": True})

    def close(self):
        pass

    def rutas(self):
        return [r for r, _ in self.envios]


class Pipeline:
    def __init__(self, conteo=None):
        self.fps = 12.34
        self.roi = None
        self.detector = types.SimpleNamespace(model_path="/modelos/yolo26n_ecuador.pt", arquitectura="yolo26")
        self._conteo = conteo or {}
        self.votos: list[tuple] = []
        self.estado_backend: list[tuple] = []
        self.limpiado = False
        self._overlays_lock = threading.Lock()
        self._current_overlays = []

    def get_browser_track_info(self, tid):
        return {}

    def get_motion_info(self, fuente="rtsp"):
        return (None, 0, False)

    def inferencia_omitida(self, fuente="rtsp"):
        return False

    def proporcion_omitida(self, fuente="rtsp"):
        return 0.25

    def get_track_info(self, tid):
        return {}

    def conteo_lecturas(self, tid):
        return dict(self._conteo)

    def update_track_plate(self, tid, placa, conf, estado, quality=None):
        self.votos.append(("rtsp", tid, placa, estado))

    def update_browser_track_plate(self, tid, placa, conf, estado, quality=None):
        self.votos.append(("navegador", tid, placa, estado))

    def mejor_analisis(self, tid):
        return None

    def track_eval_info(self, tid):
        return (None, None)

    def fijar_estado_backend(self, tid, estado):
        self.estado_backend.append((tid, estado))

    def set_roi(self, roi):
        self.roi = roi
        return roi

    def clear_all_tracks(self):
        self.limpiado = True


class Agente:
    def __init__(self, placa="PBA1234", estado="procesado", confianza=0.93):
        self.resultado = types.SimpleNamespace(placa=placa, estado=estado, confianza=confianza)

    def process_image(self, frame, initial_bbox=None, fast_mode=True):
        return self.resultado


def candidato(tid=5, ancho=160, alto=40):
    frame = np.full((480, 640, 3), 128, np.uint8)
    return types.SimpleNamespace(
        tracking_id=tid, frame=frame, plate_bbox=[200, 300, 200 + ancho, 300 + alto], confidence=0.88,
        timestamp=1_000.0, estimated_distance_m=4.2, sharpness=150.0,
    )


# ─── Adaptador: único punto que conoce dónde vive el estado del servicio ──────

class Servicio:
    """El estado vive en `MotorAnpr` (app/aplicacion/motor.py); app.main solo lo compone."""

    def __init__(self, monkeypatch, tmp_path):
        from app import main
        from app.infraestructura import acceso

        self.motor = motor = main.motor
        self._mp = monkeypatch
        monkeypatch.setattr(acceso, "ANPR_SERVICE_TOKEN", TOKEN)
        self.http = ClienteHttp()
        self.disco = EjecutorInmediato()
        self.ocr = EjecutorInmediato()
        monkeypatch.setattr(motor, "_http", self.http)
        monkeypatch.setattr(motor, "_ejecutor_disco", self.disco)
        monkeypatch.setattr(motor, "_ejecutor_ocr", self.ocr)
        monkeypatch.setattr(motor, "_dir_media", str(tmp_path))
        monkeypatch.setattr(motor._dep, "verificador", lambda: None)
        monkeypatch.setattr(motor._dep, "reconocedor_vehiculo", lambda: None)
        for nombre, valor in {"_pipeline": None, "_selector": None, "_trabajador_ocr": None, "_fuente": None,
                              "_activo": False, "_fps_captura": 0.0, "camara_id": 1,
                              "fuente_camara": "rtsp://anpr:clave-secreta@mediamtx:8554/cam_1"}.items():
            monkeypatch.setattr(motor, nombre, valor)
        for registro in ("_capturas_por_track", "_placas_registradas", "_ultimo_intento_ocr", "_intentos_captura", "_vehiculos"):
            monkeypatch.setattr(motor, registro, {})
        monkeypatch.setattr(motor, "_ocr_en_curso", set())
        self.client = TestClient(main.app)

    def fijar(self, **estado):
        nombres = {"pipeline": "_pipeline", "selector": "_selector", "trabajador_ocr": "_trabajador_ocr",
                   "fuente": "_fuente", "activo": "_activo", "fps_captura": "_fps_captura"}
        for clave, valor in estado.items():
            self._mp.setattr(self.motor, nombres[clave], valor)

    def reemplazar_fuente_rtsp(self, fabrica):
        self._mp.setattr(self.motor._dep, "fuente_rtsp", fabrica)

    def disparar_captura(self, cand):
        self.motor.disparar_captura(cand)

    def encolar_ocr(self, tid, frame, bbox):
        self.motor.encolar_ocr(tid, frame, bbox)

    @property
    def camara(self):
        return self.motor.camara_id, self.motor.fuente_camara

    @property
    def placas_registradas(self):
        return self.motor._placas_registradas


@pytest.fixture
def servicio(monkeypatch, tmp_path):
    return Servicio(monkeypatch, tmp_path)


SERVICIO = {"X-Servicio-Token": TOKEN}


# ─── Autenticación ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("metodo,ruta", [
    ("post", "/api/camera/switch"), ("post", "/api/camera/roi"), ("get", "/debug/stream"),
    ("get", "/stream/preview?url=rtsp://x"), ("get", "/api/stream/preview?url=rtsp://x"),
])
def test_endpoints_de_control_exigen_token_de_servicio(servicio, metodo, ruta):
    r = getattr(servicio.client, metodo)(ruta)
    assert r.status_code == 401
    assert r.json() == {"error": "Token de servicio requerido"}


def test_frame_del_navegador_exige_ticket(servicio):
    r = servicio.client.post("/process/frame", files={"file": ("f.jpg", b"x", "image/jpeg")})
    assert r.status_code == 401
    assert r.json() == {"error": "Ticket inválido o vencido"}


@pytest.mark.parametrize("ruta", ["/ws/stream", "/api/ws/stream", "/ws/pistas", "/ws/webcam", "/api/ws/webcam"])
def test_websockets_sin_ticket_se_cierran_con_4401(servicio, ruta):
    with pytest.raises(WebSocketDisconnect) as e:
        with servicio.client.websocket_connect(ruta):
            pass
    assert e.value.code == 4401


# ─── Estado y consulta ───────────────────────────────────────────────────────

def test_estado_del_servicio_sin_iniciar_y_sin_credenciales(servicio):
    r = servicio.client.get("/status").json()
    assert r == {
        "status": "online", "running": False, "camera_source": "rtsp://anpr:******@mediamtx:8554/cam_1",
        "capture_fps": 0.0, "tracker_fps": 0.0, "inferencias_omitidas_pct": None, "detector": None,
        "detector_arquitectura": None, "ocr_engine": None, "ocr_verifier": None,
        "architecture": "Two-Phase: Fast Capture + Async OCR",
    }
    assert servicio.client.get("/").json() == {
        "service": "ECU 911 ANPR Microservice", "version": "2.0.0", "status": "starting",
        "detector": None, "detector_arquitectura": None, "ocr_engine": None, "ocr_verifier": None,
    }


def test_estado_con_modelos_cargados(servicio):
    servicio.fijar(pipeline=Pipeline(), fps_captura=24.567)
    r = servicio.client.get("/status").json()
    assert (r["capture_fps"], r["tracker_fps"], r["detector"], r["detector_arquitectura"]) == (24.6, 12.3, "yolo26n_ecuador.pt", "yolo26")
    assert r["inferencias_omitidas_pct"] == 25.0


def test_camara_activa_conectada_por_fuente_o_por_fps(servicio):
    assert servicio.client.get("/api/camera/active").json() == {
        "camera_id": 1, "camera_source": "rtsp://anpr:******@mediamtx:8554/cam_1", "is_connected": False, "roi": None,
    }
    servicio.fijar(fps_captura=12.0)
    assert servicio.client.get("/api/camera/active").json()["is_connected"] is True


def test_pistas_por_websocket_con_zona_de_movimiento(servicio, monkeypatch):
    """El HUD del navegador recibe cada pista (aunque aún escanee) y la zona de movimiento MOG2."""
    from app.aplicacion.detector import VisualOverlayBox
    from app.interfaz import api

    monkeypatch.setattr(api, "ticket_valido", lambda ticket, alcance: ticket == "t" and alcance == "stream")
    pipeline = Pipeline()
    pipeline.get_motion_info = lambda fuente="rtsp": ([64, 48, 320, 240], 42, True) if fuente == "rtsp" else (None, 0, False)
    pipeline._current_overlays = [VisualOverlayBox(
        x1=64, y1=96, x2=192, y2=144, tracking_id=7, label="PB...  88%", color=(11, 158, 245),
        parcial="PB", confianza=0.88, velocidad=(64.0, -48.0),
    )]
    monkeypatch.setitem(servicio.motor.tamano_fuente, "w", 640)
    monkeypatch.setitem(servicio.motor.tamano_fuente, "h", 480)
    servicio.fijar(pipeline=pipeline, activo=True)
    with servicio.client.websocket_connect("/ws/pistas?ticket=t") as ws:
        datos = ws.receive_json()
        servicio.fijar(activo=False)
    assert datos == {
        "pistas": [{
            "id": 7, "caja": [0.1, 0.2, 0.3, 0.3], "puntos": None, "velocidad": [0.1, -0.1], "confianza": 0.88,
            "placa": None, "parcial": "PB", "confianza_placa": 0.0, "estado": None, "verificada": False,
        }],
        "roi": None,
        "movimiento": {"caja": [0.1, 0.1, 0.5, 0.5], "porcentaje": 42},
    }


def test_metricas_prometheus(servicio):
    r = servicio.client.get("/metrics")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/plain")
    assert "anpr_" in r.text


# ─── Región de interés y cambio de cámara ────────────────────────────────────

def test_region_de_interes(servicio):
    assert servicio.client.post("/api/camera/roi", headers=SERVICIO, json={"roi": None}).status_code == 503
    pipeline = Pipeline()
    servicio.fijar(pipeline=pipeline)
    roi = [[0, 0], [1, 0], [1, 1]]
    assert servicio.client.post("/api/camera/roi", headers=SERVICIO, json={"roi": roi, "camara_id": 9}).json() == \
        {"success": True, "aplicada": False, "roi": None}
    assert servicio.client.post("/api/camera/roi", headers=SERVICIO, json={"roi": roi, "camara_id": 1}).json() == \
        {"success": True, "aplicada": True, "roi": roi}
    assert servicio.client.post("/api/camera/roi", headers=SERVICIO, content=b"{no json").status_code == 400


def test_cambio_de_camara_reinicia_el_seguimiento_y_oculta_credenciales(servicio):
    creadas = []

    class FuenteFalsa:
        def __init__(self, url=None, index=None):
            self.url, self.is_connected, self._grab_running = url, False, False
            creadas.append(self)

        def connect(self):
            return True

        def release(self):
            pass

    servicio.reemplazar_fuente_rtsp(lambda url: FuenteFalsa(url=url))
    pipeline = Pipeline()
    selector = types.SimpleNamespace(_active_candidates={1: 1}, _captured_history={1: 1}, _prev_area={1: 1}, _track_first_seen={1: 1})
    servicio.fijar(pipeline=pipeline, selector=selector)
    r = servicio.client.post("/api/camera/switch", headers=SERVICIO, json={
        "camera_id": 2, "rtsp_url": "rtsp://anpr:otra@mediamtx:8554/cam_2", "nombre": "Garita sur", "roi": [[0, 0], [1, 0], [1, 1]],
    }).json()
    assert r == {"success": True, "message": "Cámara cambiada exitosamente a ID 2 (Garita sur)",
                 "camera_id": 2, "camera_source": "rtsp://anpr:******@mediamtx:8554/cam_2"}
    assert servicio.camara == (2, "rtsp://anpr:otra@mediamtx:8554/cam_2")
    assert [f.url for f in creadas] == ["rtsp://anpr:otra@mediamtx:8554/cam_2"]
    assert pipeline.limpiado and pipeline.roi == [[0, 0], [1, 0], [1, 1]]
    assert selector._active_candidates == selector._captured_history == selector._prev_area == selector._track_first_seen == {}

    # La misma cámara, conectada y sin `force`: no se reconecta
    creadas[0].is_connected = creadas[0]._grab_running = True
    creadas[0]._url = "rtsp://anpr:otra@mediamtx:8554/cam_2"
    r = servicio.client.post("/api/camera/switch", headers=SERVICIO, json={"camera_id": 2, "rtsp_url": "rtsp://anpr:otra@mediamtx:8554/cam_2"}).json()
    assert r["message"] == "Cámara ID 2 ya se encuentra activa" and len(creadas) == 1


# ─── Compuerta de captura (verificación en dos fases y registro) ─────────────

def test_captura_valida_registra_ingreso_y_ocr_con_evidencias(servicio):
    pipeline = Pipeline(conteo={"PBA1234": 2})
    servicio.fijar(pipeline=pipeline, trabajador_ocr=types.SimpleNamespace(_agent=Agente()), activo=True)
    servicio.disparar_captura(candidato())

    assert servicio.http.rutas() == ["detecciones/ingreso", "detecciones/completar-ocr"]
    ingreso = servicio.http.envios[0][1]
    assert ingreso["placa"] == "PBA1234" and ingreso["camara_id"] == 1 and ingreso["tracking_id"] == 5
    assert ingreso["ruta_imagen_ingreso"].startswith("/media/ingreso_")
    assert set(ingreso["metadatos"]) == {"luminancia_media", "distancia_estimada_m", "ancho_placa_px", "nitidez",
                                         "velocidad_px_s", "modelo_detector", "modelo_ocr", "vehiculo"}
    assert ingreso["metadatos"]["ancho_placa_px"] == 160 and ingreso["metadatos"]["modelo_detector"] == "yolo26n_ecuador.pt"
    ocr = servicio.http.envios[1][1]
    assert ocr["ingreso_id"] == 77 and ocr["placa_reconocida"] == "PBA1234" and ocr["estado_procesamiento"] == "procesado"
    assert set(ocr["evidencia_lectura"]) >= {"angulo", "regularidad", "bordes_hallados", "cuadrilatero", "lectura_ocr", "lectura_verificador"}
    assert ("rtsp", 5, "", "confirmada") in pipeline.votos and pipeline.estado_backend == [(5, "autorizado")]
    assert "PBA1234" in servicio.placas_registradas


def test_ocr_profundo_verificador_y_vehiculo_se_ejecutan_en_paralelo(servicio, monkeypatch):
    """Las tres etapas del registro parten de la misma foto: la latencia es la de la más lenta,
    no la suma. Se informan la duración de cada etapa y la latencia de punta a punta."""
    import time as reloj

    class AgenteLento(Agente):
        def process_image(self, frame, initial_bbox=None, fast_mode=True):
            reloj.sleep(0.2)
            return self.resultado

    class VerificadorLento:
        description = "verificador de prueba"

        def read(self, recorte):
            reloj.sleep(0.2)
            return types.SimpleNamespace(plate="PBA1234", confidence=0.95, within_budget=True, elapsed_ms=200.0)

    class ReconocedorLento:
        def analyze(self, frame, caja):
            reloj.sleep(0.2)
            return types.SimpleNamespace(to_dict=lambda: {"marca": "Kia", "color": "blanco"})

    monkeypatch.setattr(servicio.motor._dep, "verificador", lambda: VerificadorLento())
    monkeypatch.setattr(servicio.motor._dep, "reconocedor_vehiculo", lambda: ReconocedorLento())
    antes = _valor("anpr_recognition_latency_seconds_count")
    servicio.fijar(pipeline=Pipeline(conteo={"PBA1234": 2}), trabajador_ocr=types.SimpleNamespace(_agent=AgenteLento()))
    t0 = reloj.perf_counter()
    servicio.disparar_captura(candidato())
    duracion = reloj.perf_counter() - t0

    assert duracion < 0.45, f"las etapas no corrieron en paralelo ({duracion:.2f} s)"
    assert servicio.http.rutas() == ["detecciones/ingreso", "detecciones/completar-ocr"]
    assert servicio.http.envios[0][1]["metadatos"]["vehiculo"] == {"marca": "Kia", "color": "blanco"}
    etapas = servicio.http.envios[1][1]["evidencia_lectura"]["etapas_ms"]
    assert set(etapas) == {"ocr_profundo", "verificador", "vehiculo"} and all(ms >= 190 for ms in etapas.values())
    assert _valor("anpr_recognition_latency_seconds_count") - antes == 1


def test_el_vehiculo_se_analiza_por_adelantado_y_el_registro_reutiliza_el_resultado(servicio, monkeypatch):
    """El análisis del vehículo empieza cuando aparece una placa en movimiento completa, mientras el
    selector espera la mejor foto; el registro usa ese resultado sin repetir el análisis."""
    from app.aplicacion.detector import TrackedPlateROI

    analizados = []

    class Reconocedor:
        def analyze(self, frame, caja):
            analizados.append(caja)
            return types.SimpleNamespace(to_dict=lambda: {"color": "rojo"})

    monkeypatch.setattr(servicio.motor._dep, "reconocedor_vehiculo", lambda: Reconocedor())
    frame = np.zeros((480, 640, 3), np.uint8)
    caja = [200, 300, 360, 340]
    quieta = TrackedPlateROI(tracking_id=4, plate_bbox=caja, vehicle_bbox=[0, 0, 640, 480], confidence=0.9)
    movil = TrackedPlateROI(tracking_id=5, plate_bbox=caja, vehicle_bbox=[0, 0, 640, 480], confidence=0.9, en_movimiento=True)
    servicio.motor._anticipar_vehiculo(quieta, frame)
    servicio.motor._anticipar_vehiculo(movil, frame)
    servicio.motor._anticipar_vehiculo(movil, frame)  # una sola vez por track
    servicio.motor._vehiculos[5][0].result()
    assert analizados == [caja]

    servicio.fijar(pipeline=Pipeline(conteo={"PBA1234": 2}), trabajador_ocr=types.SimpleNamespace(_agent=Agente()))
    servicio.disparar_captura(candidato())
    assert analizados == [caja]
    assert servicio.http.envios[0][1]["metadatos"]["vehiculo"] == {"color": "rojo"}


class VerificadorFijo:
    description = "verificador de prueba"

    def __init__(self, placa):
        self.placa = placa

    def read(self, recorte):
        return types.SimpleNamespace(plate=self.placa, confidence=0.97, within_budget=True, elapsed_ms=50.0)


def _con_fila_de_caracteres(monkeypatch):
    """La foto contiene una fila de 7 caracteres (E3), para aislar la evidencia de confirmación (E4)."""
    from app.aplicacion import motor as modulo_motor
    from app.aplicacion.verificacion_placa import AnalisisCaracteres

    fila = AnalisisCaracteres(caracteres=7, altura=20.0, banda=[10, 10, 150, 30], puntaje=0.9, valida=True)
    monkeypatch.setattr(modulo_motor, "analizar_caracteres", lambda recorte, min_caracteres=5: fila)


def test_se_registra_la_lectura_del_verificador_y_el_desacuerdo_no_se_valida(servicio, monkeypatch):
    """El OCR rápido leyó varias veces PBV1234 (error sistemático) y el verificador PBA1234: se
    registra la del verificador, el lector más preciso, pero sin validarla, porque ninguna lectura
    OCR independiente la confirma."""
    _con_fila_de_caracteres(monkeypatch)
    monkeypatch.setattr(servicio.motor._dep, "verificador", lambda: VerificadorFijo("PBA1234"))
    servicio.fijar(pipeline=Pipeline(conteo={"PBV1234": 3}),
                   trabajador_ocr=types.SimpleNamespace(_agent=Agente(placa="PBV1234")))
    servicio.disparar_captura(candidato())
    ocr = servicio.http.envios[1][1]
    evidencia = ocr["evidencia_lectura"]
    assert ocr["placa_reconocida"].replace("-", "") == "PBA1234" and ocr["lectura_valida"] is False
    assert (evidencia["lecturas"], evidencia["verificador_coincide"]) == (0, False)
    assert (evidencia["lectura_ocr"], evidencia["lectura_verificador"]) == ("PBV1234", "PBA1234")


def test_el_verificador_no_se_confirma_a_si_mismo(servicio, monkeypatch):
    """Si el OCR no leyó nada, la lectura del verificador queda sin confirmación (antes contaba
    como "el segundo OCR coincide" consigo mismo y se validaba con una sola fuente)."""
    _con_fila_de_caracteres(monkeypatch)
    monkeypatch.setattr(servicio.motor._dep, "verificador", lambda: VerificadorFijo("PBA1234"))
    servicio.fijar(pipeline=Pipeline(conteo={}),
                   trabajador_ocr=types.SimpleNamespace(_agent=Agente(placa="", estado="no_legible", confianza=0.1)))
    servicio.disparar_captura(candidato())
    ocr = servicio.http.envios[1][1]
    assert ocr["placa_reconocida"].replace("-", "") == "PBA1234" and ocr["lectura_valida"] is False
    assert ocr["evidencia_lectura"]["verificador_coincide"] is False


def test_el_verificador_confirma_cuando_coincide_con_el_ocr(servicio, monkeypatch):
    _con_fila_de_caracteres(monkeypatch)
    monkeypatch.setattr(servicio.motor._dep, "verificador", lambda: VerificadorFijo("PBA1234"))
    servicio.fijar(pipeline=Pipeline(conteo={"PBA1234": 1}), trabajador_ocr=types.SimpleNamespace(_agent=Agente()))
    servicio.disparar_captura(candidato())
    ocr = servicio.http.envios[1][1]
    assert ocr["lectura_valida"] is True and ocr["evidencia_lectura"]["verificador_coincide"] is True


def test_anti_duplicados_por_track_y_por_placa(servicio):
    servicio.fijar(pipeline=Pipeline(conteo={"PBA1234": 2}), trabajador_ocr=types.SimpleNamespace(_agent=Agente()))
    servicio.disparar_captura(candidato(tid=5))
    servicio.disparar_captura(candidato(tid=5))   # mismo track dentro de la ventana: ni se evalúa
    servicio.disparar_captura(candidato(tid=6))   # otro track con la misma placa: duplicado
    assert servicio.http.rutas() == ["detecciones/ingreso", "detecciones/completar-ocr"]
    assert servicio.disco.enviados == 2


class SelectorDePrueba:
    def __init__(self):
        self.liberados: list[int] = []

    def liberar(self, tid):
        self.liberados.append(tid)


def test_foto_ilegible_se_reintenta_y_solo_se_audita_al_agotar_los_intentos(servicio):
    """Una foto ilegible ya no hace perder el paso: el selector elige otro cuadro del mismo track.
    Tras MAX_INTENTOS_CAPTURA fotos ilegibles se audita una sola vez como falso positivo."""
    from app.aplicacion.motor import MAX_INTENTOS_CAPTURA

    selector = SelectorDePrueba()
    servicio.fijar(pipeline=Pipeline(), selector=selector,
                   trabajador_ocr=types.SimpleNamespace(_agent=Agente(placa="", estado="no_legible", confianza=0.1)))
    for _ in range(MAX_INTENTOS_CAPTURA - 1):
        servicio.disparar_captura(candidato())
    assert servicio.http.rutas() == [] and selector.liberados == [5] * (MAX_INTENTOS_CAPTURA - 1)
    servicio.disparar_captura(candidato())
    assert servicio.http.rutas() == ["detecciones/descarte"]
    assert servicio.http.envios[0][1]["motivo"] == "segunda_verificacion_ocr_no_valido"
    servicio.disparar_captura(candidato())  # sin intentos: el track queda en la ventana anti-rebote
    assert servicio.http.rutas() == ["detecciones/descarte"]


def test_region_sin_caracteres_ni_confirmacion_se_reintenta_y_luego_se_descarta(servicio):
    from app.aplicacion.motor import MAX_INTENTOS_CAPTURA

    selector = SelectorDePrueba()
    servicio.fijar(pipeline=Pipeline(conteo={}), selector=selector, trabajador_ocr=types.SimpleNamespace(_agent=Agente()))
    for _ in range(MAX_INTENTOS_CAPTURA):
        servicio.disparar_captura(candidato())
    assert servicio.http.rutas() == ["detecciones/descarte"]
    assert servicio.http.envios[0][1]["motivo"] == "region_sin_caracteres"
    assert selector.liberados == [5] * (MAX_INTENTOS_CAPTURA - 1)


def test_ocr_asincrono_con_enfriamiento_por_track(servicio):
    pipeline = Pipeline()
    servicio.fijar(pipeline=pipeline, trabajador_ocr=types.SimpleNamespace(_agent=Agente(estado="procesado")))
    frame = np.zeros((100, 200, 3), np.uint8)
    servicio.encolar_ocr(3, frame, [10, 10, 80, 30])
    servicio.encolar_ocr(3, frame, [10, 10, 80, 30])   # dentro de 0,6 s: se ignora
    assert servicio.ocr.enviados == 1
    assert pipeline.votos == [("rtsp", 3, "PBA1234", "leida")]


def test_placa_cortada_por_el_borde_no_se_lee_y_la_respuesta_indica_que_mostrar(servicio):
    """El OCR de una placa que entra por el borde lee texto truncado ("SY589" por "PSY589"):
    no se lee hasta que está completa. Se muestran las placas en movimiento o ya leídas."""
    from app.aplicacion.detector import TrackedPlateROI
    from app.aplicacion.motor import leible

    pipeline = Pipeline()
    servicio.fijar(pipeline=pipeline, trabajador_ocr=types.SimpleNamespace(_agent=Agente(estado="procesado")))
    frame = np.zeros((360, 640, 3), np.uint8)
    completa = TrackedPlateROI(tracking_id=1, plate_bbox=[200, 150, 320, 190], vehicle_bbox=[0, 0, 640, 360],
                               confidence=0.9, en_movimiento=True)
    cortada = TrackedPlateROI(tracking_id=2, plate_bbox=[0, 150, 100, 190], vehicle_bbox=[0, 0, 640, 360], confidence=0.9)
    r = servicio.motor.procesar_cuadro_ws(frame, [completa, cortada])
    assert servicio.ocr.enviados == 1
    assert pipeline.votos == [("navegador", 1, "PBA1234", "leida")]
    assert [(x["tracking_id"], x["mostrar"]) for x in r["rois"]] == [(1, True), (2, False)]
    assert not leible([600, 150, 640, 190], frame, ancho_min=16, alto_min=6)  # borde derecho
    assert not leible([200, 150, 210, 190], frame, ancho_min=16, alto_min=6)  # demasiado angosta
    assert leible([200, 0, 320, 40], frame, ancho_min=16, alto_min=6)  # arriba: los caracteres siguen completos


# ─── Métricas del motor (corrección: antes se publicaban pero nunca se registraban) ───

def _valor(metrica, **etiquetas):
    from app.infraestructura.metrics import registry
    return registry.get_sample_value(metrica, etiquetas or None) or 0.0


def test_captura_registrada_actualiza_las_metricas(servicio):
    antes = (_valor("anpr_detections_total", status="autorizado", camera_id="1"),
             _valor("anpr_plates_recognized_total", validation_status="no_confirmada"),
             _valor("anpr_detection_confidence_count"), _valor("anpr_ocr_confidence_count"))
    servicio.fijar(pipeline=Pipeline(conteo={"PBA1234": 2}), trabajador_ocr=types.SimpleNamespace(_agent=Agente()))
    servicio.disparar_captura(candidato())
    despues = (_valor("anpr_detections_total", status="autorizado", camera_id="1"),
               _valor("anpr_plates_recognized_total", validation_status="no_confirmada"),
               _valor("anpr_detection_confidence_count"), _valor("anpr_ocr_confidence_count"))
    assert [d - a for a, d in zip(antes, despues)] == [1, 1, 1, 1]


def test_descarte_cuenta_como_deteccion_descartada(servicio):
    """Un track descartado cuenta una vez, aunque se hayan probado varias fotos suyas."""
    from app.aplicacion.motor import MAX_INTENTOS_CAPTURA

    antes = _valor("anpr_detections_total", status="descartada", camera_id="1")
    servicio.fijar(pipeline=Pipeline(), selector=SelectorDePrueba(),
                   trabajador_ocr=types.SimpleNamespace(_agent=Agente(placa="", estado="no_legible")))
    for _ in range(MAX_INTENTOS_CAPTURA + 1):
        servicio.disparar_captura(candidato())
    assert _valor("anpr_detections_total", status="descartada", camera_id="1") - antes == 1


def test_error_del_ocr_asincrono_se_cuenta(servicio):
    class AgenteFallido:
        def process_image(self, *a, **k):
            raise RuntimeError("modelo no disponible")

    antes = _valor("anpr_ocr_errors_total", error_type="ocr_asincrono")
    servicio.fijar(pipeline=Pipeline(), trabajador_ocr=types.SimpleNamespace(_agent=AgenteFallido()))
    servicio.encolar_ocr(8, np.zeros((50, 100, 3), np.uint8), [10, 10, 60, 30])
    assert _valor("anpr_ocr_errors_total", error_type="ocr_asincrono") - antes == 1
