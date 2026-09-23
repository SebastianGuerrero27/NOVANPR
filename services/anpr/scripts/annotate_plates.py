"""
Etiquetado automático de placas ANCLADO EN TEXTO (reemplaza a auto_annotate.py).

El etiquetado anterior usaba el mismo detector que después se entrenaba, así que el
modelo aprendía sus propios errores (por ejemplo, encerrar solo la franja "ECUADOR").
Este script usa un OCR independiente (PP-OCRv6 vía RapidOCR/OpenVINO) para encontrar en
la foto la línea con el texto de la placa (ABC-1234) y la cabecera "ECUADOR" encima; la
caja de la placa se construye a partir de esas dos líneas.

De cada foto se obtiene a la vez:
  - la etiqueta del detector (formato YOLO, clase 0 = license_plate)
  - el recorte y el texto para el OCR (formato fast-plate-ocr)
  - una vista previa con la caja y el texto para REVISIÓN MANUAL

La partición train/val/test se hace POR GRUPO (fecha de captura o subcarpeta), nunca por
foto, para que fotos casi idénticas del mismo vehículo no queden a ambos lados
(Laroca et al., 2023, sobre near-duplicates en datasets ALPR).

Uso (desde services/anpr):
    .venv/Scripts/python scripts/annotate_plates.py --src ../../dataset/raw ../../services/anpr/media \
        --out ../../dataset --test-groups 20260921
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import re
import shutil
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

PLATE_RE = re.compile(r"[A-Z]{3}\d{3,4}|[A-Z]{2}\d{3,4}[A-Z]?")
# Correcciones posicionales de homoglifos: zona de letras / zona de dígitos
TO_LETTER = {"0": "O", "1": "I", "2": "Z", "4": "A", "5": "S", "6": "G", "8": "B"}
TO_DIGIT = {"O": "0", "D": "0", "Q": "0", "I": "1", "L": "1", "Z": "2", "A": "4", "S": "5", "G": "6", "B": "8", "T": "7"}
IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp"}


def norm(t: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (t or "").upper())


def fix_plate(t: str) -> str:
    """Corrige homoglifos según la posición en el formato ANT (3 letras + dígitos)."""
    t = norm(t)
    if len(t) in (6, 7):
        t = "".join(TO_LETTER.get(c, c) for c in t[:3]) + "".join(TO_DIGIT.get(c, c) for c in t[3:])
    return t


def create_ocr():
    from rapidocr import EngineType, ModelType, OCRVersion, RapidOCR
    return RapidOCR(params={
        "Global.log_level": "error",
        "Global.use_cls": False,
        "Det.engine_type": EngineType.OPENVINO, "Det.model_type": ModelType.MEDIUM, "Det.ocr_version": OCRVersion.PPOCRV6,
        "Rec.engine_type": EngineType.OPENVINO, "Rec.model_type": ModelType.MEDIUM, "Rec.ocr_version": OCRVersion.PPOCRV6,
    })


def find_plate(ocr, img: np.ndarray):
    """Retorna (bbox [x1,y1,x2,y2], texto, confianza, con_cabecera) o None."""
    res = ocr(img)
    if res.boxes is None or len(res.boxes) == 0:
        return None
    lines = []
    for box, txt, score in zip(res.boxes, res.txts, res.scores):
        pts = np.array(box, dtype=np.float32)
        x1, y1 = pts.min(axis=0)
        x2, y2 = pts.max(axis=0)
        lines.append({"box": [float(x1), float(y1), float(x2), float(y2)], "txt": norm(txt), "score": float(score)})

    candidatos = []
    for ln in lines:
        m = PLATE_RE.search(fix_plate(ln["txt"])) or PLATE_RE.search(ln["txt"])
        if m and "ECUAD" not in ln["txt"]:
            candidatos.append((ln, fix_plate(m.group(0))))
    if not candidatos:
        return None
    ln, texto = max(candidatos, key=lambda c: (c[0]["box"][2] - c[0]["box"][0]) * c[0]["score"])
    px1, py1, px2, py2 = ln["box"]
    pw, ph = px2 - px1, py2 - py1

    # Cabecera "ECUADOR": línea encima del texto, centrada horizontalmente sobre él
    cabecera = None
    for other in lines:
        if "ECUAD" not in other["txt"] and "CUADO" not in other["txt"]:
            continue
        hx1, hy1, hx2, hy2 = other["box"]
        cx = (hx1 + hx2) / 2
        if hy2 <= py1 + 0.3 * ph and (py1 - hy2) < 1.2 * ph and px1 - 0.2 * pw <= cx <= px2 + 0.2 * pw:
            cabecera = other["box"]
            break

    if cabecera:
        top = cabecera[1] - 0.35 * (cabecera[3] - cabecera[1])
    else:
        top = py1 - 0.55 * ph  # la cabecera ocupa ~35 % del alto de la placa
    bbox = [px1 - 0.06 * pw, top, px2 + 0.06 * pw, py2 + 0.18 * ph]
    h, w = img.shape[:2]
    bbox = [max(0.0, bbox[0]), max(0.0, bbox[1]), min(float(w), bbox[2]), min(float(h), bbox[3])]
    return bbox, texto, ln["score"], cabecera is not None


def group_key(path: Path, src_root: Path) -> str:
    """Grupo = fecha de captura en el nombre (YYYYMMDD) o, si no hay, la subcarpeta."""
    m = re.search(r"(20\d{6})", path.name)
    if m:
        return m.group(1)
    rel = path.relative_to(src_root)
    return rel.parts[0] if len(rel.parts) > 1 else src_root.name


def assign_split(group: str, test_groups: set[str], val_ratio: float, val_groups: set[str] = frozenset()) -> str:
    if group in test_groups:
        return "test"
    if val_groups:
        return "val" if group in val_groups else "train"
    h = int(hashlib.md5(group.encode()).hexdigest(), 16) % 1000 / 1000
    return "val" if h < val_ratio else "train"


def main() -> None:
    ap = argparse.ArgumentParser(description="Etiquetado de placas anclado en texto (detector + OCR).")
    ap.add_argument("--src", nargs="+", required=True, help="Carpetas con fotos completas")
    ap.add_argument("--out", default="../../dataset")
    ap.add_argument("--test-groups", nargs="*", default=[], help="Grupos (fechas/carpetas) reservados para test")
    ap.add_argument("--val-groups", nargs="*", default=[], help="Grupos para validación (si se omite, se reparte por --val-ratio)")
    ap.add_argument("--val-ratio", type=float, default=0.2)
    ap.add_argument("--pattern", default="*", help="Filtro de nombre, ej. 'ingreso_*'")
    args = ap.parse_args()

    out = Path(args.out)
    det_dir, ocr_dir, prev_dir = out / "detector", out / "ocr" / "real", out / "preview_annotate"
    for d in (det_dir, ocr_dir, prev_dir):
        if d.exists():
            shutil.rmtree(d)
    ocr = create_ocr()
    test_groups = set(args.test_groups)

    rows_review = []
    ocr_rows = defaultdict(list)
    stats = defaultdict(int)
    for src in args.src:
        src_root = Path(src)
        for p in sorted(src_root.rglob(args.pattern)):
            if p.suffix.lower() not in IMG_EXT or "preview" in p.parts:
                continue
            img = cv2.imread(str(p))
            if img is None:
                continue
            grp = group_key(p, src_root)
            split = assign_split(grp, test_groups, args.val_ratio, set(args.val_groups))
            found = find_plate(ocr, img)
            stem = f"{grp}_{p.stem}"
            (det_dir / "images" / split).mkdir(parents=True, exist_ok=True)
            (det_dir / "labels" / split).mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, det_dir / "images" / split / f"{stem}{p.suffix.lower()}")
            label_path = det_dir / "labels" / split / f"{stem}.txt"
            prev = img.copy()

            if found is None:
                label_path.write_text("")  # imagen sin placa legible: negativo (REVISAR)
                estado = "sin_placa_detectada"
            else:
                (x1, y1, x2, y2), texto, score, con_cab = found
                h, w = img.shape[:2]
                label_path.write_text(f"0 {(x1 + x2) / 2 / w:.6f} {(y1 + y2) / 2 / h:.6f} {(x2 - x1) / w:.6f} {(y2 - y1) / h:.6f}\n")
                crop = img[int(y1):int(y2), int(x1):int(x2)]
                crop_rel = f"images/{split}/{stem}.jpg"
                (ocr_dir / "images" / split).mkdir(parents=True, exist_ok=True)
                cv2.imwrite(str(ocr_dir / crop_rel), crop)
                ocr_rows[split].append([crop_rel, texto, "Unknown"])
                estado = "ok" if (con_cab and score >= 0.85) else "revisar"
                color = (0, 200, 0) if estado == "ok" else (0, 165, 255)
                cv2.rectangle(prev, (int(x1), int(y1)), (int(x2), int(y2)), color, 3)
                cv2.putText(prev, f"{texto} ({score:.2f})", (int(x1), max(25, int(y1) - 10)), cv2.FONT_HERSHEY_SIMPLEX, 1.0, color, 3)
            stats[f"{split}:{estado}"] += 1
            (prev_dir / split).mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(prev_dir / split / f"{stem}.jpg"), prev)
            rows_review.append([str(p), grp, split, estado, found[1] if found else "", f"{found[2]:.3f}" if found else ""])

    for split, rows in ocr_rows.items():
        with open(ocr_dir / f"{split}.csv", "w", newline="", encoding="utf-8") as f:
            wr = csv.writer(f)
            wr.writerow(["image_path", "plate_text", "plate_region"])
            wr.writerows(rows)
    with open(out / "revision_anotaciones.csv", "w", newline="", encoding="utf-8") as f:
        wr = csv.writer(f)
        wr.writerow(["foto", "grupo", "split", "estado", "texto", "confianza_ocr"])
        wr.writerows(rows_review)
    (det_dir / "data.yaml").write_text(
        f"path: {det_dir.resolve().as_posix()}\ntrain: images/train\nval: images/val\ntest: images/test\n\nnames:\n  0: license_plate\n",
        encoding="utf-8",
    )
    print("Resumen:", dict(sorted(stats.items())))
    print(f"Revise las vistas previas en {prev_dir} y corrija los casos 'revisar' en revision_anotaciones.csv")


if __name__ == "__main__":
    main()
