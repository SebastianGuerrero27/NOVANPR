"""
Generador de placas vehiculares ecuatorianas sintéticas para entrenar el OCR.

Produce recortes de placa con el formato ANT (cabecera "ECUADOR", 3 letras + 3 o 4
dígitos) y degradaciones realistas: perspectiva, desenfoque, baja resolución,
compresión JPEG, iluminación, sombras y recortes imperfectos como los del detector.

Uso (desde services/anpr):
    .venv/Scripts/python scripts/generate_synthetic_plates.py --n 20000 --out ../../dataset/ocr/synth

Salida: <out>/images/*.jpg y <out>/labels.csv con columnas
image_path,plate_text,plate_region  (formato de fast-plate-ocr; region = "Unknown").

Limitación: los datos sintéticos sirven para adaptar el modelo al formato ecuatoriano,
pero la evaluación de la tesis debe hacerse SOLO con placas reales.
"""

from __future__ import annotations

import argparse
import csv
import os
import random
import string
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Primera letra: código de provincia ANT. Segunda letra: tipo de servicio o secuencia.
PROVINCIAS = "ABCEGHIJKLMNOPQRSTUVWXYZ"
SEGUNDA = string.ascii_uppercase
# Color de la franja superior según el tipo de servicio (aproximado, solo para diversidad visual)
FRANJAS = {
    "particular": None,
    "comercial": (0, 140, 255),   # naranja (BGR)
    "gobierno": (40, 180, 220),   # dorado
    "municipal": (60, 200, 150),  # verde
}

FONT_CANDIDATES = [
    ("C:/Windows/Fonts/bahnschrift.ttf", ["Bold SemiCondensed", "SemiBold SemiCondensed", "Bold Condensed", "SemiBold Condensed"]),
    ("C:/Windows/Fonts/ARIALNB.TTF", None),
    ("C:/Windows/Fonts/ARIALN.TTF", None),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf", None),
]

PLATE_W, PLATE_H = 404, 154  # proporción real 404 x 154 mm


def random_plate_text() -> str:
    letras = random.choice(PROVINCIAS) + random.choice(SEGUNDA) + random.choice(string.ascii_uppercase)
    n_dig = 4 if random.random() < 0.8 else 3  # formato actual 4 dígitos; formato antiguo 3
    digitos = "".join(random.choice(string.digits) for _ in range(n_dig))
    return letras + digitos


def load_fonts(size: int) -> list[ImageFont.FreeTypeFont]:
    fonts = []
    for path, variations in FONT_CANDIDATES:
        if not os.path.exists(path):
            continue
        if variations:
            for v in variations:
                try:
                    f = ImageFont.truetype(path, size)
                    f.set_variation_by_name(v)
                    fonts.append(f)
                except Exception:
                    pass
        else:
            fonts.append(ImageFont.truetype(path, size))
    if not fonts:
        raise RuntimeError("No se encontró ninguna fuente condensada (Bahnschrift / Arial Narrow).")
    return fonts


def fit_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, box_w: int, box_h: int):
    """Escala horizontalmente el texto para ocupar el ancho, como en las placas reales."""
    l, t, r, b = draw.textbbox((0, 0), text, font=font)
    img = Image.new("L", (r - l + 4, b - t + 4), 0)
    ImageDraw.Draw(img).text((2 - l, 2 - t), text, font=font, fill=255)
    return img.resize((box_w, box_h), Image.LANCZOS)


