"""
Resumen de los A/B pareados de tiempo real hechos con scripts/evaluar_secuencias.py.

Cada corrida es un JSON del evaluador llamado <experimento>_<brazo>_<réplica>.json (p. ej.
tope_A_1.json, hilos_8_2.json). Las réplicas alternan el orden de los brazos. Se compara:

  - latencia captura → registro de cada paso, pareada por (réplica, paso): mediana de las
    diferencias y prueba de signos exacta;
  - lecturas válidas sobre registros (IC 95 % de Wilson);
  - cuadros analizados por segundo y latencia de la lectura en vivo (p50) por corrida;
  - tiempo del detector por cuadro (p50/p95 de la etapa) por corrida.

Uso: python scripts/resumir_ab_tiempo_real.py <carpeta> <experimento> <brazo_A> <brazo_B> [--salida x.json]
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import re
import statistics


def wilson(exitos: int, n: int, z: float = 1.96):
    if n == 0:
        return None
    p = exitos / n
    centro = (p + z * z / (2 * n)) / (1 + z * z / n)
    margen = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return {"valor": round(p, 3), "ic95": [round(max(0.0, centro - margen), 3), round(min(1.0, centro + margen), 3)], "n": n}


def signos(diferencias: list[float]) -> float:
    """p bilateral exacto de la prueba de signos (sin contar empates)."""
    pos, neg = sum(d > 0 for d in diferencias), sum(d < 0 for d in diferencias)
    n = pos + neg
    if n == 0:
        return 1.0
    k = min(pos, neg)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def percentil(valores: list[float], q: float):
    if not valores:
        return None
    v = sorted(valores)
    return round(v[min(len(v) - 1, max(0, math.ceil(q * len(v)) - 1))], 3)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("carpeta")
    ap.add_argument("experimento")
    ap.add_argument("brazo_a")
    ap.add_argument("brazo_b")
    ap.add_argument("--salida", default=None)
    args = ap.parse_args()

    corridas: dict[str, dict[int, dict]] = {args.brazo_a: {}, args.brazo_b: {}}
    for ruta in glob.glob(os.path.join(args.carpeta, f"{args.experimento}_*_*.json")):
        m = re.match(rf"{re.escape(args.experimento)}_(.+)_(\d+)\.json$", os.path.basename(ruta))
        if m and m.group(1) in corridas:
            with open(ruta, encoding="utf-8") as f:
                corridas[m.group(1)][int(m.group(2))] = json.load(f)

    def por_brazo(brazo: str) -> dict:
        secs = [c["secuencias"][0] for _, c in sorted(corridas[brazo].items())]
        lat = [p["lat_registro_s"] for s in secs for p in s["detalle_pasos"] if p["lat_registro_s"] is not None]
        decision = [p.get("lat_decision_s") for s in secs for p in s["detalle_pasos"] if p.get("lat_decision_s") is not None]
        registros = sum(s["registros"] for s in secs)
        validos = sum(s.get("registros_validos", 0) for s in secs)
        detector = [s["etapas_ms"].get("detector", {}) for s in secs if s.get("etapas_ms")]
        return {
            "corridas": len(secs),
            "configuracion": [c.get("configuracion") for _, c in sorted(corridas[brazo].items())][:1],
            "latencia_registro_s": {"p50": percentil(lat, 0.5), "p95": percentil(lat, 0.95), "max": max(lat) if lat else None, "n": len(lat)},
            "registros_en_menos_de_1_s": wilson(sum(v < 1.0 for v in lat), len(lat)),
            "latencia_decision_final_s": {"p50": percentil(decision, 0.5), "p95": percentil(decision, 0.95),
                                          "max": max(decision) if decision else None, "n": len(decision)},
            "pasos_reevaluados": sum(s.get("reevaluados", 0) for s in secs),
            "lecturas_validas": wilson(validos, registros),
            "pasos_correctos": f"{sum(s['correctos'] for s in secs)}/{sum(s['pasos_legibles'] for s in secs)}",
            "fps_analizados_por_corrida": [s["fps_analizados"] for s in secs],
            "lectura_en_vivo_p50_ms_por_corrida": [(s.get("latencia_motor") or {}).get("lectura_en_vivo", {}).get("p50_ms") for s in secs],
            "detector_p50_ms_por_corrida": [d.get("p50_ms") for d in detector],
            "detector_p95_ms_por_corrida": [d.get("p95_ms") for d in detector],
        }

    # Pares (réplica, paso) con registro en ambos brazos
    dif_lat = []
    for r in sorted(set(corridas[args.brazo_a]) & set(corridas[args.brazo_b])):
        pa = corridas[args.brazo_a][r]["secuencias"][0]["detalle_pasos"]
        pb = corridas[args.brazo_b][r]["secuencias"][0]["detalle_pasos"]
        for a, b in zip(pa, pb):
            if a["lat_registro_s"] is not None and b["lat_registro_s"] is not None:
                dif_lat.append(b["lat_registro_s"] - a["lat_registro_s"])
    fps = [(corridas[args.brazo_b][r]["secuencias"][0]["fps_analizados"] - corridas[args.brazo_a][r]["secuencias"][0]["fps_analizados"])
           for r in sorted(set(corridas[args.brazo_a]) & set(corridas[args.brazo_b]))]
    resultado = {
        "experimento": args.experimento,
        args.brazo_a: por_brazo(args.brazo_a),
        args.brazo_b: por_brazo(args.brazo_b),
        "pareado": {
            "latencia_registro_dif_mediana_s (B - A)": round(statistics.median(dif_lat), 3) if dif_lat else None,
            "pares": len(dif_lat),
            "p_signos": signos(dif_lat),
            "fps_analizados_dif_por_replica (B - A)": [round(x, 2) for x in fps],
        },
    }
    print(json.dumps(resultado, ensure_ascii=False, indent=1))
    if args.salida:
        with open(args.salida, "w", encoding="utf-8") as f:
            json.dump(resultado, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
