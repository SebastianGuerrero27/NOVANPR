"""
Ablaciones del reconocimiento de placas: cuánto aporta cada componente del sistema.

Unidad de evaluación: el EVENTO (un paso vehicular = varios recortes del mismo vehículo),
porque así decide el sistema real. Variantes (una pieza quitada o cambiada a la vez):

  completo            consenso entre frames + verificador PP-OCRv6 + reglas ANT, sin preprocesado
  sin_verificador     sin la segunda lectura PP-OCRv6
  sin_consenso        decide con un solo frame (el más nítido), como un ANPR sin tracking
  con_preprocesado    agrega CLAHE + bilateral + unsharp antes del OCR
  sin_reglas_ant      sin la corrección de homoglifos por posición (formato ANT)
  solo_verificador    solo PP-OCRv6 sobre el frame más nítido
  con_rectificador    endereza cada recorte con YOLO26n-pose (4 esquinas) antes del OCR (--rectifier)

Cada variante se compara con `completo` mediante McNemar exacto (scripts/estadistica.py).

Uso (desde services/anpr):
    .venv/Scripts/python scripts/run_ablations.py --labels scripts/benchmark_labels.csv
    .venv/Scripts/python scripts/run_ablations.py --labels ... --ocr-model models/ocr/cct_s_v2_ecuador_candidato.onnx
    .venv/Scripts/python scripts/run_ablations.py --plan-entrenamiento    # ablaciones que requieren reentrenar

El CSV de etiquetas tiene columnas archivo,placa y opcionalmente evento. Si no hay columna
evento, se agrupan los recortes cuya fecha/hora (en el nombre) difiere menos de --gap segundos.
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import cv2

SERVICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVICE_DIR))

_spec = importlib.util.spec_from_file_location("estadistica", SERVICE_DIR / "scripts" / "estadistica.py")
est = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(est)

VERIFIER_WEIGHT = 2.0

PLAN_ENTRENAMIENTO = """
Ablaciones que requieren reentrenar (ejecutar en .venv-train, repetir con --seed 1 2 3):

  Datos sintéticos en el OCR
    python scripts/train_ocr.py --synth-max 0    --seed 1   # solo placas reales
    python scripts/train_ocr.py --synth-max 6000 --seed 1   # real + sintético (propuesto)

  Método de etiquetado del detector (circular vs anclado en texto)
    python scripts/annotate_plates.py --src ... --circular-model models/license_plate_detector.pt --out ../../dataset_circular
    python scripts/annotate_plates.py --src ... --out ../../dataset                     # anclado en texto (propuesto)
    python scripts/train_plate_detector.py --arch yolo26n --seed 1   (con cada dataset)

  Arquitectura del detector
    python scripts/train_plate_detector.py --arch yolo26n     --seed 1
    python scripts/train_plate_detector.py --arch rfdetr-nano --seed 1

