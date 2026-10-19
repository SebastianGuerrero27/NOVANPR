import { execFile } from 'child_process';
import crypto from 'crypto';
import net from 'net';
import sql from '../postgres';
import { getDB } from '../db';
import { revelar } from './custodiaCredenciales';
import { verificarRed } from './redCamaras';
import { emitEvent } from './socket';
import { notificar } from './notificaciones';

/**
 * Diagnóstico de cámaras con el propio protocolo RTSP: se envía un DESCRIBE a la URL
 * configurada (con autenticación Basic o Digest si la cámara la pide). Distingue equipo
 * inaccesible, ruta inexistente, credenciales requeridas o incorrectas y flujo disponible,
 * sin ejecutar comandos del sistema.
 */

export type Diagnostico = 'ok' | 'requiere_credenciales' | 'credenciales_invalidas' | 'ruta_no_encontrada' | 'rechazado' | 'sin_respuesta'
  | 'url_invalida' | 'red_no_permitida';

export interface ResultadoConexion {
  host: string | null;
  puerto: number | null;
  en_linea: boolean;
  diagnostico: Diagnostico;
  tiempo_ms: number | null;
  mensaje: string;
  servidor?: string | null;
}

const HOST_VALIDO = /^[a-zA-Z0-9.-]{1,253}$/;

interface Destino { host: string; puerto: number; usuario: string; clave: string; urlSinCredenciales: string }

export function destinoRtsp(rtspUrl: string, ip?: string | null): Destino | null {
  try {
    const u = new URL(rtspUrl);
    if (!/^rtsps?:$/.test(u.protocol)) return null;
    const host = (ip && HOST_VALIDO.test(ip.trim()) ? ip.trim() : u.hostname) || '';
    if (!HOST_VALIDO.test(host)) return null;
    const puerto = Number(u.port) || 554;
    const usuario = decodeURIComponent(u.username);
    const clave = decodeURIComponent(u.password);
    u.username = '';
    u.password = '';
    return { host, puerto, usuario, clave, urlSinCredenciales: u.toString() };
  } catch {
    return null;
  }
}

type RespuestaRtsp = { codigo: number; cabeceras: Record<string, string> };
type FalloRtsp = { error: 'timeout' | 'rechazado' | 'inaccesible' };

function leerCabeceras(texto: string): RespuestaRtsp {
  const lineas = texto.split('\r\n');
  const codigo = Number(lineas[0]?.split(' ')[1]) || 0;
  const cabeceras: Record<string, string> = {};
  for (const l of lineas.slice(1)) {
    const i = l.indexOf(':');
    if (i <= 0) continue;
    const nombre = l.slice(0, i).trim().toLowerCase();
    const valor = l.slice(i + 1).trim();
    // Hikvision y otras envían un desafío Digest y otro Basic: se conservan todos
    cabeceras[nombre] = nombre === 'www-authenticate' && cabeceras[nombre] ? `${cabeceras[nombre]}\n${valor}` : valor;
  }
  return { codigo, cabeceras };
}

/**
 * DESCRIBE por una sola conexión TCP. Si la cámara pide autenticación, la respuesta autenticada
 * va por la misma conexión: el nonce Digest de muchas cámaras (y de MediaMTX) solo vale en la
 * conexión que lo emitió. Devuelve la primera respuesta y, si se autenticó, la segunda.
 *
 * El paso autenticado espera al menos 6 s: ante una contraseña incorrecta, MediaMTX y muchas
 * cámaras demoran el 401 unos segundos (freno a la fuerza bruta) y con el límite general se
 * informaría «sin respuesta» en lugar de «contraseña incorrecta».
 */
