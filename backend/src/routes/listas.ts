import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { getDB } from '../config/db';
import { adminOSupervisor, authMiddleware } from '../middlewares/auth';
import { normalizePlate } from '../services/plateMatching';
import { auditarOperacion } from '../services/seguridad';
import { emitEvent } from '../services/socket';
import { hoyLocalSql } from '../services/tiempo';
import { config } from '../services/configuracion';

/**
 * Listas de control: padrón de vehículos autorizados y lista de alertas (lista negra).
 * Ambas comparten el mismo contrato:
 *
 *   GET    /            registros activos (vigentes y vencidos, con la marca `vigente`)
 *   POST   /            alta (reactiva el registro si la placa se había retirado)
 *   PUT    /:id         edición
 *   DELETE /:id         retiro (baja lógica) con motivo
 *
 * Lectura: todo el personal. Cambios: Administrador y Supervisor, auditados.
 */

interface Campo {
  nombre: string;
  etiqueta: string;
  max: number;
  requerido?: boolean;
  valores?: string[];
}

interface DefinicionLista {
  tabla: 'VehiculosAutorizados' | 'ListaNegra';
  entidad: 'autorizado' | 'lista_negra';
  nombre: string;
  campos: Campo[];
}

const CAMPOS_VEHICULO: Campo[] = [
  { nombre: 'tipo_vehiculo', etiqueta: 'Tipo de vehículo', max: 50 },
  { nombre: 'marca', etiqueta: 'Marca', max: 50 },
  { nombre: 'modelo', etiqueta: 'Modelo', max: 50 },
  { nombre: 'color', etiqueta: 'Color', max: 30 },
  { nombre: 'observaciones', etiqueta: 'Observaciones', max: 255 },
];

const AUTORIZADOS: DefinicionLista = {
  tabla: 'VehiculosAutorizados', entidad: 'autorizado', nombre: 'vehículos autorizados',
  campos: [
    { nombre: 'propietario', etiqueta: 'Propietario o responsable', max: 150, requerido: true },
    { nombre: 'departamento', etiqueta: 'Departamento', max: 100 },
    ...CAMPOS_VEHICULO,
  ],
};

const ALERTAS: DefinicionLista = {
  tabla: 'ListaNegra', entidad: 'lista_negra', nombre: 'lista de alertas',
  campos: [
    { nombre: 'motivo', etiqueta: 'Motivo', max: 255, requerido: true },
    { nombre: 'nivel_alerta', etiqueta: 'Nivel', max: 20, requerido: true, valores: ['CRITICA', 'ALTA', 'MEDIA'] },
    ...CAMPOS_VEHICULO.filter(c => c.nombre !== 'tipo_vehiculo'),
  ],
};

function leerCuerpo(def: DefinicionLista, body: any): { datos?: Record<string, string | null>; vence?: Date | null; placa?: string; error?: string } {
  const placa = normalizePlate(body?.placa);
  if (placa.length < 4 || placa.length > 10) return { error: 'Placa inválida (4 a 10 letras y números).' };
  const datos: Record<string, string | null> = {};
  for (const c of def.campos) {
    const v = body?.[c.nombre] === undefined || body?.[c.nombre] === null ? '' : String(body[c.nombre]).trim();
    if (c.requerido && !v) return { error: `${c.etiqueta} es obligatorio.` };
    if (v.length > c.max) return { error: `${c.etiqueta}: máximo ${c.max} caracteres.` };
    if (c.valores && v && !c.valores.includes(v.toUpperCase())) return { error: `${c.etiqueta} inválido.` };
    datos[c.nombre] = v ? (c.valores ? v.toUpperCase() : v) : null;
  }
  let vence: Date | null = null;
  if (body?.fecha_vencimiento) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.fecha_vencimiento))) return { error: 'Fecha de vencimiento inválida.' };
    vence = new Date(`${body.fecha_vencimiento}T00:00:00`);
  }
  return { datos, vence, placa };
}

function parametros(request: sql.Request, def: DefinicionLista, datos: Record<string, string | null>) {
  for (const c of def.campos) request.input(c.nombre, sql.NVarChar(c.max), datos[c.nombre]);
}

