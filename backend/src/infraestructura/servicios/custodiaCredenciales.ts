import crypto from 'crypto';
import sql from '../postgres';
import { RE_CREDENCIALES } from '../../dominio/camaras';
import type { PuertoCustodiaCredenciales } from '../../aplicacion/camaras';

/**
 * Custodia de las contraseñas RTSP de las cámaras: se guardan cifradas con AES-256-GCM dentro
 * de la misma URL (rtsp://usuario:enc.v1.<iv>.<cifrado+etiqueta>@host/ruta), de modo que la
 * máscara de la API, la recuperación de la contraseña al editar y la auditoría siguen operando
 * sobre la URL sin conocer la contraseña. Se descifra solo para entregarla a MediaMTX y al
 * diagnóstico de conectividad.
 *
 * Clave vigente: CAMARAS_CLAVE_CIFRADO (32 bytes en base64, p. ej. `openssl rand -base64 32`).
 * Si no está definida se deriva de JWT_SECRET con HKDF-SHA256 (con un aviso: en producción
 * conviene una clave propia, que no cambie al rotar JWT_SECRET).
 *
 * Rotación: las claves anteriores (CAMARAS_CLAVE_CIFRADO_ANTERIOR, varias separadas por coma, y
 * la derivada de JWT_SECRET cuando ya hay clave propia) solo se usan para descifrar; al arrancar,
 * las contraseñas cifradas con ellas se vuelven a cifrar con la vigente. Pasar de la clave
 * derivada a una propia, o cambiar la propia, no obliga a volver a escribir las contraseñas.
 */

const PREFIJO = 'enc.v1.';
const ALGORITMO = 'aes-256-gcm';
let claves: { vigente: Buffer; anteriores: Buffer[] } | null = null;

function leerClave(base64: string, variable: string): Buffer {
  const k = Buffer.from(base64.trim(), 'base64');
  if (k.length !== 32) throw new Error(`${variable} debe tener 32 bytes en base64 (openssl rand -base64 32).`);
  return k;
}

const derivadaDeJwt = (secreto: string) => Buffer.from(crypto.hkdfSync('sha256', secreto, 'anpr-ecu911', 'camaras-rtsp', 32));

function obtenerClaves(): { vigente: Buffer; anteriores: Buffer[] } {
  if (claves) return claves;
  const propia = process.env.CAMARAS_CLAVE_CIFRADO;
  const jwt = process.env.JWT_SECRET;
  const anteriores = (process.env.CAMARAS_CLAVE_CIFRADO_ANTERIOR || '').split(',').filter(k => k.trim())
    .map(k => leerClave(k, 'CAMARAS_CLAVE_CIFRADO_ANTERIOR'));
  let vigente: Buffer;
  if (propia) {
    vigente = leerClave(propia, 'CAMARAS_CLAVE_CIFRADO');
    if (jwt) anteriores.push(derivadaDeJwt(jwt)); // lo cifrado antes de definir la clave propia
  } else {
    if (!jwt) throw new Error('Defina CAMARAS_CLAVE_CIFRADO (o JWT_SECRET) para cifrar las credenciales de las cámaras.');
    console.warn('[CAMARAS] CAMARAS_CLAVE_CIFRADO no definida: la clave de las credenciales se deriva de JWT_SECRET.');
    vigente = derivadaDeJwt(jwt);
  }
  claves = { vigente, anteriores };
  return claves;
}

/** Solo para pruebas: olvida las claves calculadas (después de cambiar las variables de entorno). */
export function reiniciarClave(): void {
  claves = null;
}

const segmento = (url: string): string | undefined => url.match(RE_CREDENCIALES)?.[2];

export const estaProtegida = (url: string): boolean => Boolean(segmento(url)?.startsWith(PREFIJO));

const conClave = (url: string, texto: string) =>
  url.replace(RE_CREDENCIALES, (_u, inicio: string, _c: string, arroba: string) => `${inicio}${texto}${arroba}`);

