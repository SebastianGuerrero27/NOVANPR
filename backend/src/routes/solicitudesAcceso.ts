import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import { tienePermiso } from '../dominio/permisos';
import { describirHorario, leerHorario } from '../dominio/horario';
import { auditarOperacion } from '../services/seguridad';
import { emitEvent } from '../services/socket';
import { notificar } from '../services/notificaciones';
import {
  actualizarRegistro, AUTORIZADOS, avisarListas, CATEGORIAS_PERMISO, guardarRegistro, leerCuerpo, obtenerRegistro,
} from './listas';

/**
 * Solicitudes de acceso: el personal pide autorizar una placa (visita, proveedor, vehículo
 * sin permiso detectado en la garita) y el Gestor de accesos la aprueba —creando, reactivando o
 * ampliando el permiso del padrón— o la rechaza con un comentario.
 *
 * Separación de funciones (SoD, NIST RBAC dinámico / principio de los cuatro ojos): quien
 * solicita no puede resolver su propia solicitud, ni siquiera si su rol tiene el permiso.
 *
 *   GET  /                 ?estado=pendiente|resueltas|todas  (quien resuelve ve todas; el resto, las suyas)
 *   GET  /resumen          { pendientes } para el contador del menú
 *   POST /                 crear (solicitudes:crear)
 *   POST /:id/aprobar      aprobar con ajustes opcionales (solicitudes:resolver)
 *   POST /:id/rechazar     rechazar con comentario (solicitudes:resolver)
 *   POST /:id/cancelar     cancelar una solicitud propia pendiente
 *
 * Evento Socket.IO: solicitudes:actualizadas
 */
const router = Router();
router.use(authMiddleware);

const SELECT = `
  SELECT s.*, us.nombre_completo AS solicitante_nombre, us.email AS solicitante_email,
         ur.nombre_completo AS resolutor_nombre,
         CAST(CASE WHEN EXISTS (SELECT 1 FROM ListaNegra l WHERE l.activo = 1
              AND REPLACE(REPLACE(l.placa, '-', ''), ' ', '') = s.placa) THEN 1 ELSE 0 END AS BIT) AS en_lista_alertas,
         (SELECT TOP 1 v.id FROM VehiculosAutorizados v WHERE v.activo = 1
              AND REPLACE(REPLACE(v.placa, '-', ''), ' ', '') = s.placa) AS permiso_actual_id
  FROM SolicitudesAcceso s
  JOIN Usuarios us ON us.id = s.solicitado_por
  LEFT JOIN Usuarios ur ON ur.id = s.resuelto_por`;

const fecha = (v: any) => (v ? new Date(v).toISOString().slice(0, 10) : null);

function mapear(s: any) {
  return {
    id: s.id,
    placa: s.placa,
    propietario: s.propietario,
    departamento: s.departamento,
    categoria: s.categoria,
    motivo: s.motivo,
    vehiculo: { tipo: s.tipo_vehiculo, marca: s.marca, modelo: s.modelo, color: s.color },
    fecha_inicio: fecha(s.fecha_inicio),
    fecha_fin: fecha(s.fecha_fin),
    horario: leerHorario(s.horario),
    horario_texto: describirHorario(s.horario),
    deteccion_id: s.deteccion_id,
    estado: s.estado,
    solicitante: { id: s.solicitado_por, nombre: s.solicitante_nombre, email: s.solicitante_email },
    fecha_solicitud: s.fecha_solicitud,
    resolutor: s.resuelto_por ? { id: s.resuelto_por, nombre: s.resolutor_nombre } : null,
    fecha_resolucion: s.fecha_resolucion,
    comentario_resolucion: s.comentario_resolucion,
    vehiculo_autorizado_id: s.vehiculo_autorizado_id,
    en_lista_alertas: Boolean(s.en_lista_alertas),
    permiso_actual_id: s.permiso_actual_id ?? null,
  };
}

async function obtener(db: sql.ConnectionPool, id: number) {
  const r = await db.request().input('id', sql.Int, id).query(`${SELECT} WHERE s.id = @id`);
  return r.recordset[0] ? mapear(r.recordset[0]) : null;
}

const avisar = () => emitEvent('solicitudes:actualizadas', {});

