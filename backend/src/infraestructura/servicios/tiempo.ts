/**
 * Hora local de la institución. SQL Server guarda GETDATE() en UTC (contenedor), así que
 * "hoy" y las fechas de vencimiento se calculan con el desfase de la zona configurada
 * (Ecuador continental: UTC-5, sin horario de verano).
 */
export const ZONA_HORARIA = process.env.ZONA_HORARIA || 'America/Guayaquil';

/** Desfase en minutos de la zona (p. ej. -300 para UTC-5). */
export function desfaseMinutos(fecha = new Date()): number {
  const nombre = new Intl.DateTimeFormat('en-US', { timeZone: ZONA_HORARIA, timeZoneName: 'shortOffset' })
    .formatToParts(fecha).find(p => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = nombre.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/** Desfase en formato SQL Server ('-05:00') para SWITCHOFFSET. */
export function desfaseSql(): string { return String(ZONA_HORARIA); }

/** Fecha local de hoy como expresión SQL (para comparar con columnas DATE). */
export const hoyLocalSql = () => `(CURRENT_TIMESTAMP AT TIME ZONE '${desfaseSql()}')::date`;

/** Instante UTC en que empieza el día local que contiene `fecha`, desplazado `dias`. */
export function inicioDiaLocal(fecha = new Date(), dias = 0): Date {
  const d = desfaseMinutos(fecha);
  const local = new Date(fecha.getTime() + d * 60000);
  local.setUTCHours(0, 0, 0, 0);
  local.setUTCDate(local.getUTCDate() + dias);
  return new Date(local.getTime() - d * 60000);
}
