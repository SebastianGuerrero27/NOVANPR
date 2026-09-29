import { Router, Request, Response } from 'express';
import { camaraDeRuta, esMotor, ticketValido } from '../services/medios';

/**
 * Autorización de MediaMTX (authMethod: http). MediaMTX consulta este endpoint antes de
 * cada lectura o publicación y solo continúa si la respuesta es 2xx.
 *
 *   - Navegador (WebRTC, lectura): ticket de 60 s en la consulta (?ticket=…) emitido a un
 *     usuario con sesión válida; ruta cam_<id> de una cámara habilitada o ruta de prueba.
 *   - Motor ANPR (RTSP, lectura): usuario "anpr" y ANPR_SERVICE_TOKEN.
 *   - Publicar o reproducir grabaciones: denegado (las cámaras se leen como fuente).
 */
const router = Router();

router.post('/autorizar', async (req: Request, res: Response) => {
  const { user = '', password = '', action = '', path = '', protocol = '', query = '' } = req.body ?? {};
  try {
    if (action !== 'read') return res.status(401).end();
    const rutaValida = /^prueba_[a-f0-9]{12}$/.test(path) || (await camaraDeRuta(path)) !== null;
    if (!rutaValida) return res.status(401).end();

    if (protocol === 'webrtc') {
      const ticket = new URLSearchParams(String(query)).get('ticket');
      return ticketValido(ticket, 'stream') ? res.status(200).end() : res.status(401).end();
    }
    if (protocol === 'rtsp' && esMotor(String(user), String(password))) return res.status(200).end();
    return res.status(401).end();
  } catch (e: any) {
    console.error('[MEDIOS] autorizar:', e.message);
    return res.status(401).end();
  }
});

export default router;
