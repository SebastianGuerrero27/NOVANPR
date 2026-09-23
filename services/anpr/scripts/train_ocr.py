"""
Afinamiento de fast-plate-ocr cct-s-v2 con placas ecuatorianas (contribución principal).

Parte del modelo global cct-s-v2 (~220 mil placas de 65+ países, sin Ecuador) y lo ajusta
con placas ecuatorianas reales (dataset/ocr/real, de scripts/annotate_plates.py) y
sintéticas (dataset/ocr/synth, de scripts/generate_synthetic_plates.py). Las reales se
sobremuestrean porque son pocas y son las que representan el dominio.

Pasos:
  1. Descarga los pesos .keras y las configuraciones oficiales del release de fast-plate-ocr.
  2. Arma train.csv / val.csv combinando real + sintético.
  3. Entrena con `fast-plate-ocr train --weights-path` (backend Keras = TensorFlow, CPU).
  4. Exporta a ONNX como CANDIDATO (models/ocr/cct_s_v2_ecuador_candidato.onnx);
     con --promote pasa a producción solo si supera al modelo global en la prueba real.
  5. Compara exactitud en el conjunto de PRUEBA real: modelo global vs afinado.

Uso (entorno de entrenamiento, desde services/anpr):
    .venv-train/Scripts/python scripts/train_ocr.py --epochs 30 --batch-size 64
"""

from __future__ import annotations

import argparse
import csv
import os
import random
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent.parent.parent
OCR_DATA = BASE_DIR / "dataset" / "ocr"
MODELS_OCR = BASE_DIR / "services" / "anpr" / "models" / "ocr"
PRETRAINED = MODELS_OCR / "pretrained"
RUNS = BASE_DIR / "dataset" / "runs" / "ocr_cct_s_v2_ecuador"
RELEASE = "https://github.com/ankandrew/fast-plate-ocr/releases/download/arg-plates/"
ASSETS = ["cct_s_v2_global.keras", "cct_s_v2_global_model_config.yaml", "cct_s_v2_global_plate_config.yaml"]
# Candidato (no lo carga el servicio) y producción (lo carga automáticamente)
CAND_ONNX = MODELS_OCR / "cct_s_v2_ecuador_candidato.onnx"
CAND_CONFIG = MODELS_OCR / "cct_s_v2_ecuador_candidato_plate_config.yaml"
OUT_ONNX = MODELS_OCR / "cct_s_v2_ecuador.onnx"
OUT_CONFIG = MODELS_OCR / "cct_s_v2_ecuador_plate_config.yaml"


def download_pretrained() -> None:
    PRETRAINED.mkdir(parents=True, exist_ok=True)
    for name in ASSETS:
        dest = PRETRAINED / name
        if not dest.exists():
            print(f"[+] Descargando {name} ...")
            urllib.request.urlretrieve(RELEASE + name, dest)


def read_csv(path: Path, prefix: str) -> list[list[str]]:
    if not path.exists():
        return []
    rows = []
    for r in csv.DictReader(open(path, encoding="utf-8")):
        rows.append([f"{prefix}/{r['image_path']}", r["plate_text"], r.get("plate_region") or "Unknown"])
    return rows


def write_csv(path: Path, rows: list[list[str]]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["image_path", "plate_text", "plate_region"])
        w.writerows(rows)


def build_splits(real_oversample: int, synth_val: int, synth_max: int) -> tuple[Path, Path, int, int]:
    random.seed(0)
    synth = read_csv(OCR_DATA / "synth" / "labels.csv", "synth")
    random.shuffle(synth)
    real_train = read_csv(OCR_DATA / "real" / "train.csv", "real")
    real_val = read_csv(OCR_DATA / "real" / "val.csv", "real")

    train = synth[synth_val:synth_val + synth_max] + real_train * real_oversample
    # Validación: placas reales si existen; se añade un poco de sintético para estabilidad
    val = real_val + synth[:synth_val]
    random.shuffle(train)
    train_csv, val_csv = OCR_DATA / "train_ocr.csv", OCR_DATA / "val_ocr.csv"
    write_csv(train_csv, train)
    write_csv(val_csv, val)
    return train_csv, val_csv, len(real_train), len(real_val)


def fpo_cli(*args: str) -> None:
    """Ejecuta la CLI de fast-plate-ocr. Backend TensorFlow por defecto: en CPU es mucho más rápido que PyTorch con Keras."""
    env = dict(os.environ, KERAS_BACKEND=os.environ.get("KERAS_BACKEND", "tensorflow"))
    exe = Path(sys.executable).with_name("fast-plate-ocr.exe" if os.name == "nt" else "fast-plate-ocr")
    cmd = [str(exe), *args]
    print("[+]", " ".join(cmd))
    subprocess.run(cmd, check=True, env=env)


