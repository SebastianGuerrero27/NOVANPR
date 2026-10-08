"""
Exactitud del OCR rápido y del verificador PP-OCRv6 según el desenfoque de movimiento horizontal
(docs/METODO_VERIFICACION_LECTURA.md §3.2).

Sobre cada captura etiquetada (scripts/escenas_compuerta.csv) se aplica un desenfoque horizontal
uniforme de L píxeles (la placa avanza L px durante la exposición) y se lee la placa con el OCR
rápido (fast-plate-ocr) y con el verificador. Sirve para fijar la exposición máxima de la cámara:
L ≈ velocidad de la placa en px/s × tiempo de exposición.

Uso (dentro del contenedor del servicio; las capturas están en media/):
    docker exec -w /app anpr-service python scripts/evaluar_desenfoque.py --salida /tmp/ocr_desenfoque.json
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import statistics
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.aplicacion.detector import create_detection_pipeline  # noqa: E402
from app.aplicacion.ocr_worker import AsyncOcrWorker  # noqa: E402
from app.dominio.ecuador_plate_validator import validate_ecuadorian_plate  # noqa: E402
from app.infraestructura.ocr_engine import create_ocr_engine  # noqa: E402
from app.infraestructura.ocr_verifier import get_verifier  # noqa: E402

LARGOS = (0, 3, 6, 9, 12, 16)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--etiquetas", default="scripts/escenas_compuerta.csv")
    ap.add_argument("--media", default="media")
    ap.add_argument("--salida", default=None)
    args = ap.parse_args()

    detector = create_detection_pipeline().detector
    agente = AsyncOcrWorker(create_ocr_engine(), on_ocr_completed=lambda *a, **k: None)._agent
    verificador = get_verifier()
    with open(args.etiquetas, encoding="utf-8") as f:
        escenas = list(csv.DictReader(f))

    filas = []
    for e in escenas:
        img = cv2.imread(os.path.join(args.media, e["archivo"]))
        dets = detector.predict(img) if img is not None else []
        if not dets:
            continue
        x1, y1, x2, y2 = [int(v) for v in max(dets, key=lambda d: d.confidence).bbox]
        for largo in LARGOS:
            f = img if largo < 2 else cv2.filter2D(img, -1, np.full((1, largo), 1.0 / largo, np.float32))
            rapido = (agente.process_image(f, [x1, y1, x2, y2], fast_mode=True).placa or "").replace("-", "")
            px, py = int((x2 - x1) * 0.10), int((y2 - y1) * 0.15)
            lectura = verificador.read(f[max(0, y1 - py):y2 + py, max(0, x1 - px):x2 + px]).plate if verificador else ""
            valida, formateada, _ = validate_ecuadorian_plate(lectura or "")
            filas.append({"archivo": e["archivo"], "placa": e["placa"], "ancho_placa_px": x2 - x1, "desenfoque_px": largo,
                          "ocr_rapido": rapido, "verificador": formateada.replace("-", "") if valida else ""})

    resumen = {}
    for largo in LARGOS:
        fs = [r for r in filas if r["desenfoque_px"] == largo]
        resumen[str(largo)] = {
            "placas": len(fs),
            "ocr_rapido_correctas": sum(r["ocr_rapido"] == r["placa"] for r in fs),
            "verificador_correctas": sum(r["verificador"] == r["placa"] for r in fs),
        }
    anchos = [r["ancho_placa_px"] for r in filas if r["desenfoque_px"] == 0]
    print("RESUMEN", json.dumps({"ancho_placa_mediano_px": statistics.median(anchos) if anchos else None, "por_desenfoque": resumen},
                                ensure_ascii=False), flush=True)
    if args.salida:
        with open(args.salida, "w", encoding="utf-8") as f:
            json.dump({"resumen": resumen, "detalle": filas}, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
