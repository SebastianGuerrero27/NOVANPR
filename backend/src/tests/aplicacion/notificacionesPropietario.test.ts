import { ErrorAplicacion, type Actor } from '../../aplicacion/comun';
import { casosNotificaciones, type PuertoPush, type RepositorioNotificaciones } from '../../aplicacion/notificaciones';
import { casosPropietario, MENSAJE_DESHABILITADO, type ProveedorPropietario, type RepositorioPropietario } from '../../aplicacion/propietario';
import { leerConsultaBandeja, leerDiasMetricas } from '../../dominio/notificaciones';
import { enmascararIdentificacion, leerConsultaPropietario } from '../../dominio/propietario';
import { leerSuscripcionPush } from '../../dominio/suscripcionPush';

/** Bandeja de notificaciones, canal push y consulta de propietario con dobles de prueba (sin base ni red). */

const ADMIN: Actor = { id: 1, email: 'admin@ecu911.gob.ec', nombre: 'Administrador', rol: 'Admin', ip: '10.0.0.1' };
const GUARDIA: Actor = { id: 3, email: 'guardia@ecu911.gob.ec', nombre: 'Guardia', rol: 'Guardia', ip: '10.0.0.3' };

const fallo = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as ErrorAplicacion; }
  throw new Error('se esperaba un error');
};

const SUSCRIPCION = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: { p256dh: 'BOr2X_tl-vZb3K1a9w', auth: 'k8JV6sjdbhAi' },
};

describe('Dominio · parámetros de la bandeja y de las métricas', () => {
  it('bandeja: por omisión 30 sin filtros; acepta los valores del cliente', () => {
    expect(leerConsultaBandeja({})).toEqual({ ok: true, valor: { limite: 30, antesDe: null, desde: null, filtro: null } });
    expect(leerConsultaBandeja({ limite: '50', antes_de: '120', filtro: 'pendientes' }))
      .toEqual({ ok: true, valor: { limite: 50, antesDe: 120, desde: null, filtro: 'pendientes' } });
  });

  it.each([
    [{ limite: '0' }], [{ limite: '101' }], [{ limite: 'abc' }], [{ antes_de: '-5' }], [{ desde: '1;DROP' }],
    [{ filtro: 'todas' }], [{ filtro: ['no_leidas'] }],
  ])('bandeja: rechaza %p', consulta => {
    expect(leerConsultaBandeja(consulta).ok).toBe(false);
  });

  it('métricas: 1 a 90 días, 7 por omisión', () => {
    expect(leerDiasMetricas(undefined)).toEqual({ ok: true, valor: 7 });
    expect(leerDiasMetricas('30')).toEqual({ ok: true, valor: 30 });
    for (const malo of ['0', '91', '7.5', 'x']) expect(leerDiasMetricas(malo).ok).toBe(false);
  });

  it('suscripción push: endpoint https y claves base64url; otro tipo se rechaza', () => {
    expect(leerSuscripcionPush(SUSCRIPCION)).toEqual({
      ok: true, valor: { endpoint: SUSCRIPCION.endpoint, p256dh: SUSCRIPCION.keys.p256dh, auth: SUSCRIPCION.keys.auth },
    });
    expect(leerSuscripcionPush({ ...SUSCRIPCION, endpoint: 'http://push.local/x' }).ok).toBe(false);
    expect(leerSuscripcionPush({ ...SUSCRIPCION, endpoint: `https://push.local/${'a'.repeat(600)}` }).ok).toBe(false);
    expect(leerSuscripcionPush({ ...SUSCRIPCION, keys: { p256dh: 'con espacio', auth: 'x' } }).ok).toBe(false);
    expect(leerSuscripcionPush({ ...SUSCRIPCION, keys: { p256dh: ['x'], auth: 'x' } }).ok).toBe(false);
  });
});

