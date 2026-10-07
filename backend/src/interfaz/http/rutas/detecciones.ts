import { Router } from 'express';
import { authMiddleware, requierePermiso, servicioMiddleware } from '../middlewares/auth';
import { detecciones } from '../../../contenedor/detecciones';
import { actorDe, controlador, idDe } from '../respuesta';

/**
 * Detecciones vehiculares (cada paso por un acceso).
 *
 * Servicio ANPR (X-Servicio-Token)
 *   POST /ingreso              fase 1: captura fotográfica, estado pendiente_ocr
 *   POST /completar-ocr        fase 2: lectura OCR y cruce con listas
 *   POST /descarte             auditoría de falsos positivos descartados
 * Personal autenticado
 *   GET  /                     historial paginado con filtros
 *   GET  /recientes            últimos N pasos (monitoreo)
 *   GET  /exportar             CSV con los mismos filtros del historial
 *   GET  /buscar-placa/:placa  situación de una placa en las listas y su historial
 *   GET  /:id                  detalle completo con lectura automática, metadatos y auditoría
 *   POST /validar/:id          corrección / confirmación del personal (excepción con accesos:excepcion)
 *   POST /registro-manual      paso registrado a mano (cámara sin lectura, visita, etc.)
 *   DELETE /:id                detecciones:eliminar, con motivo auditado (borra también la evidencia)
 *   DELETE /                   eliminación masiva (todas o las filtradas), detecciones:eliminar
 *
 * Eventos Socket.IO: deteccion:nueva, deteccion:actualizada, deteccion:alerta, deteccion:eliminada,
 * deteccion:eliminadas. Reglas en dominio/detecciones.ts; casos de uso en aplicacion/detecciones.ts.
 */
const router = Router();
const monitorear = [authMiddleware, requierePermiso('operacion:monitorear')];
const validar = [authMiddleware, requierePermiso('detecciones:validar')];
const eliminar = [authMiddleware, requierePermiso('detecciones:eliminar')];

// ─── Servicio ANPR ───────────────────────────────────────────────────────────

router.post('/ingreso', servicioMiddleware, controlador('DETECCIONES fase 1', 'Error interno al registrar el ingreso.', async (req, res) => {
  const r = await detecciones.ingreso(req.body);
  res.status(r.nuevo ? 201 : 200).json(r.respuesta);
}));

router.post('/completar-ocr', servicioMiddleware, controlador('DETECCIONES fase 2', 'Error interno al completar el OCR.', async (req, res) => {
  res.json(await detecciones.completarOcr(req.body));
}));

router.post('/descarte', servicioMiddleware, controlador('DETECCIONES descarte', 'Error al registrar el descarte.', async (req, res) => {
  res.status(201).json(await detecciones.descarte(req.body));
}));

// ─── Consultas del personal ──────────────────────────────────────────────────

router.get('/', ...monitorear, controlador('DETECCIONES listar', 'Error al consultar las detecciones.', async (req, res) => {
  res.json(await detecciones.listar(req.query));
}));

router.get('/recientes', ...monitorear, controlador('DETECCIONES recientes', 'Error al consultar los ingresos recientes.', async (req, res) => {
  res.json(await detecciones.recientes(req.query.limite));
}));

router.get('/exportar', ...monitorear, controlador('DETECCIONES exportar', 'Error al exportar.', async (req, res) => {
  const { nombre, contenido } = await detecciones.exportar(req.query, actorDe(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send(contenido);
}));

router.get('/buscar-placa/:placa', ...monitorear, controlador('DETECCIONES buscar placa', 'Error al buscar la placa.', async (req, res) => {
  res.json(await detecciones.buscarPlaca(req.params.placa));
}));

router.get('/:id(\\d+)', ...monitorear, controlador('DETECCIONES detalle', 'Error al consultar la detección.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json(await detecciones.detalle(id));
}));

// ─── Acciones del personal ───────────────────────────────────────────────────

router.post('/validar/:id(\\d+)', ...validar, controlador('DETECCIONES validar', 'Error al registrar la validación.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json(await detecciones.validar(id, req.body, actorDe(req)));
}));

router.post('/registro-manual', ...validar, controlador('DETECCIONES registro manual', 'Error al registrar el ingreso manual.', async (req, res) => {
  res.status(201).json(await detecciones.registroManual(req.body, actorDe(req)));
}));

router.delete('/:id(\\d+)', ...eliminar, controlador('DETECCIONES eliminar', 'Error al eliminar la detección.', async (req, res) => {
  const id = idDe(req, res);
  if (id !== null) res.json(await detecciones.eliminar(id, req.body?.motivo, actorDe(req)));
}));

router.delete('/', ...eliminar, controlador('DETECCIONES eliminación masiva', 'Error al eliminar las detecciones.', async (req, res) => {
  res.json(await detecciones.eliminarMasivo(req.query, req.body, actorDe(req)));
}));

export default router;
