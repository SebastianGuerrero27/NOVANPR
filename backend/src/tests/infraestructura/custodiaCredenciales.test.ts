import crypto from 'crypto';
import type { ConnectionPool } from 'mssql';
import {
  conClaveVigente, estaProtegida, proteger, protegerCredencialesGuardadas, reiniciarClave, revelar,
} from '../../infraestructura/servicios/custodiaCredenciales';
import { enmascarar, MASCARA } from '../../dominio/camaras';

/** Custodia AES-256-GCM de las contraseñas RTSP (clave de prueba; sin base de datos). */

const CLAVE_PRUEBA = crypto.randomBytes(32).toString('base64');
// Contraseña típica de Hikvision (exige símbolos), codificada para URL como la arma el formulario
const URL = `rtsp://admin:${encodeURIComponent('Ecu911@Garita#2026:/x$&')}@192.168.1.64:554/Streaming/Channels/101`;

/** Cifra con una configuración de claves dada y restaura la de la prueba. */
function cifrarCon(entorno: Record<string, string | undefined>, url = URL): string {
  const antes = { ...process.env };
  Object.assign(process.env, entorno);
  for (const [k, v] of Object.entries(entorno)) if (v === undefined) delete process.env[k];
  reiniciarClave();
  const p = proteger(url);
  process.env = antes;
  reiniciarClave();
  return p;
}

/** Pool de SQL Server en memoria: la consulta inicial devuelve `filas` y los UPDATE se registran. */
function poolFalso(filas: { id: number; rtsp_url: string; rtsp_url_vista: string | null }[]) {
  const actualizaciones: Record<string, unknown>[] = [];
  const pool = {
    request() {
      const entradas: Record<string, unknown> = {};
      const req = {
        input(nombre: string, _tipo: unknown, valor: unknown) { entradas[nombre] = valor; return req; },
        async query(texto: string) {
          if (/^SELECT/i.test(texto)) return { recordset: filas };
          actualizaciones.push(entradas);
          return { rowsAffected: [1] };
        },
      };
      return req;
    },
  };
  return { pool: pool as unknown as ConnectionPool, actualizaciones };
}