def export_onnx(model_path: Path, plate_config: Path) -> None:
    """
    Exporta a ONNX con la CLI de fast-plate-ocr. En Windows su NamedTemporaryFile queda
    abierto y Keras no puede escribir en él (PermissionError), así que se ejecuta la CLI
    con un NamedTemporaryFile(delete=False).
    """
    code = (
        "import functools, sys, tempfile\n"
        "import fast_plate_ocr.cli.export as ex\n"
        "ex.NamedTemporaryFile = functools.partial(tempfile.NamedTemporaryFile, delete=False)\n"
        "from fast_plate_ocr.cli.cli import main_cli\n"
        "sys.argv = ['fast-plate-ocr', 'export', '--model', sys.argv[1], '--plate-config-file', sys.argv[2], '--format', 'onnx']\n"
        "main_cli()\n"
    )
    env = dict(os.environ, KERAS_BACKEND=os.environ.get("KERAS_BACKEND", "tensorflow"))
    print(f"[+] Exportando {model_path.name} a ONNX ...")
    subprocess.run([sys.executable, "-c", code, str(model_path), str(plate_config)], check=True, env=env)


def evaluate(split_csv: Path, **recognizer_kwargs) -> tuple[int, int]:
    import cv2
    from fast_plate_ocr import LicensePlateRecognizer

    rec = LicensePlateRecognizer(device="cpu", **recognizer_kwargs)
    gray = getattr(rec.config, "image_color_mode", "rgb") == "grayscale"
    ok = n = 0
    for r in csv.DictReader(open(split_csv, encoding="utf-8")):
        img = cv2.imread(str(split_csv.parent / r["image_path"]))
        if img is None:
            continue
        img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY if gray else cv2.COLOR_BGR2RGB)
        pred = re.sub(r"[^A-Z0-9]", "", rec.run(img)[0].plate.upper())
        ok += pred == r["plate_text"]
        n += 1
    return ok, n


def main() -> None:
    ap = argparse.ArgumentParser(description="Afinar cct-s-v2 con placas ecuatorianas.")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch-size", type=int, default=64)
    ap.add_argument("--lr", type=float, default=3e-4, help="Menor que el valor por defecto (1e-3): se afina, no se entrena desde cero")
    ap.add_argument("--real-oversample", type=int, default=20, help="Repeticiones de cada placa real en train")
    ap.add_argument("--synth-val", type=int, default=1000, help="Placas sintéticas reservadas para validación")
    ap.add_argument("--synth-max", type=int, default=6000, help="Máximo de placas sintéticas en train (afinar no requiere todas)")
    ap.add_argument("--skip-train", action="store_true", help="Solo exportar/evaluar el último entrenamiento")
    ap.add_argument("--promote", action="store_true", help="Usar el candidato en el servicio si supera al global en la prueba real")
    args = ap.parse_args()

    download_pretrained()
    train_csv, val_csv, n_real_train, n_real_val = build_splits(args.real_oversample, args.synth_val, args.synth_max)
    print(f"[+] Placas reales: train={n_real_train} (x{args.real_oversample}) val={n_real_val}")

    if not args.skip_train:
        if RUNS.exists():
            shutil.rmtree(RUNS)
        fpo_cli(
            "train",
            "--model-config-file", str(PRETRAINED / "cct_s_v2_global_model_config.yaml"),
            "--plate-config-file", str(PRETRAINED / "cct_s_v2_global_plate_config.yaml"),
            "--annotations", str(train_csv),
            "--val-annotations", str(val_csv),
            "--weights-path", str(PRETRAINED / "cct_s_v2_global.keras"),
            "--epochs", str(args.epochs),
            "--batch-size", str(args.batch_size),
            "--output-dir", str(RUNS),
            "--lr", str(args.lr),
            "--early-stopping-patience", "8",
            "--early-stopping-metric", "val_plate_acc",
            "--seed", "42",
        )

    # Mejor época según val_plate_acc (best.keras); last.keras solo si no existe
    kerases = list(RUNS.rglob("best.keras")) or list(RUNS.rglob("*.keras"))
    best = max(kerases, key=lambda p: p.stat().st_mtime)
    export_onnx(best, PRETRAINED / "cct_s_v2_global_plate_config.yaml")
    onnx = max(best.parent.rglob("*.onnx"), key=lambda p: p.stat().st_mtime)
    MODELS_OCR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(onnx, CAND_ONNX)
    shutil.copy2(PRETRAINED / "cct_s_v2_global_plate_config.yaml", CAND_CONFIG)
    print(f"[OK] Candidato afinado: {CAND_ONNX}")

    test_csv = OCR_DATA / "real" / "test.csv"
    if not test_csv.exists():
        print("[!] Sin conjunto de prueba real: el candidato no se puede promover.")
        return
    ok_g, n = evaluate(test_csv, hub_ocr_model="cct-s-v2-global-model")
    ok_e, _ = evaluate(test_csv, onnx_model_path=str(CAND_ONNX), plate_config_path=str(CAND_CONFIG))
    print(f"[=] Prueba real ({n} placas) | global: {ok_g / max(1, n):.1%} | afinado Ecuador: {ok_e / max(1, n):.1%}")
    if args.promote:
        if ok_e > ok_g:
            shutil.copy2(CAND_ONNX, OUT_ONNX)
            shutil.copy2(CAND_CONFIG, OUT_CONFIG)
            print(f"[OK] Promovido: el servicio usará {OUT_ONNX}")
        else:
            print("[!] El candidato no supera al modelo global en la prueba real. No se promueve.")


if __name__ == "__main__":
    main()
