import { type Validado, validarEntero, validarHost, validarTexto } from './validacion';

/**
 * Parámetros del sistema (dominio puro): validación y normalización del valor de cada parámetro
 * según el tipo declarado en su definición (infraestructura/servicios/configuracion.ts → DEFINICIONES).
 *
 *   booleano  true | false
 *   entero    solo dígitos, dentro del rango declarado (min y max)
 *   lista     dominios de correo separados por coma: cada uno, un nombre de host (RFC 1123) con
 *             dominio de nivel superior; se guardan en minúsculas, sin @ y sin repetidos
 *   opcion    uno de los valores declarados
 *   texto     texto libre (sin < > ni caracteres de control), obligatorio, hasta 150 caracteres
 *
 * Un cambio se rechaza completo si una clave no existe o un solo valor es inválido: no se
 * guarda nada a medias.
 */

export type TipoParametro = 'booleano' | 'entero' | 'lista' | 'texto' | 'opcion';

/** Lo que la validación necesita de la definición de un parámetro. */
export interface ReglaParametro {
  clave: string;
  tipo: TipoParametro;
  etiqueta: string;
  min?: number;
  max?: number;
  opciones?: readonly { valor: string }[];
}

/** Longitud de la columna ConfiguracionSistema.valor (NVARCHAR(500)). */
export const MAX_VALOR_PARAMETRO = 500;
/** Parámetros de texto (p. ej. la unidad institucional que encabeza reportes y exportaciones). */
export const MAX_TEXTO_PARAMETRO = 150;

const ok = <T>(valor: T): Validado<T> => ({ ok: true, valor });
const error = (mensaje: string): { ok: false; error: string } => ({ ok: false, error: mensaje });

/** Dominio de correo: nombre de host válido (no una IP) con dominio de nivel superior alfabético. */
export function esDominioCorreo(dominio: string): boolean {
  const host = validarHost(dominio);
  return host.ok && host.valor !== null && !/^[\d.]+$/.test(dominio) && /\.[a-z]{2,}$/i.test(dominio);
}

/** Valor escalar del JSON (texto, número o booleano); null o ausente cuenta como vacío. */
const esEscalar = (v: unknown) => v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);

/** Valida y normaliza el valor de un parámetro según su tipo declarado. */
export function validarParametro(def: ReglaParametro, entrada: unknown): Validado<string> {
  // La lista de dominios también se acepta como arreglo de textos
  const crudo = def.tipo === 'lista' && Array.isArray(entrada) && entrada.every(x => typeof x === 'string') ? entrada.join(',') : entrada;
  if (!esEscalar(crudo)) return error(`${def.etiqueta}: valor inválido.`);
  const texto = crudo === null || crudo === undefined ? '' : String(crudo).trim();

  switch (def.tipo) {
    case 'booleano':
      return texto === 'true' || texto === 'false' ? ok(texto) : error(`${def.etiqueta}: debe ser verdadero o falso.`);
    case 'entero': {
      const n = validarEntero(texto, { etiqueta: def.etiqueta, min: def.min, max: def.max, requerido: true });
      return n.ok ? ok(String(n.valor)) : n;
    }
    case 'lista': {
      const dominios = [...new Set(texto.split(',').map(x => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
      if (!dominios.length) return error(`${def.etiqueta}: indique al menos un dominio.`);
      const invalido = dominios.find(x => !esDominioCorreo(x));
      if (invalido !== undefined) return error(`${def.etiqueta}: dominio inválido (${invalido.substring(0, 60)}).`);
      const valor = dominios.join(',');
      return valor.length <= MAX_VALOR_PARAMETRO ? ok(valor) : error(`${def.etiqueta}: máximo ${MAX_VALOR_PARAMETRO} caracteres.`);
    }
    case 'opcion':
      return def.opciones?.some(o => o.valor === texto) ? ok(texto) : error(`${def.etiqueta}: opción inválida.`);
    case 'texto': {
      const t = validarTexto(texto, { etiqueta: def.etiqueta, tipo: 'libre', max: MAX_TEXTO_PARAMETRO, requerido: true });
      return t.ok ? ok(t.valor!) : t;
    }
    default:
      return error(`${def.etiqueta}: tipo de parámetro desconocido.`);
  }
}

/**
 * Cambios pedidos ({ clave: valor }), todos validados antes de guardar. Devuelve los pares
 * normalizados o el primer error (clave desconocida o valor inválido).
 */
export function leerCambiosConfiguracion(definiciones: readonly ReglaParametro[], valores: unknown): Validado<[string, string][]> {
  if (!valores || typeof valores !== 'object' || Array.isArray(valores) || !Object.keys(valores).length) {
    return error('No hay cambios para guardar.');
  }
  const cambios: [string, string][] = [];
  for (const [clave, valor] of Object.entries(valores)) {
    const def = definiciones.find(d => d.clave === clave);
    if (!def) return error(`Parámetro desconocido: ${clave.substring(0, 60)}`);
    const v = validarParametro(def, valor);
    if (!v.ok) return v;
    cambios.push([clave, v.valor]);
  }
  return ok(cambios);
}
