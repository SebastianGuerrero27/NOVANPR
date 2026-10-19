import sql from '../postgres';
import { getDB } from '../db';
import { enmascarar, parsearExclusiones, parsearRoi } from '../../dominio/camaras';
import { cambiarCamaraAnpr, estadoServicioAnpr, fijarZonasAnpr, fuenteActivaAnpr, Punto, zonasActivasAnpr } from './servicioAnpr';
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
 * Junto con la cámara se aplican sus zonas: la región de interés (Camaras.roi) y las zonas de
 * exclusión (Camaras.exclusiones). Las reglas de las zonas y del enmascarado de credenciales están
 * en dominio/camaras.ts.
 */
const CLAVE = 'camara_motor_id';

export async function guardarCamaraMotor(id: number, usuarioId: number | null): Promise<void> {
  await getDB().request()
    .input('clave', sql.VarChar(60), CLAVE).input('valor', sql.NVarChar(500), String(id)).input('uid', sql.Int, usuarioId)
    .query(`
      INSERT INTO ConfiguracionSistema (clave, valor, actualizado_por)
      VALUES (@clave, @valor, @uid)
      ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_por = EXCLUDED.actualizado_por,
        fecha_actualizacion = CURRENT_TIMESTAMP`);
}

/** Cámara que debería estar procesando el motor (elegida y habilitada, o la primera habilitada). */
export async function camaraDeseada(): Promise<{ id: number; nombre: string; rtsp_url: string; roi: Punto[] | null; exclusiones: Punto[][] } | null> {
  const r = await getDB().request().input('clave', sql.VarChar(60), CLAVE).query(`
    SELECT TOP 1 c.id, c.nombre, c.rtsp_url, c.roi, c.exclusiones
    FROM Camaras c
    LEFT JOIN ConfiguracionSistema cfg ON cfg.clave = @clave
    WHERE c.activa = 1
    ORDER BY CASE WHEN CAST(c.id AS NVARCHAR(20)) = cfg.valor THEN 0 ELSE 1 END, c.id`);
  const c = r.recordset[0];
  return c ? { ...c, roi: parsearRoi(c.roi), exclusiones: parsearExclusiones(c.exclusiones) } : null;
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
      // Misma cámara: solo se corrigen las zonas si el motor tiene otras (por ejemplo, se
      // guardaron mientras el motor estaba detenido)
      const actual = await zonasActivasAnpr();
      const deseadas = { roi: deseada.roi, exclusiones: deseada.exclusiones };
      if (actual !== undefined && JSON.stringify(actual) !== JSON.stringify(deseadas)) {
        await fijarZonasAnpr(deseada.id, deseada.roi, deseada.exclusiones);
      }
      return false;
    }
    await sincronizarRutas();
    await cambiarCamaraAnpr({
      id: deseada.id, nombre: deseada.nombre, rtsp_url: urlLecturaMotor(rutaCamara(deseada.id)), roi: deseada.roi, exclusiones: deseada.exclusiones,
    }, forzar);
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
