"""
Prueba de McNemar por placa entre dos detectores (detectada / no detectada con IoU >= 0.5).

Complementa scripts/evaluate_detectors.py en datasets sin textos de OCR (p. ej. Open Images): cada
placa etiquetada es un par de observaciones; solo cuentan las discordantes (b: la detecta A y no B;
c: la detecta B y no A). Estadístico con corrección de continuidad: (|b − c| − 1)² / (b + c).

Uso (desde services/anpr):
    python scripts/mcnemar_detectores.py --data-dir ../../dataset/openimages_plates --conf 0.22 --imgsz 512 \
        --a produccion=models/license_plate_detector.pt --b candidato=models/yolo26n_ecuador_candidato.pt
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2


def iou(a, b) -> float:
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def cajas_reales(etiqueta: Path, ancho: int, alto: int) -> list[tuple[float, float, float, float]]:
    cajas = []
    for linea in etiqueta.read_text(encoding="utf-8").split("\n"):
        partes = linea.split()
        if len(partes) == 5:
            cx, cy, w, h = (float(v) for v in partes[1:])
            cajas.append(((cx - w / 2) * ancho, (cy - h / 2) * alto, (cx + w / 2) * ancho, (cy + h / 2) * alto))
    return cajas


def detectadas(modelo, img, reales, conf: float, imgsz: int) -> list[bool]:
    """Placa a placa: True si alguna predicción (asignación voraz por IoU) la cubre con IoU >= 0.5."""
    r = modelo.predict(img, conf=conf, imgsz=imgsz, verbose=False)[0]
    preds = sorted(((float(c), [float(v) for v in b]) for b, c in zip(r.boxes.xyxy.tolist(), r.boxes.conf.tolist())), reverse=True)
    usadas, resultado = set(), [False] * len(reales)
    for _, p in preds:
        mejor, idx = 0.5, None
        for i, g in enumerate(reales):
            if i not in usadas and (v := iou(p, g)) >= mejor:
                mejor, idx = v, i
        if idx is not None:
            usadas.add(idx)
            resultado[idx] = True
    return resultado


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--split", default="test")
    ap.add_argument("--conf", type=float, default=0.22)
    ap.add_argument("--imgsz", type=int, default=512)
    ap.add_argument("--a", required=True, help="nombre=ruta del detector A")
    ap.add_argument("--b", required=True, help="nombre=ruta del detector B")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    from ultralytics import YOLO

    (na, ra), (nb, rb) = (x.split("=", 1) for x in (args.a, args.b))
    ma, mb = YOLO(ra), YOLO(rb)
    base = Path(args.data_dir)
    n11 = n10 = n01 = n00 = 0
    for img_path in sorted((base / "images" / args.split).glob("*.jpg")):
        img = cv2.imread(str(img_path))
        reales = cajas_reales(base / "labels" / args.split / f"{img_path.stem}.txt", img.shape[1], img.shape[0])
        for da, db in zip(detectadas(ma, img, reales, args.conf, args.imgsz), detectadas(mb, img, reales, args.conf, args.imgsz)):
            n11 += da and db
            n10 += da and not db
            n01 += db and not da
            n00 += not da and not db
    b, c = n10, n01
    chi2 = (abs(b - c) - 1) ** 2 / (b + c) if b + c else 0.0
    # p bilateral de chi² con 1 gl: erfc(sqrt(chi2 / 2))
    p = math.erfc(math.sqrt(chi2 / 2)) if chi2 > 0 else 1.0
    total = n11 + n10 + n01 + n00
    resultado = {
        "dataset": str(base), "split": args.split, "conf": args.conf, "imgsz": args.imgsz, "placas": total,
        f"recall_{na}": round((n11 + n10) / total, 4), f"recall_{nb}": round((n11 + n01) / total, 4),
        "ambos": n11, f"solo_{na}": b, f"solo_{nb}": c, "ninguno": n00, "chi2": round(chi2, 1), "p": p,
    }
    print(json.dumps(resultado, ensure_ascii=False, indent=1))
    if args.out:
        Path(args.out).write_text(json.dumps(resultado, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
