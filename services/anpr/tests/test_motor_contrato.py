"""Contrato del servidor y del motor ANPR (pruebas de caracterización).

Fijan el comportamiento observable de las rutas HTTP/WebSocket y de la compuerta de captura:
autenticación, forma de las respuestas, anti-duplicados, verificación en dos fases y registro en
el backend. Se escribieron sobre el código anterior a la separación motor/API y se ejecutan sin
cambios sobre el código nuevo: solo el adaptador `Servicio` conoce dónde vive el estado.

No cargan modelos ni abren cámaras: el pipeline, el OCR, el cliente HTTP y los ejecutores se
reemplazan por dobles de prueba.
"""
from __future__ import annotations

import json
import threading
import time
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
        #: Respuestas del ingreso que se entregan antes de la normal (p. ej. 503, una excepción o un duplicado)
        self.ingresos: list = []

    def post(self, url, json=None, timeout=None):
        self.envios.append((url.rsplit("/api/", 1)[-1], json))
        if url.endswith("/detecciones/ingreso"):
            if self.ingresos:
                r = self.ingresos.pop(0)
                if isinstance(r, Exception):
                    raise r
                return r
            return Respuesta(201, {"ingreso_id": 77})
        if url.endswith("/detecciones/completar-ocr"):
            return Respuesta(200, {"deteccion": {"estado_validacion": "autorizado"}})
        if url.endswith("/detecciones/reevaluar"):
            return Respuesta(200, {"reevaluado": True, "deteccion": {"estado_validacion": "autorizado"}})
        return Respuesta(201, {"success": True})

    def close(self):
        pass

    def rutas(self):
        return [r for r, _ in self.envios]


class Pipeline:
    def __init__(self, conteo=None):
        self.fps = 12.34
        self.roi = None
        self.exclusiones = []
        self.detector = types.SimpleNamespace(model_path="/modelos/yolo26n_ecuador.pt", arquitectura="yolo26")
        self._conteo = conteo or {}
        self.votos: list[tuple] = []
        self.estado_backend: list[tuple] = []
        self.limpiado = False
        self._overlays_lock = threading.Lock()
        self._current_overlays = []

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

    def mejor_analisis(self, tid):
        return None

    def track_eval_info(self, tid):
        return (None, None)

    def fijar_estado_backend(self, tid, estado):
        self.estado_backend.append((tid, estado))

    def set_roi(self, roi):
        self.roi = roi
        return roi

    def set_exclusiones(self, zonas):
        self.exclusiones = list(zonas or [])
        return self.exclusiones

    def clear_all_tracks(self):
        self.limpiado = True


class Agente:
    def __init__(self, placa="PBA1234", estado="procesado", confianza=0.93, texto_crudo=None):
        self.resultado = types.SimpleNamespace(placa=placa, estado=estado, confianza=confianza)
        if texto_crudo is not None:   # el agente real informa el texto leído antes de interpretarlo
            self.resultado.texto_crudo = texto_crudo

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
        monkeypatch.setattr(motor, "_ejecutor_reevaluacion", self.disco)
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
        for registro in ("_pistas_resueltas", "_placa_de_pista", "_crudos_rapidos"):
            monkeypatch.setattr(motor, registro, {})
        monkeypatch.setattr(motor, "_pistas_activas", set())
        # Sin esperas reales entre reintentos de envío
        from app.aplicacion import motor as modulo_motor
        monkeypatch.setattr(modulo_motor, "_ESPERAS_REINTENTO_S", (0.0, 0.0, 0.0))
        # El motor es uno solo para todas las pruebas: la latencia y el cuadro compartido empiezan vacíos
        from app.dominio.latencia import Cronometros, VentanaDescartes, VentanaLatencia
        for nombre, valor in {"_tiempos": Cronometros(), "_lat_edad": VentanaLatencia(300), "_lat_vivo": VentanaLatencia(200), "_lat_registro": VentanaLatencia(100),
                              "_descartes": VentanaDescartes(300), "_horas_cuadro": {}, "_cuadro_compartido": None, "_indice_cuadro": 0,
                              "_ultimo_tomado": -1, "_ultimo_seq_publicado": None}.items():
            monkeypatch.setattr(motor, nombre, valor)
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
])
def test_endpoints_de_control_exigen_token_de_servicio(servicio, metodo, ruta):
    r = getattr(servicio.client, metodo)(ruta)
    assert r.status_code == 401
    assert r.json() == {"error": "Token de servicio requerido"}


@pytest.mark.parametrize("metodo,ruta", [
    ("post", "/process/frame"), ("post", "/api/process/frame"),
    ("get", "/stream/preview?url=rtsp://x"), ("get", "/api/stream/preview?url=rtsp://x"),
])
def test_entradas_de_la_webcam_y_la_previsualizacion_libre_ya_no_existen(servicio, metodo, ruta):
    """La webcam del navegador se retiró y el motor no abre URLs arbitrarias (SSRF): solo procesa la
    cámara RTSP que asigna el backend."""
    r = getattr(servicio.client, metodo)(ruta, headers=SERVICIO)
    assert r.status_code in (404, 405)


@pytest.mark.parametrize("ruta", ["/ws/webcam", "/api/ws/webcam"])
def test_websocket_de_la_webcam_ya_no_existe(servicio, ruta):
    with pytest.raises(WebSocketDisconnect) as e:
        with servicio.client.websocket_connect(ruta):
            pass
    assert e.value.code != 4401  # no es un rechazo por ticket: la ruta no existe