router.get('/', async (req: Request, res: Response) => {
  const estado = String(req.query.estado ?? 'pendiente');
  const resuelve = tienePermiso(req.user!.rol, 'solicitudes:resolver');
  try {
    const request = getDB().request().input('uid', sql.Int, req.user!.id);
    const filtros: string[] = [];
    if (!resuelve || req.query.mias === '1') filtros.push('s.solicitado_por = @uid');
    if (estado === 'pendiente') filtros.push(`s.estado = 'pendiente'`);
    else if (estado === 'resueltas') filtros.push(`s.estado <> 'pendiente'`);
    const r = await request.query(`${SELECT} ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''}
      ORDER BY CASE WHEN s.estado = 'pendiente' THEN 0 ELSE 1 END, s.fecha_solicitud DESC
      OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY`);
    return res.json(r.recordset.map(mapear));
  } catch (e: any) {
    console.error('[SOLICITUDES] listar:', e.message);
    return res.status(500).json({ error: 'No se pudieron consultar las solicitudes.' });
  }
});

router.get('/resumen', async (req: Request, res: Response) => {
  try {
    const resuelve = tienePermiso(req.user!.rol, 'solicitudes:resolver');
    const r = await getDB().request().input('uid', sql.Int, req.user!.id).query(`
      SELECT COUNT(*) AS n FROM SolicitudesAcceso
      WHERE estado = 'pendiente' ${resuelve ? 'AND solicitado_por <> @uid' : 'AND solicitado_por = @uid'}`);
    return res.json({ pendientes: Number(r.recordset[0].n) });
  } catch (e: any) {
    console.error('[SOLICITUDES] resumen:', e.message);
    return res.status(500).json({ error: 'No se pudo consultar el resumen.' });
  }
});

router.post('/', requierePermiso('solicitudes:crear'), async (req: Request, res: Response) => {
  const b = req.body ?? {};
  // Mismas validaciones que el padrón (placa, longitudes, fechas, horario)
  const { registro, error } = leerCuerpo(AUTORIZADOS, { ...b, fecha_vencimiento: b.fecha_fin, categoria: b.categoria || 'VISITANTE' });
  if (error || !registro) return res.status(400).json({ error });
  const motivo = String(b.motivo ?? '').trim();
  if (motivo.length < 5 || motivo.length > 300) return res.status(400).json({ error: 'Indique el motivo del ingreso (5 a 300 caracteres).' });
  const deteccionId = Number.isInteger(b.deteccion_id) ? b.deteccion_id : null;

  try {
    const db = getDB();
    const abierta = await db.request().input('placa', sql.VarChar(10), registro.placa)
      .query(`SELECT id FROM SolicitudesAcceso WHERE placa = @placa AND estado = 'pendiente'`);
    if (abierta.recordset.length) {
      return res.status(409).json({ error: `Ya existe una solicitud pendiente para ${registro.placa} (#${abierta.recordset[0].id}).` });
    }
    const d = registro.datos;
    const ins = await db.request()
      .input('placa', sql.VarChar(10), registro.placa)
      .input('propietario', sql.NVarChar(150), d.propietario)
      .input('departamento', sql.NVarChar(100), d.departamento)
      .input('categoria', sql.VarChar(20), d.categoria ?? 'VISITANTE')
      .input('motivo', sql.NVarChar(300), motivo)
      .input('tipo', sql.VarChar(50), d.tipo_vehiculo)
      .input('marca', sql.VarChar(50), d.marca)
      .input('modelo', sql.VarChar(50), d.modelo)
      .input('color', sql.VarChar(30), d.color)
      .input('inicio', sql.Date, registro.inicio)
      .input('fin', sql.Date, registro.vence)
      .input('horario', sql.NVarChar(600), registro.horario)
      .input('det', sql.Int, deteccionId)
      .input('uid', sql.Int, req.user!.id)
      .query(`
        INSERT INTO SolicitudesAcceso (placa, propietario, departamento, categoria, motivo, tipo_vehiculo, marca, modelo, color,
                                       fecha_inicio, fecha_fin, horario, deteccion_id, solicitado_por)
        OUTPUT INSERTED.id
        VALUES (@placa, @propietario, @departamento, @categoria, @motivo, @tipo, @marca, @modelo, @color,
                @inicio, @fin, @horario, (SELECT id FROM DeteccionVehiculo WHERE id = @det), @uid)`);
    const id = ins.recordset[0].id;
    await auditarOperacion(db, req, 'SOLICITUD_CREADA', 'solicitud_acceso', id, `${registro.placa} · ${motivo}`);
    avisar();
    void notificar({
      tipo: 'solicitud.nueva',
      titulo: `Solicitud de acceso · ${registro.placa}`,
      mensaje: `${req.user!.nombre} solicita autorizar a ${d.propietario}${d.categoria ? ` (${d.categoria.toLowerCase()})` : ''}: ${motivo}`,
      enlace: `/solicitudes?id=${id}`,
      datos: { solicitud_id: id, placa: registro.placa },
      destinatarios: { excluir: [req.user!.id] },
    });
    return res.status(201).json({ message: 'Solicitud enviada al gestor de accesos.', solicitud: await obtener(db, id) });
  } catch (e: any) {
    console.error('[SOLICITUDES] crear:', e.message);
    return res.status(500).json({ error: 'No se pudo registrar la solicitud.' });
  }
});

