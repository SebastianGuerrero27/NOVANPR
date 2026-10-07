/**
 * Restricciones temporales de un permiso de placa (padrón de autorizados).
 *
 * Un permiso es válido en el instante t si se cumplen las tres condiciones:
 *   1. fecha_inicio ≤ día_local(t)            (o sin fecha de inicio)
 *   2. día_local(t) ≤ fecha_vencimiento       (o sin vencimiento)
 *   3. t pertenece a alguna franja horaria     (o sin franjas: 24/7)
 *
 * Es la versión para placas del RBAC temporal (TRBAC, Bertino et al., 2001): el permiso de
 * ingreso se habilita solo dentro de intervalos periódicos. Las franjas usan días ISO 8601
 * (1 = lunes … 7 = domingo) y admiten cruzar la medianoche (22:00–06:00 del lunes cubre
 * hasta las 06:00 del martes). Todo se evalúa en la zona horaria de la institución.
 *
 * Funciones puras: no tocan la base de datos (pruebas en src/tests/dominio/horario.test.ts).
 */

export interface Franja {
  /** Días ISO 8601 en que INICIA la franja (1 = lunes … 7 = domingo) */
  dias: number[];
  /** HH:MM (24 h) */
  desde: string;
  /** HH:MM (24 h). Si es menor o igual que `desde`, la franja termina al día siguiente. */
  hasta: string;
}

export type Horario = Franja[];

export type Vigencia = 'vigente' | 'no_iniciada' | 'vencida' | 'fuera_horario';

export interface PermisoTemporal {
  fecha_inicio?: Date | string | null;
  fecha_vencimiento?: Date | string | null;
  /** JSON almacenado en la base o el arreglo ya interpretado */
  horario?: string | Horario | null;
}

const MAX_FRANJAS = 7;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const NOMBRE_DIA = ['', 'L', 'M', 'X', 'J', 'V', 'S', 'D'];

const minutos = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Valida y normaliza un horario recibido por la API. Vacío o nulo = sin restricción (null).
 */
export function validarHorario(entrada: unknown): { horario: Horario | null; error?: string } {
  if (entrada === null || entrada === undefined || entrada === '') return { horario: null };
  let valor = entrada;
  if (typeof valor === 'string') {
    try { valor = JSON.parse(valor); } catch { return { horario: null, error: 'Horario inválido (JSON mal formado).' }; }
  }
  if (!Array.isArray(valor)) return { horario: null, error: 'El horario debe ser una lista de franjas.' };
  if (valor.length === 0) return { horario: null };
  if (valor.length > MAX_FRANJAS) return { horario: null, error: `Máximo ${MAX_FRANJAS} franjas horarias.` };
  const horario: Horario = [];
  for (const f of valor as any[]) {
    const dias: number[] = Array.isArray(f?.dias) ? [...new Set<number>(f.dias.map(Number))].sort((a, b) => a - b) : [];
    if (!dias.length || dias.some(d => !Number.isInteger(d) || d < 1 || d > 7)) {
      return { horario: null, error: 'Cada franja debe indicar al menos un día (1 = lunes … 7 = domingo).' };
    }
    const desde = String(f?.desde ?? '');
    const hasta = String(f?.hasta ?? '');
    if (!HHMM.test(desde) || !HHMM.test(hasta)) return { horario: null, error: 'Las horas deben tener el formato HH:MM (24 h).' };
    if (desde === hasta) return { horario: null, error: 'La hora de inicio y fin de una franja no pueden ser iguales.' };
    horario.push({ dias, desde, hasta });
  }
  return { horario };
}

/** Interpreta el valor almacenado (JSON) sin lanzar excepciones: un valor corrupto se ignora. */
export function leerHorario(valor: string | Horario | null | undefined): Horario | null {
  if (!valor) return null;
  const r = validarHorario(valor);
  return r.error ? null : r.horario;
}

/** Día ISO (1–7), minutos desde medianoche y fecha YYYY-MM-DD de un instante en una zona. */
export function tiempoLocal(fecha: Date, zona: string): { dia: number; minutos: number; ymd: string } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(fecha);
  const p = (t: string) => partes.find(x => x.type === t)?.value ?? '';
  const dia = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p('weekday')) + 1;
  return { dia, minutos: Number(p('hour')) * 60 + Number(p('minute')), ymd: `${p('year')}-${p('month')}-${p('day')}` };
}

/** ¿El instante cae dentro de alguna franja? Sin franjas = siempre. */
export function dentroDeHorario(horario: Horario | null | undefined, fecha: Date, zona: string): boolean {
  if (!horario || !horario.length) return true;
  const { dia, minutos: m } = tiempoLocal(fecha, zona);
  const ayer = dia === 1 ? 7 : dia - 1;
  return horario.some(f => {
    const ini = minutos(f.desde);
    const fin = minutos(f.hasta);
    if (ini < fin) return f.dias.includes(dia) && m >= ini && m < fin;
    // Cruza la medianoche: tramo de hoy desde `ini` o tramo de la madrugada iniciado ayer
    return (f.dias.includes(dia) && m >= ini) || (f.dias.includes(ayer) && m < fin);
  });
}

/** Fecha (DATE de SQL Server o 'YYYY-MM-DD') como 'YYYY-MM-DD'. */
function ymd(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
}

/** Estado temporal de un permiso en el instante `ahora`. */
export function evaluarVigencia(permiso: PermisoTemporal, ahora: Date, zona: string): Vigencia {
  const hoy = tiempoLocal(ahora, zona).ymd;
  const inicio = ymd(permiso.fecha_inicio);
  const fin = ymd(permiso.fecha_vencimiento);
  if (inicio && hoy < inicio) return 'no_iniciada';
  if (fin && hoy > fin) return 'vencida';
  if (!dentroDeHorario(leerHorario(permiso.horario), ahora, zona)) return 'fuera_horario';
  return 'vigente';
}

/** Rango compacto de días: [1,2,3,4,5] → "L–V", [1,3,5] → "L, X, V". */
function describirDias(dias: number[]): string {
  if (dias.length === 7) return 'Todos los días';
  const consecutivos = dias.every((d, i) => i === 0 || d === dias[i - 1] + 1);
  if (consecutivos && dias.length >= 3) return `${NOMBRE_DIA[dias[0]]}–${NOMBRE_DIA[dias[dias.length - 1]]}`;
  return dias.map(d => NOMBRE_DIA[d]).join(', ');
}

/** Texto legible del horario para avisos y reportes. */
export function describirHorario(valor: string | Horario | null | undefined): string {
  const h = leerHorario(valor);
  if (!h) return 'Sin restricción horaria';
  return h.map(f => `${describirDias(f.dias)} ${f.desde}–${f.hasta}`).join('; ');
}
