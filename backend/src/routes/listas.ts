import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { authMiddleware, requierePermiso } from '../middlewares/auth';
import type { Permiso } from '../dominio/permisos';
import { describirHorario, leerHorario, validarHorario } from '../dominio/horario';
import { normalizePlate } from '../services/plateMatching';
import { auditarOperacion } from '../services/seguridad';
import { emitEvent } from '../services/socket';
import { hoyLocalSql } from '../services/tiempo';
import { config } from '../services/configuracion';

/**
 * Listas de control: padrón de vehículos autorizados (permisos de placa) y lista de alertas.
 * Ambas comparten el mismo contrato:
 *
 *   GET    /            registros activos (vigentes y vencidos, con la marca `vigente`)
 *   POST   /            alta (reactiva el registro si la placa se había retirado)
 *   PUT    /:id         edición
 *   DELETE /:id         retiro (baja lógica) con motivo
 *
 * Lectura: permiso listas:ver (todo el personal). Cambios auditados con el permiso de cada
 * lista: padron:gestionar (Gestor de accesos, Supervisor, Administrador) y alertas:gestionar
 * (Supervisor, Administrador).
 *
 * El padrón incorpora las restricciones de los sistemas ANPR de control de acceso: categoría
 * del permiso, inicio y fin de vigencia y franjas horarias (dominio/horario.ts).
 */

interface Campo {
  nombre: string;
  etiqueta: string;
  max: number;
  requerido?: boolean;
  valores?: string[];
  omision?: string;
}

export interface DefinicionLista {
  tabla: 'VehiculosAutorizados' | 'ListaNegra';
  entidad: 'autorizado' | 'lista_negra';
  nombre: string;
  campos: Campo[];
  /** Admite fecha de inicio y franjas horarias (solo el padrón) */
  temporal: boolean;
  permisoEdicion: Permiso;
}

export const CATEGORIAS_PERMISO = ['FUNCIONARIO', 'VISITANTE', 'PROVEEDOR', 'CONTRATISTA', 'OFICIAL', 'EMERGENCIA'];

const CAMPOS_VEHICULO: Campo[] = [
  { nombre: 'tipo_vehiculo', etiqueta: 'Tipo de vehículo', max: 50 },
  { nombre: 'marca', etiqueta: 'Marca', max: 50 },
  { nombre: 'modelo', etiqueta: 'Modelo', max: 50 },
  { nombre: 'color', etiqueta: 'Color', max: 30 },
  { nombre: 'observaciones', etiqueta: 'Observaciones', max: 255 },
];

export const AUTORIZADOS: DefinicionLista = {
  tabla: 'VehiculosAutorizados', entidad: 'autorizado', nombre: 'vehículos autorizados',
  temporal: true, permisoEdicion: 'padron:gestionar',
  campos: [
    { nombre: 'propietario', etiqueta: 'Propietario o responsable', max: 150, requerido: true },
    { nombre: 'departamento', etiqueta: 'Departamento', max: 100 },
    { nombre: 'categoria', etiqueta: 'Categoría', max: 20, valores: CATEGORIAS_PERMISO, omision: 'FUNCIONARIO' },
    ...CAMPOS_VEHICULO,
  ],
};

export const ALERTAS: DefinicionLista = {
  tabla: 'ListaNegra', entidad: 'lista_negra', nombre: 'lista de alertas',
  temporal: false, permisoEdicion: 'alertas:gestionar',
  campos: [
    { nombre: 'motivo', etiqueta: 'Motivo', max: 255, requerido: true },
    { nombre: 'nivel_alerta', etiqueta: 'Nivel', max: 20, requerido: true, valores: ['CRITICA', 'ALTA', 'MEDIA'] },
    ...CAMPOS_VEHICULO.filter(c => c.nombre !== 'tipo_vehiculo'),
  ],
};