def test_el_motor_solo_acepta_fuentes_rtsp(servicio):
    r = servicio.client.post("/api/camera/switch", headers=SERVICIO, json={"camera_id": 1, "source_type": "webcam"})
    assert r.status_code == 400 and r.json() == {"success": False, "error": "Solo se admiten fuentes RTSP"}


@pytest.mark.parametrize("ruta", ["/ws/stream", "/api/ws/stream", "/ws/pistas"])
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
        "capture_fps": 0.0, "tracker_fps": 0.0, "inferencias_omitidas_pct": None, "enlace_video": None, "detector": None,
        "detector_arquitectura": None, "ocr_engine": None, "ocr_verifier": None,
        "latencia": {"edad_cuadro": None, "lectura_en_vivo": None, "registro": None, "cuadros_descartados_pct": None},
        "etapas_ms": {},
        "architecture": "Two-Phase: Fast Capture + Async OCR",
    }
    assert servicio.client.get("/").json() == {
        "service": "ECU 911 ANPR Microservice", "version": "2.0.0", "status": "starting",
        "detector": None, "detector_arquitectura": None, "ocr_engine": None, "ocr_verifier": None,
    }


@pytest.mark.parametrize("ruta", ["/status", "/api/camera/active", "/metrics"])
def test_sin_cors_otro_sitio_no_lee_el_motor_desde_el_navegador(servicio, ruta):
    """El navegador solo usa los WebSocket con ticket; ninguna página ajena puede leer el estado."""
    r = servicio.client.get(ruta, headers={"Origin": "https://sitio-ajeno.example"})
    assert r.status_code == 200
    assert "access-control-allow-origin" not in r.headers
    previa = servicio.client.options(ruta, headers={"Origin": "https://sitio-ajeno.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in previa.headers


def test_estado_con_modelos_cargados(servicio):
    servicio.fijar(pipeline=Pipeline(), fps_captura=24.567)
    r = servicio.client.get("/status").json()
    assert (r["capture_fps"], r["tracker_fps"], r["detector"], r["detector_arquitectura"]) == (24.6, 12.3, "yolo26n_ecuador.pt", "yolo26")
    assert r["inferencias_omitidas_pct"] == 25.0


def test_camara_activa_conectada_por_fuente_o_por_fps(servicio):
    assert servicio.client.get("/api/camera/active").json() == {
        "camera_id": 1, "camera_source": "rtsp://anpr:******@mediamtx:8554/cam_1", "is_connected": False, "roi": None,
        "exclusiones": [],
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
        "exclusiones": [],
        "movimiento": {"caja": [0.1, 0.1, 0.5, 0.5], "porcentaje": 42},
        "aspecto": 1.3333,
    }


def test_metricas_prometheus(servicio):
    r = servicio.client.get("/metrics")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/plain")
    assert "anpr_" in r.text


# ─── Latencia de tiempo real (desde la captura de cada cuadro) ───────────────

def test_ventanas_de_latencia_y_de_descartes():
    from app.dominio.latencia import VentanaDescartes, VentanaLatencia
    v = VentanaLatencia(5)
    assert v.resumen() is None
    for s in (0.1, 0.2, 0.3, 0.4, 0.5, 1.0):      # conserva las últimas 5
        v.registrar(s)
    assert v.resumen() == {"p50_ms": 400, "p95_ms": 1000, "max_ms": 1000, "muestras": 5}
    d = VentanaDescartes(10)
    assert d.porcentaje() is None
    for perdidos in (0, 3, 1):
        d.registrar(perdidos)
    assert d.porcentaje() == round(100 * 4 / 7, 1)


def test_el_detector_toma_siempre_el_cuadro_mas_reciente_y_cuenta_los_descartados(servicio):
    """Un solo lugar entre la captura y la detección: si la inferencia no alcanza a la cámara, se
    analiza el último cuadro y los intermedios se descartan (y se cuentan), sin acumular retraso."""
    motor = servicio.motor
    cuadro = np.zeros((48, 64, 3), np.uint8)
    hace_250_ms = time.time() - 0.25
    for seq in range(1, 6):
        assert motor._publicar_cuadro(cuadro, seq, hace_250_ms)
    assert not motor._publicar_cuadro(cuadro, 5, time.time())   # el mismo cuadro repetido no se vuelve a analizar
    _, idx, hora = motor._tomar_cuadro()
    assert idx == 5 and hora == pytest.approx(hace_250_ms)
    assert motor._tomar_cuadro() is None                        # nada nuevo
    for seq in range(6, 9):
        motor._publicar_cuadro(cuadro, seq, time.time())
    assert motor._tomar_cuadro()[1] == 8                         # el 6 y el 7 se descartan
    lat = motor.latencia()
    assert lat["cuadros_descartados_pct"] == 50.0                # 2 descartados en 2 análisis
    assert lat["edad_cuadro"]["muestras"] == 2 and lat["edad_cuadro"]["max_ms"] >= 250


def test_latencia_de_la_lectura_en_vivo_y_del_registro(servicio):
    servicio.fijar(pipeline=Pipeline(conteo={"PBA1234": 2}), trabajador_ocr=types.SimpleNamespace(_agent=Agente()), activo=True)
    # Lectura en vivo: el cuadro leído se capturó hace 0,4 s
    servicio.motor.encolar_ocr(3, np.full((480, 640, 3), 128, np.uint8), [10, 10, 80, 30], time.time() - 0.4)
    vivo = servicio.motor.latencia()["lectura_en_vivo"]
    assert vivo["muestras"] == 1 and vivo["p50_ms"] >= 400
    # Registro: el mejor cuadro del paso se capturó hace 0,6 s
    antes = _valor("anpr_capture_to_reading_seconds_count", etapa="registro")
    cand = candidato()
    cand.frame_idx = 41
    servicio.motor._horas_cuadro[41] = time.time() - 0.6
    servicio.disparar_captura(cand)
    registro = servicio.motor.latencia()["registro"]
    assert registro["muestras"] == 1 and registro["p50_ms"] >= 600
    assert _valor("anpr_capture_to_reading_seconds_count", etapa="registro") - antes == 1
    assert servicio.client.get("/status").json()["latencia"]["registro"]["muestras"] == 1
    # Dónde se fue el tiempo: OCR rápido, etapas del registro y envíos al backend
    etapas = servicio.client.get("/status").json()["etapas_ms"]
    assert {"ocr_rapido", "registro_http_ingreso", "registro_http_completar"} <= set(etapas)
    assert etapas["ocr_rapido"]["muestras"] == 1


def test_el_pipeline_mide_cada_etapa_del_cuadro():
    from app.aplicacion.detector import DetectionPipeline
    from app.dominio.models import Detection
    from app.infraestructura.detectors import MockDetector

    p = DetectionPipeline(detector=MockDetector([Detection(bbox=[100.0, 150.0, 220.0, 190.0], confidence=0.88, class_name="plate")]))
    for _ in range(3):
        p.detect_and_track(np.full((480, 640, 3), 128, np.uint8))
    etapas = p.tiempos.resumen()
    assert set(etapas) == {"movimiento", "detector", "seguimiento", "pistas"}
    assert all(e["muestras"] == 3 for e in etapas.values())


# ─── Región de interés y cambio de cámara ────────────────────────────────────

def test_region_de_interes(servicio):
    assert servicio.client.post("/api/camera/roi", headers=SERVICIO, json={"roi": None}).status_code == 503
    pipeline = Pipeline()
    servicio.fijar(pipeline=pipeline)
    roi = [[0, 0], [1, 0], [1, 1]]
    exclusiones = [[[0.0, 0.0], [0.2, 0.0], [0.2, 0.2]]]
    assert servicio.client.post("/api/camera/roi", headers=SERVICIO, json={"roi": roi, "camara_id": 9}).json() == \
        {"success": True, "aplicada": False, "roi": None, "exclusiones": []}
    assert servicio.client.post("/api/camera/roi", headers=SERVICIO, json={"roi": roi, "camara_id": 1}).json() == \
        {"success": True, "aplicada": True, "roi": roi, "exclusiones": []}
    # Con zonas de exclusión; sin el campo, las vigentes no cambian
    assert servicio.client.post("/api/camera/roi", headers=SERVICIO, json={"roi": roi, "exclusiones": exclusiones, "camara_id": 1}).json() == \
        {"success": True, "aplicada": True, "roi": roi, "exclusiones": exclusiones}
    assert servicio.client.post("/api/camera/roi", headers=SERVICIO, json={"roi": None, "camara_id": 1}).json() == \
        {"success": True, "aplicada": True, "roi": None, "exclusiones": exclusiones}
    assert servicio.client.get("/api/camera/active").json()["exclusiones"] == exclusiones
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
        "exclusiones": [[[0.0, 0.0], [0.2, 0.0], [0.2, 0.2]]],
    }).json()
    assert r == {"success": True, "message": "Cámara cambiada exitosamente a ID 2 (Garita sur)",
                 "camera_id": 2, "camera_source": "rtsp://anpr:******@mediamtx:8554/cam_2"}
    assert servicio.camara == (2, "rtsp://anpr:otra@mediamtx:8554/cam_2")
    assert [f.url for f in creadas] == ["rtsp://anpr:otra@mediamtx:8554/cam_2"]
    assert pipeline.limpiado and pipeline.roi == [[0, 0], [1, 0], [1, 1]] and pipeline.exclusiones == [[[0.0, 0.0], [0.2, 0.0], [0.2, 0.2]]]
    assert selector._active_candidates == selector._captured_history == selector._prev_area == selector._track_first_seen == {}

    # La misma cámara, conectada y sin `force`: no se reconecta
    creadas[0].is_connected = creadas[0]._grab_running = True
    creadas[0]._url = "rtsp://anpr:otra@mediamtx:8554/cam_2"
    r = servicio.client.post("/api/camera/switch", headers=SERVICIO, json={"camera_id": 2, "rtsp_url": "rtsp://anpr:otra@mediamtx:8554/cam_2"}).json()
    assert r["message"] == "Cámara ID 2 ya se encuentra activa" and len(creadas) == 1
    # Sin zonas en la solicitud no cambian; con otra cámara llegan las suyas (las anteriores no se conservan)
    assert pipeline.exclusiones == [[[0.0, 0.0], [0.2, 0.0], [0.2, 0.2]]]
    servicio.client.post("/api/camera/switch", headers=SERVICIO, json={"camera_id": 3, "rtsp_url": "rtsp://anpr:x@mediamtx:8554/cam_3", "roi": None})
    assert pipeline.roi is None and pipeline.exclusiones == []


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
    # La fuente es el tipo de entrada, nunca la URL de lectura: llevaría el token del motor a la base
    assert ingreso["fuente"] == "rtsp"
    assert "clave-secreta" not in json.dumps([cuerpo for _, cuerpo in servicio.http.envios])


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

    def __init__(self, placa, crudo=None):
        self.placa, self.crudo = placa, crudo

    def read(self, recorte):
        lectura = types.SimpleNamespace(plate=self.placa, confidence=0.97, within_budget=True, elapsed_ms=50.0)
        if self.crudo is not None:
            lectura.raw = self.crudo
        return lectura


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


