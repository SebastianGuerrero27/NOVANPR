import { casosDetecciones, type DependenciasDetecciones, type Fila, type RepositorioDetecciones } from '../../aplicacion/detecciones';
import { ErrorAplicacion, type Actor } from '../../aplicacion/comun';
import type { PoliticaAutorizacion } from '../../dominio/decisionAcceso';
import { csvDetecciones, type FilaExportacion } from '../../dominio/detecciones';

/** Detecciones con dobles de prueba: sin base de datos, sin disco, sin Socket.IO ni notificaciones. */

const ADMIN: Actor = { id: 1, email: 'admin@ecu911.gob.ec', nombre: 'Administrador', rol: 'Admin', ip: '10.0.0.1' };
const GUARDIA: Actor = { id: 3, email: 'guardia@ecu911.gob.ec', nombre: 'Guardia', rol: 'Guardia', ip: '10.0.0.3' };

const POLITICA: PoliticaAutorizacion = { criterio: 'validez_y_confianza', confianzaMinima: 0.8, fuenteConfianza: 'ocr', verificarVehiculo: true };
const AHORA = new Date('2026-10-05T15:00:00Z');
const PERMISO_VIGENTE: Fila = { id: 77, placa: 'PBA-1234', tipo_vehiculo: 'Automóvil', fecha_inicio: null, fecha_vencimiento: null, horario: null, color: 'Blanco' };

const fila = (cambios: Fila = {}): Fila => ({
  id: 15, placa_reconocida: 'PBA1234', placa_validada: null, estado_validacion: 'pendiente_revision', estado_procesamiento: 'procesado',
  fecha_hora_ingreso: new Date('2026-10-05T14:59:00Z'), ruta_imagen_ingreso: 'capturas/15.jpg', ruta_imagen_placa: 'capturas/15_placa.jpg',
  ...cambios,
});

function preparar(opciones: { alerta?: Fila | null; permiso?: Fila | null; existente?: Fila | null } = {}) {
  const repositorio: jest.Mocked<RepositorioDetecciones> = {
    obtener: jest.fn().mockResolvedValue(opciones.existente === undefined ? fila() : opciones.existente),
    mismoPaso: jest.fn().mockResolvedValue(null),
    existeCamara: jest.fn().mockResolvedValue(true),
    crearIngreso: jest.fn().mockResolvedValue({ id: 15, fecha_hora_ingreso: AHORA }),
    guardarMetadatos: jest.fn().mockResolvedValue(undefined),
    registrarLecturaAutomatica: jest.fn().mockResolvedValue(undefined),
    marcarNoLegible: jest.fn().mockResolvedValue(undefined),
    pasoProcesadoConPlaca: jest.fn().mockResolvedValue(null),
    eliminarPendiente: jest.fn().mockResolvedValue(undefined),
    guardarVeredicto: jest.fn().mockResolvedValue(undefined),
    observacion: jest.fn().mockResolvedValue({ confianza_deteccion: 0.9, fecha_hora_ingreso: '2026-10-05T14:59:00Z', marca: null, color: 'Blanco', tipo: null }),
    guardarVerificacion: jest.fn().mockResolvedValue(undefined),
    guardarDecisionAutomatica: jest.fn().mockResolvedValue(undefined),
    registrarDescarte: jest.fn().mockResolvedValue(undefined),
    contar: jest.fn().mockResolvedValue(1),
    pagina: jest.fn().mockResolvedValue([fila()]),
    recientes: jest.fn().mockResolvedValue([fila()]),
    exportar: jest.fn().mockResolvedValue([fila()]),
    historialPlaca: jest.fn().mockResolvedValue([]),
    auditoriaDe: jest.fn().mockResolvedValue([]),
    guardarValidacion: jest.fn().mockResolvedValue(undefined),
    crearManual: jest.fn().mockResolvedValue(30),
    eliminar: jest.fn().mockResolvedValue(undefined),
    eliminarFiltradas: jest.fn().mockResolvedValue([{ id: 1, ruta_imagen_ingreso: 'a.jpg', ruta_imagen_placa: null }]),
  };
  const deps = {
    repositorio,
    listas: {
      alerta: jest.fn().mockResolvedValue(opciones.alerta ? { row: opciones.alerta, coincidencia: 'exacta' } : null),
      permiso: jest.fn().mockResolvedValue(opciones.permiso ?? null),
    },
    presentar: jest.fn((f: Fila) => ({ id: f.id, placa: f.placa_validada || f.placa_reconocida || null, estado_validacion: f.estado_validacion })),
    politica: () => POLITICA,
    compararVehiculo: jest.fn().mockReturnValue({ resultado: 'coincide', detalle: 'color coincide' }),
    avisos: { decision: jest.fn(), resolverPorDeteccion: jest.fn().mockResolvedValue(undefined) },
    evidencia: { eliminar: jest.fn().mockResolvedValue(2) },
    eventos: { emitir: jest.fn() },
    auditoria: { operacion: jest.fn().mockResolvedValue(undefined) },
    tiempo: { ahora: () => AHORA, zona: 'America/Guayaquil' },
  } satisfies DependenciasDetecciones;
  return { casos: casosDetecciones(deps), ...deps };
}

