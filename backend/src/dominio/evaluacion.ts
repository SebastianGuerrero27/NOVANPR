import { levenshtein, normalizePlate } from './coincidenciaPlacas';

/**
 * Métricas científicas del reconocimiento con datos de operación (dominio puro, sin E/S).
 *
 * La "verdad" de cada paso vehicular es la placa confirmada por el personal
 * (validado_manualmente = 1). Se compara con la lectura ORIGINAL del OCR y con la decisión
 * AUTOMÁTICA del sistema, que se guardan aparte porque la validación manual sobrescribe
 * placa_reconocida y estado_validacion. Las proporciones llevan su intervalo de confianza de
 * Wilson al 95 %. La persistencia de la evaluación está en infraestructura/servicios/evaluacion.ts.
 */

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

// ─── Exportación ─────────────────────────────────────────────────────────────

/** Paso vehicular completo para la exportación (columnas de DeteccionVehiculo). */
export type FilaExportacionEvaluacion = FilaEvaluacion & Record<string, unknown>;

/** Columnas del CSV: las del paso más las variables derivadas (luz, distancia y tipo de placa). */
export const COLUMNAS_EXPORTACION_EVALUACION = [
  'id', 'fecha_hora_ingreso', 'camara_id', 'fuente', 'validado_manualmente',
  'placa_ocr_original', 'confianza_ocr_original', 'placa_validada', 'lectura_verificador',
  'decision_automatica', 'decision_final', 'latencia_ms', 'luminancia_media', 'distancia_estimada_m',
  'ancho_placa_px', 'nitidez', 'velocidad_px_s', 'condicion_clima', 'modelo_detector', 'modelo_ocr',
  'confianza_deteccion', 'luz', 'rango_distancia', 'tipo_servicio', 'formato_placa',
] as const;

/** Texto que una hoja de cálculo interpretaría como fórmula (OWASP: CSV injection). */
const INICIO_FORMULA = /^[=+\-@\t\r]/;

/**
 * Celda CSV: entre comillas solo si contiene comas, comillas o saltos de línea (el formato que
 * lee scripts/estadistica.py). Un texto que empieza como fórmula lleva un apóstrofo delante; los
 * números se escriben tal cual para no alterar los datos del análisis.
 */
function celda(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'number') return String(valor);
  let texto = valor instanceof Date ? valor.toISOString() : String(valor);
  if (INICIO_FORMULA.test(texto)) texto = `'${texto}`;
  return /[",\n\r]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

/** CSV de la evaluación: una fila por paso vehicular, en el orden recibido. */
export function csvEvaluacion(filas: readonly FilaExportacionEvaluacion[]): string {
  const lineas = [COLUMNAS_EXPORTACION_EVALUACION.join(',')];
  for (const f of filas) {
    const tipo = f.placa_validada ? tipoPlaca(f.placa_validada) : { servicio: '', formato: '' };
    const fila: Record<string, unknown> = {
      ...f,
      luz: bucketLuz(f.luminancia_media, f.fecha_hora_ingreso),
      rango_distancia: bucketDistancia(f.distancia_estimada_m),
      tipo_servicio: tipo.servicio,
      formato_placa: tipo.formato,
    };
    lineas.push(COLUMNAS_EXPORTACION_EVALUACION.map(c => celda(fila[c])).join(','));
  }
  return lineas.join('\n');
}
