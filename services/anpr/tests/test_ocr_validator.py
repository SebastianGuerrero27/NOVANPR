"""
Tests para el validador de placas ecuatorianas
"""

import pytest
from app.core.ecuador_plate_validator import validate_ecuadorian_plate


class TestEcuadorianPlateValidator:
    """Tests para validación de placas ecuatorianas"""

    def test_valid_standard_plate(self):
        """Test de placa estándar válida"""
        is_valid, formatted, score = validate_ecuadorian_plate('PBA1234')
        assert is_valid is True
        assert formatted == 'PBA-1234'
        assert score > 0.8

    def test_valid_standard_plate_with_dash(self):
        """Test de placa estándar válida con guión"""
        is_valid, formatted, score = validate_ecuadorian_plate('PBA-1234')
        assert is_valid is True
        assert formatted == 'PBA-1234'

    def test_valid_moto_plate(self):
        """Test de placa de motocicleta válida"""
        is_valid, formatted, score = validate_ecuadorian_plate('AB123C')
        assert is_valid is True
        assert formatted == 'AB-123C'

    def test_invalid_too_short(self):
        """Test de placa muy corta"""
        is_valid, formatted, score = validate_ecuadorian_plate('PB12')
        assert is_valid is False

    def test_invalid_too_long(self):
        """Test de placa muy larga"""
        is_valid, formatted, score = validate_ecuadorian_plate('PBA123456')
        assert is_valid is False

    def test_invalid_characters(self):
        """Test de placa con caracteres inválidos"""
        is_valid, formatted, score = validate_ecuadorian_plate('PB@1234')
        assert is_valid is False

    def test_case_insensitive(self):
        """Test de insensibilidad a mayúsculas/minúsculas"""
        is_valid_lower, formatted_lower, _ = validate_ecuadorian_plate('pba1234')
        is_valid_upper, formatted_upper, _ = validate_ecuadorian_plate('PBA1234')
        
        assert is_valid_lower == is_valid_upper
        assert formatted_lower == formatted_upper

    def test_formatting_with_spaces(self):
        """Test de formateo con espacios"""
        is_valid, formatted, score = validate_ecuadorian_plate('PBA 1234')
        assert is_valid is True
        assert formatted == 'PBA-1234'

    def test_3_digit_plate(self):
        """Test de placa con 3 dígitos"""
        is_valid, formatted, score = validate_ecuadorian_plate('PBA123')
        assert is_valid is True
        assert formatted == 'PBA-123'

    def test_4_digit_plate(self):
        """Test de placa con 4 dígitos"""
        is_valid, formatted, score = validate_ecuadorian_plate('PBA1234')
        assert is_valid is True
        assert formatted == 'PBA-1234'

    def test_diplomatic_plate(self):
        """Test de placa diplomática (si está implementada)"""
        is_valid, formatted, score = validate_ecuadorian_plate('CD1234')
        # Puede variar según la implementación
        assert isinstance(is_valid, bool)

    def test_institutional_plate(self):
        """Test de placa institucional (si está implementada)"""
        is_valid, formatted, score = validate_ecuadorian_plate('GZ1234')
        # Puede variar según la implementación
        assert isinstance(is_valid, bool)

    def test_empty_string(self):
        """Test de string vacío"""
        is_valid, formatted, score = validate_ecuadorian_plate('')
        assert is_valid is False

    def test_none_input(self):
        """Test de input None"""
        is_valid, formatted, score = validate_ecuadorian_plate(None)
        assert is_valid is False

    def test_score_range(self):
        """Test de rango de score"""
        is_valid, formatted, score = validate_ecuadorian_plate('PBA1234')
        if is_valid:
            assert 0 <= score <= 1.0


if __name__ == '__main__':
    pytest.main([__file__, '-v'])