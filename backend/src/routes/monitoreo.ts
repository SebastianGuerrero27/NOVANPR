import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { tienePermiso } from '../dominio/permisos';
import { cambiarCamaraAnpr, estadoServicioAnpr, urlPublicaAnpr } from '../services/servicioAnpr';
import { emitirTicket, rutaCamara, urlLecturaMotor, urlWebrtcPublica } from '../services/medios';
import { auditarOperacion } from '../services/seguridad';
import { camaraDeseada, guardarCamaraMotor, motorProcesa } from '../services/camaraMotor';
import { sincronizarRutas } from '../services/medios';
import { emitEvent } from '../services/socket';

/**
 * Monitoreo en vivo.
 *
 *   GET  /estado         estado del motor ANPR y cámara que está procesando
 *   POST /camara-activa  cambia la cámara que procesa el motor (permiso camaras:operar)
 *   POST /ticket         credencial de 60 s para el video (WebRTC de MediaMTX o WebSocket del motor)
 */
const router = Router();
router.use(authMiddleware);

router.get('/estado', async (_req: Request, res: Response) => {
  const estado = await estadoServicioAnpr();
  if (!estado.en_linea) return res.json(estado);
  // La cámara activa se informa solo si el motor procesa realmente su URL registrada
  const deseada = await camaraDeseada().catch(() => null);
  const procesa = await motorProcesa(deseada).catch(() => false);
  return res.json({
    ...estado,
    camara_activa: procesa && deseada ? { id: deseada.id, conectada: Boolean(estado.camara_activa?.conectada) } : null,
    fuente_externa: !procesa,
  });
});

router.post('/camara-activa', requierePermiso('camaras:operar'), async (req: Request, res: Response) => {
  const id = Number(req.body?.camara_id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Seleccione una cámara.' });
  try {
    const db = getDB();
    const c = (await db.request().input('id', sql.Int, id).query('SELECT id, nombre, rtsp_url, activa FROM Camaras WHERE id = @id')).recordset[0];
    if (!c) return res.status(404).json({ error: 'Cámara no encontrada.' });
    if (!c.activa) return res.status(409).json({ error: 'La cámara está deshabilitada.' });
    await guardarCamaraMotor(id, req.user!.id);
    await sincronizarRutas();
    await cambiarCamaraAnpr({ id: c.id, nombre: c.nombre, rtsp_url: urlLecturaMotor(rutaCamara(c.id)) }, true);
    await auditarOperacion(db, req, 'MONITOREO_CAMARA', 'camara', id, `Motor ANPR procesando ${c.nombre}`);
    emitEvent('monitoreo:camara', { camara_id: id, nombre: c.nombre, por: req.user!.nombre });
    return res.json({ message: `El motor ANPR ahora procesa ${c.nombre}.` });
  } catch (e: any) {
    console.error('[MONITOREO] cambiar cámara:', e.message);
    return res.status(502).json({ error: 'El servicio ANPR no respondió al cambio de cámara.' });
  }
});

router.post('/ticket', (req: Request, res: Response) => {
  const alcance = req.body?.alcance === 'webcam' ? 'webcam' : 'stream';
  // Enviar la webcam del navegador al motor es un modo de prueba: solo Administrador
  if (alcance === 'webcam' && !tienePermiso(req.user!.rol, 'camaras:gestionar')) {
    return res.status(403).json({ error: 'Solo el administrador puede usar la webcam como fuente de prueba.' });
  }
  return res.json({ ticket: emitirTicket(req.user!.id, alcance), url: urlPublicaAnpr(), webrtc: urlWebrtcPublica() });
});

export default router;