function describir(d: Destino, timeoutMs: number): Promise<{ primera: RespuestaRtsp; autenticada?: RespuestaRtsp | FalloRtsp } | FalloRtsp> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let datos = '';
    let cuerpoPendiente = 0;
    let primera: RespuestaRtsp | null = null;
    const fin = (r: { primera: RespuestaRtsp; autenticada?: RespuestaRtsp | FalloRtsp } | FalloRtsp) => { socket.destroy(); resolve(r); };
    const fallo = (error: FalloRtsp['error']) => fin(primera ? { primera, autenticada: { error } } : { error });
    const enviar = (cseq: number, auth: string | null) => socket.write(
      `DESCRIBE ${d.urlSinCredenciales} RTSP/1.0\r\nCSeq: ${cseq}\r\nAccept: application/sdp\r\nUser-Agent: ANPR-ECU911\r\n` +
      (auth ? `Authorization: ${auth}\r\n` : '') + '\r\n');
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => fallo('timeout'));
    socket.once('error', (e: NodeJS.ErrnoException) => fallo(e.code === 'ECONNREFUSED' ? 'rechazado' : 'inaccesible'));
    socket.once('close', () => fallo('inaccesible'));
    socket.on('data', b => {
      datos += b.toString('latin1');
      // Descarta el cuerpo de la respuesta anterior (Content-Length) antes de leer la siguiente
      const descartar = Math.min(cuerpoPendiente, datos.length);
      datos = datos.slice(descartar);
      cuerpoPendiente -= descartar;
      if (cuerpoPendiente > 0) return;
      const finCab = datos.indexOf('\r\n\r\n');
      if (finCab < 0 && datos.length < 16384) return;
      const r = leerCabeceras(datos.slice(0, finCab < 0 ? undefined : finCab));
      datos = finCab < 0 ? '' : datos.slice(finCab + 4);
      cuerpoPendiente = Number(r.cabeceras['content-length']) || 0;
      if (primera) return fin({ primera, autenticada: r });
      primera = r;
      const auth = r.codigo === 401 && d.usuario ? autorizacion(r.cabeceras['www-authenticate'] ?? '', d) : null;
      if (!auth) return fin({ primera });
      socket.setTimeout(Math.max(timeoutMs, 6000));
      enviar(2, auth);
    });
    socket.connect(d.puerto, d.host, () => enviar(1, null));
  });
}

/**
 * Respuesta a los desafíos WWW-Authenticate (uno por línea): Digest si la cámara lo ofrece
 * (RFC 2617, con o sin qop=auth; las Hikvision con «autenticación RTSP: digest» rechazan Basic
 * aunque también lo anuncien), si no Basic.
 */
export function autorizacion(desafios: string, d: Pick<Destino, 'usuario' | 'clave' | 'urlSinCredenciales'>,
  cnonce = crypto.randomBytes(8).toString('hex')): string | null {
  const lista = desafios.split('\n').map(s => s.trim()).filter(Boolean);
  const digest = lista.find(s => /^digest\s/i.test(s));
  if (!digest) return lista.some(s => /^basic/i.test(s)) ? `Basic ${Buffer.from(`${d.usuario}:${d.clave}`).toString('base64')}` : null;
  // Valores entre comillas (pueden tener comas, p. ej. el realm) o sin comillas
  const campo = (n: string) => {
    const m = digest.match(new RegExp(`(?:^digest\\s+|,)\\s*${n}\\s*=\\s*(?:"([^"]*)"|([^,\\s]*))`, 'i'));
    return m ? (m[1] ?? m[2] ?? '') : '';
  };
  const realm = campo('realm');
  const nonce = campo('nonce');
  const opaque = campo('opaque');
  const qop = campo('qop').split(',').map(q => q.trim().toLowerCase()).includes('auth') ? 'auth' : '';
  const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
  const ha1 = md5(`${d.usuario}:${realm}:${d.clave}`);
  const ha2 = md5(`DESCRIBE:${d.urlSinCredenciales}`);
  const nc = '00000001';
  const respuesta = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  return `Digest username="${d.usuario}", realm="${realm}", nonce="${nonce}", uri="${d.urlSinCredenciales}", response="${respuesta}"`
    + (qop ? `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"` : '') + (opaque ? `, opaque="${opaque}"` : '');
}