# ─── Lectura directa: una sustitución por el formato no confirma la placa ─────

def test_una_sustitucion_compartida_no_confirma_la_lectura(servicio, monkeypatch):
    """El OCR y el verificador leyeron "PSYS89" y el formato puso "5" en lugar de la "S": coinciden,
    pero gracias a la misma sustitución, y nadie leyó el "5". Se registra para el personal, con la
    salida cruda de cada lector, sin validarse."""
    _con_fila_de_caracteres(monkeypatch)
    monkeypatch.setattr(servicio.motor._dep, "verificador", lambda: VerificadorFijo("PSY589", crudo="PSYS89"))
    servicio.fijar(pipeline=Pipeline(conteo={"PSY589": 2}),
                   trabajador_ocr=types.SimpleNamespace(_agent=Agente(placa="PSY-589", texto_crudo="PSYS89")))
    servicio.disparar_captura(candidato())
    ocr = servicio.http.envios[1][1]
    evidencia = ocr["evidencia_lectura"]
    assert ocr["placa_reconocida"].replace("-", "") == "PSY589" and ocr["lectura_valida"] is False
    assert evidencia["verificador_coincide"] is True and evidencia["caracteres_inferidos"] == [[3, "5"]]
    assert (evidencia["lectura_ocr_cruda"], evidencia["lectura_verificador_cruda"]) == ("PSYS89", "PSYS89")
    assert any("sin lectura directa" in m for m in evidencia["motivos"])


