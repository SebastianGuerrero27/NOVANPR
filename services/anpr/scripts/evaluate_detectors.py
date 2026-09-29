"""
Comparación de detectores de placas sobre el conjunto de PRUEBA (dataset/detector, split test).

Métricas por modelo (misma implementación para YOLO y RF-DETR, para que la comparación sea justa):
  - Precisión, Recall y F1 con IoU >= 0.5 al umbral de confianza --conf
  - AP50 (área bajo la curva precisión-recall, interpolación de todos los puntos)
  - IoU medio de las detecciones correctas (qué tan ajustada queda la caja)
  - Detector + OCR: % de placas cuyo texto se lee exacto al recortar con la caja predicha
    (la métrica que importa para el control de acceso)
  - Latencia media por imagen en CPU

Uso (entorno de entrenamiento, desde services/anpr):
    .venv-train/Scripts/python scripts/evaluate_detectors.py \
        --models actual=models/license_plate_detector.pt \
                 yolo26n=models/yolo26n_ecuador_candidato.pt \
                 rfdetr=models/rfdetr_nano_ecuador_candidato.pth
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import time
from pathlib import Path

import cv2
import numpy as np

BASE_DIR = Path(__file__).resolve().parent.parent.parent.parent
DATA_DIR = BASE_DIR / "dataset" / "detector"
OCR_DIR = BASE_DIR / "dataset" / "ocr" / "real"


def iou(a, b) -> float:
    ix1, iy1, ix2, iy2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def load_split(split: str):
    items = []
    for img_path in sorted((DATA_DIR / "images" / split).glob("*")):
        if img_path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            continue
        img = cv2.imread(str(img_path))
        h, w = img.shape[:2]
        gts = []
        label = DATA_DIR / "labels" / split / f"{img_path.stem}.txt"
        for line in (label.read_text().splitlines() if label.exists() else []):
            _, cx, cy, bw, bh = map(float, line.split())
            gts.append([(cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h])
        items.append((img_path.stem, img, gts))
    texts = {}
    csv_path = OCR_DIR / f"{split}.csv"
    if csv_path.exists():
        for r in csv.DictReader(open(csv_path, encoding="utf-8")):
            texts[Path(r["image_path"]).stem] = r["plate_text"]
    return items, texts


def make_predictor(path: str, conf: float, imgsz: int):
    if path.endswith(".pth"):
        from rfdetr import RFDETRNano
        model = RFDETRNano(pretrain_weights=path)
        try:
            model.optimize_for_inference()
        except Exception:
            pass

        def run(img):
            d = model.predict(img[:, :, ::-1].copy(), threshold=0.01)
            return [(list(map(float, b)), float(c)) for b, c in zip(d.xyxy, d.confidence)]
        return run

    from ultralytics import YOLO
    model = YOLO(path)

    def run(img):
        r = model.predict(img, conf=0.01, imgsz=imgsz, verbose=False, device="cpu")[0]
        return [(list(map(float, b)), float(c)) for b, c in zip(r.boxes.xyxy.cpu().numpy(), r.boxes.conf.cpu().numpy())]
    return run


def average_precision(scored: list[tuple[float, bool]], n_gt: int) -> float:
    if n_gt == 0:
        return 0.0
    scored.sort(key=lambda x: -x[0])
    tp = np.cumsum([s[1] for s in scored])
    fp = np.cumsum([not s[1] for s in scored])
    rec = tp / n_gt
    prec = tp / np.maximum(tp + fp, 1e-9)
    mrec = np.concatenate([[0], rec, [1]])
    mpre = np.concatenate([[1], prec, [0]])
    for i in range(len(mpre) - 2, -1, -1):
        mpre[i] = max(mpre[i], mpre[i + 1])
    idx = np.where(mrec[1:] != mrec[:-1])[0]
    return float(np.sum((mrec[idx + 1] - mrec[idx]) * mpre[idx + 1]))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", required=True, help="nombre=ruta (.pt YOLO o .pth RF-DETR)")
    ap.add_argument("--split", default="test")
    ap.add_argument("--conf", type=float, default=0.35)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--ocr-model", default="cct-s-v2-global-model")
    ap.add_argument("--out", default=str(BASE_DIR / "dataset" / "resultados_detectores.json"))
    ap.add_argument("--save-preds", default="", help="Carpeta para predicciones detector+OCR por imagen (para McNemar)")
    args = ap.parse_args()

    from fast_plate_ocr import LicensePlateRecognizer
    ocr = LicensePlateRecognizer(hub_ocr_model=args.ocr_model, device="cpu")

    items, texts = load_split(args.split)
    n_gt = sum(len(g) for _, _, g in items)
    print(f"Split '{args.split}': {len(items)} imágenes, {n_gt} placas etiquetadas, {len(texts)} con texto\n")
    header = f"{'modelo':22s} {'Prec':>6s} {'Recall':>7s} {'F1':>6s} {'AP50':>6s} {'IoU':>5s} {'Det+OCR':>8s} {'ms':>6s}"
    print(header)
    results = {}
    for spec in args.models:
        name, path = spec.split("=", 1)
        run = make_predictor(path, args.conf, args.imgsz)
        run(items[0][1])  # calentamiento
        scored, tp, fp, ious, ocr_ok, t_total = [], 0, 0, [], 0, 0.0
        per_image = []
        for stem, img, gts in items:
            t0 = time.perf_counter()
            preds = run(img)
            t_total += time.perf_counter() - t0
            used = set()
            for box, c in sorted(preds, key=lambda p: -p[1]):
                best_j, best_iou = -1, 0.0
                for j, g in enumerate(gts):
                    v = iou(box, g)
                    if j not in used and v > best_iou:
                        best_j, best_iou = j, v
                hit = best_iou >= 0.5
                if hit:
                    used.add(best_j)
                scored.append((c, hit))
                if c >= args.conf:
                    tp += hit
                    fp += not hit
                    if hit:
                        ious.append(best_iou)
            # Detector + OCR: recorte de la detección más confiable y lectura exacta
            if stem in texts:
                confident = [p for p in preds if p[1] >= args.conf]
                read = ""
                if confident:
                    (x1, y1, x2, y2), _ = max(confident, key=lambda p: p[1])
                    crop = img[max(0, int(y1)):int(y2), max(0, int(x1)):int(x2)]
                    if crop.size:
                        pred = ocr.run(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))[0].plate
                        read = re.sub(r"[^A-Z0-9]", "", pred.upper())
                        ocr_ok += read == texts[stem]
                per_image.append((stem, texts[stem], read))
        prec = tp / max(1, tp + fp)
        rec = tp / max(1, n_gt)
        f1 = 2 * prec * rec / max(1e-9, prec + rec)
        ap50 = average_precision(scored, n_gt)
        r = {
            "precision": prec, "recall": rec, "f1": f1, "ap50": ap50,
            "iou_medio": float(np.mean(ious)) if ious else 0.0,
            "detector_ocr_exacto": ocr_ok / max(1, len(texts)),
            "ms_por_imagen": t_total / len(items) * 1000, "ruta": path,
        }
        results[name] = r
        if args.save_preds:
            Path(args.save_preds).mkdir(parents=True, exist_ok=True)
            with open(Path(args.save_preds) / f"preds_det_{name}.csv", "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(["id", "gt", "pred"])
                w.writerows(per_image)
        print(f"{name:22s} {prec:6.1%} {rec:7.1%} {f1:6.3f} {ap50:6.3f} {r['iou_medio']:5.2f} "
              f"{r['detector_ocr_exacto']:8.1%} {r['ms_por_imagen']:6.0f}", flush=True)
    Path(args.out).write_text(json.dumps({"split": args.split, "conf": args.conf, "resultados": results}, indent=2), encoding="utf-8")
    print(f"\nResultados guardados en {args.out}")


if __name__ == "__main__":
    main()
