import { type Validado, validarEntero } from './validacion';

/**
 * Auditoría (dominio puro): fuentes, filtros de consulta, exportación CSV y plazo de retención.
 *
 * La auditoría es de solo inserción (ISO/IEC 27001 A.8.15, OWASP ASVS V7, NIST SP 800-92): no
 * existe operación para editar ni borrar un registro. La retención tampoco borra evidencia:
 * traslada los registros más antiguos a tablas de archivo con las mismas columnas, en una sola
 * transacción, y deja constancia de cuántos movió.
 *
 *   operaciones  detecciones, listas, cámaras, solicitudes y configuración (AuditoriaOperaciones)
 *   cuentas      registro, verificación, altas, cambios de rol/estado, bloqueos (AuditoriaUsuarios)
 *   accesos      cada intento de inicio de sesión (AuditoriaAccesos)
 */

export const FUENTES_AUDITORIA = ['operaciones', 'cuentas', 'accesos'] as const;
export type FuenteAuditoria = typeof FUENTES_AUDITORIA[number];

export function esFuenteAuditoria(valor: unknown): valor is FuenteAuditoria {
  return typeof valor === 'string' && (FUENTES_AUDITORIA as readonly string[]).includes(valor);
}

/** Columnas completas de cada fuente (detalle y exportación), en el orden de la tabla. */
export const CAMPOS_AUDITORIA: Record<FuenteAuditoria, readonly string[]> = {
  operaciones: ['id', 'fecha', 'usuario_id', 'usuario_email', 'accion', 'entidad', 'entidad_id', 'detalle', 'ip'],
  cuentas: ['id', 'fecha', 'accion', 'actor_id', 'actor_email', 'objetivo_id', 'objetivo_email', 'detalle', 'ip'],
  accesos: ['id', 'fecha', 'email', 'usuario_id', 'exito', 'motivo', 'ip', 'user_agent'],
};

/** Máximo de registros por exportación (los más recientes que cumplen los filtros). */
export const MAX_FILAS_EXPORTACION = 50000;

/**
 * Plazo de retención en días: al menos un año de auditoría queda siempre en las tablas vivas
 * (consulta inmediata) y como máximo diez años antes de archivar.
 */
export const DIAS_RETENCION = { min: 365, max: 3650 } as const;

export interface FiltrosAuditoria {
  fuente: FuenteAuditoria;
  /** Texto a buscar (hasta 100 caracteres) */
  q: string | null;
  desde: Date | null;
  hasta: Date | null;
  /** Solo para la fuente accesos: true = exitosos, false = fallidos */
  exito: boolean | null;
}

const fechaFiltro = (v: unknown) => (v && !Number.isNaN(Date.parse(String(v))) ? new Date(String(v)) : null);

/**
 * Filtros del listado y de la exportación. Son criterios de búsqueda sobre consultas
 * parametrizadas, no datos que se guardan: un valor no reconocido se ignora (fuente por
 * omisión `operaciones`, fecha inválida sin filtro) y el texto se recorta a 100 caracteres.
 */
export function leerFiltrosAuditoria(consulta: Record<string, unknown>): FiltrosAuditoria {
  const fuente = esFuenteAuditoria(consulta.fuente) ? consulta.fuente : 'operaciones';
  const q = String(consulta.q ?? '').trim().substring(0, 100);
  const resultado = consulta.resultado;
  return {
    fuente,
    q: q || null,
    desde: fechaFiltro(consulta.desde),
    hasta: fechaFiltro(consulta.hasta),
    exito: fuente === 'accesos' && (resultado === 'exito' || resultado === 'fallo') ? resultado === 'exito' : null,
  };
}

/** Página (desde 1) y tamaño (10 a 100, por omisión 25) del listado. */
export function leerPaginacion(consulta: Record<string, unknown>): { pagina: number; tamano: number } {
  return {
    pagina: Math.trunc(Math.min(1_000_000, Math.max(1, Number(consulta.pagina) || 1))),
    tamano: Math.trunc(Math.min(100, Math.max(10, Number(consulta.tamano) || 25))),
  };
}

/** Días de antigüedad a partir de los cuales se archiva (entero entre 365 y 3650). */
export function validarDiasRetencion(valor: unknown): Validado<number> {
  const r = validarEntero(valor, { etiqueta: 'Días de retención', min: DIAS_RETENCION.min, max: DIAS_RETENCION.max, requerido: true });
  return r.ok ? { ok: true, valor: r.valor! } : r;
}

/** Identificador de un registro (BIGINT): entero positivo dentro del rango seguro de JavaScript. */
export function validarIdAuditoria(valor: unknown): Validado<number> {
  const r = validarEntero(valor, { etiqueta: 'Identificador', min: 1, max: Number.MAX_SAFE_INTEGER, requerido: true });
  return r.ok ? { ok: true, valor: r.valor! } : { ok: false, error: 'Identificador inválido.' };
}

// ─── Exportación CSV ─────────────────────────────────────────────────────────

/**
 * Inicio con el que una hoja de cálculo interpreta la celda como fórmula: = + - @ y también
 * tabulador o retorno de carro (OWASP, CSV Injection).
 */
const INICIO_FORMULA = /^[=+\-@\t\r]/;

/** Fechas en ISO 8601 (UTC, como en la API), booleanos true/false y vacío para null. */
function textoCelda(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? '' : valor.toISOString();
  return String(valor);
}

/**
 * Celda CSV (RFC 4180) a prueba de inyección de fórmulas: si empieza como una fórmula se le
 * antepone un apóstrofo para que Excel o LibreOffice la muestren como texto en lugar de
 * ejecutarla; siempre va entre comillas, con las comillas internas duplicadas (así las comas
 * y los saltos de línea del detalle no rompen la fila).
 */
export function celdaCsv(valor: unknown): string {
  let texto = textoCelda(valor);
  if (INICIO_FORMULA.test(texto)) texto = `'${texto}`;
  return `"${texto.replace(/"/g, '""')}"`;
}

/** Documento CSV: encabezado con los nombres de columna y una línea CRLF por registro. */
export function generarCsv(columnas: readonly string[], filas: readonly Record<string, unknown>[]): string {
  const lineas = [columnas.map(celdaCsv).join(',')];
  for (const fila of filas) lineas.push(columnas.map(c => celdaCsv(fila[c])).join(','));
  return `${lineas.join('\r\n')}\r\n`;
}
