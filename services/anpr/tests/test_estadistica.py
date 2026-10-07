"""Pruebas del análisis estadístico (scripts/estadistica.py)."""

import argparse
import csv
import importlib.util
from pathlib import Path

import numpy as np

_spec = importlib.util.spec_from_file_location(
    "estadistica", Path(__file__).resolve().parent.parent / "scripts" / "estadistica.py"
)
est = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(est)


def test_mcnemar_exacto_valores_conocidos():
    assert est.mcnemar_exact(0, 5) == 0.0625       # 2 * (1/2)^5
    assert est.mcnemar_exact(0, 0) == 1.0
    assert est.mcnemar_exact(5, 5) == 1.0
    assert est.mcnemar_exact(0, 10) < 0.01


def test_bootstrap_contiene_la_media():
    x = np.array([1] * 90 + [0] * 10, dtype=float)
    p, lo, hi = est.bootstrap_ci(x, n_boot=2000)
    assert p == 0.9 and lo < 0.9 < hi


def test_t_critica():
    assert est.t_critical(2) == 4.303
    assert est.t_critical(1000) == 1.96


def _csv_operacion(path: Path) -> None:
    cols = ["validado_manualmente", "placa_ocr_original", "placa_validada", "decision_automatica",
            "decision_final", "latencia_ms", "luz", "rango_distancia", "tipo_servicio", "formato_placa", "condicion_clima"]
    rows = [
        ["1", "PBA1234", "PBA-1234", "autorizado", "autorizado", "800", "dia", "3-6 m", "particular", "actual_4_digitos", ""],
        ["1", "PBA1284", "PBA-1234", "no_reconocido", "autorizado", "900", "noche", "6-10 m", "particular", "actual_4_digitos", ""],
        ["1", "GAA123", "GAA-123", "alerta", "alerta", "700", "dia", "<3 m", "comercial", "antiguo_3_digitos", "lluvia"],
        ["0", "XYZ999", "", "no_reconocido", "no_reconocido", "650", "dia", "3-6 m", "", "", ""],
    ]
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)


def test_operacion_genera_tabla_y_advierte_cobertura(tmp_path, capsys):
    p = tmp_path / "eval.csv"
    _csv_operacion(p)
    est.cmd_operacion(argparse.Namespace(csv=str(p), bootstrap=500, out=str(tmp_path / "r.json")))
    out = capsys.readouterr().out
    assert "cobertura: 75.0%" in out and "Cobertura < 95 %" in out
    assert "| Global: todos | 3 |" in out
    assert (tmp_path / "r.json").exists()


def test_comparar_pareado(tmp_path, capsys):
    a, b = tmp_path / "a.csv", tmp_path / "b.csv"
    for path, preds in ((a, ["X", "B", "C"]), (b, ["A", "B", "C"])):
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["id", "gt", "pred"])
            for i, (gt, pr) in enumerate(zip(["A", "B", "C"], preds)):
                w.writerow([i, gt, pr])
    est.cmd_comparar(argparse.Namespace(a=str(a), b=str(b), bootstrap=500))
    out = capsys.readouterr().out
    assert "solo A acierta = 0, solo B acierta = 1" in out
