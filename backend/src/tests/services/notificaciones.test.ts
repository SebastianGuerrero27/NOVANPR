import { configurarPuertos, notificar, Puertos, NotificacionDTO } from '../../services/notificaciones';

jest.mock('../../config/db', () => ({ getDB: jest.fn() }));
jest.mock('../../services/socket', () => ({ emitirAUsuarios: jest.fn() }));

const espera = () => new Promise(r => setImmediate(r));

function falsos(estado: { duplicada?: number | null; usuarios?: number[]; subs?: any[] } = {}) {
  const emitidos: { usuarios: number[]; evento: string; datos: any }[] = [];
  const dto = (id: number): NotificacionDTO => ({
    id, tipo: 'acceso.no_registrado', severidad: 'alta', titulo: 't', mensaje: 'm', enlace: '/detecciones/1', datos: null,
    repeticiones: 1, requiere_ack: true, fecha_creacion: new Date(), fecha_ultima: new Date(), leida: false,
    atendida: null, resuelta: false, escalada: false,
  });
  const p: Puertos = {
    buscarDuplicada: jest.fn(async () => estado.duplicada ?? null),
    incrementarRepeticion: jest.fn(async () => undefined),
    insertar: jest.fn(async () => 41),
    asignar: jest.fn(async () => estado.usuarios ?? [10, 11]),
    obtener: jest.fn(async (id: number) => dto(id)),
    destinatariosDe: jest.fn(async () => estado.usuarios ?? [10, 11]),
    suscripciones: jest.fn(async () => estado.subs ?? []),
    eliminarSuscripciones: jest.fn(async () => undefined),
    emitir: jest.fn((usuarios, evento, datos) => { emitidos.push({ usuarios, evento, datos }); }),
    push: jest.fn(async () => ({ vencidas: [99] })),
    ahora: () => new Date(),
  };
  return { p, emitidos };
}

afterEach(() => configurarPuertos());

describe('centro de notificaciones', () => {
  it('guarda, asigna por permiso (roles del catálogo) y emite a cada destinatario', async () => {
    const { p, emitidos } = falsos();
    configurarPuertos(p);
    const r = await notificar({ tipo: 'acceso.no_registrado', titulo: 'Vehículo sin permiso · ABC1234', mensaje: 'x', claveDedup: 'no_registrado:ABC1234', deteccionId: 5 });
    expect(r?.id).toBe(41);
    expect(p.insertar).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'acceso.no_registrado', severidad: 'alta', requiereAck: true, deteccionId: 5 }));
    // avisos:acceso → Operador, GestorAccesos, Supervisor, Admin
    const roles = (p.asignar as jest.Mock).mock.calls[0][1].sort();
    expect(roles).toEqual(['ADMIN', 'GESTOR_ACCESOS', 'OPERADOR', 'SUPERVISOR']);
    expect(emitidos).toEqual([expect.objectContaining({ usuarios: [10, 11], evento: 'notificacion:nueva' })]);
  });

  it('el guardado precede a la emisión (recuperable tras reconectar)', async () => {
    const orden: string[] = [];
    const { p } = falsos();
    configurarPuertos({ ...p, insertar: jest.fn(async () => { orden.push('insertar'); return 1; }), emitir: jest.fn(() => { orden.push('emitir'); }) });
    await notificar({ tipo: 'acceso.alerta_seguridad', titulo: 'a', mensaje: 'b' });
    expect(orden).toEqual(['insertar', 'emitir']);
  });

  it('supresión de avalanchas: una repetición dentro de la ventana no crea otra alarma', async () => {
    const { p, emitidos } = falsos({ duplicada: 7 });
    configurarPuertos(p);
    const r = await notificar({ tipo: 'acceso.no_registrado', titulo: 't', mensaje: 'm', claveDedup: 'no_registrado:ABC1234' });
    expect(r?.id).toBe(7);
    expect(p.insertar).not.toHaveBeenCalled();
    expect(p.incrementarRepeticion).toHaveBeenCalledWith(7);
    expect(emitidos[0].evento).toBe('notificacion:actualizada');
  });

  it('los resúmenes diarios duplicados se omiten sin emitir', async () => {
    const { p, emitidos } = falsos({ duplicada: 3 });
    configurarPuertos(p);
    expect(await notificar({ tipo: 'padron.por_vencer', titulo: 't', mensaje: 'm', claveDedup: 'padron.por_vencer:2026-10-01' })).toBeNull();
    expect(p.incrementarRepeticion).not.toHaveBeenCalled();
    expect(emitidos).toHaveLength(0);
  });

  it('destinatarios explícitos y exclusión (quien solicita no recibe su propia solicitud)', async () => {
    const { p } = falsos();
    configurarPuertos(p);
    await notificar({ tipo: 'solicitud.nueva', titulo: 't', mensaje: 'm', destinatarios: { excluir: [3] } });
    expect((p.asignar as jest.Mock).mock.calls[0][3]).toEqual([3]);
    await notificar({ tipo: 'solicitud.resuelta', titulo: 't', mensaje: 'm', destinatarios: { usuarios: [3] } });
    expect((p.asignar as jest.Mock).mock.calls[1][1]).toEqual([]); // sin permiso en el catálogo: solo el usuario
    expect((p.asignar as jest.Mock).mock.calls[1][2]).toEqual([3]);
  });

  it('envía push a las suscripciones y depura las vencidas', async () => {
    const { p } = falsos({ subs: [{ id: 99, usuario_id: 10, endpoint: 'https://x', p256dh: 'k', auth: 'a' }] });
    configurarPuertos(p);
    await notificar({ tipo: 'acceso.alerta_seguridad', severidad: 'critica', titulo: 't', mensaje: 'm' });
    await espera();
    expect(p.push).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ id: 41 }), { ttlS: 300, urgencia: 'high' });
    expect(p.eliminarSuscripciones).toHaveBeenCalledWith([99]);
  });

  it('no envía push para tipos sin canal push', async () => {
    const { p } = falsos();
    configurarPuertos(p);
    await notificar({ tipo: 'acceso.confirmacion', titulo: 't', mensaje: 'm' });
    await espera();
    expect(p.suscripciones).not.toHaveBeenCalled();
  });

  it('un fallo de E/S no se propaga al registro del paso vehicular', async () => {
    const { p } = falsos();
    configurarPuertos({ ...p, insertar: jest.fn(async () => { throw new Error('BD caída'); }) });
    const silencio = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(notificar({ tipo: 'acceso.no_registrado', titulo: 't', mensaje: 'm' })).resolves.toBeNull();
    silencio.mockRestore();
  });
});
