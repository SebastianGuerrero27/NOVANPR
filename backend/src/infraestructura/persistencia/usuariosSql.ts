import sql from 'mssql';
import { getDB } from '../db';
import { CODIGO_POR_ROL, ROL_POR_CODIGO } from '../../dominio/permisos';
import { bloqueoTemporalVigente, type EstadoCuenta } from '../../dominio/usuarios';
import type { RepositorioUsuarios, UsuarioDTO } from '../../aplicacion/usuarios';
import { emitirEnlace } from './enlacesSql';

/** Repositorio SQL Server de la administración de cuentas (tablas Usuarios y Roles, y la auditoría de cuentas). */

const SELECT_USUARIO = `
  SELECT u.id, u.email, u.nombre_completo, u.cargo, u.estado, u.email_verificado, u.bloqueado,
         u.bloqueado_hasta, u.intentos_fallidos, u.fecha_ultimo_acceso, u.fecha_creacion,
         r.codigo AS rol_codigo, r.nombre AS rol_nombre, c.email AS creado_por_email
  FROM Usuarios u
  JOIN Roles r ON r.id = u.rol_id
  LEFT JOIN Usuarios c ON c.id = u.creado_por`;

/** Formato de la API (listado y detalle): el bloqueo temporal se informa solo mientras está vigente. */
function mapear(u: any): UsuarioDTO {
  return {
    id: u.id,
    email: u.email,
    nombre_completo: u.nombre_completo,
    cargo: u.cargo,
    rol: ROL_POR_CODIGO[u.rol_codigo],
    rol_nombre: u.rol_nombre,
    estado: u.estado as EstadoCuenta,
    email_verificado: Boolean(u.email_verificado),
    bloqueado: Boolean(u.bloqueado),
    bloqueo_temporal_hasta: bloqueoTemporalVigente(u.bloqueado_hasta) ? u.bloqueado_hasta : null,
    intentos_fallidos: u.intentos_fallidos,
    fecha_ultimo_acceso: u.fecha_ultimo_acceso,
    fecha_creacion: u.fecha_creacion,
    creado_por: u.creado_por_email,
  };
}

const db = () => getDB();

export const repositorioUsuariosSql: RepositorioUsuarios = {
  async listar() {
    const r = await db().request().query(`${SELECT_USUARIO} ORDER BY u.fecha_creacion DESC`);
    return r.recordset.map(mapear);
  },

  async obtener(id) {
    const r = await db().request().input('id', sql.Int, id).query(`${SELECT_USUARIO} WHERE u.id = @id`);
    return r.recordset[0] ? mapear(r.recordset[0]) : null;
  },

  async roles() {
    const r = await db().request().query('SELECT codigo, nombre, descripcion FROM Roles ORDER BY id');
    return r.recordset.map(x => ({ rol: ROL_POR_CODIGO[x.codigo], nombre: x.nombre, descripcion: x.descripcion }));
  },

  async existeEmail(email) {
    const r = await db().request().input('email', sql.NVarChar(150), email).query('SELECT id FROM Usuarios WHERE email = @email');
    return r.recordset.length > 0;
  },

  async crear(c, creadorId) {
    const ins = await db().request()
      .input('email', sql.NVarChar(150), c.email)
      .input('nombre', sql.NVarChar(150), c.nombre_completo)
      .input('cargo', sql.NVarChar(100), c.cargo)
      .input('hash', sql.VarChar(100), c.passwordHash)
      .input('rol', sql.VarChar(20), CODIGO_POR_ROL[c.rol])
      .input('creador', sql.Int, creadorId)
      .query(`INSERT INTO Usuarios (email, nombre_completo, cargo, password_hash, rol_id, estado, email_verificado, creado_por)
              OUTPUT INSERTED.id
              SELECT @email, @nombre, @cargo, @hash, id, 'activo', 1, @creador FROM Roles WHERE codigo = @rol`);
    return ins.recordset[0].id;
  },

  async actualizar(id, c) {
    await db().request()
      .input('id', sql.Int, id)
      .input('nombre', sql.NVarChar(150), c.nombre_completo)
      .input('cargo', sql.NVarChar(100), c.cargo)
      .input('rol', sql.VarChar(20), CODIGO_POR_ROL[c.rol])
      .input('estado', sql.VarChar(20), c.estado)
      .query(`UPDATE Usuarios SET nombre_completo = @nombre, cargo = @cargo, estado = @estado,
                rol_id = (SELECT id FROM Roles WHERE codigo = @rol), fecha_actualizacion = SYSDATETIME()
              WHERE id = @id`);
  },

  async bloquear(id) {
    await db().request().input('id', sql.Int, id)
      .query('UPDATE Usuarios SET bloqueado = 1, fecha_actualizacion = SYSDATETIME() WHERE id = @id');
  },

  async desbloquear(id) {
    await db().request().input('id', sql.Int, id).query(`
      UPDATE Usuarios SET bloqueado = 0, bloqueado_hasta = NULL, intentos_fallidos = 0, fecha_actualizacion = SYSDATETIME() WHERE id = @id`);
  },

  async darDeBaja(id) {
    await db().request().input('id', sql.Int, id)
      .query("UPDATE Usuarios SET estado = 'inactivo', fecha_actualizacion = SYSDATETIME() WHERE id = @id");
  },

  async contarAdministradoresActivos() {
    const r = await db().request().query(`
      SELECT COUNT(*) AS n FROM Usuarios u JOIN Roles r ON r.id = u.rol_id
      WHERE r.codigo = 'ADMIN' AND u.estado = 'activo' AND u.bloqueado = 0`);
    // Sin fila (no debería ocurrir con COUNT) se asume cero: las reglas de continuidad rechazan la acción
    return r.recordset[0]?.n ?? 0;
  },

  emitirEnlaceRestablecimiento: (usuarioId, tokenHash, minutos) => emitirEnlace('restablecimiento', usuarioId, tokenHash, minutos),

  async auditoria(limite) {
    const acciones = await db().request().input('n', sql.Int, limite).query(`
      SELECT TOP (@n) id, fecha, accion, actor_email, objetivo_email, detalle, ip FROM AuditoriaUsuarios ORDER BY fecha DESC`);
    const accesos = await db().request().input('n', sql.Int, limite).query(`
      SELECT TOP (@n) id, fecha, email, exito, motivo, ip, user_agent FROM AuditoriaAccesos ORDER BY fecha DESC`);
    return { acciones: acciones.recordset, accesos: accesos.recordset };
  },
};
