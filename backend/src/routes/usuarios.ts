import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware, CODIGO_POR_ROL, invalidarCuenta, requierePermiso, Rol, ROL_POR_CODIGO } from '../middlewares/auth';
import { esRol, NOMBRE_ROL, permisosDe } from '../dominio/permisos';
import { emailService } from '../services/emailService';
import {
  auditarUsuario, generarToken, HORAS_CUENTA_NUEVA, MINUTOS_RESTABLECIMIENTO, normalizarEmail,
  urlFrontend, validarEmail, validarNombre,
} from '../services/seguridad';

/**
 * Administración de cuentas (permiso usuarios:gestionar). Toda acción queda en AuditoriaUsuarios.
 *
 *   GET    /api/usuarios                         listado
 *   GET    /api/usuarios/roles                   catálogo de roles
 *   POST   /api/usuarios                         crea cuenta y envía enlace para definir contraseña
 *   PUT    /api/usuarios/:id                     nombre, cargo, rol, estado
 *   POST   /api/usuarios/:id/bloquear            bloqueo administrativo
 *   POST   /api/usuarios/:id/desbloquear         quita bloqueos (administrativo y por intentos)
 *   POST   /api/usuarios/:id/restablecer-password envía enlace de restablecimiento
 *   GET    /api/usuarios/auditoria               acciones administrativas y accesos recientes
 */
const router = Router();
router.use(authMiddleware, requierePermiso('usuarios:gestionar'));


const SELECT_USUARIO = `
  SELECT u.id, u.email, u.nombre_completo, u.cargo, u.estado, u.email_verificado, u.bloqueado,
         u.bloqueado_hasta, u.intentos_fallidos, u.fecha_ultimo_acceso, u.fecha_creacion,
         r.codigo AS rol_codigo, r.nombre AS rol_nombre, c.email AS creado_por_email
  FROM Usuarios u
  JOIN Roles r ON r.id = u.rol_id
  LEFT JOIN Usuarios c ON c.id = u.creado_por`;

const mapear = (u: any) => ({
  id: u.id,
  email: u.email,
  nombre_completo: u.nombre_completo,
  cargo: u.cargo,
  rol: ROL_POR_CODIGO[u.rol_codigo],
  rol_nombre: u.rol_nombre,
  estado: u.estado,
  email_verificado: Boolean(u.email_verificado),
  bloqueado: Boolean(u.bloqueado),
  bloqueo_temporal_hasta: u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date() ? u.bloqueado_hasta : null,
  intentos_fallidos: u.intentos_fallidos,
  fecha_ultimo_acceso: u.fecha_ultimo_acceso,
  fecha_creacion: u.fecha_creacion,
  creado_por: u.creado_por_email,
});

async function obtener(db: sql.ConnectionPool, id: number) {
  const r = await db.request().input('id', sql.Int, id).query(`${SELECT_USUARIO} WHERE u.id = @id`);
  return r.recordset[0] ?? null;
}

async function administradoresActivos(db: sql.ConnectionPool): Promise<number> {
  const r = await db.request().query(`
    SELECT COUNT(*) AS n FROM Usuarios u JOIN Roles r ON r.id = u.rol_id
    WHERE r.codigo = 'ADMIN' AND u.estado = 'activo' AND u.bloqueado = 0`);
  return r.recordset[0].n;
}

const idParam = (req: Request) => Number.parseInt(req.params.id, 10);

router.get('/', async (_req: Request, res: Response) => {
  try {
    const r = await getDB().request().query(`${SELECT_USUARIO} ORDER BY u.fecha_creacion DESC`);
    return res.json(r.recordset.map(mapear));
  } catch (e: any) {
    console.error('[USUARIOS] listar:', e.message);
    return res.status(500).json({ error: 'No se pudo obtener la lista de usuarios.' });
  }
});

router.get('/roles', async (_req: Request, res: Response) => {
  const r = await getDB().request().query('SELECT codigo, nombre, descripcion FROM Roles ORDER BY id');
  return res.json(r.recordset.filter(x => ROL_POR_CODIGO[x.codigo])
    .map(x => ({ rol: ROL_POR_CODIGO[x.codigo], nombre: x.nombre, descripcion: x.descripcion, permisos: permisosDe(ROL_POR_CODIGO[x.codigo]) })));
});

