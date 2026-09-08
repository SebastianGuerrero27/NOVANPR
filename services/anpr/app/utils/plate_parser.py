"""
Validador, Normalizador y Parser Avanzado de Placas Vehiculares — Estándar República del Ecuador.

Formatos Oficiales Soportados (ANT / CTE / Policía Nacional):
  1. Estándar Particular, Comercial e Institucional: 3 Letras + 3 o 4 Dígitos (ej: PBA-1234, TBG-0987, TCA-901)
  2. Motocicletas y Cuadrones: 2 Letras + 3 o 4 Dígitos + (opcional 1 Letra) (ej: PB-123A, TC-9012)
  3. Cuerpos Diplomáticos / Consulares / Organismos: CC, CD, OI, AT + 4 Dígitos (ej: CC-0123, CD-0456)
  4. Policía Nacional / Vehículos Estatales: PP + 4 Dígitos (ej: PP-1234) o E + 4 a 5 Dígitos (ej: E-12345)
"""

from __future__ import annotations

import re
from typing import Optional, Tuple, List

# Palabras institucionales, marcas de vehículos y señales que deben ser ignoradas
HEADER_NOISE_WORDS = {
    # Institucionales
    "ECUADOR",
    "TRANSPORTE",
    "PUBLICO",
    "PARTICULAR",
    "GOBIERNO",
    "COMERCIAL",
    "POLICIA",
    "NACIONAL",
    "ANT",
    "COORDINACION",
    "ZONAL",
    "EMERGENCIAS",
    "911",
    "TRANSITO",
    "CTE",
    "GAD",
    "MUNICIPAL",
    "PROVINCIA",
    "ESTADO",
    # Marcas automotrices comunes (evita detectar emblemas como placas)
    "CHEVROLET",
    "TOYOTA",
    "HYUNDAI",
    "NISSAN",
    "FORD",
    "KIA",
    "MAZDA",
    "MITSUBISHI",
    "RENAULT",
    "VOLKSWAGEN",
    "SUZUKI",
    "YAMAHA",
    "HONDA",
    "BMW",
    "MERCEDES",
    "AUDI",
    "HINO",
    "ISUZU",
    "JAC",
    "GREATWALL",
    "CHERY",
    "PEUGEOT",
    "FIAT",
    "JEEP",
    # Señalética y palabras comunes
    "STOP",
    "PARE",
    "ENTRADA",
    "SALIDA",
    "PARKING",
    "PARQUEADERO",
    "AUTO",
    "CAR",
    "SELECCION",
    "VENTA",
    "DISCOVERY",
    "TURISMO",
    "INTERPROVINCIAL",
}

# Códigos provinciales oficiales de Ecuador (Primer carácter de la matrícula)
PROVINCE_CODES = {
    "A": "Azuay",
    "B": "Bolívar",
    "U": "Cañar",
    "C": "Carchi",
    "X": "Cotopaxi",
    "H": "Chimborazo",
    "O": "El Oro",
    "E": "Esmeraldas",
    "W": "Galápagos",
    "G": "Guayas",
    "I": "Imbabura",
    "L": "Loja",
    "R": "Los Ríos",
    "M": "Manabí",
    "V": "Morona Santiago",
    "N": "Napo",
    "S": "Pastaza",
    "P": "Pichincha",
    "Q": "Orellana",
    "K": "Sucumbíos",
    "T": "Tungurahua",
    "Z": "Zamora Chinchipe",
    "Y": "Santa Elena",
    "J": "Santo Domingo de los Tsáchilas",
}

# Mapeos de desambiguación tipográfica
DIGIT_TO_LETTER = {
    "0": "O",
    "1": "I",
    "8": "B",
    "5": "S",
    "2": "Z",
    "6": "G",
    "4": "A",
    "7": "T",
    "3": "B",
}

LETTER_TO_DIGIT = {
    "O": "0",
    "D": "0",
    "Q": "0",
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
}