def test_la_sustitucion_respaldada_por_la_lectura_de_otro_lector_si_confirma(servicio, monkeypatch):
    _con_fila_de_caracteres(monkeypatch)
    monkeypatch.setattr(servicio.motor._dep, "verificador", lambda: VerificadorFijo("PSY589", crudo="PSY589"))
    servicio.fijar(pipeline=Pipeline(conteo={"PSY589": 1}),
                   trabajador_ocr=types.SimpleNamespace(_agent=Agente(placa="PSY-589", texto_crudo="PSYS89")))
    servicio.disparar_captura(candidato())
    ocr = servicio.http.envios[1][1]
    assert ocr["lectura_valida"] is True and ocr["evidencia_lectura"]["caracteres_inferidos"] == []


def test_las_lecturas_rapidas_de_otros_cuadros_respaldan_la_placa(servicio, monkeypatch):
    """El OCR rápido guarda el texto crudo de cada cuadro del track: si en otro cuadro leyó el "5"
    tal cual, la sustitución de la foto final queda respaldada."""
    _con_fila_de_caracteres(monkeypatch)
    pipeline = Pipeline(conteo={"PSY589": 2})
    servicio.fijar(pipeline=pipeline, trabajador_ocr=types.SimpleNamespace(_agent=Agente(placa="PSY-589", texto_crudo="PSY589")))
    servicio.encolar_ocr(5, np.zeros((100, 200, 3), np.uint8), [10, 10, 80, 30])
    assert servicio.motor._crudos_rapidos[5][0] == ["PSY589"]
    servicio.fijar(trabajador_ocr=types.SimpleNamespace(_agent=Agente(placa="PSY-589", texto_crudo="PSYS89")))
    servicio.disparar_captura(candidato())
    ocr = servicio.http.envios[1][1]
    assert ocr["lectura_valida"] is True
    assert ocr["evidencia_lectura"]["lecturas_rapidas_crudas"] == ["PSY589"]
    assert 5 not in servicio.motor._crudos_rapidos     # la pista resuelta ya no los necesita


def test_el_descarte_audita_el_texto_leido_y_no_una_interpretacion(servicio):
    from app.aplicacion.motor import MAX_INTENTOS_CAPTURA

    servicio.fijar(pipeline=Pipeline(), selector=SelectorDePrueba(), trabajador_ocr=types.SimpleNamespace(
        _agent=Agente(placa="TR-4N51", estado="no_legible", confianza=0.2, texto_crudo="TRANS1")))
    for _ in range(MAX_INTENTOS_CAPTURA):
        servicio.disparar_captura(candidato())
    assert servicio.http.envios[-1][1]["texto_candidato"] == "TRANS1"


def test_el_registro_no_espera_al_verificador_mas_alla_de_su_presupuesto(servicio, monkeypatch):
    """Antes el motor esperaba al verificador hasta el final (4 s en la prueba con la cámara simulada)
    para luego descartar su lectura por tardía. Ahora registra al vencer el presupuesto."""
    import dataclasses

    liberar = threading.Event()

    class VerificadorLento(VerificadorFijo):
        def read(self, recorte):
            liberar.wait(5)
            return super().read(recorte)

    monkeypatch.setattr(servicio.motor, "_config", dataclasses.replace(servicio.motor._config, espera_verificador_s=0.05))
    monkeypatch.setattr(servicio.motor._dep, "verificador", lambda: VerificadorLento("PBA1234"))
    servicio.fijar(pipeline=Pipeline(conteo={"PBA1234": 2}), trabajador_ocr=types.SimpleNamespace(_agent=Agente()))
    antes = _valor("anpr_ocr_errors_total", error_type="verificador_fuera_de_tiempo")
    t0 = time.monotonic()
    servicio.disparar_captura(candidato())
    demora = time.monotonic() - t0
    liberar.set()
    assert demora < 2.0
    ocr = servicio.http.envios[1][1]
    assert ocr["lectura_verificador"] is None and ocr["evidencia_lectura"]["lectura_verificador"] is None
    assert _valor("anpr_ocr_errors_total", error_type="verificador_fuera_de_tiempo") - antes == 1


