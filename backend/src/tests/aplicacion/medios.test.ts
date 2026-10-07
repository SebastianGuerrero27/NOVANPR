import { casosMedios, type SolicitudLectura } from '../../aplicacion/medios';
import type { AlcanceTicket } from '../../dominio/camaras';

/** Autorización de las lecturas de MediaMTX con dobles de prueba (sin base de datos ni token real). */

const TICKET = 'eyJ1IjoxLCJhIjoic3RyZWFtIn0.firma';

function preparar() {
  const video = { camaraDeRuta: jest.fn(async (ruta: string) => (ruta === 'cam_3' ? 3 : null)) };
  const tickets = {
    valido: jest.fn((ticket: string | null | undefined, alcance: AlcanceTicket) => ticket === TICKET && alcance === 'stream'),
    esMotor: jest.fn((usuario: string, clave: string) => usuario === 'anpr' && clave === 'token-servicio'),
  };
  return { casos: casosMedios({ video, tickets }), video, tickets };
}

/** Consulta de MediaMTX: por omisión, un navegador que lee cam_3 por WebRTC con un ticket vigente. */
const lectura = (s: Partial<SolicitudLectura> = {}): SolicitudLectura => ({
  user: '', password: '', action: 'read', path: 'cam_3', protocol: 'webrtc', query: `ticket=${TICKET}`, ...s,
});

describe('Casos de uso · autorización de MediaMTX', () => {
  it('navegador: lectura WebRTC de una cámara habilitada con un ticket de video vigente', async () => {
    const { casos, tickets } = preparar();
    expect(await casos.autorizarLectura(lectura())).toBe(true);
    expect(tickets.valido).toHaveBeenCalledWith(TICKET, 'stream');
    expect(await casos.autorizarLectura(lectura({ query: 'ticket=vencido' }))).toBe(false);
    expect(await casos.autorizarLectura(lectura({ query: '' }))).toBe(false);
  });

  it('motor ANPR: lectura RTSP con el usuario y el token de servicio', async () => {
    const { casos } = preparar();
    const motor = { protocol: 'rtsp', user: 'anpr', password: 'token-servicio', query: '' };
    expect(await casos.autorizarLectura(lectura(motor))).toBe(true);
    expect(await casos.autorizarLectura(lectura({ ...motor, password: 'otra' }))).toBe(false);
    // Las credenciales del motor no sirven por otro protocolo
    expect(await casos.autorizarLectura(lectura({ ...motor, protocol: 'hls' }))).toBe(false);
  });

  it('rutas de prueba (formulario de cámaras): se autorizan sin consultar la base', async () => {
    const { casos, video } = preparar();
    expect(await casos.autorizarLectura(lectura({ path: 'prueba_0123456789ab' }))).toBe(true);
    expect(video.camaraDeRuta).not.toHaveBeenCalled();
  });

  it('deniega publicar o reproducir grabaciones, rutas desconocidas y cámaras deshabilitadas', async () => {
    const { casos, tickets } = preparar();
    for (const s of [{ action: 'publish' }, { action: 'playback' }, { path: 'cam_9' }, { path: 'prueba_XYZ' }, { path: '' }]) {
      expect(await casos.autorizarLectura(lectura(s))).toBe(false);
    }
    // Se deniega antes de mirar el ticket
    expect(tickets.valido).not.toHaveBeenCalled();
  });
});