/** Contraseña en claro, o null si esa clave no la descifra (la etiqueta GCM no coincide). */
function descifrar(texto: string, k: Buffer): string | null {
  const [iv, datos] = texto.slice(PREFIJO.length).split('.');
  const bytes = Buffer.from(datos ?? '', 'base64url');
  if (!iv || bytes.length < 17) return null;
  try {
    const descifrador = crypto.createDecipheriv(ALGORITMO, k, Buffer.from(iv, 'base64url'));
    descifrador.setAuthTag(bytes.subarray(bytes.length - 16));
    return Buffer.concat([descifrador.update(bytes.subarray(0, bytes.length - 16)), descifrador.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** URL con la contraseña cifrada; sin contraseña o ya cifrada, se devuelve igual. */
export function proteger(url: string): string {
  const texto = segmento(url);
  if (!texto || texto.startsWith(PREFIJO)) return url;
  const iv = crypto.randomBytes(12);
  const cifrador = crypto.createCipheriv(ALGORITMO, obtenerClaves().vigente, iv);
  const cifrado = Buffer.concat([cifrador.update(texto, 'utf8'), cifrador.final(), cifrador.getAuthTag()]);
  return conClave(url, `${PREFIJO}${iv.toString('base64url')}.${cifrado.toString('base64url')}`);
}

/**
 * URL con la contraseña en claro, para conectarse a la cámara (prueba la clave vigente y las
 * anteriores). Falla si el texto fue alterado o ninguna clave configurada lo descifra.
 */
export function revelar(url: string): string {
  const texto = segmento(url);
  if (!texto || !texto.startsWith(PREFIJO)) return url;
  const { vigente, anteriores } = obtenerClaves();
  for (const k of [vigente, ...anteriores]) {
    const claro = descifrar(texto, k);
    if (claro !== null) return conClave(url, claro);
  }
  throw new Error('Credencial de cámara ilegible: la clave de cifrado cambió o el dato fue alterado.');
}

/** URL cifrada con la clave vigente: cifra la contraseña en claro y vuelve a cifrar la de una clave anterior. */
export function conClaveVigente(url: string): string {
  const texto = segmento(url);
  if (!texto) return url;
  if (!texto.startsWith(PREFIJO)) return proteger(url);
  if (descifrar(texto, obtenerClaves().vigente) !== null) return url;
  return proteger(revelar(url));
}

export const custodiaCredenciales: PuertoCustodiaCredenciales = { proteger, revelar };

/**
 * Al arrancar: cifra las contraseñas que aún estén en claro (cámaras registradas antes de la
 * migración v9) y vuelve a cifrar con la clave vigente las de una clave anterior. Es idempotente;
 * devuelve cuántas cámaras actualizó. Una contraseña que ninguna clave descifra no detiene el
 * arranque: se avisa para volver a escribirla.
 */
export async function protegerCredencialesGuardadas(pool: { request: () => any }): Promise<number> {
  const r = await pool.request().query('SELECT id, rtsp_url, rtsp_url_vista FROM Camaras');
  let actualizadas = 0;
  for (const c of r.recordset) {
    let rtsp: string;
    let vista: string | null;
    try {
      rtsp = conClaveVigente(c.rtsp_url || '');
      vista = c.rtsp_url_vista ? conClaveVigente(c.rtsp_url_vista) : null;
    } catch {
      console.warn(`[CAMARAS] Cámara ${c.id}: ninguna clave configurada descifra su contraseña RTSP; vuelva a escribirla en el formulario.`);
      continue;
    }
    if (rtsp === c.rtsp_url && vista === (c.rtsp_url_vista ?? null)) continue;
    await pool.request().input('id', sql.Int, c.id).input('rtsp', sql.VarChar(512), rtsp).input('vista', sql.VarChar(512), vista)
      .query('UPDATE Camaras SET rtsp_url = @rtsp, rtsp_url_vista = @vista WHERE id = @id');
    actualizadas++;
  }
  if (actualizadas) console.log(`[CAMARAS] Credenciales RTSP cifradas con la clave vigente en ${actualizadas} cámara(s).`);
  return actualizadas;
}
