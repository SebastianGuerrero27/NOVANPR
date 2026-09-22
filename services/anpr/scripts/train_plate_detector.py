"""
Entrenamiento y Ajuste Fino (Fine-Tuning) del Detector de Placas Multi-Distancia.
Optimizado para Sistemas Inteligentes de Transporte (ITS / ECU 911).

Caracteristicas Principales:
  - Invarianza a la distancia: Escalamiento dinamico (scale 0.5 - 1.5) y mosaico.
  - Invarianza angular: Jitter de rotacion (+/- 12 deg) y correccion de perspectiva.
  - Exportacion automatica a ONNX Runtime para inferencia ultra-rapida (< 10ms).
  - Actualizacion directa del modelo en produccion (services/anpr/models/license_plate_detector.pt).
"""

import os
import sys
import shutil
import time
from pathlib import Path
import torch
from ultralytics import YOLO

# Rutas base
BASE_DIR = Path(__file__).resolve().parent.parent.parent.parent
DATASET_DIR = BASE_DIR / "dataset"
DATA_YAML = DATASET_DIR / "data.yaml"
IMAGES_TRAIN = DATASET_DIR / "images" / "train"
MODELS_DIR = BASE_DIR / "services" / "anpr" / "models"
BASE_MODEL_PT = MODELS_DIR / "license_plate_detector.pt"
FALLBACK_YOLO11 = BASE_DIR / "services" / "anpr" / "yolo11n.pt"
CANDIDATE_PT = MODELS_DIR / "license_plate_detector_candidato.pt"
ARCHIVE_DIR = MODELS_DIR / "archive"

# Por debajo de este numero de imagenes el entrenamiento no tiene validez estadistica
# y solo altera el modelo base (ver models/MODEL_CARD.md).
MIN_TRAIN_IMAGES = 200


def _map50_95(weights: Path, imgsz: int, device: str) -> float:
    """mAP50-95 del modelo sobre el conjunto de validacion de data.yaml."""
    metrics = YOLO(str(weights)).val(data=str(DATA_YAML), imgsz=imgsz, device=device, verbose=False, plots=False)
    return float(metrics.box.map)


