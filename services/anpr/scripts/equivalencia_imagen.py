"""
Equivalencia del motor entre dos imágenes de Docker (mismo código y modelos, distintos paquetes).

Sirve para validar un cambio de dependencias (requirements.txt) o de la variante de PyTorch: se
corre en cada imagen con el código del repositorio montado y se comparan las salidas.

  salidas <json>     detector de placas (YOLO), OCR de placas, verificador PP-OCRv6 y atributos del
                     vehículo (CLIP) sobre las capturas reales media/ingreso_*.jpg
  comparar <a> <b>   diferencias captura por captura (cajas, textos, confianzas)
  tiempos <etiqueta> mediana del detector y del reconocedor de vehículo en 40 capturas (2 pasadas);
                     alternar las imágenes varias rondas (A B, B A, …): los tiempos absolutos de
                     este portátil varían mucho a lo largo del día

Ejemplo (Docker Desktop en Windows, desde la raíz del repositorio):
  docker run --rm -v "$PWD/services/anpr:/app" -v anpr_anpr_model_cache:/root/.cache \\
    --entrypoint python anpr-anpr:<etiqueta> scripts/equivalencia_imagen.py salidas /app/media/eq_<etiqueta>.json

Resultado del cambio a PyTorch solo CPU (2026-10-08): docs/resultados/imagen_cpu_equivalencia.json
"""
from __future__ import annotations

import glob
import json
import os
import sys
import time

import numpy as np

CAPTURAS = "/app/media/ingreso_*.jpg"


def _componentes(con_ocr: bool = True):
    sys.path.insert(0, "/app")
    os.chdir("/app")
    from app.infraestructura.config import PLATE_MODEL_PATH
    from app.infraestructura.detectors import create_detector
    from app.infraestructura.vehicle_attributes import get_vehicle_recognizer

    detector = create_detector(PLATE_MODEL_PATH, model_type="yolo", confidence=0.09, device="cpu", imgsz=512)
    detector.warmup()
    ocr = verificador = None
    if con_ocr:
        from app.infraestructura.ocr_engine import create_ocr_engine
        from app.infraestructura.ocr_verifier import get_verifier
        ocr, verificador = create_ocr_engine(), get_verifier()
    return PLATE_MODEL_PATH, detector, ocr, verificador, get_vehicle_recognizer()