/** Reclama la solicitud pendiente de forma atómica (dos gestores no la resuelven a la vez). */
async function reclamar(db: sql.ConnectionPool, id: number, usuarioId: number, estado: 'aprobada' | 'rechazada', comentario: string | null) {
  const r = await db.request()
    .input('id', sql.Int, id).input('uid', sql.Int, usuarioId)
    .input('estado', sql.VarChar(20), estado).input('com', sql.NVarChar(300), comentario)
    .query(`
      UPDATE SolicitudesAcceso SET estado = @estado, resuelto_por = @uid, fecha_resolucion = SYSDATETIME(), comentario_resolucion = @com
      OUTPUT INSERTED.*
      WHERE id = @id AND estado = 'pendiente' AND solicitado_por <> @uid`);
  return r.recordset[0] ?? null;
}

async function motivoNoReclamable(db: sql.ConnectionPool, id: number, usuarioId: number): Promise<{ status: number; error: string }> {
  const s = await obtener(db, id);
  if (!s) return { status: 404, error: 'Solicitud no encontrada.' };
  if (s.solicitante.id === usuarioId) {
    return { status: 403, error: 'Separación de funciones: no puede resolver una solicitud que usted mismo registró.' };
  }
  return { status: 409, error: `La solicitud ya fue ${s.estado}.` };
}

router.post('/:id(\\d+)/aprobar', requierePermiso('solicitudes:resolver', 'padron:gestionar'), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const comentario = req.body?.comentario ? String(req.body.comentario).trim().substring(0, 300) : null;
  try {
    const db = getDB();
    const actual = await obtener(db, id);
    if (!actual) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    // El gestor puede ajustar la vigencia, el horario, la categoría y los datos antes de aprobar
    const a = req.body?.ajustes ?? {};
    const datos = {
      placa: actual.placa,
      propietario: a.propietario ?? actual.propietario,
      departamento: a.departamento ?? actual.departamento,
      categoria: a.categoria ?? actual.categoria,
      tipo_vehiculo: a.tipo_vehiculo ?? actual.vehiculo.tipo,
      marca: a.marca ?? actual.vehiculo.marca,
      modelo: a.modelo ?? actual.vehiculo.modelo,
      color: a.color ?? actual.vehiculo.color,
      observaciones: a.observaciones ?? `Solicitud #${id}: ${actual.motivo}`.substring(0, 255),
      fecha_inicio: a.fecha_inicio !== undefined ? a.fecha_inicio : actual.fecha_inicio,
      fecha_vencimiento: a.fecha_fin !== undefined ? a.fecha_fin : actual.fecha_fin,
      horario: a.horario !== undefined ? a.horario : actual.horario,
    };
    if (datos.categoria && !CATEGORIAS_PERMISO.includes(String(datos.categoria).toUpperCase())) {
      return res.status(400).json({ error: 'Categoría inválida.' });
    }
    const { registro, error } = leerCuerpo(AUTORIZADOS, datos);
    if (error || !registro) return res.status(400).json({ error });

    const s = await reclamar(db, id, req.user!.id, 'aprobada', comentario);
    if (!s) {
      const m = await motivoNoReclamable(db, id, req.user!.id);
      return res.status(m.status).json({ error: m.error });
    }

    let permisoId: number;
    let accion: string;
    try {
      const r = await guardarRegistro(db, AUTORIZADOS, registro, req.user!.id, { solicitudId: id });
      if ('conflicto' in r) {
        // Ya tenía un permiso activo: la aprobación lo amplía (nuevas fechas u horario)
        await actualizarRegistro(db, AUTORIZADOS, r.id, registro);
        permisoId = r.id;
        accion = 'permiso ampliado';
      } else {
        permisoId = r.id;
        accion = r.accion === 'reactivado' ? 'permiso reactivado' : 'permiso creado';
      }
      await db.request().input('id', sql.Int, id).input('v', sql.Int, permisoId)
        .query('UPDATE SolicitudesAcceso SET vehiculo_autorizado_id = @v WHERE id = @id');
    } catch (e) {
      // Sin permiso no hay aprobación: la solicitud vuelve a quedar pendiente
      await db.request().input('id', sql.Int, id).query(`
        UPDATE SolicitudesAcceso SET estado = 'pendiente', resuelto_por = NULL, fecha_resolucion = NULL, comentario_resolucion = NULL WHERE id = @id`);
      throw e;
    }

    await auditarOperacion(db, req, 'SOLICITUD_APROBADA', 'solicitud_acceso', id,
      `${registro.placa} · ${accion} #${permisoId} · ${describirHorario(registro.horario)}${comentario ? ` · ${comentario}` : ''}`);
    avisarListas(AUTORIZADOS);
    avisar();
    void notificar({
      tipo: 'solicitud.resuelta',
      titulo: `Solicitud aprobada · ${registro.placa}`,
      mensaje: `${req.user!.nombre} aprobó el ingreso de ${registro.datos.propietario} (${accion}).${comentario ? ` ${comentario}` : ''}`,
      enlace: actual.deteccion_id ? `/detecciones/${actual.deteccion_id}` : '/solicitudes',
      datos: { solicitud_id: id, placa: registro.placa, aprobada: true },
      destinatarios: { usuarios: [s.solicitado_por] },
    });
    return res.json({
      message: `Solicitud aprobada (${accion}).`,
      solicitud: await obtener(db, id),
      permiso: await obtenerRegistro(db, AUTORIZADOS, permisoId),
    });
  } catch (e: any) {
    console.error('[SOLICITUDES] aprobar:', e.message);
    return res.status(500).json({ error: 'No se pudo aprobar la solicitud.' });
  }
});

