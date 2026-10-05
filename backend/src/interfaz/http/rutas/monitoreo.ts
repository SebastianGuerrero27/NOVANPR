import { Router } from 'express';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { monitoreo } from '../../../contenedor/camaras';
import { actorDe, controlador } from '../respuesta';
import { controladorExterno } from '../servicioExterno';

/**
 * Monitoreo en vivo.
 *
 *   GET  /estado         estado del motor ANPR y cámara que está procesando   operacion:monitorear
 *   POST /camara-activa  cambia la cámara que procesa el motor                camaras:operar
 *   POST /ticket         credencial de 60 s para el video (WebRTC de MediaMTX  operacion:monitorear
 *                        o WebSocket del motor); `webcam` exige camaras:gestionar
 *
 * Los casos de uso están en aplicacion/monitoreo.ts.
 */
const router = Router();
router.use(authMiddleware);

router.get('/estado', requierePermiso('operacion:monitorear'), controlador('MONITOREO estado', 'No se pudo consultar el estado del motor ANPR.', async (_req, res) => {
  res.json(await monitoreo.estado());
}));

router.post('/camara-activa', requierePermiso('camaras:operar'),
  controladorExterno('MONITOREO cambiar cámara', 'El servicio ANPR no respondió al cambio de cámara.', async (req, res) => {
    const camara = await monitoreo.cambiarCamara(req.body?.camara_id, actorDe(req));
    res.json({ message: `El motor ANPR ahora procesa ${camara.nombre}.` });
  }));

router.post('/ticket', requierePermiso('operacion:monitorear'), controlador('MONITOREO ticket', 'No se pudo emitir la credencial de video.', async (req, res) => {
  res.json(monitoreo.ticket(req.body?.alcance, actorDe(req)));
}));

export default router;
