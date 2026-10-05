"""Prueba de aptitud de la arquitectura del servicio ANPR (docs/ARQUITECTURA_LIMPIA.md).

Lee las importaciones reales de cada módulo (ast) y falla si una capa depende de otra que no le
corresponde:

    dominio/          reglas puras: biblioteca estándar y numpy; solo importa dominio/
    infraestructura/  modelos, cámaras, red, métricas, registro y configuración; no importa aplicación
    aplicacion/       orquestación del reconocimiento; no importa la interfaz ni FastAPI. El motor en
                      tiempo real (motor.py) recibe todos sus adaptadores inyectados.
    interfaz/         servidor HTTP y WebSocket (FastAPI): delega en el motor
    main.py           raíz de composición
"""
import ast
import sys
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
CAPAS = ("dominio", "aplicacion", "infraestructura", "interfaz")
SERVIDOR = {"fastapi", "starlette", "uvicorn"}


def importaciones(archivo: Path) -> list[str]:
    arbol = ast.parse(archivo.read_text(encoding="utf-8"))
    nombres: list[str] = []
    for nodo in ast.walk(arbol):
        if isinstance(nodo, ast.Import):
            nombres += [a.name for a in nodo.names]
        elif isinstance(nodo, ast.ImportFrom) and nodo.module and nodo.level == 0:
            nombres.append(nodo.module)
    return nombres


def modulos(capa: str) -> list[Path]:
    return sorted((APP / capa).rglob("*.py"))


def violaciones(capa: str, prohibido) -> list[str]:
    return [f"{m.relative_to(APP)} → {i}" for m in modulos(capa) for i in importaciones(m) if prohibido(i)]


def test_app_contiene_solo_las_capas_y_la_raiz_de_composicion():
    carpetas = sorted(p.name for p in APP.iterdir() if p.is_dir() and p.name != "__pycache__")
    assert carpetas == sorted([*CAPAS, "data"])
    assert sorted(p.name for p in APP.glob("*.py")) == ["main.py"]


def test_dominio_es_puro():
    permitidos = set(sys.stdlib_module_names) | {"numpy"}

    def prohibido(i: str) -> bool:
        raiz = i.split(".")[0]
        if raiz == "app":
            return not i.startswith("app.dominio")
        return raiz not in permitidos

    assert violaciones("dominio", prohibido) == []


def test_infraestructura_no_depende_de_la_aplicacion_ni_del_servidor():
    assert violaciones("infraestructura", lambda i: i.startswith(("app.aplicacion", "app.interfaz", "app.main")) or i.split(".")[0] in SERVIDOR) == []


def test_aplicacion_no_depende_de_la_interfaz_ni_del_servidor():
    assert violaciones("aplicacion", lambda i: i.startswith(("app.interfaz", "app.main")) or i.split(".")[0] in SERVIDOR) == []


def test_el_motor_recibe_sus_adaptadores_inyectados():
    motor = APP / "aplicacion" / "motor.py"
    assert [i for i in importaciones(motor) if i.startswith("app.infraestructura")] == []


def test_solo_la_interfaz_conoce_fastapi():
    fuera = [f"{m.relative_to(APP)} → {i}" for capa in ("dominio", "aplicacion", "infraestructura")
             for m in modulos(capa) for i in importaciones(m) if i.split(".")[0] in SERVIDOR]
    assert fuera == []
    assert [i for i in importaciones(APP / "main.py") if i.split(".")[0] in SERVIDOR] == []


def test_la_prueba_detecta_violaciones(tmp_path):
    """Control de la propia prueba: un módulo del dominio que importa infraestructura se detecta."""
    malo = tmp_path / "malo.py"
    malo.write_text("from app.infraestructura.config import CAMERA_ID\nimport cv2\n", encoding="utf-8")
    assert importaciones(malo) == ["app.infraestructura.config", "cv2"]
