import sql from 'mssql';
import { getDB } from '../config/db';
import { cambiarCamaraAnpr, estadoServicioAnpr, fijarRoiAnpr, fuenteActivaAnpr, Punto, roiActivaAnpr } from './servicioAnpr';
import { emitEvent } from './socket';
import { rutaCamara, sincronizarRutas, urlLecturaMotor } from './medios';

/**
 * Cámara que procesa el motor ANPR.
 *
 * El motor arranca con la fuente de su .env; la cámara elegida en el sistema se guarda en
 * ConfiguracionSistema (clave interna `camara_motor_id`) y el backend la reaplica:
 *  - al iniciar, cada 30 s si el motor se reinició o quedó en otra fuente, y
 *  - al editar la URL de esa cámara.
 * Si no hay una elegida (o se deshabilitó/eliminó), se usa la primera cámara habilitada.
 * El motor no se conecta directo a la cámara sino a su ruta en MediaMTX (una sola conexión
 * con la cámara, compartida con el video WebRTC de los navegadores).
 * Junto con la cámara se aplica su región de interés (Camaras.roi).
 */
const CLAVE = 'camara_motor_id';
const RE_CREDENCIALES = /^(rtsps?:\/\/[^:@/]+:)([^@]+)(@)/i;
const enmascarar = (url: string) => url.replace(RE_CREDENCIALES, '$1******$3');

/** Región de interés guardada (JSON) -> polígono, o null si no hay una válida. */
export function parsearRoi(texto: unknown): Punto[] | null {
  if (typeof texto !== 'string' || !texto) return null;
  try {
    return validarRoi(JSON.parse(texto)).roi ?? null;
  } catch {
    return null;
  }
}

/** Valida un polígono de 3 a 12 vértices normalizados (0–1). null/[] quita la región. */
export function validarRoi(entrada: unknown): { roi?: Punto[] | null; error?: string } {
  if (entrada === null || (Array.isArray(entrada) && entrada.length === 0)) return { roi: null };
  if (!Array.isArray(entrada) || entrada.length < 3 || entrada.length > 12) {
    return { error: 'La región de interés debe tener entre 3 y 12 vértices.' };
  }
  const roi: Punto[] = [];
  for (const p of entrada) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) {
      return { error: 'Cada vértice debe ser [x, y] con valores entre 0 y 1.' };
    }
    roi.push([Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000]);
  }
  return { roi };
}

export async function guardarCamaraMotor(id: number, usuarioId: number | null): Promise<void> {
  await getDB().request()
    .input('clave', sql.VarChar(60), CLAVE).input('valor', sql.NVarChar(500), String(id)).input('uid', sql.Int, usuarioId)
    .query(`
      MERGE ConfiguracionSistema AS t USING (SELECT @clave AS clave) AS s ON t.clave = s.clave
      WHEN MATCHED THEN UPDATE SET valor = @valor, actualizado_por = @uid, fecha_actualizacion = SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT (clave, valor, actualizado_por) VALUES (@clave, @valor, @uid);`);
}

/** Cámara que debería estar procesando el motor (elegida y habilitada, o la primera habilitada). */
export async function camaraDeseada(): Promise<{ id: number; nombre: string; rtsp_url: string; roi: Punto[] | null } | null> {
  const r = await getDB().request().input('clave', sql.VarChar(60), CLAVE).query(`
    SELECT TOP 1 c.id, c.nombre, c.rtsp_url, c.roi
    FROM Camaras c
    LEFT JOIN ConfiguracionSistema cfg ON cfg.clave = @clave
    WHERE c.activa = 1
    ORDER BY CASE WHEN CAST(c.id AS NVARCHAR(20)) = cfg.valor THEN 0 ELSE 1 END, c.id`);
  const c = r.recordset[0];
  return c ? { ...c, roi: parsearRoi(c.roi) } : null;
}

/** true si el motor está procesando exactamente la URL de la cámara indicada. */
export async function motorProcesa(camara: { id: number } | null): Promise<boolean> {
  if (!camara) return false;
  const fuente = await fuenteActivaAnpr();
  return !!fuente && fuente === enmascarar(urlLecturaMotor(rutaCamara(camara.id)));
}

let ocupado = false;

/** Aplica la cámara deseada si el motor está en otra fuente. Devuelve true si hubo cambio. */
export async function sincronizarCamaraMotor(forzar = false): Promise<boolean> {
  if (ocupado) return false;
  ocupado = true;
  try {
    const deseada = await camaraDeseada();
    if (!deseada) return false;
    const estado = await estadoServicioAnpr();
    if (!estado.en_linea) return false;
    if (!forzar && (await motorProcesa(deseada))) {
      // Misma cámara: solo se corrige la región de interés si el motor tiene otra
      // (por ejemplo, se guardó mientras el motor estaba detenido)
      const actual = await roiActivaAnpr();
      if (actual !== undefined && JSON.stringify(actual) !== JSON.stringify(deseada.roi)) {
        await fijarRoiAnpr(deseada.id, deseada.roi);
      }
      return false;
    }
    await sincronizarRutas();
    await cambiarCamaraAnpr({ id: deseada.id, nombre: deseada.nombre, rtsp_url: urlLecturaMotor(rutaCamara(deseada.id)), roi: deseada.roi }, forzar);
    console.log(`[MONITOREO] Motor ANPR asignado a la cámara #${deseada.id} (${deseada.nombre})`);
    emitEvent('monitoreo:camara', { camara_id: deseada.id, nombre: deseada.nombre, por: 'Sistema' });
    return true;
  } catch (e: any) {
    console.warn('[MONITOREO] No se pudo asignar la cámara al motor:', e.message);
    return false;
  } finally {
    ocupado = false;
  }
}

export function iniciarSincronizacionMotor(): void {
  setTimeout(() => sincronizarCamaraMotor(), 5000).unref();
  setInterval(() => sincronizarCamaraMotor(), 30000).unref();
}