Luego: scripts/evaluate_detectors.py --save-preds ... y scripts/estadistica.py comparar / semillas.
"""


def norm(t: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (t or "").upper())


def timestamp(fname: str):
    m = re.search(r"(20\d{6})_(\d{6})", fname)
    return datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S") if m else None


def group_events(rows: list[dict], gap_s: float) -> dict[str, list[dict]]:
    if rows and rows[0].get("evento"):
        ev = defaultdict(list)
        for r in rows:
            ev[r["evento"]].append(r)
        return dict(ev)
    rows = sorted(rows, key=lambda r: (timestamp(r["archivo"]) or datetime.min, r["archivo"]))
    events, last, k = {}, None, 0
    for r in rows:
        t = timestamp(r["archivo"])
        if last is None or t is None or (t - last).total_seconds() > gap_s:
            k += 1
        events.setdefault(f"evento_{k:03d}", []).append(r)
        last = t
    return events


def vote(reads: list[tuple[str, float]]) -> str:
    """Consenso ponderado por confianza (misma lógica que el tracker en producción)."""
    c: Counter = Counter()
    for plate, w in reads:
        if plate:
            c[plate] += max(0.05, w)
    return c.most_common(1)[0][0] if c else ""


def main() -> None:
    ap = argparse.ArgumentParser(description="Ablaciones del reconocimiento de placas.")
    ap.add_argument("--labels", default=str(SERVICE_DIR / "scripts" / "benchmark_labels.csv"))
    ap.add_argument("--media", default=str(SERVICE_DIR / "media"))
    ap.add_argument("--ocr-model", default="cct-s-v2-global-model", help="Modelo del hub o ruta a .onnx afinado")
    ap.add_argument("--gap", type=float, default=90.0, help="Segundos máximos entre recortes del mismo evento")
    ap.add_argument("--save-preds", default="", help="Carpeta para predicciones por evento (una por variante)")
    ap.add_argument("--rectifier", default="", help="Modelo YOLO26n-pose de esquinas para la variante con_rectificador")
    ap.add_argument("--plan-entrenamiento", action="store_true", help="Solo muestra las ablaciones que requieren reentrenar")
    args = ap.parse_args()

    if args.plan_entrenamiento:
        print(PLAN_ENTRENAMIENTO)
        return

    from fast_plate_ocr import LicensePlateRecognizer
    from app.aplicacion.detector import compute_crop_sharpness
    from app.infraestructura.ocr_engine import preprocess_plate_opencv
    from app.infraestructura.ocr_verifier import PlateOcrVerifier
    from app.dominio.plate_parser import disambiguate_plate

    if args.ocr_model.endswith(".onnx"):
        rec = LicensePlateRecognizer(onnx_model_path=args.ocr_model,
                                     plate_config_path=args.ocr_model.replace(".onnx", "_plate_config.yaml"), device="cpu")
    else:
        rec = LicensePlateRecognizer(hub_ocr_model=args.ocr_model, device="cpu")
    gray = getattr(rec.config, "image_color_mode", "rgb") == "grayscale"
    verifier = PlateOcrVerifier(model_type="medium", engine="openvino")
    rectifier = None
    if args.rectifier:
        from app.infraestructura.plate_rectifier import PlateRectifier
        rectifier = PlateRectifier(args.rectifier)
    rect_ok = [0, 0]  # [rectificados, total]

    def ocr(img):
        x = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY if gray else cv2.COLOR_BGR2RGB)
        p = rec.run(x, return_confidence=True)[0]
        probs = getattr(p, "char_probs", None)
        conf = float(probs.mean()) if probs is not None and len(probs) else 0.5
        return norm(p.plate), conf

    rules = lambda t: norm(disambiguate_plate(t)) if t else ""

    rows = [r for r in csv.DictReader(open(args.labels, encoding="utf-8")) if r.get("placa", "").strip()]
    events = group_events(rows, args.gap)
    print(f"Recortes: {len(rows)} | eventos: {len(events)} | OCR: {args.ocr_model}\n")

    # Lecturas por frame (una sola vez) y del verificador sobre el frame más nítido de cada evento
    frames: dict[str, list[dict]] = {}
    for ev, items in events.items():
        lst = []
        for r in items:
            img = cv2.imread(os.path.join(args.media, r["archivo"]))
            if img is None:
                continue
            raw, conf = ocr(img)
            raw_pre, conf_pre = ocr(preprocess_plate_opencv(img))
            raw_rect, conf_rect = raw, conf
            if rectifier is not None:
                rect = rectifier.rectify(img)
                rect_ok[1] += 1
                if rect is not None:  # si no hay esquinas confiables se usa el recorte original
                    rect_ok[0] += 1
                    raw_rect, conf_rect = ocr(rect.image)
            lst.append({"img": img, "gt": norm(r["placa"]), "raw": raw, "conf": conf,
                        "raw_pre": raw_pre, "conf_pre": conf_pre, "raw_rect": raw_rect, "conf_rect": conf_rect,
                        "sharp": compute_crop_sharpness(img)})
        if lst:
            best = max(lst, key=lambda f: f["sharp"])
            v = verifier.read(best["img"])
            frames[ev] = lst
            frames[ev + "#verif"] = [{"plate": v.plate if v.within_budget else "", "conf": v.confidence}]

    ev_ids = [e for e in frames if not e.endswith("#verif")]
    gt = {e: frames[e][0]["gt"] for e in ev_ids}

    def completo(e, verificador=True, reglas=True, pre=False, consenso=True, rect=False):
        fs = frames[e]
        key, ck = ("raw_pre", "conf_pre") if pre else ("raw_rect", "conf_rect") if rect else ("raw", "conf")
        fix = rules if reglas else norm
        if consenso:
            reads = [(fix(f[key]), f[ck]) for f in fs]
        else:
            best = max(fs, key=lambda f: f["sharp"])
            reads = [(fix(best[key]), best[ck])]
        if verificador:
            v = frames[e + "#verif"][0]
            reads.append((v["plate"], v["conf"] * VERIFIER_WEIGHT))
        return vote(reads)

    variantes = {
        "completo": lambda e: completo(e),
        "sin_verificador": lambda e: completo(e, verificador=False),
        "sin_consenso": lambda e: completo(e, consenso=False, verificador=False),
        "con_preprocesado": lambda e: completo(e, pre=True),
        "sin_reglas_ant": lambda e: completo(e, reglas=False),
        "solo_verificador": lambda e: frames[e + "#verif"][0]["plate"],
    }
    if rectifier is not None:
        variantes["con_rectificador"] = lambda e: completo(e, rect=True)
        print(f"Rectificador: esquinas confiables en {rect_ok[0]}/{rect_ok[1]} recortes\n")

    preds = {name: {e: fn(e) for e in ev_ids} for name, fn in variantes.items()}
    ok = {name: {e: preds[name][e] == gt[e] for e in ev_ids} for name in variantes}
    print("| Variante | Exactitud por evento | Δ vs completo | McNemar p |")
    print("|---|---|---|---|")
    base = ok["completo"]
    for name in variantes:
        acc = sum(ok[name].values()) / len(ev_ids)
        solo_base = sum(base[e] and not ok[name][e] for e in ev_ids)
        solo_var = sum(ok[name][e] and not base[e] for e in ev_ids)
        p = est.mcnemar_exact(solo_base, solo_var) if name != "completo" else float("nan")
        delta = (acc - sum(base.values()) / len(ev_ids)) * 100
        print(f"| {name} | {acc:.1%} ({sum(ok[name].values())}/{len(ev_ids)}) | "
              f"{'—' if name == 'completo' else f'{delta:+.1f} pp'} | {'—' if name == 'completo' else f'{p:.3f}'} |")
        if args.save_preds:
            Path(args.save_preds).mkdir(parents=True, exist_ok=True)
            with open(Path(args.save_preds) / f"preds_ablacion_{name}.csv", "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(["id", "gt", "pred"])
                w.writerows([(e, gt[e], preds[name][e]) for e in ev_ids])

    if len(ev_ids) < 50:
        print(f"\n[!] Solo {len(ev_ids)} eventos: las diferencias no alcanzarán significancia estadística. "
              "Para el artículo se necesitan cientos de pasos vehiculares.")


if __name__ == "__main__":
    main()
