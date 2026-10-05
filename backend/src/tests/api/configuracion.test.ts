/**
 * Rutas de configuración sobre la base simulada: permiso configuracion:gestionar, misma forma de
 * respuesta y validación de cada valor según el tipo declarado del parámetro (400 sin guardar).
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import configuracionRoutes from '../../interfaz/http/rutas/configuracion';

const mockEscrituras: { texto: string; entradas: Record<string, unknown> }[] = [];

jest.mock('../../infraestructura/db', () => {
  const peticion = () => {
    const entradas: Record<string, unknown> = {};
    const r: any = {
      input: (nombre: string, a: unknown, b?: unknown) => { entradas[nombre] = b === undefined ? a : b; return r; },
      query: async (texto: string) => {
        if (/FROM Usuarios u JOIN Roles r ON r\.id = u\.rol_id WHERE u\.id = @id/.test(texto)) {
          const codigo = ({ 1: 'ADMIN', 3: 'GUARDIA', 4: 'GESTOR_PERMISOS' } as Record<number, string>)[Number(entradas.id)];
          return { recordset: codigo ? [{ estado: 'activo', bloqueado: 0, bloqueado_hasta: null, codigo }] : [] };
        }
        if (/MERGE ConfiguracionSistema|INSERT INTO AuditoriaOperaciones/.test(texto)) mockEscrituras.push({ texto, entradas: { ...entradas } });
        return { recordset: [], rowsAffected: [1] };
      },
    };
    return r;
  };
  return { getDB: () => ({ request: peticion }) };
});
jest.mock('../../infraestructura/servicios/socket', () => ({ emitEvent: jest.fn(), emitirAUsuarios: jest.fn(), emitirARoles: jest.fn() }));
jest.mock('../../infraestructura/servicios/servicioAnpr', () => ({ estadoServicioAnpr: jest.fn().mockResolvedValue({ en_linea: false, error: 'Servicio no disponible' }) }));

const ROLES = { Admin: 1, Guardia: 3, GestorPermisos: 4 } as const;
type Rol = keyof typeof ROLES;
const token = (rol: Rol) => `Bearer ${jwt.sign({ id: ROLES[rol], email: `${rol}@ecu911.gob.ec`, username: rol, nombre: rol, rol }, process.env.JWT_SECRET!)}`;

describe('API · configuración', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/configuracion', configuracionRoutes);
  beforeEach(() => { mockEscrituras.length = 0; });

  it('GET: parámetros editables y datos del entorno con la misma forma', async () => {
    const r = await request(app).get('/api/configuracion').set('Authorization', token('Admin')).expect(200);
    expect(Object.keys(r.body)).toEqual(['parametros', 'entorno']);
    expect(r.body.parametros.find((p: any) => p.clave === 'sesion_horas')).toMatchObject({ tipo: 'entero', min: 1, max: 24, valor: '8', origen: 'omision' });
    expect(Object.keys(r.body.entorno)).toEqual(['zona_horaria', 'correo_configurado', 'remitente_correo', 'frontend_url', 'entorno', 'anpr']);
    expect(r.body.entorno.anpr).toEqual({ en_linea: false, error: 'Servicio no disponible' });
  });

  it('PUT: guarda lo que cambió, lo audita y responde { message, parametros }', async () => {
    const r = await request(app).put('/api/configuracion').set('Authorization', token('Admin'))
      .send({ valores: { sesion_horas: '10' } }).expect(200);
    expect(r.body.message).toBe('Configuración guardada.');
    expect(Array.isArray(r.body.parametros)).toBe(true);
    expect(mockEscrituras.map(e => e.entradas)).toEqual([
      expect.objectContaining({ clave: 'sesion_horas', valor: '10', uid: 1 }),
      expect.objectContaining({ accion: 'CONFIGURACION', entidad: 'configuracion', detalle: 'sesion_horas: 8 → 10' }),
    ]);
  });

  it('PUT: sin cambios reales responde "No hubo cambios." sin escribir', async () => {
    const r = await request(app).put('/api/configuracion').set('Authorization', token('Admin'))
      .send({ valores: { sesion_horas: '8' } }).expect(200);
    expect(r.body.message).toBe('No hubo cambios.');
    expect(mockEscrituras).toEqual([]);
  });

  it.each([
    [{}, 'No hay cambios para guardar.'],
    [{ valores: {} }, 'No hay cambios para guardar.'],
    [{ valores: { clave_rara: '1' } }, 'Parámetro desconocido: clave_rara'],
    [{ valores: { sesion_horas: '48' } }, 'Duración de la sesión (horas): máximo 24.'],
    [{ valores: { login_max_intentos: '5.5' } }, 'Intentos fallidos antes del bloqueo: solo números enteros.'],
    [{ valores: { registro_publico_habilitado: 'si' } }, 'Registro público de cuentas: debe ser verdadero o falso.'],
    [{ valores: { dominios_correo: 'ecu911.gob.ec, 10.0.0.1' } }, 'Dominios de correo permitidos: dominio inválido (10.0.0.1).'],
    [{ valores: { unidad_institucional: '<script>' } }, 'Unidad institucional: sin los caracteres < > ni caracteres de control.'],
    [{ valores: { sesion_horas: '10', autorizacion_criterio: 'otro' } }, 'Criterio de autorización automática: opción inválida.'],
  ])('PUT %j → 400 sin guardar nada', async (cuerpo, error) => {
    const r = await request(app).put('/api/configuracion').set('Authorization', token('Admin')).send(cuerpo).expect(400);
    expect(r.body).toEqual({ error });
    expect(mockEscrituras).toEqual([]);
  });

  it.each(['Guardia', 'GestorPermisos'] as Rol[])('solo con configuracion:gestionar: %s recibe 403', async (rol) => {
    await request(app).get('/api/configuracion').set('Authorization', token(rol)).expect(403);
    await request(app).put('/api/configuracion').set('Authorization', token(rol)).send({ valores: { sesion_horas: '10' } }).expect(403);
  });
});
