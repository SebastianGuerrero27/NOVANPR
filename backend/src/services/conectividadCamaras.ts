import { execFile } from 'child_process';
import crypto from 'crypto';
import net from 'net';
import sql from 'mssql';
import { getDB } from '../config/db';
import { emitEvent } from './socket';
import { notificar } from './notificaciones';

/**
 * Diagnóstico de cámaras con el propio protocolo RTSP: se envía un DESCRIBE a la URL
 * configurada (con autenticación Basic o Digest si la cámara la pide). Distingue equipo
 * inaccesible, ruta inexistente, credenciales requeridas o incorrectas y flujo disponible,
 * sin ejecutar comandos del sistema.
 */

export type Diagnostico = 'ok' | 'requiere_credenciales' | 'credenciales_invalidas' | 'ruta_no_encontrada' | 'rechazado' | 'sin_respuesta' | 'url_invalida';

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

/** Envía una petición RTSP y devuelve la línea de estado y las cabeceras de la respuesta. */
function peticionRtsp(d: Destino, cabeceraAuth: string | null, cseq: number, timeoutMs: number)
  : Promise<{ codigo: number; cabeceras: Record<string, string> } | { error: 'timeout' | 'rechazado' | 'inaccesible' }> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let datos = '';
    const fin = (r: any) => { socket.destroy(); resolve(r); };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => fin({ error: 'timeout' }));
    socket.once('error', (e: NodeJS.ErrnoException) => fin({ error: e.code === 'ECONNREFUSED' ? 'rechazado' : 'inaccesible' }));
    socket.on('data', b => {
      datos += b.toString('latin1');
      const finCab = datos.indexOf('\r\n\r\n');
      if (finCab < 0 && datos.length < 16384) return;
      const lineas = datos.slice(0, finCab < 0 ? undefined : finCab).split('\r\n');
      const codigo = Number(lineas[0]?.split(' ')[1]) || 0;
      const cabeceras: Record<string, string> = {};
      for (const l of lineas.slice(1)) {
        const i = l.indexOf(':');
        if (i > 0) cabeceras[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      fin({ codigo, cabeceras });
    });
    socket.connect(d.puerto, d.host, () => {
      socket.write(
        `DESCRIBE ${d.urlSinCredenciales} RTSP/1.0\r\nCSeq: ${cseq}\r\nAccept: application/sdp\r\nUser-Agent: ANPR-ECU911\r\n` +
        (cabeceraAuth ? `Authorization: ${cabeceraAuth}\r\n` : '') + '\r\n');
    });
  });
}

function autorizacion(desafio: string, d: Destino): string | null {
  if (/^basic/i.test(desafio)) return `Basic ${Buffer.from(`${d.usuario}:${d.clave}`).toString('base64')}`;
  if (!/^digest/i.test(desafio)) return null;
  const campo = (n: string) => desafio.match(new RegExp(`${n}="?([^",]+)"?`, 'i'))?.[1] ?? '';
  const realm = campo('realm');
  const nonce = campo('nonce');
  const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
  const respuesta = md5(`${md5(`${d.usuario}:${realm}:${d.clave}`)}:${nonce}:${md5(`DESCRIBE:${d.urlSinCredenciales}`)}`);
  return `Digest username="${d.usuario}", realm="${realm}", nonce="${nonce}", uri="${d.urlSinCredenciales}", response="${respuesta}"`;
}

export async function probarConexion(rtspUrl: string, ip?: string | null, timeoutMs = 3000): Promise<ResultadoConexion> {
  const d = destinoRtsp(rtspUrl, ip);
  if (!d) return { host: null, puerto: null, en_linea: false, diagnostico: 'url_invalida', tiempo_ms: null, mensaje: 'URL RTSP inválida' };
  const base = { host: d.host, puerto: d.puerto };
  const inicio = Date.now();
  let r = await peticionRtsp(d, null, 1, timeoutMs);

  if ('error' in r) {
    const mensaje = r.error === 'rechazado' ? `El equipo rechazó la conexión en el puerto ${d.puerto} (¿servidor RTSP detenido o puerto incorrecto?)`
      : r.error === 'timeout' ? 'Sin respuesta (tiempo de espera agotado)' : 'Equipo inaccesible en la red';
    return { ...base, en_linea: false, diagnostico: r.error === 'rechazado' ? 'rechazado' : 'sin_respuesta', tiempo_ms: null, mensaje };
  }
  if (r.codigo === 401) {
    const desafio = r.cabeceras['www-authenticate'] ?? '';
    if (!d.usuario) {
      return { ...base, en_linea: false, diagnostico: 'requiere_credenciales', tiempo_ms: null, servidor: r.cabeceras.server ?? null,
        mensaje: 'La cámara pide usuario y contraseña' };
    }
    const auth = autorizacion(desafio, d);
    if (auth) r = await peticionRtsp(d, auth, 2, timeoutMs);
    if ('error' in r) return { ...base, en_linea: false, diagnostico: 'sin_respuesta', tiempo_ms: null, mensaje: 'La cámara cortó la conexión al autenticar' };
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
      await Promise.all(r.recordset.map(async c => registrarConexion(c.id, await probarConexion(c.rtsp_url, c.ip))));
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
