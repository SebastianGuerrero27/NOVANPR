"""
Análisis estadístico para el artículo / tesis.

Comandos (desde services/anpr):

  1. Métricas de operación real (CSV exportado de GET /api/evaluacion/export.csv):
       .venv/Scripts/python scripts/estadistica.py operacion --csv evaluacion_anpr.csv
     Exactitud por placa, CER, falsa aceptación / falso rechazo, lista negra no detectada y
     latencia, con IC 95 % por bootstrap, en total y por condición (luz, distancia, tipo de placa).

  2. Comparación pareada de dos sistemas sobre las MISMAS muestras (McNemar exacto):
       .venv/Scripts/python scripts/estadistica.py comparar --a preds_A.csv --b preds_B.csv
     Los CSV de predicciones (columnas id,gt,pred) los generan benchmark_ocr.py,
     evaluate_detectors.py y run_ablations.py con --save-preds.

  3. Varias semillas de entrenamiento (JSON o CSV con una métrica por corrida):
       .venv/Scripts/python scripts/estadistica.py semillas --valores 0.91 0.93 0.92
     Media ± desviación estándar e IC 95 % con t de Student.

Solo usa numpy y la biblioteca estándar.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from collections import defaultdict
from pathlib import Path

import numpy as np

RNG = np.random.default_rng(12345)  # semilla fija: los IC son reproducibles


def norm(t: str | None) -> str:
    return re.sub(r"[^A-Z0-9]", "", (t or "").upper())


def levenshtein(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return prev[len(b)]


# ---------------------------------------------------------------------------
# Intervalos de confianza
# ---------------------------------------------------------------------------

def bootstrap_ci(values: np.ndarray, stat=np.mean, n_boot: int = 10000, alpha: float = 0.05):
    """IC percentil por bootstrap (remuestreo de pasos vehiculares con reemplazo)."""
    values = np.asarray(values, dtype=float)
    if values.size == 0:
        return None, None, None
    idx = RNG.integers(0, values.size, size=(n_boot, values.size))
    stats = np.apply_along_axis(stat, 1, values[idx]) if stat is not np.mean else values[idx].mean(axis=1)
    return float(stat(values)), float(np.quantile(stats, alpha / 2)), float(np.quantile(stats, 1 - alpha / 2))


def fmt_ci(point, lo, hi, pct: bool = True) -> str:
    if point is None:
        return "—"
    if pct:
        return f"{point * 100:.1f} % [{lo * 100:.1f}, {hi * 100:.1f}]"
    return f"{point:.0f} [{lo:.0f}, {hi:.0f}]"


_T95 = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262,
        10: 2.228, 12: 2.179, 15: 2.131, 20: 2.086, 25: 2.060, 30: 2.042}


def t_critical(df: int) -> float:
    if df <= 0:
        return float("nan")
    keys = sorted(_T95)
    for k in keys:
        if df <= k:
            return _T95[k]
    return 1.96


# ---------------------------------------------------------------------------
# 1. Operación real
# ---------------------------------------------------------------------------

def metricas_grupo(rows: list[dict], n_boot: int) -> dict:
    correct = np.array([norm(r["placa_ocr_original"]) == norm(r["placa_validada"]) for r in rows], dtype=float)
    cer = np.array([levenshtein(norm(r["placa_ocr_original"]), norm(r["placa_validada"])) / max(1, len(norm(r["placa_validada"])))
                    for r in rows], dtype=float)
    out = {"n": len(rows), "exactitud": bootstrap_ci(correct, n_boot=n_boot), "cer": bootstrap_ci(cer, n_boot=n_boot)}

    def tasa(mask_den, mask_num):
        sub = np.array([mask_num(r) for r in rows if mask_den(r)], dtype=float)
        return bootstrap_ci(sub, n_boot=n_boot) + (int(sub.size),)

    out["falsa_aceptacion"] = tasa(lambda r: r["decision_final"] != "autorizado", lambda r: r["decision_automatica"] == "autorizado")
    out["falso_rechazo"] = tasa(lambda r: r["decision_final"] == "autorizado", lambda r: r["decision_automatica"] != "autorizado")
    out["lista_negra_no_detectada"] = tasa(lambda r: r["decision_final"] == "alerta", lambda r: r["decision_automatica"] != "alerta")
    lat = np.array([float(r["latencia_ms"]) for r in rows if r.get("latencia_ms")], dtype=float)
    out["latencia_p50"] = bootstrap_ci(lat, stat=lambda x: np.quantile(x, 0.5), n_boot=min(n_boot, 2000))
    out["latencia_p95"] = bootstrap_ci(lat, stat=lambda x: np.quantile(x, 0.95), n_boot=min(n_boot, 2000))
    return out


def cmd_operacion(args) -> None:
    rows = list(csv.DictReader(open(args.csv, encoding="utf-8")))
    total = len(rows)
    rows = [r for r in rows if r.get("validado_manualmente") in ("1", "true", "True") and len(norm(r.get("placa_validada"))) >= 4]
    print(f"Registros: {total} | validados: {len(rows)} | cobertura: {len(rows) / max(1, total):.1%}")
    if total and len(rows) / total < 0.95:
        print("  [!] Cobertura < 95 %: el operador no validó todos los pasos; las métricas pueden estar sesgadas.")

    grupos = {"Global": {"todos": rows}}
    for col, titulo in (("luz", "Luz"), ("rango_distancia", "Distancia"), ("tipo_servicio", "Tipo de placa"),
                        ("formato_placa", "Formato"), ("condicion_clima", "Clima")):
        g = defaultdict(list)
        for r in rows:
            g[r.get(col) or "sin_dato"].append(r)
        grupos[titulo] = dict(g)

    resultados = {}
    lines = ["| Grupo | n | Exactitud placa (IC 95 %) | CER | Falsa aceptación | Falso rechazo | Lista negra no detectada | Latencia p95 ms |",
             "|---|---|---|---|---|---|---|---|"]
    for titulo, g in grupos.items():
        for nombre, sub in sorted(g.items()):
            m = metricas_grupo(sub, args.bootstrap)
            resultados[f"{titulo}:{nombre}"] = m
            lines.append(
                f"| {titulo}: {nombre} | {m['n']} | {fmt_ci(*m['exactitud'])} | {m['cer'][0]:.3f} | "
                f"{fmt_ci(*m['falsa_aceptacion'][:3])} (n={m['falsa_aceptacion'][3]}) | "
                f"{fmt_ci(*m['falso_rechazo'][:3])} (n={m['falso_rechazo'][3]}) | "
                f"{fmt_ci(*m['lista_negra_no_detectada'][:3])} (n={m['lista_negra_no_detectada'][3]}) | "
                f"{fmt_ci(*m['latencia_p95'], pct=False)} |"
            )
    print("\n".join(lines))
    if args.out:
        Path(args.out).write_text(json.dumps(resultados, indent=2, default=float), encoding="utf-8")
        print(f"\nGuardado en {args.out}")


# ---------------------------------------------------------------------------
# 2. Comparación pareada (McNemar exacto)
# ---------------------------------------------------------------------------

def mcnemar_exact(b: int, c: int) -> float:
    """p-valor bilateral exacto: b = aciertos solo de A, c = aciertos solo de B."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    p = sum(math.comb(n, i) for i in range(0, k + 1)) / 2 ** n
    return min(1.0, 2 * p)


