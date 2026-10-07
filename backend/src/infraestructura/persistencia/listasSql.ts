import sql from 'mssql';
import { getDB } from '../db';
import { describirHorario, leerHorario } from '../../dominio/horario';
import type { DefinicionLista, RegistroLista, TipoLista } from '../../dominio/listas';
import type { RegistroListaDTO, RepositorioListas } from '../../aplicacion/listas';
import { config } from '../servicios/configuracion';
import { hoyLocalSql } from '../servicios/tiempo';

/** Repositorio SQL Server de las listas de control (tablas VehiculosAutorizados y ListaNegra). */

const TABLA: Record<TipoLista, 'VehiculosAutorizados' | 'ListaNegra'> = { autorizados: 'VehiculosAutorizados', alertas: 'ListaNegra' };
const MISMA_PLACA = "REPLACE(REPLACE(placa, '-', ''), ' ', '') = @placa";

const columnasDe = (def: DefinicionLista) => [...def.campos.map(c => c.nombre), ...(def.temporal ? ['fecha_inicio', 'horario'] : [])];
const valorDe = (c: string) => (c === 'fecha_inicio' ? '@inicio' : `@${c}`);

function parametros(request: sql.Request, def: DefinicionLista, r: RegistroLista) {
  for (const c of def.campos) request.input(c.nombre, sql.NVarChar(c.max), r.datos[c.nombre]);
  request.input('placa', sql.VarChar(10), r.placa).input('vence', sql.Date, r.vence);
  if (def.temporal) request.input('inicio', sql.Date, r.inicio).input('horario', sql.NVarChar(600), r.horario);
}

function selectLista(def: DefinicionLista): string {
  const hoy = hoyLocalSql();
  const tabla = TABLA[def.tipo];
  return `
    SELECT t.*, u.email AS registrado_por_email,
           CAST(CASE WHEN t.fecha_vencimiento IS NULL OR t.fecha_vencimiento >= ${hoy} THEN 1 ELSE 0 END AS BIT) AS vigente,
           CAST(CASE WHEN t.fecha_vencimiento >= ${hoy}
                      AND t.fecha_vencimiento <= DATEADD(DAY, ${config.entero('aviso_vencimiento_dias')}, ${hoy}) THEN 1 ELSE 0 END AS BIT) AS por_vencer,
           ${def.temporal ? `CAST(CASE WHEN t.fecha_inicio > ${hoy} THEN 1 ELSE 0 END AS BIT)` : 'CAST(0 AS BIT)'} AS pendiente_inicio,
           (SELECT COUNT(*) FROM DeteccionVehiculo d
             WHERE ${tabla === 'ListaNegra' ? 'd.alerta_id' : 'd.vehiculo_autorizado_id'} = t.id) AS ingresos
    FROM ${tabla} t LEFT JOIN Usuarios u ON u.id = t.registrado_por`;
}

/** El horario se entrega interpretado (franjas y texto legible). */
function mapear(def: DefinicionLista, r: any): RegistroListaDTO {
  if (!def.temporal) return r;
  return { ...r, horario: leerHorario(r.horario), horario_texto: describirHorario(r.horario) };
}

const db = () => getDB();

export const repositorioListasSql: RepositorioListas = {
  async listar(def) {
    const r = await db().request().query(`${selectLista(def)} WHERE t.activo = 1 ORDER BY t.fecha_registro DESC`);
    return r.recordset.map(x => mapear(def, x));
  },

  async obtener(def, id) {
    const r = await db().request().input('id', sql.Int, id).query(`${selectLista(def)} WHERE t.id = @id`);
    return r.recordset[0] ? mapear(def, r.recordset[0]) : null;
  },

  async obtenerActivo(def, id) {
    const r = await db().request().input('id', sql.Int, id).query(`SELECT * FROM ${TABLA[def.tipo]} WHERE id = @id AND activo = 1`);
    return r.recordset[0] ?? null;
  },

  async buscarPorPlaca(def, placa) {
    const r = await db().request().input('placa', sql.VarChar(10), placa)
      .query(`SELECT id, activo FROM ${TABLA[def.tipo]} WHERE ${MISMA_PLACA}`);
    return r.recordset[0] ? { id: r.recordset[0].id, activo: Boolean(r.recordset[0].activo) } : null;
  },

  async existeOtraConPlaca(def, placa, idExcluido) {
    const r = await db().request().input('placa', sql.VarChar(10), placa).input('id', sql.Int, idExcluido)
      .query(`SELECT TOP 1 id FROM ${TABLA[def.tipo]} WHERE ${MISMA_PLACA} AND id <> @id`);
    return r.recordset.length > 0;
  },

  async crear(def, r, usuarioId, solicitudId) {
    const columnas = columnasDe(def);
    const request = db().request().input('usuario', sql.Int, usuarioId);
    parametros(request, def, r);
    const conSolicitud = def.temporal && solicitudId;
    if (conSolicitud) request.input('solicitud', sql.Int, solicitudId);
    const ins = await request.query(`
      INSERT INTO ${TABLA[def.tipo]} (placa, fecha_vencimiento, registrado_por, activo, fecha_registro, ${columnas.join(', ')}${conSolicitud ? ', solicitud_id' : ''})
      OUTPUT INSERTED.id
      VALUES (@placa, @vence, @usuario, 1, GETDATE(), ${columnas.map(valorDe).join(', ')}${conSolicitud ? ', @solicitud' : ''})`);
    return ins.recordset[0].id;
  },

  async reactivar(def, id, r, usuarioId, solicitudId) {
    const request = db().request().input('usuario', sql.Int, usuarioId).input('id', sql.Int, id);
    parametros(request, def, r);
    const conSolicitud = def.temporal && solicitudId;
    if (conSolicitud) request.input('solicitud', sql.Int, solicitudId);
    await request.query(`
      UPDATE ${TABLA[def.tipo]} SET activo = 1, placa = @placa, fecha_vencimiento = @vence, registrado_por = @usuario,
        fecha_registro = GETDATE(), fecha_actualizacion = SYSDATETIME(),
        ${columnasDe(def).map(c => `${c} = ${valorDe(c)}`).join(', ')}${conSolicitud ? ', solicitud_id = @solicitud' : ''}
      WHERE id = @id`);
  },

  async actualizar(def, id, r) {
    const request = db().request().input('id', sql.Int, id);
    parametros(request, def, r);
    await request.query(`
      UPDATE ${TABLA[def.tipo]} SET placa = @placa, fecha_vencimiento = @vence, fecha_actualizacion = SYSDATETIME(),
        ${columnasDe(def).map(c => `${c} = ${valorDe(c)}`).join(', ')}
      WHERE id = @id`);
  },

  async retirar(def, id) {
    const r = await db().request().input('id', sql.Int, id)
      .query(`UPDATE ${TABLA[def.tipo]} SET activo = 0, fecha_actualizacion = SYSDATETIME() OUTPUT DELETED.placa WHERE id = @id AND activo = 1`);
    return r.recordset[0]?.placa ?? null;
  },
};
