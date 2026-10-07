import {
  casosSolicitudes, type PuertoListas, type RepositorioSolicitudes, type SolicitudDTO,
} from '../../aplicacion/solicitudesAcceso';
import { ErrorAplicacion, errorValidacion, type Actor } from '../../aplicacion/comun';
import { leerRegistroLista, LISTA_BLANCA } from '../../dominio/listas';

/** Casos de uso de las solicitudes de acceso con dobles de prueba: sin base de datos, sin red. */

const GUARDIA: Actor = { id: 3, email: 'guardia@ecu911.gob.ec', nombre: 'Guardia', rol: 'Guardia', ip: '10.0.0.3' };
const GESTOR: Actor = { id: 4, email: 'gestor@ecu911.gob.ec', nombre: 'Gestor', rol: 'GestorPermisos', ip: '10.0.0.4' };

const solicitud = (cambios: Partial<SolicitudDTO> = {}): SolicitudDTO => ({
  id: 12, placa: 'PBA1234', propietario: 'Ana Villacís', departamento: 'Tecnología', categoria: 'VISITANTE',
  motivo: 'Visita técnica al centro de datos',
  vehiculo: { tipo: 'Automóvil', marca: 'Chevrolet', modelo: 'Aveo', color: 'Blanco' },
  fecha_inicio: '2026-10-05', fecha_fin: '2026-10-05', horario: null, horario_texto: 'Sin restricción horaria',
  deteccion_id: 1532, estado: 'pendiente', solicitante: { id: GUARDIA.id, nombre: 'Guardia', email: GUARDIA.email },
  fecha_solicitud: '2026-10-04T10:00:00.000Z', resolutor: null, fecha_resolucion: null, comentario_resolucion: null,
  vehiculo_autorizado_id: null, en_lista_alertas: false, permiso_actual_id: null, version: 1,
  ...cambios,
});

/** Cuerpo del alta (y de la edición): mismos campos que envía el formulario de la garita. */
const CUERPO = {
  placa: 'pba-1234', propietario: 'Ana Villacís', departamento: 'Tecnología', categoria: 'VISITANTE',
  motivo: 'Visita técnica al centro de datos', tipo_vehiculo: 'Automóvil', marca: 'Chevrolet', modelo: 'Aveo', color: 'Blanco',
  fecha_inicio: '2026-10-05', fecha_fin: '2026-10-05', horario: null, deteccion_id: 1532,
};

function preparar(actual: SolicitudDTO | null = solicitud()) {
  const repositorio: jest.Mocked<RepositorioSolicitudes> = {
    listar: jest.fn().mockResolvedValue([]),
    contarPendientes: jest.fn().mockResolvedValue(2),
    obtener: jest.fn().mockResolvedValue(actual),
    pendienteConPlaca: jest.fn().mockResolvedValue(null),
    crear: jest.fn().mockResolvedValue(12),
    actualizar: jest.fn().mockResolvedValue(true),
    reclamar: jest.fn().mockResolvedValue({ placa: 'PBA1234', solicitado_por: GUARDIA.id }),
    liberar: jest.fn().mockResolvedValue(undefined),
    vincularPermiso: jest.fn().mockResolvedValue(undefined),
    cancelar: jest.fn().mockResolvedValue('PBA1234'),
  };
  const listas: jest.Mocked<PuertoListas> = {
    // Mismo contrato que casosListas().validar: reglas de la lista o error de validación (400)
    validar: jest.fn((def, entrada) => {
      const r = leerRegistroLista(def, entrada as Record<string, unknown>);
      if (!r.ok) throw errorValidacion(r.error);
      return r.valor;
    }),
    guardar: jest.fn().mockResolvedValue({ id: 77, accion: 'creado' }),
    obtener: jest.fn().mockResolvedValue({ id: 77, placa: 'PBA1234' }),
    difundir: jest.fn(),
    anunciarAlta: jest.fn(),
  };
  const auditoria = { operacion: jest.fn().mockResolvedValue(undefined) };
  const eventos = { emitir: jest.fn() };
  const avisos = { notificar: jest.fn() };
  const casos = casosSolicitudes({ repositorio, listas, auditoria, eventos, avisos });
  return { casos, repositorio, listas, auditoria, eventos, avisos };
}