export async function probarConexion(rtspUrl: string, ip?: string | null, timeoutMs = 3000): Promise<ResultadoConexion> {
  const d = destinoRtsp(rtspUrl, ip);
  if (!d) return { host: null, puerto: null, en_linea: false, diagnostico: 'url_invalida', tiempo_ms: null, mensaje: 'URL RTSP inválida' };
  const base = { host: d.host, puerto: d.puerto };
  const inicio = Date.now();
  const intercambio = await describir(d, timeoutMs);

  if ('error' in intercambio) {
    const r = intercambio;
    const mensaje = r.error === 'rechazado' ? `El equipo rechazó la conexión en el puerto ${d.puerto} (¿servidor RTSP detenido o puerto incorrecto?)`
      : r.error === 'timeout' ? 'Sin respuesta (tiempo de espera agotado)' : 'Equipo inaccesible en la red';
    return { ...base, en_linea: false, diagnostico: r.error === 'rechazado' ? 'rechazado' : 'sin_respuesta', tiempo_ms: null, mensaje };
  }
  let r = intercambio.primera;
  if (r.codigo === 401) {
    if (!d.usuario) {
      return { ...base, en_linea: false, diagnostico: 'requiere_credenciales', tiempo_ms: null, servidor: r.cabeceras.server ?? null,
        mensaje: 'La cámara pide usuario y contraseña' };
    }
    const autenticada = intercambio.autenticada;
    if (autenticada && 'error' in autenticada) {
      return { ...base, en_linea: false, diagnostico: 'sin_respuesta', tiempo_ms: null, mensaje: 'La cámara cortó la conexión al autenticar' };
    }
    if (autenticada) r = autenticada;
    if (r.codigo === 401) {
      return { ...base, en_linea: false, diagnostico: 'credenciales_invalidas', tiempo_ms: null, servidor: r.cabeceras.server ?? null,
        mensaje: 'Usuario o contraseña incorrectos' };
    }
  }
  const tiempo = Date.now() - inicio;
  const servidor = r.cabeceras.server ?? null;
  if (r.codigo === 200) return { ...base, en_linea: true, diagnostico: 'ok', tiempo_ms: tiempo, servidor, mensaje: 'Flujo de video disponible' };
  if (r.codigo === 404) return { ...base, en_linea: false, diagnostico: 'ruta_no_encontrada', tiempo_ms: tiempo, servidor, mensaje: 'La ruta del flujo no existe en la cámara' };
  return { ...base, en_linea: false, diagnostico: 'rechazado', tiempo_ms: tiempo, servidor, mensaje: `La cámara respondió RTSP ${r.codigo}` };
}

/** Guarda el resultado y avisa en tiempo real solo si el estado cambió. */
export async function registrarConexion(camaraId: number, r: ResultadoConexion, forzarAviso = false): Promise<void> {
  const db = getDB();
  const estado = r.en_linea ? 'EN_LINEA' : 'SIN_CONEXION';
  const prev = await db.request().input('id', sql.Int, camaraId).query('SELECT estado, mensaje_ping FROM Camaras WHERE id = @id');
  await db.request()
    .input('id', sql.Int, camaraId)
    .input('estado', sql.VarChar(20), estado)
    .input('ms', sql.Int, r.tiempo_ms)
    .input('msg', sql.VarChar(255), r.mensaje.substring(0, 255))
    .query(`UPDATE Camaras SET estado = @estado, ultimo_ping = GETDATE(), tiempo_respuesta_ms = @ms, mensaje_ping = @msg WHERE id = @id`);
  const p = prev.recordset[0];
  if (forzarAviso || p?.estado !== estado || p?.mensaje_ping !== r.mensaje) {
    emitEvent('camara:estado', { id: camaraId, estado, tiempo_respuesta_ms: r.tiempo_ms, mensaje_ping: r.mensaje, ultimo_ping: new Date() });
  }
  // Transición EN_LINEA → SIN_CONEXION: un acceso sin cámara es un punto ciego del control
  if (p?.estado === 'EN_LINEA' && estado === 'SIN_CONEXION') {
    const c = await db.request().input('id', sql.Int, camaraId).query('SELECT nombre, ubicacion FROM Camaras WHERE id = @id');
    const cam = c.recordset[0];
    void notificar({
      tipo: 'sistema.camara',
      titulo: `Cámara sin conexión · ${cam?.nombre ?? `#${camaraId}`}`,
      mensaje: `${cam?.ubicacion ?? 'Acceso'} · ${r.mensaje}. Los pasos por este acceso no se están registrando.`,
      enlace: '/camaras',
      claveDedup: `camara:${camaraId}`,
      datos: { camara_id: camaraId },
    });
  }
}

