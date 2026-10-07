import { type ReglaTexto, type Validado, validarEntero, validarHost, validarTexto } from './validacion';

/**
 * Cámaras (dominio puro, sin E/S): reglas de los datos que registra el administrador y
 * presentación segura de la cámara hacia la API.
 *
 *   nombre, ubicación  texto alfanumérico (3–100 y 3–150 caracteres)
 *   rtsp_url           rtsp:// o rtsps://, máximo 255 caracteres, sin espacios; la contraseña
 *                      nunca sale de la API (se enmascara y se recupera al editar)
 *   ip                 IPv4 o nombre de host para el ping (máximo 45); por omisión, el host de la URL
 *   roi                región de interés: polígono de 3 a 12 vértices normalizados (0–1)
 *
 * La resolución del host (destinoRtsp) y el diagnóstico de red son adaptadores de
 * infraestructura; aquí solo están las reglas.
 */

export type Punto = [number, number];

// ─── URL RTSP y credenciales ─────────────────────────────────────────────────

/** La API nunca devuelve la contraseña RTSP: la reemplaza por esta máscara. */
export const MASCARA = '******';
/**
 * `rtsp://usuario:contraseña@host` (grupo 2 = contraseña), leída igual que la clase URL (WHATWG)
 * con la que se conecta la cámara: la autoridad termina en el primer / ? o #, la contraseña va
 * del primer «:» hasta la ÚLTIMA «@» de la autoridad (puede contener «@») y el usuario puede
 * estar vacío. Si la expresión cortara antes que la conexión, parte de la contraseña quedaría a
 * la vista en la API.
 */
