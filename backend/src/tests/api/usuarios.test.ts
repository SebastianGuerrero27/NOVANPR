/**
 * Rutas de cuentas sobre la base simulada (router → caso de uso → repositorio SQL → JSON):
 * detalle y baja lógica de usuarios (GET y DELETE /api/usuarios/:id), orden de las rutas,
 * identificadores inválidos y la traducción de los rechazos de la autenticación a su código HTTP.
 */
import request from 'supertest';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

process.env.BCRYPT_ROUNDS = '4';
const CLAVE = 'ClaveSegura#2026';
const HASH = bcrypt.hashSync(CLAVE, 4);

/** Fila de Usuarios con su rol, como la devuelven las consultas (u.* + r.codigo + r.nombre + correo del creador). */
const fila = (id: number, email: string, rol_codigo: string, extra: Record<string, unknown> = {}) => ({
  id, email, nombre_completo: `Persona ${String.fromCharCode(64 + id)}`, cargo: null, estado: 'activo', email_verificado: 1,
  bloqueado: 0, bloqueado_hasta: null, intentos_fallidos: 0, fecha_ultimo_acceso: null,
  fecha_creacion: new Date('2026-09-01T10:00:00Z'), rol_codigo, rol_nombre: rol_codigo === 'ADMIN' ? 'Administrador' : 'Guardia',
  creado_por_email: 'admin@ecu911.gob.ec', password_hash: HASH, ...extra,
});

const mockUsuarios = new Map<number, Record<string, any>>();
const mockEscrituras: { texto: string; entradas: Record<string, unknown> }[] = [];

function reiniciar() {
  mockUsuarios.clear();
  mockEscrituras.length = 0;
  for (const u of [
    fila(1, 'admin@ecu911.gob.ec', 'ADMIN', { nombre_completo: 'Administradora Zonal' }),
    fila(3, 'garita@ecu911.gob.ec', 'GUARDIA'),
    fila(7, 'guardia@ecu911.gob.ec', 'GUARDIA', { nombre_completo: 'Luis Mendoza', cargo: 'Guardia de garita' }),
    fila(8, 'bloqueado@ecu911.gob.ec', 'GUARDIA', { bloqueado_hasta: new Date(Date.now() + 9.5 * 60000) }),
    fila(9, 'pendiente@ecu911.gob.ec', 'GUARDIA', { estado: 'pendiente', email_verificado: 0, creado_por_email: null }),
  ]) mockUsuarios.set(u.id, u);
}

