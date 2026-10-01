import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { destinoRtsp, diagnosticar, probarConexion, registrarConexion } from '../services/conectividadCamaras';
import { crearRutaPrueba, eliminarRutaPrueba, emitirTicket, estadoRuta, rutaCamara, sincronizarRutas, urlWebrtcPublica } from '../services/medios';
import { auditarOperacion } from '../services/seguridad';
import { emitEvent } from '../services/socket';
import { parsearRoi, sincronizarCamaraMotor, validarRoi } from '../services/camaraMotor';
import { fijarRoiAnpr } from '../services/servicioAnpr';

/**
 * Cámaras / canales RTSP.
 *
 *   GET    /                 listado (credenciales RTSP enmascaradas)
 *   POST   /                 alta                         (Administrador)
 *   PUT    /:id              edición                      (Administrador)
 *   PATCH  /:id/toggle       habilitar / deshabilitar     (Administrador)
 *   DELETE /:id              eliminación sin historial    (Administrador)
 *   POST   /probar           ping + diagnóstico RTSP de una URL antes de guardarla (Administrador)
 *   POST   /:id/ping         ping ICMP + diagnóstico RTSP (DESCRIBE con autenticación)
 *   POST   /ping-all         diagnóstico de todas las cámaras habilitadas
 *   POST   /:id/video        ruta y ticket para reproducir la cámara por WebRTC (Play)
 *   POST   /prueba-video     ruta temporal para reproducir una URL sin guardar (Administrador)
 *   DELETE /prueba-video/:r  elimina la ruta temporal
 *   GET    /video/:r/estado  estado del flujo en MediaMTX
 *
 * `activa` es la habilitación administrativa; `estado` es la conectividad observada
 * (EN_LINEA, SIN_CONEXION, SIN_VERIFICAR).
 */
const router = Router();

const MASCARA = '******';
const RE_CREDENCIALES = /^(rtsp:\/\/[^:@/]+:)([^@]+)(@)/i;

const enmascarar = (url: string) => url.replace(RE_CREDENCIALES, `$1${MASCARA}$3`);

function mapear(c: any) {
  return {
    id: c.id, nombre: c.nombre, ip: c.ip, ubicacion: c.ubicacion,
    rtsp_url: enmascarar(c.rtsp_url || ''),
    tiene_credenciales: RE_CREDENCIALES.test(c.rtsp_url || ''),
    activa: Boolean(c.activa),
    estado: c.estado || 'SIN_VERIFICAR',
    ultimo_ping: c.ultimo_ping, tiempo_respuesta_ms: c.tiempo_respuesta_ms, mensaje_ping: c.mensaje_ping,
    created_at: c.created_at, detecciones: c.detecciones ?? undefined,
    roi: parsearRoi(c.roi),
  };
}

const SELECT = `
  SELECT c.*, (SELECT COUNT(*) FROM DeteccionVehiculo d WHERE d.camara_id = c.id) AS detecciones
  FROM Camaras c`;

function leer(body: any, original?: string): { datos?: { nombre: string; ubicacion: string; rtsp: string; ip: string }; error?: string } {
  const nombre = String(body?.nombre ?? '').trim();
  const ubicacion = String(body?.ubicacion ?? '').trim();
  let rtsp = String(body?.rtsp_url ?? '').trim();
  if (nombre.length < 3 || nombre.length > 100) return { error: 'El nombre debe tener entre 3 y 100 caracteres.' };
  if (ubicacion.length < 3 || ubicacion.length > 150) return { error: 'La ubicación debe tener entre 3 y 150 caracteres.' };
  // Si el formulario devuelve la URL enmascarada se conserva la contraseña guardada
  if (original && rtsp.includes(MASCARA)) {
    const clave = original.match(RE_CREDENCIALES)?.[2];
    if (clave) rtsp = rtsp.replace(MASCARA, clave);
  }
  if (!/^rtsps?:\/\//i.test(rtsp) || rtsp.length > 255) return { error: 'Ingrese una URL RTSP válida (rtsp://…).' };
  const ipCampo = String(body?.ip ?? '').trim();
  const destino = destinoRtsp(rtsp, ipCampo || null);
  if (!destino) return { error: 'No se pudo determinar el host de la cámara. Revise la URL o la IP.' };
  return { datos: { nombre, ubicacion, rtsp, ip: ipCampo || destino.host } };
}

router.get('/', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const r = await getDB().request().query(`${SELECT} ORDER BY c.nombre`);
    return res.json(r.recordset.map(mapear));
  } catch (e: any) {
    console.error('[CAMARAS] listar:', e.message);
    return res.status(500).json({ error: 'Error al listar las cámaras.' });
  }
});