function crearRouter(def: DefinicionLista): Router {
  const router = Router();
  const columnas = def.campos.map(c => c.nombre);
  const aviso = () => emitEvent('listas:actualizadas', { lista: def.entidad });

  const SELECT = () => `
    SELECT t.*, u.email AS registrado_por_email,
           CAST(CASE WHEN t.fecha_vencimiento IS NULL OR t.fecha_vencimiento >= ${hoyLocalSql()} THEN 1 ELSE 0 END AS BIT) AS vigente,
           CAST(CASE WHEN t.fecha_vencimiento >= ${hoyLocalSql()}
                      AND t.fecha_vencimiento <= DATEADD(DAY, ${config.entero('aviso_vencimiento_dias')}, ${hoyLocalSql()}) THEN 1 ELSE 0 END AS BIT) AS por_vencer,
           (SELECT COUNT(*) FROM DeteccionVehiculo d
             WHERE ${def.tabla === 'ListaNegra' ? 'd.alerta_id' : 'd.vehiculo_autorizado_id'} = t.id) AS ingresos
    FROM ${def.tabla} t LEFT JOIN Usuarios u ON u.id = t.registrado_por`;

  router.get('/', authMiddleware, async (_req: Request, res: Response) => {
    try {
      const r = await getDB().request().query(`${SELECT()} WHERE t.activo = 1 ORDER BY t.fecha_registro DESC`);
      return res.json(r.recordset);
    } catch (e: any) {
      console.error(`[LISTAS] ${def.tabla} listar:`, e.message);
      return res.status(500).json({ error: `No se pudo consultar la ${def.nombre}.` });
    }
  });

  router.post('/', authMiddleware, adminOSupervisor, async (req: Request, res: Response) => {
    const { datos, vence, placa, error } = leerCuerpo(def, req.body);
    if (error) return res.status(400).json({ error });
    try {
      const db = getDB();
      const existe = await db.request().input('placa', sql.VarChar(10), placa)
        .query(`SELECT id, activo FROM ${def.tabla} WHERE REPLACE(REPLACE(placa, '-', ''), ' ', '') = @placa`);
      const previo = existe.recordset[0];
      if (previo?.activo) return res.status(409).json({ error: `La placa ${placa} ya está en la ${def.nombre}.` });

      const request = db.request()
        .input('placa', sql.VarChar(10), placa)
        .input('vence', sql.Date, vence)
        .input('usuario', sql.Int, req.user!.id);
      parametros(request, def, datos!);
      let id: number;
      if (previo) {
        await request.input('id', sql.Int, previo.id).query(`
          UPDATE ${def.tabla} SET activo = 1, placa = @placa, fecha_vencimiento = @vence, registrado_por = @usuario,
            fecha_registro = GETDATE(), fecha_actualizacion = SYSDATETIME(),
            ${columnas.map(c => `${c} = @${c}`).join(', ')}
          WHERE id = @id`);
        id = previo.id;
      } else {
        const ins = await request.query(`
          INSERT INTO ${def.tabla} (placa, fecha_vencimiento, registrado_por, activo, fecha_registro, ${columnas.join(', ')})
          OUTPUT INSERTED.id
          VALUES (@placa, @vence, @usuario, 1, GETDATE(), ${columnas.map(c => `@${c}`).join(', ')})`);
        id = ins.recordset[0].id;
      }
      await auditarOperacion(db, req, previo ? 'LISTA_REACTIVADO' : 'LISTA_ALTA', def.entidad, id,
        `${placa}${vence ? ` · vence ${vence.toISOString().slice(0, 10)}` : ''}`);
      aviso();
      const r = await db.request().input('id', sql.Int, id).query(`${SELECT()} WHERE t.id = @id`);
      return res.status(previo ? 200 : 201).json({ message: previo ? 'Registro reactivado.' : 'Registro creado.', item: r.recordset[0] });
    } catch (e: any) {
      console.error(`[LISTAS] ${def.tabla} alta:`, e.message);
      return res.status(500).json({ error: 'No se pudo guardar el registro.' });
    }
  });

  router.put('/:id(\\d+)', authMiddleware, adminOSupervisor, async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const { datos, vence, placa, error } = leerCuerpo(def, req.body);
    if (error) return res.status(400).json({ error });
    try {
      const db = getDB();
      const actual = await db.request().input('id', sql.Int, id).query(`SELECT * FROM ${def.tabla} WHERE id = @id AND activo = 1`);
      if (!actual.recordset.length) return res.status(404).json({ error: 'Registro no encontrado.' });
      const otro = await db.request().input('placa', sql.VarChar(10), placa).input('id', sql.Int, id)
        .query(`SELECT id FROM ${def.tabla} WHERE REPLACE(REPLACE(placa, '-', ''), ' ', '') = @placa AND id <> @id`);
      if (otro.recordset.length) return res.status(409).json({ error: `Ya existe otro registro con la placa ${placa}.` });

      const request = db.request().input('id', sql.Int, id).input('placa', sql.VarChar(10), placa).input('vence', sql.Date, vence);
      parametros(request, def, datos!);
      await request.query(`
        UPDATE ${def.tabla} SET placa = @placa, fecha_vencimiento = @vence, fecha_actualizacion = SYSDATETIME(),
          ${columnas.map(c => `${c} = @${c}`).join(', ')}
        WHERE id = @id`);

      const a = actual.recordset[0];
      const cambios = [...columnas, 'placa'].filter(c => String(a[c] ?? '') !== String(c === 'placa' ? placa : datos![c] ?? ''));
      const venceAntes = a.fecha_vencimiento ? new Date(a.fecha_vencimiento).toISOString().slice(0, 10) : '';
      if (venceAntes !== (vence ? vence.toISOString().slice(0, 10) : '')) cambios.push('fecha_vencimiento');
      await auditarOperacion(db, req, 'LISTA_EDICION', def.entidad, id, `${placa}: ${cambios.join(', ') || 'sin cambios'}`);
      aviso();
      const r = await db.request().input('id', sql.Int, id).query(`${SELECT()} WHERE t.id = @id`);
      return res.json({ message: 'Registro actualizado.', item: r.recordset[0] });
    } catch (e: any) {
      console.error(`[LISTAS] ${def.tabla} edición:`, e.message);
      return res.status(500).json({ error: 'No se pudo actualizar el registro.' });
    }
  });

  router.delete('/:id(\\d+)', authMiddleware, adminOSupervisor, async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const motivo = String(req.body?.motivo ?? '').trim();
    if (motivo.length < 5) return res.status(400).json({ error: 'Indique el motivo del retiro (mínimo 5 caracteres).' });
    try {
      const db = getDB();
      const r = await db.request().input('id', sql.Int, id)
        .query(`UPDATE ${def.tabla} SET activo = 0, fecha_actualizacion = SYSDATETIME() OUTPUT DELETED.placa WHERE id = @id AND activo = 1`);
      if (!r.recordset.length) return res.status(404).json({ error: 'Registro no encontrado.' });
      await auditarOperacion(db, req, 'LISTA_RETIRO', def.entidad, id, `${r.recordset[0].placa} · ${motivo}`);
      aviso();
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
