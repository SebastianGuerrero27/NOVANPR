import { Router } from 'express';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { auditoria } from '../../../contenedor/auditoria';
import { actorDe, controlador } from '../respuesta';

/**
 * Auditoría (auditoria:ver, solo Administrador). Es inmutable (ISO/IEC 27001 A.8.15, OWASP
 * ASVS V7, NIST SP 800-92): ninguna ruta edita ni borra registros; la retención los traslada a
 * las tablas de archivo sin perder evidencia.
 *
 *   GET  /                    consulta paginada ?fuente=&q=&desde=&hasta=&resultado=exito|fallo&pagina=&tamano=
 *   GET  /exportar            CSV (UTF-8 con BOM) con los mismos filtros, hasta 50 000 registros
 *   GET  /:fuente/:id         un registro con todas sus columnas
 *   POST /retencion           { dias } archiva los registros con más de `dias` días (365 a 3650)
 *
 *   operaciones  detecciones, listas, cámaras, solicitudes y configuración (AuditoriaOperaciones)
 *   cuentas      registro, verificación, altas, cambios de rol/estado, bloqueos (AuditoriaUsuarios)
 *   accesos      cada intento de inicio de sesión (AuditoriaAccesos)
 *
 * Reglas en dominio/auditoria.ts y casos de uso en aplicacion/auditoria.ts.
 */
const router = Router();
router.use(authMiddleware, requierePermiso('auditoria:ver'));

const CONTEXTO = 'AUDITORIA';

/** Marca de orden de bytes (U+FEFF): Excel abre el CSV como UTF-8 y muestra bien tildes y ñ. */
const BOM_UTF8 = String.fromCharCode(0xfeff);

router.get('/', controlador(CONTEXTO, 'No se pudo consultar la auditoría.', async (req, res) => {
  res.json(await auditoria.consultar(req.query));
}));

router.get('/exportar', controlador(CONTEXTO, 'No se pudo exportar la auditoría.', async (req, res) => {
  const { nombre, contenido } = await auditoria.exportar(req.query, actorDe(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  // Evidencia con datos personales: que ningún intermediario ni el navegador la guarde en caché
  res.setHeader('Cache-Control', 'no-store');
  res.send(`${BOM_UTF8}${contenido}`);
}));

router.get('/:fuente(operaciones|cuentas|accesos)/:id(\\d+)', controlador(CONTEXTO, 'No se pudo consultar el registro de auditoría.', async (req, res) => {
  res.json(await auditoria.obtener(req.params.fuente, req.params.id));
}));

router.post('/retencion', controlador(CONTEXTO, 'No se pudo aplicar la retención de la auditoría.', async (req, res) => {
  res.json(await auditoria.aplicarRetencion(req.body?.dias, actorDe(req)));
}));

export default router;
