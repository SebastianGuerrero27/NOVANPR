import unittest
from app.utils.plate_parser import validate_ecuadorian_plate, clean_ocr_mistakes


class TestEcuadorPlateParser(unittest.TestCase):
    def test_clean_ocr_mistakes(self):
        # Caso 1: Reemplazar números por letras en sección de letras
        self.assertEqual(clean_ocr_mistakes("P0A1234"), "POA1234")
        self.assertEqual(clean_ocr_mistakes("1AB987"), "IAB987")
        
        # Caso 2: Reemplazar letras por números en sección numérica
        self.assertEqual(clean_ocr_mistakes("PBA123O"), "PBA1230")
        self.assertEqual(clean_ocr_mistakes("PBA12I4"), "PBA1214")
        self.assertEqual(clean_ocr_mistakes("PBA12S4"), "PBA1254")

    def test_validate_ecuadorian_plate_standard(self):
        # Placas estándar de 3 letras y 4 números
        valido, placa = validate_ecuadorian_plate("PCA1234")
        self.assertTrue(valido)
        self.assertEqual(placa, "PCA1234")

        # Placas estándar de 3 letras y 3 números
        valido, placa = validate_ecuadorian_plate("PBA789")
        self.assertTrue(valido)
        self.assertEqual(placa, "PBA789")

    def test_validate_ecuadorian_plate_special(self):
        # Cuerpo Consular (Especial)
        valido, placa = validate_ecuadorian_plate("CC0123")
        self.assertTrue(valido)
        self.assertEqual(placa, "CC0123")

        # Policía Nacional (Especial)
        valido, placa = validate_ecuadorian_plate("PP0523")
        self.assertTrue(valido)
        self.assertEqual(placa, "PP0523")

    def test_validate_ecuadorian_plate_invalid(self):
        # Placa inválida (muy corta, caracteres raros, etc.)
        valido, placa = validate_ecuadorian_plate("XYZ1")
        self.assertFalse(valido)


if __name__ == "__main__":
    unittest.main()
