/**
 * Segundo factor de identificación: compara los atributos OBSERVADOS del vehículo
 * (tipo, color, marca; ANPR con YOLO26n + CLIP) con los REGISTRADOS en la lista negra
 * o en vehículos autorizados.
 *
 * Solo se comparan los campos presentes en ambos lados. El modelo del vehículo NO se usa
 * para decidir: el reconocimiento zero-shot de modelos concretos es poco fiable (en la
 * prueba confundió una Haval H6 con una Haval Jolion con 87 % de confianza). Marca y color sí.
 */

export type ResultadoVerificacion = 'coincide' | 'no_coincide' | 'sin_datos';

export interface AtributosVehiculo {
  marca?: string | null;
  modelo?: string | null;
  color?: string | null;
  tipo?: string | null;
}

const normalizar = (s: string | null | undefined): string =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

// Colores que la cámara confunde con facilidad (iluminación, reflejos, cámara IR) cuentan como iguales.
const GRUPOS_COLOR = [
  ['gris', 'plateado', 'plata', 'silver'],
  ['rojo', 'vino', 'granate'],
  ['cafe', 'beige', 'marron', 'dorado'],
  ['blanco', 'perla'],
  ['amarillo', 'naranja'],
];

// Marcas del mismo fabricante que comparten diseño o se venden con ambos nombres.
const GRUPOS_MARCA = [
  ['greatwall', 'haval'],
  ['chevrolet', 'gm'],
];

function mismoGrupo(a: string, b: string, grupos: string[][]): boolean {
  if (a === b) return true;
  return grupos.some(g => g.includes(a) && g.includes(b));
}

export function compararVehiculo(
  registrado: AtributosVehiculo | null | undefined,
  observado: AtributosVehiculo | null | undefined,
): { resultado: ResultadoVerificacion; detalle: string } {
  if (!registrado || !observado) return { resultado: 'sin_datos', detalle: 'Sin atributos registrados u observados' };

  const diferencias: string[] = [];
  const comparados: string[] = [];

  const cReg = normalizar(registrado.color);
  const cObs = normalizar(observado.color);
  if (cReg && cObs) {
    comparados.push('color');
    if (!mismoGrupo(cReg, cObs, GRUPOS_COLOR)) diferencias.push(`color registrado ${registrado.color}, observado ${observado.color}`);
  }

  const mReg = normalizar(registrado.marca);
  const mObs = normalizar(observado.marca);
  if (mReg && mObs) {
    comparados.push('marca');
    if (!mismoGrupo(mReg, mObs, GRUPOS_MARCA)) diferencias.push(`marca registrada ${registrado.marca}, observada ${observado.marca}`);
  }

  if (!comparados.length) return { resultado: 'sin_datos', detalle: 'No hay atributos comparables' };
  if (diferencias.length) return { resultado: 'no_coincide', detalle: diferencias.join('; ') };
  return { resultado: 'coincide', detalle: `Coinciden: ${comparados.join(' y ')}` };
}
