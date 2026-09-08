from app.utils.plate_parser import validate_ecuadorian_plate, clean_ocr_mistakes

def test_clean_ocr_mistakes():
    # Caso 1: Reemplazar números por letras en sección de letras
    assert clean_ocr_mistakes("P0A1234") == "POA1234"
    assert clean_ocr_mistakes("1AB987") == "IAB987"
    
    # Caso 2: Reemplazar letras por números en sección numérica
    assert clean_ocr_mistakes("PBA123O") == "PBA1230"
    assert clean_ocr_mistakes("PBA12I4") == "PBA1214"
    assert clean_ocr_mistakes("PBA12S4") == "PBA1254"

def test_validate_ecuadorian_plate_standard():
    # Placas estándar de 3 letras y 4 números
    valido, placa = validate_ecuadorian_plate("PCA1234")
    assert valido is True
    assert placa == "PCA1234"

    # Placas estándar de 3 letras y 3 números
    valido, placa = validate_ecuadorian_plate("PBA789")
    assert valido is True
    assert placa == "PBA789"

def test_validate_ecuadorian_plate_special():
    # Cuerpo Consular (Especial)
    valido, placa = validate_ecuadorian_plate("CC0123")
    assert valido is True
    assert placa == "CC0123"

    # Policía Nacional (Especial)
    valido, placa = validate_ecuadorian_plate("PP0523")
    assert valido is True
    assert placa == "PP0523"

def test_validate_ecuadorian_plate_invalid():
    # Placa inválida (muy corta, caracteres raros, etc.)
    valido, placa = validate_ecuadorian_plate("XYZ1")
    assert valido is False
