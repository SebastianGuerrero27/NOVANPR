"""
A/B pareado de las zonas de exclusión sobre video: la escena de la cámara Hikvision simulada
(1920×1080, vehículos reales que cruzan por la franja central) más un distractor que produce
movimiento falso, una hilera de árboles que se mece en la franja superior, por donde no pasan
vehículos. Los mismos cuadros pasan por el pipeline del motor (detector de producción, compuerta de
movimiento y recorte activos) en tres condiciones:

  A  sin zonas (como hasta ahora);
  B  con una zona de exclusión sobre los árboles;
  C  con la región de interés en el carril y la misma zona de exclusión.

Mide inferencias del detector, tiempo de proceso, cuadros con una pista de placa en el carril (los
vehículos reales: no debe bajar), cuadros con una pista falsa en la franja de los árboles y cuadros
en que el detector de movimiento (MOG2, con las mismas zonas) marca movimiento sin pista en el
carril.

Uso (desde services/anpr):
    python scripts/ab_exclusiones.py --video ../../backend/scripts/camara_hikvision_simulada/.trabajo/principal_h265.mp4
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.aplicacion.detector import DetectionPipeline, byte_track_thresholds  # noqa: E402
from app.aplicacion.movimiento import CompuertaInferencia, DetectorMovimiento  # noqa: E402
from app.infraestructura.detectors import YoloDetector  # noqa: E402

# Franja de los árboles (px de 1920×1080) y zonas normalizadas
ARBOLES = (1350, 10, 1890, 150)
EXCLUSION_ARBOLES = [[0.68, 0.0], [1.0, 0.0], [1.0, 0.16], [0.68, 0.16]]
CARRIL = [[0.0, 0.17], [1.0, 0.17], [1.0, 0.95], [0.0, 0.95]]


class Contado:
    """Detector de producción que cuenta sus inferencias."""

    def __init__(self, detector):
        self.detector, self.llamadas = detector, 0

    def __getattr__(self, nombre):
        return getattr(self.detector, nombre)

    def predict(self, frame):
        self.llamadas += 1
        return self.detector.predict(frame)


def con_arboles(cuadro: np.ndarray, i: int, follaje: np.ndarray) -> np.ndarray:
    """Agrega los árboles meciéndose: el follaje se desplaza ±30 px (ráfagas de ~1,5 s)."""
    x1, y1, x2, y2 = ARBOLES
    f = cuadro.copy()
    dx = int(30 * np.sin(2 * np.pi * i / 37.0) + 8 * np.sin(2 * np.pi * i / 11.0))
    ancho = x2 - x1
    f[y1:y2, x1:x2] = follaje[:, 40 + dx:40 + dx + ancho]
    return f


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", required=True)
    ap.add_argument("--modelo", default="models/license_plate_detector.pt")
    ap.add_argument("--salida", default="")
    a = ap.parse_args()

    cap = cv2.VideoCapture(a.video)
    cuadros = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        cuadros.append(f)
    # Follaje: manchas de hojas (~40 px) contra el cielo, de alto contraste como una copa real; una
    # textura fina desaparecería en el análisis a 320 px y no simularía el movimiento falso
    rng = np.random.default_rng(11)
    alto, ancho_follaje = ARBOLES[3] - ARBOLES[1], ARBOLES[2] - ARBOLES[0] + 80
    manchas = cv2.resize(rng.random((max(2, alto // 40), max(2, ancho_follaje // 40))).astype(np.float32),
                         (ancho_follaje, alto), interpolation=cv2.INTER_CUBIC)
    follaje = np.empty((alto, ancho_follaje, 3), np.uint8)
    follaje[:] = (225, 215, 200)                                  # cielo
    follaje[manchas > 0.5] = (40, 95, 45)                         # hojas
    escena = [con_arboles(f, i, follaje) for i, f in enumerate(cuadros)]

    _, crudo = byte_track_thresholds()
    base = YoloDetector(a.modelo, confidence=crudo, device="cpu", imgsz=512)
    base.predict(np.zeros((512, 512, 3), np.uint8))  # calentamiento

    condiciones = {"A_sin_zonas": (None, []), "B_exclusion_arboles": (None, [EXCLUSION_ARBOLES]),
                   "C_carril_y_exclusion": (CARRIL, [EXCLUSION_ARBOLES])}
    resultados = {}
    for nombre, (roi, exclusiones) in condiciones.items():
        det = Contado(base)
        p = DetectionPipeline(detector=det, compuerta=CompuertaInferencia(activa=True, umbral=0.002, max_omitidos=5), recorte_roi=True)
        p.set_roi(roi)
        p.set_exclusiones(exclusiones)
        carril: list[bool] = []
        falsas = 0
        t0 = time.perf_counter()
        for f in escena:
            centros = [((r.plate_bbox[0] + r.plate_bbox[2]) / 2, (r.plate_bbox[1] + r.plate_bbox[3]) / 2) for r in p.detect_and_track(f)]
            en_arboles = [ARBOLES[0] <= x <= ARBOLES[2] and y <= ARBOLES[3] + 20 for x, y in centros]
            carril.append(any(not a for a in en_arboles))
            falsas += any(en_arboles)
        total = time.perf_counter() - t0
        # Salida del detector de movimiento con las mismas zonas (fuera del tiempo medido)
        m = DetectorMovimiento()
        movimiento_sin_placa = sum(m.analizar(f, roi, exclusiones).caja is not None and not c for f, c in zip(escena, carril))
        resultados[nombre] = {
            "cuadros": len(escena), "inferencias": det.llamadas,
            "inferencias_pct": round(100 * det.llamadas / len(escena), 1),
            "segundos": round(total, 1), "ms_por_cuadro": round(1000 * total / len(escena), 1),
            "cuadros_con_placa_en_el_carril": sum(carril),
            "cuadros_con_placa_falsa_en_los_arboles": falsas,
            "cuadros_con_movimiento_sin_placa_en_el_carril": movimiento_sin_placa,
        }
        print(nombre, resultados[nombre], flush=True)
    print(json.dumps(resultados, ensure_ascii=False, indent=2))
    if a.salida:
        with open(a.salida, "w", encoding="utf-8") as fh:
            json.dump(resultados, fh, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
