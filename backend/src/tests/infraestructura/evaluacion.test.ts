import { bucketDistancia, bucketLuz, calcularEvaluacion, FilaEvaluacion, tipoPlaca, wilson } from '../../infraestructura/servicios/evaluacion';

const fila = (over: Partial<FilaEvaluacion>): FilaEvaluacion => ({
  id: 1, placa_ocr_original: 'PBA1234', placa_validada: 'PBA-1234',
  decision_automatica: 'no_reconocido', decision_final: 'no_reconocido', latencia_ms: 500,
  luminancia_media: 120, distancia_estimada_m: 4, condicion_clima: null, fecha_hora_ingreso: null,
  ...over,
});

describe('evaluacion', () => {
  it('exactitud por placa y CER comparan contra la placa validada', () => {
    const r = calcularEvaluacion([
      fila({ placa_ocr_original: 'PBA1234' }),
      fila({ placa_ocr_original: 'PBA1284' }), // 1 carácter mal
    ], 2);
    expect(r.global.exactitud_placa.valor).toBe(0.5);
    expect(r.global.cer_medio).toBeCloseTo((0 + 1 / 7) / 2);
    expect(r.cobertura_validacion).toBe(1);
  });

  it('lectura vacía o SIN_RECONOCER cuenta como no legible', () => {
    const r = calcularEvaluacion([fila({ placa_ocr_original: 'SIN_RECONOCER' }), fila({ placa_ocr_original: null })], 2);
    expect(r.global.tasa_no_legible.valor).toBe(1);
    expect(r.global.exactitud_placa.valor).toBe(0);
  });

  it('falsa aceptación y falso rechazo usan la decisión final del operador como verdad', () => {
    const r = calcularEvaluacion([
      fila({ decision_automatica: 'autorizado', decision_final: 'no_reconocido' }), // falsa aceptación
      fila({ decision_automatica: 'no_reconocido', decision_final: 'autorizado' }), // falso rechazo
      fila({ decision_automatica: 'autorizado', decision_final: 'autorizado' }),
      fila({ decision_automatica: 'no_reconocido', decision_final: 'no_reconocido' }),
    ], 4);
    expect(r.global.control_acceso.tasa_falsa_aceptacion.valor).toBe(0.5);
    expect(r.global.control_acceso.tasa_falso_rechazo.valor).toBe(0.5);
  });

  it('detecta vehículos de lista negra no alertados', () => {
    const r = calcularEvaluacion([
      fila({ decision_automatica: 'no_reconocido', decision_final: 'alerta' }),
      fila({ decision_automatica: 'alerta', decision_final: 'alerta' }),
    ], 2);
    expect(r.global.control_acceso.lista_negra_no_detectada.valor).toBe(0.5);
  });

  it('la cobertura revela validaciones incompletas (sesgo de selección)', () => {
    const r = calcularEvaluacion([fila({})], 4);
    expect(r.cobertura_validacion).toBe(0.25);
  });

  it('clasifica tipo y formato de placa ANT', () => {
    expect(tipoPlaca('GAA-1234')).toEqual({ servicio: 'comercial', formato: 'actual_4_digitos' });
    expect(tipoPlaca('PEA123')).toEqual({ servicio: 'gobierno', formato: 'antiguo_3_digitos' });
    expect(tipoPlaca('PSY-589').servicio).toBe('particular');
    expect(tipoPlaca('AB123C').servicio).toBe('motocicleta');
  });

  it('agrupa por luz y distancia', () => {
    expect(bucketLuz(30, null)).toBe('noche');
    expect(bucketLuz(null, '2026-09-22T21:00:00')).toBe('noche');
    expect(bucketDistancia(7.5)).toBe('6-10 m');
    expect(bucketDistancia(null)).toBe('desconocida');
  });

  it('intervalo de Wilson contiene la proporción observada', () => {
    const [lo, hi] = wilson(90, 100)!;
    expect(lo).toBeLessThan(0.9);
    expect(hi).toBeGreaterThan(0.9);
    expect(wilson(0, 0)).toBeNull();
  });
});
