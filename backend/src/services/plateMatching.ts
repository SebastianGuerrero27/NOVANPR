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

// Grupos de caracteres que el OCR confunde con frecuencia en placas.
const CONFUSION_GROUPS = ['0ODQ', '1IL', '8B', '5S', '2Z', '6G', '4A', '7T'];

const CANONICAL: Record<string, string> = {};
for (const group of CONFUSION_GROUPS) {
  for (const ch of group) CANONICAL[ch] = group[0];
}

export function normalizePlate(placa: string | null | undefined): string {
  return String(placa ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function canonicalize(placa: string): string {
  return Array.from(placa, (ch) => CANONICAL[ch] ?? ch).join('');
}

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export type TipoCoincidencia = 'exacta' | 'aproximada';

/**
 * Compara una lectura OCR con una placa registrada.
 * Retorna 'exacta', 'aproximada' (solo diferencias por homoglifos, o 1 edición en
 * placas de 6+ caracteres) o null si no coinciden.
 */
export function comparePlates(leida: string, registrada: string): TipoCoincidencia | null {
  const a = normalizePlate(leida);
  const b = normalizePlate(registrada);
  if (!a || !b) return null;
  if (a === b) return 'exacta';
  if (Math.min(a.length, b.length) < 5) return null;
  if (a.length === b.length && canonicalize(a) === canonicalize(b)) return 'aproximada';
  if (Math.min(a.length, b.length) >= 6 && levenshtein(canonicalize(a), canonicalize(b)) <= 1) {
    return 'aproximada';
  }
  return null;
}

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
             categoria, fecha_inicio, fecha_vencimiento, horario
      FROM VehiculosAutorizados
      WHERE activo = 1 AND REPLACE(REPLACE(placa, '-', ''), ' ', '') = @placa
    `);
  return result.recordset[0] ?? null;
}
