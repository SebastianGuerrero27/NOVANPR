"""
Lector RTSP del motor: límites de espera, vigilante de estancamiento y reconexión.

Las pruebas de comportamiento inyectan una captura simulada (sin red); la del límite de espera usa
OpenCV real contra un servidor TCP que acepta la conexión y nunca responde (una cámara colgada).
"""
import os
import socket
import threading
import time

import numpy as np

from app.infraestructura.video_source import OPCIONES_FFMPEG_RTSP, RTSPSource, _abrir_rtsp


class CapturaFalsa:
    """Entrega `cuadros` cuadros y luego deja de entregar (flujo estancado)."""

    def __init__(self, cuadros: int) -> None:
        self.restantes = cuadros
        self.liberada = False

    def grab(self) -> bool:
        if self.restantes <= 0:
            time.sleep(0.01)
            return False
        self.restantes -= 1
        time.sleep(0.005)
        return True

    def retrieve(self):
        return True, np.full((4, 4, 3), self.restantes, np.uint8)

    def get(self, _prop):
        return 0

    def release(self) -> None:
        self.liberada = True


def esperar(condicion, limite_s: float = 3.0) -> bool:
    fin = time.time() + limite_s
    while time.time() < fin:
        if condicion():
            return True
        time.sleep(0.02)
    return False


def test_opciones_de_ffmpeg_usan_timeout_y_no_la_obsoleta_stimeout():
    """En FFmpeg >= 5 «stimeout» no existe: se ignoraba y la lectura podía bloquearse para siempre."""
    assert "timeout;5000000" in OPCIONES_FFMPEG_RTSP and "stimeout" not in OPCIONES_FFMPEG_RTSP
    assert "rtsp_transport;tcp" in OPCIONES_FFMPEG_RTSP
    assert os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] == OPCIONES_FFMPEG_RTSP


def test_si_el_flujo_se_estanca_el_vigilante_reconecta():
    capturas: list[CapturaFalsa] = []

    def abrir(url, abrir_ms, leer_ms):
        capturas.append(CapturaFalsa(cuadros=5))
        return capturas[-1]

    fuente = RTSPSource("rtsp://anpr:token@mediamtx:8554/cam_1", estancamiento_s=0.3, abrir=abrir)
    fuente.connect()
    try:
        assert esperar(lambda: fuente.read_frame()[0])
        assert esperar(lambda: fuente.reconexiones >= 1)
        assert capturas[0].liberada
        info = fuente.source_info
        assert info["url"] == "rtsp://****:****@mediamtx:8554/cam_1" and info["reconexiones"] >= 1
    finally:
        fuente.release()


def test_un_cuadro_de_antes_de_la_caida_no_se_entrega_como_reciente():
    estado = {"abiertas": 0}

    def abrir(url, abrir_ms, leer_ms):
        estado["abiertas"] += 1
        return CapturaFalsa(cuadros=3 if estado["abiertas"] == 1 else 0)

    fuente = RTSPSource("rtsp://x/cam_1", estancamiento_s=0.2, abrir=abrir)
    fuente.connect()
    try:
        assert esperar(lambda: fuente.read_frame()[0])
        assert esperar(lambda: estado["abiertas"] >= 2)
        assert fuente.read_frame() == (False, None)
        assert not fuente.is_connected
    finally:
        fuente.release()


def test_si_la_fuente_no_abre_reintenta_con_espera_creciente():
    intentos: list[float] = []

    def abrir(url, abrir_ms, leer_ms):
        intentos.append(time.time())
        return None

    fuente = RTSPSource("rtsp://x/cam_1", abrir=abrir)
    fuente.connect()
    time.sleep(2.0)
    fuente.release()
    # 1.er intento inmediato, el 2.º a los 1,5 s, el 3.º a los 4,5 s: no un bucle de reintentos
    assert len(intentos) == 2 and 1.3 <= intentos[1] - intentos[0] <= 2.0


def test_sin_url_no_intenta_abrir():
    llamadas = []
    fuente = RTSPSource("", abrir=lambda *a: llamadas.append(a))
    fuente.connect()
    time.sleep(0.2)
    fuente.release()
    assert llamadas == []


def test_limite_de_espera_real_al_abrir_una_camara_que_no_responde():
    """Servidor que acepta la conexión TCP y nunca contesta el RTSP: OpenCV debe rendirse a tiempo."""
    servidor = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    servidor.bind(("127.0.0.1", 0))
    servidor.listen(1)
    puerto = servidor.getsockname()[1]
    aceptadas: list[socket.socket] = []
    threading.Thread(target=lambda: aceptadas.append(servidor.accept()[0]), daemon=True).start()
    try:
        t0 = time.time()
        cap = _abrir_rtsp(f"rtsp://127.0.0.1:{puerto}/Streaming/Channels/101", abrir_ms=1000, leer_ms=1000)
        transcurrido = time.time() - t0
        assert cap is None
        assert transcurrido < 7.0, f"la apertura tardó {transcurrido:.1f} s"
    finally:
        for c in aceptadas:
            c.close()
        servidor.close()


class CapturaCorrupta(CapturaFalsa):
    """Entrega cuadros vacíos (decodificación fallida) tras uno válido."""

    def retrieve(self):
        return True, np.zeros((0, 0, 3), np.uint8)


def test_un_cuadro_vacio_o_corrupto_no_se_entrega():
    fuente = RTSPSource("rtsp://x/cam_1", estancamiento_s=5.0, abrir=lambda *a: CapturaCorrupta(cuadros=50))
    fuente.connect()
    try:
        time.sleep(0.4)
        assert fuente.read_frame() == (False, None)
        assert fuente.frame_seq == 0
    finally:
        fuente.release()

