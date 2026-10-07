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
# Matrices de Confusión Posicional Deterministas (OCR Vehicular)
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
    def disambiguate(cls, text: str) -> str:
        """
        Aplica desambiguación posicional determinista:
          - Zona 1 (Letras 0..2): Convierte dígitos a sus letras más probables y valida provincia ANT.
          - Zona 2 (Dígitos 3..fin): Convierte letras a sus dígitos correspondientes.
        """
        clean = cls.sanitize(text)
        n = len(clean)
        if n < 4:
            return clean

        chars = list(clean)

        # 1. Caso Especial Diplomático (CC, CD, OI, AT, PP + 4 dígitos)
        prefix_2 = clean[:2]
        if prefix_2 in PREFIJOS_DIPLOMATICOS and n >= 5:
            prefix = prefix_2
            suffix = ""
            for i in range(2, min(n, 6)):
                c = chars[i]
                suffix += LETTER_TO_DIGIT.get(c, c) if not c.isdigit() else c
            return f"{prefix}-{suffix}"

        # 2. Caso Estándar Ecuatoriano (3 Letras + 3 o 4 Dígitos: Total 6 o 7 caracteres)
        if n in (6, 7):
            prefix = ""
            for i in range(3):
                c = chars[i]
                # Primera letra: validación estricta de provincia ANT
                if i == 0 and c in CONFUSIONES_PRIMERA_LETRA:
                    prefix += CONFUSIONES_PRIMERA_LETRA[c]
                elif not c.isalpha():
                    prefix += DIGIT_TO_LETTER.get(c, c)
                else:
                    # Si vino una letra que no es provincia (ej. 'D'), mapear a 'P'
                    if i == 0 and c not in CODIGOS_PROVINCIALES_ANT:
                        prefix += CONFUSIONES_PRIMERA_LETRA.get(c, c)
                    else:
                        prefix += c

            suffix = ""
            for i in range(3, n):
                c = chars[i]
                suffix += LETTER_TO_DIGIT.get(c, c) if not c.isdigit() else c

            if len(prefix) == 3 and prefix.isalpha() and suffix.isdigit():
                return f"{prefix}-{suffix}"

        # 3. Caso Motocicletas (2 Letras + 3-4 Dígitos + 1 Letra opcional: Total 5 o 6 caracteres estrictos)
        if (5 <= n <= 6) and chars[0].isalpha() and chars[1].isalpha() and (n == 5 or chars[2].isdigit()):
            prefix = chars[0] + chars[1]
            suffix = "".join(LETTER_TO_DIGIT.get(c, c) if i < n - 1 else c for i, c in enumerate(chars[2:]))
            return f"{prefix}-{suffix}"

        return clean

    @classmethod
    def validate(cls, raw_text: str) -> EcuadorPlateValidationResult:
        """
        Valida exhaustivamente una matrícula contra la normativa ANT Ecuador.
        Retorna la estructura validada con provincia, tipo de servicio y score de confianza.
        """
        cleaned = cls.sanitize(raw_text)
        disambiguated = cls.disambiguate(cleaned)
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


def validate_ecuadorian_plate(plate_text: str) -> Tuple[bool, str, float]:
    """
    Función de conveniencia para validar y normalizar matrículas ecuatorianas.
    Retorna: (is_valid, formatted_plate, confidence_score)
    """
    res = EcuadorPlateValidator.validate(plate_text)
    return res.is_valid, res.formatted_plate, res.confidence_score
