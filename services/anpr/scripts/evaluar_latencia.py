"""
Latencia y exactitud del reconocimiento con la placa en movimiento continuo, de punta a punta.

Ejecuta el motor de producción tal cual (app.main: hilos de captura y de detección, OCR rápido
asíncrono, compuerta de captura, OCR profundo, verificador PP-OCRv6 y atributos del vehículo) con
dos sustitutos: una cámara que entrega cuadros en tiempo real y un backend que registra cuándo
llega cada envío.

Escena por captura etiquetada (scripts/escenas_compuerta.csv): la placa se borra con inpainting
para obtener la escena vacía; luego cruza el cuadro de izquierda a derecha a velocidad constante,
con desenfoque de movimiento horizontal y ruido gaussiano σ = 2. Cada captura se recorre en
dos escenarios: obturación rápida (3 px de desenfoque) y lenta (8 px); con más de ~6 px el OCR
pierde la mayoría de las placas de ~180 px de ancho (ver docs/METODO_VERIFICACION_LECTURA.md §3.2).

Ablación pareada: cada escena se recorre con la variante base (etapas del registro una tras otra,
sin análisis anticipado del vehículo, sin reintento de captura y enfriamiento del OCR de 0,6 s) y
con la optimizada (valores de producción), alternando el orden entre escenas. Así ambas sufren la
misma carga del equipo, que en un portátil con otros procesos varía mucho de un minuto a otro.

Métricas por paso: latencia desde que la placa está completa en el cuadro hasta el registro con
la lectura (POST /api/detecciones/completar-ocr), placa registrada frente a la etiqueta, validez
de la lectura y duración de cada etapa del registro. La comparación usa las escenas registradas
por ambas variantes: mediana de la diferencia con IC 95 % por bootstrap y prueba de Wilcoxon.

Uso (dentro del contenedor del servicio; las capturas están en media/):
    docker exec -w /app anpr-service python scripts/evaluar_latencia.py --salida /tmp/latencia.json
"""

from __future__ import annotations

import argparse
import csv
import dataclasses
import json
import os
import statistics
import sys
import tempfile
import threading
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FPS = 15
VACIA_S = 1.0       # escena vacía antes de cada paso
ASENTAR_S = 3.0     # espera tras la salida para que termine el registro
VARIANTES = {
    "base": {"registro_paralelo": False, "vehiculo_anticipado": False, "intentos_captura": 1, "enfriamiento_ocr_s": 0.6},
    "optimizada": {},
}


# ─── Escena ──────────────────────────────────────────────────────────────────

def escena(img: np.ndarray, caja: list[int], cruce_s: float, desenfoque_px: int, semilla: int = 7):
    """Cuadros de la escena vacía y del cruce, e índices del primer y último cuadro con la placa completa."""
    h, w = img.shape[:2]
    x1, y1, x2, y2 = caja
    mw, mh = int((x2 - x1) * 0.30), int((y2 - y1) * 0.60)
    rx1, ry1, rx2, ry2 = max(0, x1 - mw), max(0, y1 - mh), min(w, x2 + mw), min(h, y2 + mh)
    objeto = img[ry1:ry2, rx1:rx2].copy()
    mascara = np.zeros((h, w), np.uint8)
    mascara[ry1:ry2, rx1:rx2] = 255
    fondo = cv2.inpaint(img, mascara, 5, cv2.INPAINT_TELEA)
    ow = rx2 - rx1
    n = max(2, int(cruce_s * FPS))
    paso = (w + ow) / n
    if desenfoque_px >= 2:
        nucleo = np.full((1, desenfoque_px), 1.0 / desenfoque_px, np.float32)
        objeto = cv2.filter2D(objeto, -1, nucleo)
    px1, px2 = x1 - rx1, x2 - rx1  # la placa dentro del recorte que se desplaza
    rng = np.random.default_rng(semilla)

    def ruido(f):
        return np.clip(f.astype(np.float32) + rng.normal(0, 2, f.shape), 0, 255).astype(np.uint8)

    cuadros = [ruido(fondo) for _ in range(int(VACIA_S * FPS))]
    completos = []
    for k in range(n):
        x = int(-ow + paso * (k + 1))
        f = fondo.copy()
        a, b = max(0, x), min(w, x + ow)
        if b > a:
            f[ry1:ry2, a:b] = objeto[:, a - x:b - x]
        if x + px1 >= 0 and x + px2 <= w:
            completos.append(len(cuadros))
        cuadros.append(ruido(f))
    cuadros += [ruido(fondo) for _ in range(int(ASENTAR_S * FPS))]
    return cuadros, (completos[0] if completos else None), (completos[-1] if completos else None)


