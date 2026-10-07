import { leerFiltroEvaluacion, leerPeriodoReporte, validarFechaHora } from '../../dominio/periodo';

const OMISION = { desde: new Date('2026-09-29T05:00:00Z'), hasta: new Date('2026-10-05T15:00:00Z') };

describe('Período · fecha y hora', () => {
  it('acepta AAAA-MM-DD y la fecha y hora ISO que envía el frontend', () => {
    expect(validarFechaHora('2026-10-01', { etiqueta: 'F' })).toEqual({ ok: true, valor: new Date('2026-10-01T00:00:00Z') });
    expect(validarFechaHora('2026-10-01T05:00:00.000Z', { etiqueta: 'F' })).toEqual({ ok: true, valor: new Date('2026-10-01T05:00:00Z') });
    expect(validarFechaHora('', { etiqueta: 'F' })).toEqual({ ok: true, valor: null });
  });

  it.each(['2026-02-30', '2026-10-01T25:00', 'ayer', '1e12', '2026-10-01T10:00:00+15:00'])('rechaza %p', valor => {
    expect(validarFechaHora(valor, { etiqueta: 'F' }).ok).toBe(false);
  });

  it('rechaza arreglos (parámetro repetido en la consulta)', () => {
    expect(validarFechaHora(['2026-10-01'], { etiqueta: 'F' }).ok).toBe(false);
  });
});

describe('Período · reporte consolidado', () => {
  it('sin fechas: el período por omisión y todas las cámaras', () => {
    expect(leerPeriodoReporte({}, OMISION)).toEqual({ ok: true, valor: { ...OMISION, camara: null } });
  });

  it('fechas y cámara válidas', () => {
    expect(leerPeriodoReporte({ desde: '2026-10-01', hasta: '2026-10-03T04:59:59.999Z', camara: '3' }, OMISION)).toEqual({
      ok: true, valor: { desde: new Date('2026-10-01T00:00:00Z'), hasta: new Date('2026-10-03T04:59:59.999Z'), camara: 3 },
    });
  });

  it.each([
    [{ desde: '2026-02-30' }, 'Fecha inicial no existe.'],
    [{ desde: '2026-10-05', hasta: '2026-10-01' }, 'La fecha final debe ser posterior a la inicial.'],
    [{ desde: '2025-01-01', hasta: '2026-10-01' }, 'El período máximo es de un año.'],
    [{ camara: 'abc' }, 'Cámara: solo números enteros.'],
    [{ camara: '0' }, 'Cámara: mínimo 1.'],
  ])('rechaza %p', (consulta, error) => {
    expect(leerPeriodoReporte(consulta, OMISION)).toEqual({ ok: false, error });
  });
});

describe('Período · evaluación del sistema', () => {
  it('días inclusivos: el final se cuenta hasta las 23:59:59', () => {
    const r = leerFiltroEvaluacion({ desde: '2026-10-01', hasta: '2026-10-03', camara_id: '2' });
    expect(r).toEqual({
      ok: true,
      valor: {
        desde: '2026-10-01', hasta: '2026-10-03', inicio: new Date('2026-10-01T00:00:00Z'),
        fin: new Date('2026-10-03T23:59:59'), camaraId: 2,
      },
    });
  });

  it('sin filtro: todo el historial', () => {
    expect(leerFiltroEvaluacion({})).toEqual({ ok: true, valor: { desde: null, hasta: null, inicio: null, fin: null, camaraId: null } });
  });

  it.each([
    [{ desde: '2026-10-05', hasta: '2026-10-01' }, 'La fecha inicial no puede ser posterior a la final.'],
    [{ desde: '01/10/2026' }, 'Fecha inicial: formato AAAA-MM-DD.'],
    [{ camara_id: '1.5' }, 'Cámara: solo números enteros.'],
  ])('rechaza %p', (consulta, error) => {
    expect(leerFiltroEvaluacion(consulta)).toEqual({ ok: false, error });
  });
});