def load_preds(path: str) -> dict[str, bool]:
    out = {}
    for r in csv.DictReader(open(path, encoding="utf-8")):
        out[r["id"]] = norm(r["pred"]) == norm(r["gt"])
    return out


def cmd_comparar(args) -> None:
    a, b = load_preds(args.a), load_preds(args.b)
    ids = sorted(set(a) & set(b))
    if not ids:
        raise SystemExit("Los archivos no comparten muestras (columna id).")
    va = np.array([a[i] for i in ids], dtype=float)
    vb = np.array([b[i] for i in ids], dtype=float)
    solo_a = int(((va == 1) & (vb == 0)).sum())
    solo_b = int(((va == 0) & (vb == 1)).sum())
    p = mcnemar_exact(solo_a, solo_b)
    diff = bootstrap_ci(vb - va, n_boot=args.bootstrap)
    print(f"Muestras pareadas: {len(ids)}")
    print(f"A = {Path(args.a).stem}: {va.mean():.1%} | B = {Path(args.b).stem}: {vb.mean():.1%}")
    print(f"Diferencia B - A: {diff[0] * 100:+.1f} pp, IC 95 % [{diff[1] * 100:+.1f}, {diff[2] * 100:+.1f}]")
    print(f"Discordantes: solo A acierta = {solo_a}, solo B acierta = {solo_b}")
    print(f"McNemar exacto: p = {p:.4f} -> {'diferencia significativa (p < 0.05)' if p < 0.05 else 'sin diferencia significativa'}")
    if solo_a + solo_b < 10:
        print("  [!] Menos de 10 casos discordantes: la prueba tiene poca potencia; se requieren más placas.")


# ---------------------------------------------------------------------------
# 3. Semillas
# ---------------------------------------------------------------------------

def cmd_semillas(args) -> None:
    vals = list(args.valores or [])
    for f in args.json or []:
        d = json.loads(Path(f).read_text(encoding="utf-8"))
        vals.append(float(eval_key(d, args.clave)))
    x = np.array(vals, dtype=float)
    if x.size < 2:
        raise SystemExit("Se necesitan al menos 2 corridas.")
    m, s = x.mean(), x.std(ddof=1)
    h = t_critical(x.size - 1) * s / math.sqrt(x.size)
    print(f"Corridas: {x.size} | media = {m:.4f} ± {s:.4f} (DE) | IC 95 % [{m - h:.4f}, {m + h:.4f}]")


def eval_key(d: dict, clave: str):
    for part in clave.split("."):
        d = d[part]
    return d


def main() -> None:
    ap = argparse.ArgumentParser(description="Estadística para el artículo del sistema ANPR.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("operacion")
    p1.add_argument("--csv", required=True)
    p1.add_argument("--bootstrap", type=int, default=10000)
    p1.add_argument("--out", default="")
    p2 = sub.add_parser("comparar")
    p2.add_argument("--a", required=True)
    p2.add_argument("--b", required=True)
    p2.add_argument("--bootstrap", type=int, default=10000)
    p3 = sub.add_parser("semillas")
    p3.add_argument("--valores", type=float, nargs="*")
    p3.add_argument("--json", nargs="*", help="Archivos JSON de resultados (uno por semilla)")
    p3.add_argument("--clave", default="resultados.yolo26n.f1", help="Ruta de la métrica dentro del JSON")
    args = ap.parse_args()
    {"operacion": cmd_operacion, "comparar": cmd_comparar, "semillas": cmd_semillas}[args.cmd](args)


if __name__ == "__main__":
    main()
