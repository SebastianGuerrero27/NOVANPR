import { direccionPermitida, reiniciarRedes, verificarRed } from '../../infraestructura/servicios/redCamaras';

/** Redes a las que el sistema puede conectarse como cámara (protección contra SSRF). */
describe('Redes permitidas para cámaras', () => {
  const entorno = process.env.CAMARAS_REDES_PERMITIDAS;
  afterEach(() => {
    if (entorno === undefined) delete process.env.CAMARAS_REDES_PERMITIDAS;
    else process.env.CAMARAS_REDES_PERMITIDAS = entorno;
    reiniciarRedes();
  });

  it('por omisión solo redes privadas', () => {
    delete process.env.CAMARAS_REDES_PERMITIDAS;
    reiniciarRedes();
    for (const ip of ['10.79.10.104', '172.18.0.5', '192.168.1.64', '100.64.0.1', 'fd00::5', '::ffff:192.168.1.64']) {
      expect([ip, direccionPermitida(ip)]).toEqual([ip, true]);
    }
    for (const ip of ['8.8.8.8', '127.0.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', '::ffff:127.0.0.1', 'no-es-ip']) {
      expect([ip, direccionPermitida(ip)]).toEqual([ip, false]);
    }
  });

  it('CAMARAS_REDES_PERMITIDAS limita a la VLAN de cámaras; los metadatos de la nube nunca se permiten', () => {
    process.env.CAMARAS_REDES_PERMITIDAS = '10.79.10.0/24, 169.254.0.0/16, basura';
    reiniciarRedes();
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(direccionPermitida('10.79.10.104')).toBe(true);
    expect(direccionPermitida('10.79.11.1')).toBe(false);
    expect(direccionPermitida('192.168.1.64')).toBe(false);
    expect(direccionPermitida('169.254.169.254')).toBe(false);
    expect(aviso).toHaveBeenCalledWith(expect.stringContaining('basura'));
    aviso.mockRestore();
  });

  it('verificarRed comprueba el host de la URL y la IP del ping, resolviendo los nombres', async () => {
    delete process.env.CAMARAS_REDES_PERMITIDAS;
    reiniciarRedes();
    const dns = jest.fn(async (host: string) => {
      if (host === 'camara-garita') return [{ address: '192.168.1.64' }];
      if (host === 'metadatos.nube') return [{ address: '169.254.169.254' }];
      throw new Error('ENOTFOUND');
    });
    expect(await verificarRed('rtsp://u:p@192.168.1.64:554/x', null, dns)).toBeNull();
    expect(await verificarRed('rtsp://camara-garita/x', null, dns)).toBeNull();
    expect(await verificarRed('rtsp://u:p@8.8.8.8/x', null, dns)).toMatch(/8\.8\.8\.8 está fuera de las redes permitidas/);
    expect(await verificarRed('rtsp://metadatos.nube/x', null, dns)).toMatch(/metadatos\.nube \(169\.254\.169\.254\)/);
    expect(await verificarRed('rtsp://192.168.1.64/x', '127.0.0.1', dns)).toMatch(/127\.0\.0\.1/);
    // Un nombre que no resuelve no se rechaza aquí (la conexión fallará y se comprueba al conectar)
    expect(await verificarRed('rtsp://sin-dns/x', null, dns)).toBeNull();
    expect(await verificarRed('no es url', null, dns)).toBe('URL RTSP inválida.');
  });
});