router.post('/', authMiddleware, requierePermiso('camaras:gestionar'), async (req: Request, res: Response) => {
  const { datos, error } = leer(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const db = getDB();
    const ins = await db.request()
      .input('nombre', sql.NVarChar(100), datos!.nombre)
      .input('ip', sql.VarChar(45), datos!.ip.substring(0, 45))
      .input('rtsp', sql.VarChar(255), datos!.rtsp)
      .input('ubicacion', sql.NVarChar(150), datos!.ubicacion)
      .input('usuario', sql.Int, req.user!.id)
      .query(`INSERT INTO Camaras (nombre, ip, rtsp_url, ubicacion, activa, estado, created_at, registrado_por)
              OUTPUT INSERTED.id VALUES (@nombre, @ip, @rtsp, @ubicacion, 1, 'SIN_VERIFICAR', GETDATE(), @usuario)`);
    const id = ins.recordset[0].id;
    await auditarOperacion(db, req, 'CAMARA_ALTA', 'camara', id, `${datos!.nombre} · ${datos!.ubicacion}`);
    // Primera verificación en segundo plano
    probarConexion(datos!.rtsp, datos!.ip).then(r => registrarConexion(id, r, true)).catch(() => undefined);
    sincronizarRutas().then(() => sincronizarCamaraMotor()).catch(() => undefined);
    const cam = mapear((await db.request().input('id', sql.Int, id).query(`${SELECT} WHERE c.id = @id`)).recordset[0]);
    emitEvent('camara:actualizada', cam);
    return res.status(201).json({ message: 'Cámara registrada.', camera: cam });
  } catch (e: any) {
    console.error('[CAMARAS] alta:', e.message);
    return res.status(500).json({ error: 'Error al registrar la cámara.' });
  }
});

router.put('/:id(\\d+)', authMiddleware, requierePermiso('camaras:gestionar'), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    const db = getDB();
    const actual = (await db.request().input('id', sql.Int, id).query('SELECT * FROM Camaras WHERE id = @id')).recordset[0];
    if (!actual) return res.status(404).json({ error: 'Cámara no encontrada.' });
    const { datos, error } = leer(req.body, actual.rtsp_url);
    if (error) return res.status(400).json({ error });
    await db.request()
      .input('id', sql.Int, id)
      .input('nombre', sql.NVarChar(100), datos!.nombre)
      .input('ip', sql.VarChar(45), datos!.ip.substring(0, 45))
      .input('rtsp', sql.VarChar(255), datos!.rtsp)
      .input('ubicacion', sql.NVarChar(150), datos!.ubicacion)
      .query(`UPDATE Camaras SET nombre = @nombre, ip = @ip, rtsp_url = @rtsp, ubicacion = @ubicacion,
                estado = CASE WHEN rtsp_url <> @rtsp THEN 'SIN_VERIFICAR' ELSE estado END,
                fecha_actualizacion = SYSDATETIME()
              WHERE id = @id`);
    const cambios = [
      actual.nombre !== datos!.nombre && 'nombre', actual.ubicacion !== datos!.ubicacion && 'ubicación',
      actual.rtsp_url !== datos!.rtsp && 'URL RTSP', actual.ip !== datos!.ip && 'IP',
    ].filter(Boolean).join(', ');
    await auditarOperacion(db, req, 'CAMARA_EDICION', 'camara', id, `${datos!.nombre}: ${cambios || 'sin cambios'}`);
    if (actual.rtsp_url !== datos!.rtsp) {
      probarConexion(datos!.rtsp, datos!.ip).then(r => registrarConexion(id, r, true)).catch(() => undefined);
      // MediaMTX reabre la cámara con la URL nueva; el motor sigue leyendo la misma ruta cam_<id>
      sincronizarRutas().catch(() => undefined);
    }
    const cam = mapear((await db.request().input('id', sql.Int, id).query(`${SELECT} WHERE c.id = @id`)).recordset[0]);
    emitEvent('camara:actualizada', cam);
    return res.json({ message: 'Cámara actualizada.', camera: cam });
  } catch (e: any) {
    console.error('[CAMARAS] edición:', e.message);
    return res.status(500).json({ error: 'Error al actualizar la cámara.' });
  }
});