router.post('/', async (req: Request, res: Response) => {
  const email = normalizarEmail(req.body?.email);
  const nombre = String(req.body?.nombre_completo ?? '').trim();
  const rol = req.body?.rol as Rol;
  const error = validarNombre(nombre) || validarEmail(email) || (esRol(rol) ? null : 'Rol inválido.');
  if (error) return res.status(400).json({ error });

  try {
    const db = getDB();
    const dup = await db.request().input('email', sql.NVarChar(150), email).query('SELECT id FROM Usuarios WHERE email = @email');
    if (dup.recordset.length) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });

    // Contraseña aleatoria inutilizable: el usuario define la suya con el enlace (el admin nunca la conoce)
    const hashInutil = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const ins = await db.request()
      .input('email', sql.NVarChar(150), email)
      .input('nombre', sql.NVarChar(150), nombre)
      .input('cargo', sql.NVarChar(100), String(req.body?.cargo ?? '').trim() || null)
      .input('hash', sql.VarChar(100), hashInutil)
      .input('rol', sql.VarChar(20), CODIGO_POR_ROL[rol])
      .input('creador', sql.Int, req.user!.id)
      .query(`INSERT INTO Usuarios (email, nombre_completo, cargo, password_hash, rol_id, estado, email_verificado, creado_por)
              OUTPUT INSERTED.id
              SELECT @email, @nombre, @cargo, @hash, id, 'activo', 1, @creador FROM Roles WHERE codigo = @rol`);
    const id = ins.recordset[0].id;

    const { token, hash } = generarToken();
    await db.request().input('uid', sql.Int, id).input('hash', sql.Char(64), hash).input('h', sql.Int, HORAS_CUENTA_NUEVA).query(`
      INSERT INTO RestablecimientoPassword (usuario_id, token_hash, fecha_expiracion) VALUES (@uid, @hash, DATEADD(HOUR, @h, SYSDATETIME()))`);
    const enviado = await emailService.definirPasswordCuentaNueva(
      email, nombre, `${urlFrontend()}/restablecer-password?token=${token}`, HORAS_CUENTA_NUEVA, NOMBRE_ROL[rol]);
    await auditarUsuario(db, req, 'USUARIO_CREADO', { id, email }, `Rol ${rol}`);
    return res.status(201).json({
      message: enviado
        ? 'Usuario creado. Se envió un correo para que defina su contraseña.'
        : 'Usuario creado, pero no se pudo enviar el correo. Use "Enviar enlace de contraseña".',
      usuario: mapear(await obtener(db, id)),
    });
  } catch (e: any) {
    console.error('[USUARIOS] crear:', e.message);
    return res.status(500).json({ error: 'No se pudo crear el usuario.' });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  const id = idParam(req);
  try {
    const db = getDB();
    const actual = await obtener(db, id);
    if (!actual) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const nombre = req.body?.nombre_completo !== undefined ? String(req.body.nombre_completo).trim() : actual.nombre_completo;
    const cargo = req.body?.cargo !== undefined ? String(req.body.cargo).trim() || null : actual.cargo;
    const rol: Rol = req.body?.rol ?? ROL_POR_CODIGO[actual.rol_codigo];
    const estado: string = req.body?.estado ?? actual.estado;
    const errorNombre = validarNombre(nombre);
    if (errorNombre) return res.status(400).json({ error: errorNombre });
    if (!esRol(rol)) return res.status(400).json({ error: 'Rol inválido.' });
    if (!['activo', 'inactivo', 'pendiente'].includes(estado)) return res.status(400).json({ error: 'Estado inválido.' });

    const pierdeAdmin = actual.rol_codigo === 'ADMIN' && (rol !== 'Admin' || estado !== 'activo');
    if (pierdeAdmin && id === req.user!.id) {
      return res.status(400).json({ error: 'No puede quitarse a sí mismo el rol de administrador ni desactivarse.' });
    }
    if (pierdeAdmin && (await administradoresActivos(db)) <= 1) {
      return res.status(400).json({ error: 'Debe existir al menos un administrador activo.' });
    }

    await db.request()
      .input('id', sql.Int, id)
      .input('nombre', sql.NVarChar(150), nombre)
      .input('cargo', sql.NVarChar(100), cargo)
      .input('rol', sql.VarChar(20), CODIGO_POR_ROL[rol])
      .input('estado', sql.VarChar(20), estado)
      .query(`UPDATE Usuarios SET nombre_completo = @nombre, cargo = @cargo, estado = @estado,
                rol_id = (SELECT id FROM Roles WHERE codigo = @rol), fecha_actualizacion = SYSDATETIME()
              WHERE id = @id`);

    invalidarCuenta(id);
    const cambios: string[] = [];
    if (rol !== ROL_POR_CODIGO[actual.rol_codigo]) cambios.push(`rol ${ROL_POR_CODIGO[actual.rol_codigo]} → ${rol}`);
    if (estado !== actual.estado) cambios.push(`estado ${actual.estado} → ${estado}`);
    if (nombre !== actual.nombre_completo || cargo !== actual.cargo) cambios.push('datos personales');
    await auditarUsuario(db, req, 'USUARIO_ACTUALIZADO', { id, email: actual.email }, cambios.join('; ') || 'sin cambios');
    return res.json({ message: 'Usuario actualizado.', usuario: mapear(await obtener(db, id)) });
  } catch (e: any) {
    console.error('[USUARIOS] actualizar:', e.message);
    return res.status(500).json({ error: 'No se pudo actualizar el usuario.' });
  }
});