def salidas(destino: str) -> None:
    import cv2
    import onnxruntime
    import torch
    import ultralytics

    modelo, detector, ocr, verificador, vehiculo = _componentes()
    resultado = {
        "versiones": {"torch": torch.__version__, "cv2": cv2.__version__, "numpy": np.__version__,
                      "ultralytics": ultralytics.__version__, "onnxruntime": onnxruntime.__version__,
                      "hilos_torch": torch.get_num_threads(), "detector": modelo, "ocr": ocr.engine_name},
        "imagenes": {},
    }
    for ruta in sorted(glob.glob(CAPTURAS)):
        img = cv2.imread(ruta)
        dets = detector.predict(img)
        fila = {"det": [[round(float(v), 2) for v in d.bbox] + [round(float(d.confidence), 4)] for d in dets]}
        if dets:
            d = max(dets, key=lambda x: x.confidence)
            x1, y1, x2, y2 = (int(v) for v in d.bbox)
            recorte = img[max(0, y1):y2, max(0, x1):x2]
            fila["ocr"] = [[r.text, round(float(r.confidence), 4)] for r in ocr.read_text(recorte)]
            if verificador:
                v = verificador.read(recorte)
                fila["ver"] = [v.plate, round(float(v.confidence), 4)]
            if vehiculo:
                a = vehiculo.analyze(img, [x1, y1, x2, y2])
                fila["veh"] = [a.tipo, round(float(a.tipo_conf), 4), a.color, round(float(a.color_conf), 4),
                               a.marca, round(float(a.marca_conf), 4), a.modelo, round(float(a.modelo_conf), 4)]
        resultado["imagenes"][os.path.basename(ruta)] = fila
    json.dump(resultado, open(destino, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(resultado['imagenes'])} capturas · {resultado['versiones']}")


def _iou(p, q) -> float:
    x1, y1, x2, y2 = max(p[0], q[0]), max(p[1], q[1]), min(p[2], q[2]), min(p[3], q[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    area = lambda r: max(0, r[2] - r[0]) * max(0, r[3] - r[1])  # noqa: E731
    union = area(p) + area(q) - inter
    return inter / union if union else 1.0


def comparar(ruta_a: str, ruta_b: str) -> dict:
    a, b = (json.load(open(r, encoding="utf-8")) for r in (ruta_a, ruta_b))
    dif = {"cantidad_cajas": 0, "texto_ocr": 0, "texto_verificador": 0, "etiquetas_vehiculo": 0}
    iou_min, max_conf, max_ocr, max_ver, max_veh = 1.0, 0.0, 0.0, 0.0, 0.0
    for nombre, fa in a["imagenes"].items():
        fb = b["imagenes"].get(nombre, {})
        da, db = fa.get("det", []), fb.get("det", [])
        if len(da) != len(db):
            dif["cantidad_cajas"] += 1
        for p, q in zip(sorted(da), sorted(db)):
            iou_min, max_conf = min(iou_min, _iou(p[:4], q[:4])), max(max_conf, abs(p[4] - q[4]))
        oa, ob = fa.get("ocr", []), fb.get("ocr", [])
        if [t for t, _ in oa] != [t for t, _ in ob]:
            dif["texto_ocr"] += 1
        else:
            max_ocr = max([max_ocr] + [abs(x[1] - y[1]) for x, y in zip(oa, ob)])
        va, vb = fa.get("ver"), fb.get("ver")
        if (va or [None])[0] != (vb or [None])[0]:
            dif["texto_verificador"] += 1
        elif va and vb:
            max_ver = max(max_ver, abs(va[1] - vb[1]))
        ea, eb = fa.get("veh"), fb.get("veh")
        if bool(ea) != bool(eb) or (ea and [ea[i] for i in (0, 2, 4, 6)] != [eb[i] for i in (0, 2, 4, 6)]):
            dif["etiquetas_vehiculo"] += 1
        elif ea:
            max_veh = max([max_veh] + [abs(ea[i] - eb[i]) for i in (1, 3, 5, 7)])
    resumen = {"capturas": len(a["imagenes"]), "con_placa": sum(1 for f in a["imagenes"].values() if f.get("det")),
               "diferencias": dif, "iou_minima": round(iou_min, 4), "max_delta_confianza_detector": round(max_conf, 4),
               "max_delta_confianza_ocr": round(max_ocr, 4), "max_delta_confianza_verificador": round(max_ver, 4),
               "max_delta_puntaje_vehiculo": round(max_veh, 4), "versiones_a": a["versiones"], "versiones_b": b["versiones"]}
    print(json.dumps(resumen, ensure_ascii=False, indent=1))
    return resumen


def tiempos(etiqueta: str) -> None:
    import cv2
    import torch

    _, detector, _, _, vehiculo = _componentes(con_ocr=False)
    imgs = [cv2.imread(r) for r in sorted(glob.glob(CAPTURAS))[:40]]
    for img in imgs[:3]:  # calentamiento
        d = detector.predict(img)
        if d and vehiculo:
            vehiculo.analyze(img, [int(v) for v in d[0].bbox])
    t_det, t_veh = [], []
    for _ in range(2):
        for img in imgs:
            t0 = time.perf_counter()
            d = detector.predict(img)
            t_det.append((time.perf_counter() - t0) * 1000)
            if d and vehiculo:
                t0 = time.perf_counter()
                vehiculo.analyze(img, [int(v) for v in max(d, key=lambda x: x.confidence).bbox])
                t_veh.append((time.perf_counter() - t0) * 1000)
    print(f"{etiqueta} torch={torch.__version__} hilos={torch.get_num_threads()} "
          f"detector={np.median(t_det):.1f} ms vehiculo={np.median(t_veh):.1f} ms")


if __name__ == "__main__":
    modo, *argumentos = sys.argv[1:]
    {"salidas": salidas, "comparar": comparar, "tiempos": tiempos}[modo](*argumentos)
