import { type ReglaTexto, type Validado, validarEntero, validarPlaca, validarTexto } from './validacion';

/**
 * Consulta del propietario de una placa (dominio puro). Marco legal en
 * infraestructura/servicios/consultaPropietario.ts (LOPDP, convenio DINARDAP / ANT): solo con un motivo, que queda
 * en la auditoría junto con el resultado, con un cupo de consultas por hora y por usuario, y con
 * la identificación enmascarada en la respuesta.
 */

/** Base legal de la consulta: queda registrada en AuditoriaConsultaPropietario. */
export const REGLA_MOTIVO_CONSULTA: ReglaTexto = { etiqueta: 'Motivo de la consulta', tipo: 'libre', min: 10, max: 255, requerido: true };

/** Máximo de la columna INT del paso vehicular de origen. */
const ID_MAXIMO = 2_147_483_647;

export interface ConsultaPropietario {
  placa: string;
  motivo: string;
  /** Paso vehicular desde el que se consulta (opcional) */
  deteccionId: number | null;
}

/** Cuerpo de la consulta: placa con formato ANT, motivo de 10 a 255 caracteres y paso de origen opcional. */
export function leerConsultaPropietario(entrada: unknown): Validado<ConsultaPropietario> {
  const b = (entrada && typeof entrada === 'object' ? entrada : {}) as Record<string, unknown>;
  const placa = validarPlaca(b.placa);
  if (!placa.ok) return placa;
  const motivo = validarTexto(b.motivo, REGLA_MOTIVO_CONSULTA);
  if (!motivo.ok) return motivo;
  const deteccion = validarEntero(b.deteccion_id, { etiqueta: 'Paso vehicular', min: 1, max: ID_MAXIMO });
  if (!deteccion.ok) return deteccion;
  return { ok: true, valor: { placa: placa.valor.placa, motivo: motivo.valor as string, deteccionId: deteccion.valor } };
}

/** Identificación enmascarada: solo los 2 primeros y los 2 últimos caracteres (p. ej. 18XXXXXX45). */
export function enmascararIdentificacion(id?: string): string | undefined {
  if (!id) return undefined;
  return id.length <= 4 ? '****' : `${id.slice(0, 2)}${'X'.repeat(id.length - 4)}${id.slice(-2)}`;
}
