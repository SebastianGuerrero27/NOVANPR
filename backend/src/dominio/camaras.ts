import { type ReglaTexto, type Validado, validarEntero, validarHost, validarTexto } from './validacion';

/**
 * Cámaras (dominio puro, sin E/S): reglas de los datos que registra el administrador y
 * presentación segura de la cámara hacia la API.
 *
 *   nombre, ubicación  texto alfanumérico (3–100 y 3–150 caracteres)
 *   rtsp_url           rtsp:// o rtsps://, máximo 255 caracteres, sin espacios; la contraseña
 *                      nunca sale de la API (se enmascara y se recupera al editar)
 *   rtsp_url_vista     opcional: flujo secundario (p. ej. Hikvision /Streaming/Channels/102) para
 *                      la vista en vivo del navegador; mismas reglas que rtsp_url
 *   ip                 IPv4 o nombre de host para el ping (máximo 45); por omisión, el host de la URL
 *   roi                región de interés: polígono de 3 a 12 vértices normalizados (0–1)
 *   exclusiones        zonas de exclusión: hasta 8 polígonos con las mismas reglas
 *
 * La resolución del host (destinoRtsp) y el diagnóstico de red son adaptadores de
 * infraestructura; aquí solo están las reglas.
 */

export type Punto = [number, number];
export type DireccionCamara = 'ingreso' | 'salida';

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
 * Enmascara las contraseñas de todas las URL RTSP que aparezcan dentro de un texto libre (p. ej. el
 * mensaje de error de MediaMTX, que repite la fuente rechazada). Como en una URL suelta, la
 * contraseña llega hasta la última «@» de la autoridad (antes de / ? #, un espacio o una comilla).
 */
export const enmascararEnTexto = (texto: string) =>
  texto.replace(/(rtsps?:\/\/[^\s'"`/?#@:]*:)[^\s'"`/?#]*@/gi, `$1${MASCARA}@`);

/**
 * Esquema, equipo y puerto de una URL con credenciales («rtsp://10.0.0.5:554»), en minúsculas y con
 * el puerto por omisión del esquema; null si no tiene credenciales.
 */
function destinoConCredenciales(url: string): string | null {
  const m = url.match(RE_CREDENCIALES);
  if (!m) return null;
  const esquema = m[1].slice(0, m[1].indexOf('://')).toLowerCase();
  const autoridad = url.slice(m[0].length).split(/[/?#]/)[0].toLowerCase();
  const conPuerto = /^\[[^\]]*\]:\d+$|^[^:[\]]+:\d+$/.test(autoridad);
  return `${esquema}://${conPuerto ? autoridad : `${autoridad}:${esquema === 'rtsps' ? 322 : 554}`}`;
}

/**
 * El formulario recibe la URL enmascarada; si la devuelve sin cambiar la contraseña, se
 * recupera la guardada. Solo cuenta la máscara en el lugar de la contraseña (no en la ruta ni en
 * el usuario), y se reemplaza con una función para que un `$` de la contraseña no se interprete
 * como patrón de reemplazo.
 *
 * La contraseña solo vuelve al mismo equipo (esquema, host y puerto de la URL guardada): si la
 * máscara llega con otro destino, la URL queda tal cual (con la máscara) y la validación pide
 * escribirla de nuevo. Así nadie con acceso al formulario puede enviar la contraseña custodiada a
 * un equipo propio para leerla.
 */
export function restaurarClave(rtsp: string, guardada?: string | null): string {
  if (!guardada || rtsp.match(RE_CREDENCIALES)?.[2] !== MASCARA) return rtsp;
  const clave = guardada.match(RE_CREDENCIALES)?.[2];
  if (!clave || destinoConCredenciales(rtsp) !== destinoConCredenciales(guardada)) return rtsp;
  return rtsp.replace(RE_CREDENCIALES, (_url, inicio: string, _mascara: string, arroba: string) => `${inicio}${clave}${arroba}`);
}

/**
 * Fuente que se entrega a MediaMTX. Su lector de URL (Go, net/url) es más estricto que el de la
 * API: rechaza el esquema en mayúsculas, un «%» que no forme un código %XX y ciertos caracteres
 * sin codificar en el usuario o la contraseña (p. ej. el espacio de cámaras antiguas), y al
 * rechazarla escribe la URL completa, con la contraseña, en su registro. Aquí se lleva a la forma
 * equivalente que acepta: esquema en minúsculas, «%» suelto como %25 y esos caracteres
 * codificados (MediaMTX los decodifica antes de autenticarse, así que la credencial es la misma).
 */
export function fuenteParaMediamtx(url: string): string {
  const esquema = url.match(/^rtsps?:\/\//i);
  if (!esquema) return url;
  const resto = url.slice(esquema[0].length);
  const fin = resto.search(/[/?#]/);
  const autoridad = fin === -1 ? resto : resto.slice(0, fin);
  const ruta = fin === -1 ? '' : resto.slice(fin);
  const arroba = autoridad.lastIndexOf('@');
  const sueltos = (s: string) => s.replace(/%(?![0-9a-f]{2})/gi, '%25');
  const usuario = arroba === -1 ? '' : sueltos(autoridad.slice(0, arroba))
    .replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:%@]/gu, c => encodeURIComponent(c));
  const equipo = arroba === -1 ? autoridad : autoridad.slice(arroba + 1);
  return `${esquema[0].toLowerCase()}${arroba === -1 ? '' : `${usuario}@`}${equipo}${sueltos(ruta)}`;
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
  // Esquema en minúsculas: MediaMTX rechaza «RTSP://» (y al rechazarla registra la URL completa)
  const rtsp = restaurarClave(escrita.replace(/^rtsps?:\/\//i, e => e.toLowerCase()), guardada);
  if (guardada && rtsp.match(RE_CREDENCIALES)?.[2] === MASCARA) {
    return { ok: false, error: 'URL RTSP: escriba de nuevo la contraseña de la cámara (la guardada solo se conserva si no cambian el equipo, el puerto ni el esquema).' };
  }
  if (rtsp.length > LARGO_MAXIMO_RTSP) return { ok: false, error: `URL RTSP: máximo ${LARGO_MAXIMO_RTSP} caracteres.` };
  return { ok: true, valor: rtsp };
}

/**
 * URL del flujo de vista (opcional; vacía = la vista usa el flujo principal). Si llega
 * enmascarada se recupera la contraseña guardada de la vista o, si aún no había vista, la del
 * flujo principal (las cámaras usan las mismas credenciales en ambos canales), siempre que apunte
 * al mismo equipo que esa URL guardada.
 */
export function leerUrlVista(valor: unknown, guardada?: string | null): Validado<string | null> {
  if (valor === undefined || valor === null || (typeof valor === 'string' && !valor.trim())) return { ok: true, valor: null };
  const r = leerUrlRtsp(valor, guardada);
  return r.ok ? r : { ok: false, error: r.error.replace('URL RTSP', 'URL del flujo de vista') };
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
  direccion: DireccionCamara;
  /** Flujo de vista (null = la vista usa el principal) */
  rtspVista: string | null;
  ip: string | null;
}

/** Datos listos para guardar (la IP ya resuelta). */
export interface DatosCamara {
  nombre: string;
  ubicacion: string;
  rtsp: string;
  rtspVista: string | null;
  ip: string;
  direccion: DireccionCamara;
}

/** Valida el alta o la edición; en la edición las URL guardadas permiten conservar la contraseña. */
export function leerCamara(entrada: Record<string, unknown> | null | undefined, rtspGuardada?: string | null,
  vistaGuardada?: string | null): Validado<EntradaCamara> {
  const body = entrada ?? {};
  const nombre = validarTexto(body.nombre, REGLAS_CAMARA.nombre);
  if (!nombre.ok) return nombre;
  const ubicacion = validarTexto(body.ubicacion, REGLAS_CAMARA.ubicacion);
  if (!ubicacion.ok) return ubicacion;
  const rtsp = leerUrlRtsp(body.rtsp_url, rtspGuardada);
  if (!rtsp.ok) return rtsp;
  const vista = leerUrlVista(body.rtsp_url_vista, vistaGuardada || rtspGuardada);
  if (!vista.ok) return vista;
  const ip = leerIp(body.ip);
  if (!ip.ok) return ip;
  const direccion = body.direccion === undefined ? 'ingreso' : body.direccion;
  if (direccion !== 'ingreso' && direccion !== 'salida') {
    return { ok: false, error: 'La dirección de la cámara debe ser ingreso o salida.' };
  }
  return {
    ok: true,
    valor: {
      nombre: nombre.valor as string, ubicacion: ubicacion.valor as string, rtsp: rtsp.valor,
      rtspVista: vista.valor, ip: ip.valor, direccion,
    },
  };
}

/** Campos que cambian en la edición (para la auditoría). */
export function cambiosCamara(actual: { nombre: string; ubicacion: string; rtsp_url: string; rtsp_url_vista?: string | null; ip: string; direccion?: DireccionCamara },
  nuevo: DatosCamara): string[] {
  return [
    actual.nombre !== nuevo.nombre && 'nombre', actual.ubicacion !== nuevo.ubicacion && 'ubicación',
    actual.rtsp_url !== nuevo.rtsp && 'URL RTSP', (actual.rtsp_url_vista ?? null) !== nuevo.rtspVista && 'URL de vista',
    actual.ip !== nuevo.ip && 'IP',
    (actual.direccion ?? 'ingreso') !== nuevo.direccion && 'dirección',
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

// ─── Zonas de exclusión ──────────────────────────────────────────────────────

export const MAX_EXCLUSIONES = 8;

/**
 * Zonas de exclusión: hasta 8 polígonos (cada uno con las reglas de la región de interés) donde
 * el motor no cuenta el movimiento ni busca placas: árboles, banderas, reflejos, la vereda o la
 * hora sobreimpresa, que de otro modo disparan el detector con movimiento falso. null o [] =
 * ninguna.
 */
export function leerExclusiones(entrada: unknown): Validado<Punto[][]> {
  if (entrada === null) return { ok: true, valor: [] };
  if (!Array.isArray(entrada)) return { ok: false, error: 'Las zonas de exclusión deben ser una lista de polígonos.' };
  if (entrada.length > MAX_EXCLUSIONES) return { ok: false, error: `Máximo ${MAX_EXCLUSIONES} zonas de exclusión.` };
  const zonas: Punto[][] = [];
  for (const [i, z] of entrada.entries()) {
    const zona = `Zona de exclusión ${i + 1}`;
    if (!Array.isArray(z) || z.length < VERTICES_ROI.min || z.length > VERTICES_ROI.max) {
      return { ok: false, error: `${zona}: debe tener entre ${VERTICES_ROI.min} y ${VERTICES_ROI.max} vértices.` };
    }
    const poligono = leerRoi(z);
    if (!poligono.ok || !poligono.valor) return { ok: false, error: `${zona}: cada vértice debe ser [x, y] con valores entre 0 y 1.` };
    zonas.push(poligono.valor);
  }
  return { ok: true, valor: zonas };
}

/** Zonas de exclusión guardadas (JSON) → polígonos; [] si no hay o no son válidas. */
export function parsearExclusiones(texto: unknown): Punto[][] {
  if (typeof texto !== 'string' || !texto) return [];
  try {
    const r = leerExclusiones(JSON.parse(texto));
    return r.ok ? r.valor : [];
  } catch {
    return [];
  }
}

/** "2 zonas de exclusión", "1 zona de exclusión", "sin zonas de exclusión". */
export const describirExclusiones = (n: number) => (n === 0 ? 'sin zonas de exclusión' : n === 1 ? '1 zona de exclusión' : `${n} zonas de exclusión`);

// ─── Presentación ────────────────────────────────────────────────────────────

/** Cámara tal como está guardada (con la contraseña RTSP y el número de detecciones). */
export interface CamaraGuardada {
  id: number;
  nombre: string;
  ip: string;
  rtsp_url: string;
  rtsp_url_vista?: string | null;
  ubicacion: string;
  direccion?: DireccionCamara;
  activa: boolean | number;
  estado: string | null;
  ultimo_ping: Date | null;
  tiempo_respuesta_ms: number | null;
  mensaje_ping: string | null;
  created_at: Date;
  detecciones?: number | null;
  /** Región de interés serializada (JSON) */
  roi: string | null;
  /** Zonas de exclusión serializadas (JSON) */
  exclusiones?: string | null;
}

/** Cámara tal como la entrega la API. */
export interface CamaraPublica {
  id: number;
  nombre: string;
  ip: string;
  ubicacion: string;
  direccion: DireccionCamara;
  /** Con la contraseña enmascarada */
  rtsp_url: string;
  /** Flujo de vista con la contraseña enmascarada (null = la vista usa el principal) */
  rtsp_url_vista: string | null;
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
  exclusiones: Punto[][];
}

/** Presentación segura: contraseña enmascarada, región de interés y zonas de exclusión interpretadas. */
export function presentarCamara(c: CamaraGuardada): CamaraPublica {
  return {
    id: c.id, nombre: c.nombre, ip: c.ip, ubicacion: c.ubicacion, direccion: c.direccion ?? 'ingreso',
    rtsp_url: enmascarar(c.rtsp_url || ''),
    rtsp_url_vista: c.rtsp_url_vista ? enmascarar(c.rtsp_url_vista) : null,
    tiene_credenciales: tieneCredenciales(c.rtsp_url || ''),
    activa: Boolean(c.activa),
    estado: c.estado || 'SIN_VERIFICAR',
    ultimo_ping: c.ultimo_ping, tiempo_respuesta_ms: c.tiempo_respuesta_ms, mensaje_ping: c.mensaje_ping,
    created_at: c.created_at, detecciones: c.detecciones ?? undefined,
    roi: parsearRoi(c.roi),
    exclusiones: parsearExclusiones(c.exclusiones),
  };
}

// ─── Video y monitoreo ───────────────────────────────────────────────────────

/** Ruta temporal de MediaMTX para probar una URL sin guardarla. */
export const RE_RUTA_PRUEBA = /^prueba_[a-f0-9]{12}$/;
/** Rutas de video consultables: cam_<id> (flujo principal), cam_<id>_vista o una ruta de prueba. */
export const RE_RUTA_VIDEO = /^(cam_\d+(_vista)?|prueba_[a-f0-9]{12})$/;

/** stream: ver el video de una cámara registrada (WebRTC) y las pistas del motor. */
export const ALCANCES_TICKET = ['stream'] as const;
export type AlcanceTicket = typeof ALCANCES_TICKET[number];

/** Alcance del ticket de video: uno de los valores exactos; por omisión `stream`. */
export function leerAlcance(valor: unknown): Validado<AlcanceTicket> {
  if (valor === undefined || valor === null || valor === '') return { ok: true, valor: 'stream' };
  if (typeof valor !== 'string' || !(ALCANCES_TICKET as readonly string[]).includes(valor)) {
    return { ok: false, error: `Alcance inválido. Valores: ${ALCANCES_TICKET.join(', ')}.` };
  }
  return { ok: true, valor: valor as AlcanceTicket };
}