router.patch('/:id(\\d+)/toggle', authMiddleware, requierePermiso('camaras:gestionar'), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    const db = getDB();
    const r = await db.request().input('id', sql.Int, id).query(`
      UPDATE Camaras SET activa = CASE WHEN activa = 1 THEN 0 ELSE 1 END, fecha_actualizacion = SYSDATETIME()
      OUTPUT INSERTED.nombre, INSERTED.activa WHERE id = @id`);
    if (!r.recordset.length) return res.status(404).json({ error: 'Cámara no encontrada.' });
    const { nombre, activa } = r.recordset[0];
    await auditarOperacion(db, req, activa ? 'CAMARA_HABILITADA' : 'CAMARA_DESHABILITADA', 'camara', id, nombre);
    sincronizarRutas().then(() => sincronizarCamaraMotor()).catch(() => undefined);
    const cam = mapear((await db.request().input('id', sql.Int, id).query(`${SELECT} WHERE c.id = @id`)).recordset[0]);
    emitEvent('camara:actualizada', cam);
    return res.json({ message: activa ? 'Cámara habilitada.' : 'Cámara deshabilitada.', camera: cam });
  } catch (e: any) {
    console.error('[CAMARAS] toggle:', e.message);
    return res.status(500).json({ error: 'Error al cambiar el estado de la cámara.' });
  }
});

/**
 * Región de interés de la cámara: polígono con vértices normalizados (0–1) sobre el cuadro.
 * El motor solo busca placas cuyo centro cae dentro (máscara de detección de OpenALPR).
 * { roi: [[x, y], ...] } o { roi: null } para usar el cuadro completo.
 */
router.put('/:id(\\d+)/roi', authMiddleware, requierePermiso('camaras:operar'), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { roi, error } = validarRoi(req.body?.roi ?? null);
  if (error) return res.status(400).json({ error });
  try {
    const db = getDB();
    const r = await db.request().input('id', sql.Int, id).input('roi', sql.NVarChar(1000), roi ? JSON.stringify(roi) : null)
      .query('UPDATE Camaras SET roi = @roi, fecha_actualizacion = SYSDATETIME() OUTPUT INSERTED.nombre WHERE id = @id');
    if (!r.recordset.length) return res.status(404).json({ error: 'Cámara no encontrada.' });
    await auditarOperacion(db, req, 'CAMARA_ROI', 'camara', id,
      `${r.recordset[0].nombre}: ${roi ? `región de ${roi.length} vértices` : 'cuadro completo'}`);
    // Si el motor procesa esta cámara la aplica al instante; si no, al activarla
    fijarRoiAnpr(id, roi ?? null).catch(() => undefined);
    const cam = mapear((await db.request().input('id', sql.Int, id).query(`${SELECT} WHERE c.id = @id`)).recordset[0]);
    emitEvent('camara:actualizada', cam);
    return res.json({ message: roi ? 'Región de interés guardada.' : 'Región de interés eliminada: se analiza el cuadro completo.', camera: cam });
  } catch (e: any) {
    console.error('[CAMARAS] región de interés:', e.message);
    return res.status(500).json({ error: 'Error al guardar la región de interés.' });
  }
});

router.delete('/:id(\\d+)', authMiddleware, requierePermiso('camaras:gestionar'), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    const db = getDB();
    const c = (await db.request().input('id', sql.Int, id).query(`${SELECT} WHERE c.id = @id`)).recordset[0];
    if (!c) return res.status(404).json({ error: 'Cámara no encontrada.' });
    if (c.detecciones > 0) {
      return res.status(409).json({ error: `La cámara tiene ${c.detecciones} detecciones registradas: deshabilítela en lugar de eliminarla para conservar el historial.` });
    }
    await db.request().input('id', sql.Int, id).query('DELETE FROM Camaras WHERE id = @id');
    await auditarOperacion(db, req, 'CAMARA_ELIMINADA', 'camara', id, c.nombre);
    emitEvent('camara:eliminada', { id });
    sincronizarRutas().then(() => sincronizarCamaraMotor()).catch(() => undefined);
    return res.json({ message: 'Cámara eliminada.' });
  } catch (e: any) {
    console.error('[CAMARAS] eliminar:', e.message);
    return res.status(500).json({ error: 'Error al eliminar la cámara.' });
  }
});

/** Recupera la contraseña guardada cuando el formulario envía la URL enmascarada. */
async function urlReal(rtsp: string, camaraId: number): Promise<string> {
  if (!Number.isInteger(camaraId) || !rtsp.includes(MASCARA)) return rtsp;
  const original = (await getDB().request().input('id', sql.Int, camaraId).query('SELECT rtsp_url FROM Camaras WHERE id = @id')).recordset[0]?.rtsp_url;
  const clave = original?.match(RE_CREDENCIALES)?.[2];
  return clave ? rtsp.replace(MASCARA, clave) : rtsp;
}

