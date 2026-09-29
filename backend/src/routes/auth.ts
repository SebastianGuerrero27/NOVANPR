import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware, firmarToken, ROL_POR_CODIGO } from '../middlewares/auth';
import { emailService } from '../services/emailService';
import { config } from '../services/configuracion';
import {
  auditarAcceso, auditarUsuario, dominiosPermitidos, generarToken, hashToken, HORAS_VERIFICACION,
  maxIntentos, minutosBloqueo, MINUTOS_RESTABLECIMIENTO, normalizarEmail, urlFrontend,
  validarEmail, validarNombre, validarPassword,
} from '../services/seguridad';

/**
 * Autenticación y ciclo de vida de la cuenta.
 *
 *   GET  /api/auth/estado                  ¿falta la configuración inicial? ¿SMTP activo?
 *   POST /api/auth/configuracion-inicial   crea el PRIMER administrador (solo si no hay ninguno)
 *   POST /api/auth/login                   correo + contraseña (bloqueo temporal por intentos)
 *   POST /api/auth/registro                cuenta nueva (rol Operador) + correo de verificación
 *   GET  /api/auth/verificar-email         activa la cuenta con el token del correo
 *   POST /api/auth/reenviar-verificacion   nuevo enlace de verificación
 *   POST /api/auth/olvide-password         enlace de restablecimiento (respuesta siempre genérica)
 *   POST /api/auth/restablecer-password    define la nueva contraseña con el token
 *   GET  /api/auth/me                      datos de la sesión actual
 *   PUT  /api/auth/perfil                  nombre y cargo propios
 *   POST /api/auth/cambiar-password        cambio con la contraseña actual
 */
const router = Router();
const RONDAS_BCRYPT = Number(process.env.BCRYPT_ROUNDS ?? 12);
// Hash de una clave aleatoria: iguala el tiempo de respuesta cuando el correo no existe
const HASH_FICTICIO = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), RONDAS_BCRYPT);
const MENSAJE_GENERICO_RECUPERACION =
  'Si el correo pertenece a una cuenta activa, recibirá un enlace para restablecer la contraseña.';

async function usuarioPorEmail(db: sql.ConnectionPool, email: string) {
  const r = await db.request().input('email', sql.NVarChar(150), email).query(`
    SELECT u.*, r.codigo AS rol_codigo, r.nombre AS rol_nombre
    FROM Usuarios u JOIN Roles r ON r.id = u.rol_id
    WHERE u.email = @email`);
  return r.recordset[0] ?? null;
}

async function rolId(db: sql.ConnectionPool, codigo: string): Promise<number> {
  const r = await db.request().input('c', sql.VarChar(20), codigo).query('SELECT id FROM Roles WHERE codigo = @c');
  if (!r.recordset.length) throw new Error(`Rol ${codigo} no existe (¿migración v2 aplicada?)`);
  return r.recordset[0].id;
}

function respuestaSesion(u: any) {
  const rol = ROL_POR_CODIGO[u.rol_codigo];
  const token = firmarToken({ id: u.id, email: u.email, nombre: u.nombre_completo, rol });
  return {
    token,
    user: { id: u.id, email: u.email, username: u.email, nombre: u.nombre_completo, cargo: u.cargo, rol },
  };
}

async function hayAdministrador(db: sql.ConnectionPool): Promise<boolean> {
  const r = await db.request().query(`
    SELECT COUNT(*) AS n FROM Usuarios u JOIN Roles r ON r.id = u.rol_id WHERE r.codigo = 'ADMIN'`);
  return r.recordset[0].n > 0;
}

// ─────────────────────────────────────────────────────────────────────────────

router.get('/estado', async (_req: Request, res: Response) => {
  try {
    const db = getDB();
    return res.json({
      configuracion_inicial_requerida: !(await hayAdministrador(db)),
      registro_habilitado: config.booleano('registro_publico_habilitado'),
      smtp_configurado: emailService.smtpConfigurado(),
      dominios_permitidos: dominiosPermitidos(),
      unidad_institucional: config.texto('unidad_institucional'),
    });
  } catch (e: any) {
    console.error('[AUTH] estado:', e.message);
    return res.status(500).json({ error: 'No se pudo consultar el estado del sistema.' });
  }
});