def test_el_tope_cuenta_desde_que_el_verificador_empieza_a_leer(servicio, monkeypatch):
    """Si la etapa espera en cola (otro registro ocupa los hilos), esa espera no consume el
    presupuesto: una lectura que el verificador hace a tiempo se usa, como antes del tope."""
    import dataclasses

    ocupado = threading.Event()

    def bloquear():
        ocupado.wait(5)
        return None, 0.0

    monkeypatch.setattr(servicio.motor, "_config", dataclasses.replace(servicio.motor._config, espera_verificador_s=0.2))
    monkeypatch.setattr(servicio.motor._dep, "verificador", lambda: VerificadorFijo("PBA1234"))
    servicio.fijar(pipeline=Pipeline(conteo={"PBA1234": 1}), trabajador_ocr=types.SimpleNamespace(_agent=Agente()))
    # Los tres hilos de etapas quedan ocupados 0,5 s: el verificador espera en cola más que su tope
    for _ in range(3):
        servicio.motor._ejecutor_etapas.submit(bloquear)
    threading.Timer(0.5, ocupado.set).start()
    servicio.disparar_captura(candidato())
    ocr = servicio.http.envios[1][1]
    assert ocr["lectura_verificador"] == "PBA-1234" and ocr["evidencia_lectura"]["verificador_coincide"] is True


# ─── Registro en menos de 1 s: lo que tarda llega como reevaluación ──────────

class ReconocedorLento:
    """Atributos del vehículo (CLIP) que tardan más que el registro."""

    def __init__(self, liberar):
        self.liberar = liberar

    def analyze(self, frame, caja):
        self.liberar.wait(5)
        return types.SimpleNamespace(to_dict=lambda: {"tipo": "auto", "color": "blanco"})


class VerificadorTardio(VerificadorFijo):
    def __init__(self, placa, liberar, crudo=None):
        super().__init__(placa, crudo=crudo)
        self.liberar = liberar

    def read(self, recorte):
        self.liberar.wait(5)
        return super().read(recorte)


def _configurar(servicio, monkeypatch, **cambios):
    import dataclasses

    monkeypatch.setattr(servicio.motor, "_config", dataclasses.replace(servicio.motor._config, **cambios))


def _liberar_al_registrar(servicio, monkeypatch, evento, demora=0.1):
    """El trabajo lento termina `demora` segundos después de que el paso queda registrado."""
    original = servicio.http.post
    registros = []

    def post(url, json=None, timeout=None):
        if url.endswith("/detecciones/completar-ocr"):
            registros.append(time.monotonic())
            threading.Timer(demora, evento.set).start()
        return original(url, json=json, timeout=timeout)

    monkeypatch.setattr(servicio.http, "post", post)
    return registros


def test_el_paso_se_registra_sin_esperar_al_vehiculo_y_sus_atributos_llegan_despues(servicio, monkeypatch):
    _con_fila_de_caracteres(monkeypatch)
    liberar = threading.Event()
    monkeypatch.setattr(servicio.motor._dep, "reconocedor_vehiculo", lambda: ReconocedorLento(liberar))
    servicio.fijar(pipeline=Pipeline(conteo={"PBA1234": 2}), trabajador_ocr=types.SimpleNamespace(_agent=Agente()))
    registros = _liberar_al_registrar(servicio, monkeypatch, liberar, demora=0.2)
    t0 = time.monotonic()
    servicio.disparar_captura(candidato())
    assert registros and registros[0] - t0 < 1.0
    assert servicio.http.rutas() == ["detecciones/ingreso", "detecciones/completar-ocr", "detecciones/reevaluar"]
    assert servicio.http.envios[0][1]["metadatos"]["vehiculo"] is None
    assert servicio.http.envios[2][1] == {"ingreso_id": 77, "vehiculo": {"tipo": "auto", "color": "blanco"}}


def test_el_segundo_ocr_que_llega_tarde_confirma_la_lectura_en_la_reevaluacion(servicio, monkeypatch):
    _con_fila_de_caracteres(monkeypatch)
    _configurar(servicio, monkeypatch, presupuesto_registro_s=0.3)   # 0,3 s menos 0,25 s de reserva
    liberar = threading.Event()
    monkeypatch.setattr(servicio.motor._dep, "verificador", lambda: VerificadorTardio("PBA1234", liberar, crudo="PBA1234"))
    servicio.fijar(pipeline=Pipeline(conteo={}), trabajador_ocr=types.SimpleNamespace(_agent=Agente(texto_crudo="PBA1234")))
    _liberar_al_registrar(servicio, monkeypatch, liberar)
    servicio.disparar_captura(candidato())
    assert servicio.http.rutas() == ["detecciones/ingreso", "detecciones/completar-ocr", "detecciones/reevaluar"]
    registro, reevaluacion = servicio.http.envios[1][1], servicio.http.envios[2][1]
    # Sin el segundo OCR, una sola lectura no confirma la placa; al llegar, la confirma
    assert registro["lectura_valida"] is False and registro["evidencia_lectura"]["segundo_ocr_pendiente"] is True
    assert reevaluacion["lectura_valida"] is True and reevaluacion["lectura_verificador"] == "PBA-1234"
    assert reevaluacion["evidencia_lectura"]["verificador_coincide"] is True
    assert "segundo_ocr_pendiente" not in reevaluacion["evidencia_lectura"]


