import { getDB } from '../db';
import { hoyLocalSql } from './tiempo';
import { config } from './configuracion';
import { escalarPendientes, notificar, purgarAntiguas } from './notificaciones';

/**
 * Tareas periódicas del centro de notificaciones:
 *   - cada 15 s: escalamiento de alarmas críticas/altas no reconocidas (ISA-18.2);
 *   - cada hora: resumen diario de permisos por vencer para el gestor de accesos (una vez por
 *     día gracias a la clave de supresión) y depuración según la retención configurada.
 * Son seguras con varias instancias del backend (UPDATE … OUTPUT atómico y claves diarias).
 */

const SEGUNDOS_ESCALAMIENTO = 15;
const MS_HORA = 60 * 60 * 1000;

function enSerie(nombre: string, tarea: () => Promise<unknown>): () => Promise<void> {
  let ocupado = false;
  return async () => {
    if (ocupado) return;
    ocupado = true;
    try { await tarea(); } catch (e: any) { console.warn(`[TAREAS] ${nombre}:`, e.message); } finally { ocupado = false; }
  };
}

export async function resumenPermisosPorVencer(): Promise<void> {
  const dias = config.entero('aviso_vencimiento_dias');
  const r = await getDB().request().query(`
    SELECT COUNT(*) AS n, MIN(fecha_vencimiento) AS primero FROM VehiculosAutorizados
    WHERE activo = 1 AND fecha_vencimiento >= ${hoyLocalSql()} AND fecha_vencimiento <= DATEADD(DAY, ${Number(dias)}, ${hoyLocalSql()})`);
  const n = Number(r.recordset[0]?.n ?? 0);
  if (!n) return;
  const hoy = new Date().toISOString().slice(0, 10);
  await notificar({
    tipo: 'padron.por_vencer',
    titulo: `${n} ${n === 1 ? 'permiso vence' : 'permisos vencen'} en los próximos ${dias} días`,
    mensaje: `El primero vence el ${new Date(r.recordset[0].primero).toISOString().slice(0, 10)}. Renueve los que correspondan para evitar accesos denegados.`,
    enlace: '/listas/autorizados?vigencia=por_vencer',
    claveDedup: `padron.por_vencer:${hoy}`,
    datos: { cantidad: n },
  });
}

export function iniciarTareasProgramadas(): void {
  if (process.env.NODE_ENV === 'test' || process.env.TAREAS_PROGRAMADAS === 'false') return;
  const escalar = enSerie('escalamiento', escalarPendientes);
  const horaria = enSerie('tareas horarias', async () => {
    await resumenPermisosPorVencer();
    const n = await purgarAntiguas();
    if (n) console.log(`[TAREAS] ${n} notificaciones antiguas depuradas.`);
  });
  setInterval(escalar, SEGUNDOS_ESCALAMIENTO * 1000).unref();
  setInterval(horaria, MS_HORA).unref();
  // Primera pasada poco después del arranque (la base ya está conectada)
  setTimeout(horaria, 30_000).unref();
}
