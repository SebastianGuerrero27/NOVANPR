"""Valida un dataset YOLO y crea una copia para deteccion, sin editar el origen.

Acepta etiquetas de deteccion (5 columnas) o pose de cuatro esquinas (17).
Conserva los splits existentes; las esquinas se omiten solo en la copia.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import shutil
import uuid

from PIL import Image, ImageDraw

BASE_DIR = Path(__file__).resolve().parents[3]
DEFAULT_SOURCE = BASE_DIR / "dataset" / "openimages_plates_ecuatorianas"
DEFAULT_OUTPUT = BASE_DIR / "dataset" / "detector_ecuatorianas"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
SPLITS = ("train", "val", "test")


@dataclass
class Sample:
    split: str
    image: Path
    label: Path
    width: int
    height: int
    boxes: list[list[float]]
    formats: list[int]
    image_sha256: str
    pixel_sha256: str
    label_sha256: str


def parse_label(path: Path) -> tuple[list[list[float]], list[int]]:
    """Rechaza etiquetas ambiguas, clases ajenas y geometria no normalizada."""
    boxes, formats = [], []
    for line_number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        if not line.strip():
            continue  # una etiqueta vacia es una imagen negativa valida
        tokens = line.split()
        location = f"{path}:{line_number}"
        if len(tokens) not in (5, 17):
            raise ValueError(f"{location}: se esperan 5 o 17 columnas; hay {len(tokens)}")
        try:
            values = list(map(float, tokens))
        except ValueError as exc:
            raise ValueError(f"{location}: etiqueta no numerica") from exc
        if not all(math.isfinite(x) for x in values):
            raise ValueError(f"{location}: valores NaN o infinitos")
        cls, x, y, width, height = values[:5]
        if cls != 0:
            raise ValueError(f"{location}: la unica clase permitida es 0 (license_plate)")
        if not (0 <= x <= 1 and 0 <= y <= 1 and 0 < width <= 1 and 0 < height <= 1):
            raise ValueError(f"{location}: coordenadas de caja invalidas")
        # Se admite exclusivamente el error de redondeo de etiquetas de seis decimales.
        if (x - width / 2 < -1e-6 or y - height / 2 < -1e-6
                or x + width / 2 > 1 + 1e-6 or y + height / 2 > 1 + 1e-6):
            raise ValueError(f"{location}: caja fuera de la imagen")
        for index in range(5, len(values), 3):
            kx, ky, visible = values[index:index + 3]
            if not (0 <= kx <= 1 and 0 <= ky <= 1 and visible in (0, 1, 2)):
                raise ValueError(f"{location}: punto clave invalido")
        boxes.append(values[:5])
        formats.append(len(values))
    return boxes, formats


def inspect_dataset(source: Path) -> tuple[list[Sample], dict]:
    source = source.resolve()
    if not source.is_dir():
        raise ValueError(f"No existe el dataset de origen: {source}")
    samples = []
    report = {"source": str(source), "splits": {}, "warnings": []}
    pixel_hashes = defaultdict(list)
    for split in SPLITS:
        image_dir, label_dir = source / "images" / split, source / "labels" / split
        images = sorted(p for p in image_dir.glob("*") if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS)
        labels = {p.stem: p for p in label_dir.glob("*.txt") if p.is_file()}
        stems = [p.stem for p in images]
        if len(stems) != len(set(stems)):
            raise ValueError(f"{split}: dos imagenes usan el mismo nombre sin extension")
        missing = sorted(set(stems) - set(labels))
        orphan = sorted(set(labels) - set(stems))
        if missing or orphan:
            raise ValueError(f"{split}: pares imagen/etiqueta incompletos; sin etiqueta={missing[:5]}, sin imagen={orphan[:5]}")
        if split in ("train", "val") and not images:
            raise ValueError(f"{split}: se requiere al menos una imagen")
        if not images:
            continue
        formats, count_boxes, dimensions = Counter(), 0, []
        visibility = Counter()
        for image in images:
            label = labels[image.stem]
            boxes, row_formats = parse_label(label)
            raw = image.read_bytes()
            try:
                with Image.open(image) as original:
                    original.load()
                    width, height = original.size
                    if width < 1 or height < 1:
                        raise ValueError("dimensiones vacias")
                    if original.getexif().get(274, 1) != 1:
                        raise ValueError("orientacion EXIF pendiente: normalice imagen y etiquetas juntas")
                    rgb = original.convert("RGB")
                    pixel_hash = hashlib.sha256(f"{width}x{height}:".encode() + rgb.tobytes()).hexdigest()
            except Exception as exc:
                raise ValueError(f"Imagen invalida {image}: {exc}") from exc
            image_hash = hashlib.sha256(raw).hexdigest()
            sample = Sample(split, image, label, width, height, boxes, row_formats,
                            image_hash, pixel_hash, hashlib.sha256(label.read_bytes()).hexdigest())
            samples.append(sample)
            key = f"{split}/{image.name}"
            pixel_hashes[pixel_hash].append(key)
            dimensions.append((width, height))
            formats.update(map(str, row_formats))
            count_boxes += len(boxes)
            if 17 in row_formats:
                for line in label.read_text(encoding="utf-8-sig").splitlines():
                    values = line.split()
                    if len(values) == 17:
                        visibility.update(values[7::3])
        report["splits"][split] = {
            "images": len(images), "labels": len(labels), "boxes": count_boxes,
            "class_counts": {"0": count_boxes}, "source_row_columns": dict(formats),
            "empty_labels": sum(not s.boxes for s in samples if s.split == split),
            "keypoint_visibility": dict(visibility),
            "width_min_max": [min(w for w, _ in dimensions), max(w for w, _ in dimensions)],
            "height_min_max": [min(h for _, h in dimensions), max(h for _, h in dimensions)],
        }
    duplicates = [items for items in pixel_hashes.values() if len(items) > 1]
    cross_split = [items for items in duplicates if len({i.split("/", 1)[0] for i in items}) > 1]
    if cross_split:
        raise ValueError(f"Fuga entre particiones: imagenes identicas en splits diferentes: {cross_split[:3]}")
    report["identical_image_groups_within_split"] = duplicates
    report["identical_image_groups_across_splits"] = cross_split
    report["duplicate_check"] = "SHA256 de pixeles RGB decodificados y dimensiones; no detecta fotos similares"
    report["source_yaml"] = (source / "data.yaml").read_text(encoding="utf-8") if (source / "data.yaml").exists() else None
    pose_count = sum(17 in s.formats for s in samples)
    synthetic_hint = pose_count and all(s.image.stem.startswith("pose_") for s in samples)
    report["synthetic_origin_inferred"] = bool(synthetic_hint)
    if pose_count:
        report["warnings"].append("El origen contiene etiquetas YOLO-pose; se copian solo las cajas de las primeras cinco columnas.")
    if synthetic_hint:
        report["warnings"].append(
            "Los nombres pose_* y las cuatro esquinas coinciden con generate_synthetic_plates.py: "
            "probables recortes sinteticos ecuatorianos para rectificacion. El nombre de carpeta no acredita origen Open Images "
            "ni fotografias reales. Confirmar visualmente; estas muestras no demuestran deteccion en escenas a 1-10 metros."
        )
    report["warnings"].append("La comprobacion de duplicados exactos no garantiza independencia por vehiculo o texto de placa.")
    if duplicates:
        report["warnings"].append(f"Hay {len(duplicates)} grupos de imagenes identicas dentro de un mismo split.")
    report["manifest"] = [
        {"image": str(s.image.relative_to(source)), "label": str(s.label.relative_to(source)),
         "width": s.width, "height": s.height, "boxes": len(s.boxes),
         "image_sha256": s.image_sha256, "pixel_sha256": s.pixel_sha256, "label_sha256": s.label_sha256}
        for s in samples
    ]
    fingerprint = "\n".join(f"{m['image']} {m['image_sha256']} {m['label_sha256']}" for m in report["manifest"])
    report["source_fingerprint_sha256"] = hashlib.sha256(fingerprint.encode()).hexdigest()
    return samples, report


def create_previews(samples: list[Sample], output: Path, count: int) -> None:
    if count <= 0:
        return
    preview = output / "preview"
    preview.mkdir()
    # Muestreo uniforme y determinista del conjunto completo, incluyendo validacion.
    count = min(count, len(samples))
    indexes = [round(i * (len(samples) - 1) / max(count - 1, 1)) for i in range(count)]
    cols, cell_width, cell_height = 4, 300, 180
    rows = (count + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell_width, rows * cell_height), "#202020")
    text_draw = ImageDraw.Draw(sheet)
    for i, index in enumerate(indexes):
        sample = samples[index]
        with Image.open(sample.image) as original:
            image = original.convert("RGB")
        draw = ImageDraw.Draw(image)
        for _, cx, cy, width, height in sample.boxes:
            coords = ((round((cx - width / 2) * sample.width), round((cy - height / 2) * sample.height)),
                      (round((cx + width / 2) * sample.width), round((cy + height / 2) * sample.height)))
            draw.rectangle(coords, outline=(0, 255, 0), width=max(1, min(image.size) // 100))
        image.save(preview / f"{sample.split}_{sample.image.stem}.jpg", quality=95)
        image.thumbnail((cell_width - 12, cell_height - 32))
        x, y = (i % cols) * cell_width, (i // cols) * cell_height
        text_draw.text((x + 6, y + 5), f"{sample.split}/{sample.image.name}", fill="white")
        sheet.paste(image, (x + (cell_width - image.width) // 2, y + 28 + (cell_height - 32 - image.height) // 2))
    sheet.save(preview / "contact_sheet.jpg", quality=95)


def prepare_dataset(source: Path, output: Path, preview_count: int = 24) -> dict:
    source, output = source.resolve(), output.resolve()
    if output.exists():
        raise ValueError(f"El destino ya existe: {output}. Use otro --output para evitar mezclar ejecuciones.")
    if source == output or source in output.parents or output in source.parents:
        raise ValueError("El origen y destino deben ser directorios separados, sin anidamiento.")
    samples, report = inspect_dataset(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Se publica el resultado solo despues de completar todas las copias y vistas previas.
    # mkdir hereda los permisos del dataset. TemporaryDirectory aplica un ACL
    # privado en Windows que impediria al usuario y a Docker abrir la salida.
    staging = output.parent / f".{output.name}-prepare-{uuid.uuid4().hex}"
    staging.mkdir()
    try:
        for split in report["splits"]:
            (staging / "images" / split).mkdir(parents=True)
            (staging / "labels" / split).mkdir(parents=True)
        for sample in samples:
            shutil.copy2(sample.image, staging / "images" / sample.split / sample.image.name)
            text = "\n".join("0 " + " ".join(f"{x:.8f}" for x in box[1:]) for box in sample.boxes)
            (staging / "labels" / sample.split / sample.label.name).write_text(text + ("\n" if text else ""), encoding="utf-8")
        yaml = "# Copia de deteccion; rutas relativas a este archivo (portable a Docker).\n"
        yaml += "train: images/train\nval: images/val\n"
        if "test" in report["splits"]:
            yaml += "test: images/test\n"
        yaml += "names:\n  0: license_plate\n"
        (staging / "data.yaml").write_text(yaml, encoding="utf-8")
        report.update({"output": str(output), "created_at_utc": datetime.now(timezone.utc).isoformat(),
                       "conversion": "YOLO detection; clase cx cy width height, sin puntos clave", "preserved_splits": True})
        (staging / "provenance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        create_previews(samples, staging, preview_count)
        staging.rename(output)
    finally:
        if staging.exists():
            # El unico directorio que se limpia es el que acaba de crearse aqui.
            if staging.parent != output.parent or not staging.name.startswith(f".{output.name}-prepare-"):
                raise RuntimeError("Ruta de limpieza fuera del destino previsto")
            shutil.rmtree(staging)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--preview-count", type=int, default=24)
    args = parser.parse_args()
    if args.preview_count < 0:
        parser.error("--preview-count debe ser mayor o igual a cero")
    try:
        report = prepare_dataset(args.source, args.output, args.preview_count)
    except (ValueError, OSError) as exc:
        parser.exit(1, f"Error: {exc}\n")
    print(json.dumps({key: report[key] for key in ("source", "output", "splits", "warnings")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