router.post('/configuracion-inicial', async (req: Request, res: Response) => {
  const email = normalizarEmail(req.body?.email);
  const nombre = String(req.body?.nombre_completo ?? '').trim();
  const password = String(req.body?.password ?? '');
  const errorDatos = validarNombre(nombre) || validarEmail(email) || validarPassword(password);
  if (errorDatos) return res.status(400).json({ error: errorDatos });

  try {
    const db = getDB();
    const tx = new sql.Transaction(db);
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      // Serializable: dos solicitudes simultáneas no pueden crear dos "primeros" administradores
      const existe = await new sql.Request(tx).query(`
        SELECT COUNT(*) AS n FROM Usuarios u WITH (UPDLOCK, HOLDLOCK)
        JOIN Roles r ON r.id = u.rol_id WHERE r.codigo = 'ADMIN'`);
      if (existe.recordset[0].n > 0) {
        await tx.rollback();
        return res.status(409).json({ error: 'El sistema ya tiene un administrador. Inicie sesión.' });
      }
      const hash = await bcrypt.hash(password, RONDAS_BCRYPT);
      const idRol = await rolId(db, 'ADMIN');
      await new sql.Request(tx)
        .input('email', sql.NVarChar(150), email)
        .input('nombre', sql.NVarChar(150), nombre)
        .input('cargo', sql.NVarChar(100), String(req.body?.cargo ?? '').trim() || null)
        .input('hash', sql.VarChar(100), hash)
        .input('rol', sql.Int, idRol)
        .query(`INSERT INTO Usuarios (email, nombre_completo, cargo, password_hash, rol_id, estado, email_verificado, fecha_cambio_password)
                VALUES (@email, @nombre, @cargo, @hash, @rol, 'activo', 1, SYSDATETIME())`);
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw e;
    }
    const u = await usuarioPorEmail(db, email);
    await auditarUsuario(db, req, 'CONFIGURACION_INICIAL', { id: u.id, email }, 'Primer administrador del sistema');
    return res.status(201).json({ message: 'Administrador creado.', ...respuestaSesion(u) });
  } catch (e: any) {
    console.error('[AUTH] configuración inicial:', e.message);
    return res.status(500).json({ error: 'No se pudo crear el administrador.' });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  const email = normalizarEmail(req.body?.email ?? req.body?.username);
  const password = String(req.body?.password ?? '');
  if (!email || !password) return res.status(400).json({ error: 'Ingrese su correo y contraseña.' });

  try {
    const db = getDB();
    const u = await usuarioPorEmail(db, email);
    const credencialesInvalidas = () => res.status(401).json({ error: 'Correo o contraseña incorrectos.' });

    if (!u) {
      // Mismo costo de tiempo que con usuario existente (no revela qué correos existen)
      await bcrypt.compare(password, HASH_FICTICIO);
      await auditarAcceso(db, req, email, null, false, 'credenciales');
      return credencialesInvalidas();
    }

    if (u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date()) {
      const min = Math.ceil((new Date(u.bloqueado_hasta).getTime() - Date.now()) / 60000);
      await auditarAcceso(db, req, email, u.id, false, 'bloqueado');
      return res.status(423).json({ error: `Cuenta bloqueada temporalmente por intentos fallidos. Intente en ${min} min.` });
    }
    if (u.bloqueado) {
      await auditarAcceso(db, req, email, u.id, false, 'bloqueado');
      return res.status(403).json({ error: 'Cuenta bloqueada por un administrador.' });
    }

    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) {
      const intentos = u.intentos_fallidos + 1;
      const bloquear = intentos >= maxIntentos();
      await db.request()
        .input('id', sql.Int, u.id)
        .input('intentos', sql.Int, bloquear ? 0 : intentos)
        .input('min', sql.Int, minutosBloqueo())
        .input('bloquear', sql.Bit, bloquear)
        .query(`UPDATE Usuarios SET intentos_fallidos = @intentos,
                  bloqueado_hasta = CASE WHEN @bloquear = 1 THEN DATEADD(MINUTE, @min, SYSDATETIME()) ELSE bloqueado_hasta END
                WHERE id = @id`);
      await auditarAcceso(db, req, email, u.id, false, bloquear ? 'bloqueo_por_intentos' : 'credenciales');
      if (bloquear) {
        await emailService.cuentaBloqueada(u.email, u.nombre_completo, minutosBloqueo());
        return res.status(423).json({ error: `Demasiados intentos fallidos. Cuenta bloqueada ${minutosBloqueo()} minutos.` });
      }
      return credencialesInvalidas();
    }

    // Contraseña correcta: el estado se revela solo a quien conoce la contraseña
    if (u.estado === 'pendiente' || !u.email_verificado) {
      await auditarAcceso(db, req, email, u.id, false, 'no_verificado');
      return res.status(403).json({ error: 'Debe verificar su correo antes de ingresar.', codigo: 'EMAIL_NO_VERIFICADO' });
    }
    if (u.estado !== 'activo') {
      await auditarAcceso(db, req, email, u.id, false, 'inactivo');
      return res.status(403).json({ error: 'La cuenta está inactiva. Contacte al administrador.' });
    }

    await db.request().input('id', sql.Int, u.id).query(`
      UPDATE Usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, fecha_ultimo_acceso = SYSDATETIME() WHERE id = @id`);
    await auditarAcceso(db, req, email, u.id, true, 'ok');
    return res.json(respuestaSesion(u));
  } catch (e: any) {
    console.error('[AUTH] login:', e.message);
    return res.status(500).json({ error: 'Error interno al iniciar sesión.' });
  }
});

