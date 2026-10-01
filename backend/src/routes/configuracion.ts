import { Router, Request, Response } from 'express';
import { getDB } from '../config/db';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { cargarConfiguracion, guardarValor, listarConfiguracion, validarValor } from '../services/configuracion';
import { emailService } from '../services/emailService';
import { auditarOperacion } from '../services/seguridad';
import { estadoServicioAnpr } from '../services/servicioAnpr';
import { ZONA_HORARIA } from '../services/tiempo';

/**
 * Configuración del sistema (solo Administrador).
 *
 *   GET /api/configuracion   parámetros editables y datos del entorno (solo lectura)
 *   PUT /api/configuracion   { valores: { clave: valor } } — se validan todos antes de guardar
 */
const router = Router();
router.use(authMiddleware, requierePermiso('configuracion:gestionar'));

router.get('/', async (_req: Request, res: Response) => {
  const anpr = await estadoServicioAnpr();
  return res.json({
    parametros: listarConfiguracion(),
    entorno: {
      zona_horaria: ZONA_HORARIA,
      correo_configurado: emailService.smtpConfigurado(),
      remitente_correo: emailService.smtpConfigurado() ? (process.env.SMTP_FROM || process.env.SMTP_USER || null) : null,
      frontend_url: process.env.FRONTEND_URL || null,
      entorno: process.env.NODE_ENV || 'development',
      anpr,
    },
  });
});

router.put('/', async (req: Request, res: Response) => {
  const valores = req.body?.valores;
  if (!valores || typeof valores !== 'object' || !Object.keys(valores).length) {
    return res.status(400).json({ error: 'No hay cambios para guardar.' });
  }
  const validados: [string, string][] = [];
  for (const [clave, valor] of Object.entries(valores)) {
    const r = validarValor(clave, valor);
    if (r.error) return res.status(400).json({ error: r.error });
    validados.push([clave, r.valor!]);
  }
  try {
    const db = getDB();
    const previos = Object.fromEntries(listarConfiguracion().map(p => [p.clave, p.valor]));
    const cambiados = validados.filter(([c, v]) => previos[c] !== v);
    for (const [clave, valor] of cambiados) {
      await guardarValor(db, clave, valor, req.user!.id);
      await auditarOperacion(db, req, 'CONFIGURACION', 'configuracion', null, `${clave}: ${previos[clave]} → ${valor}`);
    }
    await cargarConfiguracion(db);
    return res.json({ message: cambiados.length ? 'Configuración guardada.' : 'No hubo cambios.', parametros: listarConfiguracion() });
  } catch (e: any) {
    console.error('[CONFIG] guardar:', e.message);
    return res.status(500).json({ error: 'No se pudo guardar la configuración.' });
  }
});

export default router;
