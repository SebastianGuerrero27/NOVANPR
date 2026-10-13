"""
A/B pareado: detector sobre el cuadro completo (A) frente a detector sobre el recorte de la región
de interés (B), con la misma función que usa el motor (ventana_inferencia) y el mismo detector,
umbral y resolución de producción.

Cada imagen de la prueba de Open Images simula una cámara a la que el administrador le dibujó la
región de interés alrededor del carril: un rectángulo que contiene todas las placas etiquetadas,
ampliado hasta ocupar al menos --fraccion del ancho y del alto (centrado en ellas). En ambas
condiciones se descartan las detecciones con el centro fuera de la región, como hace el motor. Por
placa: detectada (IoU >= 0.5 con una detección >= --conf) o no; McNemar sobre los pares
discordantes, recall por tamaño de placa, falsos positivos dentro de la región y tiempo de
inferencia (el orden A/B se alterna por imagen para no favorecer a ninguna condición).

Uso (desde services/anpr):
    python scripts/ab_recorte_roi.py --data-dir ../../dataset/openimages_plates --fraccion 0.5 \
        --salida ../../docs/resultados/recorte_roi.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.aplicacion.detector import ventana_inferencia  # noqa: E402
from app.aplicacion.verificacion_placa import punto_en_roi  # noqa: E402
from app.infraestructura.detectors import YoloDetector  # noqa: E402


def iou(a, b) -> float:
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def cajas_reales(etiqueta: Path, ancho: int, alto: int) -> list[list[float]]:
    cajas = []
    for linea in etiqueta.read_text(encoding="utf-8").split("\n"):
        partes = linea.split()
        if len(partes) == 5:
            cx, cy, w, h = (float(v) for v in partes[1:])
            cajas.append([(cx - w / 2) * ancho, (cy - h / 2) * alto, (cx + w / 2) * ancho, (cy + h / 2) * alto])
    return cajas


def region_simulada(reales: list[list[float]], ancho: int, alto: int, fraccion: float) -> list[list[float]]:
    """Rectángulo normalizado que contiene las placas, de al menos `fraccion` del cuadro por lado."""
    x1, y1 = min(b[0] for b in reales), min(b[1] for b in reales)
    x2, y2 = max(b[2] for b in reales), max(b[3] for b in reales)
    w, h = max(x2 - x1, fraccion * ancho), max(y2 - y1, fraccion * alto)
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    rx1 = min(max(0.0, cx - w / 2), max(0.0, ancho - w))
    ry1 = min(max(0.0, cy - h / 2), max(0.0, alto - h))
    rx2, ry2 = min(float(ancho), rx1 + w), min(float(alto), ry1 + h)
    return [[rx1 / ancho, ry1 / alto], [rx2 / ancho, ry1 / alto], [rx2 / ancho, ry2 / alto], [rx1 / ancho, ry2 / alto]]


def detectar(detector: YoloDetector, img: np.ndarray, ventana, roi_px: np.ndarray, conf: float):
    """Cajas (px de la imagen) con confianza >= conf y centro dentro de la región, y ms de inferencia."""
    ox, oy = (ventana[0], ventana[1]) if ventana else (0, 0)
    entrada = np.ascontiguousarray(img[ventana[1]:ventana[3], ventana[0]:ventana[2]]) if ventana else img
    t0 = time.perf_counter()
    dets = detector.predict(entrada)
    ms = (time.perf_counter() - t0) * 1000
    cajas = []
    for d in dets:
        b = [d.bbox[0] + ox, d.bbox[1] + oy, d.bbox[2] + ox, d.bbox[3] + oy]
        if d.confidence >= conf and punto_en_roi((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, roi_px):
            cajas.append((d.confidence, b))
    return sorted(cajas, reverse=True), ms


def emparejar(preds, reales) -> tuple[list[bool], int]:
    """Por placa real, ¿alguna predicción la cubre con IoU >= 0.5? (voraz) y cuántas predicciones sobran."""
    usadas, resultado, sobrantes = set(), [False] * len(reales), 0
    for _, p in preds:
        mejor, idx = 0.5, None
        for i, g in enumerate(reales):
            if i not in usadas and (v := iou(p, g)) >= mejor:
                mejor, idx = v, i
        if idx is None:
            sobrantes += 1
        else:
            usadas.add(idx)
            resultado[idx] = True
    return resultado, sobrantes


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--split", default="test")
    ap.add_argument("--modelo", default="models/license_plate_detector.pt")
    ap.add_argument("--conf", type=float, default=0.22, help="Umbral con el que una detección crea pista en el motor")
    ap.add_argument("--imgsz", type=int, default=512)
    ap.add_argument("--fraccion", type=float, default=0.5)
    ap.add_argument("--limite", type=int, default=0, help="Máximo de imágenes (0 = todas)")
    ap.add_argument("--salida", default="")
    a = ap.parse_args()

    detector = YoloDetector(a.modelo, confidence=min(0.05, a.conf), device="cpu", imgsz=a.imgsz)
    detector.predict(np.zeros((a.imgsz, a.imgsz, 3), np.uint8))  # calentamiento

    imagenes = sorted((Path(a.data_dir) / "images" / a.split).glob("*.jpg"))
    if a.limite:
        imagenes = imagenes[: a.limite]
    placas = []          # (ancho relativo, detectada A, detectada B, recortada)
    fp = {"A": 0, "B": 0}
    tiempos = {"A": [], "B": []}
    recortadas = 0
    for n, ruta in enumerate(imagenes):
        img = cv2.imread(str(ruta))
        etiqueta = Path(a.data_dir) / "labels" / a.split / (ruta.stem + ".txt")
        if img is None or not etiqueta.exists():
            continue
        alto, ancho = img.shape[:2]
        reales = cajas_reales(etiqueta, ancho, alto)
        if not reales:
            continue
        roi = region_simulada(reales, ancho, alto, a.fraccion)
        roi_px = np.array([[p[0] * ancho, p[1] * alto] for p in roi], np.float32)
        ventana = ventana_inferencia(roi, ancho, alto)
        recortadas += ventana is not None
        orden = ("A", "B") if n % 2 == 0 else ("B", "A")
        res = {}
        for cond in orden:
            res[cond] = detectar(detector, img, ventana if cond == "B" else None, roi_px, a.conf)
        det_a, sob_a = emparejar(res["A"][0], reales)
        det_b, sob_b = emparejar(res["B"][0], reales)
        fp["A"] += sob_a
        fp["B"] += sob_b
        tiempos["A"].append(res["A"][1])
        tiempos["B"].append(res["B"][1])
        for g, da, db in zip(reales, det_a, det_b):
            placas.append(((g[2] - g[0]) / ancho, da, db, ventana is not None))
        if (n + 1) % 200 == 0:
            print(f"{n + 1}/{len(imagenes)} imágenes", flush=True)

    def resumen(filas):
        total = len(filas)
        a_ok = sum(f[1] for f in filas)
        b_ok = sum(f[2] for f in filas)
        b = sum(1 for f in filas if f[1] and not f[2])   # A sí, B no
        c = sum(1 for f in filas if f[2] and not f[1])   # B sí, A no
        chi2 = (abs(b - c) - 1) ** 2 / (b + c) if b + c else 0.0
        # p de la chi-cuadrado con 1 g.l. (aproximación exacta con erfc)
        p = math.erfc(math.sqrt(chi2 / 2)) if b + c else 1.0
        return {"placas": total, "recall_A": round(a_ok / total, 4) if total else None,
                "recall_B": round(b_ok / total, 4) if total else None,
                "solo_A": b, "solo_B": c, "mcnemar_chi2": round(chi2, 2), "p": round(p, 6)}

    tamanos = {"pequeña (<3 % del ancho)": lambda r: r < 0.03, "mediana (3–8 %)": lambda r: 0.03 <= r < 0.08,
               "grande (>=8 %)": lambda r: r >= 0.08}
    resultado = {
        "modelo": a.modelo, "conf": a.conf, "imgsz": a.imgsz, "fraccion_region": a.fraccion,
        "imagenes": len(tiempos["A"]), "imagenes_con_recorte": recortadas,
        "todas": resumen(placas),
        "solo_imagenes_con_recorte": resumen([f for f in placas if f[3]]),
        "por_tamano": {k: resumen([f for f in placas if cond(f[0])]) for k, cond in tamanos.items()},
        "falsos_positivos_en_region": fp,
        "ms_inferencia_mediana": {k: round(statistics.median(v), 1) for k, v in tiempos.items() if v},
        "ms_inferencia_media": {k: round(statistics.fmean(v), 1) for k, v in tiempos.items() if v},
    }
    print(json.dumps(resultado, ensure_ascii=False, indent=2))
    if a.salida:
        Path(a.salida).write_text(json.dumps(resultado, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
