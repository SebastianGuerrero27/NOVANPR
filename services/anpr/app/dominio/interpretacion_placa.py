"""
Interpretación de una lectura OCR como matrícula ANT sin inventar caracteres.

El OCR entrega texto y la matrícula tiene formatos fijos (p. ej. 3 letras + 3 o 4 dígitos). Cuando
el texto no encaja, una confusión típica del OCR (0↔O, 1↔I, 8↔B, 5↔S…) puede explicar la
diferencia, pero cambiar un carácter es una hipótesis, no una lectura. Por eso esta interpretación:

  1. Elige el formato que encaja con MENOS sustituciones. Antes se probaba primero el de automóvil
     y se forzaba: una moto leída bien (AB-123A) se convertía en otra placa (ABI-234).
  2. Nunca agrega, quita ni reordena caracteres: si ningún formato encaja devuelve el texto leído
     (saneado) sin placa.
  3. Registra cada sustitución (posición, leído, interpretado). Una placa con caracteres inferidos
     solo por el formato no se confirma sola: ver `caracteres_sin_lectura_directa`.

Cada módulo conserva su propia tabla de confusiones; aquí solo se decide cómo se aplican.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Mapping, Optional

Correccion = tuple[int, str, str]  # (posición, carácter leído, carácter interpretado)


@dataclass(frozen=True)
class Formato:
    nombre: str
    #: Clases por posición, una cadena por longitud admitida: 'L' letra, 'D' dígito
    patrones: tuple[str, ...]
    #: Posición del guion en la placa formateada
    separador: int
    #: Prefijos literales obligatorios en el texto leído (sin sustituciones), p. ej. diplomáticos
    prefijos: tuple[str, ...] = ()
    #: Caracteres leídos admitidos en la primera posición (None: cualquiera)
    primeras: Optional[frozenset[str]] = None
    #: La primera letra es la provincia: admite la tabla de confusiones propia de esa posición
    provincia: bool = False


DIPLOMATICO = Formato("diplomatico", ("LLDDDD",), separador=2, prefijos=("CC", "CD", "OI", "AT", "PP"))
PARTICULAR = Formato("particular", ("LLLDDD", "LLLDDDD"), separador=3, provincia=True)
MOTO = Formato("moto", ("LLDDD", "LLDDDD", "LLDDDL", "LLDDDDL"), separador=2)


@dataclass(frozen=True)
class Interpretacion:
    crudo: str                      # texto leído: solo A-Z y 0-9, sin cabecera
    placa: str                      # placa formateada ("PBA-1234") o "" si ningún formato encaja
    formato: str                    # nombre del formato o ""
    correcciones: tuple[Correccion, ...]


def sanear(texto: Optional[str], ruido: Iterable[str] = ()) -> str:
    """Mayúsculas, sin palabras de cabecera (ECUADOR, ANT…) y solo caracteres A-Z y 0-9."""
    if not texto:
        return ""
    t = str(texto).upper().strip()
    for palabra in ruido:
        t = re.sub(rf"\b{palabra}\b", "", t)
    return re.sub(r"[^A-Z0-9]", "", t)


def _encajar(crudo: str, patron: str, formato: Formato, digito_a_letra: Mapping[str, str],
             letra_a_digito: Mapping[str, str], primera_letra: Mapping[str, str]) -> Optional[tuple[str, list[Correccion]]]:
    if formato.prefijos and crudo[:2] not in formato.prefijos:
        return None
    if formato.primeras is not None and crudo[0] not in formato.primeras:
        return None
    salida, correcciones = [], []
    for i, (c, clase) in enumerate(zip(crudo, patron)):
        if clase == "L":
            if i == 0 and formato.provincia and c in primera_letra:
                nuevo = primera_letra[c]
            else:
                nuevo = c if c.isalpha() else digito_a_letra.get(c)
        else:
            nuevo = c if c.isdigit() else letra_a_digito.get(c)
        if nuevo is None:
            return None
        if nuevo != c:
            correcciones.append((i, c, nuevo))
        salida.append(nuevo)
    return "".join(salida), correcciones


def interpretar(texto: Optional[str], *, formatos: Iterable[Formato], digito_a_letra: Mapping[str, str],
                letra_a_digito: Mapping[str, str], primera_letra: Optional[Mapping[str, str]] = None,
                ruido: Iterable[str] = ()) -> Interpretacion:
    """
    El formato (de `formatos`, en orden de prioridad para los empates) que explica el texto con
    menos sustituciones de la tabla de confusiones. Sin formato posible: placa vacía.
    """
    crudo = sanear(texto, ruido)
    mejor: Optional[tuple[Formato, str, list[Correccion]]] = None
    for formato in formatos:
        for patron in formato.patrones:
            if len(patron) != len(crudo):
                continue
            encaje = _encajar(crudo, patron, formato, digito_a_letra, letra_a_digito, primera_letra or {})
            if encaje is not None and (mejor is None or len(encaje[1]) < len(mejor[2])):
                mejor = (formato, *encaje)
    if mejor is None:
        return Interpretacion(crudo, "", "", ())
    formato, caracteres, correcciones = mejor
    placa = f"{caracteres[:formato.separador]}-{caracteres[formato.separador:]}"
    return Interpretacion(crudo, placa, formato.nombre, tuple(correcciones))


def caracteres_sin_lectura_directa(placa: str, lecturas_crudas: Iterable[Optional[str]]) -> list[tuple[int, str]]:
    """
    Caracteres de la placa que ningún lector leyó tal cual: se comparan las lecturas crudas de la
    misma longitud, posición por posición (las de otra longitud no respaldan ninguna). Un carácter
    que solo existe por una sustitución del formato es una hipótesis: la lectura no se confirma.
    """
    objetivo = sanear(placa)
    alineadas = [c for c in (sanear(t) for t in lecturas_crudas) if len(c) == len(objetivo)]
    return [(i, ch) for i, ch in enumerate(objetivo) if not any(c[i] == ch for c in alineadas)]
