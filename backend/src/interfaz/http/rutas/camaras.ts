import { Router } from 'express';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { camaras } from '../../../contenedor/camaras';
import { actorDe, controlador, idDe } from '../respuesta';
import { controladorExterno } from '../servicioExterno';

/**
 * Cámaras / canales RTSP.
 *
 *   GET    /                 listado (credenciales RTSP enmascaradas)        operacion:monitorear
 *   GET    /:id              detalle (mismo formato que el listado)          operacion:monitorear
 *   POST   /                 alta                                            camaras:gestionar
 *   PUT    /:id              edición                                         camaras:gestionar
 *   PATCH  /:id/toggle       habilitar / deshabilitar                        camaras:gestionar
 *   PUT    /:id/roi          región de interés                               camaras:operar
 *   DELETE /:id              eliminación sin historial                       camaras:gestionar
 *   POST   /probar           ping + diagnóstico RTSP de una URL antes de guardarla
 *   POST   /:id/ping         ping ICMP + diagnóstico RTSP (DESCRIBE con autenticación)
 *   POST   /ping-all         diagnóstico de todas las cámaras habilitadas
 *   POST   /:id/video        ruta y ticket para reproducir la cámara por WebRTC (Play)
 *   POST   /prueba-video     ruta temporal para reproducir una URL sin guardar
 *   DELETE /prueba-video/:r  elimina la ruta temporal
 *   GET    /video/:r/estado  estado del flujo en MediaMTX                    operacion:monitorear
 *
 * Diagnóstico y rutas de prueba: camaras:gestionar. `activa` es la habilitación
 * administrativa; `estado` es la conectividad observada (EN_LINEA, SIN_CONEXION,
 * SIN_VERIFICAR). Las reglas están en dominio/camaras.ts y los casos de uso en
 * aplicacion/camaras.ts.
 */
const router = Router();

const ver = [authMiddleware, requierePermiso('operacion:monitorear')];
const gestionar = [authMiddleware, requierePermiso('camaras:gestionar')];
const operar = [authMiddleware, requierePermiso('camaras:operar')];

router.get('/', ...ver, controlador('CAMARAS listar', 'Error al listar las cámaras.', async (_req, res) => {
  res.json(await camaras.listar());
}));

router.get('/:id(\\d+)', ...ver, controlador('CAMARAS detalle', 'Error al consultar la cámara.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json(await camaras.obtener(id));
}));

router.post('/', ...gestionar, controlador('CAMARAS alta', 'Error al registrar la cámara.', async (req, res) => {
  res.status(201).json({ message: 'Cámara registrada.', camera: await camaras.registrar(req.body, actorDe(req)) });
}));

router.put('/:id(\\d+)', ...gestionar, controlador('CAMARAS edición', 'Error al actualizar la cámara.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json({ message: 'Cámara actualizada.', camera: await camaras.editar(id, req.body, actorDe(req)) });
}));

router.patch('/:id(\\d+)/toggle', ...gestionar, controlador('CAMARAS toggle', 'Error al cambiar el estado de la cámara.', async (req, res) => {
  const id = idDe(req, res);
  if (id === null) return;
  const { camara, activa } = await camaras.alternar(id, actorDe(req));
  res.json({ message: activa ? 'Cámara habilitada.' : 'Cámara deshabilitada.', camera: camara });
}));

/** { roi: [[x, y], ...] } con vértices normalizados (0–1), o { roi: null } para el cuadro completo. */
router.put('/:id(\\d+)/roi', ...operar, controlador('CAMARAS región de interés', 'Error al guardar la región de interés.', async (req, res) => {
  const id = idDe(req, res);
  if (id === null) return;
  const { camara, roi } = await camaras.fijarRoi(id, req.body?.roi, actorDe(req));
  res.json({ message: roi ? 'Región de interés guardada.' : 'Región de interés eliminada: se analiza el cuadro completo.', camera: camara });
}));

router.delete('/:id(\\d+)', ...gestionar, controlador('CAMARAS eliminar', 'Error al eliminar la cámara.', async (req, res) => {
  const id = idDe(req, res);
  if (id === null) return;
  await camaras.eliminar(id, actorDe(req));
  res.json({ message: 'Cámara eliminada.' });
}));

router.post('/probar', ...gestionar, controlador('CAMARAS probar', 'Error al probar la conexión.', async (req, res) => {
  res.json(await camaras.probar(req.body));
}));

router.post('/:id(\\d+)/ping', ...gestionar, controlador('CAMARAS ping', 'Error al probar la conexión.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json(await camaras.diagnosticar(id));
}));

router.post('/ping-all', ...gestionar, controlador('CAMARAS ping-all', 'Error al probar las cámaras.', async (_req, res) => {
  res.json(await camaras.diagnosticarTodas());
}));

router.post('/:id(\\d+)/video', ...ver, controladorExterno('CAMARAS video', 'El servidor de video no respondió.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json(await camaras.video(id, actorDe(req)));
}));

router.post('/prueba-video', ...gestionar, controladorExterno('CAMARAS prueba de video', 'El servidor de video no respondió.', async (req, res) => {
  res.json(await camaras.pruebaVideo(req.body, actorDe(req)));
}));

router.delete('/prueba-video/:ruta', ...gestionar, controlador('CAMARAS prueba de video', 'No se pudo eliminar la ruta de prueba.', async (req, res) => {
  await camaras.eliminarPruebaVideo(req.params.ruta);
  res.json({ ok: true });
}));

router.get('/video/:ruta/estado', ...ver, controlador('CAMARAS estado de video', 'No se pudo consultar el servidor de video.', async (req, res) => {
  res.json(await camaras.estadoVideo(req.params.ruta));
}));

export default router;
