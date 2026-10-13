/**
 * Cliente del motor ANPR: el estado que ve el monitoreo (incluida la latencia desde la captura de
 * cada cuadro) y el envío de las zonas de la cámara.
 */
import { estadoServicioAnpr, fijarZonasAnpr, zonasActivasAnpr } from '../../infraestructura/servicios/servicioAnpr';

const LATENCIA = {
  edad_cuadro: { p50_ms: 140, p95_ms: 320, max_ms: 410, muestras: 300 },
  lectura_en_vivo: { p50_ms: 780, p95_ms: 1350, max_ms: 1600, muestras: 42 },
  registro: { p50_ms: 1900, p95_ms: 2600, max_ms: 2700, muestras: 9 },
  cuadros_descartados_pct: 86.4,
};

describe('Cliente del motor ANPR', () => {
  const fetchOriginal = global.fetch;
  let llamadas: { url: string; init?: RequestInit }[];

  beforeEach(() => {
    llamadas = [];
    global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const ruta = String(url);
      llamadas.push({ url: ruta, init });
      const cuerpo = ruta.endsWith('/status')
        ? { capture_fps: 25, tracker_fps: 3.1, detector: 'license_plate_detector.pt', ocr_engine: 'fastalpr', ocr_verifier: null, latencia: LATENCIA }
        : ruta.endsWith('/api/camera/active')
          ? { camera_id: 3, is_connected: true, roi: [[0, 0.2], [1, 0.2], [1, 1]], exclusiones: [[[0.7, 0], [1, 0], [1, 0.2]]] }
          : { success: true };
      return { ok: true, status: 200, json: async () => cuerpo } as Response;
    }) as typeof fetch;
  });
  afterAll(() => { global.fetch = fetchOriginal; });

  it('el estado del motor incluye la latencia desde la captura de cada cuadro', async () => {
    const e = await estadoServicioAnpr();
    expect(e).toMatchObject({ en_linea: true, fps_captura: 25, fps_procesamiento: 3.1, latencia: LATENCIA, camara_activa: { id: 3, conectada: true } });
  });

  it('las zonas viajan juntas al motor y se leen las vigentes', async () => {
    await fijarZonasAnpr(3, null, [[[0.7, 0], [1, 0], [1, 0.2]]]);
    const envio = llamadas.find(l => l.url.endsWith('/api/camera/roi'));
    expect(JSON.parse(String(envio?.init?.body))).toEqual({ camara_id: 3, roi: null, exclusiones: [[[0.7, 0], [1, 0], [1, 0.2]]] });
    expect(await zonasActivasAnpr()).toEqual({ roi: [[0, 0.2], [1, 0.2], [1, 1]], exclusiones: [[[0.7, 0], [1, 0], [1, 0.2]]] });
  });
});
