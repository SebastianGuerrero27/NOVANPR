import sql from 'mssql';
import { hoyLocalSql } from './tiempo';

/**
 * Cruce de placas leídas por OCR contra Lista Negra y Vehículos Autorizados.
 *
 * Las dos listas tienen costos de error opuestos, por eso usan criterios distintos:
 *   - Vehículos Autorizados: coincidencia EXACTA. Un error de OCR nunca debe conceder
 *     acceso (antes un LIKE por sufijo autorizaba "BA1234" como "PBA1234").
 *   - Lista Negra: coincidencia APROXIMADA. Un carácter mal leído no debe dejar pasar
 *     un vehículo buscado; las coincidencias no exactas se marcan como "aproximada"
 *     para que el operador las confirme.
 */

export { comparePlates, levenshtein, normalizePlate, type TipoCoincidencia } from '../../dominio/coincidenciaPlacas';
import { comparePlates, normalizePlate, type TipoCoincidencia } from '../../dominio/coincidenciaPlacas';

export interface BlacklistMatch {
  row: any;
  coincidencia: TipoCoincidencia;
}

/** Busca la placa en la lista de alertas vigente priorizando coincidencias exactas. */
export async function findBlacklistMatch(db: sql.ConnectionPool, placa: string): Promise<BlacklistMatch | null> {
  if (!normalizePlate(placa)) return null;
  const result = await db.request().query(`
    SELECT id, placa, motivo, nivel_alerta, fecha_registro, marca, modelo, color
    FROM ListaNegra
    WHERE activo = 1 AND (fecha_vencimiento IS NULL OR fecha_vencimiento >= ${hoyLocalSql()})
  `);

  let aproximada: BlacklistMatch | null = null;
  for (const row of result.recordset) {
    const tipo = comparePlates(placa, row.placa);
    if (tipo === 'exacta') return { row, coincidencia: 'exacta' };
    if (tipo === 'aproximada' && !aproximada) aproximada = { row, coincidencia: 'aproximada' };
  }
  return aproximada;
}

/**
 * Permiso de la placa en el padrón (registro activo, coincidencia EXACTA normalizada), sin
 * filtrar por fechas ni horario: la vigencia temporal la evalúa la política de acceso
 * (dominio/horario.ts → evaluarVigencia) para poder explicar POR QUÉ un permiso existente no
 * concede el paso (fuera de horario, aún no vigente o vencido).
 */
export async function findPermisoExacto(db: sql.ConnectionPool, placa: string): Promise<any | null> {
  const clean = normalizePlate(placa);
  if (!clean) return null;
  const result = await db.request()
    .input('placa', sql.VarChar(20), clean)
    .query(`
      SELECT TOP 1 id, placa, propietario, departamento, tipo_vehiculo, marca, modelo, color,
             categoria, fecha_inicio, fecha_vencimiento, horario, registrado_por
      FROM VehiculosAutorizados
      WHERE activo = 1 AND REPLACE(REPLACE(placa, '-', ''), ' ', '') = @placa
    `);
  return result.recordset[0] ?? null;
}