router.post('/registro', async (req: Request, res: Response) => {
  if (!config.booleano('registro_publico_habilitado')) {
    return res.status(403).json({ error: 'El registro público está deshabilitado. Solicite su cuenta al administrador.' });
  }
  const email = normalizarEmail(req.body?.email);
  const nombre = String(req.body?.nombre_completo ?? '').trim();
  const password = String(req.body?.password ?? '');
  const errorDatos = validarNombre(nombre) || validarEmail(email) || validarPassword(password);
  if (errorDatos) return res.status(400).json({ error: errorDatos });

  try {
    const db = getDB();
    if (await usuarioPorEmail(db, email)) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
    }
    const hash = await bcrypt.hash(password, RONDAS_BCRYPT);
    const ins = await db.request()
      .input('email', sql.NVarChar(150), email)
      .input('nombre', sql.NVarChar(150), nombre)
      .input('cargo', sql.NVarChar(100), String(req.body?.cargo ?? '').trim() || null)
      .input('hash', sql.VarChar(100), hash)
      .input('rol', sql.Int, await rolId(db, 'OPERADOR'))
      .query(`INSERT INTO Usuarios (email, nombre_completo, cargo, password_hash, rol_id, estado, email_verificado, fecha_cambio_password)
              OUTPUT INSERTED.id
              VALUES (@email, @nombre, @cargo, @hash, @rol, 'pendiente', 0, SYSDATETIME())`);
    const id = ins.recordset[0].id;

    const { token, hash: tokenHash } = generarToken();
    await db.request()
      .input('uid', sql.Int, id)
      .input('hash', sql.Char(64), tokenHash)
      .input('horas', sql.Int, HORAS_VERIFICACION)
      .query(`INSERT INTO VerificacionEmail (usuario_id, token_hash, fecha_expiracion)
              VALUES (@uid, @hash, DATEADD(HOUR, @horas, SYSDATETIME()))`);
    const enlace = `${urlFrontend()}/verificar-email?token=${token}`;
    const enviado = await emailService.verificacionCuenta(email, nombre, enlace, HORAS_VERIFICACION);
    await auditarUsuario(db, req, 'REGISTRO', { id, email }, 'Registro público; pendiente de verificación');

    return res.status(201).json({
      message: enviado
        ? 'Cuenta creada. Revise su correo y siga el enlace para activarla.'
        : 'Cuenta creada, pero no se pudo enviar el correo de verificación. Solicite un nuevo enlace.',
    });
  } catch (e: any) {
    console.error('[AUTH] registro:', e.message);
    return res.status(500).json({ error: 'No se pudo completar el registro.' });
  }
});