describe('Casos de uso · notificaciones', () => {
  const preparar = (pushHabilitado = true) => {
    const repositorio: jest.Mocked<RepositorioNotificaciones> = {
      bandeja: jest.fn().mockResolvedValue([{ id: 9 }]),
      resumen: jest.fn().mockResolvedValue({ no_leidas: 2, pendientes: 1 }),
      leerTodas: jest.fn().mockResolvedValue(undefined),
      leer: jest.fn().mockResolvedValue(undefined),
      reconocer: jest.fn().mockResolvedValue(3),
      guardarSuscripcion: jest.fn().mockResolvedValue(undefined),
      eliminarSuscripcion: jest.fn().mockResolvedValue(undefined),
      suscripciones: jest.fn().mockResolvedValue([{ id: 5, usuario_id: 3, endpoint: SUSCRIPCION.endpoint, p256dh: 'a', auth: 'b' }]),
      eliminarSuscripciones: jest.fn().mockResolvedValue(undefined),
      metricas: jest.fn().mockResolvedValue({
        porSeveridad: [{ severidad: 'critica', emitidas: 24, repeticiones_agrupadas: null, con_ack: 24, reconocidas: 20, escaladas: 2 }],
        tta: [{ severidad: 'critica', tta_mediana_s: 12.5, tta_p95_s: 40 }],
        avalanchas: { ventanas_avalancha: 1 },
      }),
    };
    const push: jest.Mocked<PuertoPush> = {
      habilitado: jest.fn(() => pushHabilitado),
      clavePublica: jest.fn(() => 'BClave'),
      enviar: jest.fn().mockResolvedValue({ enviados: 1, vencidas: [5], fallidas: [] }),
    };
    return { casos: casosNotificaciones({ repositorio, push, pushActivado: () => true }), repositorio, push };
  };

  it('bandeja: valida los parámetros antes de consultar y añade el resumen', async () => {
    const { casos, repositorio } = preparar();
    expect((await fallo(casos.bandeja(GUARDIA, { limite: '500' }))).tipo).toBe('validacion');
    expect(repositorio.bandeja).not.toHaveBeenCalled();
    expect(await casos.bandeja(GUARDIA, { filtro: 'no_leidas' })).toEqual({ items: [{ id: 9 }], no_leidas: 2, pendientes: 1 });
    expect(repositorio.bandeja).toHaveBeenCalledWith(GUARDIA.id, { limite: 30, antesDe: null, desde: null, filtro: 'no_leidas' });
  });

  it('leer, reconocer y reconocer las alarmas de un paso: siempre del usuario de la sesión', async () => {
    const { casos, repositorio } = preparar();
    expect(await casos.leer(GUARDIA, 9)).toEqual({ no_leidas: 2, pendientes: 1 });
    expect(repositorio.leer).toHaveBeenCalledWith(GUARDIA.id, 9);
    expect(await casos.reconocer(GUARDIA, 9)).toEqual({ reconocidas: 3, no_leidas: 2, pendientes: 1 });
    expect(await casos.reconocerDeteccion(GUARDIA, 1532)).toMatchObject({ reconocidas: 3 });
    expect(repositorio.reconocer).toHaveBeenLastCalledWith(GUARDIA.id, { deteccionId: 1532 });
  });

  it('suscripción push: valida el cuerpo (400) y recorta el agente de usuario', async () => {
    const { casos, repositorio } = preparar();
    expect((await fallo(casos.suscribir(GUARDIA, { endpoint: 'javascript:alert(1)' }, 'UA'))).tipo).toBe('validacion');
    await casos.suscribir(GUARDIA, SUSCRIPCION, 'x'.repeat(300));
    expect(repositorio.guardarSuscripcion).toHaveBeenCalledWith(GUARDIA.id,
      { endpoint: SUSCRIPCION.endpoint, p256dh: SUSCRIPCION.keys.p256dh, auth: SUSCRIPCION.keys.auth }, 'x'.repeat(255));
    expect((await fallo(casos.desuscribir(GUARDIA, {}))).message).toBe('Indique la suscripción.');
  });

  it('prueba push: 503 sin claves en el servidor, 404 sin equipos, y elimina las suscripciones vencidas', async () => {
    expect((await fallo(preparar(false).casos.probarPush(GUARDIA))).tipo).toBe('no_disponible');
    const sinEquipos = preparar();
    sinEquipos.repositorio.suscripciones.mockResolvedValue([]);
    expect((await fallo(sinEquipos.casos.probarPush(GUARDIA))).tipo).toBe('no_encontrado');
    const { casos, repositorio } = preparar();
    expect(await casos.probarPush(GUARDIA)).toMatchObject({ message: 'Prueba enviada a 1 equipo.', enviados: 1 });
    expect(repositorio.eliminarSuscripciones).toHaveBeenCalledWith([5]);
  });

  it('métricas: valida los días y calcula la tasa de alarmas por hora (ISA-18.2)', async () => {
    const { casos, repositorio } = preparar();
    expect((await fallo(casos.metricas({ dias: '365' }))).tipo).toBe('validacion');
    const r = await casos.metricas({ dias: '1' });
    expect(repositorio.metricas).toHaveBeenCalledWith(1);
    expect(r).toEqual({
      dias: 1, alarmas_por_hora: 1, ventanas_avalancha_10min: 1,
      por_severidad: [{
        severidad: 'critica', emitidas: 24, repeticiones_agrupadas: 0, con_ack: 24, reconocidas: 20, escaladas: 2,
        tta_mediana_s: 12.5, tta_p95_s: 40,
      }],
    });
  });

  it('clave push: activo solo si el servidor tiene claves y el parámetro lo permite', () => {
    expect(preparar().casos.clavePush()).toEqual({ habilitado: true, clave_publica: 'BClave' });
    expect(preparar(false).casos.clavePush()).toEqual({ habilitado: false, clave_publica: 'BClave' });
  });
});

