import sql from 'mssql';
export {
  bucketDistancia, bucketLuz, calcularEvaluacion, type FilaEvaluacion, tipoPlaca, wilson,
} from '../../dominio/evaluacion';

/**
 * Evaluación científica del sistema con datos de operación.
 *
 * La "verdad" de cada paso vehicular es la placa confirmada por el operador
 * (validado_manualmente = 1). Se compara contra la lectura ORIGINAL del OCR y la
 * decisión AUTOMÁTICA del sistema, que se guardan aparte porque la validación
 * manual sobrescribe placa_reconocida y estado_validacion.
 *
 * Para que las métricas no estén sesgadas, durante el periodo de evaluación el
 * operador debe validar TODOS los registros (no solo los dudosos); la métrica
 * `cobertura_validacion` lo controla.
 */

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

export interface MetadatosCaptura {
  luminancia_media?: number;
  distancia_estimada_m?: number;
  ancho_placa_px?: number;
  nitidez?: number;
  velocidad_px_s?: number;
  modelo_detector?: string;
  modelo_ocr?: string;
  vehiculo?: {
    tipo?: string | null; color?: string | null; marca?: string | null; modelo?: string | null;
    [k: string]: unknown;
  } | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 100): string | null => (typeof v === 'string' && v ? v.substring(0, max) : null);

/** Guarda los metadatos de la captura. No interrumpe el registro si falla (p. ej. migración pendiente). */
export async function guardarMetadatosCaptura(db: sql.ConnectionPool, id: number, meta?: MetadatosCaptura): Promise<void> {
  if (!meta || typeof meta !== 'object') return;
  try {
    await db.request()
      .input('id', sql.Int, id)
      .input('lum', sql.Float, num(meta.luminancia_media))
      .input('dist', sql.Float, num(meta.distancia_estimada_m))
      .input('ancho', sql.Int, num(meta.ancho_placa_px) !== null ? Math.round(meta.ancho_placa_px as number) : null)
      .input('nit', sql.Float, num(meta.nitidez))
      .input('vel', sql.Float, num(meta.velocidad_px_s))
      .input('mdet', sql.VarChar(100), str(meta.modelo_detector))
      .input('mocr', sql.VarChar(100), str(meta.modelo_ocr))
      .input('vtipo', sql.VarChar(30), str(meta.vehiculo?.tipo, 30))
      .input('vcolor', sql.VarChar(30), str(meta.vehiculo?.color, 30))
      .input('vmarca', sql.VarChar(50), str(meta.vehiculo?.marca, 50))
      .input('vmodelo', sql.VarChar(50), str(meta.vehiculo?.modelo, 50))
      .input('vjson', sql.NVarChar(500), meta.vehiculo ? JSON.stringify(meta.vehiculo).substring(0, 500) : null)
      .query(`
        UPDATE DeteccionVehiculo SET
          luminancia_media = @lum, distancia_estimada_m = @dist, ancho_placa_px = @ancho,
          nitidez = @nit, velocidad_px_s = @vel, modelo_detector = @mdet, modelo_ocr = @mocr,
          vehiculo_tipo = @vtipo, vehiculo_color = @vcolor, vehiculo_marca = @vmarca,
          vehiculo_modelo = @vmodelo, vehiculo_atributos_json = @vjson
        WHERE id = @id
      `);
  } catch (error: any) {
    console.warn(`[EVALUACION] No se guardaron metadatos del ingreso #${id}: ${error.message}`);
  }
}

export interface LecturaAutomatica {
  placaOriginal: string;
  confianza: number | null;
  decision: string;
  lecturaVerificador?: string | null;
  latenciaMs?: number | null;
}

/** Conserva la lectura y la decisión automáticas antes de cualquier corrección manual. */
export async function registrarLecturaAutomatica(db: sql.ConnectionPool, id: number, l: LecturaAutomatica): Promise<void> {
  try {
    await db.request()
      .input('id', sql.Int, id)
      .input('placa', sql.VarChar(20), l.placaOriginal.substring(0, 20))
      .input('conf', sql.Float, num(l.confianza))
      .input('decision', sql.VarChar(30), l.decision)
      .input('verif', sql.VarChar(20), str(l.lecturaVerificador, 20))
      .input('lat', sql.Int, num(l.latenciaMs) !== null ? Math.round(l.latenciaMs as number) : null)
      .query(`
        UPDATE DeteccionVehiculo SET
          placa_ocr_original = @placa, confianza_ocr_original = @conf, decision_automatica = @decision,
          lectura_verificador = @verif, latencia_ms = @lat
        WHERE id = @id
      `);
  } catch (error: any) {
    console.warn(`[EVALUACION] No se guardó la lectura automática del ingreso #${id}: ${error.message}`);
  }
}

// Las métricas (funciones puras) están en dominio/evaluacion.ts y se reexportan arriba.
