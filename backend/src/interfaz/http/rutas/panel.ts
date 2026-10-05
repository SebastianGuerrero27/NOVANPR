import { Router } from 'express';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { panel } from '../../../contenedor/panel';
import { actorDe, controlador } from '../respuesta';

/**
 * Datos del panel de inicio. Todo se calcula con los registros reales: si no hay detecciones,
 * los indicadores valen cero (no hay datos de relleno).
 *
 *   GET /resumen          operación del día y de los últimos 7 días (operacion:monitorear)
 *   GET /accesos          solicitudes, padrón, denegados y reincidentes (padron:gestionar)
 *   GET /administracion   cuentas, accesos, actividad y estado de los servicios (usuarios:gestionar)
 *
 * Casos de uso en aplicacion/panel.ts.
 */
const router = Router();

router.get('/resumen', authMiddleware, requierePermiso('operacion:monitorear'),
  controlador('PANEL resumen', 'No se pudo obtener el resumen del panel.', async (_req, res) => {
    res.json(await panel.resumen());
  }));

router.get('/accesos', authMiddleware, requierePermiso('padron:gestionar'),
  controlador('PANEL accesos', 'No se pudo obtener el panel de accesos.', async (req, res) => {
    res.json(await panel.accesos(actorDe(req)));
  }));

router.get('/administracion', authMiddleware, requierePermiso('usuarios:gestionar'),
  controlador('PANEL administración', 'No se pudo obtener el panel de administración.', async (_req, res) => {
    res.json(await panel.administracion());
  }));

export default router;
