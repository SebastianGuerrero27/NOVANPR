"""
Evaluación de la compuerta de inferencia y de la lectura de placas completas
(docs/METODO_VERIFICACION_LECTURA.md §2.4 y §3.1).

Escena compuesta por captura etiquetada: la placa se recorta y se borra con inpainting para
obtener la escena vacía; luego la placa entra por el borde izquierdo, se detiene (vehículo en la
garita) y sale por el derecho, con escena vacía antes y después. Ruido gaussiano σ = 2 en todos
los cuadros. Variantes, con el mismo modelo y el mismo código de seguimiento:

  base       el detector se ejecuta en cada cuadro; el OCR lee cualquier caja de tamaño suficiente
  propuesta  compuerta de inferencia; el OCR no lee placas cortadas por el borde lateral

El OCR sigue la política del motor (≤ 3 lecturas ANT por track, un intento cada 3 cuadros).
Métricas por secuencia: inferencias del detector, ms por cuadro (escena vacía / con placa),
cuadro en que se detecta la placa y en que se ve su lectura, consenso con la placa detenida
(acierto contra la etiqueta), lecturas de placas con corte lateral y cuadros de escena vacía
con algún recuadro dibujado.

Uso (las capturas están en media/, fuera del control de versiones):
    docker exec -w /app anpr-service python scripts/evaluar_compuerta.py \\
        --etiquetas scripts/escenas_compuerta.csv --salida /tmp/compuerta_movimiento.json
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import statistics
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.aplicacion.detector import DetectionPipeline, create_detection_pipeline  # noqa: E402
from app.aplicacion.motor import leible  # noqa: E402
from app.aplicacion.movimiento import CompuertaInferencia  # noqa: E402
from app.aplicacion.ocr_worker import AsyncOcrWorker  # noqa: E402
from app.aplicacion.verificacion_placa import toca_borde_lateral  # noqa: E402
from app.infraestructura.ocr_engine import create_ocr_engine  # noqa: E402

FASES = [("vacia", 30), ("entra", 24), ("detenida", 30), ("sale", 18), ("vacia", 30)]
ESTADOS_FINALES = {"confirmada", "autorizado", "alerta", "no_reconocido", "pendiente_revision"}
VARIANTES = ("base", "propuesta")


class DetectorContado:
    """Envuelve el detector compartido y cuenta las inferencias de una variante."""

    def __init__(self, detector) -> None:
        self.detector, self.llamadas = detector, 0

    def predict(self, frame):
        self.llamadas += 1
        return self.detector.predict(frame)

    def warmup(self, *_):
        pass


def secuencia(img: np.ndarray, caja: list[int], semilla: int = 7):
    """Cuadros (fase, imagen) de la escena compuesta."""
    h, w = img.shape[:2]
    x1, y1, x2, y2 = caja
    mw, mh = int((x2 - x1) * 0.30), int((y2 - y1) * 0.60)
    rx1, ry1, rx2, ry2 = max(0, x1 - mw), max(0, y1 - mh), min(w, x2 + mw), min(h, y2 + mh)
    objeto = img[ry1:ry2, rx1:rx2].copy()
    mascara = np.zeros((h, w), np.uint8)
    mascara[ry1:ry2, rx1:rx2] = 255
    fondo = cv2.inpaint(img, mascara, 5, cv2.INPAINT_TELEA)
    ow = rx2 - rx1
    rng = np.random.default_rng(semilla)
    for fase, n in FASES:
        for k in range(n):
            x = {"vacia": None, "entra": int(-ow + (rx1 + ow) * (k + 1) / n), "detenida": rx1,
                 "sale": int(rx1 + (w - rx1) * (k + 1) / n)}[fase]
            f = fondo.copy()
            if x is not None:
                a, b = max(0, x), min(w, x + ow)
                if b > a:
                    f[ry1:ry2, a:b] = objeto[:, a - x:b - x]
            yield fase, np.clip(f.astype(np.float32) + rng.normal(0, 2, f.shape), 0, 255).astype(np.uint8)


def evaluar(variante: str, img: np.ndarray, caja: list[int], detector, agente) -> dict:
    contado = DetectorContado(detector)
    compuerta = CompuertaInferencia(activa=variante == "propuesta")
    p = DetectionPipeline(detector=contado, compuerta=compuerta)
    ultimo_ocr: dict[int, int] = {}
    ms = {"vacia": [], "placa": []}
    r = {"detecta": None, "lectura_visible": None, "consenso": None, "intentos_ocr": 0,
         "lecturas_corte_lateral": 0, "cuadros_vacios_con_recuadro": 0}
    for i, (fase, frame) in enumerate(secuencia(img, caja)):
        t0 = time.perf_counter()
        rois = p.detect_and_track(frame, imgsz=512)
        ms["vacia" if fase == "vacia" else "placa"].append((time.perf_counter() - t0) * 1000)
        for roi in rois:
            info = p.get_track_info(roi.tracking_id)
            bx1, by1, bx2, by2 = roi.plate_bbox
            puede = leible(roi.plate_bbox, frame, 16, 6) if variante == "propuesta" else (bx2 - bx1) >= 16 and (by2 - by1) >= 6
            if (info.get("lecturas", 0) < 3 and info.get("status") not in ESTADOS_FINALES and puede
                    and i - ultimo_ocr.get(roi.tracking_id, -99) >= 3):
                ultimo_ocr[roi.tracking_id] = i
                res = agente.process_image(frame, roi.plate_bbox, fast_mode=True)
                r["intentos_ocr"] += 1
                if res.placa:
                    r["lecturas_corte_lateral"] += toca_borde_lateral(roi.plate_bbox, frame.shape[1])
                    p.update_track_plate(roi.tracking_id, res.placa, res.confianza,
                                         "leida" if res.estado == "procesado" else "escaneando")
        with p._overlays_lock:
            recuadros = list(p._current_overlays)
        if fase == "vacia":
            r["cuadros_vacios_con_recuadro"] += bool(recuadros)
        elif rois and r["detecta"] is None:
            r["detecta"] = i
        if any(o.placa for o in recuadros) and r["lectura_visible"] is None:
            r["lectura_visible"] = i
        if fase == "detenida":
            placas = [x for x in (p.get_track_info(roi.tracking_id).get("plate") for roi in rois) if x]
            if placas:
                r["consenso"] = placas[0]
    r["inferencias"] = contado.llamadas
    r["ms_escena_vacia"] = round(statistics.mean(ms["vacia"]), 1)
    r["ms_con_placa"] = round(statistics.mean(ms["placa"]), 1)
    return r


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--etiquetas", default="scripts/escenas_compuerta.csv")
    ap.add_argument("--media", default="media")
    ap.add_argument("--salida", default=None, help="archivo JSON con el detalle y el resumen")
    args = ap.parse_args()

    base = create_detection_pipeline()
    agente = AsyncOcrWorker(create_ocr_engine(), on_ocr_completed=lambda *a, **k: None)._agent
    with open(args.etiquetas, encoding="utf-8") as f:
        escenas = list(csv.DictReader(f))

    detalle = []
    for escena in escenas:
        img = cv2.imread(os.path.join(args.media, escena["archivo"]))
        dets = base.detector.predict(img) if img is not None else []
        if not dets:
            print(json.dumps({"archivo": escena["archivo"], "omitida": "sin placa detectada en la captura"}), flush=True)
            continue
        caja = [int(v) for v in max(dets, key=lambda d: d.confidence).bbox]
        for variante in VARIANTES:
            r = evaluar(variante, img, caja, base.detector, agente)
            r.update(archivo=escena["archivo"], placa=escena["placa"], variante=variante, acierto=r["consenso"] == escena["placa"])
            detalle.append(r)
            print(json.dumps(r), flush=True)

    resumen = {}
    for variante in VARIANTES:
        rs = [x for x in detalle if x["variante"] == variante]
        resumen[variante] = {
            "secuencias": len(rs),
            "cuadros_por_secuencia": sum(n for _, n in FASES),
            "inferencias_por_secuencia": round(statistics.mean(x["inferencias"] for x in rs), 1),
            "ms_por_cuadro_escena_vacia": round(statistics.mean(x["ms_escena_vacia"] for x in rs), 1),
            "ms_por_cuadro_con_placa": round(statistics.mean(x["ms_con_placa"] for x in rs), 1),
            "aciertos": sum(x["acierto"] for x in rs),
            "lecturas_corte_lateral": sum(x["lecturas_corte_lateral"] for x in rs),
            "intentos_ocr": sum(x["intentos_ocr"] for x in rs),
            "cuadros_vacios_con_recuadro": sum(x["cuadros_vacios_con_recuadro"] for x in rs),
        }
    print("RESUMEN", json.dumps(resumen, ensure_ascii=False), flush=True)
    if args.salida:
        with open(args.salida, "w", encoding="utf-8") as f:
            json.dump({"fases": FASES, "resumen": resumen, "detalle": detalle}, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
