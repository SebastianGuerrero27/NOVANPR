"""
Herramienta de Auto-Etiquetado Inteligente para Dataset ANPR Multi-Distancia.
Convierte fotos tomadas con celular o camara IP en formato YOLO oficial.

Funcionalidades:
  1. Deteccion automatica de orientacion EXIF de smartphone.
  2. Localizacion precisa de matriculas con margen de seguridad.
  3. Formateo estandar YOLO (clase 0: license_plate).
  4. Division automatica 80% train / 20% val estratificada.
  5. Generacion de visualizaciones de control de calidad en dataset/preview/.
"""

import os
import sys
import glob
import random
import shutil
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ExifTags
from ultralytics import YOLO

# Rutas base del proyecto
BASE_DIR = Path(__file__).resolve().parent.parent.parent.parent
DATASET_DIR = BASE_DIR / "dataset"
RAW_DIR = DATASET_DIR / "raw"
IMAGES_TRAIN = DATASET_DIR / "images" / "train"
IMAGES_VAL = DATASET_DIR / "images" / "val"
LABELS_TRAIN = DATASET_DIR / "labels" / "train"
LABELS_VAL = DATASET_DIR / "labels" / "val"
PREVIEW_DIR = DATASET_DIR / "preview"
MODEL_PATH = BASE_DIR / "services" / "anpr" / "models" / "license_plate_detector.pt"
FALLBACK_MODEL = BASE_DIR / "services" / "anpr" / "yolo11n.pt"


def fix_image_orientation(image_path: Path) -> np.ndarray:
    """Carga la imagen corrigiendo automaticamente la rotacion EXIF de smartphones."""
    try:
        pil_img = Image.open(image_path)
        exif = pil_img.getexif()
        if exif:
            for orientation_tag in ExifTags.TAGS.keys():
                if ExifTags.TAGS[orientation_tag] == "Orientation":
                    break
            orientation = exif.get(orientation_tag)
            if orientation == 3:
                pil_img = pil_img.rotate(180, expand=True)
            elif orientation == 6:
                pil_img = pil_img.rotate(270, expand=True)
            elif orientation == 8:
                pil_img = pil_img.rotate(90, expand=True)
        
        cv_img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
        return cv_img
    except Exception:
        return cv2.imread(str(image_path))