# Expresiones regulares para validación de patrones
REGEX_ESTANDAR = re.compile(r"^[A-Z]{3}-?\d{3,4}$")
REGEX_ESPECIAL = re.compile(r"^(CC|CD|OI|AT|PP)-?\d{4}$")
REGEX_ESTATAL_CORTO = re.compile(r"^[A-Z]{1}-?\d{4,5}$")
REGEX_MOTO = re.compile(r"^[A-Z]{2}-?\d{3,4}[A-Z]?$")


def sanitize_raw_text(raw_text: str) -> str:
    """Elimina ruido, espacios y caracteres especiales, dejando solo alfanuméricos en mayúsculas."""
    if not raw_text:
        return ""
    text = str(raw_text).upper().strip()
    # Filtrar palabras de cabecera si están presentes
    for word in HEADER_NOISE_WORDS:
        text = re.sub(rf"\b{word}\b", "", text)
    # Dejar solo A-Z y 0-9
    return re.sub(r"[^A-Z0-9]", "", text)


def disambiguate_plate(text: str) -> str:
    """
    Aplica desambiguación de caracteres dependiente de la posición para matrículas ecuatorianas.
    Ejemplo: '0BA123A' -> 'OBA-1234' | 'PBA-I234' -> 'PBA-1234' | 'TCA9O12' -> 'TCA-9012'
    """
    clean = sanitize_raw_text(text)
    if len(clean) < 4:
        return clean

    chars = list(clean)
    n = len(chars)

    # 1. Caso Especial Diplomático/Oficial (2 Letras + 4 Dígitos, ej: CC-1234, PP-5678, CD-0123)
    if n == 6 and clean[:2] in ("CC", "CD", "OI", "AT", "PP"):
        prefix = clean[:2]
        suffix = ""
        for i in range(2, 6):
            c = chars[i]
            suffix += LETTER_TO_DIGIT.get(c, c) if not c.isdigit() else c
        if suffix.isdigit():
            return f"{prefix}-{suffix}"

    # 2. Caso Estándar Ecuatoriano (6 o 7 caracteres: 3 Letras + 3 o 4 Dígitos)
    if n in (6, 7):
        prefix = ""
        for i in range(3):
            c = chars[i]
            prefix += DIGIT_TO_LETTER.get(c, c) if not c.isalpha() else c

        # Corrección de confusión OCR común en inicial de provincia ('D' -> 'P')
        if prefix and prefix[0] == "D":
            prefix = "P" + prefix[1:]

        suffix = ""
        for i in range(3, n):
            c = chars[i]
            suffix += LETTER_TO_DIGIT.get(c, c) if not c.isdigit() else c

        # Validar si el prefijo tiene 3 letras y el sufijo 3-4 dígitos
        if len(prefix) == 3 and prefix.isalpha() and suffix.isdigit():
            return f"{prefix}-{suffix}"

    # 3. Caso Motocicleta (2 Letras + 3 o 4 Dígitos + opcional 1 Letra, ej: PB-123A o PB-1234)
    if n in (5, 6):
        prefix = ""
        for i in range(2):
            c = chars[i]
            prefix += DIGIT_TO_LETTER.get(c, c) if not c.isalpha() else c

        mid_digits = ""
        for i in range(2, n):
            c = chars[i]
            if i == n - 1 and chars[i].isalpha() and n == 6:
                # Último carácter puede ser letra en algunas motos
                mid_digits += DIGIT_TO_LETTER.get(c, c)
            else:
                mid_digits += LETTER_TO_DIGIT.get(c, c) if not c.isdigit() else c

        if len(prefix) == 2 and prefix.isalpha():
            return f"{prefix}-{mid_digits}"

    # 4. Caso Estatal Corto (1 Letra + 4 o 5 Dígitos, ej: E-12345)
    if n in (5, 6) and (chars[0] == "E" or chars[0] in DIGIT_TO_LETTER):
        first_letter = DIGIT_TO_LETTER.get(chars[0], chars[0]) if not chars[0].isalpha() else chars[0]
        suffix = ""
        for i in range(1, n):
            c = chars[i]
            suffix += LETTER_TO_DIGIT.get(c, c) if not c.isdigit() else c
        if first_letter.isalpha() and suffix.isdigit():
            return f"{first_letter}-{suffix}"

    return clean