export interface DatosRegistro {
  placa: string;
  datos: Record<string, string | null>;
  vence: Date | null;
  inicio: Date | null;
  horario: string | null;
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Valida el cuerpo de un alta o edición. */
export function leerCuerpo(def: DefinicionLista, body: any): { registro?: DatosRegistro; error?: string } {
  const placa = normalizePlate(body?.placa);
  if (placa.length < 4 || placa.length > 10) return { error: 'Placa inválida (4 a 10 letras y números).' };
  const datos: Record<string, string | null> = {};
  for (const c of def.campos) {
    let v = body?.[c.nombre] === undefined || body?.[c.nombre] === null ? '' : String(body[c.nombre]).trim();
    if (!v && c.omision) v = c.omision;
    if (c.requerido && !v) return { error: `${c.etiqueta} es obligatorio.` };
    if (v.length > c.max) return { error: `${c.etiqueta}: máximo ${c.max} caracteres.` };
    if (c.valores && v && !c.valores.includes(v.toUpperCase())) return { error: `${c.etiqueta} inválido.` };
    datos[c.nombre] = v ? (c.valores ? v.toUpperCase() : v) : null;
  }
  let vence: Date | null = null;
  if (body?.fecha_vencimiento) {
    if (!FECHA.test(String(body.fecha_vencimiento))) return { error: 'Fecha de vencimiento inválida.' };
    vence = new Date(`${body.fecha_vencimiento}T00:00:00Z`);
  }
  let inicio: Date | null = null;
  let horario: string | null = null;
  if (def.temporal) {
    if (body?.fecha_inicio) {
      if (!FECHA.test(String(body.fecha_inicio))) return { error: 'Fecha de inicio inválida.' };
      inicio = new Date(`${body.fecha_inicio}T00:00:00Z`);
      if (vence && inicio > vence) return { error: 'La fecha de inicio no puede ser posterior al vencimiento.' };
    }
    const h = validarHorario(body?.horario);
    if (h.error) return { error: h.error };
    horario = h.horario ? JSON.stringify(h.horario) : null;
  }
  return { registro: { placa, datos, vence, inicio, horario } };
}

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

function parametros(request: sql.Request, def: DefinicionLista, r: DatosRegistro) {
  for (const c of def.campos) request.input(c.nombre, sql.NVarChar(c.max), r.datos[c.nombre]);
  request.input('placa', sql.VarChar(10), r.placa).input('vence', sql.Date, r.vence);
  if (def.temporal) request.input('inicio', sql.Date, r.inicio).input('horario', sql.NVarChar(600), r.horario);
}

function columnasDe(def: DefinicionLista): string[] {
  return [...def.campos.map(c => c.nombre), ...(def.temporal ? ['fecha_inicio', 'horario'] : [])];
}

const valorDe = (c: string) => (c === 'fecha_inicio' ? '@inicio' : `@${c}`);

function selectLista(def: DefinicionLista): string {
  const hoy = hoyLocalSql();
  return `
    SELECT t.*, u.email AS registrado_por_email,
           CAST(CASE WHEN t.fecha_vencimiento IS NULL OR t.fecha_vencimiento >= ${hoy} THEN 1 ELSE 0 END AS BIT) AS vigente,
           CAST(CASE WHEN t.fecha_vencimiento >= ${hoy}
                      AND t.fecha_vencimiento <= DATEADD(DAY, ${config.entero('aviso_vencimiento_dias')}, ${hoy}) THEN 1 ELSE 0 END AS BIT) AS por_vencer,
           ${def.temporal ? `CAST(CASE WHEN t.fecha_inicio > ${hoy} THEN 1 ELSE 0 END AS BIT)` : 'CAST(0 AS BIT)'} AS pendiente_inicio,
           (SELECT COUNT(*) FROM DeteccionVehiculo d
             WHERE ${def.tabla === 'ListaNegra' ? 'd.alerta_id' : 'd.vehiculo_autorizado_id'} = t.id) AS ingresos
    FROM ${def.tabla} t LEFT JOIN Usuarios u ON u.id = t.registrado_por`;
}

/** Representación de un registro para la API (el horario se entrega interpretado). */
function mapearRegistro(def: DefinicionLista, r: any) {
  if (!def.temporal) return r;
  return { ...r, horario: leerHorario(r.horario), horario_texto: describirHorario(r.horario) };
}

export async function obtenerRegistro(db: sql.ConnectionPool, def: DefinicionLista, id: number) {
  const r = await db.request().input('id', sql.Int, id).query(`${selectLista(def)} WHERE t.id = @id`);
  return r.recordset[0] ? mapearRegistro(def, r.recordset[0]) : null;
}

/**
 * Alta de un registro o reactivación del que se había retirado con la misma placa.
 * Reutilizado por la aprobación de solicitudes de acceso. Devuelve el id y si ya existía
 * activo (en ese caso NO modifica nada: la decisión de editar es explícita).
 */
export async function guardarRegistro(
  db: sql.ConnectionPool, def: DefinicionLista, r: DatosRegistro, usuarioId: number, extra?: { solicitudId?: number },
): Promise<{ id: number; accion: 'creado' | 'reactivado' } | { conflicto: true; id: number }> {
  const existe = await db.request().input('placa', sql.VarChar(10), r.placa)
    .query(`SELECT id, activo FROM ${def.tabla} WHERE REPLACE(REPLACE(placa, '-', ''), ' ', '') = @placa`);
  const previo = existe.recordset[0];
  if (previo?.activo) return { conflicto: true, id: previo.id };

  const columnas = columnasDe(def);
  const request = db.request().input('usuario', sql.Int, usuarioId);
  parametros(request, def, r);
  const conSolicitud = def.temporal && extra?.solicitudId;
  if (conSolicitud) request.input('solicitud', sql.Int, extra!.solicitudId);
  if (previo) {
    await request.input('id', sql.Int, previo.id).query(`
      UPDATE ${def.tabla} SET activo = 1, placa = @placa, fecha_vencimiento = @vence, registrado_por = @usuario,
        fecha_registro = GETDATE(), fecha_actualizacion = SYSDATETIME(),
        ${columnas.map(c => `${c} = ${valorDe(c)}`).join(', ')}${conSolicitud ? ', solicitud_id = @solicitud' : ''}
      WHERE id = @id`);
    return { id: previo.id, accion: 'reactivado' };
  }
  const ins = await request.query(`
    INSERT INTO ${def.tabla} (placa, fecha_vencimiento, registrado_por, activo, fecha_registro, ${columnas.join(', ')}${conSolicitud ? ', solicitud_id' : ''})
    OUTPUT INSERTED.id
    VALUES (@placa, @vence, @usuario, 1, GETDATE(), ${columnas.map(valorDe).join(', ')}${conSolicitud ? ', @solicitud' : ''})`);
  return { id: ins.recordset[0].id, accion: 'creado' };
}

/** Actualiza un registro activo (usado por la edición y por la aprobación que amplía un permiso). */
export async function actualizarRegistro(db: sql.ConnectionPool, def: DefinicionLista, id: number, r: DatosRegistro) {
  const request = db.request().input('id', sql.Int, id);
  parametros(request, def, r);
  await request.query(`
    UPDATE ${def.tabla} SET placa = @placa, fecha_vencimiento = @vence, fecha_actualizacion = SYSDATETIME(),
      ${columnasDe(def).map(c => `${c} = ${valorDe(c)}`).join(', ')}
    WHERE id = @id`);
}

export function avisarListas(def: DefinicionLista) {
  emitEvent('listas:actualizadas', { lista: def.entidad });
}

function crearRouter(def: DefinicionLista): Router {
  const router = Router();
  const edicion = requierePermiso(def.permisoEdicion);

  router.get('/', authMiddleware, requierePermiso('listas:ver'), async (_req: Request, res: Response) => {
    try {
      const r = await getDB().request().query(`${selectLista(def)} WHERE t.activo = 1 ORDER BY t.fecha_registro DESC`);
      return res.json(r.recordset.map(x => mapearRegistro(def, x)));
    } catch (e: any) {
      console.error(`[LISTAS] ${def.tabla} listar:`, e.message);
      return res.status(500).json({ error: `No se pudo consultar la ${def.nombre}.` });
    }
  });

  router.post('/', authMiddleware, edicion, async (req: Request, res: Response) => {
    const { registro, error } = leerCuerpo(def, req.body);
    if (error || !registro) return res.status(400).json({ error });
    try {
      const db = getDB();
      const r = await guardarRegistro(db, def, registro, req.user!.id);
      if ('conflicto' in r) return res.status(409).json({ error: `La placa ${registro.placa} ya está en la ${def.nombre}.` });
      const detalle = [registro.placa,
        registro.inicio ? `desde ${iso(registro.inicio)}` : '',
        registro.vence ? `vence ${iso(registro.vence)}` : '',
        registro.horario ? describirHorario(registro.horario) : ''].filter(Boolean).join(' · ');
      await auditarOperacion(db, req, r.accion === 'reactivado' ? 'LISTA_REACTIVADO' : 'LISTA_ALTA', def.entidad, r.id, detalle);
      avisarListas(def);
      return res.status(r.accion === 'reactivado' ? 200 : 201).json({
        message: r.accion === 'reactivado' ? 'Registro reactivado.' : 'Registro creado.',
        item: await obtenerRegistro(db, def, r.id),
      });
    } catch (e: any) {
      console.error(`[LISTAS] ${def.tabla} alta:`, e.message);
      return res.status(500).json({ error: 'No se pudo guardar el registro.' });
    }
  });

  router.put('/:id(\\d+)', authMiddleware, edicion, async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const { registro, error } = leerCuerpo(def, req.body);
    if (error || !registro) return res.status(400).json({ error });
    try {
      const db = getDB();
      const actual = await db.request().input('id', sql.Int, id).query(`SELECT * FROM ${def.tabla} WHERE id = @id AND activo = 1`);
      if (!actual.recordset.length) return res.status(404).json({ error: 'Registro no encontrado.' });
      const otro = await db.request().input('placa', sql.VarChar(10), registro.placa).input('id', sql.Int, id)
        .query(`SELECT id FROM ${def.tabla} WHERE REPLACE(REPLACE(placa, '-', ''), ' ', '') = @placa AND id <> @id`);
      if (otro.recordset.length) return res.status(409).json({ error: `Ya existe otro registro con la placa ${registro.placa}.` });

      await actualizarRegistro(db, def, id, registro);

      const a = actual.recordset[0];
      const cambios = [...def.campos.map(c => c.nombre), 'placa']
        .filter(c => String(a[c] ?? '') !== String(c === 'placa' ? registro.placa : registro.datos[c] ?? ''));
      const fecha = (v: any) => (v ? new Date(v).toISOString().slice(0, 10) : '');
      if (fecha(a.fecha_vencimiento) !== iso(registro.vence)) cambios.push('fecha_vencimiento');
      if (def.temporal && fecha(a.fecha_inicio) !== iso(registro.inicio)) cambios.push('fecha_inicio');
      if (def.temporal && (a.horario ?? null) !== registro.horario) cambios.push(`horario (${describirHorario(registro.horario)})`);
      await auditarOperacion(db, req, 'LISTA_EDICION', def.entidad, id, `${registro.placa}: ${cambios.join(', ') || 'sin cambios'}`);
      avisarListas(def);
      return res.json({ message: 'Registro actualizado.', item: await obtenerRegistro(db, def, id) });
    } catch (e: any) {
      console.error(`[LISTAS] ${def.tabla} edición:`, e.message);
      return res.status(500).json({ error: 'No se pudo actualizar el registro.' });
    }
  });

  router.delete('/:id(\\d+)', authMiddleware, edicion, async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const motivo = String(req.body?.motivo ?? '').trim();
    if (motivo.length < 5) return res.status(400).json({ error: 'Indique el motivo del retiro (mínimo 5 caracteres).' });
    try {
      const db = getDB();
      const r = await db.request().input('id', sql.Int, id)
        .query(`UPDATE ${def.tabla} SET activo = 0, fecha_actualizacion = SYSDATETIME() OUTPUT DELETED.placa WHERE id = @id AND activo = 1`);
      if (!r.recordset.length) return res.status(404).json({ error: 'Registro no encontrado.' });
      await auditarOperacion(db, req, 'LISTA_RETIRO', def.entidad, id, `${r.recordset[0].placa} · ${motivo}`);
      avisarListas(def);
      return res.json({ message: 'Registro retirado de la lista.' });
    } catch (e: any) {
      console.error(`[LISTAS] ${def.tabla} retiro:`, e.message);
      return res.status(500).json({ error: 'No se pudo retirar el registro.' });
    }
  });

  return router;
}

export const autorizadosRouter = crearRouter(AUTORIZADOS);
export const alertasRouter = crearRouter(ALERTAS);
