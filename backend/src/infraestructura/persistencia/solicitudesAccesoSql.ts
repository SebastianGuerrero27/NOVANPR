import sql from 'mssql';
import { getDB } from '../db';
import { describirHorario, leerHorario } from '../../dominio/horario';
import type { DatosSolicitud } from '../../dominio/solicitudesAcceso';
import type { RepositorioSolicitudes, SolicitudDTO } from '../../aplicacion/solicitudesAcceso';

/** Repositorio SQL Server de las solicitudes de acceso (tabla SolicitudesAcceso). */

const SELECT = `
  SELECT s.*, us.nombre_completo AS solicitante_nombre, us.email AS solicitante_email,
         ur.nombre_completo AS resolutor_nombre,
         CAST(CASE WHEN EXISTS (SELECT 1 FROM ListaNegra l WHERE l.activo = 1
              AND REPLACE(REPLACE(l.placa, '-', ''), ' ', '') = s.placa) THEN 1 ELSE 0 END AS BIT) AS en_lista_alertas,
         (SELECT TOP 1 v.id FROM VehiculosAutorizados v WHERE v.activo = 1
              AND REPLACE(REPLACE(v.placa, '-', ''), ' ', '') = s.placa) AS permiso_actual_id
  FROM SolicitudesAcceso s
  JOIN Usuarios us ON us.id = s.solicitado_por
  LEFT JOIN Usuarios ur ON ur.id = s.resuelto_por`;

const fecha = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : null);

/** El horario se entrega interpretado (franjas y texto legible). */
function mapear(s: any): SolicitudDTO {
  return {
    id: s.id,
    placa: s.placa,
    propietario: s.propietario,
    departamento: s.departamento,
    categoria: s.categoria,
    motivo: s.motivo,
    vehiculo: { tipo: s.tipo_vehiculo, marca: s.marca, modelo: s.modelo, color: s.color },
    fecha_inicio: fecha(s.fecha_inicio),
    fecha_fin: fecha(s.fecha_fin),
    horario: leerHorario(s.horario),
    horario_texto: describirHorario(s.horario),
    deteccion_id: s.deteccion_id,
    estado: s.estado,
    solicitante: { id: s.solicitado_por, nombre: s.solicitante_nombre, email: s.solicitante_email },
    fecha_solicitud: s.fecha_solicitud,
    resolutor: s.resuelto_por ? { id: s.resuelto_por, nombre: s.resolutor_nombre } : null,
    fecha_resolucion: s.fecha_resolucion,
    comentario_resolucion: s.comentario_resolucion,
    vehiculo_autorizado_id: s.vehiculo_autorizado_id,
    en_lista_alertas: Boolean(s.en_lista_alertas),
    permiso_actual_id: s.permiso_actual_id ?? null,
    version: s.version,
  };
}

/** Columnas que se escriben en el alta y en la edición. */
function parametros(request: sql.Request, s: DatosSolicitud): sql.Request {
  const d = s.registro.datos;
  return request
    .input('placa', sql.VarChar(10), s.registro.placa)
    .input('propietario', sql.NVarChar(150), d.propietario)
    .input('departamento', sql.NVarChar(100), d.departamento)
    .input('categoria', sql.VarChar(20), d.categoria ?? 'VISITANTE')
    .input('motivo', sql.NVarChar(300), s.motivo)
    .input('tipo', sql.VarChar(50), d.tipo_vehiculo)
    .input('marca', sql.VarChar(50), d.marca)
    .input('modelo', sql.VarChar(50), d.modelo)
    .input('color', sql.VarChar(30), d.color)
    .input('inicio', sql.Date, s.registro.inicio)
    .input('fin', sql.Date, s.registro.vence)
    .input('horario', sql.NVarChar(600), s.registro.horario)
    .input('det', sql.Int, s.deteccionId);
}

/** Paso vehicular de origen solo si existe (si se eliminó, la solicitud queda sin vínculo). */
const DETECCION = '(SELECT id FROM DeteccionVehiculo WHERE id = @det)';

const db = () => getDB();

