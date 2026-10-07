import { Router } from 'express';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { solicitudes } from '../../../contenedor/solicitudesAcceso';
import { actorDe, controlador, idDe } from '../respuesta';

/**
 * Solicitudes de acceso: el personal pide autorizar una placa (visita, proveedor, vehículo
 * sin permiso detectado en la garita) y el Gestor de permisos la aprueba —creando, reactivando
 * o ampliando el permiso de la lista blanca— o la rechaza con un comentario.
 *
 * Separación de funciones (SoD, NIST RBAC dinámico / principio de los cuatro ojos): quien
 * solicita no puede resolver su propia solicitud, ni siquiera si su rol tiene el permiso.
 *
 *   GET  /                 ?estado=pendiente|resueltas|todas  (quien resuelve ve todas; el resto, las suyas)
 *   GET  /resumen          { pendientes } para el contador del menú
 *   POST /                 crear (solicitudes:crear)
 *   PUT  /:id              editar una solicitud propia pendiente (solicitudes:crear)
 *   POST /:id/aprobar      aprobar con ajustes opcionales (solicitudes:resolver + padron:gestionar)
 *   POST /:id/rechazar     rechazar con comentario (solicitudes:resolver)
 *   POST /:id/cancelar     cancelar una solicitud propia pendiente
 *
 * Evento Socket.IO: solicitudes:actualizadas. Reglas en dominio/solicitudesAcceso.ts y casos
 * de uso en aplicacion/solicitudesAcceso.ts.
 */
const router = Router();
router.use(authMiddleware);

const CONTEXTO = 'SOLICITUDES';

router.get('/', controlador(CONTEXTO, 'No se pudieron consultar las solicitudes.', async (req, res) => {
  res.json(await solicitudes.listar(actorDe(req), { estado: req.query.estado, mias: req.query.mias }));
}));

router.get('/resumen', controlador(CONTEXTO, 'No se pudo consultar el resumen.', async (req, res) => {
  res.json(await solicitudes.resumen(actorDe(req)));
}));

router.post('/', requierePermiso('solicitudes:crear'), controlador(CONTEXTO, 'No se pudo registrar la solicitud.', async (req, res) => {
  const solicitud = await solicitudes.crear(req.body, actorDe(req));
  res.status(201).json({ message: 'Solicitud enviada al gestor de accesos.', solicitud });
}));

router.put('/:id(\\d+)', requierePermiso('solicitudes:crear'), controlador(CONTEXTO, 'No se pudo actualizar la solicitud.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json({ message: 'Solicitud actualizada.', solicitud: await solicitudes.editar(id, req.body, actorDe(req)) });
}));

router.post('/:id(\\d+)/aprobar', requierePermiso('solicitudes:resolver', 'padron:gestionar'),
  controlador(CONTEXTO, 'No se pudo aprobar la solicitud.', async (req, res) => {
    const id = idDe(req, res);
    if (id === null) return;
    const { accion, solicitud, permiso } = await solicitudes.aprobar(id, req.body, actorDe(req));
    res.json({ message: `Solicitud aprobada (${accion}).`, solicitud, permiso });
  }));

router.post('/:id(\\d+)/rechazar', requierePermiso('solicitudes:resolver'), controlador(CONTEXTO, 'No se pudo rechazar la solicitud.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json({ message: 'Solicitud rechazada.', solicitud: await solicitudes.rechazar(id, req.body?.comentario, actorDe(req)) });
}));

router.post('/:id(\\d+)/cancelar', controlador(CONTEXTO, 'No se pudo cancelar la solicitud.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json({ message: 'Solicitud cancelada.', solicitud: await solicitudes.cancelar(id, actorDe(req)) });
}));

export default router;