describe('Consulta de propietario', () => {
  const preparar = (opciones: { habilitado?: boolean; usadas?: number; datos?: unknown; error?: Error } = {}) => {
    const repositorio: jest.Mocked<RepositorioPropietario> = {
      consultasUltimaHora: jest.fn().mockResolvedValue(opciones.usadas ?? 0),
      registrar: jest.fn().mockResolvedValue(undefined),
      recientes: jest.fn().mockResolvedValue([{ id: 1 }]),
    };
    const consultar = opciones.error ? jest.fn().mockRejectedValue(opciones.error)
      : jest.fn().mockResolvedValue(opciones.datos === undefined ? { nombre: 'Ana Villacís', identificacion: '1803456789', fuente: 'ANT' } : opciones.datos);
    const proveedor: ProveedorPropietario = { nombre: 'oficial', habilitado: opciones.habilitado ?? true, consultar };
    return { casos: casosPropietario({ repositorio, proveedor, limitePorHora: 20 }), repositorio, consultar };
  };
  const CUERPO = { placa: 'pba-1234', motivo: 'Verificación de vehículo con alerta en el acceso', deteccion_id: 1532 };

  it('dominio: placa con formato ANT, motivo de 10 a 255 caracteres y paso de origen opcional', () => {
    expect(leerConsultaPropietario(CUERPO)).toEqual({
      ok: true, valor: { placa: 'PBA1234', motivo: CUERPO.motivo, deteccionId: 1532 },
    });
    expect(leerConsultaPropietario({ ...CUERPO, placa: 'PBA12' }).ok).toBe(false);
    expect(leerConsultaPropietario({ ...CUERPO, motivo: 'corto' })).toEqual({ ok: false, error: 'Motivo de la consulta: mínimo 10 caracteres.' });
    expect(leerConsultaPropietario({ ...CUERPO, motivo: '<b>consulta</b> urgente' }).ok).toBe(false);
    expect(leerConsultaPropietario({ ...CUERPO, deteccion_id: 'abc' }).ok).toBe(false);
    expect(enmascararIdentificacion('1803456789')).toBe('18XXXXXX89');
    expect(enmascararIdentificacion('123')).toBe('****');
  });

  it('datos inválidos: 400 sin registrar ni consultar', async () => {
    const { casos, repositorio, consultar } = preparar();
    expect((await fallo(casos.consultar({ ...CUERPO, motivo: '' }, ADMIN))).tipo).toBe('validacion');
    expect(repositorio.registrar).not.toHaveBeenCalled();
    expect(consultar).not.toHaveBeenCalled();
  });

  it('consulta correcta: identificación enmascarada y registrada como ok', async () => {
    const { casos, repositorio } = preparar();
    expect(await casos.consultar(CUERPO, ADMIN)).toEqual({ placa: 'PBA1234', nombre: 'Ana Villacís', identificacion: '18XXXXXX89', fuente: 'ANT' });
    expect(repositorio.registrar).toHaveBeenCalledWith({
      actor: ADMIN, placa: 'PBA1234', motivo: CUERPO.motivo, deteccionId: 1532, proveedor: 'oficial', resultado: 'ok',
    });
  });

  it('cupo agotado (429), sin convenio (503) y sin datos (404): todo queda registrado', async () => {
    const limite = preparar({ usadas: 20 });
    expect(await fallo(limite.casos.consultar(CUERPO, ADMIN))).toMatchObject({ tipo: 'limite', message: 'Límite de 20 consultas por hora alcanzado.' });
    expect(limite.repositorio.registrar).toHaveBeenCalledWith(expect.objectContaining({ resultado: 'limite' }));
    expect(limite.consultar).not.toHaveBeenCalled();

    const deshabilitado = preparar({ habilitado: false });
    expect(await fallo(deshabilitado.casos.consultar(CUERPO, ADMIN))).toMatchObject({ tipo: 'no_disponible', message: MENSAJE_DESHABILITADO });
    expect(deshabilitado.repositorio.registrar).toHaveBeenCalledWith(expect.objectContaining({ resultado: 'deshabilitado' }));

    const vacio = preparar({ datos: null });
    expect((await fallo(vacio.casos.consultar(CUERPO, ADMIN))).tipo).toBe('no_encontrado');
    expect(vacio.repositorio.registrar).toHaveBeenCalledWith(expect.objectContaining({ resultado: 'no_encontrado' }));
  });

  it('falla del servicio oficial: se registra como error y se propaga (502 en la API)', async () => {
    const { casos, repositorio } = preparar({ error: new Error('timeout') });
    await expect(casos.consultar(CUERPO, ADMIN)).rejects.toThrow('timeout');
    expect(repositorio.registrar).toHaveBeenCalledWith(expect.objectContaining({ resultado: 'error' }));
  });

  it('auditoría: proveedor, estado y consultas recientes', async () => {
    expect(await preparar({ habilitado: false }).casos.auditoria()).toEqual({ proveedor: 'oficial', habilitado: false, consultas: [{ id: 1 }] });
  });
});
