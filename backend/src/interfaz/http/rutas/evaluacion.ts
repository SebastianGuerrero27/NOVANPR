import { Router } from 'express';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { evaluacion } from '../../../contenedor/evaluacion';
import { controlador } from '../respuesta';

/**
 * Evaluación científica del sistema con datos de operación (evaluacion:ver).
 *
 *   GET /resumen?desde=AAAA-MM-DD&hasta=AAAA-MM-DD&camara_id=   métricas con IC 95 %
 *   GET /export.csv?desde=…&hasta=…&camara_id=                  una fila por paso vehicular
 *
 * Días inclusivos (el final se cuenta hasta las 23:59:59) y cámara entera positiva: un valor
 * inválido responde 400. Métricas en dominio/evaluacion.ts; casos de uso en aplicacion/evaluacion.ts.
 */
const router = Router();
router.use(authMiddleware, requierePermiso('evaluacion:ver'));

router.get('/resumen', controlador('EVALUACION resumen', 'Error al calcular las métricas de evaluación.', async (req, res) => {
  res.json(await evaluacion.resumen(req.query));
}));

router.get('/export.csv', controlador('EVALUACION exportar', 'Error al exportar los datos de evaluación.', async (req, res) => {
  const contenido = await evaluacion.exportar(req.query);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="evaluacion_anpr.csv"');
  res.send(contenido);
}));

export default router;
