import type { CalendarioLocal } from '../../aplicacion/calendario';
import { ErrorAplicacion, type Actor } from '../../aplicacion/comun';
import { casosEvaluacion, type RepositorioEvaluacion } from '../../aplicacion/evaluacion';
import { casosPanel, type RepositorioPanel } from '../../aplicacion/panel';
import { casosReportes, type RepositorioReportes } from '../../aplicacion/reportes';
import { COLUMNAS_EXPORTACION_EVALUACION } from '../../dominio/evaluacion';

/** Panel, reporte consolidado y evaluación con dobles de prueba: sin base de datos y con un reloj fijo. */

const GESTOR: Actor = { id: 4, email: 'gestor@ecu911.gob.ec', nombre: 'Gestor', rol: 'GestorPermisos', ip: '10.0.0.4' };

/** Ecuador (UTC-5): el día local empieza a las 05:00 UTC. Ahora: lunes 5 de octubre de 2026, 10:00 locales. */
const AHORA = new Date('2026-10-05T15:00:00Z');
const calendario: CalendarioLocal = {
  ahora: () => AHORA,
  inicioDiaLocal: (fecha, dias = 0) => {
    const local = new Date(fecha.getTime() - 5 * 3_600_000);
    local.setUTCHours(0, 0, 0, 0);
    return new Date(local.getTime() + 5 * 3_600_000 + dias * 86_400_000);
  },
  desfaseMinutos: () => -300,
};

const fallo = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as ErrorAplicacion; }
  throw new Error('se esperaba un error');
};

