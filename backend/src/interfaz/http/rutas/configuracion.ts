import { Router } from 'express';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { configuracion } from '../../../contenedor/configuracion';
import { actorDe, controlador } from '../respuesta';

/**
 * Configuración del sistema (configuracion:gestionar, solo Administrador).
 *
 *   GET /   parámetros editables (valor vigente y origen) y datos del entorno (solo lectura)
 *   PUT /   { valores: { clave: valor } } — cada valor se valida según el tipo declarado del
 *           parámetro antes de guardar; una clave desconocida o un valor inválido responden 400
 *           sin guardar nada. Cada cambio queda en la auditoría.
 *
 * Reglas en dominio/configuracion.ts y casos de uso en aplicacion/configuracion.ts.
 */
const router = Router();
router.use(authMiddleware, requierePermiso('configuracion:gestionar'));

const CONTEXTO = 'CONFIG';

router.get('/', controlador(CONTEXTO, 'No se pudo consultar la configuración.', async (_req, res) => {
  res.json(await configuracion.consultar());
}));

router.put('/', controlador(CONTEXTO, 'No se pudo guardar la configuración.', async (req, res) => {
  const { cambiados, parametros } = await configuracion.guardar(req.body?.valores, actorDe(req));
  res.json({ message: cambiados ? 'Configuración guardada.' : 'No hubo cambios.', parametros });
}));

export default router;
