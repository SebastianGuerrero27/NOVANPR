"""
Dataset público de placas para el detector: subconjunto "Vehicle registration plate" de Open Images V7.

Open Images (Kuznetsova et al., IJCV 2020) anota a mano cajas de placas vehiculares de todo el
mundo (clase /m/01jfm_). Se usan sus particiones OFICIALES (train / validation / test) para que el
experimento sea reproducible y comparable; ninguna imagen se repite entre particiones.

Filtros (documentados en el artículo):
  - Se descartan las imágenes con alguna caja de placa "IsGroupOf" (una caja que agrupa varias
    placas: la posición de cada una es ambigua) o "IsDepiction" (dibujos, juguetes, fotos de fotos).
  - Se conservan las cajas verificadas por personas (fuente "xclick" y "activemil" verificadas, que
    son las que publica el archivo de anotaciones).
  - Las imágenes se reducen a 640 px en el lado mayor al descargarlas (las cajas están normalizadas,
    así que las etiquetas no cambian) para ahorrar disco y tiempo de entrenamiento en CPU.

Licencias: anotaciones CC BY 4.0 (Google); imágenes CC BY 2.0 según cada autor en Flickr. El
dataset generado NO se versiona (dataset/openimages_plates/ está en .gitignore).

Uso (desde services/anpr):
    python scripts/prepare_openimages_plates.py --max-train 6000 --workers 32
Resultado: dataset/openimages_plates/{images,labels}/{train,val,test} y data.yaml
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import random
import time
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import cv2
import numpy as np

BASE_DIR = Path(__file__).resolve().parent.parent.parent.parent
OUT_DIR = BASE_DIR / "dataset" / "openimages_plates"
CACHE_DIR = BASE_DIR / "dataset" / "openimages_cache"

CLASE_PLACA = "/m/01jfm_"  # "Vehicle registration plate"
ANOTACIONES = {
    "train": "https://storage.googleapis.com/openimages/v6/oidv6-train-annotations-bbox.csv",
    "val": "https://storage.googleapis.com/openimages/v5/validation-annotations-bbox.csv",
    "test": "https://storage.googleapis.com/openimages/v5/test-annotations-bbox.csv",
}
CARPETA_OI = {"train": "train", "val": "validation", "test": "test"}
URL_IMAGEN = "https://open-images-dataset.s3.amazonaws.com/{carpeta}/{image_id}.jpg"


def anotaciones_placas(split: str) -> Path:
    """Descarga (en flujo) el CSV de cajas del split y guarda solo las filas de placas."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    destino = CACHE_DIR / f"{split}-plates-bbox.csv"
    if destino.exists() and destino.stat().st_size > 0:
        return destino
    print(f"[+] Descargando anotaciones de {split} (se filtra la clase {CLASE_PLACA} en flujo)…")
    with urllib.request.urlopen(ANOTACIONES[split]) as resp, open(destino, "w", encoding="utf-8") as out:
        texto = io.TextIOWrapper(resp, encoding="utf-8")
        cabecera = texto.readline()
        out.write(cabecera)
        for linea in texto:
            if CLASE_PLACA in linea:
                out.write(linea)
    return destino


def cajas_por_imagen(csv_path: Path) -> dict[str, list[tuple[float, float, float, float]]]:
    """Agrupa las cajas por imagen y excluye las imágenes con cajas de grupo o representaciones."""
    cajas: dict[str, list[tuple[float, float, float, float]]] = defaultdict(list)
    excluidas: set[str] = set()
    with open(csv_path, encoding="utf-8") as f:
        for fila in csv.DictReader(f):
            if fila["LabelName"] != CLASE_PLACA:
                continue
            if fila["IsGroupOf"] == "1" or fila["IsDepiction"] == "1":
                excluidas.add(fila["ImageID"])
                continue
            x0, x1 = float(fila["XMin"]), float(fila["XMax"])
            y0, y1 = float(fila["YMin"]), float(fila["YMax"])
            if x1 > x0 and y1 > y0:
                cajas[fila["ImageID"]].append((x0, x1, y0, y1))
    for image_id in excluidas:
        cajas.pop(image_id, None)
    return dict(cajas)


