/**
 * Publicación de las cámaras en MediaMTX (sincronizarRutas y rutas de prueba) contra un MediaMTX
 * simulado que valida las fuentes como la versión 1.21.1: rechaza «RTSP://», un «%» que no forme un
 * código %XX y caracteres sin codificar en el usuario o la contraseña, y al rechazar una fuente la
 * repite completa (con la contraseña) en su respuesta, como hace la imagen real.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { crearRutaPrueba, eliminarRutaPrueba, sincronizarRutas } from '../../infraestructura/servicios/medios';
import { reiniciarRedes } from '../../infraestructura/servicios/redCamaras';

const mockCamaras: { id: number; rtsp_url: string; rtsp_url_vista: string | null }[] = [];
jest.mock('../../infraestructura/db', () => ({
  getDB: () => ({ request: () => ({ query: async () => ({ recordset: mockCamaras }) }) }),
}));

interface MediamtxSimulado {
  rutas: Map<string, string>;
  /** Rutas cuya alta o cambio falla («*» = todas) */
  fallar: Set<string>;
  solicitudes: string[];
  cerrar: () => Promise<void>;
}

/** Reglas del lector de URL de MediaMTX (Go, net/url) que importan aquí. */
const fuenteAceptada = (f: string) => {
  if (!/^rtsps?:\/\//.test(f) || /%(?![0-9a-fA-F]{2})/.test(f)) return false;
  const autoridad = f.replace(/^rtsps?:\/\//, '').split(/[/?#]/)[0];
  const arroba = autoridad.lastIndexOf('@');
  return arroba === -1 || /^[A-Za-z0-9\-._~!$&'()*+,;=:%@]*$/.test(autoridad.slice(0, arroba));
};

function mediamtx(iniciales: Record<string, string> = {}): Promise<MediamtxSimulado> {
  const rutas = new Map(Object.entries(iniciales));
  const fallar = new Set<string>();
  const solicitudes: string[] = [];
  const srv = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', c => { cuerpo += c; });
    req.on('end', () => {
      const responder = (estado: number, datos: unknown) => {
        res.writeHead(estado, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(datos));
      };
      const url = req.url ?? '';
      solicitudes.push(`${req.method} ${url.split('?')[0]}`);
      if (req.method === 'GET' && url.startsWith('/v3/config/paths/list')) {
        return responder(200, { items: [...rutas].map(([name, source]) => ({ name, source })) });
      }
      const m = url.match(/^\/v3\/config\/paths\/(add|patch|delete)\/(.+)$/);
      if (!m) return responder(404, { status: 'error', error: 'not found' });
      const [, accion, nombre] = m;
      if (accion === 'delete') {
        rutas.delete(nombre);
        return responder(200, {});
      }
      const fuente = String(JSON.parse(cuerpo || '{}').source);
      if (fallar.has(nombre) || fallar.has('*')) return responder(500, { status: 'error', error: `unable to apply '${fuente}'` });
      if (!fuenteAceptada(fuente)) return responder(400, { status: 'error', error: `invalid source: '${fuente}'` });
      rutas.set(nombre, fuente);
      return responder(200, {});
    });
  });
  return new Promise(listo => srv.listen(0, '127.0.0.1', () => {
    process.env.MEDIAMTX_API_URL = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    listo({ rutas, fallar, solicitudes, cerrar: () => new Promise(fin => srv.close(() => fin())) });
  }));
}

describe('MediaMTX · publicación de las cámaras', () => {
  const entorno = { ...process.env };
  let avisos: string[];

  beforeAll(() => {
    delete process.env.CAMARAS_REDES_PERMITIDAS;
    reiniciarRedes();
  });
  beforeEach(() => {
    avisos = [];
    jest.spyOn(console, 'warn').mockImplementation((...partes: unknown[]) => { avisos.push(partes.join(' ')); });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    process.env = entorno;
    reiniciarRedes();
  });

  it('publica cada cámara con una fuente que MediaMTX acepta (la misma credencial) y retira solo las rutas cam_ sobrantes', async () => {
    const mtx = await mediamtx({ cam_9: 'rtsp://admin:vieja@10.0.0.9/x', grabacion: 'rtsp://10.0.0.8/y' });
    mockCamaras.splice(0, mockCamaras.length,
      // Esquema en mayúsculas y contraseña con espacio (cámara registrada antes de validar el formato)
      { id: 1, rtsp_url: 'RTSP://admin:mi clave@10.0.0.5:554/Streaming/Channels/101',
        rtsp_url_vista: 'rtsp://admin:mi clave@10.0.0.5:554/Streaming/Channels/102' },
      // «%» suelto en la contraseña
      { id: 2, rtsp_url: 'rtsp://admin:50%off@10.0.0.6/canal', rtsp_url_vista: null });
    await sincronizarRutas();
    await mtx.cerrar();
    expect(Object.fromEntries(mtx.rutas)).toEqual({
      grabacion: 'rtsp://10.0.0.8/y',
      cam_1: 'rtsp://admin:mi%20clave@10.0.0.5:554/Streaming/Channels/101',
      cam_1_vista: 'rtsp://admin:mi%20clave@10.0.0.5:554/Streaming/Channels/102',
      cam_2: 'rtsp://admin:50%25off@10.0.0.6/canal',
    });
    expect(avisos).toEqual([]);
  });

  it('las sincronizaciones siguientes no vuelven a modificar las rutas ya publicadas', async () => {
    const mtx = await mediamtx();
    mockCamaras.splice(0, mockCamaras.length, { id: 1, rtsp_url: 'RTSP://admin:mi clave@10.0.0.5/101', rtsp_url_vista: null });
    await sincronizarRutas();
    mtx.solicitudes.length = 0;
    await sincronizarRutas();
    await mtx.cerrar();
    expect(mtx.solicitudes).toEqual(['GET /v3/config/paths/list']);
  });

  it('si MediaMTX rechaza una ruta, publica las demás, retira las sobrantes y el aviso no lleva la contraseña', async () => {
    const mtx = await mediamtx({ cam_9: 'rtsp://admin:vieja@10.0.0.9/x' });
    mtx.fallar.add('cam_1');
    mockCamaras.splice(0, mockCamaras.length,
      { id: 1, rtsp_url: 'rtsp://admin:ClaveSecreta123@10.0.0.5/101', rtsp_url_vista: null },
      { id: 2, rtsp_url: 'rtsp://admin:OtraClave@10.0.0.6/101', rtsp_url_vista: null });
    await sincronizarRutas();
    await mtx.cerrar();
    expect([...mtx.rutas.keys()]).toEqual(['cam_2']);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('Ruta cam_1');
    expect(avisos[0]).toContain('rtsp://admin:******@10.0.0.5/101');
    expect(avisos.join('\n')).not.toMatch(/ClaveSecreta123|OtraClave/);
  });

  it('ruta de prueba: entrega la fuente normalizada y, si MediaMTX la rechaza, el error no lleva la contraseña', async () => {
    const mtx = await mediamtx();
    const nombre = await crearRutaPrueba('RTSP://admin:ClaveSecreta123@10.0.0.5:554/x');
    expect(mtx.rutas.get(nombre)).toBe('rtsp://admin:ClaveSecreta123@10.0.0.5:554/x');
    await eliminarRutaPrueba(nombre);
    expect(mtx.rutas.has(nombre)).toBe(false);

    mtx.fallar.add('*');
    const error = await crearRutaPrueba('rtsp://admin:ClaveSecreta123@10.0.0.5:554/x').catch((e: Error) => e);
    await mtx.cerrar();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('rtsp://admin:******@10.0.0.5:554/x');
    expect((error as Error).message).not.toContain('ClaveSecreta123');
  });
});
