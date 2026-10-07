import { Router } from 'express';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { reportes } from '../../../contenedor/reportes';
import { controlador } from '../respuesta';

/**
 * Reporte consolidado de un período (reportes:ver).
 *
 *   GET /?desde=ISO&hasta=ISO&camara=id
 *
 * Por omisión, los últimos 7 días locales; máximo 366 días. Fechas AAAA-MM-DD o ISO 8601 y
 * cámara entera positiva: un valor inválido responde 400 (dominio/periodo.ts).
 */
const router = Router();
router.use(authMiddleware, requierePermiso('reportes:ver'));

router.get('/', controlador('REPORTES', 'No se pudo generar el reporte.', async (req, res) => {
  res.json(await reportes.consolidado(req.query));
}));

export default router;