const fallo = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as ErrorAplicacion; }
  throw new Error('se esperaba un error');
};

describe('Casos de uso · solicitudes de acceso', () => {
  it('crear: valida con las reglas de la lista blanca, registra, audita, difunde y avisa al gestor', async () => {
    const { casos, repositorio, auditoria, eventos, avisos } = preparar();
    await casos.crear(CUERPO, GUARDIA);
    expect(repositorio.pendienteConPlaca).toHaveBeenCalledWith('PBA1234', undefined);
    expect(repositorio.crear).toHaveBeenCalledWith(expect.objectContaining({
      motivo: 'Visita técnica al centro de datos', deteccionId: 1532, registro: expect.objectContaining({ placa: 'PBA1234' }),
    }), GUARDIA.id);
    expect(auditoria.operacion).toHaveBeenCalledWith(GUARDIA, 'SOLICITUD_CREADA', 'solicitud_acceso', 12, 'PBA1234 · Visita técnica al centro de datos');
    expect(eventos.emitir).toHaveBeenCalledWith('solicitudes:actualizadas', {});
    expect(avisos.notificar).toHaveBeenCalledWith(expect.objectContaining({
      tipo: 'solicitud.nueva', enlace: '/solicitudes?id=12', destinatarios: { excluir: [GUARDIA.id] },
    }));
  });

  it.each([
    ['placa fuera del formato', { placa: 'ABC123' }],
    ['responsable con números', { propietario: 'Ana 23' }],
    ['motivo corto', { motivo: 'no' }],
    ['motivo largo', { motivo: 'x'.repeat(301) }],
    ['motivo con etiquetas HTML', { motivo: '<script>alert(1)</script>' }],
    ['ingreso de origen cero', { deteccion_id: 0 }],
    ['ingreso de origen no numérico', { deteccion_id: 'abc' }],
    ['ingreso de origen decimal', { deteccion_id: 1.5 }],
    ['color con dígitos', { color: 'Rojo2' }],
  ])('crear: rechaza %s (400) sin tocar la base', async (_caso, cambio) => {
    const { casos, repositorio } = preparar();
    const e = await fallo(casos.crear({ ...CUERPO, ...cambio }, GUARDIA));
    expect(e.tipo).toBe('validacion');
    expect(repositorio.pendienteConPlaca).not.toHaveBeenCalled();
    expect(repositorio.crear).not.toHaveBeenCalled();
  });

  it('crear: el ingreso de origen es opcional (null) y la categoría por omisión es VISITANTE', async () => {
    const { casos, repositorio } = preparar();
    await casos.crear({ ...CUERPO, deteccion_id: null, categoria: '' }, GUARDIA);
    const [datos] = repositorio.crear.mock.calls[0];
    expect(datos.deteccionId).toBeNull();
    expect(datos.registro.datos.categoria).toBe('VISITANTE');
  });

  it('crear: 409 si la placa ya tiene una solicitud pendiente', async () => {
    const { casos, repositorio } = preparar();
    repositorio.pendienteConPlaca.mockResolvedValue(9);
    const e = await fallo(casos.crear(CUERPO, GUARDIA));
    expect(e.tipo).toBe('conflicto');
    expect(e.message).toContain('#9');
    expect(repositorio.crear).not.toHaveBeenCalled();
  });

  it('editar: 404 si no existe, 403 si es de otra persona y 409 si ya no está pendiente', async () => {
    expect((await fallo(preparar(null).casos.editar(12, CUERPO, GUARDIA))).tipo).toBe('no_encontrado');

    const ajena = preparar(solicitud({ solicitante: { id: 99, nombre: 'Otro', email: 'otro@ecu911.gob.ec' } }));
    expect((await fallo(ajena.casos.editar(12, CUERPO, GUARDIA))).tipo).toBe('prohibido');
    expect(ajena.repositorio.actualizar).not.toHaveBeenCalled();

    const resuelta = preparar(solicitud({ estado: 'aprobada' }));
    const e = await fallo(resuelta.casos.editar(12, CUERPO, GUARDIA));
    expect(e.tipo).toBe('conflicto');
    expect(e.message).toContain('aprobada');
    expect(resuelta.repositorio.actualizar).not.toHaveBeenCalled();
  });

  it('editar: mismas validaciones que el alta (400 antes de escribir)', async () => {
    const { casos, repositorio } = preparar();
    expect((await fallo(casos.editar(12, { ...CUERPO, placa: 'P-12' }, GUARDIA))).tipo).toBe('validacion');
    expect((await fallo(casos.editar(12, { ...CUERPO, motivo: '' }, GUARDIA))).tipo).toBe('validacion');
    expect((await fallo(casos.editar(12, { ...CUERPO, fecha_inicio: '2026-11-01', fecha_fin: '2026-10-01' }, GUARDIA))).tipo).toBe('validacion');
    expect(repositorio.actualizar).not.toHaveBeenCalled();
  });

  it('editar: guarda, audita los campos cambiados y difunde', async () => {
    const { casos, repositorio, auditoria, eventos } = preparar();
    await casos.editar(12, { ...CUERPO, motivo: 'Entrega de equipos de radio', color: 'Rojo' }, GUARDIA);
    expect(repositorio.pendienteConPlaca).toHaveBeenCalledWith('PBA1234', 12);
    expect(repositorio.actualizar).toHaveBeenCalledWith(12, expect.objectContaining({ motivo: 'Entrega de equipos de radio' }), GUARDIA.id);
    expect(auditoria.operacion).toHaveBeenCalledWith(GUARDIA, 'SOLICITUD_EDITADA', 'solicitud_acceso', 12, 'PBA1234: motivo, color');
    expect(eventos.emitir).toHaveBeenCalledWith('solicitudes:actualizadas', {});
  });

  it('editar: conserva el ingreso de origen si el cuerpo no lo trae y lo quita con null', async () => {
    const { deteccion_id: _omitido, ...sinDeteccion } = CUERPO;
    const a = preparar();
    await a.casos.editar(12, sinDeteccion, GUARDIA);
    expect(a.repositorio.actualizar.mock.calls[0][1].deteccionId).toBe(1532);
    const b = preparar();
    await b.casos.editar(12, { ...CUERPO, deteccion_id: null }, GUARDIA);
    expect(b.repositorio.actualizar.mock.calls[0][1].deteccionId).toBeNull();
    expect(b.auditoria.operacion).toHaveBeenCalledWith(GUARDIA, 'SOLICITUD_EDITADA', 'solicitud_acceso', 12, 'PBA1234: deteccion_id');
  });

  it('editar: 409 si otra solicitud pendiente tiene la placa nueva', async () => {
    const { casos, repositorio } = preparar();
    repositorio.pendienteConPlaca.mockResolvedValue(20);
    const e = await fallo(casos.editar(12, { ...CUERPO, placa: 'PBB5678' }, GUARDIA));
    expect(e.tipo).toBe('conflicto');
    expect(e.message).toContain('#20');
    expect(repositorio.actualizar).not.toHaveBeenCalled();
  });

  it('editar: 409 si se resolvió entre la lectura y la escritura (edición atómica)', async () => {
    const { casos, repositorio, auditoria } = preparar();
    repositorio.actualizar.mockResolvedValue(false);
    repositorio.obtener.mockResolvedValueOnce(solicitud()).mockResolvedValueOnce(solicitud({ estado: 'rechazada' }));
    const e = await fallo(casos.editar(12, CUERPO, GUARDIA));
    expect(e.tipo).toBe('conflicto');
    expect(e.message).toContain('rechazada');
    expect(auditoria.operacion).not.toHaveBeenCalled();
  });

  it('aprobar: concede el permiso con los casos de uso de listas, audita y avisa al solicitante', async () => {
    const { casos, repositorio, listas, auditoria, eventos, avisos } = preparar();
    const r = await casos.aprobar(12, { comentario: 'Bienvenido', ajustes: { fecha_fin: '2026-10-31', categoria: 'PROVEEDOR' }, version: 1 }, GESTOR);
    expect(r.accion).toBe('permiso creado');
    // Lo solicitado más los ajustes, validado con los casos de uso de listas (reglas de la lista blanca)
    expect(listas.validar).toHaveBeenCalledWith(LISTA_BLANCA, expect.objectContaining({
      placa: 'PBA1234', propietario: 'Ana Villacís', categoria: 'PROVEEDOR', fecha_inicio: '2026-10-05', fecha_vencimiento: '2026-10-31',
    }));
    expect(repositorio.reclamar).toHaveBeenCalledWith(12, GESTOR.id, 'aprobada', 'Bienvenido', 1);
    expect(listas.guardar).toHaveBeenCalledWith(LISTA_BLANCA, expect.objectContaining({
      placa: 'PBA1234', datos: expect.objectContaining({ categoria: 'PROVEEDOR', observaciones: 'Solicitud #12: Visita técnica al centro de datos' }),
    }), GESTOR, { solicitudId: 12, actualizarSiExiste: true });
    expect(repositorio.vincularPermiso).toHaveBeenCalledWith(12, 77);
    expect(auditoria.operacion).toHaveBeenCalledWith(GESTOR, 'SOLICITUD_APROBADA', 'solicitud_acceso', 12,
      'PBA1234 · permiso creado #77 · Sin restricción horaria · Bienvenido');
    expect(listas.difundir).toHaveBeenCalledWith(LISTA_BLANCA);
    expect(eventos.emitir).toHaveBeenCalledWith('solicitudes:actualizadas', {});
    expect(listas.anunciarAlta).toHaveBeenCalledWith(LISTA_BLANCA, { id: 77, placa: 'PBA1234' }, GESTOR);
    expect(avisos.notificar).toHaveBeenCalledWith(expect.objectContaining({
      tipo: 'solicitud.resuelta', enlace: '/detecciones/1532', destinatarios: { usuarios: [GUARDIA.id] },
      datos: { solicitud_id: 12, placa: 'PBA1234', aprobada: true },
    }));
  });

  it('aprobar: si la placa ya tenía permiso, la aprobación lo amplía', async () => {
    const { casos, listas } = preparar();
    listas.guardar.mockResolvedValue({ id: 5, accion: 'actualizado' });
    expect((await casos.aprobar(12, { version: 1 }, GESTOR)).accion).toBe('permiso ampliado');
  });

  it('aprobar: separación de funciones (403) y solicitud ya resuelta (409)', async () => {
    const propia = preparar(solicitud({ solicitante: { id: GESTOR.id, nombre: 'Gestor', email: GESTOR.email } }));
    propia.repositorio.reclamar.mockResolvedValue(null);
    const e = await fallo(propia.casos.aprobar(12, { version: 1 }, GESTOR));
    expect(e.tipo).toBe('prohibido');
    expect(e.message).toMatch(/Separación de funciones/);
    expect(propia.listas.guardar).not.toHaveBeenCalled();

    const resuelta = preparar(solicitud({ estado: 'aprobada' }));
    resuelta.repositorio.reclamar.mockResolvedValue(null);
    const c = await fallo(resuelta.casos.aprobar(12, { version: 1 }, GESTOR));
    expect(c.tipo).toBe('conflicto');
    expect(c.message).toBe('La solicitud ya fue aprobada.');
  });

  it('aprobar: rechaza un comentario o ajustes inválidos antes de resolver', async () => {
    const { casos, repositorio, listas } = preparar();
    expect((await fallo(casos.aprobar(12, { comentario: 'x'.repeat(301), version: 1 }, GESTOR))).tipo).toBe('validacion');
    expect((await fallo(casos.aprobar(12, { comentario: 'ok <b>', version: 1 }, GESTOR))).tipo).toBe('validacion');
    expect((await fallo(casos.aprobar(12, { ajustes: { categoria: 'VIP' }, version: 1 }, GESTOR))).message).toBe('Categoría inválida.');
    expect(listas.validar).not.toHaveBeenCalled();
    // Vigencia invertida: la rechaza la validación de la lista blanca (casos de uso de listas)
    const fechas = await fallo(casos.aprobar(12, { ajustes: { fecha_inicio: '2026-11-01', fecha_fin: '2026-10-01' }, version: 1 }, GESTOR));
    expect(fechas.tipo).toBe('validacion');
    expect(fechas.message).toBe('La fecha de inicio no puede ser posterior al vencimiento.');
    expect(listas.validar).toHaveBeenCalledTimes(1);
    expect(repositorio.reclamar).not.toHaveBeenCalled();
  });

  it('aprobar: exige la versión revisada (entero positivo) antes de tocar la base', async () => {
    const { casos, repositorio } = preparar();
    for (const version of [undefined, 0, 'abc', 1.5, [1]]) {
      expect((await fallo(casos.aprobar(12, { version }, GESTOR))).tipo).toBe('validacion');
    }
    expect(repositorio.obtener).not.toHaveBeenCalled();
    expect(repositorio.reclamar).not.toHaveBeenCalled();
  });

  it('aprobar: si el solicitante la editó mientras el gestor la revisaba, no se aprueba (409)', async () => {
    // El gestor revisó la versión 1 (PBA1234); el guardia cambió la placa a XYZ9999 (versión 2)
    const { casos, repositorio, listas } = preparar(solicitud({ placa: 'XYZ9999', version: 2 }));
    const e = await fallo(casos.aprobar(12, { version: 1 }, GESTOR));
    expect(e).toMatchObject({ tipo: 'conflicto', message: 'La solicitud cambió mientras la revisaba: vuelva a abrirla para ver los datos actuales.' });
    expect(repositorio.reclamar).not.toHaveBeenCalled();
    expect(listas.guardar).not.toHaveBeenCalled();
  });

  it('aprobar: si la edición llega entre la lectura y el reclamo, el reclamo con versión falla y no se concede nada', async () => {
    const { casos, repositorio, listas, auditoria } = preparar();
    repositorio.obtener
      .mockResolvedValueOnce(solicitud())                                       // lectura: versión 1, PBA1234
      .mockResolvedValueOnce(solicitud({ placa: 'XYZ9999', version: 2 }));      // tras el reclamo fallido
    repositorio.reclamar.mockResolvedValue(null);
    const e = await fallo(casos.aprobar(12, { version: 1 }, GESTOR));
    expect(repositorio.reclamar).toHaveBeenCalledWith(12, GESTOR.id, 'aprobada', null, 1);
    expect(e).toMatchObject({ tipo: 'conflicto', message: 'La solicitud cambió mientras la revisaba: vuelva a abrirla para ver los datos actuales.' });
    expect(listas.guardar).not.toHaveBeenCalled();
    expect(auditoria.operacion).not.toHaveBeenCalled();
  });

  it('aprobar: si no se pudo conceder el permiso, la solicitud vuelve a quedar pendiente', async () => {
    const { casos, repositorio, listas, auditoria } = preparar();
    listas.guardar.mockRejectedValue(new Error('caída de la base'));
    await expect(casos.aprobar(12, { version: 1 }, GESTOR)).rejects.toThrow('caída de la base');
    expect(repositorio.liberar).toHaveBeenCalledWith(12);
    expect(auditoria.operacion).not.toHaveBeenCalled();
  });

  it('rechazar: exige el motivo (5 a 300) antes de tocar la base; audita y avisa al solicitante', async () => {
    const { casos, repositorio, auditoria, avisos } = preparar();
    expect((await fallo(casos.rechazar(12, 'no', GESTOR))).tipo).toBe('validacion');
    expect((await fallo(casos.rechazar(12, undefined, GESTOR))).tipo).toBe('validacion');
    expect((await fallo(casos.rechazar(12, 'x'.repeat(301), GESTOR))).message).toBe('Motivo del rechazo: máximo 300 caracteres.');
    expect((await fallo(casos.rechazar(12, 'No <b>autorizado</b>', GESTOR))).tipo).toBe('validacion');
    expect(repositorio.reclamar).not.toHaveBeenCalled();

    await casos.rechazar(12, '  No se justifica el ingreso ', GESTOR);
    expect(repositorio.reclamar).toHaveBeenCalledWith(12, GESTOR.id, 'rechazada', 'No se justifica el ingreso');
    expect(auditoria.operacion).toHaveBeenCalledWith(GESTOR, 'SOLICITUD_RECHAZADA', 'solicitud_acceso', 12, 'PBA1234 · No se justifica el ingreso');
    expect(avisos.notificar).toHaveBeenCalledWith(expect.objectContaining({
      tipo: 'solicitud.resuelta', mensaje: 'Gestor: No se justifica el ingreso', destinatarios: { usuarios: [GUARDIA.id] },
    }));
  });

  it('cancelar: solo una pendiente propia; audita y difunde', async () => {
    const a = preparar();
    a.repositorio.cancelar.mockResolvedValue(null);
    expect((await fallo(a.casos.cancelar(12, GUARDIA))).tipo).toBe('no_encontrado');

    const { casos, repositorio, auditoria, eventos } = preparar();
    await casos.cancelar(12, GUARDIA);
    expect(repositorio.cancelar).toHaveBeenCalledWith(12, GUARDIA.id);
    expect(auditoria.operacion).toHaveBeenCalledWith(GUARDIA, 'SOLICITUD_CANCELADA', 'solicitud_acceso', 12, 'PBA1234');
    expect(eventos.emitir).toHaveBeenCalledWith('solicitudes:actualizadas', {});
  });

  it('listar y resumen: quien resuelve ve todas (o las suyas con mias=1); el resto, solo las propias', async () => {
    const { casos, repositorio } = preparar();
    await casos.listar(GESTOR, { estado: 'resueltas' });
    expect(repositorio.listar).toHaveBeenLastCalledWith({ usuarioId: GESTOR.id, soloPropias: false, vista: 'resueltas' });
    await casos.listar(GESTOR, { estado: 'pendiente', mias: '1' });
    expect(repositorio.listar).toHaveBeenLastCalledWith({ usuarioId: GESTOR.id, soloPropias: true, vista: 'pendiente' });
    await casos.listar(GUARDIA, {});
    expect(repositorio.listar).toHaveBeenLastCalledWith({ usuarioId: GUARDIA.id, soloPropias: true, vista: 'pendiente' });
    await casos.listar(GUARDIA, { estado: 'otra' });
    expect(repositorio.listar).toHaveBeenLastCalledWith({ usuarioId: GUARDIA.id, soloPropias: true, vista: 'todas' });

    expect(await casos.resumen(GESTOR)).toEqual({ pendientes: 2 });
    expect(repositorio.contarPendientes).toHaveBeenLastCalledWith(GESTOR.id, true);
    await casos.resumen(GUARDIA);
    expect(repositorio.contarPendientes).toHaveBeenLastCalledWith(GUARDIA.id, false);
  });
});
