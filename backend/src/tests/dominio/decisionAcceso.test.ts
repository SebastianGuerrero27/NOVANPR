import { cumpleCriterioLectura, decidirAcceso, EntradaDecision, PoliticaAutorizacion } from '../../dominio/decisionAcceso';

const POLITICA: PoliticaAutorizacion = { criterio: 'validez_y_confianza', confianzaMinima: 0.82, fuenteConfianza: 'ocr', verificarVehiculo: true };
const BUENA = { lecturaValida: true, confianzaOcr: 0.95, confianzaDeteccion: 0.9 };
const entrada = (e: Partial<EntradaDecision>): EntradaDecision => ({
  origen: 'automatico', alerta: null, permiso: null, lectura: BUENA, verificacionVehiculo: null, politica: POLITICA, ...e,
});
const PERMISO = { id: 7, vigencia: 'vigente' as const };

describe('política de decisión de acceso (tabla R1–R7)', () => {
  it('R1 · la alerta prevalece sobre todo y nunca se rebaja', () => {
    const d = decidirAcceso(entrada({ alerta: { id: 1, coincidencia: 'aproximada' }, permiso: PERMISO, lectura: { lecturaValida: false, confianzaOcr: 0.1, confianzaDeteccion: 0.1 } }));
    expect(d).toMatchObject({ estado: 'alerta', regla: 'R1' });
  });

  it.each(['fuera_horario', 'no_iniciada', 'vencida'] as const)('R2 · permiso %s → no autorizado con la restricción', (vigencia) => {
    const d = decidirAcceso(entrada({ permiso: { id: 7, vigencia } }));
    expect(d).toMatchObject({ estado: 'no_reconocido', regla: 'R2', restriccion: vigencia });
  });

  it('R2 · la excepción solo aplica en validación manual', () => {
    expect(decidirAcceso(entrada({ origen: 'manual', permiso: { id: 7, vigencia: 'fuera_horario' }, excepcion: true })))
      .toMatchObject({ estado: 'autorizado', regla: 'R2-excepcion', restriccion: 'fuera_horario' });
    expect(decidirAcceso(entrada({ origen: 'automatico', permiso: { id: 7, vigencia: 'fuera_horario' }, excepcion: true })).estado)
      .toBe('no_reconocido');
  });

  it('R3 · lectura no confirmada o con baja confianza → revisión humana', () => {
    expect(decidirAcceso(entrada({ permiso: PERMISO, lectura: { ...BUENA, lecturaValida: false } }))).toMatchObject({ estado: 'pendiente_revision', regla: 'R3' });
    expect(decidirAcceso(entrada({ permiso: PERMISO, lectura: { ...BUENA, confianzaOcr: 0.81 } }))).toMatchObject({ estado: 'pendiente_revision', regla: 'R3' });
  });

  it('R4 · vehículo distinto al registrado (si la verificación está activa)', () => {
    expect(decidirAcceso(entrada({ permiso: PERMISO, verificacionVehiculo: 'no_coincide' }))).toMatchObject({ estado: 'pendiente_revision', regla: 'R4' });
    expect(decidirAcceso(entrada({ permiso: PERMISO, verificacionVehiculo: 'no_coincide', politica: { ...POLITICA, verificarVehiculo: false } })).estado).toBe('autorizado');
  });

  it('R5 · permiso vigente y lectura suficiente → autorizado', () => {
    expect(decidirAcceso(entrada({ permiso: PERMISO }))).toMatchObject({ estado: 'autorizado', regla: 'R5', restriccion: null });
  });

  it('R5 · en validación manual la persona ya confirmó la placa (no se exige confianza)', () => {
    expect(decidirAcceso(entrada({ origen: 'manual', permiso: PERMISO, lectura: undefined })).estado).toBe('autorizado');
  });

  it('R6 · sin permiso y lectura inválida → revisión (podría ser una placa del padrón mal leída)', () => {
    expect(decidirAcceso(entrada({ lectura: { ...BUENA, lecturaValida: false } }))).toMatchObject({ estado: 'pendiente_revision', regla: 'R6' });
  });

  it('R7 · sin permiso → no autorizado', () => {
    expect(decidirAcceso(entrada({}))).toMatchObject({ estado: 'no_reconocido', regla: 'R7', restriccion: null });
    expect(decidirAcceso(entrada({ origen: 'manual', lectura: { ...BUENA, lecturaValida: false } })).regla).toBe('R7');
  });

  it('propiedad de seguridad: nunca autoriza sin permiso vigente', () => {
    const vigencias = [null, 'vigente', 'fuera_horario', 'no_iniciada', 'vencida'] as const;
    for (const v of vigencias) for (const origen of ['automatico', 'manual'] as const) for (const valida of [true, false, null]) {
      for (const conf of [0, 0.5, 0.99]) for (const vehiculo of ['coincide', 'no_coincide', 'sin_datos', null] as const) {
        const d = decidirAcceso(entrada({
          origen, permiso: v ? { id: 1, vigencia: v } : null, verificacionVehiculo: vehiculo,
          lectura: { lecturaValida: valida, confianzaOcr: conf, confianzaDeteccion: conf },
        }));
        if (d.estado === 'autorizado') expect(v).toBe('vigente');
      }
    }
  });
});

describe('criterio de lectura', () => {
  it('solo confianza ignora la validez', () => {
    expect(cumpleCriterioLectura({ lecturaValida: false, confianzaOcr: 0.9, confianzaDeteccion: null }, { ...POLITICA, criterio: 'confianza' }).cumple).toBe(true);
  });
  it('solo validez no exige confianza cuando el motor informó el veredicto', () => {
    expect(cumpleCriterioLectura({ lecturaValida: true, confianzaOcr: 0.1, confianzaDeteccion: null }, { ...POLITICA, criterio: 'validez' }).cumple).toBe(true);
    // Sin veredicto del motor, se recurre a la confianza
    expect(cumpleCriterioLectura({ lecturaValida: null, confianzaOcr: 0.1, confianzaDeteccion: null }, { ...POLITICA, criterio: 'validez' }).cumple).toBe(false);
  });
  it('con ambas fuentes se evalúa la menor', () => {
    const c = cumpleCriterioLectura({ lecturaValida: true, confianzaOcr: 0.95, confianzaDeteccion: 0.6 }, { ...POLITICA, fuenteConfianza: 'ambas' });
    expect(c).toMatchObject({ cumple: false, evaluada: 0.6 });
  });
});