def validate_ecuadorian_plate(raw_text: str) -> Tuple[bool, str, float]:
    """
    Valida y formatea una placa contra los patrones oficiales del Ecuador.
    
    Returns:
        (es_valida, placa_formateada, score_confianza_formato)
    """
    if not raw_text:
        return False, "", 0.0

    normalized = disambiguate_plate(raw_text)
    clean_no_hyphen = normalized.replace("-", "")

    # Caso Estándar 3 Letras + 3 o 4 Dígitos (PBA-1234 / TCA-901)
    if REGEX_ESTANDAR.match(normalized):
        first_letter = normalized[0]
        # Bonificación si la primera letra corresponde a una provincia válida
        province_bonus = 0.15 if first_letter in PROVINCE_CODES else 0.05
        return True, normalized, 0.85 + province_bonus

    # Caso Especial (Diplomáticos, Policía)
    if REGEX_ESPECIAL.match(normalized):
        return True, normalized, 0.90

    # Caso Estatal Corto
    if REGEX_ESTATAL_CORTO.match(normalized):
        return True, normalized, 0.85

    # Caso Moto
    if REGEX_MOTO.match(normalized):
        return True, normalized, 0.80

    # Placa parcial o incompleta (al menos 3 caracteres alfanuméricos)
    if len(clean_no_hyphen) >= 3:
        return False, normalized, 0.40

    return False, raw_text, 0.0


def extract_plate_from_tokens(tokens: List[str]) -> Tuple[str, float]:
    """
    Ensambla tokens OCR individuales (ej: ['ECUADOR', 'PBA', '1234'])
    buscando combinaciones horizontales y verticales que formen una matrícula válida.
    """
    if not tokens:
        return "", 0.0

    filtered_tokens = []
    for t in tokens:
        clean = sanitize_raw_text(t)
        if clean and clean not in HEADER_NOISE_WORDS:
            filtered_tokens.append(clean)

    if not filtered_tokens:
        return "", 0.0

    # 1. Probar tokens individuales directos
    for t in filtered_tokens:
        is_valid, plate, score = validate_ecuadorian_plate(t)
        if is_valid:
            return plate, score

    # 2. Probar combinaciones de pares consecutivos (ej: 'PBA' + '1234' -> 'PBA1234')
    for i in range(len(filtered_tokens)):
        for j in range(i + 1, len(filtered_tokens)):
            combined = filtered_tokens[i] + filtered_tokens[j]
            is_valid, plate, score = validate_ecuadorian_plate(combined)
            if is_valid:
                return plate, score

            # Probar orden inverso
            combined_rev = filtered_tokens[j] + filtered_tokens[i]
            is_valid, plate, score = validate_ecuadorian_plate(combined_rev)
            if is_valid:
                return plate, score

    # 3. Probar concatenación total
    all_combined = "".join(filtered_tokens)
    is_valid, plate, score = validate_ecuadorian_plate(all_combined)
    if is_valid:
        return plate, score

    # 4. Búsqueda de subcadena con Regex dentro del texto concatenado
    match = re.search(r"([A-Z0-9]{3})[-_\s]?([A-Z0-9]{3,4})", all_combined)
    if match:
        extracted = match.group(1) + match.group(2)
        is_valid, plate, score = validate_ecuadorian_plate(extracted)
        if is_valid:
            return plate, score

    # Retornar el token más prometedor con formato
    best_raw = max(filtered_tokens, key=len)
    disambiguated = disambiguate_plate(best_raw)
    return disambiguated, 0.40