const fallo = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as ErrorAplicacion; }
  throw new Error('se esperaba un error');
};

describe('Detecciones · servicio ANPR', () => {
  it('fase 1: exige la imagen; reutiliza el mismo paso físico; si no, crea el ingreso pendiente de OCR y lo difunde', async () => {
    const sinImagen = preparar();
    expect((await fallo(sinImagen.casos.ingreso({ tracking_id: 4 }))).tipo).toBe('validacion');

    const repetido = preparar();
    repetido.repositorio.mismoPaso.mockResolvedValue({ id: 9, fecha_hora_ingreso: AHORA });
    expect(await repetido.casos.ingreso({ tracking_id: 4, ruta_imagen_ingreso: 'x.jpg' }))
      .toEqual({ nuevo: false, respuesta: expect.objectContaining({ ingreso_id: 9, deduplicado: true }) });
    expect(repetido.repositorio.crearIngreso).not.toHaveBeenCalled();

    const { casos, repositorio, eventos } = preparar();
    const r = await casos.ingreso({ tracking_id: 4, ruta_imagen_ingreso: 'x.jpg', placa: 'pba-12', camara_id: '2', confianza_deteccion: 0.91, metadatos: { luz: 1 } });
    expect(r).toEqual({ nuevo: true, respuesta: { message: 'Ingreso registrado (pendiente de OCR).', ingreso_id: 15, fecha_hora_ingreso: AHORA } });
    expect(repositorio.mismoPaso).toHaveBeenCalledWith(4, 'PBA12');
    expect(repositorio.crearIngreso).toHaveBeenCalledWith({ trackingId: 4, pista: 'PBA12', ruta: 'x.jpg', confianza: 0.91, fuente: 'webcam', camaraId: 2 });
    expect(repositorio.guardarMetadatos).toHaveBeenCalledWith(15, { luz: 1 });
    expect(eventos.emitir).toHaveBeenCalledWith('deteccion:nueva', expect.objectContaining({ id: 15 }));
  });

  it('fase 2 sin lectura utilizable: queda para el personal y no se elimina la evidencia', async () => {
    const { casos, repositorio } = preparar();
    expect((await fallo(casos.completarOcr({ ingreso_id: 'x' }))).message).toBe('El ID de ingreso es obligatorio.');
    await casos.completarOcr({ ingreso_id: 15, placa_reconocida: 'SIN RECONOCER', ruta_imagen_placa: 'p.jpg' });
    expect(repositorio.marcarNoLegible).toHaveBeenCalledWith(15, 'p.jpg');
    expect(repositorio.registrarLecturaAutomatica).toHaveBeenCalledWith(15, expect.objectContaining({ decision: 'pendiente_revision' }));
    expect(repositorio.guardarDecisionAutomatica).not.toHaveBeenCalled();
  });

  it('fase 2 del mismo paso ya procesado: se consolida con el registro previo', async () => {
    const { casos, repositorio, eventos } = preparar();
    repositorio.pasoProcesadoConPlaca.mockResolvedValue(9);
    expect(await casos.completarOcr({ ingreso_id: 15, placa_reconocida: 'PBA1234' }))
      .toEqual({ message: 'Detección consolidada con el paso previo.', deduplicado: true, ingreso_id: 9 });
    expect(repositorio.eliminarPendiente).toHaveBeenCalledWith(15);
    expect(eventos.emitir).toHaveBeenCalledWith('deteccion:eliminada', { id: 15, consolidado_en: 9 });
  });

  it('fase 2 con permiso vigente y lectura confiable: autoriza, verifica el vehículo y avisa', async () => {
    const { casos, repositorio, avisos, compararVehiculo } = preparar({ permiso: PERMISO_VIGENTE, existente: fila({ estado_validacion: 'autorizado' }) });
    await casos.completarOcr({ ingreso_id: 15, placa_reconocida: 'pba1234', confianza_ocr: 0.95, lectura_valida: true, evidencia_lectura: { valido: true } });
    expect(repositorio.guardarVeredicto).toHaveBeenCalledWith(15, true, '{"valido":true}');
    expect(compararVehiculo).toHaveBeenCalledWith(PERMISO_VIGENTE, expect.objectContaining({ color: 'Blanco' }));
    expect(repositorio.guardarDecisionAutomatica).toHaveBeenCalledWith(15,
      { placa: 'PBA1234', confianza: 0.95, rutaPlaca: null, tipo: 'Automóvil' },
      expect.objectContaining({ permiso: PERMISO_VIGENTE, vigencia: 'vigente' }),
      expect.objectContaining({ estado: 'autorizado', regla: 'R5' }));
    expect(avisos.decision).toHaveBeenCalledWith(expect.objectContaining({ id: 15 }), expect.objectContaining({ estado: 'autorizado' }), PERMISO_VIGENTE);
  });

  it('fase 2 con la placa en la lista negra: alerta (nunca se rebaja) y evento deteccion:alerta', async () => {
    const { casos, repositorio, eventos } = preparar({ alerta: { id: 5, placa: 'PBA1234' }, existente: fila({ estado_validacion: 'alerta' }) });
    await casos.completarOcr({ ingreso_id: 15, placa_reconocida: 'PBA1234', confianza_ocr: 0.2, lectura_valida: false });
    expect(repositorio.guardarDecisionAutomatica).toHaveBeenCalledWith(15, expect.anything(), expect.anything(),
      expect.objectContaining({ estado: 'alerta', regla: 'R1' }));
    expect(eventos.emitir).toHaveBeenCalledWith('deteccion:alerta', expect.objectContaining({ id: 15 }));
  });

  it('descarte: valores tolerantes del motor', async () => {
    const { casos, repositorio } = preparar();
    expect(await casos.descarte({ tracking_id: 'x', texto_candidato: 'A'.repeat(80) })).toEqual({ success: true });
    expect(repositorio.registrarDescarte).toHaveBeenCalledWith({
      trackingId: -1, motivo: 'falso_positivo_ocr', texto: 'A'.repeat(50), confianza: null, fuente: null, camaraId: null,
    });
  });
});