export const repositorioSolicitudesSql: RepositorioSolicitudes = {
  async listar({ usuarioId, soloPropias, vista }) {
    const filtros: string[] = [];
    if (soloPropias) filtros.push('s.solicitado_por = @uid');
    if (vista === 'pendiente') filtros.push(`s.estado = 'pendiente'`);
    else if (vista === 'resueltas') filtros.push(`s.estado <> 'pendiente'`);
    const r = await db().request().input('uid', sql.Int, usuarioId).query(`${SELECT} ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''}
      ORDER BY CASE WHEN s.estado = 'pendiente' THEN 0 ELSE 1 END, s.fecha_solicitud DESC
      OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY`);
    return r.recordset.map(mapear);
  },

  async contarPendientes(usuarioId, deOtros) {
    const r = await db().request().input('uid', sql.Int, usuarioId).query(`
      SELECT COUNT(*) AS n FROM SolicitudesAcceso
      WHERE estado = 'pendiente' ${deOtros ? 'AND solicitado_por <> @uid' : 'AND solicitado_por = @uid'}`);
    return Number(r.recordset[0].n);
  },

  async obtener(id) {
    const r = await db().request().input('id', sql.Int, id).query(`${SELECT} WHERE s.id = @id`);
    return r.recordset[0] ? mapear(r.recordset[0]) : null;
  },

  async pendienteConPlaca(placa, idExcluido) {
    const r = await db().request().input('placa', sql.VarChar(10), placa).input('excluir', sql.Int, idExcluido ?? null)
      .query(`SELECT TOP 1 id FROM SolicitudesAcceso
              WHERE placa = @placa AND estado = 'pendiente' AND (@excluir IS NULL OR id <> @excluir)`);
    return r.recordset[0]?.id ?? null;
  },

  async crear(s, usuarioId) {
    const ins = await parametros(db().request(), s).input('uid', sql.Int, usuarioId).query(`
      INSERT INTO SolicitudesAcceso (placa, propietario, departamento, categoria, motivo, tipo_vehiculo, marca, modelo, color,
                                     fecha_inicio, fecha_fin, horario, deteccion_id, solicitado_por)
      OUTPUT INSERTED.id
      VALUES (@placa, @propietario, @departamento, @categoria, @motivo, @tipo, @marca, @modelo, @color,
              @inicio, @fin, @horario, ${DETECCION}, @uid)`);
    return ins.recordset[0].id;
  },

  async actualizar(id, s, usuarioId) {
    const r = await parametros(db().request(), s).input('id', sql.Int, id).input('uid', sql.Int, usuarioId).query(`
      UPDATE SolicitudesAcceso
      SET placa = @placa, propietario = @propietario, departamento = @departamento, categoria = @categoria, motivo = @motivo,
          tipo_vehiculo = @tipo, marca = @marca, modelo = @modelo, color = @color,
          fecha_inicio = @inicio, fecha_fin = @fin, horario = @horario, deteccion_id = ${DETECCION}, version = version + 1
      WHERE id = @id AND estado = 'pendiente' AND solicitado_por = @uid`);
    return (r.rowsAffected[0] ?? 0) > 0;
  },

  async reclamar(id, usuarioId, estado, comentario, version) {
    const r = await db().request()
      .input('id', sql.Int, id).input('uid', sql.Int, usuarioId)
      .input('estado', sql.VarChar(20), estado).input('com', sql.NVarChar(300), comentario)
      .input('version', sql.Int, version ?? null)
      .query(`
        UPDATE SolicitudesAcceso SET estado = @estado, resuelto_por = @uid, fecha_resolucion = SYSDATETIME(), comentario_resolucion = @com
        OUTPUT INSERTED.placa, INSERTED.solicitado_por
        WHERE id = @id AND estado = 'pendiente' AND solicitado_por <> @uid AND (@version IS NULL OR version = @version)`);
    const f = r.recordset[0];
    return f ? { placa: f.placa, solicitado_por: f.solicitado_por } : null;
  },

  async liberar(id) {
    await db().request().input('id', sql.Int, id).query(`
      UPDATE SolicitudesAcceso SET estado = 'pendiente', resuelto_por = NULL, fecha_resolucion = NULL, comentario_resolucion = NULL
      WHERE id = @id`);
  },

  async vincularPermiso(id, permisoId) {
    await db().request().input('id', sql.Int, id).input('v', sql.Int, permisoId)
      .query('UPDATE SolicitudesAcceso SET vehiculo_autorizado_id = @v WHERE id = @id');
  },

  async cancelar(id, usuarioId) {
    const r = await db().request().input('id', sql.Int, id).input('uid', sql.Int, usuarioId).query(`
      UPDATE SolicitudesAcceso SET estado = 'cancelada', fecha_resolucion = SYSDATETIME()
      OUTPUT INSERTED.placa
      WHERE id = @id AND estado = 'pendiente' AND solicitado_por = @uid`);
    return r.recordset[0]?.placa ?? null;
  },
};
