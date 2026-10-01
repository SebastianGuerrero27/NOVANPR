import { API_URL } from '../services/api';
import type { EstadoValidacion } from './tipos';

const ZONA = 'America/Guayaquil';

const fFecha = new Intl.DateTimeFormat('es-EC', { timeZone: ZONA, day: '2-digit', month: 'short', year: 'numeric' });
const fFechaHora = new Intl.DateTimeFormat('es-EC', { timeZone: ZONA, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fHora = new Intl.DateTimeFormat('es-EC', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fDiaCorto = new Intl.DateTimeFormat('es-EC', { timeZone: ZONA, weekday: 'short', day: '2-digit' });
const fNumero = new Intl.NumberFormat('es-EC');

export const fecha = (v?: string | Date | null) => (v ? fFecha.format(new Date(v)) : '—');
export const fechaHora = (v?: string | Date | null) => (v ? fFechaHora.format(new Date(v)) : '—');
export const hora = (v?: string | Date | null) => (v ? fHora.format(new Date(v)) : '—');
export const diaCorto = (isoFecha: string) => fDiaCorto.format(new Date(`${isoFecha}T12:00:00-05:00`));
export const numero = (v?: number | null) => (v === null || v === undefined ? '—' : fNumero.format(v));
export const porcentaje = (v?: number | null, dec = 1) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(dec)} %`);

/** "hace 3 min", "hace 2 h", o la fecha si pasó más de un día. */
export function relativo(v?: string | Date | null): string {
  if (!v) return '—';
  const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
  if (s < 10) return 'ahora';
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return fechaHora(v);
}

/** Fecha local (Ecuador) en formato YYYY-MM-DD, para inputs de tipo date. */
export function fechaIsoLocal(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Convierte "YYYY-MM-DD" (día local) al instante ISO de inicio o fin de ese día en Ecuador. */
export function limiteDia(ymd: string, fin = false): string {
  return new Date(`${ymd}T${fin ? '23:59:59.999' : '00:00:00'}-05:00`).toISOString();
}

/** URL absoluta de una imagen de evidencia (el backend entrega rutas /media firmadas). */
export const urlMedia = (ruta?: string | null) => (ruta ? `${API_URL}${ruta}` : null);

export const ESTADOS: Record<EstadoValidacion, { etiqueta: string; corta: string; color: string }> = {
  autorizado: { etiqueta: 'Autorizado', corta: 'Autorizado', color: 'var(--autorizado)' },
  pendiente_revision: { etiqueta: 'Pendiente de revisión', corta: 'Pendiente', color: 'var(--pendiente)' },
  no_reconocido: { etiqueta: 'No registrado', corta: 'No registrado', color: 'var(--no-registrado-serie)' },
  alerta: { etiqueta: 'Alerta', corta: 'Alerta', color: 'var(--alerta)' },
};

/** Orden fijo de las series de estado en gráficos (validado para daltonismo). */
export const SERIES_ESTADO = [
  { clave: 'autorizados', etiqueta: 'Autorizados', color: '#15803d' },
  { clave: 'pendientes', etiqueta: 'Pendientes', color: '#2563eb' },
  { clave: 'no_registrados', etiqueta: 'No registrados', color: '#d97706' },
  { clave: 'alertas', etiqueta: 'Alertas', color: '#b91c1c' },
] as const;

export const NIVELES_ALERTA: Record<string, { etiqueta: string; clase: string }> = {
  CRITICA: { etiqueta: 'Crítica', clase: 'solido-alerta' },
  ALTA: { etiqueta: 'Alta', clase: 'alerta' },
  MEDIA: { etiqueta: 'Media', clase: 'no_reconocido' },
};

export const ROLES: Record<string, string> = { Admin: 'Administrador', Supervisor: 'Supervisor', Operador: 'Operador', GestorAccesos: 'Gestor de accesos' };

export const CATEGORIAS_PERMISO: Record<string, string> = {
  FUNCIONARIO: 'Funcionario', VISITANTE: 'Visitante', PROVEEDOR: 'Proveedor', CONTRATISTA: 'Contratista', OFICIAL: 'Vehículo oficial', EMERGENCIA: 'Emergencia',
};

export function iniciales(nombre?: string | null): string {
  return (nombre || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]!.toUpperCase()).join('');
}

export function descargarBlob(blob: Blob, nombre: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Nombre de archivo del encabezado Content-Disposition, o el indicado. */
export function nombreDescarga(cabecera: string | undefined, porDefecto: string): string {
  return cabecera?.match(/filename="?([^";]+)"?/)?.[1] ?? porDefecto;
}
