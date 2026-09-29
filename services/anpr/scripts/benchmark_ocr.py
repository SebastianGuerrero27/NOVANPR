"""
Benchmark de motores OCR sobre recortes de placa etiquetados manualmente.

Uso (desde services/anpr):
    .venv/Scripts/python scripts/benchmark_ocr.py --labels scripts/benchmark_labels.csv

El CSV tiene columnas: archivo,placa  (placa sin guion; vacío = excluir del cálculo).
Métricas por motor:
  - exactitud: lectura idéntica a la etiqueta (normalizada A-Z0-9).
  - CER: distancia de edición / longitud de la etiqueta (menor es mejor).
  - ms: latencia media por recorte en CPU (sin contar la carga del modelo).
Cada motor se evalúa "crudo" y con el post-proceso ecuatoriano del sistema
(disambiguate_plate), para separar el aporte del modelo del de las reglas.
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import sys
import time
import warnings

import cv2
import numpy as np

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def norm(t: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (t or "").upper())


def levenshtein(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return prev[len(b)]


def best_plate_text(texts: list[str]) -> str:
    """Une los fragmentos leídos y descarta la cabecera 'ECUADOR'."""
    joined = norm("".join(t for t in texts if "ECUAD" not in norm(t)))
    m = re.search(r"[A-Z]{2,3}\d{3,4}", joined)
    return m.group(0) if m else joined


# ---------------------------------------------------------------------------
# Motores
# ---------------------------------------------------------------------------

def engine_fast_plate(model_name: str):
    from fast_plate_ocr import LicensePlateRecognizer
    if model_name.endswith(".onnx"):
        cfg = model_name.replace(".onnx", "_plate_config.yaml")
        rec = LicensePlateRecognizer(onnx_model_path=model_name, plate_config_path=cfg, device="cpu")
    else:
        rec = LicensePlateRecognizer(hub_ocr_model=model_name, device="cpu")
    mode = getattr(rec.config, "image_color_mode", "rgb")

    def run(img):
        x = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if mode == "grayscale" else cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        preds = rec.run(x)
        p = preds[0]
        return norm(getattr(p, "plate", p))
    return run


def engine_rapidocr():
    from rapidocr_onnxruntime import RapidOCR
    eng = RapidOCR(use_angle_cls=False)

    def run(img):
        res, _ = eng(img)
        return best_plate_text([r[1] for r in (res or [])])
    return run


def engine_easyocr():
    import easyocr
    reader = easyocr.Reader(["en"], gpu=False, verbose=False)

    def run(img):
        res = reader.readtext(img, allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-")
        res = sorted(res, key=lambda r: (r[0][0][1] // 30, r[0][0][0]))
        return best_plate_text([r[1] for r in res])
    return run


def engine_ppocrv6():
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(
        text_detection_model_name="PP-OCRv6_medium_det",
        text_recognition_model_name="PP-OCRv6_medium_rec",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        enable_mkldnn=False,  # evita un fallo de oneDNN en Paddle 3.3 sobre CPU
    )

    def run(img):
        out = ocr.predict(img)
        texts = []
        for r in out:
            texts.extend(r.get("rec_texts", []) if isinstance(r, dict) else r["rec_texts"])
        return best_plate_text(texts)
    return run


def engine_sistema_actual():
    """Pipeline en producción: PlateEnhancementAgent + motor híbrido (config .env)."""
    from app.core.plate_agent import PlateEnhancementAgent
    agent = PlateEnhancementAgent()

    def run(img):
        h, w = img.shape[:2]
        res = agent.process_image(img, initial_bbox=[0, 0, w, h], fast_mode=False)
        return norm(res.placa)
    return run


ENGINES = {
    "fast-plate-ocr cct-s-v2-global": lambda: engine_fast_plate("cct-s-v2-global-model"),
    "cct-s-v2 afinado Ecuador": lambda: engine_fast_plate(
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "ocr", "cct_s_v2_ecuador_candidato.onnx")),
    "fast-plate-ocr mobile-vit-v2 (actual)": lambda: engine_fast_plate("global-plates-mobile-vit-v2-model"),
    "RapidOCR PP-OCRv4": engine_rapidocr,
    "EasyOCR": engine_easyocr,
    "PaddleOCR PP-OCRv6": engine_ppocrv6,
    "Sistema actual (agente + híbrido)": engine_sistema_actual,
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", required=True)
    ap.add_argument("--media", default="media")
    ap.add_argument("--only", default="", help="subcadena para evaluar solo algunos motores")
    ap.add_argument("--days", nargs="*", default=[], help="Evaluar solo recortes de estas fechas (YYYYMMDD)")
    ap.add_argument("--save-preds", default="", help="Carpeta donde guardar las predicciones por muestra (para McNemar)")
    args = ap.parse_args()

    from app.utils.plate_parser import disambiguate_plate

    rows = [r for r in csv.DictReader(open(args.labels, encoding="utf-8")) if r["placa"].strip()]
    if args.days:
        rows = [r for r in rows if any(f"_{d}_" in r["archivo"] for d in args.days)]
    data = [(r["archivo"], norm(r["placa"]), cv2.imread(os.path.join(args.media, r["archivo"]))) for r in rows]
    data = [d for d in data if d[2] is not None]
    print(f"Recortes evaluados: {len(data)}\n")
    print(f"{'motor':40s} {'exact.':>7s} {'exact+reglas':>13s} {'CER':>6s} {'ms':>7s}")

    for name, factory in ENGINES.items():
        if args.only and args.only.lower() not in name.lower():
            continue
        try:
            run = factory()
            run(data[0][2])  # calentamiento
        except Exception as e:  # motor no disponible
            print(f"{name:40s} no disponible: {e}")
            continue
        ok = ok_rules = 0
        cer_sum = 0.0
        t_total = 0.0
        errores = []
        preds = []
        for fname, gt, img in data:
            t0 = time.perf_counter()
            try:
                pred = run(img)
            except Exception:
                pred = ""
            t_total += time.perf_counter() - t0
            post = norm(disambiguate_plate(pred)) if pred else ""
            preds.append((fname, gt, post))
            ok += pred == gt
            ok_rules += post == gt
            cer_sum += levenshtein(post or pred, gt) / len(gt)
            if post != gt:
                errores.append(f"{fname}:{post or pred or '∅'}")
        n = len(data)
        print(f"{name:40s} {ok / n:7.1%} {ok_rules / n:13.1%} {cer_sum / n:6.3f} {t_total / n * 1000:7.0f}", flush=True)
        if args.save_preds:
            os.makedirs(args.save_preds, exist_ok=True)
            slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
            with open(os.path.join(args.save_preds, f"preds_{slug}.csv"), "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(["id", "gt", "pred"])
                w.writerows(preds)
        if errores:
            print(f"    errores ({len(errores)}): {', '.join(errores[:8])}{' ...' if len(errores) > 8 else ''}")


if __name__ == "__main__":
    main()
