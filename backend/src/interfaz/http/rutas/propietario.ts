import { Router } from 'express';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { propietario } from '../../../contenedor/propietario';
import { controladorExterno } from '../servicioExterno';
import { actorDe, controlador } from '../respuesta';

/**
 * Consulta de datos del propietario (propietario:consultar; marco legal en infraestructura/servicios/consultaPropietario.ts).
 *
 *   POST /consulta    { placa, motivo, deteccion_id? }   400 · 404 · 429 (cupo por hora) · 503 (sin convenio) · 502
 *   GET  /auditoria   proveedor, si está habilitado y las 200 consultas más recientes
 *
 * Reglas en dominio/propietario.ts y casos de uso en aplicacion/propietario.ts.
 */
const router = Router();
router.use(authMiddleware, requierePermiso('propietario:consultar'));

router.post('/consulta', controladorExterno('PROPIETARIO consulta', 'Error al consultar el servicio oficial.', async (req, res) => {
  res.json(await propietario.consultar(req.body, actorDe(req)));
}));

router.get('/auditoria', controlador('PROPIETARIO auditoría', 'Error al leer la auditoría.', async (_req, res) => {
  res.json(await propietario.auditoria());
}));

export default router;
