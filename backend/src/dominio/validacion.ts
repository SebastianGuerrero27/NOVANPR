/**
 * Reglas de validación de los datos que registra una persona (dominio puro, sin E/S).
 *
 * Es la única fuente de verdad de los formatos: la API las aplica en cada alta o edición y el
 * frontend replica las mismas expresiones (frontend/src/dominio/validacion.ts) para avisar antes de
 * enviar. Las lecturas automáticas del motor ANPR NO se validan con estas reglas: la cámara
 * informa lo que lee y el cruce con las listas tolera los errores típicos del OCR.
 *
 * Placas (formato vigente de la ANT, Ecuador):
 *   - Automóviles: 3 letras + 4 números      ABC1234  (se muestra ABC-1234)
 *   - Motocicletas: 2 letras + 3 números + 1 letra   AB123C   (se muestra AB-123C)
 */

export type Validado<T> = { ok: true; valor: T } | { ok: false; error: string };

const ok = <T>(valor: T): Validado<T> => ({ ok: true, valor });

/** Vacío (undefined/null) o escalar (texto o número). Rechaza arreglos y objetos: String([3]) === '3'. */
const esEscalar = (valor: unknown) => valor === undefined || valor === null || typeof valor === 'string' || typeof valor === 'number';
const error = <T>(mensaje: string): Validado<T> => ({ ok: false, error: mensaje });

// ─── Placa ───────────────────────────────────────────────────────────────────

export type TipoPlaca = 'auto' | 'moto';
export const FORMATO_PLACA = 'ABC-1234 (automóvil) o AB-123C (motocicleta)';
export const RE_PLACA_AUTO = /^[A-Z]{3}\d{4}$/;
export const RE_PLACA_MOTO = /^[A-Z]{2}\d{3}[A-Z]$/;