router.get('/verificar-email', async (req: Request, res: Response) => {
  const token = String(req.query.token ?? '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'Enlace de verificación inválido.' });
  try {
    const db = getDB();
    const r = await db.request().input('hash', sql.Char(64), hashToken(token)).query(`
      SELECT TOP 1 v.id, v.usuario_id, v.usado, v.fecha_expiracion, u.email, u.estado
      FROM VerificacionEmail v JOIN Usuarios u ON u.id = v.usuario_id
      WHERE v.token_hash = @hash`);
    const v = r.recordset[0];
    if (!v) return res.status(400).json({ error: 'Enlace de verificación inválido.' });
    if (v.usado) return res.json({ message: 'Su correo ya estaba verificado. Puede iniciar sesión.' });
    if (new Date(v.fecha_expiracion) < new Date()) {
      return res.status(410).json({ error: 'El enlace expiró. Solicite uno nuevo desde el inicio de sesión.', codigo: 'TOKEN_EXPIRADO' });
    }
    await db.request().input('vid', sql.Int, v.id).input('uid', sql.Int, v.usuario_id).query(`
      UPDATE VerificacionEmail SET usado = 1, fecha_uso = SYSDATETIME() WHERE id = @vid;
      UPDATE Usuarios SET email_verificado = 1,
             estado = CASE WHEN estado = 'pendiente' THEN 'activo' ELSE estado END,
             fecha_actualizacion = SYSDATETIME()
      WHERE id = @uid;`);
    await auditarUsuario(db, req, 'EMAIL_VERIFICADO', { id: v.usuario_id, email: v.email });
    return res.json({ message: 'Correo verificado. Su cuenta está activa: ya puede iniciar sesión.' });
  } catch (e: any) {
    console.error('[AUTH] verificar email:', e.message);
    return res.status(500).json({ error: 'No se pudo verificar el correo.' });
  }
});

router.post('/reenviar-verificacion', async (req: Request, res: Response) => {
  const email = normalizarEmail(req.body?.email);
  const generica = { message: 'Si la cuenta existe y está pendiente de verificación, recibirá un nuevo enlace.' };
  try {
    const db = getDB();
    const u = await usuarioPorEmail(db, email);
    if (!u || u.email_verificado) return res.json(generica);
    // Límite: un reenvío por minuto
    const reciente = await db.request().input('uid', sql.Int, u.id).query(`
      SELECT COUNT(*) AS n FROM VerificacionEmail WHERE usuario_id = @uid AND fecha_creacion > DATEADD(MINUTE, -1, SYSDATETIME())`);
    if (reciente.recordset[0].n > 0) return res.json(generica);

    const { token, hash } = generarToken();
    await db.request().input('uid', sql.Int, u.id).input('hash', sql.Char(64), hash).input('horas', sql.Int, HORAS_VERIFICACION).query(`
      UPDATE VerificacionEmail SET usado = 1 WHERE usuario_id = @uid AND usado = 0;
      INSERT INTO VerificacionEmail (usuario_id, token_hash, fecha_expiracion) VALUES (@uid, @hash, DATEADD(HOUR, @horas, SYSDATETIME()));`);
    await emailService.verificacionCuenta(u.email, u.nombre_completo, `${urlFrontend()}/verificar-email?token=${token}`, HORAS_VERIFICACION);
    return res.json(generica);
  } catch (e: any) {
    console.error('[AUTH] reenviar verificación:', e.message);
    return res.json(generica);
  }
});

router.post('/olvide-password', async (req: Request, res: Response) => {
  const email = normalizarEmail(req.body?.email);
  try {
    const db = getDB();
    const u = await usuarioPorEmail(db, email);
    if (u && u.estado === 'activo' && !u.bloqueado) {
      const reciente = await db.request().input('uid', sql.Int, u.id).query(`
        SELECT COUNT(*) AS n FROM RestablecimientoPassword WHERE usuario_id = @uid AND fecha_creacion > DATEADD(MINUTE, -1, SYSDATETIME())`);
      if (reciente.recordset[0].n === 0) {
        const { token, hash } = generarToken();
        await db.request().input('uid', sql.Int, u.id).input('hash', sql.Char(64), hash).input('min', sql.Int, MINUTOS_RESTABLECIMIENTO).query(`
          UPDATE RestablecimientoPassword SET usado = 1 WHERE usuario_id = @uid AND usado = 0;
          INSERT INTO RestablecimientoPassword (usuario_id, token_hash, fecha_expiracion) VALUES (@uid, @hash, DATEADD(MINUTE, @min, SYSDATETIME()));`);
        await emailService.restablecerPassword(u.email, u.nombre_completo, `${urlFrontend()}/restablecer-password?token=${token}`, MINUTOS_RESTABLECIMIENTO);
        await auditarUsuario(db, req, 'SOLICITUD_RESTABLECIMIENTO', { id: u.id, email: u.email });
      }
    }
  } catch (e: any) {
    console.error('[AUTH] olvidé contraseña:', e.message);
  }
  // Respuesta idéntica exista o no la cuenta (no permite descubrir correos registrados)
  return res.json({ message: MENSAJE_GENERICO_RECUPERACION });
});

router.post('/restablecer-password', async (req: Request, res: Response) => {
  const token = String(req.body?.token ?? '');
  const password = String(req.body?.password ?? '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'Enlace inválido.' });
  const errorPass = validarPassword(password);
  if (errorPass) return res.status(400).json({ error: errorPass });

  try {
    const db = getDB();
    const r = await db.request().input('hash', sql.Char(64), hashToken(token)).query(`
      SELECT TOP 1 t.id, t.usuario_id, t.usado, t.fecha_expiracion, u.email, u.nombre_completo
      FROM RestablecimientoPassword t JOIN Usuarios u ON u.id = t.usuario_id
      WHERE t.token_hash = @hash`);
    const t = r.recordset[0];
    if (!t || t.usado) return res.status(400).json({ error: 'El enlace ya fue usado o no es válido. Solicite uno nuevo.' });
    if (new Date(t.fecha_expiracion) < new Date()) return res.status(410).json({ error: 'El enlace expiró. Solicite uno nuevo.' });

    const nuevoHash = await bcrypt.hash(password, RONDAS_BCRYPT);
    await db.request().input('tid', sql.Int, t.id).input('uid', sql.Int, t.usuario_id).input('hash', sql.VarChar(100), nuevoHash).query(`
      UPDATE RestablecimientoPassword SET usado = 1, fecha_uso = SYSDATETIME() WHERE id = @tid;
      UPDATE Usuarios SET password_hash = @hash, fecha_cambio_password = SYSDATETIME(), intentos_fallidos = 0,
             bloqueado_hasta = NULL, email_verificado = 1,
             estado = CASE WHEN estado = 'pendiente' THEN 'activo' ELSE estado END,
             fecha_actualizacion = SYSDATETIME()
      WHERE id = @uid;`);
    await emailService.passwordCambiada(t.email, t.nombre_completo);
    await auditarUsuario(db, req, 'PASSWORD_RESTABLECIDA', { id: t.usuario_id, email: t.email });
    return res.json({ message: 'Contraseña actualizada. Ya puede iniciar sesión.' });
  } catch (e: any) {
    console.error('[AUTH] restablecer contraseña:', e.message);
    return res.status(500).json({ error: 'No se pudo restablecer la contraseña.' });
  }
});

router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const r = await getDB().request().input('id', sql.Int, req.user!.id).query(`
      SELECT u.id, u.email, u.nombre_completo, u.cargo, u.estado, u.fecha_ultimo_acceso, u.fecha_creacion,
             r.codigo AS rol_codigo, r.nombre AS rol_nombre
      FROM Usuarios u JOIN Roles r ON r.id = u.rol_id WHERE u.id = @id`);
    const u = r.recordset[0];
    if (!u || u.estado !== 'activo') return res.status(401).json({ error: 'La cuenta ya no está activa.' });
    return res.json({
      user: {
        id: u.id, email: u.email, username: u.email, nombre: u.nombre_completo, cargo: u.cargo,
        rol: ROL_POR_CODIGO[u.rol_codigo], rol_nombre: u.rol_nombre,
        fecha_ultimo_acceso: u.fecha_ultimo_acceso, fecha_creacion: u.fecha_creacion,
      },
    });
  } catch (e: any) {
    console.error('[AUTH] me:', e.message);
    return res.status(500).json({ error: 'No se pudo obtener la sesión.' });
  }
});

