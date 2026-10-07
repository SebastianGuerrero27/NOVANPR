/**
 * Rutas de solicitudes de acceso sobre la base simulada, con énfasis en la edición
 * (PUT /api/solicitudes-acceso/:id): permiso solicitudes:crear, solo quien la registró (403),
 * solo mientras está pendiente (409), mismas validaciones que el alta (400), auditoría
 * SOLICITUD_EDITADA, evento solicitudes:actualizadas y respuesta { message, solicitud }.
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import solicitudesRoutes from '../../interfaz/http/rutas/solicitudesAcceso';
import { emitEvent } from '../../infraestructura/servicios/socket';

/** Estado de la base simulada: la solicitud guardada, otra pendiente con la placa y lo escrito. */
const mockBase = {
  fila: null as Record<string, any> | null,
  otraPendiente: null as number | null,
  escrituras: [] as { texto: string; entradas: Record<string, any> }[],
};

jest.mock('../../infraestructura/db', () => {
  const peticion = () => {
    const entradas: Record<string, any> = {};
    const r: any = {
      input: (nombre: string, a: unknown, b?: unknown) => { entradas[nombre] = b === undefined ? a : b; return r; },
      query: async (texto: string) => {
        if (/FROM Usuarios u JOIN Roles r ON r\.id = u\.rol_id WHERE u\.id = @id/.test(texto)) {
          const codigo = ({ 1: 'ADMIN', 3: 'GUARDIA', 4: 'GESTOR_PERMISOS' } as Record<number, string>)[Number(entradas.id)];
          return { recordset: codigo ? [{ estado: 'activo', bloqueado: 0, bloqueado_hasta: null, codigo }] : [] };
        }
        const f = mockBase.fila;
        if (/FROM SolicitudesAcceso s[\s\S]*WHERE s\.id = @id/.test(texto)) {
          return { recordset: f && f.id === entradas.id ? [{ ...f }] : [] };
        }
        if (/SELECT TOP 1 id FROM SolicitudesAcceso/.test(texto)) {
          return { recordset: mockBase.otraPendiente ? [{ id: mockBase.otraPendiente }] : [] };
        }
        if (/UPDATE SolicitudesAcceso\s+SET placa = @placa/.test(texto)) {
          mockBase.escrituras.push({ texto, entradas: { ...entradas } });
          // Misma condición atómica que el repositorio: pendiente y registrada por quien edita
          const aplica = !!f && f.id === entradas.id && f.estado === 'pendiente' && f.solicitado_por === entradas.uid;
          if (aplica) {
            Object.assign(f!, {
              placa: entradas.placa, propietario: entradas.propietario, departamento: entradas.departamento,
              categoria: entradas.categoria, motivo: entradas.motivo, tipo_vehiculo: entradas.tipo, marca: entradas.marca,
              modelo: entradas.modelo, color: entradas.color, fecha_inicio: entradas.inicio, fecha_fin: entradas.fin,
              horario: entradas.horario, deteccion_id: entradas.det,
            });
          }
          return { recordset: [], rowsAffected: [aplica ? 1 : 0] };
        }
        if (/INSERT INTO AuditoriaOperaciones/.test(texto)) {
          mockBase.escrituras.push({ texto, entradas: { ...entradas } });
          return { recordset: [], rowsAffected: [1] };
        }
        return { recordset: [], rowsAffected: [0] };
      },
    };
    return r;
  };
  return { getDB: () => ({ request: peticion }) };
});
jest.mock('../../infraestructura/servicios/socket', () => ({ emitEvent: jest.fn(), emitirAUsuarios: jest.fn(), emitirARoles: jest.fn() }));

const ROLES = { Admin: 1, Guardia: 3, GestorPermisos: 4 } as const;
type Rol = keyof typeof ROLES;
const token = (rol: Rol) => `Bearer ${jwt.sign({ id: ROLES[rol], email: `${rol}@ecu911.gob.ec`, username: rol, nombre: rol, rol }, process.env.JWT_SECRET!)}`;

/** Solicitud pendiente #12 registrada por el guardia (usuario 3) desde el paso vehicular 1532. */
const filaPendiente = () => ({
  id: 12, placa: 'PBA1234', propietario: 'Ana Villacís', departamento: 'Tecnología', categoria: 'VISITANTE',
  motivo: 'Visita técnica al centro de datos', tipo_vehiculo: 'Automóvil', marca: 'Chevrolet', modelo: 'Aveo', color: 'Blanco',
  fecha_inicio: new Date('2026-10-05T00:00:00Z'), fecha_fin: new Date('2026-10-05T00:00:00Z'), horario: null, deteccion_id: 1532,
  estado: 'pendiente', solicitado_por: ROLES.Guardia, solicitante_nombre: 'Guardia', solicitante_email: 'guardia@ecu911.gob.ec',
  fecha_solicitud: new Date('2026-10-04T10:00:00Z'), resuelto_por: null, resolutor_nombre: null, fecha_resolucion: null,
  comentario_resolucion: null, vehiculo_autorizado_id: null, en_lista_alertas: 0, permiso_actual_id: null,
});