describe('Detecciones · consultas del personal', () => {
  it('historial: filtros validados (400) y paginación ajustada', async () => {
    const { casos, repositorio } = preparar();
    expect((await fallo(casos.listar({ camara: 'abc' }))).tipo).toBe('validacion');
    expect((await fallo(casos.listar({ desde: '2026-02-30' }))).tipo).toBe('validacion');
    expect(repositorio.contar).not.toHaveBeenCalled();
    const r = await casos.listar({ placa: 'pba-12', estado: 'alerta,otro', tamano: '500', pagina: '2' });
    expect(repositorio.pagina).toHaveBeenCalledWith(expect.objectContaining({ placa: 'PBA12', estados: ['alerta'] }), 100, 100);
    expect(r).toMatchObject({ total: 1, pagina: 2, tamano: 100 });
  });

  it('situación de una placa: al menos 3 caracteres; un permiso fuera de su vigencia se informa como restringido', async () => {
    const corto = preparar();
    expect((await fallo(corto.casos.buscarPlaca('PB'))).message).toBe('Ingrese al menos 3 caracteres de la placa.');
    const { casos } = preparar({ permiso: { ...PERMISO_VIGENTE, fecha_vencimiento: '2026-01-31' } });
    expect(await casos.buscarPlaca('pba-1234')).toMatchObject({
      placa: 'PBA1234', estado: 'restringido', restriccion: 'vencida', motivo: 'El permiso está vencido',
    });
  });

  it('exportación: queda auditada y el archivo lleva la fecha', async () => {
    const { casos, auditoria } = preparar();
    const r = await casos.exportar({ estado: 'alerta' }, GUARDIA);
    expect(r.nombre).toBe('ingresos_anpr_2026-10-05.csv');
    expect(auditoria.operacion).toHaveBeenCalledWith(GUARDIA, 'EXPORTACION', 'deteccion', null, '1 registros · {"estado":"alerta"}');
  });

  it('CSV del historial: BOM, celdas entre comillas y fórmulas neutralizadas', () => {
    const csv = csvDetecciones([{ ...fila(), propietario: '=HYPERLINK("http://malicioso")', confianza_ocr: 0.953 } as unknown as FilaExportacion]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"\'=HYPERLINK(""http://malicioso"")"');
    expect(csv).toContain('"95.3"');
  });
});

describe('Detecciones · acciones del personal', () => {
  it('validar: placa con formato ANT, excepción solo con accesos:excepcion y con motivo', async () => {
    const { casos, repositorio } = preparar();
    expect((await fallo(casos.validar(15, { placa_validada: 'PBA12' }, ADMIN))).tipo).toBe('validacion');
    expect((await fallo(casos.validar(15, { placa_validada: 'PBA1234', excepcion: true, observacion: 'Reunión urgente' }, GUARDIA))).tipo).toBe('prohibido');
    expect((await fallo(casos.validar(15, { placa_validada: 'PBA1234', excepcion: true }, ADMIN))).message).toBe('El campo «Motivo de la excepción» es obligatorio.');
    expect(repositorio.obtener).not.toHaveBeenCalled();
    expect((await fallo(preparar({ existente: null }).casos.validar(15, { placa_validada: 'PBA1234' }, GUARDIA))).tipo).toBe('no_encontrado');
  });

  it('validar: guarda la corrección, audita, resuelve las alarmas del paso y avisa si cambia a autorizado', async () => {
    const { casos, repositorio, auditoria, avisos } = preparar({ permiso: PERMISO_VIGENTE });
    const r = await casos.validar(15, { placa_validada: 'pba-1234', observacion: 'Placa sucia' }, GUARDIA);
    expect(repositorio.guardarValidacion).toHaveBeenCalledWith(15, { placa: 'PBA1234', tipo: 'Automóvil', usuarioId: GUARDIA.id },
      expect.anything(), expect.objectContaining({ estado: 'autorizado' }));
    expect(auditoria.operacion).toHaveBeenCalledWith(GUARDIA, 'VALIDACION', 'deteccion', 15, 'PBA1234 → PBA1234 (Autorizado) · Placa sucia');
    expect(avisos.resolverPorDeteccion).toHaveBeenCalledWith(15);
    expect(avisos.decision).toHaveBeenCalled();
    expect(r.message).toBe('Validación registrada.');
  });

  it('validar con excepción fuera de horario: autoriza y queda auditado como EXCEPCION_ACCESO', async () => {
    const { casos, auditoria } = preparar({ permiso: { ...PERMISO_VIGENTE, fecha_vencimiento: '2026-01-31' } });
    await casos.validar(15, { placa_validada: 'PBA1234', excepcion: true, observacion: 'Reunión urgente' }, ADMIN);
    expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'EXCEPCION_ACCESO', 'deteccion', 15, expect.stringContaining('Reunión urgente'));
  });

  it('registro manual: valida (placa ANT, motivo), cruza con las listas y no modifica la lista blanca', async () => {
    const { casos, repositorio, auditoria } = preparar();
    expect((await fallo(casos.registroManual({ placa: 'ABC123', motivo: 'Cámara caída' }, GUARDIA))).tipo).toBe('validacion');
    expect((await fallo(casos.registroManual({ placa: 'ABC1234', motivo: 'no' }, GUARDIA))).tipo).toBe('validacion');
    await casos.registroManual({ placa: 'ab-123c', motivo: 'Cámara fuera de servicio' }, GUARDIA);
    expect(repositorio.crearManual).toHaveBeenCalledWith({ placa: 'AB123C', camaraId: null, tipo: 'Motocicleta', usuarioId: GUARDIA.id },
      expect.anything(), expect.objectContaining({ estado: 'no_reconocido' }));
    expect(auditoria.operacion).toHaveBeenCalledWith(GUARDIA, 'REGISTRO_MANUAL', 'deteccion', 30, 'AB123C (No registrado) · Cámara fuera de servicio');
  });

  it('eliminar: motivo obligatorio antes de tocar la base; borra la evidencia y queda auditado', async () => {
    const { casos, repositorio, evidencia, eventos } = preparar();
    expect((await fallo(casos.eliminar(15, 'no', ADMIN))).tipo).toBe('validacion');
    expect(repositorio.obtener).not.toHaveBeenCalled();
    expect(await casos.eliminar(15, 'Prueba de cámara', ADMIN)).toEqual({ message: 'Detección eliminada.', id: 15 });
    expect(evidencia.eliminar).toHaveBeenCalledWith(['capturas/15.jpg', 'capturas/15_placa.jpg']);
    expect(eventos.emitir).toHaveBeenCalledWith('deteccion:eliminada', { id: 15 });
  });

  it('eliminación masiva: exige ELIMINAR y motivo; sin filtros alcanza a todas', async () => {
    const { casos, repositorio, auditoria } = preparar();
    expect((await fallo(casos.eliminarMasivo({}, { motivo: 'Limpieza de pruebas' }, ADMIN))).message).toBe('Escriba ELIMINAR para confirmar.');
    expect((await fallo(casos.eliminarMasivo({}, { confirmacion: 'ELIMINAR', motivo: 'x' }, ADMIN))).tipo).toBe('validacion');
    expect(await casos.eliminarMasivo({}, { confirmacion: 'ELIMINAR', motivo: 'Limpieza de pruebas' }, ADMIN))
      .toEqual({ message: '1 registro eliminado.', total: 1 });
    expect(repositorio.eliminarFiltradas).toHaveBeenCalledWith(null);
    expect(auditoria.operacion).toHaveBeenCalledWith(ADMIN, 'DETECCIONES_ELIMINADAS', 'deteccion', null,
      '1 registros y 2 imágenes · todas las detecciones · Limpieza de pruebas');
    await casos.eliminarMasivo({ estado: 'alerta' }, { confirmacion: 'ELIMINAR', motivo: 'Limpieza de pruebas' }, ADMIN);
    expect(repositorio.eliminarFiltradas).toHaveBeenLastCalledWith(expect.objectContaining({ estados: ['alerta'] }));
  });
});