router.post('/:id(\\d+)/rechazar', requierePermiso('solicitudes:resolver'), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const comentario = String(req.body?.comentario ?? '').trim();
  if (comentario.length < 5) return res.status(400).json({ error: 'Indique el motivo del rechazo (mínimo 5 caracteres).' });
  try {
    const db = getDB();
    const s = await reclamar(db, id, req.user!.id, 'rechazada', comentario.substring(0, 300));
    if (!s) {
      const m = await motivoNoReclamable(db, id, req.user!.id);
      return res.status(m.status).json({ error: m.error });
    }
    await auditarOperacion(db, req, 'SOLICITUD_RECHAZADA', 'solicitud_acceso', id, `${s.placa} · ${comentario}`);
    avisar();
    void notificar({
      tipo: 'solicitud.resuelta',
      titulo: `Solicitud rechazada · ${s.placa}`,
      mensaje: `${req.user!.nombre}: ${comentario}`,
      enlace: '/solicitudes',
      datos: { solicitud_id: id, placa: s.placa, aprobada: false },
      destinatarios: { usuarios: [s.solicitado_por] },
    });
    return res.json({ message: 'Solicitud rechazada.', solicitud: await obtener(db, id) });
  } catch (e: any) {
    console.error('[SOLICITUDES] rechazar:', e.message);
    return res.status(500).json({ error: 'No se pudo rechazar la solicitud.' });
  }
});

router.post('/:id(\\d+)/cancelar', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  try {
    const db = getDB();
    const r = await db.request().input('id', sql.Int, id).input('uid', sql.Int, req.user!.id).query(`
      UPDATE SolicitudesAcceso SET estado = 'cancelada', fecha_resolucion = SYSDATETIME()
      OUTPUT INSERTED.placa
      WHERE id = @id AND estado = 'pendiente' AND solicitado_por = @uid`);
    if (!r.recordset.length) return res.status(404).json({ error: 'No hay una solicitud pendiente propia con ese número.' });
    await auditarOperacion(db, req, 'SOLICITUD_CANCELADA', 'solicitud_acceso', id, r.recordset[0].placa);
    avisar();
    return res.json({ message: 'Solicitud cancelada.', solicitud: await obtener(db, id) });
  } catch (e: any) {
    console.error('[SOLICITUDES] cancelar:', e.message);
    return res.status(500).json({ error: 'No se pudo cancelar la solicitud.' });
  }
});

export default router;