export const RE_CREDENCIALES = /^(rtsps?:\/\/[^:/?#]*:)([^/?#]+)(@)/i;
export const LARGO_MAXIMO_RTSP = 255;
/** Largo de la columna Camaras.ip */
export const LARGO_MAXIMO_IP = 45;
/** rtsp:// o rtsps:// seguido de al menos un carácter imprimible, sin espacios ni < > */
// eslint-disable-next-line no-control-regex
const RE_URL_RTSP = /^rtsps?:\/\/[^\s<>\u0000-\u001F\u007F]+$/i;
export const MENSAJE_URL_RTSP = 'Ingrese una URL RTSP válida (rtsp://…).';

export const enmascarar = (url: string) => url.replace(RE_CREDENCIALES, `$1${MASCARA}$3`);
export const tieneCredenciales = (url: string) => RE_CREDENCIALES.test(url);

/**
 * El formulario recibe la URL enmascarada; si la devuelve sin cambiar la contraseña, se
 * recupera la guardada. Solo cuenta la máscara en el lugar de la contraseña (no en la ruta ni en
 * el usuario), y se reemplaza con una función para que un `$` de la contraseña no se interprete
 * como patrón de reemplazo.
 */
export function restaurarClave(rtsp: string, guardada?: string | null): string {
  if (!guardada || rtsp.match(RE_CREDENCIALES)?.[2] !== MASCARA) return rtsp;
  const clave = guardada.match(RE_CREDENCIALES)?.[2];
  return clave ? rtsp.replace(RE_CREDENCIALES, (_url, inicio: string, _mascara: string, arroba: string) => `${inicio}${clave}${arroba}`) : rtsp;
}

/**
 * URL RTSP escrita por una persona. El formato se comprueba sobre lo escrito y la contraseña
 * guardada se recupera después (solo se vuelve a comprobar el largo): una cámara registrada antes
 * de esta regla, con un espacio en la contraseña, se puede editar sin volver a escribirla.
 */
export function leerUrlRtsp(valor: unknown, guardada?: string | null): Validado<string> {
  if (valor !== undefined && valor !== null && typeof valor !== 'string') return { ok: false, error: MENSAJE_URL_RTSP };
  const escrita = typeof valor === 'string' ? valor.trim() : '';
  if (!escrita) return { ok: false, error: 'El campo «URL RTSP» es obligatorio.' };
  if (!RE_URL_RTSP.test(escrita)) return { ok: false, error: MENSAJE_URL_RTSP };
  const rtsp = restaurarClave(escrita, guardada);
  if (rtsp.length > LARGO_MAXIMO_RTSP) return { ok: false, error: `URL RTSP: máximo ${LARGO_MAXIMO_RTSP} caracteres.` };
  return { ok: true, valor: rtsp };
}

/** IP o host para el ping (opcional): validarHost y el largo de la columna Camaras.ip. */
export function leerIp(valor: unknown): Validado<string | null> {
  const ip = validarHost(valor);
  if (ip.ok && ip.valor && ip.valor.length > LARGO_MAXIMO_IP) return { ok: false, error: `IP o host: máximo ${LARGO_MAXIMO_IP} caracteres.` };
  return ip;
}

// ─── Alta y edición ──────────────────────────────────────────────────────────

export const REGLAS_CAMARA = {
  nombre: { etiqueta: 'Nombre', tipo: 'alfanumerico', min: 3, max: 100, requerido: true },
  ubicacion: { etiqueta: 'Ubicación', tipo: 'alfanumerico', min: 3, max: 150, requerido: true },
} satisfies Record<string, ReglaTexto>;

/** Entrada validada; `ip` es null cuando el host se toma de la URL. */
export interface EntradaCamara {
  nombre: string;
  ubicacion: string;
  rtsp: string;
  ip: string | null;
}

/** Datos listos para guardar (la IP ya resuelta). */
export interface DatosCamara {
  nombre: string;
  ubicacion: string;
  rtsp: string;
  ip: string;
}

/** Valida el alta o la edición; en la edición `rtspGuardada` permite conservar la contraseña. */
export function leerCamara(entrada: Record<string, unknown> | null | undefined, rtspGuardada?: string | null): Validado<EntradaCamara> {
  const body = entrada ?? {};
  const nombre = validarTexto(body.nombre, REGLAS_CAMARA.nombre);
  if (!nombre.ok) return nombre;
  const ubicacion = validarTexto(body.ubicacion, REGLAS_CAMARA.ubicacion);
  if (!ubicacion.ok) return ubicacion;
  const rtsp = leerUrlRtsp(body.rtsp_url, rtspGuardada);
  if (!rtsp.ok) return rtsp;
  const ip = leerIp(body.ip);
  if (!ip.ok) return ip;
  return { ok: true, valor: { nombre: nombre.valor as string, ubicacion: ubicacion.valor as string, rtsp: rtsp.valor, ip: ip.valor } };
}

/** Campos que cambian en la edición (para la auditoría). */
export function cambiosCamara(actual: { nombre: string; ubicacion: string; rtsp_url: string; ip: string }, nuevo: DatosCamara): string[] {
  return [
    actual.nombre !== nuevo.nombre && 'nombre', actual.ubicacion !== nuevo.ubicacion && 'ubicación',
    actual.rtsp_url !== nuevo.rtsp && 'URL RTSP', actual.ip !== nuevo.ip && 'IP',
  ].filter((c): c is string => Boolean(c));
}

/** Máximo de la columna INT: un id mayor no existe y desbordaría el parámetro SQL. */
const ID_MAXIMO = 2147483647;

/** Id de cámara recibido en el cuerpo de una solicitud (entero positivo). */
export function leerIdCamara(valor: unknown, requerido = false): Validado<number | null> {
  return validarEntero(valor, { etiqueta: 'Cámara', min: 1, max: ID_MAXIMO, requerido });
}

// ─── Región de interés ───────────────────────────────────────────────────────

export const VERTICES_ROI = { min: 3, max: 12 } as const;

/**
 * Región de interés: polígono de 3 a 12 vértices [x, y] normalizados (0–1) sobre el cuadro.
 * null o [] = cuadro completo. Cada coordenada debe ser un número (no texto) y se redondea a
 * 4 decimales.
 */
export function leerRoi(entrada: unknown): Validado<Punto[] | null> {
  if (entrada === null || (Array.isArray(entrada) && entrada.length === 0)) return { ok: true, valor: null };
  if (!Array.isArray(entrada) || entrada.length < VERTICES_ROI.min || entrada.length > VERTICES_ROI.max) {
    return { ok: false, error: `La región de interés debe tener entre ${VERTICES_ROI.min} y ${VERTICES_ROI.max} vértices.` };
  }
  const roi: Punto[] = [];
  for (const p of entrada) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) {
      return { ok: false, error: 'Cada vértice debe ser [x, y] con valores entre 0 y 1.' };
    }
    roi.push([Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000]);
  }
  return { ok: true, valor: roi };
}