/** Datos propios editables por el usuario (nombre y cargo). El correo y el rol los gestiona el administrador. */
router.put('/perfil', authMiddleware, async (req: Request, res: Response) => {
  const nombre = String(req.body?.nombre_completo ?? '').trim();
  const cargo = String(req.body?.cargo ?? '').trim() || null;
  const errorNombre = validarNombre(nombre);
  if (errorNombre) return res.status(400).json({ error: errorNombre });
  if (cargo && cargo.length > 100) return res.status(400).json({ error: 'El cargo admite hasta 100 caracteres.' });
  try {
    const db = getDB();
    await db.request()
      .input('id', sql.Int, req.user!.id)
      .input('nombre', sql.NVarChar(150), nombre)
      .input('cargo', sql.NVarChar(100), cargo)
      .query('UPDATE Usuarios SET nombre_completo = @nombre, cargo = @cargo, fecha_actualizacion = SYSDATETIME() WHERE id = @id');
    await auditarUsuario(db, req, 'PERFIL_ACTUALIZADO', { id: req.user!.id, email: req.user!.email });
    return res.json({ message: 'Perfil actualizado.' });
  } catch (e: any) {
    console.error('[AUTH] perfil:', e.message);
    return res.status(500).json({ error: 'No se pudo actualizar el perfil.' });
  }
});

