import sql from 'mssql';
import { getDB } from '../db';
import { ROL_POR_CODIGO } from '../../dominio/permisos';
import type { CuentaAcceso, CuentaPropia, RepositorioAuth } from '../../aplicacion/auth';
import { buscarEnlace, emitirEnlace, enlaceReciente } from './enlacesSql';

/**
 * Repositorio SQL Server de la autenticación: cuentas por correo, intentos de inicio de sesión,
 * configuración inicial, registro público, perfil propio y enlaces de un solo uso.
 */

const db = () => getDB();

/** Id de un rol por su código (los roles los crea la migración; sin ellos no hay cuentas). */
async function rolId(codigo: string): Promise<number> {
  const r = await db().request().input('c', sql.VarChar(20), codigo).query('SELECT id FROM Roles WHERE codigo = @c');
  if (!r.recordset.length) throw new Error(`Rol ${codigo} no existe (¿migración v2 aplicada?)`);
  return r.recordset[0].id;
}

function cuenta(u: any): CuentaAcceso {
  return {
    id: u.id,
    email: u.email,
    nombre_completo: u.nombre_completo,
    cargo: u.cargo ?? null,
    password_hash: u.password_hash,
    rol: ROL_POR_CODIGO[u.rol_codigo],
    estado: u.estado,
    email_verificado: Boolean(u.email_verificado),
    bloqueado: Boolean(u.bloqueado),
    bloqueado_hasta: u.bloqueado_hasta ?? null,
    intentos_fallidos: u.intentos_fallidos ?? 0,
  };
}

/** Datos de una cuenta que elige su propia contraseña (configuración inicial y registro público). */
const datosCuenta = (request: sql.Request, c: CuentaPropia, rol: number) => request
  .input('email', sql.NVarChar(150), c.email)
  .input('nombre', sql.NVarChar(150), c.nombre_completo)
  .input('cargo', sql.NVarChar(100), c.cargo)
  .input('hash', sql.VarChar(100), c.passwordHash)
  .input('rol', sql.Int, rol);

