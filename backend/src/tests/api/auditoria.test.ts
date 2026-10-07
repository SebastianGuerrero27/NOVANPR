/**
 * Rutas de auditoría sobre la base simulada: permiso auditoria:ver, consulta paginada,
 * exportación CSV (UTF-8 con BOM, nombre del archivo, fórmulas neutralizadas), detalle de un
 * registro y validación del plazo de retención.
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import auditoriaRoutes from '../../interfaz/http/rutas/auditoria';

const mockAuditadas: Record<string, unknown>[] = [];

jest.mock('../../infraestructura/db', () => {
  const fila = {
    id: '7', fecha: new Date('2026-10-04T15:30:00Z'), accion: 'ROL_CAMBIADO', actor_id: 1, actor_email: 'admin@ecu911.gob.ec',
    objetivo_id: 3, objetivo_email: 'guardia@ecu911.gob.ec', detalle: '=HYPERLINK("http://malicioso")', ip: '10.0.0.1',
  };
  const peticion = () => {
    const entradas: Record<string, unknown> = {};
    const r: any = {
      input: (nombre: string, a: unknown, b?: unknown) => { entradas[nombre] = b === undefined ? a : b; return r; },
      query: async (texto: string) => {
        if (/FROM Usuarios u JOIN Roles r ON r\.id = u\.rol_id WHERE u\.id = @id/.test(texto)) {
          const codigo = ({ 1: 'ADMIN', 3: 'GUARDIA', 4: 'GESTOR_PERMISOS' } as Record<number, string>)[Number(entradas.id)];
          return { recordset: codigo ? [{ estado: 'activo', bloqueado: 0, bloqueado_hasta: null, codigo }] : [] };
        }
        if (/INSERT INTO AuditoriaOperaciones/.test(texto)) {
          mockAuditadas.push({ ...entradas });
          return { recordset: [], rowsAffected: [1] };
        }
        if (/SELECT COUNT\(\*\) AS n FROM Auditoria/.test(texto)) return { recordset: [{ n: 1 }] };
        if (/OFFSET @offset ROWS/.test(texto)) return { recordset: [{ id: '7', fecha: fila.fecha, actor: fila.actor_email, accion: fila.accion }] };
        if (/SELECT TOP \(@limite\)/.test(texto)) return { recordset: [fila] };
        if (/WHERE id = @id/.test(texto)) return { recordset: Number(entradas.id) === 7 ? [fila] : [] };
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

describe('API · auditoría', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auditoria', auditoriaRoutes);

  it('consulta paginada con la misma forma { items, total, pagina, tamano }', async () => {
    const r = await request(app).get('/api/auditoria?fuente=cuentas&pagina=1&tamano=10').set('Authorization', token('Admin')).expect(200);
    expect(r.body).toEqual({
      items: [{ id: '7', fecha: '2026-10-04T15:30:00.000Z', actor: 'admin@ecu911.gob.ec', accion: 'ROL_CAMBIADO' }],
      total: 1, pagina: 1, tamano: 10,
    });
  });

  it('exportar: CSV UTF-8 con BOM, nombre auditoria_<fuente>_<AAAA-MM-DD>.csv, fórmulas neutralizadas y auditado', async () => {
    const r = await request(app).get('/api/auditoria/exportar?fuente=cuentas&q=admin').set('Authorization', token('Admin')).expect(200);
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="auditoria_cuentas_\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.text.charCodeAt(0)).toBe(0xfeff);
    const [encabezado, linea] = r.text.slice(1).split('\r\n');
    expect(encabezado).toBe('"id","fecha","accion","actor_id","actor_email","objetivo_id","objetivo_email","detalle","ip"');
    expect(linea).toContain('"\'=HYPERLINK(""http://malicioso"")"');
    expect(mockAuditadas).toContainEqual(expect.objectContaining({ accion: 'AUDITORIA_EXPORTADA', entidad: 'auditoria', uid: 1 }));
  });

  it('exportar: una fuente desconocida exporta las operaciones (mismo criterio que la consulta)', async () => {
    const r = await request(app).get('/api/auditoria/exportar?fuente=sistema').set('Authorization', token('Admin')).expect(200);
    expect(r.headers['content-disposition']).toMatch(/filename="auditoria_operaciones_/);
  });

  it('detalle: un registro con todas sus columnas; 404 si no existe o si la fuente no es una de las tres', async () => {
    const r = await request(app).get('/api/auditoria/cuentas/7').set('Authorization', token('Admin')).expect(200);
    expect(r.body).toMatchObject({ id: '7', accion: 'ROL_CAMBIADO', objetivo_email: 'guardia@ecu911.gob.ec', ip: '10.0.0.1' });
    const no = await request(app).get('/api/auditoria/operaciones/8').set('Authorization', token('Admin')).expect(404);
    expect(no.body).toEqual({ error: 'Registro de auditoría no encontrado.' });
    await request(app).get('/api/auditoria/sistema/7').set('Authorization', token('Admin')).expect(404);
    await request(app).get('/api/auditoria/operaciones/abc').set('Authorization', token('Admin')).expect(404);
  });

  it('retención: 400 si el plazo no es un entero entre 365 y 3650 días', async () => {
    const corto = await request(app).post('/api/auditoria/retencion').set('Authorization', token('Admin')).send({ dias: 30 }).expect(400);
    expect(corto.body.error).toMatch(/mínimo 365/);
    const largo = await request(app).post('/api/auditoria/retencion').set('Authorization', token('Admin')).send({ dias: 4000 }).expect(400);
    expect(largo.body.error).toMatch(/máximo 3650/);
    await request(app).post('/api/auditoria/retencion').set('Authorization', token('Admin')).send({}).expect(400);
    await request(app).post('/api/auditoria/retencion').set('Authorization', token('Admin')).send({ dias: '1 año' }).expect(400);
  });

  it.each(['Guardia', 'GestorPermisos'] as Rol[])('solo con auditoria:ver: %s recibe 403 en todas las rutas', async (rol) => {
    await request(app).get('/api/auditoria').set('Authorization', token(rol)).expect(403);
    await request(app).get('/api/auditoria/exportar').set('Authorization', token(rol)).expect(403);
    await request(app).get('/api/auditoria/operaciones/7').set('Authorization', token(rol)).expect(403);
    await request(app).post('/api/auditoria/retencion').set('Authorization', token(rol)).send({ dias: 400 }).expect(403);
  });

  it('sin sesión → 401', async () => {
    await request(app).get('/api/auditoria/exportar').expect(401);
    await request(app).post('/api/auditoria/retencion').send({ dias: 400 }).expect(401);
  });
});
