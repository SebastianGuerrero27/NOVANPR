/**
 * Endpoints de autenticación con la base simulada (esquema v2+: correo, estado, rol por código).
 */
import request from 'supertest';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

process.env.BCRYPT_ROUNDS = '4';
const HASH = bcrypt.hashSync('ClaveSegura#2026', 4);

const usuario = {
  id: 4, email: 'gestor@ecu911.gob.ec', nombre_completo: 'Gestor de Accesos', cargo: null, password_hash: HASH,
  rol_codigo: 'GESTOR_PERMISOS', rol_nombre: 'Gestor de permisos', estado: 'activo', email_verificado: 1,
  bloqueado: 0, bloqueado_hasta: null, intentos_fallidos: 0,
};

jest.mock('../../infraestructura/db', () => ({
  getDB: () => ({
    request: () => {
      const entradas: Record<string, unknown> = {};
      const r: any = {
        input: (n: string, a: unknown, b?: unknown) => { entradas[n] = b === undefined ? a : b; return r; },
        query: async (texto: string) => {
          if (/WHERE u\.email = @email/.test(texto)) {
            return { recordset: entradas.email === usuario.email ? [usuario] : [] };
          }
          return { recordset: [], rowsAffected: [1] };
        },
      };
      return r;
    },
  }),
}));
jest.mock('../../infraestructura/servicios/emailService', () => ({ emailService: { cuentaBloqueada: jest.fn(), smtpConfigurado: () => false } }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const authRoutes = require('../../interfaz/http/rutas/auth').default;

describe('Auth API', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);

  it('inicia sesión con credenciales válidas y entrega el rol con sus permisos', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: 'GESTOR@ecu911.gob.ec ', password: 'ClaveSegura#2026' });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ id: 4, rol: 'GestorPermisos', rol_nombre: 'Gestor de permisos' });
    expect(r.body.user.permisos).toEqual(expect.arrayContaining(['padron:gestionar', 'solicitudes:resolver']));
    expect(r.body.user.permisos).not.toContain('alertas:gestionar');
    const payload = jwt.verify(r.body.token, process.env.JWT_SECRET!) as any;
    expect(payload).toMatchObject({ id: 4, rol: 'GestorPermisos' });
  });

  it('rechaza una contraseña incorrecta con 401 y mensaje genérico', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: usuario.email, password: 'incorrecta' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Correo o contraseña incorrectos.');
  });

  it('no revela si el correo existe', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: 'nadie@ecu911.gob.ec', password: 'x' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Correo o contraseña incorrectos.');
  });

  it('exige correo y contraseña', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: usuario.email });
    expect(r.status).toBe(400);
    expect(r.body).toHaveProperty('error');
  });
});
