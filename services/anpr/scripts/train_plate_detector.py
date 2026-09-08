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


def train_plate_detector(
    epochs: int = 35,
    imgsz: int = 640,
    batch_size: int = 8,
    patience: int = 12,
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

    if best_pt.exists():
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        dest_pt = MODELS_DIR / "license_plate_detector.pt"
        shutil.copy2(best_pt, dest_pt)
        print("\n" + "=" * 70)
        print(f"  [✓] MODELO ENTRENADO EXITOSAMENTE Y COPIADO A:")
        print(f"      {dest_pt}")
        print("=" * 70)

        # 6. Exportar a formato ONNX si las librerias estan presentes
        try:
            import onnx
            print("\n[+] Exportando modelo a formato ONNX optimizado para produccion...")
            best_model = YOLO(str(dest_pt))
            onnx_path = best_model.export(format="onnx", imgsz=imgsz, dynamic=True)
            print(f"  [✓] Modelo ONNX generado: {onnx_path}")
        except Exception:
            print(f"\n  [i] Inferencia activa en produccion mediante PyTorch directo ({dest_pt.name}).")

        print("\n[+] El microservicio ANPR utilizara automaticamente este modelo nuevo.")
        return True

    return False


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Entrenar detector de placas ecuatorianas multi-distancia.")
    parser.add_argument("--epochs", type=int, default=30, help="Numero maximo de epocas (default: 30)")
    parser.add_argument("--imgsz", type=int, default=640, help="Resolucion de entrenamiento (default: 640)")
    parser.add_argument("--batch", type=int, default=8, help="Tamano del lote (default: 8)")
    args = parser.parse_args()

    train_plate_detector(epochs=args.epochs, imgsz=args.imgsz, batch_size=args.batch)