def test_si_el_segundo_ocr_tardio_lee_otra_placa_la_reevaluacion_la_registra_como_antes(servicio, monkeypatch):
    """Igual que si hubiera llegado a tiempo: prevalece la placa del verificador, sin validarla
    porque ninguna lectura OCR la confirma (antes la rápida PBV1234 se registraba y se validaba)."""
    _con_fila_de_caracteres(monkeypatch)
    _configurar(servicio, monkeypatch, presupuesto_registro_s=0.3)
    liberar = threading.Event()
    monkeypatch.setattr(servicio.motor._dep, "verificador", lambda: VerificadorTardio("PBA1234", liberar))
    servicio.fijar(pipeline=Pipeline(conteo={"PBV1234": 3}), trabajador_ocr=types.SimpleNamespace(_agent=Agente(placa="PBV1234")))
    _liberar_al_registrar(servicio, monkeypatch, liberar)
    servicio.disparar_captura(candidato())
    registro, reevaluacion = servicio.http.envios[1][1], servicio.http.envios[2][1]
    assert registro["placa_reconocida"].replace("-", "") == "PBV1234" and registro["lectura_valida"] is True
    assert reevaluacion["placa_reconocida"] == "PBA-1234" and reevaluacion["lectura_valida"] is False
    assert "PBA1234" in servicio.placas_registradas


def test_una_foto_dudosa_espera_al_verificador_como_antes(servicio, monkeypatch):
    """Sin fila de caracteres (E3) el verificador es quien confirma o descarta: no hay registro rápido."""
    _configurar(servicio, monkeypatch, presupuesto_registro_s=0.3)
    liberar = threading.Event()
    monkeypatch.setattr(servicio.motor._dep, "verificador", lambda: VerificadorTardio("PBA1234", liberar))
    servicio.fijar(pipeline=Pipeline(conteo={"PBA1234": 2}), trabajador_ocr=types.SimpleNamespace(_agent=Agente()))
    threading.Timer(0.3, liberar.set).start()
    servicio.disparar_captura(candidato())
    assert servicio.http.rutas() == ["detecciones/ingreso", "detecciones/completar-ocr"]
    assert servicio.http.envios[1][1]["lectura_verificador"] == "PBA-1234"


def test_sin_presupuesto_el_registro_espera_al_vehiculo_como_antes(servicio, monkeypatch):
    _con_fila_de_caracteres(monkeypatch)
    _configurar(servicio, monkeypatch, presupuesto_registro_s=None)
    liberar = threading.Event()
    monkeypatch.setattr(servicio.motor._dep, "reconocedor_vehiculo", lambda: ReconocedorLento(liberar))
    servicio.fijar(pipeline=Pipeline(conteo={"PBA1234": 2}), trabajador_ocr=types.SimpleNamespace(_agent=Agente()))
    threading.Timer(0.2, liberar.set).start()
    servicio.disparar_captura(candidato())
    assert servicio.http.rutas() == ["detecciones/ingreso", "detecciones/completar-ocr"]
    assert servicio.http.envios[0][1]["metadatos"]["vehiculo"] == {"tipo": "auto", "color": "blanco"}


# ─── Solo placas: la lectura debe corresponder a la forma de la placa ────────

def test_texto_con_formato_de_moto_en_un_recuadro_de_auto_no_se_registra(servicio):
    """Teclado o pantalla: 'AH7441' (2 letras + 4 dígitos) dentro de un recuadro alargado de placa de
    auto. No es una placa: no se registra el paso; se audita el descarte."""
    servicio.fijar(pipeline=Pipeline(conteo={"AH7441": 2}), trabajador_ocr=types.SimpleNamespace(_agent=Agente(placa="AH7441")))
    servicio.disparar_captura(candidato())                     # 160×40: placa de auto
    assert servicio.http.rutas() == ["detecciones/descarte"]
    assert servicio.http.envios[0][1]["motivo"] == "formato_no_corresponde_a_la_placa"


def test_la_misma_lectura_en_un_recuadro_de_moto_si_se_registra(servicio):
    servicio.fijar(pipeline=Pipeline(conteo={"AH7441": 2}), trabajador_ocr=types.SimpleNamespace(_agent=Agente(placa="AH7441")))
    servicio.disparar_captura(candidato(ancho=60, alto=50))   # casi cuadrada: placa de moto
    assert servicio.http.rutas()[0] == "detecciones/ingreso"


def test_una_placa_diplomatica_de_auto_si_se_registra(servicio):
    servicio.fijar(pipeline=Pipeline(conteo={"CC1234": 2}), trabajador_ocr=types.SimpleNamespace(_agent=Agente(placa="CC1234")))
    servicio.disparar_captura(candidato())
    assert servicio.http.rutas()[0] == "detecciones/ingreso"


def test_si_el_ocr_lee_formato_de_moto_se_espera_al_verificador_y_su_lectura_se_registra(servicio, monkeypatch):
    """Placa de auto movida: el OCR leyó PJ001 (le falta la F). Sin registro rápido para esa lectura:
    se espera al verificador, que leyó PJF001, y se registra esa placa."""
    _con_fila_de_caracteres(monkeypatch)
    _configurar(servicio, monkeypatch, presupuesto_registro_s=0.3)
    liberar = threading.Event()
    monkeypatch.setattr(servicio.motor._dep, "verificador", lambda: VerificadorTardio("PJF001", liberar))
    servicio.fijar(pipeline=Pipeline(conteo={"PJ001": 2}), trabajador_ocr=types.SimpleNamespace(_agent=Agente(placa="PJ001")))
    threading.Timer(0.3, liberar.set).start()
    servicio.disparar_captura(candidato())
    assert servicio.http.rutas() == ["detecciones/ingreso", "detecciones/completar-ocr"]
    assert servicio.http.envios[1][1]["placa_reconocida"].replace("-", "") == "PJF001"


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
    servicio.motor._pistas_activas = {5}   # el vehículo sigue a la vista
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
    servicio.motor._pistas_activas = {5}
    for _ in range(MAX_INTENTOS_CAPTURA):
        servicio.disparar_captura(candidato())
    assert servicio.http.rutas() == ["detecciones/descarte"]
    assert servicio.http.envios[0][1]["motivo"] == "region_sin_caracteres"
    assert selector.liberados == [5] * (MAX_INTENTOS_CAPTURA - 1)


