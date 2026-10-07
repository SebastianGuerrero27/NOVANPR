import sql from 'mssql';
import { getDB } from '../db';
import { CAMPOS_AUDITORIA, FUENTES_AUDITORIA, type FiltrosAuditoria, type FuenteAuditoria } from '../../dominio/auditoria';
import type { ConteoArchivado, RepositorioAuditoria } from '../../aplicacion/auditoria';

/**
 * Repositorio SQL Server de la auditoría (AuditoriaOperaciones, AuditoriaUsuarios y
 * AuditoriaAccesos). Solo consulta y traslada al archivo: no existe UPDATE, y el único DELETE
 * está dentro de la transacción de retención, que elimina exactamente lo que acaba de copiar.
 */

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
function filtrar(f: FiltrosAuditoria): { where: string; peticion: () => sql.Request } {
  const condiciones = ['1 = 1'];
  if (f.q) condiciones.push(`(${TABLAS[f.fuente].busqueda.map(c => `${c} LIKE @q`).join(' OR ')})`);
  if (f.desde) condiciones.push('fecha >= @desde');
  if (f.hasta) condiciones.push('fecha <= @hasta');
  if (f.fuente === 'accesos' && f.exito !== null) condiciones.push(`exito = ${f.exito ? 1 : 0}`);
  const peticion = () => {
    const r = getDB().request();
    if (f.q) r.input('q', sql.NVarChar(200), `%${f.q}%`);
    if (f.desde) r.input('desde', sql.DateTime2, f.desde);
    if (f.hasta) r.input('hasta', sql.DateTime2, f.hasta);
    return r;
  };
  return { where: condiciones.join(' AND '), peticion };
}

/**
 * Traslado de una fuente al archivo: copia, elimina solo las filas cuyo id ya está en el archivo
 * y comprueba que se eliminó exactamente lo copiado; si no coincide, THROW revierte todo.
 */
function trasladar(fuente: FuenteAuditoria): string {
  const { tabla, archivo } = TABLAS[fuente];
  const columnas = CAMPOS_AUDITORIA[fuente].join(', ');
  return `
    INSERT INTO ${archivo} (${columnas})
    SELECT ${columnas} FROM ${tabla} WHERE fecha < @corte;
    SET @${fuente} = @@ROWCOUNT;
    DELETE t FROM ${tabla} t
    WHERE t.fecha < @corte AND EXISTS (SELECT 1 FROM ${archivo} a WHERE a.id = t.id);
    IF @@ROWCOUNT <> @${fuente} THROW 50001, N'Retención de ${tabla}: lo eliminado no coincide con lo archivado.', 1;`;
}

/**
 * Lote de la retención (parámetro @dias), que archivar() ejecuta dentro de su transacción: las
 * tres fuentes con el mismo corte. El primer error salta al CATCH, que lo devuelve sin ejecutar
 * nada más, y archivar() revierte la transacción completa. No usa SET XACT_ABORT ON: el pool de
 * mssql reutiliza las conexiones sin reiniciarlas y la opción seguiría activa en las consultas
 * siguientes de esa conexión. Exportado para verificar su forma en las pruebas.
 */
export const LOTE_RETENCION = `
  DECLARE @corte DATETIME2 = DATEADD(DAY, -@dias, SYSDATETIME());
  DECLARE ${FUENTES_AUDITORIA.map(f => `@${f} INT = 0`).join(', ')};
  BEGIN TRY
  ${FUENTES_AUDITORIA.map(trasladar).join('\n')}
  END TRY
  BEGIN CATCH
    THROW;
  END CATCH;
  SELECT ${FUENTES_AUDITORIA.map(f => `@${f} AS ${f}`).join(', ')};`;

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
              ORDER BY fecha DESC OFFSET @offset ROWS FETCH NEXT @tamano ROWS ONLY`);
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
    const tx = new sql.Transaction(getDB());
    await tx.begin();
    try {
      const r = await new sql.Request(tx).input('dias', sql.Int, dias).query(LOTE_RETENCION);
      await tx.commit();
      const f = r.recordset[0];
      return { operaciones: Number(f.operaciones), cuentas: Number(f.cuentas), accesos: Number(f.accesos) };
    } catch (e) {
      // Cualquier error del lote o del commit revierte la copia y el borrado de las tres fuentes.
      // Si la conexión se perdió, el servidor ya revirtió la transacción al cerrar la sesión.
      await tx.rollback().catch(() => undefined);
      throw e;
    }
  },
};