def render_plate(text: str, fonts_big, fonts_small) -> np.ndarray:
    tipo = random.choices(list(FRANJAS), weights=[70, 15, 8, 7])[0]
    fondo = random.randint(215, 250)
    img = Image.new("RGB", (PLATE_W, PLATE_H), (fondo, fondo, fondo))
    draw = ImageDraw.Draw(img)

    franja = FRANJAS[tipo]
    if franja:
        draw.rectangle([0, 0, PLATE_W, 38], fill=franja[::-1])
    # Marco en relieve
    borde = random.randint(20, 70)
    draw.rounded_rectangle([3, 3, PLATE_W - 4, PLATE_H - 4], radius=10, outline=(borde,) * 3, width=random.randint(3, 6))

    # Cabecera "ECUADOR" con los dos agujeros de sujeción
    tinta = random.randint(10, 45)
    header = fit_text(draw, "ECUADOR", random.choice(fonts_small), random.randint(170, 200), random.randint(26, 32))
    hx = (PLATE_W - header.width) // 2
    img.paste((tinta,) * 3, (hx, 7), header)
    for cx in (hx - 40, hx + header.width + 40):
        draw.ellipse([cx - 6, 16, cx + 6, 28], fill=(fondo - 60,) * 3, outline=(tinta,) * 3)

    # Texto principal "ABC-1234"
    principal = f"{text[:3]}-{text[3:]}"
    body = fit_text(draw, principal, random.choice(fonts_big), random.randint(355, 385), random.randint(92, 104))
    img.paste((tinta,) * 3, ((PLATE_W - body.width) // 2, random.randint(42, 50)), body)

    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)


def degrade(plate: np.ndarray, margin_max: float = 0.12) -> tuple[np.ndarray, np.ndarray]:
    """
    Aplica degradaciones de cámara y un recorte imperfecto del detector.
    Retorna (imagen, esquinas) con las 4 esquinas de la placa [sup-izq, sup-der, inf-der, inf-izq]
    normalizadas a [0, 1] respecto a la imagen devuelta (etiquetas exactas para YOLO-pose).
    """
    h, w = plate.shape[:2]
    # Fondo alrededor (la caja del detector rara vez es exacta)
    pad = int(w * 0.25)
    # Tonos poco saturados (carrocería, parachoques, pavimento)
    base = np.random.randint(20, 220)
    bg_color = np.clip(base + np.random.randint(-30, 30, 3), 0, 255).tolist()
    canvas = cv2.copyMakeBorder(plate, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=bg_color)
    canvas = cv2.add(canvas, np.random.randint(0, 40, canvas.shape, dtype=np.uint8))

    # Perspectiva y rotación
    src = np.float32([[pad, pad], [pad + w, pad], [pad + w, pad + h], [pad, pad + h]])
    j = lambda s: np.random.uniform(-s, s)
    k = 0.10 * w
    dst = src + np.float32([[j(k), j(k)], [j(k), j(k)], [j(k), j(k)], [j(k), j(k)]])
    M = cv2.getPerspectiveTransform(src, dst)
    canvas = cv2.warpPerspective(canvas, M, (canvas.shape[1], canvas.shape[0]), borderMode=cv2.BORDER_REPLICATE)

    # Recorte alrededor de la placa con margen aleatorio (a veces corta un poco, como el detector)
    xs, ys = dst[:, 0], dst[:, 1]
    mx, my = np.random.uniform(-0.04, margin_max) * w, np.random.uniform(-0.04, margin_max + 0.03) * h
    x1, y1 = int(max(0, xs.min() - mx)), int(max(0, ys.min() - my))
    x2, y2 = int(min(canvas.shape[1], xs.max() + mx)), int(min(canvas.shape[0], ys.max() + my))
    crop = canvas[y1:y2, x1:x2]
    corners = (dst - np.float32([x1, y1])) / np.float32([max(1, x2 - x1), max(1, y2 - y1)])

    # Iluminación: brillo, contraste y sombra parcial
    crop = cv2.convertScaleAbs(crop, alpha=np.random.uniform(0.6, 1.3), beta=np.random.uniform(-50, 40))
    if random.random() < 0.35:
        mask = np.zeros(crop.shape[:2], np.float32)
        cx = random.randint(0, crop.shape[1])
        mask[:, cx:] = np.random.uniform(0.3, 0.7)
        crop = (crop * (1 - mask[..., None])).astype(np.uint8)

    # Baja resolución (placa lejana) y desenfoque de movimiento / óptico
    scale = np.random.uniform(0.15, 1.0)
    small = cv2.resize(crop, (max(24, int(crop.shape[1] * scale)), max(10, int(crop.shape[0] * scale))), interpolation=cv2.INTER_AREA)
    if random.random() < 0.5:
        ksz = random.choice([3, 5, 7, 9])
        kernel = np.zeros((ksz, ksz), np.float32)
        kernel[ksz // 2, :] = 1.0 / ksz
        if random.random() < 0.5:
            kernel = cv2.warpAffine(kernel, cv2.getRotationMatrix2D((ksz / 2, ksz / 2), random.uniform(0, 180), 1), (ksz, ksz))
            kernel /= max(kernel.sum(), 1e-6)
        small = cv2.filter2D(small, -1, kernel)
    elif random.random() < 0.5:
        small = cv2.GaussianBlur(small, (0, 0), np.random.uniform(0.3, 1.5))

    # Ruido de sensor y compresión JPEG (stream RTSP)
    noise = np.random.normal(0, np.random.uniform(0, 10), small.shape)
    small = np.clip(small.astype(np.float32) + noise, 0, 255).astype(np.uint8)
    ok, enc = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, random.randint(20, 90)])
    out = cv2.imdecode(enc, cv2.IMREAD_COLOR)
    if random.random() < 0.15:
        out = cv2.cvtColor(cv2.cvtColor(out, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)  # cámara IR nocturna
    return out, corners


def pose_label(corners: np.ndarray) -> str:
    """Línea YOLO-pose: clase, caja de la placa y 4 esquinas (x, y, visibilidad)."""
    inside = (corners >= 0).all(axis=1) & (corners <= 1).all(axis=1)
    c = np.clip(corners, 0, 1)
    x1, y1 = c.min(axis=0)
    x2, y2 = c.max(axis=0)
    kpts = " ".join(f"{x:.6f} {y:.6f} {2 if v else 0}" for (x, y), v in zip(c, inside))
    return f"0 {(x1 + x2) / 2:.6f} {(y1 + y2) / 2:.6f} {x2 - x1:.6f} {y2 - y1:.6f} {kpts}\n"


def generate_pose_dataset(args) -> None:
    """Recortes con márgenes amplios (como los del detector) y sus 4 esquinas exactas."""
    random.seed(args.seed)
    np.random.seed(args.seed)
    out = Path(args.pose_out)
    fonts_big, fonts_small = load_fonts(120), load_fonts(40)
    for i in range(args.n):
        split = "val" if i % 10 == 0 else "train"
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)
        img, corners = degrade(render_plate(random_plate_text(), fonts_big, fonts_small), margin_max=0.30)
        cv2.imwrite(str(out / "images" / split / f"pose_{i:06d}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        (out / "labels" / split / f"pose_{i:06d}.txt").write_text(pose_label(corners))
        if (i + 1) % 2000 == 0:
            print(f"  {i + 1}/{args.n} recortes con esquinas", flush=True)
    (out / "data.yaml").write_text(
        f"path: {out.resolve().as_posix()}\ntrain: images/train\nval: images/val\n"
        "kpt_shape: [4, 3]\n"
        "flip_idx: [1, 0, 3, 2]\n"  # al voltear horizontalmente se intercambian izq/der
        "names:\n  0: placa\n",
        encoding="utf-8",
    )
    print(f"Listo: dataset YOLO-pose en {out}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Genera placas ecuatorianas sintéticas para OCR.")
    ap.add_argument("--n", type=int, default=20000)
    ap.add_argument("--out", default="../../dataset/ocr/synth")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--pose-out", default="",
                    help="Genera en su lugar un dataset YOLO-pose de esquinas (para scripts/train_plate_rectifier.py)")
    args = ap.parse_args()
    if args.pose_out:
        generate_pose_dataset(args)
        return

    random.seed(args.seed)
    np.random.seed(args.seed)
    out = Path(args.out)
    (out / "images").mkdir(parents=True, exist_ok=True)
    fonts_big, fonts_small = load_fonts(120), load_fonts(40)

    with open(out / "labels.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["image_path", "plate_text", "plate_region"])
        for i in range(args.n):
            text = random_plate_text()
            img, _ = degrade(render_plate(text, fonts_big, fonts_small))
            name = f"images/synth_{i:06d}.jpg"
            cv2.imwrite(str(out / name), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
            w.writerow([name, text, "Unknown"])
            if (i + 1) % 2000 == 0:
                print(f"  {i + 1}/{args.n} placas generadas", flush=True)
    print(f"Listo: {args.n} placas en {out}")


if __name__ == "__main__":
    main()