router.post('/:id/bloquear', async (req: Request, res: Response) => {
  const id = idParam(req);
  try {
    const db = getDB();
    const u = await obtener(db, id);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado.' });
    if (id === req.user!.id) return res.status(400).json({ error: 'No puede bloquear su propia cuenta.' });
    if (u.rol_codigo === 'ADMIN' && (await administradoresActivos(db)) <= 1) {
      return res.status(400).json({ error: 'Debe existir al menos un administrador activo.' });
    }
    await db.request().input('id', sql.Int, id).query('UPDATE Usuarios SET bloqueado = 1, fecha_actualizacion = SYSDATETIME() WHERE id = @id');
    invalidarCuenta(id);
    await auditarUsuario(db, req, 'USUARIO_BLOQUEADO', { id, email: u.email }, String(req.body?.motivo ?? '').substring(0, 300) || undefined);
    return res.json({ message: 'Usuario bloqueado.', usuario: mapear(await obtener(db, id)) });
  } catch (e: any) {
    console.error('[USUARIOS] bloquear:', e.message);
    return res.status(500).json({ error: 'No se pudo bloquear el usuario.' });
  }
});

router.post('/:id/desbloquear', async (req: Request, res: Response) => {
  const id = idParam(req);
  try {
    const db = getDB();
    const u = await obtener(db, id);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado.' });
    await db.request().input('id', sql.Int, id).query(`
      UPDATE Usuarios SET bloqueado = 0, bloqueado_hasta = NULL, intentos_fallidos = 0, fecha_actualizacion = SYSDATETIME() WHERE id = @id`);
    invalidarCuenta(id);
    await auditarUsuario(db, req, 'USUARIO_DESBLOQUEADO', { id, email: u.email });
    return res.json({ message: 'Usuario desbloqueado.', usuario: mapear(await obtener(db, id)) });
  } catch (e: any) {
    console.error('[USUARIOS] desbloquear:', e.message);
    return res.status(500).json({ error: 'No se pudo desbloquear el usuario.' });
  }
});

router.post('/:id/restablecer-password', async (req: Request, res: Response) => {
  const id = idParam(req);
  try {
    const db = getDB();
    const u = await obtener(db, id);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado.' });
    const { token, hash } = generarToken();
    await db.request().input('uid', sql.Int, id).input('hash', sql.Char(64), hash).input('min', sql.Int, MINUTOS_RESTABLECIMIENTO).query(`
      UPDATE RestablecimientoPassword SET usado = 1 WHERE usuario_id = @uid AND usado = 0;
      INSERT INTO RestablecimientoPassword (usuario_id, token_hash, fecha_expiracion) VALUES (@uid, @hash, DATEADD(MINUTE, @min, SYSDATETIME()));`);
    const enviado = await emailService.restablecerPassword(
      u.email, u.nombre_completo, `${urlFrontend()}/restablecer-password?token=${token}`, MINUTOS_RESTABLECIMIENTO);
    await auditarUsuario(db, req, 'ENLACE_PASSWORD_ENVIADO', { id, email: u.email });
    return res.json({ message: enviado ? 'Enlace de restablecimiento enviado.' : 'No se pudo enviar el correo.' });
  } catch (e: any) {
    console.error('[USUARIOS] restablecer:', e.message);
    return res.status(500).json({ error: 'No se pudo generar el enlace.' });
  }
});

router.get('/auditoria', async (req: Request, res: Response) => {
  const limite = Math.min(500, Math.max(10, Number(req.query.limite) || 200));
  try {
    const db = getDB();
    const acciones = await db.request().input('n', sql.Int, limite).query(`
      SELECT TOP (@n) id, fecha, accion, actor_email, objetivo_email, detalle, ip FROM AuditoriaUsuarios ORDER BY fecha DESC`);
    const accesos = await db.request().input('n', sql.Int, limite).query(`
      SELECT TOP (@n) id, fecha, email, exito, motivo, ip, user_agent FROM AuditoriaAccesos ORDER BY fecha DESC`);
    return res.json({ acciones: acciones.recordset, accesos: accesos.recordset });
  } catch (e: any) {
    console.error('[USUARIOS] auditoría:', e.message);
    return res.status(500).json({ error: 'No se pudo obtener la auditoría.' });
  }
});

export default router;
