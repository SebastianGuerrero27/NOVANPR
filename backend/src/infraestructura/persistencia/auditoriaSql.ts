import sql, { PostgresRequest } from '../postgres';
import { getDB } from '../db';
import { CAMPOS_AUDITORIA, FUENTES_AUDITORIA, type FiltrosAuditoria, type FuenteAuditoria } from '../../dominio/auditoria';
import type { ConteoArchivado, RepositorioAuditoria } from '../../aplicacion/auditoria';

/** Repositorio PostgreSQL de auditoría con archivado transaccional de registros antiguos. */

interface TablaAuditoria {
  tabla: string;
  /** Tabla de archivo (migración v7) con las mismas columnas más fecha_archivado */
  archivo: string;
  /** Columnas resumidas del listado (contrato de GET /api/auditoria) */
  resumen: string;
  /** Columnas donde busca el texto `q` */
  busqueda: readonly string[];
}

const TABLAS: Record<FuenteAuditoria, TablaAuditoria> = {
  operaciones: {
    tabla: 'AuditoriaOperaciones', archivo: 'AuditoriaOperacionesArchivo',
    resumen: 'id, fecha, usuario_email AS actor, accion, entidad, entidad_id, detalle, ip',
    busqueda: ['usuario_email', 'accion', 'entidad', 'detalle'],
  },
  cuentas: {
    tabla: 'AuditoriaUsuarios', archivo: 'AuditoriaUsuariosArchivo',
    resumen: 'id, fecha, actor_email AS actor, accion, objetivo_email AS objetivo, detalle, ip',
    busqueda: ['actor_email', 'objetivo_email', 'accion', 'detalle'],
  },
  accesos: {
    tabla: 'AuditoriaAccesos', archivo: 'AuditoriaAccesosArchivo',
    resumen: 'id, fecha, email, exito, motivo, ip, user_agent',
    busqueda: ['email', 'motivo', 'ip'],
  },
};

/** Cláusula WHERE de los filtros y una fábrica de peticiones con sus parámetros (@q, @desde, @hasta). */
function filtrar(f: FiltrosAuditoria): { where: string; peticion: () => PostgresRequest } {
  const condiciones = ['1 = 1'];
  if (f.q) condiciones.push(`(${TABLAS[f.fuente].busqueda.map(c => `${c} LIKE @q`).join(' OR ')})`);
  if (f.desde) condiciones.push('fecha >= @desde');
  if (f.hasta) condiciones.push('fecha <= @hasta');
  if (f.fuente === 'accesos' && f.exito !== null) condiciones.push(`exito IS ${f.exito ? 'TRUE' : 'FALSE'}`);
  const peticion = () => {
    const r = getDB().request();
    if (f.q) r.input('q', sql.NVarChar(200), `%${f.q}%`);
    if (f.desde) r.input('desde', sql.DateTime2, f.desde);
    if (f.hasta) r.input('hasta', sql.DateTime2, f.hasta);
    return r;
  };
  return { where: condiciones.join(' AND '), peticion };
}

export const repositorioAuditoriaSql: RepositorioAuditoria = {
  async contar(f) {
    const { where, peticion } = filtrar(f);
    const r = await peticion().query(`SELECT COUNT(*) AS n FROM ${TABLAS[f.fuente].tabla} WHERE ${where}`);
    return Number(r.recordset[0]?.n ?? 0);
  },

  async pagina(f, desplazamiento, tamano) {
    const { tabla, resumen } = TABLAS[f.fuente];
    const { where, peticion } = filtrar(f);
    const r = await peticion().input('offset', sql.Int, desplazamiento).input('tamano', sql.Int, tamano)
      .query(`SELECT ${resumen} FROM ${tabla} WHERE ${where}
              ORDER BY fecha DESC LIMIT @tamano OFFSET @offset`);
    return r.recordset;
  },

  async completos(f, limite) {
    const { where, peticion } = filtrar(f);
    const r = await peticion().input('limite', sql.Int, limite)
      .query(`SELECT TOP (@limite) ${CAMPOS_AUDITORIA[f.fuente].join(', ')} FROM ${TABLAS[f.fuente].tabla}
              WHERE ${where} ORDER BY fecha DESC, id DESC`);
    return r.recordset;
  },

  async obtener(fuente, id) {
    const r = await getDB().request().input('id', sql.BigInt, id)
      .query(`SELECT ${CAMPOS_AUDITORIA[fuente].join(', ')} FROM ${TABLAS[fuente].tabla} WHERE id = @id`);
    return r.recordset[0] ?? null;
  },

  async archivar(dias): Promise<ConteoArchivado> {
    const client = await getDB().connect();
    await client.query('BEGIN');
    try {
      const corte = new Date(Date.now() - dias * 86400000);
      const resultado: Record<FuenteAuditoria, number> = { operaciones: 0, cuentas: 0, accesos: 0 };
      for (const fuente of FUENTES_AUDITORIA) {
        const { tabla, archivo } = TABLAS[fuente];
        const columnas = CAMPOS_AUDITORIA[fuente].join(', ');
        const r = await client.query(`WITH archivadas AS (
          INSERT INTO ${archivo} (${columnas}, fecha_archivado)
          SELECT ${columnas}, CURRENT_TIMESTAMP FROM ${tabla} WHERE fecha < $1
          ON CONFLICT (id) DO NOTHING RETURNING id
        ), eliminadas AS (
          DELETE FROM ${tabla} t USING archivadas a WHERE t.id = a.id RETURNING t.id
        ) SELECT COUNT(*) AS n FROM eliminadas`, [corte]);
        resultado[fuente] = Number(r.rows[0]?.n ?? 0);
      }
      await client.query('COMMIT');
      return { operaciones: resultado.operaciones, cuentas: resultado.cuentas, accesos: resultado.accesos };
    } catch (e) {
      // Cualquier error del lote o del commit revierte la copia y el borrado de las tres fuentes.
      // Si la conexión se perdió, el servidor ya revirtió la transacción al cerrar la sesión.
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally { client.release(); }
  },
};
