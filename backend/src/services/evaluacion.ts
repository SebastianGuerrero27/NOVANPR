import sql from 'mssql';
import { levenshtein, normalizePlate } from './plateMatching';

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

// ---------------------------------------------------------------------------
// Métricas (funciones puras)
// ---------------------------------------------------------------------------

export interface FilaEvaluacion {
  id: number;
  placa_ocr_original: string | null;
  placa_validada: string | null;
  decision_automatica: string | null;
  decision_final: string | null; // estado_validacion tras la validación del operador
  latencia_ms: number | null;
  luminancia_media: number | null;
  distancia_estimada_m: number | null;
  condicion_clima: string | null;
  fecha_hora_ingreso: Date | string | null;
}

/** Tipo de placa ANT según la segunda letra y el formato (3 dígitos = formato antiguo). */
export function tipoPlaca(placa: string): { servicio: string; formato: string } {
  const p = normalizePlate(placa);
  let servicio = 'particular';
  if (/^[A-Z]{2}\d{3,4}[A-Z]?$/.test(p) && p.length <= 6 && !/^[A-Z]{3}/.test(p)) servicio = 'motocicleta';
  else if ('AUZ'.includes(p[1] ?? '')) servicio = 'comercial';
  else if (p[1] === 'E') servicio = 'gobierno';
  else if (p[1] === 'M') servicio = 'municipal';
  const digitos = (p.match(/\d/g) ?? []).length;
  return { servicio, formato: digitos === 3 ? 'antiguo_3_digitos' : digitos === 4 ? 'actual_4_digitos' : 'otro' };
}

export function bucketLuz(lum: number | null, fecha: Date | string | null): string {
  if (lum !== null) return lum < 60 ? 'noche' : 'dia'; // luminancia media 0-255 del frame
  if (!fecha) return 'desconocido';
  const h = new Date(fecha).getHours();
  return h >= 6 && h < 18 ? 'dia' : 'noche';
}

export function bucketDistancia(d: number | null): string {
  if (d === null) return 'desconocida';
  if (d < 3) return '<3 m';
  if (d < 6) return '3-6 m';
  if (d < 10) return '6-10 m';
  return '>=10 m';
}

/** Intervalo de confianza de Wilson al 95 % para una proporción. */
export function wilson(exitos: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.96;
  const p = exitos / n;
  const den = 1 + (z * z) / n;
  const centro = (p + (z * z) / (2 * n)) / den;
  const margen = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, centro - margen), Math.min(1, centro + margen)];
}

function percentil(valores: number[], q: number): number | null {
  if (!valores.length) return null;
  const s = [...valores].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

interface Proporcion { valor: number | null; n: number; ic95: [number, number] | null }
const prop = (exitos: number, n: number): Proporcion => ({ valor: n ? exitos / n : null, n, ic95: wilson(exitos, n) });

function resumenGrupo(filas: FilaEvaluacion[]) {
  let exactas = 0, noLegibles = 0, cerSum = 0;
  let autorizadosReales = 0, falsosRechazos = 0, noAutorizadosReales = 0, falsasAceptaciones = 0;
  let alertasReales = 0, alertasPerdidas = 0, noAlertasReales = 0, falsasAlertas = 0;

  for (const f of filas) {
    const verdad = normalizePlate(f.placa_validada);
    const lectura = normalizePlate(f.placa_ocr_original);
    const legible = lectura.length >= 4 && lectura !== 'SINRECONOCER';
    if (!legible) noLegibles++;
    if (legible && lectura === verdad) exactas++;
    cerSum += verdad ? levenshtein(legible ? lectura : '', verdad) / verdad.length : 0;

    const auto = f.decision_automatica ?? '';
    const real = f.decision_final ?? '';
    if (real === 'autorizado') { autorizadosReales++; if (auto !== 'autorizado') falsosRechazos++; }
    else { noAutorizadosReales++; if (auto === 'autorizado') falsasAceptaciones++; }
    if (real === 'alerta') { alertasReales++; if (auto !== 'alerta') alertasPerdidas++; }
    else { noAlertasReales++; if (auto === 'alerta') falsasAlertas++; }
  }
  const n = filas.length;
  const lat = filas.map(f => f.latencia_ms).filter((v): v is number => typeof v === 'number');
  return {
    n,
    exactitud_placa: prop(exactas, n),
    cer_medio: n ? cerSum / n : null,
    tasa_no_legible: prop(noLegibles, n),
    control_acceso: {
      tasa_falsa_aceptacion: prop(falsasAceptaciones, noAutorizadosReales),
      tasa_falso_rechazo: prop(falsosRechazos, autorizadosReales),
      lista_negra_no_detectada: prop(alertasPerdidas, alertasReales),
      falsas_alertas: prop(falsasAlertas, noAlertasReales),
    },
    latencia_ms: { n: lat.length, p50: percentil(lat, 0.5), p95: percentil(lat, 0.95), max: lat.length ? Math.max(...lat) : null },
  };
}

function agrupar(filas: FilaEvaluacion[], clave: (f: FilaEvaluacion) => string) {
  const grupos: Record<string, FilaEvaluacion[]> = {};
  for (const f of filas) (grupos[clave(f)] ??= []).push(f);
  return Object.fromEntries(Object.entries(grupos).map(([k, v]) => [k, resumenGrupo(v)]));
}

export function calcularEvaluacion(filas: FilaEvaluacion[], totalRegistros: number) {
  const conVerdad = filas.filter(f => normalizePlate(f.placa_validada).length >= 4);
  return {
    total_registros: totalRegistros,
    validados: conVerdad.length,
    cobertura_validacion: totalRegistros ? conVerdad.length / totalRegistros : null,
    global: resumenGrupo(conVerdad),
    por_luz: agrupar(conVerdad, f => bucketLuz(f.luminancia_media, f.fecha_hora_ingreso)),
    por_distancia: agrupar(conVerdad, f => bucketDistancia(f.distancia_estimada_m)),
    por_tipo_placa: agrupar(conVerdad, f => tipoPlaca(f.placa_validada ?? '').servicio),
    por_formato: agrupar(conVerdad, f => tipoPlaca(f.placa_validada ?? '').formato),
    por_clima: agrupar(conVerdad, f => f.condicion_clima || 'sin_anotar'),
  };
}
