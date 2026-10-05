import sql from 'mssql';
import { getDB } from '../db';
import type { RepositorioPropietario } from '../../aplicacion/propietario';

/** Repositorio SQL Server de las consultas de propietario (tabla AuditoriaConsultaPropietario, solo inserción). */
export const repositorioPropietarioSql: RepositorioPropietario = {
  async consultasUltimaHora(usuarioId) {
    const r = await getDB().request().input('uid', sql.Int, usuarioId)
      .query('SELECT COUNT(*) AS n FROM AuditoriaConsultaPropietario WHERE usuario_id = @uid AND fecha >= DATEADD(HOUR, -1, GETDATE())');
    return Number(r.recordset[0]?.n ?? 0);
  },

  async registrar(c) {
    await getDB().request()
      .input('uid', sql.Int, c.actor.id)
      .input('unom', sql.VarChar(100), c.actor.nombre ?? null)
      .input('placa', sql.VarChar(20), c.placa)
      .input('motivo', sql.VarChar(255), c.motivo)
      .input('det', sql.Int, c.deteccionId)
      .input('prov', sql.VarChar(50), c.proveedor)
      .input('res', sql.VarChar(20), c.resultado)
      .query(`
        INSERT INTO AuditoriaConsultaPropietario (usuario_id, usuario_nombre, placa, motivo, deteccion_id, proveedor, resultado)
        VALUES (@uid, @unom, @placa, @motivo, @det, @prov, @res)
      `);
  },

  async recientes() {
    const r = await getDB().request().query(`
      SELECT TOP 200 id, usuario_nombre, placa, motivo, deteccion_id, proveedor, resultado, fecha
      FROM AuditoriaConsultaPropietario ORDER BY fecha DESC
    `);
    return r.recordset;
  },
};
