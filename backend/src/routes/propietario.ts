import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { crearProveedorPropietario, enmascararIdentificacion } from '../services/consultaPropietario';
import { normalizePlate } from '../services/plateMatching';

/**
 * Consulta de datos del propietario (ver services/consultaPropietario.ts para el marco legal).
 *
 *   POST /api/propietario/consulta   { placa, motivo, deteccion_id? }   (solo Admin)
 *   GET  /api/propietario/auditoria                                     (solo Admin)
 *
 * Reglas: motivo obligatorio (base legal de la consulta), límite de consultas por hora y por
 * usuario, y registro de TODAS las consultas (incluidas las rechazadas) en la auditoría.
 */
const router = Router();
const proveedor = crearProveedorPropietario();
const LIMITE_POR_HORA = Number(process.env.PROPIETARIO_LIMITE_HORA ?? 20);

async function auditar(db: sql.ConnectionPool, req: Request, placa: string, motivo: string, detId: number | null, resultado: string) {
  await db.request()
    .input('uid', sql.Int, req.user?.id ?? 0)
    .input('unom', sql.VarChar(100), req.user?.nombre ?? req.user?.username ?? null)
    .input('placa', sql.VarChar(20), placa)
    .input('motivo', sql.VarChar(255), motivo.substring(0, 255))
    .input('det', sql.Int, detId)
    .input('prov', sql.VarChar(50), proveedor.nombre)
    .input('res', sql.VarChar(20), resultado)
    .query(`
      INSERT INTO AuditoriaConsultaPropietario (usuario_id, usuario_nombre, placa, motivo, deteccion_id, proveedor, resultado)
      VALUES (@uid, @unom, @placa, @motivo, @det, @prov, @res)
    `);
}

router.post('/consulta', authMiddleware, requierePermiso('propietario:consultar'), async (req: Request, res: Response) => {
  const placa = normalizePlate(req.body?.placa);
  const motivo = String(req.body?.motivo ?? '').trim();
  const detId = Number.isInteger(req.body?.deteccion_id) ? req.body.deteccion_id : null;

  if (placa.length < 5) return res.status(400).json({ error: 'Placa inválida.' });
  if (motivo.length < 10) {
    return res.status(400).json({ error: 'Debe indicar el motivo de la consulta (mínimo 10 caracteres); queda registrado en la auditoría.' });
  }

  try {
    const db = getDB();
    const uso = await db.request()
      .input('uid', sql.Int, req.user?.id ?? 0)
      .query('SELECT COUNT(*) AS n FROM AuditoriaConsultaPropietario WHERE usuario_id = @uid AND fecha >= DATEADD(HOUR, -1, GETDATE())');
    if (uso.recordset[0].n >= LIMITE_POR_HORA) {
      await auditar(db, req, placa, motivo, detId, 'limite');
      return res.status(429).json({ error: `Límite de ${LIMITE_POR_HORA} consultas por hora alcanzado.` });
    }

    if (!proveedor.habilitado) {
      await auditar(db, req, placa, motivo, detId, 'deshabilitado');
      return res.status(503).json({
        disponible: false,
        error:
          'La consulta de propietarios no está habilitada. Requiere un convenio del ECU 911 con DINARDAP / ANT ' +
          'para acceder a su servicio web oficial; la extracción automatizada de portales públicos (SRI, ANT) no está permitida.',
      });
    }

    const datos = await proveedor.consultar(placa);
    await auditar(db, req, placa, motivo, detId, datos ? 'ok' : 'no_encontrado');
    if (!datos) return res.status(404).json({ error: 'No se encontraron datos para la placa.' });
    return res.json({ placa, ...datos, identificacion: enmascararIdentificacion(datos.identificacion) });
  } catch (error: any) {
    console.error('[PROPIETARIO] Error en la consulta:', error.message);
    try { await auditar(getDB(), req, placa, motivo, detId, 'error'); } catch { /* la auditoría no debe ocultar el error original */ }
    return res.status(502).json({ error: 'Error al consultar el servicio oficial.' });
  }
});

router.get('/auditoria', authMiddleware, requierePermiso('propietario:consultar'), async (_req: Request, res: Response) => {
  try {
    const r = await getDB().request().query(`
      SELECT TOP 200 id, usuario_nombre, placa, motivo, deteccion_id, proveedor, resultado, fecha
      FROM AuditoriaConsultaPropietario ORDER BY fecha DESC
    `);
    return res.json({ proveedor: proveedor.nombre, habilitado: proveedor.habilitado, consultas: r.recordset });
  } catch (error: any) {
    return res.status(500).json({ error: 'Error al leer la auditoría.' });
  }
});

export default router;
