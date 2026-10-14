"""
Costo y beneficio de exigir más evidencia de placa antes de registrar un paso, en la prueba de Open
Images (placas etiquetadas): para cada umbral de confianza del detector y para la regla "la placa
está sobre un vehículo detectado" (YOLO26n COCO: auto, moto, bus, camión), cuántas placas reales se
conservan (IoU ≥ 0,5) y cuántas detecciones sin placa real quedan.

Uso (desde services/anpr):
    .venv/Scripts/python scripts/evaluar_evidencia_placa.py --data-dir ../../dataset/openimages_plates \\
        --salida ../../docs/resultados/evidencia_placa_openimages.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import cv2

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ab_recorte_roi import cajas_reales, iou  # noqa: E402
from app.infraestructura.detectors import YoloDetector  # noqa: E402
from app.infraestructura.vehicle_attributes import _COCO_VEHICULOS, vehicle_box_for_plate  # noqa: E402

UMBRALES = (0.22, 0.3, 0.4, 0.5, 0.6)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--split", default="test")
    ap.add_argument("--modelo", default="models/license_plate_detector.pt")
    ap.add_argument("--vehiculos", default="yolo26n.pt")
    ap.add_argument("--limite", type=int, default=0)
    ap.add_argument("--salida", default="")
    a = ap.parse_args()

    from ultralytics import YOLO

    detector = YoloDetector(a.modelo, confidence=0.05, device="cpu", imgsz=512)
    vehiculos = YOLO(a.vehiculos)
    imagenes = sorted((Path(a.data_dir) / "images" / a.split).glob("*.jpg"))
    if a.limite:
        imagenes = imagenes[: a.limite]

    placas = []        # por placa real: mejor confianza de una detección que la cubre y si está sobre un vehículo
    falsas = []        # por detección sin placa real: confianza y si está sobre un vehículo
    for k, ruta in enumerate(imagenes, 1):
        img = cv2.imread(str(ruta))
        if img is None:
            continue
        alto, ancho = img.shape[:2]
        reales = cajas_reales(Path(a.data_dir) / "labels" / a.split / (ruta.stem + ".txt"), ancho, alto)
        res = vehiculos.predict(img, conf=0.3, classes=list(_COCO_VEHICULOS), verbose=False, device="cpu")[0]
        cajas_v = [(b.tolist(), int(c), float(s)) for b, c, s in zip(res.boxes.xyxy, res.boxes.cls, res.boxes.conf)] if res.boxes is not None else []
        dets = [(float(d.confidence), [float(v) for v in d.bbox]) for d in detector.predict(img) if d.confidence >= UMBRALES[0]]
        usadas = set()
        for r in reales:
            mejor = None
            for j, (c, b) in enumerate(dets):
                if iou(r, b) >= 0.5 and (mejor is None or c > dets[mejor][0]):
                    mejor = j
            if mejor is not None:
                usadas.add(mejor)
            c, b = dets[mejor] if mejor is not None else (0.0, r)
            placas.append({"conf": c, "en_vehiculo": vehicle_box_for_plate(cajas_v, [int(v) for v in b]) is not None})
        for j, (c, b) in enumerate(dets):
            if j not in usadas and not any(iou(r, b) >= 0.5 for r in reales):
                falsas.append({"conf": c, "en_vehiculo": vehicle_box_for_plate(cajas_v, [int(v) for v in b]) is not None})
        if k % 200 == 0:
            print(f"{k}/{len(imagenes)}", flush=True)

    n = len(placas)
    filas = []
    for t in UMBRALES:
        for exige_vehiculo in (False, True):
            ok = sum(p["conf"] >= t and (p["en_vehiculo"] or not exige_vehiculo) for p in placas)
            fp = sum(f["conf"] >= t and (f["en_vehiculo"] or not exige_vehiculo) for f in falsas)
            filas.append({"umbral": t, "exige_vehiculo": exige_vehiculo, "placas_conservadas": ok, "recall": round(ok / n, 4),
                          "detecciones_sin_placa": fp})
    resultado = {"imagenes": len(imagenes), "placas_reales": n, "filas": filas}
    for f in filas:
        print(f"umbral {f['umbral']:.2f} vehículo={'sí' if f['exige_vehiculo'] else 'no'}: "
              f"placas {f['placas_conservadas']}/{n} ({f['recall']:.1%}), detecciones sin placa {f['detecciones_sin_placa']}")
    if a.salida:
        with open(a.salida, "w", encoding="utf-8") as fh:
            json.dump(resultado, fh, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
