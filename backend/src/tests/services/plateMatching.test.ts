import { comparePlates, levenshtein, normalizePlate } from '../../services/plateMatching';

describe('plateMatching', () => {
  it('normaliza guiones, espacios y minúsculas', () => {
    expect(normalizePlate(' pba-1234 ')).toBe('PBA1234');
    expect(normalizePlate(null)).toBe('');
  });

  it('calcula la distancia de Levenshtein', () => {
    expect(levenshtein('PBA1234', 'PBA1234')).toBe(0);
    expect(levenshtein('PBA1234', 'PBA123')).toBe(1);
    expect(levenshtein('PCA1234', 'TBG9870')).toBe(7);
  });

  it('coincidencia exacta ignora el formato', () => {
    expect(comparePlates('PBA-1234', 'pba1234')).toBe('exacta');
  });

  it('una lectura parcial por sufijo NO es exacta (no debe autorizar)', () => {
    expect(comparePlates('BA1234', 'PBA1234')).not.toBe('exacta');
  });

  it('confusiones típicas de OCR se detectan como aproximadas', () => {
    expect(comparePlates('P8A1234', 'PBA1234')).toBe('aproximada');
    expect(comparePlates('PBAI234', 'PBA1234')).toBe('aproximada');
    expect(comparePlates('TBG9B7', 'TBG987')).toBe('aproximada');
    expect(comparePlates('TCH9O7', 'TBG987')).toBe(null); // 3 diferencias reales
  });

  it('un carácter omitido en placa larga es aproximado', () => {
    expect(comparePlates('PBA123', 'PBA1234')).toBe('aproximada');
  });

  it('placas distintas no coinciden', () => {
    expect(comparePlates('PCD5678', 'PBA1234')).toBe(null);
    expect(comparePlates('', 'PBA1234')).toBe(null);
    expect(comparePlates('AB12', 'AB13')).toBe(null);
  });
});