/** Verificación periódica de las cámaras habilitadas (CAMARAS_INTERVALO_S, 0 = desactivada). */
export function iniciarMonitorCamaras(): void {
  const intervalo = Number(process.env.CAMARAS_INTERVALO_S ?? 60);
  if (!intervalo) return;
  let ocupado = false;
  setInterval(async () => {
    if (ocupado) return;
    ocupado = true;
    try {
      const r = await getDB().request().query('SELECT id, rtsp_url, ip FROM Camaras WHERE activa = 1');
      // Cada cámara por separado: una credencial ilegible no impide verificar las demás
      await Promise.all(r.recordset.map(async c => {
        try {
          const url = revelar(c.rtsp_url);
          const motivo = await verificarRed(url, c.ip);
          await registrarConexion(c.id, motivo
            ? { host: null, puerto: null, en_linea: false, diagnostico: 'red_no_permitida', tiempo_ms: null, mensaje: motivo }
            : await probarConexion(url, c.ip));
        } catch (e: any) {
          console.warn(`[CAMARAS] Cámara #${c.id}: ${e.message}`);
        }
      }));
    } catch (e: any) {
      console.warn('[CAMARAS] Monitor de conectividad:', e.message);
    } finally {
      ocupado = false;
    }
  }, intervalo * 1000).unref();
}

export interface ResultadoPing { host: string; responde: boolean; tiempo_ms: number | null; mensaje: string }

/**
 * Ping ICMP al equipo (conectividad de red). Se ejecuta el binario `ping` con execFile y el
 * host validado como argumento (sin consola), por lo que no admite inyección de comandos.
 */
export function pingIcmp(host: string, timeoutS = 2): Promise<ResultadoPing> {
  if (!HOST_VALIDO.test(host) || host.startsWith('-')) {
    return Promise.resolve({ host, responde: false, tiempo_ms: null, mensaje: 'Host inválido' });
  }
  const windows = process.platform === 'win32';
  const args = windows ? ['-n', '1', '-w', String(timeoutS * 1000), host] : ['-c', '1', '-W', String(timeoutS), host];
  return new Promise(resolve => {
    execFile('ping', args, { timeout: (timeoutS + 2) * 1000 }, (error, stdout) => {
      const salida = String(stdout || '');
      const ms = salida.match(/(?:time|tiempo)[=<]\s*([\d.,]+)\s*ms/i)?.[1];
      const responde = !error && (/ttl=/i.test(salida) || /1 (packets )?received/i.test(salida));
      resolve({
        host,
        responde,
        tiempo_ms: responde && ms ? Math.round(Number(ms.replace(',', '.'))) : null,
        mensaje: responde ? 'El equipo responde al ping' : 'Sin respuesta al ping (equipo apagado, fuera de la red o ICMP bloqueado)',
      });
    });
  });
}

/** Diagnóstico completo: red (ping) y servicio de video (RTSP). */
export async function diagnosticar(rtspUrl: string, ip?: string | null) {
  const d = destinoRtsp(rtspUrl, ip);
  const [ping, rtsp] = await Promise.all([
    d ? pingIcmp(d.host) : Promise.resolve(null),
    probarConexion(rtspUrl, ip),
  ]);
  return { ping, rtsp };
}