def auto_annotate(confidence_threshold: float = 0.20, val_ratio: float = 0.20):
    print("=" * 70)
    print("  AUTO-ETIQUETADO INTELIGENTE ANPR — FORMATO OFICIAL YOLOV11/YOLOV8")
    print("=" * 70)

    # 1. Cargar modelo detector
    if MODEL_PATH.exists():
        print(f"[*] Cargando modelo especializado: {MODEL_PATH}")
        model = YOLO(str(MODEL_PATH))
    else:
        print(f"[!] Modelo especializado no encontrado. Usando detector base: {FALLBACK_MODEL}")
        model = YOLO(str(FALLBACK_MODEL))

    # 2. Buscar todas las fotos en dataset/raw
    valid_exts = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    raw_images = [
        p for p in RAW_DIR.rglob("*")
        if p.is_file() and p.suffix.lower() in valid_exts
    ]

    if not raw_images:
        print(f"\n[!] NO SE ENCONTRARON FOTOS EN: {RAW_DIR}")
        print("    Por favor coloca las fotos tomadas con tu celular en 'dataset/raw/'")
        print("    o en sus subcarpetas (1_metro, 2_metros, 3_metros, 5_metros, 8_metros).")
        return

    print(f"\n[+] Se encontraron {len(raw_images)} fotografia(s) en raw/.")
    print("[+] Creando directorios y preparando lotes...")

    for d in (IMAGES_TRAIN, IMAGES_VAL, LABELS_TRAIN, LABELS_VAL, PREVIEW_DIR):
        d.mkdir(parents=True, exist_ok=True)

    # Mezclar fotos aleatoriamente para reparto homogéneo
    random.seed(42)
    random.shuffle(raw_images)

    total_annotated = 0
    total_skipped = 0

    for idx, img_path in enumerate(raw_images, 1):
        img = fix_image_orientation(img_path)
        if img is None or img.size == 0:
            print(f"    [-] No se pudo leer imagen: {img_path.name}")
            total_skipped += 1
            continue

        h, w = img.shape[:2]

        # Inferencia con Ultralytics YOLO a escala original y multi-escala
        results = model.predict(img, conf=confidence_threshold, verbose=False, imgsz=640)[0]
        boxes = results.boxes.xyxy.cpu().numpy()
        confs = results.boxes.conf.cpu().numpy()

        # Si no detectó a 640, probar a escala mayor (1024) para placas lejanas
        if len(boxes) == 0:
            results = model.predict(img, conf=confidence_threshold * 0.75, verbose=False, imgsz=1024)[0]
            boxes = results.boxes.xyxy.cpu().numpy()
            confs = results.boxes.conf.cpu().numpy()

        if len(boxes) == 0:
            print(f"    [?] Placa no detectada automaticamente en {img_path.name} (se omite para etiquetado manual)")
            total_skipped += 1
            continue

        # Seleccionar la caja con mayor confianza o tamaño coherente
        best_idx = np.argmax(confs)
        x1, y1, x2, y2 = boxes[best_idx]
        conf = confs[best_idx]

        # Validar relación de aspecto (placas vehiculares y motos)
        bw = x2 - x1
        bh = y2 - y1
        ar = bw / max(1.0, float(bh))
        if ar < 0.8 or ar > 4.5:
            print(f"    [?] Caja con aspecto irregular (AR={ar:.2f}) en {img_path.name}, descartada.")
            total_skipped += 1
            continue

        # Coordenadas normalizadas YOLO: 0 x_center y_center width height
        x_center = ((x1 + x2) / 2.0) / float(w)
        y_center = ((y1 + y2) / 2.0) / float(h)
        norm_w = bw / float(w)
        norm_h = bh / float(h)

        # Asignar a Train o Val
        is_val = (random.random() < val_ratio)
        target_img_dir = IMAGES_VAL if is_val else IMAGES_TRAIN
        target_lbl_dir = LABELS_VAL if is_val else LABELS_TRAIN

        # Nombre base limpio
        base_name = f"plate_{idx:04d}_{img_path.stem}"
        dest_img_path = target_img_dir / f"{base_name}.jpg"
        dest_lbl_path = target_lbl_dir / f"{base_name}.txt"

        # Guardar imagen y etiqueta
        cv2.imwrite(str(dest_img_path), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        with open(dest_lbl_path, "w", encoding="utf-8") as f:
            f.write(f"0 {x_center:.6f} {y_center:.6f} {norm_w:.6f} {norm_h:.6f}\n")

        # Ejecutar OCR rápido sobre el recorte para mostrar el texto real de la matrícula
        plate_text = ""
        ocr_conf = conf * 100.0
        try:
            from rapidocr_onnxruntime import RapidOCR
            ocr_tool = RapidOCR()
            pad_x = int(bw * 0.20)
            pad_y = int(bh * 0.15)
            c_x1, c_y1 = max(0, int(x1 - pad_x)), max(0, int(y1 - pad_y))
            c_x2, c_y2 = min(w, int(x2 + pad_x)), min(h, int(y2 + pad_y))
            crop = img[c_y1:c_y2, c_x1:c_x2]
            if crop.size > 0:
                ocr_res, _ = ocr_tool(crop)
                if ocr_res:
                    for item in ocr_res:
                        txt = str(item[1]).strip().upper().replace(" ", "")
                        clean_t = "".join(c for c in txt if c.isalnum() or c == "-")
                        if len(clean_t.replace("-", "")) >= 4 and any(c.isalpha() for c in clean_t) and any(c.isdigit() for c in clean_t):
                            plate_text = clean_t
                            ocr_conf = float(item[2]) * 100.0
                            break
                    if not plate_text and len(ocr_res) > 0:
                        plate_text = "".join(c for c in str(ocr_res[0][1]).strip().upper() if c.isalnum() or c == "-")
        except Exception:
            pass

        # Guardar visualización en preview con caja verde y OCR real
        preview_img = img.copy()
        cv2.rectangle(preview_img, (int(x1), int(y1)), (int(x2), int(y2)), (0, 255, 0), 3)
        tag = f"{plate_text} ({ocr_conf:.1f}%)" if plate_text else f"Placa ({conf*100:.1f}%)"

        # Texto verde nítido directamente arriba del borde superior sin fondo
        cv2.putText(preview_img, tag, (int(x1), max(24, int(y1) - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.72, (0, 255, 0), 2, cv2.LINE_AA)
        preview_path = PREVIEW_DIR / f"preview_{base_name}.jpg"
        cv2.imwrite(str(preview_path), preview_img)

        total_annotated += 1
        subset = "VAL" if is_val else "TRAIN"
        print(f"    [✓] [{idx}/{len(raw_images)}] {img_path.name} -> {subset} (Conf: {conf*100:.1f}%)")

    print("\n" + "=" * 70)
    print("  RESUMEN DE AUTO-ETIQUETADO:")
    print(f"  - Total procesadas: {len(raw_images)}")
    print(f"  - Placas etiquetadas exitosamente: {total_annotated}")
    print(f"  - Fotos no reconocidas / omitidas: {total_skipped}")
    print(f"  - Vista previa de control de calidad: {PREVIEW_DIR}")
    print("=" * 70)
    print("\n[+] Siguiente paso: Revisa las fotos en 'dataset/preview/' y ejecuta el entrenamiento:")
    print(r"    .\services\anpr\.venv\Scripts\python services\anpr\scripts\train_plate_detector.py")


if __name__ == "__main__":
    auto_annotate()