jest.mock('../../infraestructura/db', () => {
  const peticion = () => {
    const entradas: Record<string, unknown> = {};
    const r: any = {
      input: (nombre: string, a: unknown, b?: unknown) => { entradas[nombre] = b === undefined ? a : b; return r; },
      query: async (texto: string) => {
        const porId = () => mockUsuarios.get(Number(entradas.id));
        // authMiddleware: estado vigente de la cuenta de la sesión
        if (/SELECT u\.estado, u\.bloqueado, u\.bloqueado_hasta, r\.codigo/.test(texto)) {
          const u = porId();
          return { recordset: u ? [{ estado: u.estado, bloqueado: u.bloqueado, bloqueado_hasta: u.bloqueado_hasta, codigo: u.rol_codigo }] : [] };
        }
        // Repositorio de usuarios: detalle y listado (SELECT_USUARIO)
        if (/LEFT JOIN Usuarios c ON c\.id = u\.creado_por\s+WHERE u\.id = @id/.test(texto)) return { recordset: porId() ? [porId()] : [] };
        if (/LEFT JOIN Usuarios c ON c\.id = u\.creado_por\s+ORDER BY/.test(texto)) return { recordset: [...mockUsuarios.values()] };
        if (/SELECT codigo, nombre, descripcion FROM Roles ORDER BY id/.test(texto)) {
          return { recordset: [
            { codigo: 'ADMIN', nombre: 'Administrador', descripcion: 'Administración del sistema' },
            { codigo: 'OPERADOR', nombre: 'Operador', descripcion: 'Rol retirado en la migración v6' },
          ] };
        }
        if (/SELECT COUNT\(\*\) AS n FROM Usuarios u JOIN Roles r[\s\S]*u\.bloqueado = 0/.test(texto)) {
          return { recordset: [{ n: [...mockUsuarios.values()].filter(u => u.rol_codigo === 'ADMIN' && u.estado === 'activo' && !u.bloqueado).length }] };
        }
        if (/SET estado = 'inactivo'/.test(texto)) {
          mockEscrituras.push({ texto, entradas: { ...entradas } });
          if (porId()) porId()!.estado = 'inactivo';
          return { recordset: [], rowsAffected: [1] };
        }
        if (/INSERT INTO Auditoria(Usuarios|Accesos)/.test(texto)) mockEscrituras.push({ texto, entradas: { ...entradas } });
        // Autenticación: cuenta por correo, sesión vigente y enlace de verificación (vencido)
        if (/WHERE u\.email = @email/.test(texto)) {
          return { recordset: [...mockUsuarios.values()].filter(u => u.email === entradas.email) };
        }
        if (/SELECT u\.id, u\.email, u\.nombre_completo, u\.cargo, u\.estado, u\.fecha_ultimo_acceso/.test(texto)) return { recordset: porId() ? [porId()] : [] };
        if (/FROM VerificacionEmail t JOIN Usuarios u/.test(texto)) {
          return { recordset: [{ id: 3, usuario_id: 9, usado: 0, fecha_expiracion: new Date(Date.now() - 60000), email: 'pendiente@ecu911.gob.ec', nombre_completo: 'Persona I' }] };
        }
        return { recordset: [], rowsAffected: [1] };
      },
    };
    return r;
  };
  return { getDB: () => ({ request: peticion }) };
});
jest.mock('../../infraestructura/servicios/socket', () => ({ emitEvent: jest.fn(), emitirAUsuarios: jest.fn(), emitirARoles: jest.fn() }));
jest.mock('../../infraestructura/servicios/emailService', () => ({
  emailService: {
    smtpConfigurado: () => false,
    definirPasswordCuentaNueva: jest.fn().mockResolvedValue(true),
    restablecerPassword: jest.fn().mockResolvedValue(true),
    verificacionCuenta: jest.fn().mockResolvedValue(true),
    passwordCambiada: jest.fn().mockResolvedValue(true),
    cuentaBloqueada: jest.fn().mockResolvedValue(true),
  },
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const usuariosRoutes = require('../../interfaz/http/rutas/usuarios').default;
const authRoutes = require('../../interfaz/http/rutas/auth').default;
const { alInvalidarCuenta } = require('../../infraestructura/sesiones') as { alInvalidarCuenta: (fn: (id?: number) => void) => void };
/* eslint-enable @typescript-eslint/no-var-requires */

const sesion = (id: number, email: string, rol: string) =>
  `Bearer ${jwt.sign({ id, email, username: email, nombre: email, rol }, process.env.JWT_SECRET!)}`;
const ADMIN = sesion(1, 'admin@ecu911.gob.ec', 'Admin');
const GUARDIA = sesion(3, 'garita@ecu911.gob.ec', 'Guardia');

const invalidadas: (number | undefined)[] = [];
alInvalidarCuenta(id => invalidadas.push(id));

describe('API · usuarios (detalle y baja lógica)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/usuarios', usuariosRoutes);
  beforeEach(() => { reiniciar(); invalidadas.length = 0; });

  it('GET /:id responde la cuenta con el mismo formato que un elemento del listado', async () => {
    const lista = await request(app).get('/api/usuarios').set('Authorization', ADMIN).expect(200);
    const detalle = await request(app).get('/api/usuarios/7').set('Authorization', ADMIN).expect(200);
    expect(detalle.body).toEqual(lista.body.find((u: any) => u.id === 7));
    expect(Object.keys(detalle.body)).toEqual([
      'id', 'email', 'nombre_completo', 'cargo', 'rol', 'rol_nombre', 'estado', 'email_verificado', 'bloqueado',
      'bloqueo_temporal_hasta', 'intentos_fallidos', 'fecha_ultimo_acceso', 'fecha_creacion', 'creado_por',
    ]);
    expect(detalle.body).toMatchObject({ id: 7, rol: 'Guardia', email_verificado: true, bloqueado: false, creado_por: 'admin@ecu911.gob.ec' });
    expect(detalle.body).not.toHaveProperty('password_hash');
  });

  it('GET /:id → 404 si no existe y 400 si el identificador no es un entero positivo', async () => {
    expect((await request(app).get('/api/usuarios/99').set('Authorization', ADMIN).expect(404)).body).toEqual({ error: 'Usuario no encontrado.' });
    expect((await request(app).get('/api/usuarios/abc').set('Authorization', ADMIN).expect(400)).body).toEqual({ error: 'Identificador inválido.' });
    await request(app).put('/api/usuarios/0').set('Authorization', ADMIN).send({ rol: 'Admin' }).expect(400);
  });

  it('/roles y /auditoria no se confunden con /:id', async () => {
    const roles = await request(app).get('/api/usuarios/roles').set('Authorization', ADMIN).expect(200);
    expect(roles.body.map((r: any) => r.rol)).toEqual(['Admin']);
    expect(roles.body[0].permisos).toContain('usuarios:gestionar');
    const auditoria = await request(app).get('/api/usuarios/auditoria').set('Authorization', ADMIN).expect(200);
    expect(Object.keys(auditoria.body)).toEqual(['acciones', 'accesos']);
  });

  it('DELETE /:id: baja lógica con motivo, cierra las sesiones de la cuenta y la audita', async () => {
    const r = await request(app).delete('/api/usuarios/7').set('Authorization', ADMIN).send({ motivo: 'Fin de la relación laboral' }).expect(200);
    expect(r.body.message).toBe('Cuenta dada de baja.');
    expect(r.body.usuario).toMatchObject({ id: 7, estado: 'inactivo' });
    expect(invalidadas).toEqual([7]);
    expect(mockEscrituras.map(e => e.entradas)).toEqual([
      { id: 7 },
      expect.objectContaining({
        accion: 'USUARIO_DADO_DE_BAJA', actor: 1, actorEmail: 'admin@ecu911.gob.ec', objId: 7, objEmail: 'guardia@ecu911.gob.ec',
        detalle: 'estado activo → inactivo · Fin de la relación laboral',
      }),
    ]);
    // Una segunda baja de la misma cuenta es un conflicto
    const otra = await request(app).delete('/api/usuarios/7').set('Authorization', ADMIN).send({ motivo: 'Fin de la relación laboral' }).expect(409);
    expect(otra.body).toEqual({ error: 'La cuenta ya está dada de baja.' });
  });

  it('DELETE /:id: 403 sobre la propia cuenta, 400 sin motivo o con id inválido, 403 sin el permiso', async () => {
    const propia = await request(app).delete('/api/usuarios/1').set('Authorization', ADMIN).send({ motivo: 'Me retiro del sistema' }).expect(403);
    expect(propia.body).toEqual({ error: 'No puede dar de baja su propia cuenta.' });
    const sinMotivo = await request(app).delete('/api/usuarios/7').set('Authorization', ADMIN).expect(400);
    expect(sinMotivo.body).toEqual({ error: 'El campo «Motivo de la baja» es obligatorio.' });
    await request(app).delete('/api/usuarios/7').set('Authorization', ADMIN).send({ motivo: '<b>baja</b>' }).expect(400);
    await request(app).delete('/api/usuarios/x7').set('Authorization', ADMIN).send({ motivo: 'Fin de la relación laboral' }).expect(400);
    await request(app).delete('/api/usuarios/7').set('Authorization', GUARDIA).send({ motivo: 'Fin de la relación laboral' }).expect(403);
    await request(app).get('/api/usuarios/7').set('Authorization', GUARDIA).expect(403);
    expect(mockUsuarios.get(7)!.estado).toBe('activo');
    expect(mockEscrituras).toEqual([]);
    expect(invalidadas).toEqual([]);
  });
});

describe('API · autenticación (rechazos con código propio)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  beforeEach(reiniciar);

  it('bloqueo temporal → 423 con los minutos restantes', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: 'bloqueado@ecu911.gob.ec', password: CLAVE }).expect(423);
    expect(r.body).toEqual({ error: 'Cuenta bloqueada temporalmente por intentos fallidos. Intente en 10 min.' });
  });

  it('correo sin verificar → 403 con el código EMAIL_NO_VERIFICADO y acceso fallido auditado', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: 'pendiente@ecu911.gob.ec', password: CLAVE }).set('User-Agent', 'jest').expect(403);
    expect(r.body).toEqual({ error: 'Debe verificar su correo antes de ingresar.', codigo: 'EMAIL_NO_VERIFICADO' });
    expect(mockEscrituras.map(e => e.entradas)).toEqual([
      expect.objectContaining({ email: 'pendiente@ecu911.gob.ec', uid: 9, exito: false, motivo: 'no_verificado', ua: 'jest' }),
    ]);
  });

  it('enlace de verificación vencido → 410 con el código TOKEN_EXPIRADO', async () => {
    const r = await request(app).get(`/api/auth/verificar-email?token=${'a'.repeat(64)}`).expect(410);
    expect(r.body).toEqual({ error: 'El enlace expiró. Solicite uno nuevo desde el inicio de sesión.', codigo: 'TOKEN_EXPIRADO' });
  });

  it('recuperación de contraseña: respuesta genérica exista o no la cuenta', async () => {
    const generica = { message: 'Si el correo pertenece a una cuenta activa, recibirá un enlace para restablecer la contraseña.' };
    expect((await request(app).post('/api/auth/olvide-password').send({ email: 'nadie@ecu911.gob.ec' }).expect(200)).body).toEqual(generica);
    expect((await request(app).post('/api/auth/olvide-password').send({}).expect(200)).body).toEqual(generica);
  });

  it('GET /me: datos de la sesión con los permisos del rol vigente', async () => {
    const r = await request(app).get('/api/auth/me').set('Authorization', ADMIN).expect(200);
    expect(Object.keys(r.body.user)).toEqual([
      'id', 'email', 'username', 'nombre', 'cargo', 'rol', 'rol_nombre', 'permisos', 'fecha_ultimo_acceso', 'fecha_creacion',
    ]);
    expect(r.body.user).toMatchObject({ id: 1, username: 'admin@ecu911.gob.ec', nombre: 'Administradora Zonal', rol: 'Admin', rol_nombre: 'Administrador' });
  });
});
