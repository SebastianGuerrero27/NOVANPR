import sql, { PostgresRequest } from '../postgres';
import { getDB } from '../db';
import type { DatosCamara } from '../../dominio/camaras';
import type { RepositorioCamaras } from '../../aplicacion/camaras';

/** Repositorio PostgreSQL de las cámaras (tabla camaras). */

const SELECT = `
  SELECT c.*, (SELECT COUNT(*) FROM DeteccionVehiculo d WHERE d.camara_id = c.id) AS detecciones
  FROM Camaras c`;

const db = () => getDB();

/**
 * Parámetros del alta y la edición; la IP se recorta al largo de la columna (VARCHAR(45)). Las
 * URL llegan con la contraseña ya protegida (VARCHAR(512), migración v9).
 */
const conDatos = (request: PostgresRequest, c: DatosCamara) => request
  .input('nombre', sql.NVarChar(100), c.nombre)
  .input('ip', sql.VarChar(45), c.ip.substring(0, 45))
  .input('rtsp', sql.VarChar(512), c.rtsp)
  .input('vista', sql.VarChar(512), c.rtspVista)
  .input('ubicacion', sql.NVarChar(150), c.ubicacion)
  .input('direccion', sql.VarChar(10), c.direccion);

export const repositorioCamarasSql: RepositorioCamaras = {
  async listar() {
    return (await db().request().query(`${SELECT} ORDER BY c.nombre`)).recordset;
  },

  async obtener(id) {
    return (await db().request().input('id', sql.Int, id).query(`${SELECT} WHERE c.id = @id`)).recordset[0] ?? null;
  },

  async conexion(id) {
    const c = (await db().request().input('id', sql.Int, id)
      .query('SELECT id, nombre, ip, rtsp_url, rtsp_url_vista, activa, direccion, roi, exclusiones FROM Camaras WHERE id = @id')).recordset[0];
    return c ? { ...c, activa: Boolean(c.activa) } : null;
  },

  async habilitadas() {
    return (await db().request().query('SELECT id, nombre, rtsp_url, ip FROM Camaras WHERE activa = 1')).recordset;
  },

  async crear(c, usuarioId) {
    const r = await conDatos(db().request(), c).input('usuario', sql.Int, usuarioId)
      .query(`INSERT INTO Camaras (nombre, ip, rtsp_url, rtsp_url_vista, ubicacion, direccion, activa, estado, created_at, registrado_por)
              OUTPUT INSERTED.id VALUES (@nombre, @ip, @rtsp, @vista, @ubicacion, @direccion, TRUE, 'SIN_VERIFICAR', GETDATE(), @usuario)`);
    return r.recordset[0].id;
  },

  async actualizar(id, c) {
    await conDatos(db().request(), c).input('id', sql.Int, id)
      .query(`UPDATE Camaras SET nombre = @nombre, ip = @ip, rtsp_url = @rtsp, rtsp_url_vista = @vista, ubicacion = @ubicacion, direccion = @direccion,
                estado = CASE WHEN rtsp_url IS DISTINCT FROM CAST(@rtsp AS VARCHAR(512)) THEN 'SIN_VERIFICAR' ELSE estado END,
                fecha_actualizacion = SYSDATETIME()
              WHERE id = @id`);
  },

  async alternarActiva(id) {
    const r = await db().request().input('id', sql.Int, id).query(`
      UPDATE Camaras SET activa = NOT activa, fecha_actualizacion = SYSDATETIME()
      OUTPUT INSERTED.nombre, INSERTED.activa WHERE id = @id`);
    const c = r.recordset[0];
    return c ? { nombre: c.nombre, activa: Boolean(c.activa) } : null;
  },

  async fijarZonas(id, roi, exclusiones) {
    // Solo se actualizan las zonas indicadas (undefined = la guardada no cambia)
    const peticion = db().request().input('id', sql.Int, id);
    const columnas: string[] = [];
    if (roi !== undefined) {
      peticion.input('roi', sql.NVarChar(1000), roi ? JSON.stringify(roi) : null);
      columnas.push('roi = @roi');
    }
    if (exclusiones !== undefined) {
      peticion.input('exclusiones', sql.NVarChar(sql.MAX), exclusiones.length ? JSON.stringify(exclusiones) : null);
      columnas.push('exclusiones = @exclusiones');
    }
    const r = await peticion.query(`UPDATE Camaras SET ${[...columnas, 'fecha_actualizacion = SYSDATETIME()'].join(', ')}
      OUTPUT INSERTED.nombre WHERE id = @id`);
    return r.recordset[0]?.nombre ?? null;
  },

  async eliminar(id) {
    await db().request().input('id', sql.Int, id).query('DELETE FROM Camaras WHERE id = @id');
  },
};
