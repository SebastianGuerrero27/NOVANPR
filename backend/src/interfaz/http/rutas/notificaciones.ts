import { Router } from 'express';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { notificaciones } from '../../../contenedor/notificaciones';
import { actorDe, controlador, idDe } from '../respuesta';

/**
 * Bandeja de notificaciones de la sesión (cada usuario ve solo las suyas).
 *
 *   GET    /                         bandeja: ?limite (1-100), ?antes_de=<id> (paginación), ?desde=<id>
 *                                    (recuperación tras reconectar), ?filtro=no_leidas|pendientes
 *   GET    /resumen                  { no_leidas, pendientes } para la campana del encabezado
 *   GET    /catalogo                 tipos de notificación (etiqueta, prioridad, canales)
 *   POST   /:id/leer                 marca como leída
 *   POST   /leer-todas               marca todas como leídas
 *   POST   /:id/reconocer            reconocimiento (ACK) de una alarma
 *   POST   /reconocer-deteccion/:id  ACK de las alarmas de un paso (botón "Enterado" del aviso de garita)
 *   GET    /push/clave               clave pública VAPID y si el canal push está activo
 *   POST   /push/suscripcion         registra la suscripción push del navegador
 *   DELETE /push/suscripcion         la elimina (el usuario desactivó las notificaciones)
 *   POST   /push/prueba              envía un push de prueba a los equipos del usuario
 *   GET    /metricas                 indicadores del canal para la evaluación (evaluacion:ver), ?dias (1-90)
 *
 * Casos de uso en aplicacion/notificaciones.ts.
 */
const router = Router();
router.use(authMiddleware);

router.get('/', controlador('NOTIFICACIONES bandeja', 'No se pudieron obtener las notificaciones.', async (req, res) => {
  res.json(await notificaciones.bandeja(actorDe(req), req.query));
}));

router.get('/resumen', controlador('NOTIFICACIONES resumen', 'No se pudo obtener el resumen de notificaciones.', async (req, res) => {
  res.json(await notificaciones.resumen(actorDe(req)));
}));

router.get('/catalogo', (_req, res) => {
  res.json(notificaciones.catalogo());
});

router.post('/leer-todas', controlador('NOTIFICACIONES leer todas', 'No se pudieron marcar las notificaciones.', async (req, res) => {
  res.json(await notificaciones.leerTodas(actorDe(req)));
}));

router.post('/:id(\\d+)/leer', controlador('NOTIFICACIONES leer', 'No se pudo marcar la notificación.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json(await notificaciones.leer(actorDe(req), id));
}));

router.post('/:id(\\d+)/reconocer', controlador('NOTIFICACIONES reconocer', 'No se pudo registrar el reconocimiento.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json(await notificaciones.reconocer(actorDe(req), id));
}));

router.post('/reconocer-deteccion/:id(\\d+)', controlador('NOTIFICACIONES reconocer detección', 'No se pudo registrar el reconocimiento.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json(await notificaciones.reconocerDeteccion(actorDe(req), id));
}));

// ─── Web Push ────────────────────────────────────────────────────────────────

router.get('/push/clave', (_req, res) => {
  res.json(notificaciones.clavePush());
});

router.post('/push/suscripcion', controlador('NOTIFICACIONES suscripción', 'No se pudo registrar la suscripción.', async (req, res) => {
  res.status(201).json(await notificaciones.suscribir(actorDe(req), req.body, req.headers['user-agent']));
}));

router.delete('/push/suscripcion', controlador('NOTIFICACIONES baja de suscripción', 'No se pudo eliminar la suscripción.', async (req, res) => {
  res.json(await notificaciones.desuscribir(actorDe(req), req.body));
}));

router.post('/push/prueba', controlador('NOTIFICACIONES prueba push', 'No se pudo enviar la prueba.', async (req, res) => {
  res.json(await notificaciones.probarPush(actorDe(req)));
}));

// ─── Indicadores para la evaluación científica del canal ─────────────────────

router.get('/metricas', requierePermiso('evaluacion:ver'),
  controlador('NOTIFICACIONES métricas', 'No se pudieron calcular las métricas de notificación.', async (req, res) => {
    res.json(await notificaciones.metricas(req.query));
  }));

export default router;