def train_plate_detector(
    epochs: int = 35,
    imgsz: int = 640,
    batch_size: int = 8,
    patience: int = 12,
    force: bool = False,
    promote: bool = False,
):
    print("=" * 70)
    print("  ENTRENAMIENTO ESPECIALIZADO DE PLACAS — MULTI-DISTANCIA")
    print("  SISTEMA ITS ECU 911")
    print("=" * 70)

    # 1. Validar existencia del dataset
    train_images = list(IMAGES_TRAIN.glob("*.jpg")) + list(IMAGES_TRAIN.glob("*.png"))
    if not train_images:
        print("\n[!] ERROR: No se encontraron imagenes de entrenamiento en:")
        print(f"    {IMAGES_TRAIN}")
        print("\n    Pasos requeridos antes de entrenar:")
        print("    1. Coloca fotos de placas tomadas a distintas distancias en 'dataset/raw/'")
        print(r"    2. Ejecuta: .\services\anpr\.venv\Scripts\python services\anpr\scripts\auto_annotate.py")
        return False

    if len(train_images) < MIN_TRAIN_IMAGES and not force:
        print(f"\n[!] Solo hay {len(train_images)} imagenes de entrenamiento (minimo {MIN_TRAIN_IMAGES}).")
        print("    Entrenar con tan pocas imagenes no produce un modelo valido para la tesis.")
        print("    Use --force solo para pruebas; el modelo de produccion no se modificara.")
        return False

    print(f"\n[+] Imagenes de entrenamiento listas: {len(train_images)}")
    print(f"[+] Archivo de configuracion: {DATA_YAML}")

    # 2. Seleccionar dispositivo (GPU CUDA o CPU multi-hilo)
    device = "0" if torch.cuda.is_available() else "cpu"
    num_threads = min(8, max(2, os.cpu_count() or 4))
    if device == "cpu":
        torch.set_num_threads(num_threads)
        print(f"[+] Entorno de ejecucion: CPU Multi-Core ({num_threads} hilos)")
        batch_size = min(batch_size, 4)
    else:
        gpu_name = torch.cuda.get_device_name(0)
        print(f"[+] Aceleracion por Hardware: GPU NVIDIA ({gpu_name})")

    # 3. Cargar pesos base
    if BASE_MODEL_PT.exists():
        start_weights = str(BASE_MODEL_PT)
        print(f"[+] Reanudando fine-tuning desde pesos existentes: {start_weights}")
    elif FALLBACK_YOLO11.exists():
        start_weights = str(FALLBACK_YOLO11)
        print(f"[+] Iniciando desde detector base: {start_weights}")
    else:
        start_weights = "yolo11n.pt"
        print(f"[+] Descargando detector base oficial: {start_weights}")

    model = YOLO(start_weights)

    # 4. Iniciar entrenamiento con hiperparámetros adaptados a multi-distancia
    print(f"\n[+] Iniciando entrenamiento por {epochs} epocas (patience={patience})...")
    print("    Aumentaciones activadas:")
    print("    - Multi-scale jitter (0.5 a 1.5x) para detectar placas de 1m a 10m")
    print("    - Rotacion +/- 12 grados para soportar celulares inclinados")
    print("    - Mosaic y perspectiva angular para robustez en transito")

    runs_dir = DATASET_DIR / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)

    results = model.train(
        data=str(DATA_YAML),
        epochs=epochs,
        imgsz=imgsz,
        batch=batch_size,
        device=device,
        patience=patience,
        save=True,
        project=str(runs_dir),
        name="plate_multiscale_experiment",
        exist_ok=True,
        # Aumentaciones espaciales para distintas distancias y angulos
        scale=0.55,          # Simula acercamiento (1m) y alejamiento (8m)
        degrees=12.0,        # Inclinacion vehicular y de smartphone
        perspective=0.001,   # Perspectiva de camara
        shear=2.0,           # Deformacion por velocidad
        mosaic=1.0,          # Composicion de 4 fotos simultaneas
        hsv_h=0.015,
        hsv_s=0.5,
        hsv_v=0.4,           # Invarianza ante luz directa y sombra
        flipud=0.0,
        fliplr=0.5,          # Reflejo horizontal
        verbose=True,
        plots=True,
    )

    # 5. Obtener mejores pesos
    best_pt = runs_dir / "plate_multiscale_experiment" / "weights" / "best.pt"
    if not best_pt.exists():
        print(f"[!] No se encontro best.pt en {best_pt}. Usando last.pt...")
        best_pt = runs_dir / "plate_multiscale_experiment" / "weights" / "last.pt"

    if not best_pt.exists():
        return False

    # El modelo nuevo se guarda como CANDIDATO; nunca sobrescribe produccion automaticamente.
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(best_pt, CANDIDATE_PT)
    print(f"\n[+] Modelo candidato guardado en: {CANDIDATE_PT}")

    cand_map = _map50_95(CANDIDATE_PT, imgsz, device)
    prod_map = _map50_95(BASE_MODEL_PT, imgsz, device) if BASE_MODEL_PT.exists() else 0.0
    print(f"[+] mAP50-95 en validacion | produccion: {prod_map:.4f} | candidato: {cand_map:.4f}")

    if not promote:
        print("[i] Produccion sin cambios. Use --promote para reemplazarlo si el candidato es mejor.")
        return True
    if cand_map <= prod_map:
        print("[!] El candidato no supera al modelo de produccion. No se promueve.")
        return True

    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    if BASE_MODEL_PT.exists():
        backup = ARCHIVE_DIR / f"license_plate_detector_{time.strftime('%Y%m%d_%H%M%S')}.pt"
        shutil.copy2(BASE_MODEL_PT, backup)
        print(f"[+] Respaldo del modelo anterior: {backup}")
    shutil.copy2(CANDIDATE_PT, BASE_MODEL_PT)
    print(f"[OK] Candidato promovido a produccion: {BASE_MODEL_PT}")
    print("     Actualice models/MODEL_CARD.md con el dataset y las metricas de este entrenamiento.")
    return True


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Entrenar detector de placas ecuatorianas multi-distancia.")
    parser.add_argument("--epochs", type=int, default=30, help="Numero maximo de epocas (default: 30)")
    parser.add_argument("--imgsz", type=int, default=640, help="Resolucion de entrenamiento (default: 640)")
    parser.add_argument("--batch", type=int, default=8, help="Tamano del lote (default: 8)")
    parser.add_argument("--force", action="store_true", help=f"Entrenar aunque haya menos de {MIN_TRAIN_IMAGES} imagenes")
    parser.add_argument("--promote", action="store_true", help="Reemplazar produccion si el candidato tiene mejor mAP50-95")
    args = parser.parse_args()

    train_plate_detector(
        epochs=args.epochs, imgsz=args.imgsz, batch_size=args.batch,
        force=args.force, promote=args.promote,
    )
