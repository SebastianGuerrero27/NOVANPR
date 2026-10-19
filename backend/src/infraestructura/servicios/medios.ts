import crypto from 'crypto';
import sql from '../postgres';
import { getDB } from '../db';
import { type AlcanceTicket, enmascararEnTexto, fuenteParaMediamtx } from '../../dominio/camaras';
import { revelar } from './custodiaCredenciales';
import { verificarRed } from './redCamaras';

/**
 * Integración con MediaMTX (servidor de medios).
 *
 * Cada cámara registrada y habilitada se publica como la ruta `cam_<id>` (flujo principal, el que
 * lee el motor ANPR por RTSP) y, si tiene flujo de vista, como `cam_<id>_vista` (flujo secundario,
 * el que ven los navegadores por WebRTC; si no hay, ven el principal). MediaMTX abre una sola
 * conexión por flujo (bajo demanda) y la reparte sin transcodificar. Las rutas se administran por
 * la API interna de MediaMTX a partir de la base de datos: las credenciales se descifran solo al
 * entregarlas a MediaMTX y nunca se escriben en archivos de configuración.
 */
const API = () => (process.env.MEDIAMTX_API_URL || 'http://localhost:9997').replace(/\/$/, '');
const RTSP_INTERNA = () => (process.env.MEDIAMTX_RTSP_URL || 'rtsp://localhost:8554').replace(/\/$/, '');
export const urlWebrtcPublica = () => (process.env.WEBRTC_PUBLIC_URL || 'http://localhost:8889').replace(/\/$/, '');

const token = () => process.env.ANPR_SERVICE_TOKEN || '';
export const USUARIO_MOTOR = 'anpr';

export const rutaCamara = (id: number) => `cam_${id}`;
export const rutaVista = (id: number) => `cam_${id}_vista`;