describe('Custodia de credenciales RTSP (AES-256-GCM)', () => {
  const entorno = { ...process.env };
  beforeEach(() => {
    process.env.CAMARAS_CLAVE_CIFRADO = CLAVE_PRUEBA;
    reiniciarClave();
  });
  afterAll(() => {
    process.env = entorno;
    reiniciarClave();
  });

  it('cifra solo la contraseña: usuario, host y ruta quedan legibles y la contraseña no aparece', () => {
    const p = proteger(URL);
    expect(estaProtegida(p)).toBe(true);
    expect(p).toMatch(/^rtsp:\/\/admin:enc\.v1\.[\w-]+\.[\w-]+@192\.168\.1\.64:554\/Streaming\/Channels\/101$/);
    expect(p).not.toContain('Ecu911');
    expect(revelar(p)).toBe(URL);
  });

  it('cada cifrado usa un IV aleatorio, es idempotente y deja igual una URL sin contraseña', () => {
    const a = proteger(URL);
    expect(proteger(URL)).not.toBe(a);
    expect(proteger(a)).toBe(a);
    for (const sin of ['rtsp://192.168.1.64:554/live', 'rtsp://admin@192.168.1.64/live']) {
      expect(proteger(sin)).toBe(sin);
      expect(revelar(sin)).toBe(sin);
    }
    expect(revelar(URL)).toBe(URL); // en claro (anterior a la migración): se usa tal cual
  });

  it('la máscara de la API también oculta la contraseña cifrada', () => {
    expect(enmascarar(proteger(URL))).toBe(`rtsp://admin:${MASCARA}@192.168.1.64:554/Streaming/Channels/101`);
  });

  it('un dato alterado o una clave distinta no se descifra (autenticación GCM)', () => {
    const p = proteger(URL);
    const alterada = p.replace(/(\.[\w-]{4})([\w-])/, (_m, a: string, c: string) => `${a}${c === 'A' ? 'B' : 'A'}`);
    expect(() => revelar(alterada)).toThrow('Credencial de cámara ilegible');
    process.env.CAMARAS_CLAVE_CIFRADO = crypto.randomBytes(32).toString('base64');
    reiniciarClave();
    expect(() => revelar(p)).toThrow('la clave de cifrado cambió');
  });

  it('exige una clave de 32 bytes; sin clave propia se deriva de JWT_SECRET', () => {
    process.env.CAMARAS_CLAVE_CIFRADO = Buffer.from('corta').toString('base64');
    reiniciarClave();
    expect(() => proteger(URL)).toThrow('32 bytes');
    delete process.env.CAMARAS_CLAVE_CIFRADO;
    process.env.JWT_SECRET = 'secreto-de-prueba';
    reiniciarClave();
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(revelar(proteger(URL))).toBe(URL);
    expect(aviso).toHaveBeenCalledWith(expect.stringContaining('se deriva de JWT_SECRET'));
    aviso.mockRestore();
  });

  it('rotación: lo cifrado con CAMARAS_CLAVE_CIFRADO_ANTERIOR se lee y se vuelve a cifrar con la vigente', () => {
    const anterior = crypto.randomBytes(32).toString('base64');
    const vieja = cifrarCon({ CAMARAS_CLAVE_CIFRADO: anterior });
    expect(() => revelar(vieja)).toThrow('la clave de cifrado cambió');
    process.env.CAMARAS_CLAVE_CIFRADO_ANTERIOR = `${crypto.randomBytes(32).toString('base64')},${anterior}`;
    reiniciarClave();
    expect(revelar(vieja)).toBe(URL);
    const nueva = conClaveVigente(vieja);
    expect(nueva).not.toBe(vieja);
    expect(conClaveVigente(nueva)).toBe(nueva);
    delete process.env.CAMARAS_CLAVE_CIFRADO_ANTERIOR;
    reiniciarClave();
    expect(revelar(nueva)).toBe(URL); // ya no depende de la clave anterior
  });

  it('definir la clave propia no pierde lo cifrado con la clave derivada de JWT_SECRET', () => {
    process.env.JWT_SECRET = 'secreto-de-prueba';
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const derivada = cifrarCon({ CAMARAS_CLAVE_CIFRADO: undefined, JWT_SECRET: 'secreto-de-prueba' });
    aviso.mockRestore();
    expect(revelar(derivada)).toBe(URL);
    expect(revelar(conClaveVigente(derivada))).toBe(URL);
  });

  it('al arrancar cifra lo que está en claro, recifra lo de una clave anterior y no se detiene por una ilegible', async () => {
    const anterior = crypto.randomBytes(32).toString('base64');
    const vigente = proteger(URL);
    const filas = [
      { id: 1, rtsp_url: URL, rtsp_url_vista: URL.replace('101', '102') },
      { id: 2, rtsp_url: cifrarCon({ CAMARAS_CLAVE_CIFRADO: anterior }), rtsp_url_vista: null },
      { id: 3, rtsp_url: vigente, rtsp_url_vista: null },
      { id: 4, rtsp_url: cifrarCon({ CAMARAS_CLAVE_CIFRADO: crypto.randomBytes(32).toString('base64') }), rtsp_url_vista: null },
      { id: 5, rtsp_url: 'rtsp://192.168.1.70:554/live', rtsp_url_vista: null },
    ];
    process.env.CAMARAS_CLAVE_CIFRADO_ANTERIOR = anterior;
    reiniciarClave();
    const { pool, actualizaciones } = poolFalso(filas);
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const registro = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await protegerCredencialesGuardadas(pool)).toBe(2);
    expect(actualizaciones.map(a => a.id)).toEqual([1, 2]);
    for (const a of actualizaciones) {
      expect(estaProtegida(String(a.rtsp))).toBe(true);
      expect(revelar(String(a.rtsp))).toBe(URL);
    }
    expect(revelar(String(actualizaciones[0].vista))).toBe(URL.replace('101', '102'));
    expect(aviso).toHaveBeenCalledWith(expect.stringContaining('Cámara 4'));
    aviso.mockRestore();
    registro.mockRestore();
    delete process.env.CAMARAS_CLAVE_CIFRADO_ANTERIOR;
  });
});