/** Región de interés guardada (JSON) → polígono, o null si no hay una válida. */
export function parsearRoi(texto: unknown): Punto[] | null {
  if (typeof texto !== 'string' || !texto) return null;
  try {
    const r = leerRoi(JSON.parse(texto));
    return r.ok ? r.valor : null;
  } catch {
    return null;
  }
}

// ─── Presentación ────────────────────────────────────────────────────────────

/** Cámara tal como está guardada (con la contraseña RTSP y el número de detecciones). */
export interface CamaraGuardada {
  id: number;
  nombre: string;
  ip: string;
  rtsp_url: string;
  ubicacion: string;
  activa: boolean | number;
  estado: string | null;
  ultimo_ping: Date | null;
  tiempo_respuesta_ms: number | null;
  mensaje_ping: string | null;
  created_at: Date;
  detecciones?: number | null;
  /** Región de interés serializada (JSON) */
  roi: string | null;
}

/** Cámara tal como la entrega la API. */
export interface CamaraPublica {
  id: number;
  nombre: string;
  ip: string;
  ubicacion: string;
  /** Con la contraseña enmascarada */
  rtsp_url: string;
  tiene_credenciales: boolean;
  /** Habilitación administrativa */
  activa: boolean;
  /** Conectividad observada: EN_LINEA, SIN_CONEXION o SIN_VERIFICAR */
  estado: string;
  ultimo_ping: Date | null;
  tiempo_respuesta_ms: number | null;
  mensaje_ping: string | null;
  created_at: Date;
  detecciones?: number;
  roi: Punto[] | null;
}

/** Presentación segura: contraseña enmascarada y región de interés interpretada. */
export function presentarCamara(c: CamaraGuardada): CamaraPublica {
  return {
    id: c.id, nombre: c.nombre, ip: c.ip, ubicacion: c.ubicacion,
    rtsp_url: enmascarar(c.rtsp_url || ''),
    tiene_credenciales: tieneCredenciales(c.rtsp_url || ''),
    activa: Boolean(c.activa),
    estado: c.estado || 'SIN_VERIFICAR',
    ultimo_ping: c.ultimo_ping, tiempo_respuesta_ms: c.tiempo_respuesta_ms, mensaje_ping: c.mensaje_ping,
    created_at: c.created_at, detecciones: c.detecciones ?? undefined,
    roi: parsearRoi(c.roi),
  };
}

// ─── Video y monitoreo ───────────────────────────────────────────────────────

/** Ruta temporal de MediaMTX para probar una URL sin guardarla. */
export const RE_RUTA_PRUEBA = /^prueba_[a-f0-9]{12}$/;
/** Rutas de video consultables: cam_<id> de una cámara registrada o una ruta de prueba. */
export const RE_RUTA_VIDEO = /^(cam_\d+|prueba_[a-f0-9]{12})$/;

/** stream: ver el video · webcam: enviar la webcam del navegador al motor (modo de prueba). */
export const ALCANCES_TICKET = ['stream', 'webcam'] as const;
export type AlcanceTicket = typeof ALCANCES_TICKET[number];

/** Alcance del ticket de video: uno de los valores exactos; por omisión `stream`. */
export function leerAlcance(valor: unknown): Validado<AlcanceTicket> {
  if (valor === undefined || valor === null || valor === '') return { ok: true, valor: 'stream' };
  if (typeof valor !== 'string' || !(ALCANCES_TICKET as readonly string[]).includes(valor)) {
    return { ok: false, error: `Alcance inválido. Valores: ${ALCANCES_TICKET.join(', ')}.` };
  }
  return { ok: true, valor: valor as AlcanceTicket };
}
