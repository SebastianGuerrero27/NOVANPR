import type { PuertoServidorVideo, PuertoTickets } from './camaras';
import { RE_RUTA_PRUEBA } from '../dominio/camaras';

/**
 * Autorización de las lecturas del servidor de medios (MediaMTX, authMethod: http). MediaMTX
 * consulta antes de cada lectura o publicación y solo continúa si se autoriza:
 *
 *   - Navegador (WebRTC): ticket de 60 s con alcance de video, emitido a un usuario con sesión.
 *   - Motor ANPR (RTSP): usuario "anpr" y el token de servicio.
 *   - La ruta debe ser cam_<id> de una cámara habilitada o una ruta de prueba.
 *   - Publicar o reproducir grabaciones: denegado (las cámaras se leen como fuente).
 */

/** Lo que MediaMTX envía en cada consulta (textos; un campo ausente llega vacío). */
export interface SolicitudLectura {
  user: string;
  password: string;
  action: string;
  path: string;
  protocol: string;
  query: string;
}

export interface DependenciasMedios {
  video: Pick<PuertoServidorVideo, 'camaraDeRuta'>;
  tickets: Pick<PuertoTickets, 'valido' | 'esMotor'>;
}

export function casosMedios(d: DependenciasMedios) {
  return {
    async autorizarLectura(s: SolicitudLectura): Promise<boolean> {
      if (s.action !== 'read') return false;
      const rutaValida = RE_RUTA_PRUEBA.test(s.path) || (await d.video.camaraDeRuta(s.path)) !== null;
      if (!rutaValida) return false;
      if (s.protocol === 'webrtc') return d.tickets.valido(new URLSearchParams(s.query).get('ticket'), 'stream');
      return s.protocol === 'rtsp' && d.tickets.esMotor(s.user, s.password);
    },
  };
}

export type CasosMedios = ReturnType<typeof casosMedios>;