class CamaraSimulada:
    """Fuente de video que entrega los cuadros de la escena a FPS cuadros por segundo."""

    def __init__(self) -> None:
        self._name = "camara_simulada"
        self.is_connected = True
        self._cuadros: list[np.ndarray] = []
        self._i = 0
        self._siguiente = time.monotonic()
        self.emitidos: dict[int, float] = {}
        self._candado = threading.Lock()

    def cargar(self, cuadros: list[np.ndarray]) -> None:
        with self._candado:
            self._cuadros, self._i, self.emitidos = cuadros, 0, {}

    @property
    def terminada(self) -> bool:
        return self._i >= len(self._cuadros)

    def connect(self) -> bool:
        return True

    def release(self) -> None:
        pass

    def read_frame(self):
        espera = self._siguiente - time.monotonic()
        if espera > 0:
            time.sleep(espera)
        self._siguiente = max(self._siguiente + 1.0 / FPS, time.monotonic())
        with self._candado:
            if not self._cuadros:
                return False, None
            i = min(self._i, len(self._cuadros) - 1)
            self.emitidos.setdefault(i, time.time())
            self._i += 1
            return True, self._cuadros[i].copy()


# ─── Backend sustituto ───────────────────────────────────────────────────────

class Respuesta:
    def __init__(self, codigo: int, datos: dict) -> None:
        self.status_code, self._datos, self.text = codigo, datos, json.dumps(datos)

    def json(self) -> dict:
        return self._datos


class BackendRegistrador:
    def __init__(self) -> None:
        self.envios: list[tuple[float, str, dict]] = []
        self._id = 0

    def post(self, url: str, json: dict | None = None, timeout: float | None = None):
        self.envios.append((time.time(), url, json or {}))
        if url.endswith("/detecciones/ingreso"):
            self._id += 1
            return Respuesta(201, {"ingreso_id": self._id})
        if url.endswith("/detecciones/completar-ocr"):
            return Respuesta(200, {"deteccion": {"estado_validacion": "autorizado"}})
        return Respuesta(201, {"success": True})

    def get(self, *a, **k):
        return Respuesta(200, {})

    def close(self) -> None:
        pass


# ─── Medición por etapa ──────────────────────────────────────────────────────