router.post('/cambiar-password', authMiddleware, async (req: Request, res: Response) => {
  const actual = String(req.body?.actual ?? '');
  const nueva = String(req.body?.nueva ?? '');
  const errorPass = validarPassword(nueva);
  if (errorPass) return res.status(400).json({ error: errorPass });
  if (actual === nueva) return res.status(400).json({ error: 'La nueva contraseña debe ser distinta de la actual.' });
  try {
    const db = getDB();
    const r = await db.request().input('id', sql.Int, req.user!.id).query('SELECT id, email, nombre_completo, password_hash FROM Usuarios WHERE id = @id');
    const u = r.recordset[0];
    if (!u || !(await bcrypt.compare(actual, u.password_hash))) {
      return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
    }
    await db.request().input('id', sql.Int, u.id).input('hash', sql.VarChar(100), await bcrypt.hash(nueva, RONDAS_BCRYPT)).query(`
      UPDATE Usuarios SET password_hash = @hash, fecha_cambio_password = SYSDATETIME(), fecha_actualizacion = SYSDATETIME() WHERE id = @id`);
    await emailService.passwordCambiada(u.email, u.nombre_completo);
    await auditarUsuario(db, req, 'PASSWORD_CAMBIADA', { id: u.id, email: u.email });
    return res.json({ message: 'Contraseña actualizada.' });
  } catch (e: any) {
    console.error('[AUTH] cambiar contraseña:', e.message);
    return res.status(500).json({ error: 'No se pudo cambiar la contraseña.' });
  }
});

export default router;