describe('Casos de uso · panel de inicio', () => {
  const repositorio: jest.Mocked<RepositorioPanel> = {
    operacion: jest.fn().mockResolvedValue({
      hoy: { total: 3, autorizados: 2, alertas: 1, no_registrados: null, pendientes: 0, validados: 1 },
      ayer: { total: 5 },
      porHora: [{ hora: 9, total: 3, autorizados: 2, alertas: 1, no_registrados: 0, pendientes: 0 }],
      tendencia: [{ fecha: '2026-10-05', total: 3, autorizados: 2, alertas: 1, no_registrados: 0, pendientes: 0 }],
      camaras: [{ id: 1, nombre: 'Garita', activa: 1 }],
      cola: { n: 2 },
      alertas: [{ id: 9 }],
      listas: { autorizados_vigentes: 10, autorizados_por_vencer: null },
      precision: { validadas: 4, correctas: null },
    }),
    accesos: jest.fn().mockResolvedValue({
      solicitudes: [{ id: 1, placa: 'PBA1234', total: 3 }, { id: 2, placa: 'GSD4321', total: 3 }],
      padron: { vigentes: 8, vencidos: null },
      categorias: [{ categoria: 'VISITANTE', n: 2 }],
      denegados: { sin_permiso: 1, restringidos: null },
      reincidentes: [{ placa: 'XYZ9999', intentos: '3', ultimo: '2026-10-05T14:00:00Z' }],
      recientes: [{ id: 21 }],
    }),
    administracion: jest.fn().mockResolvedValue({
      usuarios: [
        { codigo: 'ADMIN', estado: 'activo', bloqueado: false, bloqueo_temporal: 0, n: 1 },
        { codigo: 'GUARDIA', estado: 'activo', bloqueado: true, bloqueo_temporal: 0, n: 1 },
        { codigo: 'GUARDIA', estado: 'pendiente', bloqueado: false, bloqueo_temporal: 0, n: 2 },
        { codigo: 'GESTOR_PERMISOS', estado: 'inactivo', bloqueado: false, bloqueo_temporal: 1, n: 1 },
      ],
      accesos: { exitosos: 7, fallidos: null },
      fallidos: [],
      actividad: [],
    }),
  };
  const casos = casosPanel({
    repositorio, tiempo: calendario, diasAviso: () => 7, mapearDeteccion: f => ({ mapeada: f.id }),
    servicios: { anpr: async () => ({ en_linea: true }), correoConfigurado: () => false },
  });

  it('resumen: series completas (24 horas y 7 días locales) y conteos nulos en cero', async () => {
    const r = await casos.resumen();
    expect(repositorio.operacion).toHaveBeenCalledWith(expect.objectContaining({
      hoy: new Date('2026-10-05T05:00:00Z'), hace7: new Date('2026-09-29T05:00:00Z'), desfase: -300, diasAviso: 7,
    }));
    expect(r.por_hora).toHaveLength(24);
    expect(r.por_hora[9]).toEqual({ hora: 9, total: 3, autorizados: 2, alertas: 1, no_registrados: 0, pendientes: 0 });
    expect(r.por_hora[10].total).toBe(0);
    expect(r.tendencia.map(d => d.fecha)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
    expect(r.tendencia[6].total).toBe(3);
    expect(r.hoy.no_registrados).toBe(0);
    expect(r).toMatchObject({
      ayer_misma_hora: 5, cola_revision: 2, ultimas_alertas: [{ mapeada: 9 }], camaras: [{ id: 1, activa: true }],
      listas: { autorizados_vigentes: 10, autorizados_por_vencer: 0, dias_aviso: 7 }, exactitud_ocr: { validadas: 4, correctas: 0 },
    });
  });

  it('accesos: las solicitudes propias no cuentan (SoD) y el total no se repite en cada fila', async () => {
    const r = await casos.accesos(GESTOR);
    expect(repositorio.accesos).toHaveBeenCalledWith(expect.objectContaining({ usuarioId: GESTOR.id, diasAviso: 7 }));
    expect(r.solicitudes).toEqual({ pendientes: 3, ultimas: [{ id: 1, placa: 'PBA1234' }, { id: 2, placa: 'GSD4321' }] });
    expect(r).toMatchObject({
      padron: { vigentes: 8, vencidos: 0, dias_aviso: 7 }, categorias: { VISITANTE: 2 }, hoy: { sin_permiso: 1, restringidos: 0 },
      reincidentes: [{ placa: 'XYZ9999', intentos: 3 }], denegados_recientes: [{ mapeada: 21 }],
    });
  });

  it('administración: un bloqueo prevalece sobre el estado y se cuentan los 3 roles', async () => {
    const r = await casos.administracion();
    expect(r.usuarios).toEqual({
      total: 5, activos: 1, pendientes: 2, inactivos: 0, bloqueados: 2, por_rol: { Admin: 1, Guardia: 3, GestorPermisos: 1 },
    });
    expect(r.accesos_24h).toEqual({ exitosos: 7, fallidos: 0 });
    expect(r.servicios).toEqual({ base_datos: { en_linea: true }, anpr: { en_linea: true }, correo: { configurado: false } });
  });
});

describe('Casos de uso · reporte consolidado', () => {
  const preparar = () => {
    const repositorio: jest.Mocked<RepositorioReportes> = {
      consolidado: jest.fn().mockResolvedValue({
        totales: { total: 4, autorizados: 3, alertas: null, validados: 1, latencia_media_ms: null, confianza_ocr_media: 0.91 },
        porDia: [{ fecha: '2026-10-02', total: 4, autorizados: 3, alertas: 0, no_registrados: 1, pendientes: 0 }],
        porHora: [{ hora: 8, total: 4 }],
        porCamara: [{ camara_id: 1, camara: 'Garita', total: 4, alertas: null }],
        porTipo: [{ tipo: 'Automóvil', total: 4 }],
        frecuentes: [{ placa: 'PBA1234', ingresos: 2 }],
        validacion: [{ usuario: 'Guardia', validaciones: 1, correcciones: null }],
        alertas: [],
      }),
    };
    return { casos: casosReportes({ repositorio, tiempo: calendario }), repositorio };
  };

  it('valida el período antes de consultar la base (400)', async () => {
    const { casos, repositorio } = preparar();
    for (const consulta of [{ desde: '2026-02-30' }, { camara: 'x' }, { desde: '2026-10-05', hasta: '2026-10-01' }]) {
      expect((await fallo(casos.consolidado(consulta))).tipo).toBe('validacion');
    }
    expect(repositorio.consolidado).not.toHaveBeenCalled();
  });

  it('serie diaria continua, 24 horas y conteos numéricos; latencia nula se conserva', async () => {
    const { casos, repositorio } = preparar();
    const r = await casos.consolidado({ desde: '2026-10-01T05:00:00.000Z', hasta: '2026-10-04T04:59:59.999Z', camara: '1' });
    expect(repositorio.consolidado).toHaveBeenCalledWith(
      { desde: new Date('2026-10-01T05:00:00Z'), hasta: new Date('2026-10-04T04:59:59.999Z'), camara: 1 }, -300);
    expect(r.por_dia.map(d => [d.fecha, d.total])).toEqual([['2026-10-01', 0], ['2026-10-02', 4], ['2026-10-03', 0]]);
    expect(r.por_hora).toHaveLength(24);
    expect(r.por_hora[8]).toEqual({ hora: 8, total: 4 });
    expect(r.totales).toMatchObject({ total: 4, alertas: 0, latencia_media_ms: null, confianza_ocr_media: 0.91 });
    expect(r.por_camara[0]).toEqual({ camara_id: 1, camara: 'Garita', total: 4, alertas: 0 });
    expect(r.validacion_por_usuario[0].correcciones).toBe(0);
  });

  it('sin fechas: los últimos 7 días locales hasta ahora', async () => {
    const { casos, repositorio } = preparar();
    const r = await casos.consolidado({});
    expect(repositorio.consolidado).toHaveBeenCalledWith({ desde: new Date('2026-09-29T05:00:00Z'), hasta: AHORA, camara: null }, -300);
    expect(r.por_dia).toHaveLength(7);
  });
});

describe('Casos de uso · evaluación del sistema', () => {
  const paso = (cambios: Record<string, unknown>) => ({
    id: 1, fecha_hora_ingreso: new Date('2026-10-02T15:00:00Z'), camara_id: 1, fuente: 'camara', validado_manualmente: true,
    placa_ocr_original: 'PBA1234', confianza_ocr_original: 0.9, placa_validada: 'PBA1234', lectura_verificador: null,
    decision_automatica: 'autorizado', decision_final: 'autorizado', latencia_ms: 820, luminancia_media: 120,
    distancia_estimada_m: 4.5, ancho_placa_px: 140, nitidez: 80, velocidad_px_s: 12, condicion_clima: null,
    modelo_detector: 'yolo26n', modelo_ocr: 'paddle', confianza_deteccion: 0.88, ...cambios,
  });
  const preparar = (pasos = [paso({}), paso({ id: 2, validado_manualmente: false, placa_validada: null })]) => {
    const repositorio: jest.Mocked<RepositorioEvaluacion> = { pasos: jest.fn().mockResolvedValue(pasos) };
    return { casos: casosEvaluacion({ repositorio }), repositorio };
  };

  it('valida el filtro antes de consultar la base (400)', async () => {
    const { casos, repositorio } = preparar();
    expect((await fallo(casos.resumen({ desde: '2026-10-05', hasta: '2026-10-01' }))).tipo).toBe('validacion');
    expect((await fallo(casos.exportar({ camara_id: 'abc' }))).tipo).toBe('validacion');
    expect(repositorio.pasos).not.toHaveBeenCalled();
  });

  it('resumen: métricas sobre los validados y cobertura sobre el total del período', async () => {
    const { casos, repositorio } = preparar();
    const r = await casos.resumen({ desde: '2026-10-01', hasta: '2026-10-03' });
    expect(repositorio.pasos).toHaveBeenCalledWith(expect.objectContaining({ desde: '2026-10-01', hasta: '2026-10-03', camaraId: null }));
    expect(r).toMatchObject({
      periodo: { desde: '2026-10-01', hasta: '2026-10-03' }, modelos: ['yolo26n + paddle'],
      total_registros: 2, validados: 1, cobertura_validacion: 0.5,
    });
    expect(r.global.exactitud_placa.valor).toBe(1);
  });

  it('exportar: columnas fijas, variables derivadas y fórmulas neutralizadas (los números no se alteran)', async () => {
    const { casos } = preparar([paso({ condicion_clima: '=HYPERLINK("http://malicioso")', velocidad_px_s: -3 })]);
    const [encabezado, fila] = (await casos.exportar({})).split('\n');
    expect(encabezado).toBe(COLUMNAS_EXPORTACION_EVALUACION.join(','));
    const celdas = fila.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const valor = (c: string) => celdas[COLUMNAS_EXPORTACION_EVALUACION.indexOf(c as never)];
    expect(valor('fecha_hora_ingreso')).toBe('2026-10-02T15:00:00.000Z');
    expect(valor('condicion_clima')).toBe('"\'=HYPERLINK(""http://malicioso"")"');
    expect(valor('velocidad_px_s')).toBe('-3');
    expect(valor('luz')).toBe('dia');
    expect(valor('rango_distancia')).toBe('3-6 m');
    expect(valor('tipo_servicio')).toBe('particular');
    expect(valor('formato_placa')).toBe('actual_4_digitos');
  });
});
