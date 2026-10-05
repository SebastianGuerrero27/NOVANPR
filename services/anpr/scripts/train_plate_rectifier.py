"""
Entrenamiento del rectificador de placas: YOLO26n-pose que predice las 4 esquinas.

El modelo recibe el recorte que entrega el detector (con margen) y predice las esquinas
[sup-izq, sup-der, inf-der, inf-izq]; con ellas se aplica una homografía que deja la placa
frontal y del tamaño canónico ANT antes del OCR (app/infraestructura/plate_rectifier.py). Reemplaza a la
rectificación heurística por contornos de plate_agent.py.

Datos: dataset/pose (scripts/generate_synthetic_plates.py --pose-out), con esquinas exactas.
Si existen recortes reales con esquinas revisadas en dataset/pose_real, se agregan.

Uso (desde services/anpr):
    .venv/Scripts/python scripts/generate_synthetic_plates.py --n 8000 --pose-out ../../dataset/pose
    .venv/Scripts/python scripts/train_plate_rectifier.py --epochs 40
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent.parent.parent
DATA_YAML = BASE_DIR / "dataset" / "pose" / "data.yaml"
RUNS_DIR = BASE_DIR / "dataset" / "runs"
MODELS_DIR = BASE_DIR / "services" / "anpr" / "models"
CANDIDATE = MODELS_DIR / "plate_rectifier_candidato.pt"


def main() -> None:
    ap = argparse.ArgumentParser(description="Entrenar YOLO26n-pose para las 4 esquinas de la placa.")
    ap.add_argument("--arch", default="yolo26n-pose", help="yolo26n-pose (por defecto) o yolo11n-pose")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--imgsz", type=int, default=256, help="Los recortes de placa son pequeños; 256 basta")
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--fraction", type=float, default=1.0, help="Fracción del dataset por época (acelera en CPU)")
    args = ap.parse_args()

    if not DATA_YAML.exists():
        raise SystemExit(f"No existe {DATA_YAML}. Genere primero el dataset con --pose-out.")

    from ultralytics import YOLO

    model = YOLO(f"{args.arch}.pt")
    name = f"{args.arch}_rectificador_s{args.seed}"
    model.train(
        data=str(DATA_YAML),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        seed=args.seed,
        deterministic=True,
        fraction=args.fraction,
        patience=max(8, args.epochs // 4),
        project=str(RUNS_DIR),
        name=name,
        exist_ok=True,
        # La geometría la aporta el generador (perspectiva exacta); aquí solo variaciones suaves
        fliplr=0.0,        # voltear invierte el texto de la placa
        mosaic=0.0,        # un recorte = una placa
        degrees=5.0,
        scale=0.3,
        translate=0.1,
        hsv_v=0.4,
        plots=True,
        verbose=True,
    )
    best = RUNS_DIR / name / "weights" / "best.pt"
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(best, CANDIDATE)
    print(f"[+] Rectificador candidato: {CANDIDATE}")
    print("    Para usarlo en el servicio: PLATE_RECTIFIER_PATH=models/plate_rectifier_candidato.pt")
    print("    Compárelo con: scripts/run_ablations.py --rectifier models/plate_rectifier_candidato.pt")


if __name__ == "__main__":
    main()
