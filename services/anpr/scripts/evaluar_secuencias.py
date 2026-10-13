"""
Evaluación de punta a punta sobre secuencias de video etiquetadas (protocolo en
docs/PROTOCOLO_EVALUACION_SECUENCIAS.md).

Ejecuta el motor de producción tal cual (app.main: hilos de captura y de detección, compuerta,
recorte de la región, seguimiento, OCR rápido, compuerta de captura, OCR profundo y verificador)
con dos sustitutos: una "cámara" que entrega los cuadros de un video grabado a su velocidad real
(los cuadros que no alcanzan a analizarse se descartan como con la cámara en vivo) y un backend
que registra cada envío. Las zonas (región de interés y exclusiones) salen de la etiqueta.

Cada secuencia es un JSON (ver scripts/secuencias/*.json):
  {"secuencia": "...", "video": "ruta relativa al JSON", "particion": "calibracion|prueba",
   "condiciones": ["dia", "noche", "lluvia", ...], "zonas": {"roi": null, "exclusiones": []},
   "pasos": [{"placa": "PSY589", "legible": true, "inicio_s": 0.8, "fin_s": 4.5}, ...]}

Métricas (por secuencia y agregadas por partición y condición; proporciones con IC 95 % de
Wilson, falsas detecciones por hora con IC exacto de Poisson, latencias p50/p95/p99 con n):
  1. recall de detección por paso (alguna pista de placa durante el paso)
  2. precisión de los registros (registros asignados a un paso / registros)
  3. falsas detecciones por hora de cámara (registros sin paso)
  4. transcripción exacta de los pasos registrados
  5. reconocimiento exacto de punta a punta sobre los pasos legibles
  6. pasos legibles sin una lectura correcta
  7. duplicados por paso registrado
  8. latencia captura → lectura en vivo (HUD)
  9. latencia captura → registro confirmado por el backend
 10. FPS recibidos, FPS analizados y cuadros descartados

Uso (dentro del contenedor del motor, donde están los modelos):
    docker cp <video> anpr-service:/tmp/...   (o monte la carpeta de secuencias)
    docker exec -w /app anpr-service python scripts/evaluar_secuencias.py scripts/secuencias/*.json --salida /tmp/eval.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
import tempfile
import threading
import time
from collections import defaultdict

import cv2

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.evaluar_latencia import BackendRegistrador  # noqa: E402

ASENTAR_S = 8.0          # espera al final de cada secuencia para que terminen los registros
TOLERANCIA_S = 0.5       # el mejor cuadro de un registro puede caer apenas fuera del intervalo etiquetado


# ─── Estadística ─────────────────────────────────────────────────────────────

def wilson(exitos: int, n: int, z: float = 1.96) -> dict:
    """Proporción con su intervalo de confianza de Wilson (95 %)."""
    if n == 0:
        return {"valor": None, "ic95": None, "n": 0}
    p = exitos / n
    centro = (p + z * z / (2 * n)) / (1 + z * z / n)
    margen = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return {"valor": round(p, 4), "ic95": [round(max(0.0, centro - margen), 4), round(min(1.0, centro + margen), 4)], "n": n, "exitos": exitos}


def poisson_por_hora(eventos: int, horas: float) -> dict:
    """Tasa por hora con IC exacto (Garwood) aproximado por la chi-cuadrado vía Wilson–Hilferty."""
    if horas <= 0:
        return {"valor": None, "ic95": None, "eventos": eventos, "horas": 0}

    def chi2_cuantil(p: float, gl: float) -> float:
        if gl <= 0:
            return 0.0
        z = statistics.NormalDist().inv_cdf(p)
        return gl * (1 - 2 / (9 * gl) + z * math.sqrt(2 / (9 * gl))) ** 3

    bajo = 0.0 if eventos == 0 else chi2_cuantil(0.025, 2 * eventos) / 2
    alto = chi2_cuantil(0.975, 2 * (eventos + 1)) / 2
    return {"valor": round(eventos / horas, 2), "ic95": [round(bajo / horas, 2), round(alto / horas, 2)], "eventos": eventos, "horas": round(horas, 4)}


def percentiles(valores: list[float]) -> dict | None:
    if not valores:
        return None
    datos = sorted(valores)

    def p(q: float) -> int:
        return round(1000 * datos[min(len(datos) - 1, int(math.ceil(q * len(datos))) - 1)])

    return {"p50_ms": p(0.50), "p95_ms": p(0.95), "p99_ms": p(0.99), "n": len(datos)}


# ─── Cámara sustituta: video grabado a su velocidad real ─────────────────────

class VideoGrabado:
    """Entrega los cuadros de un video a su FPS, con número de cuadro y hora de entrega, como
    RTSPSource: el motor descarta los que no alcanza a analizar."""

    def __init__(self, ruta: str) -> None:
        self._cap = cv2.VideoCapture(ruta)
        if not self._cap.isOpened():
            raise RuntimeError(f"No se pudo abrir el video {ruta}")
        self.fps = self._cap.get(cv2.CAP_PROP_FPS) or 25.0
        self._name = os.path.basename(ruta)
        self.is_connected = True
        self.frame_seq = 0
        self.hora_entregada = 0.0
        self.emitidos: dict[int, float] = {}
        self.terminada = False
        self._siguiente = None
        self._ultimo = None

    def connect(self) -> bool:
        return True

    def release(self) -> None:
        self._cap.release()

    def read_frame(self):
        if self.terminada:
            time.sleep(0.02)
            return False, None
        ahora = time.monotonic()
        if self._siguiente is None:
            self._siguiente = ahora
        if ahora < self._siguiente:
            # Aún no llega el siguiente cuadro: se repite el último (como RTSPSource)
            time.sleep(min(0.005, self._siguiente - ahora))
            return (True, self._ultimo.copy()) if self._ultimo is not None else (False, None)
        ok, cuadro = self._cap.read()
        if not ok:
            self.terminada = True
            return False, None
        self._siguiente += 1.0 / self.fps
        self.frame_seq += 1
        self.hora_entregada = time.time()
        self.emitidos[self.frame_seq] = self.hora_entregada
        self._ultimo = cuadro
        return True, cuadro.copy()


# ─── Ejecución de una secuencia ──────────────────────────────────────────────

class SinFuente:
    """Fuente vacía mientras no hay una secuencia en curso."""
    _name = "sin_fuente"
    is_connected = False

    def connect(self) -> bool:
        return True

    def release(self) -> None:
        pass

    def read_frame(self):
        time.sleep(0.02)
        return False, None


def evaluar(motor, ruta_json: str, carpeta_videos: str | None = None) -> dict:
    with open(ruta_json, encoding="utf-8") as f:
        etiqueta = json.load(f)
    if carpeta_videos:
        ruta_video = os.path.join(carpeta_videos, os.path.basename(etiqueta["video"]))
    else:
        ruta_video = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(ruta_json)), etiqueta["video"]))
    camara = VideoGrabado(ruta_video)
    backend = motor._http

    # Estado limpio: sin memoria de la secuencia anterior
    motor._pipeline.clear_all_tracks()
    for registro in ("_placas_registradas", "_capturas_por_track", "_intentos_captura", "_vehiculos", "_horas_cuadro",
                     "_pistas_resueltas", "_placa_de_pista", "_pistas_activas", "_crudos_rapidos"):
        getattr(motor, registro).clear()
    for registro in ("_active_candidates", "_captured_history", "_prev_area", "_track_first_seen"):
        getattr(motor._selector, registro).clear()
    zonas = etiqueta.get("zonas") or {}
    motor._pipeline.set_roi(zonas.get("roi"))
    motor._pipeline.set_exclusiones(zonas.get("exclusiones") or [])
    from app.dominio.latencia import Cronometros
    for nombre in ("_lat_edad", "_lat_vivo", "_lat_registro"):
        getattr(motor, nombre)._valores.clear()
    motor._descartes._perdidos.clear()
    motor._tiempos = Cronometros()
    motor._pipeline.tiempos = Cronometros()

    # Capturas disparadas (pista → hora de captura de su mejor cuadro) y cuadros analizados
    capturas: dict[int, float] = {}
    original_disparar = motor.disparar_captura

    def disparar(candidato):
        hora = motor._horas_cuadro.get(getattr(candidato, "frame_idx", -1))
        if hora:
            capturas.setdefault(getattr(candidato, "tracking_id", -1), hora)
        return original_disparar(candidato)

    motor.disparar_captura = disparar
    analizados = [0]
    original_detectar = motor._pipeline.detect_and_track

    def detectar(frame, *a, **k):
        analizados[0] += 1
        return original_detectar(frame, *a, **k)

    motor._pipeline.detect_and_track = detectar

    # Pistas visibles en el HUD, muestreadas cada 0,1 s
    muestras: list[tuple[float, int]] = []
    fin_muestreo = threading.Event()

    def muestrear():
        while not fin_muestreo.is_set():
            muestras.append((time.time(), len(motor.pistas_actuales().get("pistas", []))))
            time.sleep(0.1)

    n_envios = len(backend.envios)
    hilo = threading.Thread(target=muestrear, daemon=True)
    hilo.start()
    motor._fuente = camara
    while not camara.terminada:
        time.sleep(0.05)
    motor._fuente = SinFuente()
    duracion_s = (max(camara.emitidos.values()) - min(camara.emitidos.values())) if camara.emitidos else 0.0
    time.sleep(ASENTAR_S)
    fin_muestreo.set()
    hilo.join(timeout=1)
    motor.disparar_captura = original_disparar
    motor._pipeline.detect_and_track = original_detectar

    t0 = camara.emitidos.get(1, time.time())
    envios = backend.envios[n_envios:]
    registros = []
    for t, url, datos in envios:
        if url.endswith("/detecciones/completar-ocr"):
            registros.append({"t": t, "ingreso_id": datos.get("ingreso_id"), "placa": (datos.get("placa_reconocida") or "").replace("-", "").upper(),
                              "valida": datos.get("lectura_valida")})
    # Reevaluaciones (segundo OCR o vehículo llegados después del registro): placa y veredicto finales
    por_ingreso = {r["ingreso_id"]: r for r in registros}
    for t, url, datos in envios:
        if url.endswith("/detecciones/reevaluar") and datos.get("ingreso_id") in por_ingreso:
            r = por_ingreso[datos["ingreso_id"]]
            r["t_final"] = t
            if isinstance(datos.get("lectura_valida"), bool):
                r["valida"] = datos["lectura_valida"]
            if datos.get("placa_reconocida"):
                r["placa"] = datos["placa_reconocida"].replace("-", "").upper()
    # El backend sustituto numera los ingresos en orden desde el arranque; el ingreso trae la pista
    pista_de_ingreso = {}
    k = 0
    for t, url, datos in backend.envios:
        if url.endswith("/detecciones/ingreso"):
            k += 1
            pista_de_ingreso[k] = datos.get("tracking_id")
    pasos = etiqueta["pasos"]
    asignados: dict[int, list[dict]] = defaultdict(list)
    sin_paso = []
    lat_registro, lat_final = [], []
    for r in registros:
        hora_cuadro = capturas.get(pista_de_ingreso.get(r["ingreso_id"]))
        if hora_cuadro:
            r["lat"] = r["t"] - hora_cuadro
            r["lat_final"] = r.get("t_final", r["t"]) - hora_cuadro
            lat_registro.append(r["lat"])
            lat_final.append(r["lat_final"])
        momento = (hora_cuadro or r["t"]) - t0
        candidatos = [i for i, p in enumerate(pasos) if p["inicio_s"] - TOLERANCIA_S <= momento <= p["fin_s"] + (TOLERANCIA_S if hora_cuadro else 12.0)]
        if candidatos:
            asignados[max(candidatos, key=lambda i: pasos[i]["inicio_s"])].append(r)
        else:
            sin_paso.append(r)

    detectados = []
    for p in pasos:
        a, b = t0 + p["inicio_s"], t0 + p["fin_s"]
        detectados.append(any(n > 0 for t, n in muestras if a <= t <= b))
    legibles = [i for i, p in enumerate(pasos) if p.get("legible", True)]
    correctos = [i for i in legibles if any(r["placa"] == pasos[i]["placa"].replace("-", "").upper() for r in asignados.get(i, []))]
    con_registro = [i for i in range(len(pasos)) if asignados.get(i)]
    exactos_registrados = [i for i in con_registro if asignados[i][0]["placa"] == pasos[i]["placa"].replace("-", "").upper()]
    duplicados = sum(len(asignados[i]) - 1 for i in con_registro)
    estado = motor.estado()
    return {
        "secuencia": etiqueta.get("secuencia", os.path.basename(ruta_json)),
        "particion": etiqueta.get("particion", "prueba"),
        "condiciones": etiqueta.get("condiciones", []),
        "duracion_s": round(duracion_s, 2),
        "pasos": len(pasos), "pasos_legibles": len(legibles),
        "cuadros_recibidos": len(camara.emitidos), "cuadros_analizados": analizados[0],
        "fps_recibidos": round(len(camara.emitidos) / duracion_s, 1) if duracion_s else None,
        "fps_analizados": round(analizados[0] / duracion_s, 1) if duracion_s else None,
        "detectados": sum(detectados), "registros": len(registros), "registros_sin_paso": len(sin_paso),
        "pasos_con_registro": len(con_registro), "transcripcion_exacta": len(exactos_registrados),
        "correctos": len(correctos), "duplicados": duplicados,
        "lat_vivo_s": list(motor._lat_vivo._valores), "lat_registro_s": lat_registro, "lat_final_s": lat_final,
        "reevaluados": sum(1 for r in registros if "t_final" in r),
        "registros_validos": sum(1 for r in registros if r["valida"] is True),
        "detalle_pasos": [
            {"placa": p["placa"], "detectado": detectados[i], "registros": [r["placa"] for r in asignados.get(i, [])],
             # Primer registro del paso: latencia captura → registro y veredicto del motor
             "lat_registro_s": round(asignados[i][0]["lat"], 3) if asignados.get(i) and "lat" in asignados[i][0] else None,
             # Hasta la última decisión del backend (registro o reevaluación)
             "lat_decision_s": round(asignados[i][0]["lat_final"], 3) if asignados.get(i) and "lat_final" in asignados[i][0] else None,
             "valida": asignados[i][0]["valida"] if asignados.get(i) else None}
            for i, p in enumerate(pasos)
        ],
        "registros_falsos": [r["placa"] for r in sin_paso],
        "latencia_motor": estado.get("latencia"),
        "etapas_ms": estado.get("etapas_ms"),
    }


def resumir(resultados: list[dict]) -> dict:
    """Métricas 1–10 agregadas sobre un conjunto de secuencias."""
    if not resultados:
        return {}
    s = lambda clave: sum(r[clave] for r in resultados)  # noqa: E731
    horas = s("duracion_s") / 3600.0
    vivo = [v for r in resultados for v in r["lat_vivo_s"]]
    registro = [v for r in resultados for v in r["lat_registro_s"]]
    return {
        "secuencias": len(resultados),
        "1_recall_deteccion_por_paso": wilson(s("detectados"), s("pasos")),
        "2_precision_registros": wilson(s("registros") - s("registros_sin_paso"), s("registros")),
        "3_falsas_detecciones_por_hora": poisson_por_hora(s("registros_sin_paso"), horas),
        "4_transcripcion_exacta_de_pasos_registrados": wilson(s("transcripcion_exacta"), s("pasos_con_registro")),
        "5_reconocimiento_exacto_punta_a_punta": wilson(s("correctos"), s("pasos_legibles")),
        "6_pasos_legibles_sin_lectura_correcta": wilson(s("pasos_legibles") - s("correctos"), s("pasos_legibles")),
        "7_duplicados_por_paso_registrado": round(s("duplicados") / s("pasos_con_registro"), 3) if s("pasos_con_registro") else None,
        "8_latencia_captura_a_lectura_en_vivo": percentiles(vivo),
        "9_latencia_captura_a_registro": percentiles(registro),
        "9b_latencia_captura_a_decision_final": percentiles([v for r in resultados for v in r.get("lat_final_s", [])]),
        "10_cuadros": {
            "fps_recibidos": round(s("cuadros_recibidos") / s("duracion_s"), 1) if s("duracion_s") else None,
            "fps_analizados": round(s("cuadros_analizados") / s("duracion_s"), 1) if s("duracion_s") else None,
            "descartados_pct": round(100 * (1 - s("cuadros_analizados") / s("cuadros_recibidos")), 1) if s("cuadros_recibidos") else None,
        },
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("etiquetas", nargs="+", help="JSON de cada secuencia")
    ap.add_argument("--videos", default=None, help="Carpeta de los videos (si no, la ruta relativa de cada JSON)")
    ap.add_argument("--salida", default=None)
    ap.add_argument("--sin-tope-verificador", action="store_true",
                    help="Ablación: esperar al verificador sin tope (comportamiento anterior al 2026-10-12)")
    ap.add_argument("--ventana-antiduplicados", type=float, default=None,
                    help="Solo para medir latencias en escenas que repiten la misma placa: ventana anti-duplicados del motor (s)")
    args = ap.parse_args()

    import dataclasses

    from app import main as composicion
    from app.aplicacion import motor as modulo_motor
    from app.infraestructura.config import TORCH_THREADS

    motor = composicion.motor
    if args.sin_tope_verificador:
        motor._config = dataclasses.replace(motor._config, espera_verificador_s=None)
    if args.ventana_antiduplicados is not None:
        modulo_motor.PLATE_DEBOUNCE_SECONDS = args.ventana_antiduplicados
    backend = BackendRegistrador()
    # La cámara real se reemplaza por los videos; arranca sin fuente hasta la primera secuencia
    motor._dep.crear_fuente_video = SinFuente
    motor._http = backend
    motor._dir_media = tempfile.mkdtemp(prefix="evaluacion_")
    motor.iniciar()
    motor._dep.verificador(), motor._dep.reconocedor_vehiculo()  # precarga de modelos

    resultados = []
    for ruta in args.etiquetas:
        r = evaluar(motor, ruta, args.videos)
        resultados.append(r)
        print(f"{r['secuencia']}: {r['correctos']}/{r['pasos_legibles']} pasos correctos, {r['registros']} registros "
              f"({r['registros_sin_paso']} sin paso, {r['duplicados']} duplicados), {r['fps_analizados']} fps analizados", flush=True)

    informe = {
        "configuracion": {"espera_verificador_s": motor._config.espera_verificador_s, "torch_threads": TORCH_THREADS,
                          "presupuesto_registro_s": motor._config.presupuesto_registro_s,
                          "ventana_antiduplicados_s": modulo_motor.PLATE_DEBOUNCE_SECONDS},
        "todas": resumir(resultados),
    }
    for particion in sorted({r["particion"] for r in resultados}):
        informe[f"particion:{particion}"] = resumir([r for r in resultados if r["particion"] == particion])
    for condicion in sorted({c for r in resultados for c in r["condiciones"]}):
        informe[f"condicion:{condicion}"] = resumir([r for r in resultados if condicion in r["condiciones"]])
    informe["secuencias"] = [{k: v for k, v in r.items() if k not in ("lat_vivo_s", "lat_registro_s", "lat_final_s")} for r in resultados]
    print(json.dumps(informe, ensure_ascii=False, indent=2))
    if args.salida:
        with open(args.salida, "w", encoding="utf-8") as f:
            json.dump(informe, f, ensure_ascii=False, indent=2)
    motor.detener()


if __name__ == "__main__":
    main()