/** URL con la que el motor ANPR lee una ruta de MediaMTX (autenticado con el token de servicio). */
export function urlLecturaMotor(ruta: string): string {
  const base = RTSP_INTERNA().replace(/^rtsp:\/\//, '');
  return `rtsp://${USUARIO_MOTOR}:${encodeURIComponent(token())}@${base}/${ruta}`;
}

async function api(metodo: string, ruta: string, cuerpo?: unknown): Promise<any> {
  const r = await fetch(`${API()}${ruta}`, {
    method: metodo,
    headers: cuerpo ? { 'Content-Type': 'application/json' } : undefined,
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(4000),
  });
  // MediaMTX repite en sus errores la fuente rechazada (con la contraseña): se enmascara antes de
  // que el mensaje llegue a un log o a una respuesta
  if (!r.ok) {
    const detalle = enmascararEnTexto(await r.text().catch(() => '')).slice(0, 300);
    throw new Error(`MediaMTX ${metodo} ${ruta}: HTTP ${r.status} ${detalle}`.trim());
  }
  return r.status === 200 ? r.json().catch(() => ({})) : {};
}

const configRuta = (source: string) => ({
  source,
  rtspTransport: 'tcp',
  sourceOnDemand: true,
  sourceOnDemandStartTimeout: '10s',
  sourceOnDemandCloseAfter: '15s',
});

/** Rutas configuradas en MediaMTX (nombre → fuente). */
async function rutasConfiguradas(): Promise<Map<string, string>> {
  const r = await api('GET', '/v3/config/paths/list?itemsPerPage=1000');
  return new Map((r.items ?? []).map((p: any) => [p.name, p.source]));
}

let sincronizando: Promise<void> | null = null;

/** Deja en MediaMTX exactamente una ruta por cámara habilitada, con su URL vigente. */
export function sincronizarRutas(): Promise<void> {
  if (sincronizando) return sincronizando;
  sincronizando = (async () => {
    try {
      const [camaras, actuales] = await Promise.all([
        getDB().request().query('SELECT id, rtsp_url, rtsp_url_vista FROM Camaras WHERE activa = 1'),
        rutasConfiguradas(),
      ]);
      const deseadas = new Map<string, string>();
      for (const c of camaras.recordset) {
        try {
          const principal = revelar(c.rtsp_url);
          const vista = c.rtsp_url_vista ? revelar(c.rtsp_url_vista) : null;
          // Protección contra SSRF: MediaMTX no abre destinos fuera de las redes permitidas
          const motivo = await verificarRed(principal, null) ?? (vista ? await verificarRed(vista, null) : null);
          if (motivo) {
            console.warn(`[MEDIOS] Cámara #${c.id} no publicada: ${motivo}`);
            continue;
          }
          deseadas.set(rutaCamara(c.id), fuenteParaMediamtx(principal));
          if (vista) deseadas.set(rutaVista(c.id), fuenteParaMediamtx(vista));
        } catch (e: any) {
          console.warn(`[MEDIOS] Cámara #${c.id}: ${enmascararEnTexto(String(e.message))}`);
        }
      }
      // Cada ruta por separado: una que MediaMTX rechace no impide publicar las demás ni retirar
      // las sobrantes (cámaras eliminadas, deshabilitadas o fuera de las redes permitidas)
      const aplicar = async (nombre: string, accion: () => Promise<unknown>) => {
        try {
          await accion();
        } catch (e: any) {
          console.warn(`[MEDIOS] Ruta ${nombre}: ${enmascararEnTexto(String(e.message))}`);
        }
      };
      for (const [nombre, fuente] of deseadas) {
        if (!actuales.has(nombre)) await aplicar(nombre, () => api('POST', `/v3/config/paths/add/${nombre}`, configRuta(fuente)));
        else if (actuales.get(nombre) !== fuente) await aplicar(nombre, () => api('PATCH', `/v3/config/paths/patch/${nombre}`, configRuta(fuente)));
      }
      for (const nombre of actuales.keys()) {
        if (nombre.startsWith('cam_') && !deseadas.has(nombre)) await aplicar(nombre, () => api('DELETE', `/v3/config/paths/delete/${nombre}`));
      }
    } catch (e: any) {
      console.warn('[MEDIOS] No se pudo sincronizar MediaMTX:', enmascararEnTexto(String(e.message)));
    } finally {
      sincronizando = null;
    }
  })();
  return sincronizando;
}

export function iniciarSincronizacionMedios(): void {
  setTimeout(() => sincronizarRutas(), 3000).unref();
  setInterval(() => sincronizarRutas(), 60000).unref();
}

/* ─── Rutas temporales para probar una URL antes de guardarla ─── */

const pruebas = new Map<string, NodeJS.Timeout>();
const MINUTOS_PRUEBA = 3;

export async function crearRutaPrueba(fuente: string): Promise<string> {
  const nombre = `prueba_${crypto.randomBytes(6).toString('hex')}`;
  await api('POST', `/v3/config/paths/add/${nombre}`, { ...configRuta(fuenteParaMediamtx(fuente)), sourceOnDemandCloseAfter: '5s' });
  pruebas.set(nombre, setTimeout(() => eliminarRutaPrueba(nombre), MINUTOS_PRUEBA * 60000));
  return nombre;
}

export async function eliminarRutaPrueba(nombre: string): Promise<void> {
  if (!/^prueba_[a-f0-9]{12}$/.test(nombre)) return;
  clearTimeout(pruebas.get(nombre));
  pruebas.delete(nombre);
  await api('DELETE', `/v3/config/paths/delete/${nombre}`).catch(() => undefined);
}

/** Estado en vivo de una ruta: si la fuente está lista y cuántos la están leyendo. */
export async function estadoRuta(nombre: string): Promise<{ lista: boolean; lectores: number; pistas: string[] } | null> {
  try {
    const r = await api('GET', `/v3/paths/get/${nombre}`);
    return { lista: Boolean(r.ready), lectores: (r.readers ?? []).length, pistas: r.tracks ?? [] };
  } catch {
    return null;
  }
}

/* ─── Tickets de lectura ─── */

/**
 * Ticket de 60 s para el navegador (video WebRTC y WebSockets del motor): HMAC-SHA256 con el
 * token de servicio sobre {usuario, alcance, expiración}.
 */
export function emitirTicket(usuarioId: number, alcance: AlcanceTicket): string {
  const payload = Buffer.from(JSON.stringify({ u: usuarioId, a: alcance, exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
  const firma = crypto.createHmac('sha256', token()).update(payload).digest('base64url');
  return `${payload}.${firma}`;
}

export function ticketValido(ticket: string | null | undefined, alcance: AlcanceTicket): boolean {
  if (!ticket || !ticket.includes('.') || !token()) return false;
  const [payload, firma] = ticket.split('.');
  const esperada = Buffer.from(crypto.createHmac('sha256', token()).update(payload).digest('base64url'));
  const recibida = Buffer.from(firma ?? '');
  if (esperada.length !== recibida.length || !crypto.timingSafeEqual(esperada, recibida)) return false;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return d.exp >= Date.now() / 1000 && d.a === alcance;
  } catch {
    return false;
  }
}

/** Credenciales del motor ANPR para leer de MediaMTX por RTSP. */
export function esMotor(usuario: string, clave: string): boolean {
  const esperado = Buffer.from(token());
  const recibido = Buffer.from(clave || '');
  return usuario === USUARIO_MOTOR && esperado.length > 0 && esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido);
}

/** Cámara registrada (habilitada) a la que corresponde una ruta cam_<id>. */
export async function camaraDeRuta(ruta: string): Promise<number | null> {
  const m = ruta.match(/^cam_(\d+)(?:_vista)?$/);
  if (!m) return null;
  const r = await getDB().request().input('id', sql.Int, Number(m[1])).query('SELECT id FROM Camaras WHERE id = @id AND activa = 1');
  return r.recordset[0]?.id ?? null;
}
