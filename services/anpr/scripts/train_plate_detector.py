"""
Afinamiento del detector de placas con placas ecuatorianas: YOLO26n o RF-DETR-nano.

El dataset por omisión es dataset/detector_ecuatorianas, preparado sin alterar las
fuentes con scripts/prepare_plate_dataset.py. --data permite elegir otro dataset;
para comparaciones de arquitecturas se debe usar la misma partición.

  - YOLO26n (Ultralytics, 2026): sin NMS, optimizado para CPU y objetos pequeños.
  - RF-DETR-nano (Robinson et al., ICLR 2026): transformer con backbone DINOv2; se adapta
    mejor con pocos datos, pero es más lento en CPU.

El resultado se guarda como CANDIDATO; nunca reemplaza el modelo de producción salvo con
--promote y solo si supera al actual en el conjunto de validación (ver models/MODEL_CARD.md).

Uso (entorno de entrenamiento, desde services/anpr):
    python scripts/train_plate_detector.py --weights models/license_plate_detector.pt --epochs 30 --export-onnx
    python scripts/train_plate_detector.py --data ../../dataset/detector/data.yaml --arch rfdetr-nano --epochs 30

    # Con el dataset público de Open Images (scripts/prepare_openimages_plates.py)
    python scripts/train_plate_detector.py --arch yolo26n --data ../../dataset/openimages_plates/data.yaml \
        --nombre openimages --epochs 30 --imgsz 512 --batch 16
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import time
from pathlib import Path

import cv2
import yaml

BASE_DIR = Path(__file__).resolve().parent.parent.parent.parent
DATA_DIR = BASE_DIR / "dataset" / "detector_ecuatorianas"
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


def validate_dataset(data_yaml: Path) -> dict:
    """Falla ante rutas equivocadas, etiquetas pose o cajas fuera de la imagen."""
    data_yaml = data_yaml.resolve()
    config = yaml.safe_load(data_yaml.read_text(encoding="utf-8"))
    if not isinstance(config, dict) or "kpt_shape" in config:
        raise ValueError("El detector requiere YOLO detection (5 columnas), no pose. Ejecute prepare_plate_dataset.py.")
    names = config.get("names")
    if names not in ({0: "license_plate"}, ["license_plate"]):
        raise ValueError("Se requiere una sola clase 0: license_plate.")
    # Ultralytics no interpreta `path: .` respecto del YAML. Omitirlo es portable;
    # admitirlo aqui validaria una carpeta distinta a la que realmente entrena.
    root = Path(config.get("path") or data_yaml.parent)
    if not root.is_absolute():
        raise ValueError("Omita 'path' para un YAML portable o use una ruta absoluta; Ultralytics no resuelve 'path' relativo al YAML.")
    root = root.resolve()
    counts = {}
    seen = {}
    digest = hashlib.sha256()
    for split in ("train", "val", "test"):
        if split not in config:
            continue
        value = config[split]
        if not isinstance(value, str):
            raise ValueError(f"{split}: use una carpeta de imágenes en el YAML.")
        image_dir = (root / value).resolve()
        if not image_dir.is_dir():
            raise ValueError(f"Carpeta inexistente: {image_dir}")
        if "images" not in image_dir.parts:
            raise ValueError(f"La carpeta debe seguir images/<split>: {image_dir}")
        parts = list(image_dir.parts)
        parts[len(parts) - 1 - parts[::-1].index("images")] = "labels"
        label_dir = Path(*parts)
        images = sorted(p for p in image_dir.rglob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".bmp"})
        if not images:
            raise ValueError(f"Split vacío: {split}")
        print(f"[validación] {split}: comprobando {len(images)} imágenes y etiquetas...", flush=True)
        boxes = 0
        for index, image in enumerate(images, 1):
            label = label_dir / image.relative_to(image_dir).with_suffix(".txt")
            if not label.is_file():
                raise ValueError(f"Falta etiqueta: {label}")
            text = label.read_text(encoding="utf-8")
            for line in text.splitlines():
                if not line.strip():
                    continue
                values = line.split()
                if len(values) != 5:
                    raise ValueError(f"{label}: se requieren 5 columnas, recibidas {len(values)}.")
                cls, cx, cy, bw, bh = map(float, values)
                if cls != 0 or not all(math.isfinite(v) for v in (cx, cy, bw, bh)) or not (0 < bw <= 1 and 0 < bh <= 1):
                    raise ValueError(f"Clase o caja inválida: {label}")
                if not (-1e-5 <= cx - bw / 2 <= cx + bw / 2 <= 1.00001 and -1e-5 <= cy - bh / 2 <= cy + bh / 2 <= 1.00001):
                    raise ValueError(f"Caja fuera de la imagen: {label}")
                boxes += 1
            image_hash = hashlib.sha256(image.read_bytes()).hexdigest()
            if image_hash in seen and seen[image_hash] != split:
                raise ValueError(f"Imagen duplicada entre {split} y {seen[image_hash]}: {image}")
            seen[image_hash] = split
            digest.update(f"{split}/{image.relative_to(image_dir).as_posix()}:{image_hash}:{text}".encode())
            if index % 1000 == 0:
                print(f"[validación] {split}: {index}/{len(images)}", flush=True)
        counts[split] = {"images": len(images), "boxes": boxes}
    if not all(s in counts for s in ("train", "val")):
        raise ValueError("Se requieren particiones train y val.")
    return {"yaml": str(data_yaml), "root": str(root), "splits": counts, "sha256": digest.hexdigest()}


# ---------------------------------------------------------------------------
# YOLO26n
# ---------------------------------------------------------------------------

def train_yolo(arch: str, epochs: int, imgsz: int, batch: int, device: str, seed: int = 0,
               nombre: str = "ecuador", workers: int = 4, weights: str | None = None,
               resume: str | None = None, patience: int = 10, lr0: float = 0.0001,
               freeze: int = 0, multi_scale: float = 0.25) -> Path:
    from ultralytics import YOLO

    model = YOLO(resume or weights or f"{arch}.pt")
    if model.task != "detect":
        raise ValueError(f"Los pesos son de tarea {model.task}; se requiere detect.")
    options = dict(
        data=str(DATA_YAML),
        workers=workers,
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        device=device,
        patience=patience,
        project=str(RUNS_DIR),
        name=f"{arch}_{nombre}_s{seed}_{time.strftime('%Y%m%d_%H%M%S')}",
        exist_ok=False,
        seed=seed,
        deterministic=True,
        # Aumentaciones pensadas para placas: sin volteo horizontal (invierte los caracteres)
        fliplr=0.0,
        flipud=0.0,
        degrees=8.0,
        perspective=0.0008,
        shear=3.0,
        scale=0.6,          # placas grandes (cerca) y pequeñas (lejos)
        multi_scale=multi_scale,
        mosaic=1.0,
        close_mosaic=min(epochs, max(2, epochs // 8)),
        hsv_v=0.5,          # día / noche / contraluz
        plots=True,
        verbose=True,
        optimizer="AdamW",
        lr0=lr0,
        freeze=freeze,
        save_period=1,
        cache=False,
    )
    if resume:
        # Ultralytics restaura épocas, optimizador y aumentaciones del checkpoint.
        model.train(resume=True, data=str(DATA_YAML), device=device, workers=workers)
    else:
        model.train(**options)
    run_dir = Path(model.trainer.save_dir)
    best = run_dir / "weights" / "best.pt"
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    dest = MODELS_DIR / f"{run_dir.name}_candidato.pt"
    shutil.copy2(best, dest)
    dataset = validate_dataset(DATA_YAML)
    report = {
        "candidate": str(dest), "run": str(run_dir), "dataset": dataset,
        "weights": resume or weights or f"{arch}.pt", "resumed": bool(resume),
        "metrics": {str(k): float(v) for k, v in model.trainer.metrics.items()},
        "production_changed": False,
    }
    (dest.with_suffix(".json")).write_text(json.dumps(report, indent=2), encoding="utf-8")
    return dest


def export_onnx(candidate: Path, imgsz: int) -> Path:
    """Exporta tamaño dinámico y verifica una inferencia real con ONNX Runtime."""
    import sys

    import numpy as np
    import onnxruntime as ort
    from ultralytics import YOLO

    # Ejecucion directa desde scripts/: importar el helper puro sin requerir el OCR/config.
    service_path = str(Path(__file__).resolve().parents[1])
    if service_path not in sys.path:
        sys.path.insert(0, service_path)
    from app.infraestructura.model_architecture import identificar_arquitectura, guardar_metadata_arquitectura_onnx

    model = YOLO(str(candidate))
    arquitectura = identificar_arquitectura(model.model)
    path = Path(model.export(format="onnx", imgsz=imgsz, batch=1,
                             dynamic=True, simplify=False, opset=17, device="cpu"))
    guardar_metadata_arquitectura_onnx(path, arquitectura, hashlib.sha256(candidate.read_bytes()).hexdigest())
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])
    inputs = {session.get_inputs()[0].name: np.zeros((1, 3, imgsz, imgsz), dtype=np.float32)}
    session.run(None, inputs)
    times = []
    for _ in range(10):
        start = time.perf_counter()
        outputs = session.run(None, inputs)
        times.append((time.perf_counter() - start) * 1000)
    result = {"onnx": str(path), "input_size": imgsz, "threads": 4, "warmups": 1,
              "samples": 10, "median_ms": float(np.median(times)), "p95_ms": float(np.percentile(times, 95)),
              "output_shapes": [list(o.shape) for o in outputs],
              "scope": "Solo inferencia ONNX con entrada cero; excluye preproceso, OCR y video."}
    path.with_suffix(".benchmark.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"[OK] ONNX verificado: {path}; mediana {result['median_ms']:.1f} ms (solo red).")
    return path


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

def promote(candidate: Path) -> bool:
    """Reemplaza el detector de producción (solo modelos YOLO .pt) respaldando el anterior."""
    from ultralytics import YOLO

    if candidate.suffix != ".pt" or not candidate.is_file() or not PROD_PT.is_file():
        raise ValueError("Se requieren candidato .pt y modelo de producción existente para comparar y respaldar.")
    audit = validate_dataset(DATA_YAML)
    provenance_path = Path(audit["root"]) / "provenance.json"
    if provenance_path.exists():
        provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
        if provenance.get("synthetic_origin_inferred"):
            raise ValueError("No se promueve con validación sintética: evalúe antes en fotografías reales independientes.")
    # Un .onnx/.engine anterior puede ser elegido por el despliegue: nunca dejarlo
    # asociado a un .pt diferente sin una actualización coordinada y verificada.
    if any(PROD_PT.with_suffix(suffix).exists() for suffix in (".onnx", ".engine")):
        raise ValueError("Hay artefactos ONNX/engine de producción; actualice y verifique todos los formatos juntos antes de promover.")
    cand = YOLO(str(candidate)).val(data=str(DATA_YAML), split="val", verbose=False, plots=False).box.map
    prod = YOLO(str(PROD_PT)).val(data=str(DATA_YAML), split="val", verbose=False, plots=False).box.map
    if not all(math.isfinite(metric) and 0 <= metric <= 1 for metric in (cand, prod)):
        raise ValueError("No se promueve con métricas inválidas o no finitas.")
    print(f"[+] mAP50-95 validación | producción: {prod:.4f} | candidato: {cand:.4f}")
    if cand <= prod:
        print("[!] El candidato no supera a producción. No se promueve.")
        return False
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    backup = ARCHIVE_DIR / f"license_plate_detector_{time.strftime('%Y%m%d_%H%M%S')}.pt"
    shutil.copy2(PROD_PT, backup)
    shutil.copy2(candidate, PROD_PT)
    print(f"[OK] Promovido a producción. Respaldo: {backup}. Actualice models/MODEL_CARD.md.")
    return True


def main() -> None:
    global DATA_DIR, DATA_YAML
    ap = argparse.ArgumentParser(description="Afinar detector de placas ecuatorianas (YOLO26n / RF-DETR-nano).")
    ap.add_argument("--arch", default="yolo26n", choices=["yolo26n", "yolo11n", "yolov8n", "rfdetr-nano"])
    ap.add_argument("--epochs", type=int, default=80)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--seed", type=int, default=0, help="Semilla (repetir con varias para el artículo)")
    ap.add_argument("--force", action="store_true", help=f"Entrenar con menos de {MIN_TRAIN_IMAGES} imágenes (solo pruebas)")
    ap.add_argument("--promote", action="store_true", help="Reemplazar producción si el candidato YOLO es mejor")
    ap.add_argument("--data", default=str(DATA_YAML), help="data.yaml del dataset (por omisión, el ecuatoriano)")
    ap.add_argument("--nombre", default="ecuador", help="Sufijo de la corrida y del candidato (p. ej. openimages)")
    ap.add_argument("--workers", type=int, default=4, help="Procesos del cargador de datos")
    ap.add_argument("--weights", help="Pesos .pt iniciales; permite afinar el detector ya entrenado")
    ap.add_argument("--resume", metavar="CHECKPOINT", help="Reanudar un last.pt interrumpido")
    ap.add_argument("--validate-only", action="store_true", help="Validar datos sin entrenar")
    ap.add_argument("--export-onnx", action="store_true", help="Exportar y comprobar el candidato en ONNX Runtime")
    ap.add_argument("--threads", type=int, default=4, help="Hilos CPU de PyTorch")
    ap.add_argument("--patience", type=int, default=10)
    ap.add_argument("--lr0", type=float, default=0.0001, help="Tasa inicial AdamW para afinamiento")
    ap.add_argument("--freeze", type=int, default=0, help="Congelar las primeras N capas")
    ap.add_argument("--multi-scale", type=float, default=0.25, help="Variación de resolución por lote (0 desactiva)")
    args = ap.parse_args()

    if min(args.epochs, args.imgsz, args.batch, args.threads, args.patience) <= 0 or args.workers < 0 or args.freeze < 0:
        ap.error("epochs, imgsz, batch, threads y patience deben ser positivos; workers y freeze >= 0")
    if not 0 <= args.multi_scale < 1 or args.lr0 <= 0:
        ap.error("multi-scale debe estar entre 0 y 1 (excluido); lr0 > 0")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", args.nombre):
        ap.error("nombre solo admite letras, números, guiones y subrayados")
    if args.weights and args.resume:
        ap.error("Use --weights o --resume, no ambos")
    for path in (args.weights, args.resume):
        if path and not Path(path).is_file():
            ap.error(f"No existe el checkpoint: {path}")
    if args.arch == "rfdetr-nano" and (args.weights or args.resume or args.export_onnx):
        ap.error("weights, resume y export-onnx se implementan para YOLO")

    DATA_YAML = Path(args.data).resolve()
    DATA_DIR = DATA_YAML.parent

    if not DATA_YAML.exists():
        raise SystemExit(f"No existe {DATA_YAML}. Ejecute primero scripts/annotate_plates.py")
    try:
        audit = validate_dataset(DATA_YAML)
    except (ValueError, OSError) as exc:
        raise SystemExit(f"Dataset inválido: {exc}") from exc
    DATA_DIR = Path(audit["root"])
    n_train = audit["splits"]["train"]["images"]
    print(json.dumps(audit, indent=2))
    if args.validate_only:
        return
    if n_train < MIN_TRAIN_IMAGES and not args.force:
        raise SystemExit(f"[!] Solo {n_train} imágenes de entrenamiento (mínimo {MIN_TRAIN_IMAGES}). Use --force solo para pruebas.")

    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    config_dir = RUNS_DIR / ".ultralytics"
    config_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("YOLO_CONFIG_DIR", str(config_dir))
    os.environ.setdefault("YOLO_OFFLINE", "true")
    os.environ.setdefault("YOLO_AUTOINSTALL", "false")
    os.environ["OMP_NUM_THREADS"] = str(args.threads)
    os.environ["MKL_NUM_THREADS"] = str(args.threads)
    import torch
    torch.set_num_threads(args.threads)
    # select_device('cpu') vuelve a fijar los hilos usando esta constante.
    from ultralytics.utils import torch_utils
    torch_utils.NUM_THREADS = args.threads
    if args.arch == "rfdetr-nano":
        cand = train_rfdetr(args.epochs, args.batch, args.device, args.seed)
    else:
        cand = train_yolo(args.arch, args.epochs, args.imgsz, args.batch, args.device, args.seed,
                          args.nombre, args.workers, args.weights, args.resume, args.patience,
                          args.lr0, args.freeze, args.multi_scale)
    print(f"[+] Candidato guardado: {cand}")
    print("    Compárelo con: scripts/evaluate_detectors.py")

    if args.export_onnx:
        export_onnx(cand, args.imgsz)

    if args.promote and cand.suffix == ".pt":
        promoted = promote(cand)
        report_path = cand.with_suffix(".json")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        report["production_changed"] = promoted
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