export const repositorioAuthSql: RepositorioAuth = {
  async hayAdministrador() {
    const r = await db().request().query(`
      SELECT COUNT(*) AS n FROM Usuarios u JOIN Roles r ON r.id = u.rol_id WHERE r.codigo = 'ADMIN'`);
    return r.recordset[0].n > 0;
  },

  async porEmail(email) {
    const r = await db().request().input('email', sql.NVarChar(150), email).query(`
      SELECT u.*, r.codigo AS rol_codigo, r.nombre AS rol_nombre
      FROM Usuarios u JOIN Roles r ON r.id = u.rol_id
      WHERE u.email = @email`);
    return r.recordset[0] ? cuenta(r.recordset[0]) : null;
  },

  async sesion(id) {
    const r = await db().request().input('id', sql.Int, id).query(`
      SELECT u.id, u.email, u.nombre_completo, u.cargo, u.estado, u.fecha_ultimo_acceso, u.fecha_creacion,
             r.codigo AS rol_codigo, r.nombre AS rol_nombre
      FROM Usuarios u JOIN Roles r ON r.id = u.rol_id WHERE u.id = @id`);
    const u = r.recordset[0];
    if (!u) return null;
    return {
      id: u.id, email: u.email, nombre_completo: u.nombre_completo, cargo: u.cargo, estado: u.estado,
      rol: ROL_POR_CODIGO[u.rol_codigo], rol_nombre: u.rol_nombre,
      fecha_ultimo_acceso: u.fecha_ultimo_acceso, fecha_creacion: u.fecha_creacion,
    };
  },

  async credenciales(id) {
    const r = await db().request().input('id', sql.Int, id)
      .query('SELECT id, email, nombre_completo, password_hash FROM Usuarios WHERE id = @id');
    return r.recordset[0] ?? null;
  },

  async crearPrimerAdministrador(c) {
    const tx = new sql.Transaction(db());
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {
      // Serializable: dos solicitudes simultáneas no pueden crear dos "primeros" administradores
      const existe = await new sql.Request(tx).query(`
        SELECT COUNT(*) AS n FROM Usuarios u WITH (UPDLOCK, HOLDLOCK)
        JOIN Roles r ON r.id = u.rol_id WHERE r.codigo = 'ADMIN'`);
      if (existe.recordset[0].n > 0) {
        await tx.rollback();
        return false;
      }
      await datosCuenta(new sql.Request(tx), c, await rolId('ADMIN'))
        .query(`INSERT INTO Usuarios (email, nombre_completo, cargo, password_hash, rol_id, estado, email_verificado, fecha_cambio_password)
                VALUES (@email, @nombre, @cargo, @hash, @rol, 'activo', 1, SYSDATETIME())`);
      await tx.commit();
      return true;
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw e;
    }
  },

  async registrar(c) {
    const ins = await datosCuenta(db().request(), c, await rolId('GUARDIA'))
      .query(`INSERT INTO Usuarios (email, nombre_completo, cargo, password_hash, rol_id, estado, email_verificado, fecha_cambio_password)
              OUTPUT INSERTED.id
              VALUES (@email, @nombre, @cargo, @hash, @rol, 'pendiente', 0, SYSDATETIME())`);
    return ins.recordset[0].id;
  },

  async registrarIntentoFallido(id, intentos, bloquear, minutos) {
    await db().request()
      .input('id', sql.Int, id)
      .input('intentos', sql.Int, intentos)
      .input('min', sql.Int, minutos)
      .input('bloquear', sql.Bit, bloquear)
      .query(`UPDATE Usuarios SET intentos_fallidos = @intentos,
                bloqueado_hasta = CASE WHEN @bloquear = 1 THEN DATEADD(MINUTE, @min, SYSDATETIME()) ELSE bloqueado_hasta END
              WHERE id = @id`);
  },

  async registrarAcceso(id) {
    await db().request().input('id', sql.Int, id).query(`
      UPDATE Usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, fecha_ultimo_acceso = SYSDATETIME() WHERE id = @id`);
  },

  async actualizarPerfil(id, p) {
    await db().request()
      .input('id', sql.Int, id)
      .input('nombre', sql.NVarChar(150), p.nombre_completo)
      .input('cargo', sql.NVarChar(100), p.cargo)
      .query('UPDATE Usuarios SET nombre_completo = @nombre, cargo = @cargo, fecha_actualizacion = SYSDATETIME() WHERE id = @id');
  },

  async cambiarPassword(id, passwordHash) {
    await db().request().input('id', sql.Int, id).input('hash', sql.VarChar(100), passwordHash).query(`
      UPDATE Usuarios SET password_hash = @hash, fecha_cambio_password = SYSDATETIME(), fecha_actualizacion = SYSDATETIME() WHERE id = @id`);
  },

  enlaceReciente,
  emitirEnlace,
  buscarEnlace,

  async confirmarCorreo(enlaceId, usuarioId) {
    await db().request().input('vid', sql.Int, enlaceId).input('uid', sql.Int, usuarioId).query(`
      UPDATE VerificacionEmail SET usado = 1, fecha_uso = SYSDATETIME() WHERE id = @vid;
      UPDATE Usuarios SET email_verificado = 1,
             estado = CASE WHEN estado = 'pendiente' THEN 'activo' ELSE estado END,
             fecha_actualizacion = SYSDATETIME()
      WHERE id = @uid;`);
  },

  async restablecerPassword(enlaceId, usuarioId, passwordHash) {
    await db().request()
      .input('tid', sql.Int, enlaceId)
      .input('uid', sql.Int, usuarioId)
      .input('hash', sql.VarChar(100), passwordHash)
      .query(`
        UPDATE RestablecimientoPassword SET usado = 1, fecha_uso = SYSDATETIME() WHERE id = @tid;
        UPDATE Usuarios SET password_hash = @hash, fecha_cambio_password = SYSDATETIME(), intentos_fallidos = 0,
               bloqueado_hasta = NULL, email_verificado = 1,
               estado = CASE WHEN estado = 'pendiente' THEN 'activo' ELSE estado END,
               fecha_actualizacion = SYSDATETIME()
        WHERE id = @uid;`);
  },
};
