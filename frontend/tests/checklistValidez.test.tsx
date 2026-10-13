/**
 * Detalle del paso: la lista de evidencias indica si cada carácter de la placa lo leyó algún lector
 * tal cual y muestra la salida cruda de cada uno (sin las interpretaciones 5↔S, 0↔O…).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { EvidenciaLectura } from '../src/dominio/tipos';
import { ChecklistValidez } from '../src/interfaz/paginas/DetalleDeteccion';

const BASE: EvidenciaLectura = {
  valido: true, formato: true, dentro_cuadro: true, caracteres: 6, lecturas: 2, verificador_coincide: true, motivos: [],
};

describe('Evidencias de la lectura', () => {
  it('señala los caracteres inferidos por el formato y muestra el texto leído sin interpretar', () => {
    render(<ChecklistValidez valida={false} ev={{
      ...BASE, valido: false, motivos: ['caracteres inferidos por el formato, sin lectura directa: 5 (posición 4)'],
      caracteres_inferidos: [[3, '5']], lectura_ocr_cruda: 'PSYS89', lectura_verificador_cruda: 'PSYS89', lecturas_rapidas_crudas: ['PSYS89'],
    }} />);
    expect(screen.getByText('Lectura directa de cada carácter')).toBeTruthy();
    expect(screen.getByText('Inferidos por el formato, sin que ningún lector los leyera: 5 (posición 4).')).toBeTruthy();
    expect(screen.getByText('Texto leído, sin interpretar: OCR PSYS89 · verificador PSYS89 · otros cuadros PSYS89.')).toBeTruthy();
  });

  it('con todos los caracteres leídos tal cual, la evidencia se cumple', () => {
    render(<ChecklistValidez valida ev={{ ...BASE, caracteres_inferidos: [], lectura_ocr_cruda: 'PSY589' }} />);
    expect(screen.getByText('Algún lector leyó tal cual cada carácter de la placa.')).toBeTruthy();
  });

  it('los registros anteriores a esta evidencia no muestran la fila ni el texto crudo', () => {
    render(<ChecklistValidez valida ev={BASE} />);
    expect(screen.queryByText('Lectura directa de cada carácter')).toBeNull();
    expect(screen.queryByText(/Texto leído, sin interpretar/)).toBeNull();
  });
});