# ─── Deduplicación y robustez del registro (auditoría del motor) ─────────────

def _vencer_antirebote(servicio, tid):
    """Simula que pasaron más de 35 s desde el disparo de la pista y desde el registro de la placa."""
    servicio.motor._capturas_por_track[tid] = 0.0
    for placa in list(servicio.motor._placas_registradas):
        servicio.motor._placas_registradas[placa] = 0.0


def test_vehiculo_detenido_mas_de_35_s_no_se_registra_dos_veces(servicio):
    """Un vehículo detenido frente a la garita (control de documentos) sigue a la vista con la misma
    pista: vencidas las ventanas de 35 s, la pista ya resuelta no vuelve a registrarse."""
    servicio.fijar(pipeline=Pipeline(conteo={"PBA1234": 2}), trabajador_ocr=types.SimpleNamespace(_agent=Agente()))
    servicio.disparar_captura(candidato(tid=5))
    assert servicio.http.rutas() == ["detecciones/ingreso", "detecciones/completar-ocr"]
    _vencer_antirebote(servicio, 5)
    servicio.motor._renovar_pasos({5})       # sigue a la vista: la ventana de su placa cuenta desde ahora
    servicio.disparar_captura(candidato(tid=5))
    # Si su pista se pierde (oclusión) y nace otra para el mismo vehículo, es el mismo paso
    servicio.disparar_captura(candidato(tid=8))
    assert servicio.http.rutas() == ["detecciones/ingreso", "detecciones/completar-ocr"]
    # Cuando ya no se ve durante más de 35 s, un paso nuevo de esa placa sí se registra
    servicio.motor._renovar_pasos(set())
    _vencer_antirebote(servicio, 9)
    servicio.disparar_captura(candidato(tid=9))
    assert servicio.http.rutas().count("detecciones/ingreso") == 2


def test_pista_descartada_no_se_audita_de_nuevo_cada_35_s(servicio):
    from app.aplicacion.motor import MAX_INTENTOS_CAPTURA

    servicio.fijar(pipeline=Pipeline(), selector=SelectorDePrueba(),
                   trabajador_ocr=types.SimpleNamespace(_agent=Agente(placa="", estado="no_legible")))
    servicio.motor._pistas_activas = {5}
    for _ in range(MAX_INTENTOS_CAPTURA):
        servicio.disparar_captura(candidato())
    assert servicio.http.rutas() == ["detecciones/descarte"]
    _vencer_antirebote(servicio, 5)
    servicio.disparar_captura(candidato())     # el rótulo sigue ahí: no se vuelve a leer ni a auditar
    assert servicio.http.rutas() == ["detecciones/descarte"]


def test_si_el_vehiculo_ya_salio_la_foto_ilegible_se_audita_al_instante(servicio):
    """Sin la pista a la vista nadie volverá a disparar: el paso no se pierde en silencio."""
    selector = SelectorDePrueba()
    servicio.fijar(pipeline=Pipeline(), selector=selector,
                   trabajador_ocr=types.SimpleNamespace(_agent=Agente(placa="", estado="no_legible", confianza=0.1)))
    servicio.motor._pistas_activas = set()
    servicio.disparar_captura(candidato())
    assert servicio.http.rutas() == ["detecciones/descarte"]


def test_un_fallo_transitorio_del_backend_se_reintenta(servicio):
    servicio.fijar(pipeline=Pipeline(conteo={"PBA1234": 2}), trabajador_ocr=types.SimpleNamespace(_agent=Agente()))
    servicio.http.ingresos = [Respuesta(503, {"error": "reiniciando"}), ConnectionError("sin red")]
    servicio.disparar_captura(candidato())
    assert servicio.http.rutas() == ["detecciones/ingreso"] * 3 + ["detecciones/completar-ocr"]
    assert "PBA1234" in servicio.placas_registradas


def test_si_el_backend_no_acepta_el_ingreso_la_placa_no_queda_registrada(servicio):
    """Con el backend caído no se pierde el paso en silencio ni se bloquea la placa 35 s: la reserva
    se revierte, el fallo se cuenta y, si el vehículo ya salió, se audita (cuando el backend vuelva)."""
    pipeline = Pipeline(conteo={"PBA1234": 2})
    servicio.fijar(pipeline=pipeline, selector=SelectorDePrueba(), trabajador_ocr=types.SimpleNamespace(_agent=Agente()))
    antes = _valor("anpr_detection_errors_total", error_type="backend")
    servicio.http.ingresos = [Respuesta(503, {"error": "caído"})] * 3
    servicio.disparar_captura(candidato())
    assert "PBA1234" not in servicio.placas_registradas
    assert ("rtsp", 5, "", "leida") in pipeline.votos        # el HUD deja de mostrarla como confirmada
    assert servicio.http.rutas() == ["detecciones/ingreso"] * 3 + ["detecciones/descarte"]
    assert servicio.http.envios[-1][1]["motivo"] == "backend_no_disponible"
    assert _valor("anpr_detection_errors_total", error_type="backend") - antes == 1


