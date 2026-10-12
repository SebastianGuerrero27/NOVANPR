import { normalizarFuente } from '../../dominio/detecciones';

describe('Detecciones · fuente de la detección', () => {
  it('una URL RTSP (con o sin credenciales) se guarda como «rtsp»: nunca la URL', () => {
    expect(normalizarFuente('rtsp://anpr:token-de-servicio@mediamtx:8554/cam_1')).toBe('rtsp');
    expect(normalizarFuente('RTSPS://u:p@camara:322/ruta')).toBe('rtsp');
    expect(normalizarFuente('http://x/y')).toBe('rtsp');
  });

  it('identificadores cortos se conservan; ausente o inválido → «rtsp»', () => {
    expect(normalizarFuente('rtsp')).toBe('rtsp');
    expect(normalizarFuente('manual')).toBe('manual');
    for (const malo of [undefined, null, '', '   ', 5, {}, 'con espacios', 'x'.repeat(21), '<script>']) {
      expect(normalizarFuente(malo)).toBe('rtsp');
    }
  });
});
