import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware, requierePermiso } from '../middlewares/auth';

/**
 * Consulta de auditoría (solo Administrador), paginada y con filtros.
 *
 *   GET /api/auditoria?fuente=operaciones|cuentas|accesos&q=&desde=&hasta=&resultado=exito|fallo&pagina=&tamano=
 *
 *   operaciones  detecciones, listas, cámaras, monitoreo y configuración (AuditoriaOperaciones)
 *   cuentas      registro, verificación, altas, cambios de rol/estado, bloqueos (AuditoriaUsuarios)
 *   accesos      cada intento de inicio de sesión (AuditoriaAccesos)
 */
const router = Router();
router.use(authMiddleware, requierePermiso('auditoria:ver'));

const FUENTES = {
  operaciones: {
    tabla: 'AuditoriaOperaciones',
    columnas: 'id, fecha, usuario_email AS actor, accion, entidad, entidad_id, detalle, ip',
    busqueda: ['usuario_email', 'accion', 'entidad', 'detalle'],
  },
  cuentas: {
    tabla: 'AuditoriaUsuarios',
    columnas: 'id, fecha, actor_email AS actor, accion, objetivo_email AS objetivo, detalle, ip',
    busqueda: ['actor_email', 'objetivo_email', 'accion', 'detalle'],
  },
  accesos: {
    tabla: 'AuditoriaAccesos',
    columnas: 'id, fecha, email, exito, motivo, ip, user_agent',
    busqueda: ['email', 'motivo', 'ip'],
  },
} as const;

router.get('/', async (req: Request, res: Response) => {
  const fuente = FUENTES[String(req.query.fuente) as keyof typeof FUENTES] ?? FUENTES.operaciones;
  const tamano = Math.min(100, Math.max(10, Number(req.query.tamano) || 25));
  const pagina = Math.max(1, Number(req.query.pagina) || 1);

  const filtros: string[] = ['1 = 1'];
  const params: [string, any, any][] = [];
  const q = String(req.query.q ?? '').trim();
  if (q) {
    params.push(['q', sql.NVarChar(200), `%${q.substring(0, 100)}%`]);
    filtros.push(`(${fuente.busqueda.map(c => `${c} LIKE @q`).join(' OR ')})`);
  }
  if (req.query.desde && !Number.isNaN(Date.parse(String(req.query.desde)))) {
    params.push(['desde', sql.DateTime2, new Date(String(req.query.desde))]);
    filtros.push('fecha >= @desde');
  }
  if (req.query.hasta && !Number.isNaN(Date.parse(String(req.query.hasta)))) {
    params.push(['hasta', sql.DateTime2, new Date(String(req.query.hasta))]);
    filtros.push('fecha <= @hasta');
  }
  if (fuente === FUENTES.accesos && (req.query.resultado === 'exito' || req.query.resultado === 'fallo')) {
    filtros.push(`exito = ${req.query.resultado === 'exito' ? 1 : 0}`);
  }

  const peticion = () => {
    const r = getDB().request();
    for (const [n, t, v] of params) r.input(n, t, v);
    return r;
  };
  try {
    const where = filtros.join(' AND ');
    const total = (await peticion().query(`SELECT COUNT(*) AS n FROM ${fuente.tabla} WHERE ${where}`)).recordset[0].n;
    const r = await peticion()
      .input('offset', sql.Int, (pagina - 1) * tamano).input('tamano', sql.Int, tamano)
      .query(`SELECT ${fuente.columnas} FROM ${fuente.tabla} WHERE ${where}
              ORDER BY fecha DESC OFFSET @offset ROWS FETCH NEXT @tamano ROWS ONLY`);
    return res.json({ items: r.recordset, total, pagina, tamano });
  } catch (e: any) {
    console.error('[AUDITORIA] consulta:', e.message);
    return res.status(500).json({ error: 'No se pudo consultar la auditoría.' });
  }
});

export default router;