def descargar(split: str, image_id: str, cajas: list, lado_max: int, reintentos: int = 3) -> bool:
    img_path = OUT_DIR / "images" / split / f"{image_id}.jpg"
    lbl_path = OUT_DIR / "labels" / split / f"{image_id}.txt"
    if not (img_path.exists() and lbl_path.exists()):
        url = URL_IMAGEN.format(carpeta=CARPETA_OI[split], image_id=image_id)
        for intento in range(reintentos):
            try:
                with urllib.request.urlopen(url, timeout=30) as resp:
                    datos = np.frombuffer(resp.read(), dtype=np.uint8)
                img = cv2.imdecode(datos, cv2.IMREAD_COLOR)
                if img is None:
                    return False
                h, w = img.shape[:2]
                escala = lado_max / max(h, w)
                if escala < 1:
                    img = cv2.resize(img, (round(w * escala), round(h * escala)), interpolation=cv2.INTER_AREA)
                cv2.imwrite(str(img_path), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
                break
            except Exception:
                if intento == reintentos - 1:
                    return False
                time.sleep(2 ** intento)
    # Formato YOLO: clase cx cy w h (normalizados)
    lineas = [f"0 {(x0 + x1) / 2:.6f} {(y0 + y1) / 2:.6f} {x1 - x0:.6f} {y1 - y0:.6f}" for x0, x1, y0, y1 in cajas]
    lbl_path.write_text("\n".join(lineas) + "\n", encoding="utf-8")
    return True


def main() -> None:
    ap = argparse.ArgumentParser(description="Subconjunto de placas de Open Images V7 en formato YOLO.")
    ap.add_argument("--max-train", type=int, default=6000, help="Máximo de imágenes de entrenamiento (muestreo con semilla)")
    ap.add_argument("--max-val", type=int, default=0, help="Máximo de imágenes de validación (0 = todas)")
    ap.add_argument("--max-test", type=int, default=0, help="Máximo de imágenes de prueba (0 = todas)")
    ap.add_argument("--lado-max", type=int, default=640, help="Lado mayor al guardar las imágenes")
    ap.add_argument("--workers", type=int, default=32)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    limites = {"train": args.max_train, "val": args.max_val, "test": args.max_test}
    resumen: dict[str, dict[str, int]] = {}
    for split in ("train", "val", "test"):
        (OUT_DIR / "images" / split).mkdir(parents=True, exist_ok=True)
        (OUT_DIR / "labels" / split).mkdir(parents=True, exist_ok=True)
        cajas = cajas_por_imagen(anotaciones_placas(split))
        ids = sorted(cajas)
        disponibles = len(ids)
        if limites[split] and len(ids) > limites[split]:
            ids = sorted(random.Random(args.seed).sample(ids, limites[split]))
        print(f"[+] {split}: {disponibles} imágenes con placas válidas; se usan {len(ids)}")
        ok = 0
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futuros = [pool.submit(descargar, split, i, cajas[i], args.lado_max) for i in ids]
            for n, fut in enumerate(as_completed(futuros), start=1):
                ok += bool(fut.result())
                if n % 500 == 0:
                    print(f"    {split}: {n}/{len(ids)}")
        resumen[split] = {
            "imagenes_disponibles": disponibles,
            "imagenes": ok,
            "placas": sum(len(cajas[i]) for i in ids if (OUT_DIR / "images" / split / f"{i}.jpg").exists()),
        }
        print(f"[OK] {split}: {ok}/{len(ids)} imágenes descargadas")

    (OUT_DIR / "data.yaml").write_text(
        "# Open Images V7 — Vehicle registration plate (/m/01jfm_). Generado por\n"
        "# services/anpr/scripts/prepare_openimages_plates.py (particiones oficiales)\n"
        f"path: {OUT_DIR.as_posix()}\n"
        "train: images/train\nval: images/val\ntest: images/test\n"
        "names:\n  0: license_plate\n",
        encoding="utf-8",
    )
    (OUT_DIR / "resumen.json").write_text(json.dumps({"seed": args.seed, "lado_max": args.lado_max, **resumen}, indent=2), encoding="utf-8")
    print(json.dumps(resumen, indent=2))


if __name__ == "__main__":
    main()