/** Edición sin deteccion_id: conserva el paso vehicular de origen. */
const CUERPO = {
  placa: 'pbb-5678', propietario: 'Ana Villacís', departamento: 'Tecnología', categoria: 'PROVEEDOR',
  motivo: 'Entrega de equipos de radio', tipo_vehiculo: 'Camioneta', marca: 'Toyota', modelo: 'Hilux', color: 'Gris',
  fecha_inicio: '2026-10-06', fecha_fin: '2026-10-07', horario: null,
};

describe('API · solicitudes de acceso (edición)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/solicitudes-acceso', solicitudesRoutes);

  const editar = (rol: Rol, cuerpo: object = CUERPO, id: number | string = 12) =>
    request(app).put(`/api/solicitudes-acceso/${id}`).set('Authorization', token(rol)).send(cuerpo);

  beforeEach(() => {
    mockBase.fila = filaPendiente();
    mockBase.otraPendiente = null;
    mockBase.escrituras.length = 0;
    jest.mocked(emitEvent).mockClear();
  });

  it('quien la registró la edita mientras está pendiente: { message, solicitud }, auditada y difundida', async () => {
    const r = await editar('Guardia').expect(200);
    expect(r.body.message).toBe('Solicitud actualizada.');
    expect(r.body.solicitud).toMatchObject({
      id: 12, placa: 'PBB5678', categoria: 'PROVEEDOR', motivo: 'Entrega de equipos de radio', estado: 'pendiente',
      vehiculo: { tipo: 'Camioneta', marca: 'Toyota', modelo: 'Hilux', color: 'Gris' },
      fecha_inicio: '2026-10-06', fecha_fin: '2026-10-07', deteccion_id: 1532,
      solicitante: { id: ROLES.Guardia, nombre: 'Guardia', email: 'guardia@ecu911.gob.ec' },
    });
    const [actualizacion, auditoria] = mockBase.escrituras;
    expect(actualizacion.entradas).toMatchObject({ id: 12, uid: ROLES.Guardia, placa: 'PBB5678', det: 1532 });
    expect(auditoria.entradas).toMatchObject({
      accion: 'SOLICITUD_EDITADA', entidad: 'solicitud_acceso', eid: 12, uid: ROLES.Guardia,
      detalle: 'PBB5678: placa, categoria, motivo, tipo_vehiculo, marca, modelo, color, fecha_inicio, fecha_fin',
    });
    expect(emitEvent).toHaveBeenCalledWith('solicitudes:actualizadas', {});
  });

  it('403 si no la registró, aunque su rol pueda crear solicitudes (Administrador)', async () => {
    const r = await editar('Admin').expect(403);
    expect(r.body).toEqual({ error: 'Solo quien registró la solicitud puede editarla.' });
    expect(mockBase.escrituras).toEqual([]);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('409 si ya no está pendiente', async () => {
    mockBase.fila!.estado = 'aprobada';
    const r = await editar('Guardia').expect(409);
    expect(r.body).toEqual({ error: 'La solicitud ya fue aprobada: solo puede editarse mientras está pendiente.' });
    expect(mockBase.escrituras).toEqual([]);
  });

  it.each([
    [{ placa: 'ABC12' }, 'Placa inválida. Formato: ABC-1234 (automóvil) o AB-123C (motocicleta).'],
    [{ propietario: 'Ana 2' }, "Propietario o responsable: solo letras, espacios y . ' - &."],
    [{ motivo: '<b>Visita</b>' }, 'Motivo del ingreso: sin los caracteres < > ni caracteres de control.'],
    [{ motivo: '' }, 'El campo «Motivo del ingreso» es obligatorio.'],
    [{ deteccion_id: -4 }, 'Ingreso de origen: mínimo 1.'],
    [{ fecha_inicio: '2026-10-08' }, 'La fecha de inicio no puede ser posterior al vencimiento.'],
  ])('400 con las mismas validaciones del alta: %j', async (cambio, error) => {
    const r = await editar('Guardia', { ...CUERPO, ...cambio }).expect(400);
    expect(r.body).toEqual({ error });
    expect(mockBase.escrituras).toEqual([]);
  });

  it('409 si otra solicitud pendiente ya tiene la placa', async () => {
    mockBase.otraPendiente = 20;
    const r = await editar('Guardia').expect(409);
    expect(r.body).toEqual({ error: 'Ya existe una solicitud pendiente para PBB5678 (#20).' });
    expect(mockBase.escrituras).toEqual([]);
  });

  it('404 si no existe y 400 si el identificador no es un entero positivo', async () => {
    expect((await editar('Guardia', CUERPO, 99).expect(404)).body).toEqual({ error: 'Solicitud no encontrada.' });
    expect((await editar('Guardia', CUERPO, 0).expect(400)).body).toEqual({ error: 'Identificador inválido.' });
    await editar('Guardia', CUERPO, 'abc').expect(404);
  });

  it('requiere solicitudes:crear: el gestor de permisos recibe 403 y sin sesión 401', async () => {
    await editar('GestorPermisos').expect(403);
    await request(app).put('/api/solicitudes-acceso/12').send(CUERPO).expect(401);
    expect(mockBase.escrituras).toEqual([]);
  });
});