/** Mayúsculas y sin separadores: "abc-1234" → "ABC1234". */
export function normalizarPlaca(valor: unknown): string {
  return String(valor ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function tipoPlaca(placa: string): TipoPlaca | null {
  if (RE_PLACA_AUTO.test(placa)) return 'auto';
  if (RE_PLACA_MOTO.test(placa)) return 'moto';
  return null;
}

/** Placa ingresada por una persona: normalizada y con formato de automóvil o motocicleta. */
export function validarPlaca(valor: unknown): Validado<{ placa: string; tipo: TipoPlaca }> {
  if (!esEscalar(valor)) return error(`Placa inválida. Formato: ${FORMATO_PLACA}.`);
  const placa = normalizarPlaca(valor);
  if (!placa) return error('La placa es obligatoria.');
  const tipo = tipoPlaca(placa);
  if (!tipo) return error(`Placa inválida. Formato: ${FORMATO_PLACA}.`);
  return ok({ placa, tipo });
}

// ─── Texto ───────────────────────────────────────────────────────────────────

/**
 * Tipos de texto:
 *   nombre       personas e instituciones: letras (con tildes y ñ), espacios y . ' - &
 *   letras       solo letras y espacios (p. ej. color)
 *   alfanumerico letras, números, espacios y - . / (marca, modelo, cargo, ubicación)
 *   libre        cualquier texto imprimible sin < > ni caracteres de control (observaciones, motivos)
 */
export type TipoTexto = 'nombre' | 'letras' | 'alfanumerico' | 'libre';

export const PATRONES_TEXTO: Record<TipoTexto, { re: RegExp; descripcion: string }> = {
  nombre: { re: /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ .'&-]*$/, descripcion: 'solo letras, espacios y . \' - &' },
  letras: { re: /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ ]+$/, descripcion: 'solo letras y espacios' },
  alfanumerico: { re: /^[A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ .,/#()-]+$/, descripcion: 'letras, números, espacios y . , / # ( ) -' },
  // eslint-disable-next-line no-control-regex
  libre: { re: /^[^<>\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+$/, descripcion: 'sin los caracteres < > ni caracteres de control' },
};

export interface ReglaTexto {
  etiqueta: string;
  tipo: TipoTexto;
  max: number;
  min?: number;
  requerido?: boolean;
}

/** Texto recortado y con espacios internos colapsados; null si está vacío y no es obligatorio. */
export function validarTexto(valor: unknown, r: ReglaTexto): Validado<string | null> {
  if (!esEscalar(valor)) return error(`${r.etiqueta}: valor inválido.`);
  const texto = valor === undefined || valor === null ? '' : String(valor).trim().replace(/\s+/g, ' ');
  if (!texto) return r.requerido ? error(`El campo «${r.etiqueta}» es obligatorio.`) : ok(null);
  if (r.min && texto.length < r.min) return error(`${r.etiqueta}: mínimo ${r.min} caracteres.`);
  if (texto.length > r.max) return error(`${r.etiqueta}: máximo ${r.max} caracteres.`);
  const patron = PATRONES_TEXTO[r.tipo];
  if (!patron.re.test(texto)) return error(`${r.etiqueta}: ${patron.descripcion}.`);
  return ok(texto);
}

// ─── Números ─────────────────────────────────────────────────────────────────

/** Entero (solo dígitos, signo opcional) dentro del rango. Rechaza "12a", "1.5", "1e3". */
export function validarEntero(valor: unknown, r: { etiqueta: string; min?: number; max?: number; requerido?: boolean }): Validado<number | null> {
  if (!esEscalar(valor)) return error(`${r.etiqueta}: solo números enteros.`);
  const texto = valor === undefined || valor === null ? '' : String(valor).trim();
  if (!texto) return r.requerido ? error(`El campo «${r.etiqueta}» es obligatorio.`) : ok(null);
  if (!/^-?\d+$/.test(texto)) return error(`${r.etiqueta}: solo números enteros.`);
  const n = Number(texto);
  if (!Number.isSafeInteger(n)) return error(`${r.etiqueta}: número fuera de rango.`);
  if (r.min !== undefined && n < r.min) return error(`${r.etiqueta}: mínimo ${r.min}.`);
  if (r.max !== undefined && n > r.max) return error(`${r.etiqueta}: máximo ${r.max}.`);
  return ok(n);
}

/** Identificador numérico positivo (parámetros de ruta como :id). */
export function esIdValido(valor: unknown): boolean {
  return /^\d{1,9}$/.test(String(valor ?? '')) && Number(valor) > 0;
}

// ─── Otros formatos ──────────────────────────────────────────────────────────

export const RE_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function validarEmail(valor: unknown, etiqueta = 'Correo'): Validado<string> {
  if (!esEscalar(valor)) return error(`${etiqueta} inválido.`);
  const email = String(valor ?? '').trim().toLowerCase();
  if (!email) return error(`El campo «${etiqueta}» es obligatorio.`);
  if (email.length > 150 || !RE_EMAIL.test(email)) return error(`${etiqueta} inválido.`);
  return ok(email);
}

export const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Fecha AAAA-MM-DD existente en el calendario (rechaza 2026-02-30). */
export function validarFecha(valor: unknown, r: { etiqueta: string; requerido?: boolean }): Validado<Date | null> {
  if (!esEscalar(valor)) return error(`${r.etiqueta}: formato AAAA-MM-DD.`);
  const texto = String(valor ?? '').trim();
  if (!texto) return r.requerido ? error(`El campo «${r.etiqueta}» es obligatorio.`) : ok(null);
  if (!RE_FECHA.test(texto)) return error(`${r.etiqueta}: formato AAAA-MM-DD.`);
  const fecha = new Date(`${texto}T00:00:00Z`);
  if (Number.isNaN(fecha.getTime()) || fecha.toISOString().slice(0, 10) !== texto) return error(`${r.etiqueta} no existe.`);
  return ok(fecha);
}

const RE_IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const RE_HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Dirección IPv4 o nombre de host. */
export function validarHost(valor: unknown, etiqueta = 'IP o host'): Validado<string | null> {
  if (!esEscalar(valor)) return error(`${etiqueta} inválido.`);
  const texto = String(valor ?? '').trim();
  if (!texto) return ok(null);
  // Solo dígitos y puntos: debe ser una IPv4 válida (evita que "300.1.1.1" pase como nombre de host)
  const pareceIp = /^[\d.]+$/.test(texto);
  if (pareceIp ? !RE_IPV4.test(texto) : !RE_HOST.test(texto)) return error(`${etiqueta} inválido.`);
  return ok(texto);
}
