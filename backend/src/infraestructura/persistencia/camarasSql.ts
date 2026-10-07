import sql from 'mssql';
import { getDB } from '../db';
import type { DatosCamara } from '../../dominio/camaras';
import type { RepositorioCamaras } from '../../aplicacion/camaras';

/** Repositorio SQL Server de las cámaras (tabla Camaras). */

const SELECT = `
  SELECT c.*, (SELECT COUNT(*) FROM DeteccionVehiculo d WHERE d.camara_id = c.id) AS detecciones
  FROM Camaras c`;

const db = () => getDB();

/** Parámetros del alta y la edición; la IP se recorta al largo de la columna (VARCHAR(45)). */
const conDatos = (request: sql.Request, c: DatosCamara) => request
  .input('nombre', sql.NVarChar(100), c.nombre)
  .input('ip', sql.VarChar(45), c.ip.substring(0, 45))
  .input('rtsp', sql.VarChar(255), c.rtsp)
  .input('ubicacion', sql.NVarChar(150), c.ubicacion);

export const repositorioCamarasSql: RepositorioCamaras = {
  async listar() {
    return (await db().request().query(`${SELECT} ORDER BY c.nombre`)).recordset;
  },

  async obtener(id) {
    return (await db().request().input('id', sql.Int, id).query(`${SELECT} WHERE c.id = @id`)).recordset[0] ?? null;
  },

  async conexion(id) {
    const c = (await db().request().input('id', sql.Int, id)
      .query('SELECT id, nombre, ip, rtsp_url, activa FROM Camaras WHERE id = @id')).recordset[0];
    return c ? { ...c, activa: Boolean(c.activa) } : null;
  },

  async habilitadas() {
    return (await db().request().query('SELECT id, nombre, rtsp_url, ip FROM Camaras WHERE activa = 1')).recordset;
  },

  async crear(c, usuarioId) {
    const r = await conDatos(db().request(), c).input('usuario', sql.Int, usuarioId)
      .query(`INSERT INTO Camaras (nombre, ip, rtsp_url, ubicacion, activa, estado, created_at, registrado_por)
              OUTPUT INSERTED.id VALUES (@nombre, @ip, @rtsp, @ubicacion, 1, 'SIN_VERIFICAR', GETDATE(), @usuario)`);
    return r.recordset[0].id;
  },

  async actualizar(id, c) {
    await conDatos(db().request(), c).input('id', sql.Int, id)
      .query(`UPDATE Camaras SET nombre = @nombre, ip = @ip, rtsp_url = @rtsp, ubicacion = @ubicacion,
                estado = CASE WHEN rtsp_url <> @rtsp THEN 'SIN_VERIFICAR' ELSE estado END,
                fecha_actualizacion = SYSDATETIME()
              WHERE id = @id`);
  },

  async alternarActiva(id) {
    const r = await db().request().input('id', sql.Int, id).query(`
      UPDATE Camaras SET activa = CASE WHEN activa = 1 THEN 0 ELSE 1 END, fecha_actualizacion = SYSDATETIME()
      OUTPUT INSERTED.nombre, INSERTED.activa WHERE id = @id`);
    const c = r.recordset[0];
    return c ? { nombre: c.nombre, activa: Boolean(c.activa) } : null;
  },

  async fijarRoi(id, roi) {
    const r = await db().request().input('id', sql.Int, id).input('roi', sql.NVarChar(1000), roi ? JSON.stringify(roi) : null)
      .query('UPDATE Camaras SET roi = @roi, fecha_actualizacion = SYSDATETIME() OUTPUT INSERTED.nombre WHERE id = @id');
    return r.recordset[0]?.nombre ?? null;
  },

  async eliminar(id) {
    await db().request().input('id', sql.Int, id).query('DELETE FROM Camaras WHERE id = @id');
  },
};
