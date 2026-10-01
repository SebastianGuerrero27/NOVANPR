"""
Afinamiento del detector de placas con placas ecuatorianas: YOLO26n o RF-DETR-nano.

Ambas arquitecturas se entrenan con el MISMO dataset (dataset/detector, generado por
scripts/annotate_plates.py con partición por grupo) para compararlas en la tesis con
scripts/evaluate_detectors.py.

  - YOLO26n (Ultralytics, 2026): sin NMS, optimizado para CPU y objetos pequeños.
  - RF-DETR-nano (Robinson et al., ICLR 2026): transformer con backbone DINOv2; se adapta
    mejor con pocos datos, pero es más lento en CPU.

El resultado se guarda como CANDIDATO; nunca reemplaza el modelo de producción salvo con
--promote y solo si supera al actual en el conjunto de validación (ver models/MODEL_CARD.md).

Uso (entorno de entrenamiento, desde services/anpr):
    .venv-train/Scripts/python scripts/train_plate_detector.py --arch yolo26n --epochs 80
    .venv-train/Scripts/python scripts/train_plate_detector.py --arch rfdetr-nano --epochs 30

    # Con el dataset público de Open Images (scripts/prepare_openimages_plates.py)
    python scripts/train_plate_detector.py --arch yolo26n --data ../../dataset/openimages_plates/data.yaml \
        --nombre openimages --epochs 30 --imgsz 512 --batch 16
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import time
from pathlib import Path

import cv2

BASE_DIR = Path(__file__).resolve().parent.parent.parent.parent
DATA_DIR = BASE_DIR / "dataset" / "detector"
DATA_YAML = DATA_DIR / "data.yaml"
MODELS_DIR = BASE_DIR / "services" / "anpr" / "models"
RUNS_DIR = BASE_DIR / "dataset" / "runs"
PROD_PT = MODELS_DIR / "license_plate_detector.pt"
ARCHIVE_DIR = MODELS_DIR / "archive"

# Por debajo de este número de imágenes de entrenamiento el resultado no tiene validez
# estadística para la tesis (solo sirve como prueba del pipeline con --force).
MIN_TRAIN_IMAGES = 200


def count_images(split: str) -> int:
    d = DATA_DIR / "images" / split
    return sum(1 for p in d.glob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png"}) if d.exists() else 0


# ---------------------------------------------------------------------------
# YOLO26n
# ---------------------------------------------------------------------------

def train_yolo(arch: str, epochs: int, imgsz: int, batch: int, device: str, seed: int = 0,
               nombre: str = "ecuador", workers: int = 4) -> Path:
    from ultralytics import YOLO

    weights = f"{arch}.pt"  # yolo26n.pt se descarga de los releases oficiales de Ultralytics
    model = YOLO(weights)
    model.train(
        data=str(DATA_YAML),
        workers=workers,
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        device=device,
        patience=max(10, epochs // 4),
        project=str(RUNS_DIR),
        name=f"{arch}_{nombre}_s{seed}",
        exist_ok=True,
        seed=seed,
        deterministic=True,
        # Aumentaciones pensadas para placas: sin volteo horizontal (invierte los caracteres)
        fliplr=0.0,
        flipud=0.0,
        degrees=8.0,
        perspective=0.0008,
        shear=3.0,
        scale=0.6,          # placas grandes (cerca) y pequeñas (lejos)
        mosaic=1.0,
        close_mosaic=max(5, epochs // 8),
        hsv_v=0.5,          # día / noche / contraluz
        plots=True,
        verbose=True,
    )
    best = RUNS_DIR / f"{arch}_{nombre}_s{seed}" / "weights" / "best.pt"
    dest = MODELS_DIR / (f"{arch}_{nombre}_candidato.pt" if seed == 0 else f"{arch}_{nombre}_s{seed}_candidato.pt")
    shutil.copy2(best, dest)
    return dest


# ---------------------------------------------------------------------------
# RF-DETR-nano (requiere formato COCO: se convierte desde las etiquetas YOLO)
# ---------------------------------------------------------------------------

def yolo_to_coco(coco_dir: Path) -> None:
    """Convierte dataset/detector (YOLO) a la estructura COCO que espera RF-DETR."""
    if coco_dir.exists():
        shutil.rmtree(coco_dir)
    for split, coco_split in (("train", "train"), ("val", "valid"), ("test", "test")):
        img_dir = DATA_DIR / "images" / split
        if not img_dir.exists():
            continue
        out = coco_dir / coco_split
        out.mkdir(parents=True)
        images, annotations = [], []
        ann_id = 1
        for img_id, img_path in enumerate(sorted(img_dir.glob("*")), start=1):
            if img_path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
                continue
            h, w = cv2.imread(str(img_path)).shape[:2]
            shutil.copy2(img_path, out / img_path.name)
            images.append({"id": img_id, "file_name": img_path.name, "width": w, "height": h})
            label = DATA_DIR / "labels" / split / f"{img_path.stem}.txt"
            for line in (label.read_text().splitlines() if label.exists() else []):
                _, cx, cy, bw, bh = map(float, line.split())
                x, y = (cx - bw / 2) * w, (cy - bh / 2) * h
                annotations.append({
                    "id": ann_id, "image_id": img_id, "category_id": 0,
                    "bbox": [x, y, bw * w, bh * h], "area": bw * w * bh * h, "iscrowd": 0,
                })
                ann_id += 1
        coco = {"images": images, "annotations": annotations,
                "categories": [{"id": 0, "name": "license_plate", "supercategory": "none"}]}
        (out / "_annotations.coco.json").write_text(json.dumps(coco), encoding="utf-8")


def train_rfdetr(epochs: int, batch: int, device: str, seed: int = 0) -> Path:
    from rfdetr import RFDETRNano

    coco_dir = BASE_DIR / "dataset" / "detector_coco"
    yolo_to_coco(coco_dir)
    out_dir = RUNS_DIR / f"rfdetr_nano_ecuador_s{seed}"
    model = RFDETRNano()  # descarga los pesos preentrenados COCO de RF-DETR-nano
    model.train(
        dataset_dir=str(coco_dir),
        epochs=epochs,
        batch_size=batch,
        grad_accum_steps=max(1, 16 // batch),
        lr=1e-4,
        output_dir=str(out_dir),
        device=device,
        seed=seed,
    )
    best = next((out_dir / n for n in ("checkpoint_best_total.pth", "checkpoint_best_ema.pth", "checkpoint_best_regular.pth")
                 if (out_dir / n).exists()), out_dir / "checkpoint.pth")
    dest = MODELS_DIR / ("rfdetr_nano_ecuador_candidato.pth" if seed == 0 else f"rfdetr_nano_ecuador_s{seed}_candidato.pth")
    shutil.copy2(best, dest)
    return dest


# ---------------------------------------------------------------------------

def promote(candidate: Path) -> None:
    """Reemplaza el detector de producción (solo modelos YOLO .pt) respaldando el anterior."""
    from ultralytics import YOLO

    cand = YOLO(str(candidate)).val(data=str(DATA_YAML), split="val", verbose=False, plots=False).box.map
    prod = YOLO(str(PROD_PT)).val(data=str(DATA_YAML), split="val", verbose=False, plots=False).box.map
    print(f"[+] mAP50-95 validación | producción: {prod:.4f} | candidato: {cand:.4f}")
    if cand <= prod:
        print("[!] El candidato no supera a producción. No se promueve.")
        return
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    backup = ARCHIVE_DIR / f"license_plate_detector_{time.strftime('%Y%m%d_%H%M%S')}.pt"
    shutil.copy2(PROD_PT, backup)
    shutil.copy2(candidate, PROD_PT)
    print(f"[OK] Promovido a producción. Respaldo: {backup}. Actualice models/MODEL_CARD.md.")


def main() -> None:
    global DATA_DIR, DATA_YAML
    ap = argparse.ArgumentParser(description="Afinar detector de placas ecuatorianas (YOLO26n / RF-DETR-nano).")
    ap.add_argument("--arch", default="yolo26n", choices=["yolo26n", "yolo11n", "yolov8n", "rfdetr-nano"])
    ap.add_argument("--epochs", type=int, default=80)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--device", default="0" if os.environ.get("CUDA_VISIBLE_DEVICES") else "cpu")
    ap.add_argument("--seed", type=int, default=0, help="Semilla (repetir con varias para el artículo)")
    ap.add_argument("--force", action="store_true", help=f"Entrenar con menos de {MIN_TRAIN_IMAGES} imágenes (solo pruebas)")
    ap.add_argument("--promote", action="store_true", help="Reemplazar producción si el candidato YOLO es mejor")
    ap.add_argument("--data", default=str(DATA_YAML), help="data.yaml del dataset (por omisión, el ecuatoriano)")
    ap.add_argument("--nombre", default="ecuador", help="Sufijo de la corrida y del candidato (p. ej. openimages)")
    ap.add_argument("--workers", type=int, default=4, help="Procesos del cargador de datos")
    args = ap.parse_args()

    DATA_YAML = Path(args.data).resolve()
    DATA_DIR = DATA_YAML.parent

    if not DATA_YAML.exists():
        raise SystemExit(f"No existe {DATA_YAML}. Ejecute primero scripts/annotate_plates.py")
    n_train = count_images("train")
    print(f"[+] Dataset: train={n_train} val={count_images('val')} test={count_images('test')}")
    if n_train < MIN_TRAIN_IMAGES and not args.force:
        raise SystemExit(f"[!] Solo {n_train} imágenes de entrenamiento (mínimo {MIN_TRAIN_IMAGES}). Use --force solo para pruebas.")

    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    if args.arch == "rfdetr-nano":
        cand = train_rfdetr(args.epochs, args.batch, args.device, args.seed)
    else:
        cand = train_yolo(args.arch, args.epochs, args.imgsz, args.batch, args.device, args.seed,
                          args.nombre, args.workers)
    print(f"[+] Candidato guardado: {cand}")
    print("    Compárelo con: scripts/evaluate_detectors.py")

    if args.promote and cand.suffix == ".pt":
        promote(cand)


if __name__ == "__main__":
    main()