class Cronometro:
    def __init__(self) -> None:
        self.etapas: list[tuple[float, str, float]] = []
        self._candado = threading.Lock()

    def envolver(self, objeto, metodo: str, etapa: str, solo_si=None) -> None:
        original = getattr(objeto, metodo)

        def medido(*args, **kwargs):
            t0 = time.perf_counter()
            try:
                return original(*args, **kwargs)
            finally:
                if solo_si is None or solo_si(args, kwargs):
                    with self._candado:
                        self.etapas.append((time.time(), etapa, (time.perf_counter() - t0) * 1000))

        setattr(objeto, metodo, medido)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--etiquetas", default="scripts/escenas_compuerta.csv")
    ap.add_argument("--media", default="media")
    ap.add_argument("--escenarios", default="1.5:3,1.5:8",
                    help="cruce_s:desenfoque_px separados por comas (segundos en cruzar el cuadro y px de desenfoque)")
    ap.add_argument("--salida", default=None)
    args = ap.parse_args()

    from app import main as composicion

    motor = composicion.motor
    camara = CamaraSimulada()
    backend = BackendRegistrador()
    motor._dep.crear_fuente_video = lambda: camara
    motor._http = backend
    motor._dir_media = tempfile.mkdtemp(prefix="latencia_")

    motor.iniciar()
    verificador, reconocedor = motor._dep.verificador(), motor._dep.reconocedor_vehiculo()  # precarga
    reloj = Cronometro()
    reloj.envolver(motor._trabajador_ocr._agent, "process_image", "ocr_profundo",
                   solo_si=lambda a, k: k.get("fast_mode") is False)
    if verificador is not None:
        reloj.envolver(verificador, "read", "verificador")
    if reconocedor is not None:
        reloj.envolver(reconocedor, "analyze", "vehiculo")
    capturas: list[float] = []
    reloj_captura = motor.disparar_captura

    def disparar(candidato):
        capturas.append(time.time())
        return reloj_captura(candidato)

    motor.disparar_captura = disparar

    with open(args.etiquetas, encoding="utf-8") as f:
        escenas = list(csv.DictReader(f))
    detector = motor._pipeline.detector
    config_produccion = motor._config
    detalle = []
    pasos = []
    for escenario in args.escenarios.split(","):
        cruce_s, desenfoque_px = float(escenario.split(":")[0]), int(escenario.split(":")[1])
        for n, e in enumerate(escenas):
            orden = list(VARIANTES) if n % 2 == 0 else list(reversed(VARIANTES))
            pasos += [(escenario, cruce_s, desenfoque_px, e, v) for v in orden]
    for escenario, cruce_s, desenfoque_px, e, variante in pasos:
        img = cv2.imread(os.path.join(args.media, e["archivo"]))
        dets = detector.predict(img) if img is not None else []
        if not dets:
            continue
        caja = [int(v) for v in max(dets, key=lambda d: d.confidence).bbox]
        cuadros, i_completa, _ = escena(img, caja, cruce_s, desenfoque_px)
        motor._config = dataclasses.replace(config_produccion, **VARIANTES[variante])
        # Paso independiente: sin memoria del anterior (misma placa en varias escenas)
        motor._pipeline.clear_all_tracks()
        motor._placas_registradas.clear()
        motor._capturas_por_track.clear()
        motor._intentos_captura.clear()
        motor._vehiculos.clear()
        for registro in ("_active_candidates", "_captured_history", "_prev_area", "_track_first_seen"):
            getattr(motor._selector, registro).clear()
        n_envios, n_etapas, n_capturas = len(backend.envios), len(reloj.etapas), len(capturas)
        camara.cargar(cuadros)
        while not camara.terminada:
            time.sleep(0.05)
        time.sleep(0.5)

        t_completa = camara.emitidos.get(i_completa) if i_completa is not None else None
        envios = backend.envios[n_envios:]
        completar = [(t, d) for t, u, d in envios if u.endswith("/completar-ocr")]
        ingresos = [t for t, u, _ in envios if u.endswith("/detecciones/ingreso")]
        etapas: dict[str, list[float]] = {}
        for _, nombre, ms in reloj.etapas[n_etapas:]:
            etapas.setdefault(nombre, []).append(round(ms, 1))
        primero = completar[0] if completar else None
        placa = (primero[1].get("placa_reconocida") or "").replace("-", "") if primero else None
        r = {
            "archivo": e["archivo"], "placa": e["placa"], "escenario": escenario, "variante": variante,
            "placa_registrada": placa, "acierto": placa == e["placa"],
            "lectura_valida": primero[1].get("lectura_valida") if primero else None,
            "registros": len(completar),
            "latencia_ms": int((primero[0] - t_completa) * 1000) if primero and t_completa else None,
            "captura_ms": int((capturas[n_capturas] - t_completa) * 1000) if len(capturas) > n_capturas and t_completa else None,
            "ingreso_ms": int((ingresos[0] - t_completa) * 1000) if ingresos and t_completa else None,
            "latencia_motor_ms": primero[1].get("latencia_ms") if primero else None,
            "etapas_ms": etapas,
        }
        detalle.append(r)
        print(json.dumps(r, ensure_ascii=False), flush=True)
    motor.detener()

    def med(xs):
        xs = [x for x in xs if x is not None]
        return round(statistics.median(xs), 1) if xs else None

    resumen = {}
    for escenario, variante in dict.fromkeys((r["escenario"], r["variante"]) for r in detalle):
        rs = [r for r in detalle if r["escenario"] == escenario and r["variante"] == variante]
        lat = sorted(r["latencia_ms"] for r in rs if r["latencia_ms"] is not None)
        cruce_s, desenfoque_px = escenario.split(":")
        resumen[f"cruce {cruce_s} s, desenfoque {desenfoque_px} px · {variante}"] = {
            "pasos": len(rs),
            "registrados": sum(r["registros"] > 0 for r in rs),
            "aciertos": sum(r["acierto"] for r in rs),
            "lecturas_validas": sum(bool(r["lectura_valida"]) for r in rs),
            "latencia_mediana_ms": med(lat),
            "latencia_p90_ms": lat[int(0.9 * (len(lat) - 1))] if lat else None,
            "latencia_max_ms": lat[-1] if lat else None,
            "captura_mediana_ms": med(r["captura_ms"] for r in rs),
            "ocr_profundo_mediana_ms": med(x for r in rs for x in r["etapas_ms"].get("ocr_profundo", [])),
            "verificador_mediana_ms": med(x for r in rs for x in r["etapas_ms"].get("verificador", [])),
            "vehiculo_mediana_ms": med(x for r in rs for x in r["etapas_ms"].get("vehiculo", [])),
        }
    comparacion = {}
    for escenario in dict.fromkeys(r["escenario"] for r in detalle):
        por = {(r["archivo"], r["variante"]): r for r in detalle if r["escenario"] == escenario}
        dif = [por[(a, "base")]["latencia_ms"] - por[(a, "optimizada")]["latencia_ms"]
               for a in dict.fromkeys(a for a, _ in por)
               if (a, "base") in por and (a, "optimizada") in por
               and por[(a, "base")]["latencia_ms"] is not None and por[(a, "optimizada")]["latencia_ms"] is not None]
        if not dif:
            continue
        rng = np.random.default_rng(0)
        boot = [float(np.median(rng.choice(dif, len(dif)))) for _ in range(5000)]
        try:
            from scipy.stats import wilcoxon
            p = float(wilcoxon(dif).pvalue) if len(dif) >= 5 and any(dif) else None
        except ImportError:
            p = None
        cruce_s, desenfoque_px = escenario.split(":")
        comparacion[f"cruce {cruce_s} s, desenfoque {desenfoque_px} px"] = {
            "pares": len(dif),
            "reduccion_mediana_ms": round(float(np.median(dif)), 1),
            "ic95_ms": [round(float(np.percentile(boot, 2.5)), 1), round(float(np.percentile(boot, 97.5)), 1)],
            "pares_mas_rapidos_optimizada": sum(d > 0 for d in dif),
            "wilcoxon_p": p,
        }
    print("RESUMEN", json.dumps(resumen, ensure_ascii=False), flush=True)
    print("COMPARACION", json.dumps(comparacion, ensure_ascii=False), flush=True)
    if args.salida:
        with open(args.salida, "w", encoding="utf-8") as f:
            json.dump({"fps": FPS, "variantes": VARIANTES, "resumen": resumen, "comparacion": comparacion,
                       "detalle": detalle}, f, ensure_ascii=False, indent=2)
    os._exit(0)  # hilos daemon de modelos (OpenVINO, CLIP) pueden retrasar la salida


if __name__ == "__main__":
    main()
