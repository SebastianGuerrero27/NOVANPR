"""
A/B pareado de la interpretación de lecturas OCR sobre recortes de placa etiquetados.

  A · reglas anteriores (versión de los módulos en git HEAD): sustituciones posicionales forzadas,
      formato de auto antes que el de moto, sin registrar lo que se cambió.
  B · interpretación actual: formato con menos sustituciones, cada una registrada, y una placa con
      caracteres que ningún lector leyó tal cual no se confirma (app/dominio/interpretacion_placa.py).

Mismos recortes y mismos modelos de producción (agente cct-s-v2 y verificador PP-OCRv6): el
verificador lee una vez por recorte y se interpretan sus líneas con A y con B; el agente se ejecuta
con cada versión del parser (su OCR es determinista). Decisión por foto como en el motor: placa del
verificador si lee una placa ANT, si no la del OCR; "confirmada" = formato ANT y ambos lectores de
acuerdo (en una sola foto no hay consenso de varios cuadros) y, en B, sin caracteres inferidos.

Uso (desde services/anpr):
    .venv/Scripts/python scripts/ab_correcciones.py --labels scripts/benchmark_labels.csv \\
        --out ../../docs/resultados/correcciones_ocr_2026-10-12.json
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import subprocess
import sys
import types
import warnings

import cv2

warnings.filterwarnings("ignore")
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from estadistica import mcnemar_exact, norm  # noqa: E402


def wilson(exitos: int, n: int, z: float = 1.96) -> list[float] | None:
    if n == 0:
        return None
    p = exitos / n
    centro = (p + z * z / (2 * n)) / (1 + z * z / n)
    margen = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return [round(max(0.0, centro - margen), 4), round(min(1.0, centro + margen), 4)]


def modulo_de_git(ruta: str, nombre: str) -> types.ModuleType:
    """Carga la versión de HEAD de un módulo del motor como un módulo aparte."""
    fuente = subprocess.run(["git", "-C", RAIZ, "show", f"HEAD:services/anpr/{ruta}"], capture_output=True,
                            text=True, encoding="utf-8", check=True).stdout
    modulo = types.ModuleType(nombre)
    modulo.__file__ = f"HEAD:{ruta}"
    sys.modules[nombre] = modulo   # dataclasses resuelve las anotaciones por el nombre del módulo
    exec(compile(fuente, modulo.__file__, "exec"), modulo.__dict__)
    return modulo


def decidir(profundo, verificador_placa: str, validar, crudos=None) -> dict:
    """Decisión de una foto, como en MotorAnpr._verificar_y_registrar."""
    from app.dominio.interpretacion_placa import caracteres_sin_lectura_directa

    placa = ""
    if profundo.placa and profundo.estado == "procesado":
        placa = profundo.placa
    elif profundo.placa and len(profundo.placa.replace("-", "")) >= 4:
        valida, formateada, _ = validar(profundo.placa)
        if valida:
            placa = formateada
    placa_ver = ""
    if verificador_placa:
        valida, formateada, _ = validar(verificador_placa)
        if valida:
            placa_ver = formateada
    final = norm(placa_ver or placa)
    coincide = bool(placa_ver) and norm(placa_ver) == norm(profundo.placa)
    formato = bool(final) and validar(final)[0]
    inferidos = caracteres_sin_lectura_directa(final, crudos) if (crudos is not None and final) else []
    return {"placa": final, "confirmada": bool(formato and coincide and not inferidos), "inferidos": inferidos}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", default="scripts/benchmark_labels.csv")
    ap.add_argument("--media", default="media")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    import app.aplicacion.plate_agent as modulo_agente
    from app.aplicacion.plate_agent import PlateEnhancementAgent
    from app.dominio.ecuador_plate_validator import validate_ecuadorian_plate as validar_b
    from app.infraestructura.ocr_verifier import get_verifier, leer_lineas_placa, merge_row_fragments

    parser_a = modulo_de_git("app/dominio/plate_parser.py", "parser_anterior")
    validar_a = modulo_de_git("app/dominio/ecuador_plate_validator.py", "validador_anterior").validate_ecuadorian_plate
    verificador_a = modulo_de_git("app/infraestructura/ocr_verifier.py", "verificador_anterior")

    filas = [r for r in csv.DictReader(open(args.labels, encoding="utf-8")) if r["placa"].strip()]
    datos = [(r["archivo"], norm(r["placa"]), cv2.imread(os.path.join(args.media, r["archivo"]))) for r in filas]
    datos = [d for d in datos if d[2] is not None]

    agente = PlateEnhancementAgent()
    verificador = get_verifier()
    if verificador is None:
        sys.exit("El verificador PP-OCRv6 no está disponible: el A/B necesita los dos lectores de producción.")
    funciones_b = (modulo_agente.extraer_placa, modulo_agente.validate_ecuadorian_plate, modulo_agente.disambiguate_plate)
    funciones_a = (lambda tokens: (*parser_a.extract_plate_from_tokens(tokens), ""),
                   parser_a.validate_ecuadorian_plate, parser_a.disambiguate_plate)

    def leer_con(funciones, img):
        modulo_agente.extraer_placa, modulo_agente.validate_ecuadorian_plate, modulo_agente.disambiguate_plate = funciones
        h, w = img.shape[:2]
        return agente.process_image(img, initial_bbox=[0, 0, w, h], fast_mode=False)

    muestras = []
    try:
        for archivo, etiqueta, img in datos:
            res = verificador._ocr(img)
            txts, scores = list(res.txts or []), list(res.scores or [])
            if res.boxes is not None and len(txts) > 1:
                txts, scores = merge_row_fragments(res.boxes, txts, scores)
            ver_a = verificador_a.parse_plate_lines(txts, scores)[0]
            ver_b, _, crudo_ver = leer_lineas_placa(txts, scores)
            prof_a, prof_b = leer_con(funciones_a, img), leer_con(funciones_b, img)
            a = decidir(prof_a, ver_a, validar_a)
            b = decidir(prof_b, ver_b, validar_b, crudos=[prof_b.texto_crudo, crudo_ver])
            muestras.append({"archivo": archivo, "etiqueta": etiqueta, "a": a, "b": b,
                             "crudo_ocr": prof_b.texto_crudo, "crudo_verificador": crudo_ver})
    finally:
        modulo_agente.extraer_placa, modulo_agente.validate_ecuadorian_plate, modulo_agente.disambiguate_plate = funciones_b

    n = len(muestras)

    def resumen(clave: str) -> dict:
        correctas = sum(m[clave]["placa"] == m["etiqueta"] for m in muestras)
        conf_ok = sum(m[clave]["confirmada"] and m[clave]["placa"] == m["etiqueta"] for m in muestras)
        conf_mal = sum(m[clave]["confirmada"] and m[clave]["placa"] != m["etiqueta"] for m in muestras)
        return {
            "placa_correcta": {"exitos": correctas, "valor": round(correctas / n, 4), "ic95": wilson(correctas, n)},
            "confirmada_y_correcta": {"exitos": conf_ok, "valor": round(conf_ok / n, 4), "ic95": wilson(conf_ok, n)},
            "confirmada_y_erronea": {"exitos": conf_mal, "valor": round(conf_mal / n, 4), "ic95": wilson(conf_mal, n)},
            "a_revision_del_personal": sum(not m[clave]["confirmada"] for m in muestras),
        }

    def pares(criterio) -> dict:
        solo_a = sum(criterio(m["a"], m) and not criterio(m["b"], m) for m in muestras)
        solo_b = sum(criterio(m["b"], m) and not criterio(m["a"], m) for m in muestras)
        return {"solo_A": solo_a, "solo_B": solo_b, "p_mcnemar": mcnemar_exact(solo_a, solo_b)}

    resultado = {
        "descripcion": "A = reglas posicionales anteriores (git HEAD); B = interpretación con mínimo de sustituciones y lectura directa",
        "lectores": {"ocr": getattr(agente._ocr, "model_id", type(agente._ocr).__name__), "verificador": verificador.description},
        "recortes": n,
        "placas_distintas": len({m["etiqueta"] for m in muestras}),
        "A": resumen("a"),
        "B": resumen("b"),
        "pareado": {
            "placa_correcta": pares(lambda d, m: d["placa"] == m["etiqueta"]),
            "confirmada_y_correcta": pares(lambda d, m: d["confirmada"] and d["placa"] == m["etiqueta"]),
        },
        "con_caracteres_inferidos": [
            {"archivo": m["archivo"], "etiqueta": m["etiqueta"], "B": m["b"], "crudo_ocr": m["crudo_ocr"],
             "crudo_verificador": m["crudo_verificador"]} for m in muestras if m["b"]["inferidos"]],
        # Lecturas que se habrían autorizado sin intervención con una placa equivocada
        "confirmadas_erroneas": [
            {"archivo": m["archivo"], "etiqueta": m["etiqueta"], "A": m["a"], "B": m["b"], "crudo_ocr": m["crudo_ocr"],
             "crudo_verificador": m["crudo_verificador"]}
            for m in muestras if any(m[k]["confirmada"] and m[k]["placa"] != m["etiqueta"] for k in ("a", "b"))],
        "discordantes": [
            {"archivo": m["archivo"], "etiqueta": m["etiqueta"], "A": m["a"], "B": m["b"],
             "crudo_ocr": m["crudo_ocr"], "crudo_verificador": m["crudo_verificador"]}
            for m in muestras if (m["a"]["placa"], m["a"]["confirmada"]) != (m["b"]["placa"], m["b"]["confirmada"])
        ],
    }
    print(json.dumps({k: resultado[k] for k in ("recortes", "placas_distintas", "A", "B", "pareado")}, indent=1, ensure_ascii=False))
    print("discordantes:", len(resultado["discordantes"]), "| con caracteres inferidos:", len(resultado["con_caracteres_inferidos"]))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(resultado, f, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
