/**
 * Integración HTTP sobre la aplicación real (crearApp) con la base de datos simulada:
 * verifica de extremo a extremo que cada endpoint aplica la matriz RBAC (401 sin sesión,
 * 403 sin permiso, y que con permiso la solicitud llega a la validación de negocio).
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { Express } from 'express';

const CODIGO_POR_USUARIO: Record<number, string> = { 1: 'ADMIN', 2: 'SUPERVISOR', 3: 'OPERADOR', 4: 'GESTOR_ACCESOS' };

jest.mock('../../config/db', () => {
  const peticion = () => {
    const entradas: Record<string, unknown> = {};
    const r: any = {
      input: (nombre: string, a: unknown, b?: unknown) => { entradas[nombre] = b === undefined ? a : b; return r; },
      query: async (texto: string) => {
        if (/FROM Usuarios u JOIN Roles r ON r\.id = u\.rol_id WHERE u\.id = @id/.test(texto)) {
          const codigo = CODIGO_POR_USUARIO[Number(entradas.id)];
          return { recordset: codigo ? [{ estado: 'activo', bloqueado: 0, bloqueado_hasta: null, codigo }] : [], recordsets: [], rowsAffected: [1] };
        }
        return { recordset: [], recordsets: [[]], rowsAffected: [0] };
      },
      batch: async () => ({ recordset: [] }),
    };
    return r;
  };
  return { getDB: () => ({ request: peticion }) };
});
jest.mock('../../services/socket', () => ({ emitEvent: jest.fn(), emitirAUsuarios: jest.fn(), emitirARoles: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { crearApp } = require('../../app') as { crearApp: () => Express };

const ROLES = { Admin: 1, Supervisor: 2, Operador: 3, GestorAccesos: 4 } as const;
type Rol = keyof typeof ROLES;
const token = (rol: Rol) => jwt.sign({ id: ROLES[rol], email: `${rol}@ecu911.gob.ec`, username: rol, nombre: rol, rol }, process.env.JWT_SECRET!);

describe('API · integración', () => {
  let app: Express;
  beforeAll(() => { app = crearApp(); });

  it('health y métricas Prometheus', async () => {
    await request(app).get('/health').expect(200).expect(r => expect(r.body.status).toBe('OK'));
    const m = await request(app).get('/metrics').expect(200);
    expect(m.headers['content-type']).toContain('text/plain');
    expect(m.text).toContain('anpr_notificaciones_total');
  });

  it('sin sesión → 401', async () => {
    await request(app).get('/api/vehiculos-autorizados').expect(401);
    await request(app).get('/api/notificaciones').expect(401);
    await request(app).get('/api/vehiculos-autorizados').set('Authorization', 'Bearer token-falso').expect(401);
  });

  /**
   * [método, ruta, cuerpo, { rol: estado esperado }]. 400/404/200 = pasó la autorización y
   * llegó a la lógica del endpoint; 403 = la matriz RBAC lo impidió; PERMITIDO = cualquier
   * respuesta distinta de 401/403 (el resultado depende de datos que la base simulada no tiene).
   */
  const PERMITIDO = -1;
  const MATRIZ: [string, string, object, Record<Rol, number>][] = [
    ['post', '/api/vehiculos-autorizados', {}, { Admin: 400, Supervisor: 400, GestorAccesos: 400, Operador: 403 }],
    ['post', '/api/blacklist', {}, { Admin: 400, Supervisor: 400, GestorAccesos: 403, Operador: 403 }],
    ['get', '/api/vehiculos-autorizados', {}, { Admin: 200, Supervisor: 200, GestorAccesos: 200, Operador: 200 }],
    ['post', '/api/solicitudes-acceso', {}, { Admin: 400, Supervisor: 400, GestorAccesos: 400, Operador: 400 }],
    ['post', '/api/solicitudes-acceso/5/rechazar', {}, { Admin: 400, Supervisor: 400, GestorAccesos: 400, Operador: 403 }],
    ['post', '/api/solicitudes-acceso/5/aprobar', {}, { Admin: 404, Supervisor: 404, GestorAccesos: 404, Operador: 403 }],
    ['get', '/api/panel/accesos', {}, { Admin: 200, Supervisor: 200, GestorAccesos: 200, Operador: 403 }],
    ['get', '/api/usuarios', {}, { Admin: 200, Supervisor: 403, GestorAccesos: 403, Operador: 403 }],
    ['delete', '/api/detecciones/1', {}, { Admin: 400, Supervisor: 403, GestorAccesos: 403, Operador: 403 }],
    ['get', '/api/notificaciones/metricas', {}, { Admin: 200, Supervisor: 200, GestorAccesos: 403, Operador: 403 }],
    ['get', '/api/reportes?desde=2026-10-02&hasta=2026-10-01', {}, { Admin: 400, Supervisor: 400, GestorAccesos: 400, Operador: 403 }],
    ['get', '/api/auditoria', {}, { Admin: PERMITIDO, Supervisor: 403, GestorAccesos: 403, Operador: 403 }],
    // Excepción de acceso (autorizar fuera de horario): solo con accesos:excepcion
    ['post', '/api/detecciones/validar/1', { placa_validada: 'ABC1234', excepcion: true, observacion: 'Reunión urgente' },
      { Admin: 404, Supervisor: 404, GestorAccesos: 404, Operador: 403 }],
  ];

  for (const [metodo, ruta, cuerpo, esperado] of MATRIZ) {
    for (const rol of Object.keys(esperado) as Rol[]) {
      it(`${metodo.toUpperCase()} ${ruta} · ${rol} → ${esperado[rol] === PERMITIDO ? 'permitido' : esperado[rol]}`, async () => {
        const silencio = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const r = await (request(app) as any)[metodo](ruta).set('Authorization', `Bearer ${token(rol)}`).send(cuerpo);
        silencio.mockRestore();
        if (esperado[rol] === PERMITIDO) expect([401, 403]).not.toContain(r.status);
        else expect({ ruta, rol, status: r.status }).toEqual({ ruta, rol, status: esperado[rol] });
      });
    }
  }

  it('la bandeja de notificaciones es por usuario y responde a todos los roles', async () => {
    for (const rol of Object.keys(ROLES) as Rol[]) {
      const r = await request(app).get('/api/notificaciones').set('Authorization', `Bearer ${token(rol)}`).expect(200);
      expect(r.body).toEqual({ items: [], no_leidas: 0, pendientes: 0 });
    }
  });

  it('el catálogo de notificaciones se publica para el cliente', async () => {
    const r = await request(app).get('/api/notificaciones/catalogo').set('Authorization', `Bearer ${token('Operador')}`).expect(200);
    expect(r.body.map((t: any) => t.tipo)).toContain('acceso.restringido');
  });
});
