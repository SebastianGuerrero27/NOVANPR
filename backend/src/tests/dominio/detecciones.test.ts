import { evidenciaDe, MAX_EVIDENCIA, normalizarFuente, serializarEvidencia } from '../../dominio/detecciones';

describe('Detecciones · fuente de la detección', () => {
  it('una URL RTSP (con o sin credenciales) se guarda como «rtsp»: nunca la URL', () => {
    expect(normalizarFuente('rtsp://anpr:token-de-servicio@mediamtx:8554/cam_1')).toBe('rtsp');
    expect(normalizarFuente('RTSPS://u:p@camara:322/ruta')).toBe('rtsp');
    expect(normalizarFuente('http://x/y')).toBe('rtsp');
  });

  it('identificadores cortos se conservan; ausente o inválido → «rtsp»', () => {
    expect(normalizarFuente('rtsp')).toBe('rtsp');
    expect(normalizarFuente('manual')).toBe('manual');
    for (const malo of [undefined, null, '', '   ', 5, {}, 'con espacios', 'x'.repeat(21), '<script>']) {
      expect(normalizarFuente(malo)).toBe('rtsp');
    }
  });
});

describe('Detecciones · evidencia de la lectura', () => {
  const base = { valido: false, formato: true, motivos: ['caracteres inferidos por el formato, sin lectura directa: 5 (posición 4)'],
    caracteres_inferidos: [[3, '5']], lectura_ocr_cruda: 'PSYS89', lectura_verificador_cruda: 'PSYS89' };

  it('se guarda tal cual cuando cabe en la columna', () => {
    expect(evidenciaDe({ evidencia_lectura: serializarEvidencia(base) })).toEqual(base);
  });

  it('si no cabe se omiten primero los tiempos por etapa: nunca queda un JSON cortado e ilegible', () => {
    const etapas_ms = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`etapa_${i}`, 1234.5]));
    const json = serializarEvidencia({ ...base, etapas_ms });
    expect(json!.length).toBeLessThanOrEqual(MAX_EVIDENCIA);
    expect(evidenciaDe({ evidencia_lectura: json })).toEqual(base);
  });

  it('una evidencia que no es un objeto o que ni recortada cabe no se guarda', () => {
    for (const mala of [null, 'texto', 5, [1, 2]]) expect(serializarEvidencia(mala)).toBeNull();
    expect(serializarEvidencia({ lectura_ocr: 'X'.repeat(MAX_EVIDENCIA) })).toBeNull();
  });
});
