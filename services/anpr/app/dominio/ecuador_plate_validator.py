"""
Módulo Especializado de Validación y Normalización de Matrículas para Ecuador (ANT).
Normativa Técnica Oficial de la Agencia Nacional de Tránsito (ANT) y Código Orgánico de Transporte Terrestre.

Tipologías Soportadas:
  1. Vehículos Particulares: 3 Letras + 3 o 4 Dígitos (ej. PBA-1234, TCG-0987, PSY-589).
  2. Vehículos Comerciales (Taxis, Buses, Carga Pesada): Segunda letra 'A', 'U', 'Z' (ej. GAA-1234, PUZ-5678).
  3. Vehículos del Estado / Gubernamentales: Segunda letra 'E' (ej. PEA-1234, GEB-5678).
  4. Vehículos Municipales / Seccionales: Segunda letra 'M' (ej. PMA-1234, QMC-5678).
  5. Vehículos de Emergencia (Cruz Roja, Bomberos): Segunda letra 'X' (ej. PXA-1234).
  6. Motocicletas: 2 Letras + 3 o 4 Dígitos + 1 Letra opcional (ej. AB-123C, PB-1234).
  7. Cuerpo Diplomático / Organismos Internacionales: CC, CD, OI, AT, PP + 4 Dígitos.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, Tuple, Dict

from app.dominio.interpretacion_placa import DIPLOMATICO, MOTO, PARTICULAR, Interpretacion, interpretar

# =============================================================================
# Codificación Oficial de Provincias (ANT Ecuador - Primera Letra)
# =============================================================================
CODIGOS_PROVINCIALES_ANT: Dict[str, str] = {
    "A": "Azuay",
    "B": "Bolívar",
    "C": "Carchi",
    "E": "Esmeraldas",
    "G": "Guayas",
    "H": "Chimborazo",
    "I": "Imbabura",
    "J": "Santo Domingo de los Tsáchilas",
    "K": "Sucumbíos",
    "L": "Loja",
    "M": "Manabí",
    "N": "Napo",
    "O": "El Oro",
    "P": "Pichincha",
    "Q": "Orellana",
    "R": "Los Ríos",
    "S": "Pastaza",
    "T": "Tungurahua",
    "U": "Cañar",
    "V": "Morona Santiago",
    "W": "Galápagos",
    "X": "Cotopaxi",
    "Y": "Santa Elena",
    "Z": "Zamora Chinchipe",
}

# Tipos de Servicio según la segunda letra de la matrícula
TIPOS_SERVICIO_SEGUNDA_LETRA: Dict[str, str] = {
    "A": "Comercial (Transporte Público / Taxi / Bus)",
    "U": "Comercial (Transporte Público / Carga)",
    "Z": "Comercial (Transporte Mixto / Carga Liviana)",
    "E": "Gubernamental / Estado Central",
    "M": "Gobierno Autónomo Descentralizado / Municipal",
    "X": "Emergencia / Bomberos / Cruz Roja",
    "S": "Servicio Público Oficial",
}

# Prefijos Especiales Diplomáticos y de Misión
PREFIJOS_DIPLOMATICOS: Dict[str, str] = {
    "CC": "Cuerpo Consular",
    "CD": "Cuerpo Diplomático",
    "OI": "Organismo Internacional",
    "AT": "Asistencia Técnica",
    "PP": "Provisional / Internación Temporal",
}

# =============================================================================
# Matrices de Confusión Posicional (OCR Vehicular)
# Se aplican como hipótesis: se elige el formato que necesita menos sustituciones y cada una queda
# registrada (ver app/dominio/interpretacion_placa.py).
# =============================================================================

# Si el carácter se encuentra en zona ALFABÉTICA (posiciones 0, 1, 2)
DIGIT_TO_LETTER: Dict[str, str] = {
    "0": "O",
    "1": "I",
    "8": "B",
    "5": "S",
    "2": "Z",
    "6": "G",
    "4": "A",
    "7": "T",
    "3": "B",
    "9": "P",
}

# Si el carácter se encuentra en zona NUMÉRICA (posiciones 3, 4, 5, 6)
LETTER_TO_DIGIT: Dict[str, str] = {
    "O": "0",
    "D": "0",
    "Q": "0",
    "U": "0",
    "I": "1",
    "L": "1",
    "J": "1",
    "Z": "2",
    "S": "5",
    "B": "8",
    "G": "6",
    "A": "4",
    "T": "7",
    "Y": "7",
    "P": "9",
}

# Sustituciones contextuales para la PRIMERA LETRA (Provincia ANT)
CONFUSIONES_PRIMERA_LETRA: Dict[str, str] = {
    "D": "P",  # 'D' no es provincia en Ecuador; confusión común de 'P' (Pichincha) por remache
    "0": "O",  # '0' -> 'O' (El Oro)
    "1": "I",  # '1' -> 'I' (Imbabura)
    "8": "B",  # '8' -> 'B' (Bolívar)
    "5": "S",  # '5' -> 'S' (Pastaza)
    "2": "Z",  # '2' -> 'Z' (Zamora)
    "6": "G",  # '6' -> 'G' (Guayas)
    "4": "A",  # '4' -> 'A' (Azuay)
    "7": "T",  # '7' -> 'T' (Tungurahua)
}

# Ruido institucional que suele aparecer en el banner superior
HEADER_NOISE_WORDS: set[str] = {
    "ECUADOR", "ANT", "GOBIERNO", "NACIONAL", "DEL", "PROVINCIA", 
    "TRANSITO", "TRANSPORTE", "TERRESTRE", "COMERCIAL", "CONSORCIO"
}


@dataclass
class EcuadorPlateValidationResult:
    """Resultado estructurado de validación y sintaxis de matrícula ecuatoriana."""
    is_valid: bool
    formatted_plate: str        # Formato normalizado: AAA-1234
    raw_plate: str              # Cadena sin formato
    confidence_score: float     # Nivel de confianza sintáctica (0.0 a 1.0)
    tipo_vehiculo: str          # "Particular", "Comercial", "Estado", "Diplomático", "Moto"
    provincia: str              # Nombre de la provincia emisora (ej. "Pichincha")
    servicio: str               # Descripción del servicio vehicular
    correcciones: tuple = ()    # Sustituciones aplicadas al texto leído: (posición, leído, interpretado)


class EcuadorPlateValidator:
    """
    Validador Sintáctico y Normalizador de Matrículas para la República del Ecuador.
    Aplica matrices de confusión dependientes de posición y verificación de códigos ANT.
    """

    REGEX_ESTANDAR = re.compile(r"^[A-Z]{3}-?\d{3,4}$")
    REGEX_DIPLOMATICO = re.compile(r"^(CC|CD|OI|AT|PP)-?\d{4}$")
    REGEX_MOTO = re.compile(r"^[A-Z]{2}-?\d{3,4}[A-Z]?$")

    @classmethod
    def sanitize(cls, raw_text: str) -> str:
        """Elimina ruido, espacios y caracteres especiales, dejando solo alfanuméricos en mayúsculas."""
        if not raw_text:
            return ""
        text = str(raw_text).upper().strip()
        for word in HEADER_NOISE_WORDS:
            text = re.sub(rf"\b{word}\b", "", text)
        return re.sub(r"[^A-Z0-9]", "", text)

    @classmethod
    def interpretar(cls, text: str) -> Interpretacion:
        """
        Formato (diplomático, particular o moto, en ese orden ante empates) que explica el texto con
        menos sustituciones de las matrices de confusión; la primera letra admite además las
        confusiones de provincia. Nunca agrega ni quita caracteres.
        """
        return interpretar(
            text, formatos=(DIPLOMATICO, PARTICULAR, MOTO), digito_a_letra=DIGIT_TO_LETTER,
            letra_a_digito=LETTER_TO_DIGIT, primera_letra=CONFUSIONES_PRIMERA_LETRA, ruido=HEADER_NOISE_WORDS,
        )

    @classmethod
    def disambiguate(cls, text: str) -> str:
        """Placa interpretada ("PBA-1234") o, si ningún formato encaja, el texto leído tal cual."""
        interpretacion = cls.interpretar(text)
        return interpretacion.placa or interpretacion.crudo

    @classmethod
    def validate(cls, raw_text: str) -> EcuadorPlateValidationResult:
        """
        Valida exhaustivamente una matrícula contra la normativa ANT Ecuador.
        Retorna la estructura validada con provincia, tipo de servicio y score de confianza.
        """
        interpretacion = cls.interpretar(raw_text)
        cleaned = interpretacion.crudo
        disambiguated = interpretacion.placa or cleaned
        correcciones = interpretacion.correcciones
        clean_no_hyphen = disambiguated.replace("-", "")

        # 1. Validación de Matrícula Estándar (Automóviles / Camionetas / Buses)
        match_std = cls.REGEX_ESTANDAR.match(disambiguated)
        if match_std:
            letra_prov = clean_no_hyphen[0]
            segunda_letra = clean_no_hyphen[1]

            provincia = CODIGOS_PROVINCIALES_ANT.get(letra_prov, "No Identificada")
            servicio = TIPOS_SERVICIO_SEGUNDA_LETRA.get(segunda_letra, "Particular (Uso Privado)")
            tipo_veh = "Comercial" if segunda_letra in ("A", "U", "Z") else (
                "Gubernamental" if segunda_letra == "E" else (
                    "Municipal" if segunda_letra == "M" else "Particular"
                )
            )

            is_valid_prov = letra_prov in CODIGOS_PROVINCIALES_ANT
            score = 1.0 if is_valid_prov else 0.85

            return EcuadorPlateValidationResult(
                is_valid=is_valid_prov,
                formatted_plate=disambiguated if "-" in disambiguated else f"{clean_no_hyphen[:3]}-{clean_no_hyphen[3:]}",
                raw_plate=cleaned,
                confidence_score=score,
                tipo_vehiculo=tipo_veh,
                provincia=provincia,
                servicio=servicio,
                correcciones=correcciones,
            )

        # 2. Validación de Cuerpo Diplomático
        match_dip = cls.REGEX_DIPLOMATICO.match(disambiguated)
        if match_dip:
            prefix = clean_no_hyphen[:2]
            return EcuadorPlateValidationResult(
                is_valid=True,
                formatted_plate=disambiguated if "-" in disambiguated else f"{prefix}-{clean_no_hyphen[2:]}",
                raw_plate=cleaned,
                confidence_score=0.95,
                tipo_vehiculo="Diplomático / Misión",
                provincia="Pichincha (Sede Cancillería)",
                servicio=PREFIJOS_DIPLOMATICOS.get(prefix, "Organismo Internacional"),
                correcciones=correcciones,
            )

        # 3. Validación de Motocicletas
        match_moto = cls.REGEX_MOTO.match(disambiguated)
        if match_moto:
            letra_prov = clean_no_hyphen[0]
            provincia = CODIGOS_PROVINCIALES_ANT.get(letra_prov, "No Identificada")
            return EcuadorPlateValidationResult(
                is_valid=letra_prov in CODIGOS_PROVINCIALES_ANT,
                formatted_plate=disambiguated,
                raw_plate=cleaned,
                confidence_score=0.88,
                tipo_vehiculo="Motocicleta / Bicimoto",
                provincia=provincia,
                servicio="Particular / Comercial",
                correcciones=correcciones,
            )

        # 4. Placa Parcial o No Conforme
        return EcuadorPlateValidationResult(
            is_valid=False,
            formatted_plate=disambiguated,
            raw_plate=cleaned,
            confidence_score=0.35 if len(clean_no_hyphen) >= 4 else 0.0,
            tipo_vehiculo="No Identificado",
            provincia="Desconocida",
            servicio="No Legible",
        )


def formato_placa(plate_text: str) -> str:
    """Formato ANT con que se interpreta la lectura: 'particular', 'moto', 'diplomatico' o '' (ninguno)."""
    return EcuadorPlateValidator.interpretar(plate_text).formato


def formato_coherente_con_la_placa(plate_text: str, es_moto: bool) -> bool:
    """
    Una placa de auto (recuadro alargado, una fila) se lee con formato de auto (3 letras + 3 o 4
    dígitos) o diplomático; las de moto son casi cuadradas, de dos filas. Una lectura con formato de
    moto dentro de un recuadro de auto es texto que no es una placa (teclado, pantalla, rótulo) o una
    placa de auto mal leída a la que le falta un carácter (PJF001 → PJ001).
    """
    return es_moto or formato_placa(plate_text) != "moto"


def validate_ecuadorian_plate(plate_text: str) -> Tuple[bool, str, float]:
    """
    Función de conveniencia para validar y normalizar matrículas ecuatorianas.
    Retorna: (is_valid, formatted_plate, confidence_score)
    """
    res = EcuadorPlateValidator.validate(plate_text)
    return res.is_valid, res.formatted_plate, res.confidence_score