def test_el_paso_conserva_la_camara_con_que_se_disparo(servicio):
    servicio.fijar(pipeline=Pipeline(conteo={"PBA1234": 2}), trabajador_ocr=types.SimpleNamespace(_agent=Agente()))
    cand = candidato()
    servicio.motor.camara_id = 2                 # el operador cambió de cámara durante el registro
    servicio.motor._verificar_y_registrar(cand, 5, cand.frame.copy(), 0.0, camara=1)
    assert servicio.http.envios[0][1]["camara_id"] == 1


def test_el_cambio_de_camara_olvida_la_ventana_por_placa_de_la_anterior(servicio):
    class FuenteFalsa:
        def __init__(self, url=None):
            self.url, self.is_connected, self._grab_running = url, False, False

        def connect(self):
            return True

        def release(self):
            pass

    servicio.reemplazar_fuente_rtsp(lambda url: FuenteFalsa(url=url))
    servicio.fijar(pipeline=Pipeline(), selector=types.SimpleNamespace(_active_candidates={}, _captured_history={}, _prev_area={}, _track_first_seen={}))
    servicio.motor._placas_registradas["PBA1234"] = time.time()
    servicio.client.post("/api/camera/switch", headers=SERVICIO, json={"camera_id": 2, "rtsp_url": "rtsp://anpr:x@mediamtx:8554/cam_2"})
    assert servicio.placas_registradas == {}


def test_el_antiduplicado_temprano_exige_consenso_del_ocr_rapido(servicio):
    """Una sola lectura rápida que coincide con una placa recién registrada (confusión 8→3) no omite
    al vehículo: lo deciden el OCR profundo y el verificador."""
    class PipelineConLectura(Pipeline):
        def get_track_info(self, tid):
            return {"plate": "PBA1234", "confidence": 0.9}

    class Verificador:
        description = "verificador de prueba"

        def read(self, recorte):
            return types.SimpleNamespace(plate="PBA1284", confidence=0.96, within_budget=True, elapsed_ms=5.0)

    # El consenso rápido quedó en PBA1234 con una sola lectura; el OCR profundo y el verificador leen PBA1284
    servicio._mp.setattr(servicio.motor._dep, "verificador", lambda: Verificador())
    pipeline = PipelineConLectura(conteo={"PBA1234": 1, "PBA1284": 2})
    servicio.fijar(pipeline=pipeline, trabajador_ocr=types.SimpleNamespace(_agent=Agente(placa="PBA1284")))
    servicio.motor._placas_registradas["PBA1234"] = time.time()
    servicio.disparar_captura(candidato(tid=6))
    assert servicio.http.envios[0][1]["placa"].replace("-", "") == "PBA1284"
    # Con dos lecturas concordantes sí se omite antes de leer
    servicio.http.envios.clear()
    servicio.fijar(pipeline=PipelineConLectura(conteo={"PBA1234": 2}))
    servicio.disparar_captura(candidato(tid=7))
    assert servicio.http.envios == []


def test_si_el_backend_deduplica_se_borran_las_fotos_del_intento(servicio, tmp_path):
    servicio.fijar(pipeline=Pipeline(conteo={"PBA1234": 2}), trabajador_ocr=types.SimpleNamespace(_agent=Agente()))
    servicio.http.ingresos = [Respuesta(200, {"ingreso_id": 41, "deduplicado": True})]
    servicio.disparar_captura(candidato())
    assert servicio.http.rutas() == ["detecciones/ingreso"]
    assert list(tmp_path.glob("*.jpg")) == []


def test_ocr_asincrono_con_enfriamiento_por_track(servicio):
    pipeline = Pipeline()
    servicio.fijar(pipeline=pipeline, trabajador_ocr=types.SimpleNamespace(_agent=Agente(estado="procesado")))
    frame = np.zeros((100, 200, 3), np.uint8)
    servicio.encolar_ocr(3, frame, [10, 10, 80, 30])
    servicio.encolar_ocr(3, frame, [10, 10, 80, 30])   # dentro de 0,6 s: se ignora
    assert servicio.ocr.enviados == 1
    assert pipeline.votos == [("rtsp", 3, "PBA1234", "leida")]


def test_placa_cortada_por_el_borde_no_se_lee(servicio):
    """El OCR de una placa que entra por el borde lee texto truncado ("SY589" por "PSY589"):
    el hilo de detección no la lee hasta que está completa."""
    from app.aplicacion.detector import TrackedPlateROI
    from app.aplicacion.motor import leible

    pipeline = Pipeline()
    servicio.fijar(pipeline=pipeline, trabajador_ocr=types.SimpleNamespace(_agent=Agente(estado="procesado")))
    frame = np.zeros((360, 640, 3), np.uint8)
    completa = TrackedPlateROI(tracking_id=1, plate_bbox=[200, 150, 320, 190], vehicle_bbox=[0, 0, 640, 360],
                               confidence=0.9, en_movimiento=True)
    cortada = TrackedPlateROI(tracking_id=2, plate_bbox=[0, 150, 100, 190], vehicle_bbox=[0, 0, 640, 360], confidence=0.9)
    servicio.motor._leer_placas(pipeline, [completa, cortada], frame)
    assert servicio.ocr.enviados == 1
    assert pipeline.votos == [("rtsp", 1, "PBA1234", "leida")]
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
