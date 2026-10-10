import crypto from 'crypto';
import net from 'net';
import { autorizacion, probarConexion } from '../../infraestructura/servicios/conectividadCamaras';

/**
 * Sonda RTSP del backend contra un servidor RTSP falso que se comporta como una cámara: responde
 * 401 con sus desafíos, valida la respuesta Digest (RFC 2617) del lado del servidor y entrega 200
 * o 404 según la ruta. Como MediaMTX (gortsplib) y muchas cámaras, el nonce vale solo en la
 * conexión TCP que lo emitió.
 */

const CLAVE = 'Ecu911@Garita#26:/x';
const RUTA = '/Streaming/Channels/101';
const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

/** `pausaTrasFallo`: demora del 401 ante una respuesta incorrecta (MediaMTX espera ~2 s). */
interface Camara { realm: string; qop: boolean; opaque?: string; basicTambien: boolean; pausaTrasFallo?: number }

function camaraFalsa(c: Camara): Promise<{ puerto: number; cerrar: () => void; autorizaciones: string[] }> {
  const autorizaciones: string[] = [];
  const servidor = net.createServer(socket => {
    const nonce = crypto.randomBytes(8).toString('hex');
    socket.on('data', b => {
      const texto = b.toString('latin1');
      const [linea, ...resto] = texto.split('\r\n');
      const uri = linea.split(' ')[1];
      const cseq = resto.find(l => /^cseq:/i.test(l))?.split(':')[1].trim() ?? '1';
      const auth = resto.find(l => /^authorization:/i.test(l))?.slice('authorization:'.length).trim() ?? '';
      if (auth) autorizaciones.push(auth);
      const responder = (estado: string, extra: string[] = []) =>
        socket.write([`RTSP/1.0 ${estado}`, `CSeq: ${cseq}`, 'Server: Camara de prueba', ...extra, '', ''].join('\r\n'));
      const campo = (n: string) => auth.match(new RegExp(`${n}="?([^",]*)"?`, 'i'))?.[1] ?? '';
      let valida = false;
      if (/^digest/i.test(auth)) {
        const ha1 = md5(`${campo('username')}:${c.realm}:${CLAVE}`);
        const ha2 = md5(`DESCRIBE:${campo('uri')}`);
        const esperada = c.qop
          ? md5(`${ha1}:${nonce}:${campo('nc')}:${campo('cnonce')}:${campo('qop')}:${ha2}`)
          : md5(`${ha1}:${nonce}:${ha2}`);
        valida = campo('username') === 'admin' && campo('response') === esperada && (!c.opaque || campo('opaque') === c.opaque);
      }
      if (!valida && auth && c.pausaTrasFallo) {
        setTimeout(() => responder('401 Unauthorized', [`WWW-Authenticate: Digest realm="${c.realm}", nonce="${nonce}"`]), c.pausaTrasFallo);
        return;
      }
      if (!valida) {
        const digest = `Digest realm="${c.realm}", nonce="${nonce}"${c.qop ? ', qop="auth"' : ''}${c.opaque ? `, opaque="${c.opaque}"` : ''}`;
        // Cuerpo en la respuesta 401 (algunas cámaras envían HTML): la sonda debe descartarlo
        const cuerpo = '<html>401</html>';
        responder('401 Unauthorized', [`WWW-Authenticate: ${digest}`, ...(c.basicTambien ? [`WWW-Authenticate: Basic realm="${c.realm}"`] : []),
          `Content-Length: ${cuerpo.length}`]);
        socket.write(cuerpo);
        return;
      }
      if (new URL(uri).pathname !== RUTA) return responder('404 Not Found');
      responder('200 OK', ['Content-Type: application/sdp', 'Content-Length: 0']);
    });
  });
  return new Promise(resolve => servidor.listen(0, '127.0.0.1', () =>
    resolve({ puerto: (servidor.address() as net.AddressInfo).port, cerrar: () => servidor.close(), autorizaciones })));
}

const url = (puerto: number, clave = CLAVE, ruta = RUTA, usuario = 'admin') =>
  `rtsp://${usuario ? `${usuario}:${encodeURIComponent(clave)}@` : ''}127.0.0.1:${puerto}${ruta}`;

describe('Sonda RTSP de cámaras (DESCRIBE con autenticación)', () => {
  it('Hikvision: anuncia Digest y Basic; se responde con Digest y la contraseña con símbolos se decodifica', async () => {
    const cam = await camaraFalsa({ realm: 'IP Camera(J12345678)', qop: false, basicTambien: true });
    try {
      const r = await probarConexion(url(cam.puerto));
      expect(r).toMatchObject({ en_linea: true, diagnostico: 'ok', servidor: 'Camara de prueba' });
      expect(cam.autorizaciones.at(-1)).toMatch(/^Digest /);
      expect(await probarConexion(url(cam.puerto, 'otra'))).toMatchObject({ en_linea: false, diagnostico: 'credenciales_invalidas' });
      expect(await probarConexion(url(cam.puerto, CLAVE, '/Streaming/Channels/301'))).toMatchObject({ diagnostico: 'ruta_no_encontrada' });
      expect(await probarConexion(url(cam.puerto, CLAVE, RUTA, ''))).toMatchObject({ diagnostico: 'requiere_credenciales' });
    } finally {
      cam.cerrar();
    }
  });

  it('contraseña incorrecta con el 401 demorado (freno a la fuerza bruta): se informa como contraseña incorrecta', async () => {
    const cam = await camaraFalsa({ realm: 'ipcam', qop: false, basicTambien: false, pausaTrasFallo: 3500 });
    try {
      expect(await probarConexion(url(cam.puerto, 'otra'), null, 3000)).toMatchObject({ en_linea: false, diagnostico: 'credenciales_invalidas' });
    } finally {
      cam.cerrar();
    }
  }, 15000);

  it('Digest con qop=auth, opaque y un realm con comas', async () => {
    const cam = await camaraFalsa({ realm: 'Login to 4K00, NVR', qop: true, opaque: 'abc123', basicTambien: false });
    try {
      expect(await probarConexion(url(cam.puerto))).toMatchObject({ en_linea: true, diagnostico: 'ok' });
    } finally {
      cam.cerrar();
    }
  });

  it('solo Basic: responde con Basic; sin desafío conocido no inventa una respuesta', () => {
    const d = { usuario: 'admin', clave: 'x', urlSinCredenciales: 'rtsp://h/r' };
    expect(autorizacion('Basic realm="cam"', d)).toBe(`Basic ${Buffer.from('admin:x').toString('base64')}`);
    expect(autorizacion('Negotiate abc', d)).toBeNull();
    expect(autorizacion('Digest realm="a,b", nonce="n", qop="auth-int,auth"', d, 'c0')).toContain('qop=auth, nc=00000001, cnonce="c0"');
  });
});