/** Ping + diagnóstico RTSP de una URL que aún no se guarda (formulario). */
router.post('/probar', authMiddleware, requierePermiso('camaras:gestionar'), async (req: Request, res: Response) => {
  try {
    const rtsp = await urlReal(String(req.body?.rtsp_url ?? '').trim(), Number(req.body?.camara_id));
    return res.json(await diagnosticar(rtsp, String(req.body?.ip ?? '').trim() || null));
  } catch (e: any) {
    console.error('[CAMARAS] probar:', e.message);
    return res.status(500).json({ error: 'Error al probar la conexión.' });
  }
});

/** Ping ICMP (conectividad de red) + diagnóstico RTSP de una cámara registrada. */
router.post('/:id(\\d+)/ping', authMiddleware, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    const c = (await getDB().request().input('id', sql.Int, id).query('SELECT rtsp_url, ip FROM Camaras WHERE id = @id')).recordset[0];
    if (!c) return res.status(404).json({ error: 'Cámara no encontrada.' });
    const r = await diagnosticar(c.rtsp_url, c.ip);
    await registrarConexion(id, r.rtsp, true);
    return res.json(r);
  } catch (e: any) {
    console.error('[CAMARAS] ping:', e.message);
    return res.status(500).json({ error: 'Error al probar la conexión.' });
  }
});

router.post('/ping-all', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const r = await getDB().request().query('SELECT id, nombre, rtsp_url, ip FROM Camaras WHERE activa = 1');
    const detalles = await Promise.all(r.recordset.map(async c => {
      const d = await diagnosticar(c.rtsp_url, c.ip);
      await registrarConexion(c.id, d.rtsp, true);
      return { id: c.id, nombre: c.nombre, ...d };
    }));
    return res.json({ total: detalles.length, en_linea: detalles.filter(d => d.rtsp.en_linea).length, detalles });
  } catch (e: any) {
    console.error('[CAMARAS] ping-all:', e.message);
    return res.status(500).json({ error: 'Error al probar las cámaras.' });
  }
});

/**
 * Reproducción de prueba (“Play”): ruta de MediaMTX y ticket para verla por WebRTC.
 * Una cámara registrada usa su ruta cam_<id>; para el formulario se crea una ruta temporal
 * (se elimina al cerrar la vista previa o a los 3 minutos).
 */
router.post('/:id(\\d+)/video', authMiddleware, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    const c = (await getDB().request().input('id', sql.Int, id).query('SELECT activa FROM Camaras WHERE id = @id')).recordset[0];
    if (!c) return res.status(404).json({ error: 'Cámara no encontrada.' });
    if (!c.activa) return res.status(409).json({ error: 'Habilite la cámara para reproducir su video.' });
    await sincronizarRutas();
    return res.json({ ruta: rutaCamara(id), ticket: emitirTicket(req.user!.id, 'stream'), webrtc: urlWebrtcPublica() });
  } catch (e: any) {
    console.error('[CAMARAS] video:', e.message);
    return res.status(502).json({ error: 'El servidor de video no respondió.' });
  }
});

router.post('/prueba-video', authMiddleware, requierePermiso('camaras:gestionar'), async (req: Request, res: Response) => {
  try {
    const rtsp = await urlReal(String(req.body?.rtsp_url ?? '').trim(), Number(req.body?.camara_id));
    if (!destinoRtsp(rtsp)) return res.status(400).json({ error: 'URL RTSP inválida.' });
    const ruta = await crearRutaPrueba(rtsp);
    return res.json({ ruta, ticket: emitirTicket(req.user!.id, 'stream'), webrtc: urlWebrtcPublica() });
  } catch (e: any) {
    console.error('[CAMARAS] prueba de video:', e.message);
    return res.status(502).json({ error: 'El servidor de video no respondió.' });
  }
});

router.delete('/prueba-video/:ruta', authMiddleware, requierePermiso('camaras:gestionar'), async (req: Request, res: Response) => {
  await eliminarRutaPrueba(req.params.ruta);
  return res.json({ ok: true });
});

/** Estado del flujo en el servidor de video (fuente lista, lectores, pistas). */
router.get('/video/:ruta/estado', authMiddleware, async (req: Request, res: Response) => {
  if (!/^(cam_\d+|prueba_[a-f0-9]{12})$/.test(req.params.ruta)) return res.status(400).json({ error: 'Ruta inválida.' });
  return res.json(await estadoRuta(req.params.ruta) ?? { lista: false, lectores: 0, pistas: [] });
});

export default router;
